// Verify deployed UI with real media while protecting the listener's canonical progress.
import fs from "node:fs";
import { chromium, expect as baseExpect } from "@playwright/test";
import { defaultAppearance } from "../src/appearance.ts";
const expect=baseExpect.configure({timeout:20000});
process.loadEnvFile(".env");
const recordingId=process.argv[2];
if(!recordingId) throw new Error("Usage: node --import tsx scripts/verify-playback-workflow.mjs recording-id");
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome"});
const context=await browser.newContext({baseURL:process.env.SONDER_VERIFY_URL || "https://sonder.pecori.no",viewport:{width:390,height:844},hasTouch:true,serviceWorkers:"block"});
const report={recordingId,protectedWrites:0,checks:[],errors:[]};
const check=(name,details={})=>report.checks.push({name,...details});
try {
  const login=await context.request.post("/api/auth/login",{data:{password:process.env.APP_PASSWORD}});
  if(!login.ok()) throw new Error("Sign-in failed");
  const books=await(await context.request.get("/api/books")).json();
  const book=books.find(b=>b.recordingId===recordingId);
  if(!book) throw new Error("Recording not found");
  await context.route("**/api/progress",async route=>{
    report.protectedWrites++;
    await route.fulfill({json:{progress:route.request().postDataJSON()}});
  });
  await context.route("**/api/reader/*/progress",async route=>{
    report.protectedWrites++;
    const data=route.request().postDataJSON();
    await route.fulfill({json:{checkpoint:{...data,revision:(data.baseRevision||0)+1}}});
  });
  // Playback preferences in this browser stay local and do not alter account defaults.
  await context.addInitScript(appearance=>{
    localStorage.setItem("sonder-appearance-device","true");
    localStorage.setItem("sonder-appearance",JSON.stringify(appearance));
    const Native=window.Audio;
    window.__actualAudio=[];
    window.Audio=class extends Native {
      constructor(...args){super(...args);window.__actualAudio.push(this);}
    };
  },{...defaultAppearance,playback:{progressScope:"chapter"}});
  const page=await context.newPage();
  page.on("pageerror",error=>report.errors.push(error.message));
  const actual=()=>page.evaluate(()=>{
    const a=window.__actualAudio.find(a=>!!a.src);
    return a && {position:a.currentTime,paused:a.paused,duration:a.duration,src:a.src,ready:a.readyState,error:a.error?.message};
  });
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
  if(await page.getByRole("button",{name:"Playback options",exact:true}).count())await page.getByRole("button",{name:"Playback options",exact:true}).click();
  await page.getByRole("button",{name:"Versions & sources",exact:true}).click();
  const manager=page.getByRole("dialog",{name:"Versions & sources",exact:true});
  const source=manager.getByRole("combobox",{name:"Playback source choice",exact:true});
  await expect(source).toBeEnabled();
  const unchanged=(await actual()).position;
  for(const mode of ["original","server"]){
    await expect(source).toBeEnabled();
    const option=source.locator(`option[value="${mode}"]`);
    if(await option.isDisabled())continue;
    await source.selectOption(mode);
    await manager.getByRole("button",{name:"Apply source",exact:true}).click();
    await expect.poll(async()=>{const a=await actual();return a.src.includes(`?source=${mode}`)&&a.ready>=2&&!a.error;},{timeout:40000}).toBe(true);
    await expect.poll(async()=>(await actual()).position).toBeCloseTo(unchanged,0);
    expect((await actual()).paused).toBe(true);
    await manager.getByRole("button",{name:"Close dialog",exact:true}).click();
    await page.locator(".player-dock").getByRole("button",{name:"Play",exact:true}).click();
    await expect.poll(async()=>{const a=await actual();return !a.paused&&a.position>unchanged;},{timeout:30000}).toBe(true);
    await page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true}).click();
    // Return to the same time so both delivery modes are checked against it.
    await page.locator(".dock-book").click();
    await page.getByRole("slider",{name:"Seek in chapter",exact:true}).fill(String(Math.round(preview)));
    if(await page.getByRole("button",{name:"Playback options",exact:true}).count())await page.getByRole("button",{name:"Playback options",exact:true}).click();
  await page.getByRole("button",{name:"Versions & sources",exact:true}).click();
    check("delivery source plays",{source:mode});
  }
  await page.screenshot({path:"artifacts/live-playback-versions-desktop.png",fullPage:true});
  await manager.getByRole("button",{name:"Close dialog",exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
  if(await page.getByRole("group",{name:"Ebook editions",exact:true}).count())await page.getByRole("group",{name:"Ebook editions",exact:true}).getByRole("button").first().click();
  await expect(page.getByRole("dialog",{name:"Now playing",exact:true})).toBeVisible();
  await expect(page.locator(".reader-viewport iframe")).toBeVisible();
  check("compact player opens linked EPUB");
  await page.getByRole("button",{name:"Close dialog",exact:true}).click();
  await page.getByRole("button",{name:`Open title page for ${book.title}`,exact:true}).click();
  await expect(detail).toBeVisible();
  check("compact player cover opens title page");
  expect(report.errors).toEqual([]);
  report.ok=true;
} catch(error) {
  report.ok=false;report.failure=error.message;process.exitCode=1;
} finally {
  await context.unrouteAll({behavior:"wait"});
  await browser.close();
  fs.mkdirSync("artifacts",{recursive:true});
  fs.writeFileSync("artifacts/playback-workflow-verification.json",JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
