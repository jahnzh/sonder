// Verify deployed UI with real media while protecting the listener's canonical progress.
import fs from "node:fs";
import {protectBrowserMutations, closeProtectedBrowser} from "./verification-safety.mjs";
import { chromium, expect as baseExpect } from "@playwright/test";
import { defaultAppearance } from "../src/appearance.ts";
import { createReaderControls, waitForBox } from "./live-reader-controls.mjs";
import { verifyBaseURL } from "./live-check-target.mjs";
import { requestFrom, getJSON, NoSuitableRecording, NO_SUITABLE_RECORDING_EXIT } from "./live-check-recording.mjs";
import { selectPlaybackRecording, PLAYBACK_MIN_CHAPTER_SECONDS } from "./live-check-playback.mjs";
const expect=baseExpect.configure({timeout:20000});
process.loadEnvFile(".env");
// The recording id is a preference: the check plays it when it qualifies and otherwise picks another (#431).
const preferred=process.argv[2]||null;
const baseURL=verifyBaseURL();
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome"});
const context=await browser.newContext({baseURL,viewport:{width:390,height:844},hasTouch:true,serviceWorkers:"block"});
const report={recordingId:null,preferred,protectedWrites:0,checks:[],errors:[]};
const check=(name,details={})=>report.checks.push({name,...details});
let readAudio;
try {
  const login=await context.request.post("/api/auth/login",{data:{password:process.env.APP_PASSWORD}});
  if(!login.ok()) throw new Error(`Sign-in failed (POST /api/auth/login answered ${login.status()})`);
  // Playback starts at the owner's saved position, which this check must not move: choose a recording where it can run.
  // Only a listing that holds no qualifying recording leads to "no suitable recording"; any failed request fails the check (#431).
  // A recording chosen here that then fails below stays a failure: the check does not fall through to another one.
  const pick=await selectPlaybackRecording(requestFrom(context),{preferred});
  const {book,ebooks,sequence}=pick;
  report.recordingId=pick.recordingId;
  report.selection={start:sequence.start,timeline:sequence.timeline,...(pick.preferred?{preferred:pick.preferred}:{})};
  const hasEbook=ebooks.some(e=>e.workId===book.workId && e.format==="epub" && e.available);
  await protectBrowserMutations(context,baseURL,report);
  // Playback preferences in this browser stay local and do not alter account defaults.
  await context.addInitScript(appearance=>{
    localStorage.setItem("sonder-appearance-device","true");
    localStorage.setItem("sonder-appearance",JSON.stringify(appearance));
    const Native=window.Audio;
    window.__actualAudio=[];
    window.Audio=class extends Native {
      constructor(...args){super(...args);window.__actualAudio.push(this);}
    };
  },{...defaultAppearance,playback:{progressScope:"chapter"},reader:{...defaultAppearance.reader,display:"book"}});
  const page=await context.newPage();
  page.on("pageerror",error=>report.errors.push(error.message));
  const actual=()=>page.evaluate(()=>{
    const a=window.__actualAudio.find(a=>!!a.src);
    return a && {position:a.currentTime,paused:a.paused,duration:a.duration,src:a.src,ready:a.readyState,error:a.error?.message,sourceLabel:document.querySelector(".player-dock .playback-source")?.textContent};
  });
  readAudio=actual;
  // The Book page (#532) replaced the book dialog: Listen plays the book's chosen recording.
  await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
  const bookPage=page.getByRole("region",{name:"Book",exact:true});
  await expect(bookPage).toBeVisible();
  // The book's Hardcover row (shown when this account connected Hardcover) opens the Hardcover page (#529), whose
  // Open on Hardcover is the canonical link. Only read: nothing on the page is changed.
  const hardcoverRow=bookPage.getByRole("button",{name:/^Hardcover /});
  if(book.hardcover?.slug && await hardcoverRow.count()){
    await hardcoverRow.click();
    const link=page.getByRole("link",{name:"Open on Hardcover",exact:true});
    await expect(link).toHaveAttribute("href",`https://hardcover.app/books/${encodeURIComponent(book.hardcover.slug)}`);
    check("canonical Hardcover link",{href:await link.getAttribute("href")});
    await page.getByRole("button",{name:"Back to the book",exact:true}).click();
    await expect(bookPage).toBeVisible();
  }
  await bookPage.getByRole("button",{name:"Listen",exact:true}).click();
  await expect.poll(async()=>{const a=await actual();return !!a && a.ready>=2 && !a.paused && !a.error;},{timeout:30000}).toBe(true);
  // The chosen recording is the one this check selected: media addresses name the track (/api/media/<track id>).
  const playing=decodeURIComponent((await actual()).src);
  if(!book.tracks.some(track=>playing.includes(track.id))) throw new Error(`Listen played ${playing}, not the selected recording ${pick.recordingId}: choose it on the book's Audiobook page or pass it as the recording id`);
  // Listen opens Now playing over the dock: pause there.
  await page.getByRole("dialog",{name:"Now playing",exact:true}).getByRole("button",{name:/^Pause( narration)?$/}).filter({visible:true}).first().click();
  await expect.poll(async()=>(await actual()).paused).toBe(true);
  check("real audio decodes",{duration:(await actual()).duration});
  const nowPlaying=page.getByRole("dialog",{name:"Now playing",exact:true});
  const openNowPlaying=async()=>{if(!(await nowPlaying.isVisible())) await page.locator(".dock-book").click();await expect(nowPlaying).toBeVisible();};
  await openNowPlaying();
  await expect(page.getByText("Loading ebook…",{exact:true})).toBeHidden();
  const room=page.locator(".inline-reader");
  if(hasEbook) await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  // The reader's controls toggle on a tap and reset when it remounts; every use of them goes through this helper (#413).
  const controls=createReaderControls({page,room});
  // Plays from is on the Audiobook page (#530), opened by Now playing's Audiobook. With an ebook that button is in the
  // dialog's own Playback options (the reader's head has no More, #592); a DOM click, as the dialog's heading is
  // clipped under the reader (#22). The page stays on the same address between rounds, so the sources are read here.
  const manager=page.getByRole("region",{name:"Audiobook",exact:true});
  const playsFrom=manager.getByRole("button",{name:/^Plays from: /});
  const openSources=async()=>{
    if(await room.count()) await page.locator(".playback-menu-trigger").evaluate(el=>el.click());
    await page.getByRole("button",{name:"Audiobook",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"Now playing",exact:true})).toBeHidden();
    await expect(playsFrom).toBeEnabled();
    return getJSON(requestFrom(context),`/api/recordings/${encodeURIComponent(book.recordingId)}/sources`,body=>Array.isArray(body?.tracks)?null:"expected {tracks: [...]}");
  };
  const slider=page.getByRole("slider",{name:"Seek in chapter",exact:true});
  await controls.show(slider,"Seek in chapter slider");
  await expect(slider).toBeVisible();
  const chapterDuration=Number(await slider.getAttribute("max"));
  // Selection read this timeline with playbackTimeline (scripts/live-check-playback.mjs); the drags below need its length.
  if(!(chapterDuration>=PLAYBACK_MIN_CHAPTER_SECONDS)) throw new Error(`The chapter slider lasts ${chapterDuration} s (needs at least ${PLAYBACK_MIN_CHAPTER_SECONDS} s); selection expected "${sequence.timeline.title}" of ${Math.round(sequence.timeline.duration)} s`);
  if(chapterDuration>3000 && book.tracks[0].chapters?.length>1)throw new Error("Expected embedded chapter duration, not full M4B");
  await slider.fill("60");
  const start=(await actual()).position;
  const box=await waitForBox(slider,{description:"Seek in chapter slider"}), width=box.width-18;
  const x=box.x+9+60/chapterDuration*width,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x,y-156);await page.mouse.move(x+30,y-156,{steps:5});
  let preview=Number(await slider.inputValue());
  expect((await actual()).position).toBeCloseTo(start,0);
  expect(preview-60).toBe(Math.floor(60+30/width*chapterDuration/4)-60);
  await page.mouse.up();
  await expect.poll(async()=>(await actual()).position).toBeCloseTo(start+preview-60,0);
  expect((await actual()).paused).toBe(true);
  check("embedded chapter and precision seek",{chapterDuration,seekDelta:preview-60,mobileWidth:box.width});
  const cdp=await context.newCDPSession(page);
  const touchBox=await waitForBox(slider,{description:"Seek in chapter slider"});
  const touchX=touchBox.x+9+preview/chapterDuration*(touchBox.width-18),touchY=touchBox.y+touchBox.height/2;
  const touch=async(type,tx=touchX,ty=touchY)=>cdp.send("Input.dispatchTouchEvent",{type,touchPoints:type==="touchEnd"?[]:[{x:tx,y:ty,id:1}]});
  await touch("touchStart");
  await touch("touchMove",touchX,touchY-156);
  await touch("touchMove",touchX+45,touchY-156);
  await expect.poll(async()=>Number(await slider.inputValue())).toBeGreaterThan(preview);
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  const touchPreview=Number(await slider.inputValue());
  const touchText=await slider.getAttribute("aria-valuetext");
  expect(touchPreview-preview).toBeLessThan(45/(touchBox.width-18)*chapterDuration/2);
  const chapterStart=start-60;
  await touch("touchEnd");
  await expect.poll(async()=>(await actual()).position).toBeCloseTo(chapterStart+touchPreview,5);
  await expect(slider).toHaveAttribute("aria-valuetext",touchText);
  preview=touchPreview;
  check("touch release keeps the previewed position",{chapterPosition:touchPreview});
  await page.screenshot({path:"artifacts/live-playback-chapter-mobile.png",fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  const desktop=await waitForBox(slider,{description:"Seek in chapter slider (desktop)"});
  expect(desktop.width).toBeGreaterThan(box.width*1.7);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(1440);
  check("desktop timeline expands",{width:desktop.width});
  await page.screenshot({path:"artifacts/live-playback-chapter-desktop.png",fullPage:true});
  const sourceState=await openSources();
  const unchanged=(await actual()).position;
  const sourceNames={original:"Original stream",server:"Server copy"};
  for(const mode of ["original","server"]){
    const playing=await actual();
    const availability=sourceState.tracks.find(track=>playing.src.includes(encodeURIComponent(track.id))) || sourceState.tracks[0];
    if(!availability?.[mode] || sourceState.faults?.[mode])continue;
    report.sourceMode=mode;
    await expect(playsFrom).toBeEnabled();
    await playsFrom.click();
    const picker=page.getByRole("dialog",{name:"Plays from",exact:true});
    const option=picker.getByRole("radio",{name:sourceNames[mode],exact:true});
    await expect(option).toBeEnabled();
    await option.click();
    await expect(picker).toBeHidden();
    await expect(manager.getByRole("button",{name:`Plays from: ${sourceNames[mode]}`,exact:true})).toBeVisible();
    // Selecting the source already in use need not reload the audio URL.
    // Assert the reported delivery source and decoded audio instead of URL shape.
    await expect.poll(async()=>{
      const a=await actual();
      const label=await page.locator(".player-dock .playback-source").textContent();
      return a.ready>=2&&!a.error&&(mode==="server" ? label.includes("Host server") : /Online stream|TorBox/.test(label));
    },{timeout:40000}).toBe(true);
    await expect.poll(async()=>(await actual()).position).toBeCloseTo(unchanged,0);
    expect((await actual()).paused).toBe(true);
    await page.locator(".player-dock").getByRole("button",{name:"Play",exact:true}).click();
    await expect.poll(async()=>{const a=await actual();return !a.paused&&a.position>unchanged;},{timeout:30000}).toBe(true);
    await page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true}).click();
    // Return to the same time so both delivery modes are checked against it.
    await openNowPlaying();
    await controls.show(slider,"Seek in chapter slider");
    await slider.fill(String(Math.round(preview)));
    await openSources();
    check("delivery source plays",{source:mode});
  }
  await page.screenshot({path:"artifacts/live-playback-versions-desktop.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  const openReader=page.getByRole("button",{name:"Open ebook reader",exact:true});
  if(hasEbook){
    await openReader.click();
    if(await page.getByRole("group",{name:"Ebook editions",exact:true}).count())await page.getByRole("group",{name:"Ebook editions",exact:true}).getByRole("button").first().click();
    await expect(page.getByRole("dialog",{name:"Now playing",exact:true})).toBeVisible();
    await expect(page.locator(".reader-viewport iframe")).toBeVisible();
    check("compact player opens linked EPUB");
    await controls.click(room.locator(".reader-topbar").getByRole("button",{name:"Close reader",exact:true}),"Close reader");
  } else check("no linked EPUB available");
  // The player's cover opens the Book page (#532).
  await page.getByRole("button",{name:`Open title page for ${book.title}`,exact:true}).click();
  await expect(bookPage).toBeVisible();
  check("compact player cover opens the Book page");
  expect(report.errors).toEqual([]);
  report.ok=true;
} catch(error) {
  // Nothing to run on is a result of its own, not a failure: no page was opened, so nothing could write (#431).
  if(error instanceof NoSuitableRecording){
    report.ok=null;report.skipped=error.reason;process.exitCode=NO_SUITABLE_RECORDING_EXIT;console.log(error.message);
    if(process.env.SONDER_LIVE_CHECK_SKIP_FILE) fs.writeFileSync(process.env.SONDER_LIVE_CHECK_SKIP_FILE,error.reason);
  } else {
    report.ok=false;report.failure=error.message;report.audio=await readAudio?.().catch(()=>null);process.exitCode=1;
  }
} finally {
  await closeProtectedBrowser(context,browser,report);
  fs.mkdirSync("artifacts",{recursive:true});
  fs.writeFileSync("artifacts/playback-workflow-verification.json",JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
