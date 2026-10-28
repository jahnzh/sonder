// Verify deployed UI with real media while protecting the listener's canonical progress.
import fs from "node:fs";
import {protectBrowserMutations, closeProtectedBrowser} from "./verification-safety.mjs";
import { chromium, expect as baseExpect } from "@playwright/test";
import { defaultAppearance } from "../src/appearance.ts";
const expect=baseExpect.configure({timeout:20000});
process.loadEnvFile(".env");
const recordingId=process.argv[2];
if(!recordingId) throw new Error("Usage: node --import tsx scripts/verify-playback-workflow.mjs recording-id");
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome"});
const baseURL=process.env.SONDER_VERIFY_URL || "https://sonder.pecori.no";
const context=await browser.newContext({baseURL,viewport:{width:390,height:844},hasTouch:true,serviceWorkers:"block"});
const report={recordingId,protectedWrites:0,checks:[],errors:[]};
const check=(name,details={})=>report.checks.push({name,...details});
let readAudio;
try {
  const login=await context.request.post("/api/auth/login",{data:{password:process.env.APP_PASSWORD}});
  if(!login.ok()) throw new Error("Sign-in failed");
  const books=await(await context.request.get("/api/books")).json();
  const book=books.find(b=>b.recordingId===recordingId);
  if(!book) throw new Error("Recording not found");
  const ebooks=await (await context.request.get("/api/ebooks")).json();
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
  await page.goto("/");
  await page.getByRole("button",{name:`About ${book.title}`,exact:true}).first().click();
  const detail=page.getByRole("dialog",{name:"Book details",exact:true});
  const editions=detail.getByRole("combobox",{name:"Audiobook release",exact:true});
  if(await editions.count()) await editions.selectOption(book.id);
  if(book.hardcover?.slug){
    const link=detail.locator(".detail-actions").getByRole("link",{name:"Hardcover",exact:true});
    await expect(link).toHaveAttribute("href",`https://hardcover.app/books/${encodeURIComponent(book.hardcover.slug)}`);
    check("canonical Hardcover link",{href:await link.getAttribute("href")});
  }
  await detail.getByRole("button",{name:/^(Continue listening|Start listening)$/}).click();
  await expect.poll(async()=>{const a=await actual();return !!a && a.ready>=2 && !a.paused && !a.error;},{timeout:30000}).toBe(true);
  await detail.getByRole("button",{name:"Pause",exact:true}).click();
  await detail.getByRole("button",{name:"Close dialog",exact:true}).click();
  check("real audio decodes",{duration:(await actual()).duration});
  await page.locator(".dock-book").click();
  await expect(page.getByText("Loading ebook…",{exact:true})).toBeHidden();
  const room=page.locator(".inline-reader");
  if(hasEbook) await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  const showControls=async()=>{
    if(!await room.count() || await room.locator(".reader-topbar").isVisible()) return;
    const box=await room.locator(".reader-viewport").boundingBox();
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    await expect(room.locator(".reader-topbar")).toBeVisible();
  };
  const openSources=async()=>{
    if(await room.count()){await showControls(); await room.locator(".reader-topbar").getByRole("button",{name:"More",exact:true}).click();}
    else if(await page.getByRole("button",{name:"Playback options",exact:true}).isVisible()) await page.getByRole("button",{name:"Playback options",exact:true}).click();
    const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/recordings/${encodeURIComponent(book.recordingId)}/sources`&&response.request().method()==="GET"&&response.ok());
    await page.getByRole("button",{name:"Versions & sources",exact:true}).click();
    const state=await (await refreshed).json();
    await expect(page.getByRole("dialog",{name:"Versions & sources",exact:true}).getByRole("combobox",{name:"Playback source choice",exact:true})).toBeEnabled();
    return state;
  };
  await showControls();
  const slider=page.getByRole("slider",{name:"Seek in chapter",exact:true});
  await expect(slider).toBeVisible();
  const chapterDuration=Number(await slider.getAttribute("max"));
  if(chapterDuration>3000 && book.tracks[0].chapters?.length>1)throw new Error("Expected embedded chapter duration, not full M4B");
  await slider.fill("60");
  const start=(await actual()).position;
  const box=await slider.boundingBox(), width=box.width-18;
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
  const touchBox=await slider.boundingBox();
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
  const desktop=await slider.boundingBox();
  expect(desktop.width).toBeGreaterThan(box.width*1.7);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(1440);
  check("desktop timeline expands",{width:desktop.width});
  await page.screenshot({path:"artifacts/live-playback-chapter-desktop.png",fullPage:true});
  const sourceState=await openSources();
  const manager=page.getByRole("dialog",{name:"Versions & sources",exact:true});
  const source=manager.getByRole("combobox",{name:"Playback source choice",exact:true});
  await expect(source).toBeEnabled();
  const unchanged=(await actual()).position;
  for(const mode of ["original","server"]){
    await expect(source).toBeEnabled();
    const option=source.locator(`option[value="${mode}"]`);
    // The dialog can render cached options before its asynchronous refresh settles.
    const playing=await actual();
    const availability=sourceState.tracks.find(track=>playing.src.includes(encodeURIComponent(track.id))) || sourceState.tracks[0];
    if(!availability?.[mode] || sourceState.faults?.[mode])continue;
    await expect(option).toBeEnabled();
    report.sourceMode=mode;
    await source.selectOption(mode);
    await manager.getByRole("button",{name:"Apply source",exact:true}).click();
    await expect(source).toHaveValue(mode);
    // Selecting the source already in use need not reload the audio URL.
    // Assert the reported delivery source and decoded audio instead of URL shape.
    await expect.poll(async()=>{
      const a=await actual();
      const label=await page.locator(".player-dock .playback-source").textContent();
      return a.ready>=2&&!a.error&&(mode==="server" ? label.includes("Host server") : /Online stream|TorBox/.test(label));
    },{timeout:40000}).toBe(true);
    await expect.poll(async()=>(await actual()).position).toBeCloseTo(unchanged,0);
    expect((await actual()).paused).toBe(true);
    await manager.getByRole("button",{name:"Close dialog",exact:true}).click();
    await page.locator(".player-dock").getByRole("button",{name:"Play",exact:true}).click();
    await expect.poll(async()=>{const a=await actual();return !a.paused&&a.position>unchanged;},{timeout:30000}).toBe(true);
    await page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true}).click();
    // Return to the same time so both delivery modes are checked against it.
    await page.locator(".dock-book").click();
    await showControls();
    await page.getByRole("slider",{name:"Seek in chapter",exact:true}).fill(String(Math.round(preview)));
    await openSources();
    check("delivery source plays",{source:mode});
  }
  await page.screenshot({path:"artifacts/live-playback-versions-desktop.png",fullPage:true});
  await manager.getByRole("button",{name:"Close dialog",exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  const openReader=page.getByRole("button",{name:"Open ebook reader",exact:true});
  if(hasEbook){
    await openReader.click();
    if(await page.getByRole("group",{name:"Ebook editions",exact:true}).count())await page.getByRole("group",{name:"Ebook editions",exact:true}).getByRole("button").first().click();
    await expect(page.getByRole("dialog",{name:"Now playing",exact:true})).toBeVisible();
    await expect(page.locator(".reader-viewport iframe")).toBeVisible();
    check("compact player opens linked EPUB");
    await showControls();
    await room.locator(".reader-topbar").getByRole("button",{name:"Close reader",exact:true}).click();
  } else check("no linked EPUB available");
  await page.getByRole("button",{name:`Open title page for ${book.title}`,exact:true}).click();
  await expect(detail).toBeVisible();
  check("compact player cover opens title page");
  expect(report.errors).toEqual([]);
  report.ok=true;
} catch(error) {
  report.ok=false;report.failure=error.message;report.audio=await readAudio?.().catch(()=>null);process.exitCode=1;
} finally {
  await closeProtectedBrowser(context,browser,report);
  fs.mkdirSync("artifacts",{recursive:true});
  fs.writeFileSync("artifacts/playback-workflow-verification.json",JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
