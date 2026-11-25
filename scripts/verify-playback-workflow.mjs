// Verify deployed UI with real media while protecting the listener's canonical progress.
import fs from "node:fs";
import {protectBrowserMutations, closeProtectedBrowser} from "./verification-safety.mjs";
import { chromium, expect as baseExpect } from "@playwright/test";
import { defaultAppearance } from "../src/appearance.ts";
import { createReaderControls, waitForBox } from "./live-reader-controls.mjs";
import { verifyBaseURL } from "./live-check-target.mjs";
import { requestFrom, getJSON, NoSuitableRecording, NO_SUITABLE_RECORDING_EXIT, verifyChoice } from "./live-check-recording.mjs";
import { selectPlaybackRecording, PLAYBACK_MIN_CHAPTER_SECONDS } from "./live-check-playback.mjs";
const expect=baseExpect.configure({timeout:20000});
// A local test server (tests/browser-server.ts) has no .env and no password; production reads both from .env.
if(fs.existsSync(".env")) process.loadEnvFile(".env");
// The recording id (first argument, else SONDER_VERIFY_RECORDING) is a preference: the check plays it when it qualifies
// and otherwise picks another (#431). Never one listened to in the last 48 h: chosen explicitly, that is refused unless
// SONDER_VERIFY_ALLOW_RECENT=1 (#774).
const {preferred,allowRecent}=verifyChoice();
const baseURL=verifyBaseURL();
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome"});
const context=await browser.newContext({baseURL,viewport:{width:390,height:844},hasTouch:true,serviceWorkers:"block"});
const report={recordingId:null,preferred,protectedWrites:0,checks:[],errors:[]};
const check=(name,details={})=>report.checks.push({name,...details});
let readAudio;
try {
  if(process.env.APP_PASSWORD){
    const login=await context.request.post("/api/auth/login",{data:{password:process.env.APP_PASSWORD}});
    if(!login.ok()) throw new Error(`Sign-in failed (POST /api/auth/login answered ${login.status()})`);
  }
  // Playback starts at the owner's saved position, which this check must not move: choose a recording where it can run.
  // Only a listing that holds no qualifying recording leads to "no suitable recording"; any failed request fails the check (#431).
  // A recording chosen here that then fails below stays a failure: the check does not fall through to another one.
  const pick=await selectPlaybackRecording(requestFrom(context),{preferred,allowRecent});
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
  // Now playing is one screen with two faces, Listen and Read (#593): `#listen/<work>` and `#read/<work>`.
  const screen=page.getByRole("dialog",{name:"Now playing",exact:true});
  const listen=page.locator(".now-playing-listen");
  const faces=()=>screen.getByRole("radiogroup",{name:"Listen or read",exact:true});
  const hash=()=>page.evaluate(()=>decodeURIComponent(location.hash));
  // The Book page (#532): its recording is the chosen one; the check needs the one it selected.
  await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
  const bookPage=page.getByRole("region",{name:"Book",exact:true});
  await expect(bookPage).toBeVisible();
  // Listen plays the chosen recording and opens Now playing on its Listen face.
  await bookPage.getByRole("button",{name:"Listen",exact:true}).click();
  await expect.poll(async()=>{const a=await actual();return !!a && a.ready>=2 && !a.paused && !a.error;},{timeout:30000}).toBe(true);
  const playing=(await actual()).src;
  if(!book.tracks.some(track=>decodeURIComponent(playing).includes(track.id)))throw new Error(`Listen played ${playing}, not the selected recording ${pick.recordingId}: choose it on the book's Audiobook page or pass it as the recording id`);
  await expect(listen).toBeVisible();
  expect(await hash()).toBe(`#listen/${book.workId}`);
  await listen.getByRole("button",{name:"Pause",exact:true}).click();
  await expect.poll(async()=>(await actual()).paused).toBe(true);
  check("real audio decodes; Listen opens Now playing on its Listen face",{duration:(await actual()).duration});
  const slider=listen.getByRole("slider",{name:"Seek in chapter",exact:true});
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
  expect(desktop.width).toBeGreaterThan(box.width*1.2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(1440);
  check("desktop timeline expands",{width:desktop.width});
  await page.screenshot({path:"artifacts/live-playback-chapter-desktop.png",fullPage:true});
  // Plays from on Listen: the Audiobook page's picker (ADR 0015). A choice switches the source and keeps the place.
  const playsFrom=listen.getByRole("button",{name:"Plays from",exact:true});
  const picker=page.getByRole("dialog",{name:"Plays from",exact:true});
  const unchanged=(await actual()).position;
  const names={original:"Original stream",server:"Server copy"};
  for(const mode of ["original","server"]){
    await expect(playsFrom).toBeEnabled();
    await playsFrom.click();
    const option=picker.getByRole("radio",{name:names[mode],exact:true});
    // The picker rules out a source with no file for the place, a faulty one, or one that needs a connection.
    if(await option.isDisabled()){await page.keyboard.press("Escape");await expect(picker).toBeHidden();continue;}
    report.sourceMode=mode;
    if(await option.getAttribute("aria-checked")!=="true") await option.click();
    else await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(playsFrom).toHaveText(names[mode]);
    // Selecting the source already in use need not reload the audio URL: check the decoded audio and the place.
    await expect.poll(async()=>{const a=await actual();return a.ready>=2&&!a.error;},{timeout:40000}).toBe(true);
    await expect.poll(async()=>(await actual()).position).toBeCloseTo(unchanged,0);
    expect((await actual()).paused).toBe(true);
    await listen.getByRole("button",{name:"Play",exact:true}).click();
    await expect.poll(async()=>{const a=await actual();return !a.paused&&a.position>unchanged;},{timeout:30000}).toBe(true);
    await listen.getByRole("button",{name:"Pause",exact:true}).click();
    // Return to the same time so both delivery modes are checked against it.
    await slider.fill(String(Math.round(preview)));
    await expect.poll(async()=>(await actual()).position).toBeCloseTo(unchanged,0);
    check("Plays from switches the source and keeps the place",{source:mode});
  }
  // Back to Automatic, as the owner left it on this device.
  await playsFrom.click();
  await picker.getByRole("radio",{name:"Automatic",exact:true}).click().catch(()=>page.keyboard.press("Escape"));
  await expect(picker).toBeHidden();
  await page.screenshot({path:"artifacts/live-playback-versions-desktop.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  // Earlier positions on Listen: today's Position history, which lists the seeks above; an entry restores its place.
  await listen.getByRole("button",{name:"Earlier positions",exact:true}).click();
  const history=page.getByRole("dialog",{name:"Position history",exact:true});
  await expect(history).toBeVisible();
  const entries=history.getByRole("listitem");
  if(await entries.count()){
    const before=(await actual()).position;
    await entries.first().getByRole("button").click();
    await expect(history).toBeHidden();
    await expect.poll(async()=>Math.abs((await actual()).position-before)).toBeGreaterThan(1);
    check("Earlier positions opens Position history and restores an entry",{entries:await entries.count()});
  } else {
    await page.keyboard.press("Escape");
    check("Earlier positions opens Position history (no jumps listed)");
  }
  // The faces: Read replaces Listen's entry when the book has an EPUB; Back closes Now playing.
  if(hasEbook){
    await faces().getByRole("radio",{name:"Read",exact:true}).click();
    await expect.poll(hash).toBe(`#read/${book.workId}`);
    await expect(page.locator(".now-playing-screen .reader-viewport .prepared-text").first()).toBeVisible();
    check("Now playing switches to its Read face");
    // The Read face's head shows its controls after a tap on the text; the helper taps and clicks (#413).
    const room=page.locator(".now-playing-screen .reader-room");
    const controls=createReaderControls({page,room});
    await controls.click(room.locator(".reader-topbar").getByRole("radio",{name:"Listen",exact:true}),"Listen");
    await expect.poll(hash).toBe(`#listen/${book.workId}`);
    await expect(listen).toBeVisible();
  } else {
    await expect(faces().getByRole("radio",{name:"Read",exact:true})).toHaveAttribute("aria-checked","false");
    check("no linked EPUB: Read leads to Get ebook or is off");
  }
  await page.goBack();
  await expect(screen).toBeHidden();
  check("Back closes Now playing");
  // The mini player opens Now playing again on its face rule: the face last shown, Listen.
  await page.locator(".player-dock .dock-book").click();
  await expect.poll(hash).toBe(`#listen/${book.workId}`);
  await listen.getByRole("button",{name:"Open this book’s page",exact:true}).click();
  await expect(bookPage).toBeVisible();
  check("Listen's head opens the book's page");
  await page.getByRole("button",{name:`Open title page for ${book.title}`,exact:true}).click();
  await expect(bookPage).toBeVisible();
  check("compact player cover opens title page");
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
