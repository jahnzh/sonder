import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";

test.afterEach(async ({page}) => {
  // Drain the catalog routes before Playwright tears down its request context.
  await page.unrouteAll({behavior:"wait"});
});

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = [];
    (window as any).__audioElements = elements;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); elements.push(this); }
    };
  });
}
async function audioState(page: Page) {
  return page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find(a => !!a.src)!;
    return {position:audio.currentTime, duration:audio.duration, paused:audio.paused, src:audio.src};
  });
}
async function position(page: Page, value: number) {
  await page.evaluate(value => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find(a => !!a.src)!;
    audio.currentTime=value;
    audio.dispatchEvent(new Event("timeupdate"));
  }, value);
}
async function playAndPause(page: Page, title: string) {
  await page.getByRole("button", {name:`Play ${title}`,exact:true}).click();
  const pause=page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true});
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(async()=>(await audioState(page)).paused).toBe(true);
}
async function manage(page: Page) {
  await page.locator(".dock-book").click();
  await expect(page.getByText("Loading ebook…",{exact:true})).toBeHidden();
  const reveal=page.getByRole("button",{name:"Show reader controls",exact:true});
  if(await reveal.isVisible()) await reveal.click();
  if(await page.getByRole("button",{name:"Playback options",exact:true}).count()) await page.getByRole("button",{name:"Playback options",exact:true}).click();
  await page.getByRole("button",{name:"Versions & sources",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Versions & sources",exact:true})).toBeVisible();
}

test("chapter progress persists; precision dragging previews, slows with distance and cancels safely; wide bars expand", async ({page})=>{
  await instrument(page);
  const appearance=await (await page.request.get("/api/appearance")).json();
  await page.route("**/api/books",async route=>{
    const response=await route.fetch(), books=await response.json();
    const alice=books.find((b:any)=>b.id==="alice");
    alice.tracks=alice.tracks.slice(0,1);
    alice.tracks[0].chapters=[{title:"Chapter one",start:0,end:120.12345678},{title:"Chapter two",start:120.12345678,end:300.12345678},{title:"Chapter three",start:300.12345678,end:alice.tracks[0].duration}];
    await route.fulfill({response,json:books});
  });
  try {
    await page.goto("/#settings");
    await page.getByRole("combobox",{name:"Playback progress bar",exact:true}).selectOption("chapter");
    await page.getByRole("button",{name:"Save playback settings",exact:true}).click();
    await expect(page.getByText("Playback settings saved.", {exact:true})).toBeVisible();
    await page.reload();
    await expect(page.getByRole("combobox",{name:"Playback progress bar",exact:true})).toHaveValue("chapter");
    await page.locator(".mobile-nav").getByRole("button",{name:"My library",exact:true}).click();
    await playAndPause(page,"Alice’s Adventures in Wonderland");
    await position(page,150.12345678);
    await page.locator(".dock-book").click();
    const slider=page.getByRole("slider",{name:"Seek in chapter",exact:true});
    expect(Number(await slider.getAttribute("max"))).toBeCloseTo(180,8);
    await expect(slider).toHaveValue("30");
    await expect(slider).toHaveAttribute("aria-valuetext",/0:30 elapsed, 2:30 remaining in Chapter two/);
    const box=(await slider.boundingBox())!, width=box.width-18;
    const x=box.x+9+30/180*width, y=box.y+box.height/2;
    await page.mouse.move(x,y); await page.mouse.down();
    await page.mouse.move(x,y-156);
    await expect(slider).toHaveValue("30");
    await page.mouse.move(x+60,y-156,{steps:5});
    const fine=Number(await slider.inputValue())-30;
    expect(fine).toBe(Math.floor(30+60/width*180/4)-30);
    expect((await audioState(page)).position).toBeCloseTo(150,0);
    await page.mouse.up();
    await expect.poll(async()=>(await audioState(page)).position).toBeCloseTo(150+fine,0);
    await slider.fill("30");
    await page.mouse.move(x,y); await page.mouse.down();
    await page.mouse.move(x+60,y,{steps:5}); await page.mouse.up();
    const normal=(await audioState(page)).position-150;
    expect(normal/fine).toBeCloseTo(4,0);
    await slider.fill("30");
    await page.mouse.move(x,y); await page.mouse.down();
    await page.mouse.move(x+30,y);
    await slider.dispatchEvent("pointercancel",{pointerId:1});
    await page.mouse.up();
    expect((await audioState(page)).position).toBeCloseTo(150,0);
    await slider.focus(); await page.keyboard.press("ArrowRight");
    await expect.poll(async()=>(await audioState(page)).position).toBeCloseTo(151,0);
    // Release coordinates must not add an unseen final movement to the preview.
    await slider.fill("30");
    await page.mouse.move(x,y); await page.mouse.down();
    await page.mouse.move(x+30,y-156);
    const shown=Number(await slider.inputValue());
    await slider.locator("..").dispatchEvent("pointerup",{pointerId:1,clientX:x+130,clientY:y});
    await page.mouse.up();
    await expect.poll(async()=>(await audioState(page)).position).toBeCloseTo(120.12345678+shown,5);
    await slider.fill("31");
    const mobileWidth=box.width;
    await page.screenshot({path:"artifacts/playback-chapter-mobile.png",fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await expect.poll(async()=>(await slider.boundingBox())!.width).toBeGreaterThan(mobileWidth*1.7);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(1440);
    await page.screenshot({path:"artifacts/playback-chapter-desktop.png",fullPage:true});
    await page.getByRole("button",{name:"Close dialog",exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await page.locator(".mobile-nav").getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("combobox",{name:"Playback progress bar",exact:true}).selectOption("book");
    await page.locator(".dock-book").click();
    await expect(page.getByRole("slider",{name:"Seek in audiobook",exact:true})).toHaveValue("151");
    expect((await audioState(page)).paused).toBe(true);
    await page.setViewportSize({width:320,height:740});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);
  } finally { await page.request.put("/api/appearance",{data:appearance}); }
});

test("whole-audiobook seeking crosses real audio files and preserves pause",async({page})=>{
  await instrument(page);
  const result=await page.request.post("/api/import",{multipart:{title:"Timeline across files",author:"Playback QA",one:{name:"One.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")},two:{name:"Two.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
  expect(result.ok()).toBe(true);
  const id=(await result.json()).id;
  const book=(await (await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
  let releaseFirst!:()=>void,held=false;
  const firstRequest=new Promise<void>(resolve=>{releaseFirst=resolve;});
  await page.route("**/api/progress",async route=>{
    if(route.request().method()==="POST" && route.request().postDataJSON().recordingId===book.recordingId && !held){
      held=true;
      await firstRequest;
    }
    await route.continue();
  });
  try {
  await page.goto("/");
  await playAndPause(page,"Timeline across files");
  await expect.poll(()=>held).toBe(true);
  await page.locator(".dock-book").click();
  const length=book.tracks[0].duration;
  const slider=page.getByRole("slider",{name:"Seek in audiobook",exact:true});
  await slider.fill(String(Math.round(length+100)));
  await expect.poll(async()=>(await audioState(page)).src).toContain(book.tracks[1].id);
  await expect.poll(async()=>(await audioState(page)).position).toBeCloseTo(100,0);
  expect((await audioState(page)).paused).toBe(true);
  releaseFirst();
  await expect.poll(async()=>{
    const current=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
    return current.progress?.trackId;
  }).toBe(book.tracks[1].id);
  } finally { releaseFirst(); }
});

test("playback opens the reader and title page; downloaded sources can be switched, flagged and removed",async({page})=>{
  test.setTimeout(90000);
  await instrument(page);
  const result=await page.request.post("/api/import",{multipart:{title:"Managed playback story",author:"Playback QA",file:{name:"Chapter.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
  expect(result.ok()).toBe(true);
  const id=(await result.json()).id;
  const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
  expect((await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Companion.epub",mimeType:"application/epub+zip",buffer:await readerFixture()}}})).ok()).toBe(true);
  await page.goto("/");
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.reload();
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await playAndPause(page,"Managed playback story");
  await position(page,160);
  await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Now playing"})).toBeVisible();
  await expect(page.frameLocator(".inline-reader .reader-viewport iframe").getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:"Show reader controls"}).click();
  await page.getByRole("button",{name:"Close reader",exact:true}).click();
  await page.getByRole("button",{name:"Open title page for Managed playback story",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Book details"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Read ebook",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Save offline",exact:true}).click();
  await expect(page.getByRole("button",{name:"Downloaded",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Versions & sources",exact:true}).click();
  const manager=page.getByRole("dialog",{name:"Versions & sources",exact:true});
  // Opening the manager from a title page should expose just the manager.
  await expect(manager).toBeVisible();
  const choice=manager.getByRole("combobox",{name:"Playback source choice",exact:true});
  await expect(choice).toBeEnabled();
  await choice.selectOption("device");
  await manager.getByRole("button",{name:"Apply source",exact:true}).click();
  await expect.poll(async()=>(await audioState(page)).src).toMatch(/^blob:/);
  expect((await audioState(page)).paused).toBe(true);
  expect((await audioState(page)).position).toBeCloseTo(160,0);
  await choice.selectOption("server");
  await manager.getByRole("button",{name:"Apply source",exact:true}).click();
  await expect.poll(async()=>(await audioState(page)).src).toContain("?source=server");
  await expect.poll(async()=>(await audioState(page)).position).toBeCloseTo(160,0);
  const response=await page.evaluate(async(id)=>{
    const response=await fetch(`/api/media/${id}?source=server`,{headers:{Range:"bytes=0-43"}});
    return {status:response.status,source:response.headers.get("X-Sonder-Media-Source")};
  },book.tracks[0].id);
  expect(response).toEqual({status:206,source:"server"});
  await manager.getByRole("button",{name:"Mark as faulty",exact:true}).click();
  await manager.getByRole("combobox",{name:"Faulty item",exact:true}).selectOption("device");
  await manager.getByRole("button",{name:"Save fault report",exact:true}).click();
  await expect(manager.getByText("Device copy marked faulty",{exact:true})).toBeVisible();
  await expect.poll(async()=>(await audioState(page)).src).toContain(`/api/media/${book.tracks[0].id}`);
  expect((await audioState(page)).paused).toBe(true);
  await page.reload();
  await page.getByRole("button",{name:"Play Managed playback story",exact:true}).click();
  await expect(page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true})).toBeVisible();
  await page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true}).click();
  expect((await audioState(page)).src).not.toMatch(/^blob:/);
  await manage(page);
  await expect(manager.getByText("Device copy marked faulty",{exact:true})).toBeVisible();
  await manager.getByRole("button",{name:"Remove device copy",exact:true}).click();
  await page.getByRole("dialog",{name:"Remove downloaded copy?",exact:true}).getByRole("button",{name:"Remove copy",exact:true}).click();
  await expect(manager.getByRole("button",{name:"Remove device copy",exact:true})).toBeDisabled();
  await expect(manager.getByText("Device copy marked faulty",{exact:true})).toHaveCount(0);
  await manager.getByRole("button",{name:"Mark as faulty",exact:true}).click();
  await manager.getByRole("combobox",{name:"Faulty item",exact:true}).selectOption("recording");
  await manager.getByRole("combobox",{name:"Fault reason",exact:true}).selectOption("wrong-language");
  await manager.getByRole("button",{name:"Save fault report",exact:true}).click();
  await expect(manager.getByText("Recording marked faulty",{exact:true})).toBeVisible();
  await expect(manager.getByRole("button",{name:"Apply source",exact:true})).toBeDisabled();
  const saved=(await(await page.request.get(`/api/recordings/${book.recordingId}/sources`)).json());
  expect(saved.faults.recording.reason).toBe("wrong-language");
  expect((await page.request.get(`/api/media/${book.tracks[0].id}`)).status()).toBe(409);
  await manager.getByRole("button",{name:"Clear fault flag",exact:true}).click();
  await expect(manager.getByText("Recording marked faulty",{exact:true})).toHaveCount(0);
  await expect(manager.getByRole("alert")).toHaveCount(0);
  expect((await audioState(page)).paused).toBe(true);
  const after=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
  expect(after.inLibrary).toBe(true);
  expect(after.progress.position).toBeGreaterThanOrEqual(160);
  expect(after.tracks).toHaveLength(1);
  await page.screenshot({path:"artifacts/playback-versions-mobile.png",fullPage:true});
});

test("switching audiobook versions resumes each recording's own checkpoint",async({page})=>{
  await instrument(page);
  const books=[];
  for (const title of ["Release choice English","Release choice French"]) {
    const response=await page.request.post("/api/import",{multipart:{title,author:"Version QA",file:{name:"Chapter.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
    expect(response.ok()).toBe(true);
    const id=(await response.json()).id;
    books.push((await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id));
  }
  const [english,french]=books;
  await page.request.post("/api/progress",{data:{recordingId:french.recordingId,trackId:french.tracks[0].id,position:42,duration:french.tracks[0].duration,updatedAt:Date.now()}});
  await page.route("**/api/books",async route=>{
    const response=await route.fetch(), all=await response.json();
    for (const b of all) {
      if(b.id===english.id) Object.assign(b,{workId:english.workId,narrator:"English Reader",language:"English"});
      if(b.id===french.id) Object.assign(b,{workId:english.workId,narrator:"French Reader",language:"French"});
    }
    await route.fulfill({response,json:all});
  });
  await page.goto("/");
  await playAndPause(page,"Release choice English");
  await position(page,210);
  await manage(page);
  const dialog=page.getByRole("dialog",{name:"Versions & sources",exact:true});
  await dialog.getByRole("button",{name:/French Reader/}).click();
  await dialog.getByRole("button",{name:"Use this version",exact:true}).click();
  await expect.poll(async()=>(await audioState(page)).src).toContain(french.tracks[0].id);
  await expect.poll(async()=>(await audioState(page)).position).toBeGreaterThanOrEqual(42);
  expect((await audioState(page)).position).toBeLessThan(50);
  await dialog.getByRole("button",{name:/English Reader/}).click();
  await dialog.getByRole("button",{name:"Use this version",exact:true}).click();
  await expect.poll(async()=>(await audioState(page)).src).toContain(english.tracks[0].id);
  await expect.poll(async()=>(await audioState(page)).position).toBeGreaterThanOrEqual(210);
  expect((await audioState(page)).position).toBeLessThan(220);
});

test.describe("touch seeking",()=>{
  test.use({hasTouch:true,isMobile:true});
  test("releasing a fine-seek gesture keeps the exact previewed destination",async({page,context})=>{
    await instrument(page);
    const response=await page.request.post("/api/import",{multipart:{title:"Touch seek story",author:"Seek QA",file:{name:"Chapter.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
    expect(response.ok()).toBe(true);
    await page.goto("/");
    await playAndPause(page,"Touch seek story");
    await position(page,200);
    await page.locator(".dock-book").click();
    const slider=page.getByRole("slider",{name:"Seek in audiobook",exact:true});
    await slider.scrollIntoViewIfNeeded();
    const cdp=await context.newCDPSession(page);
    const box=(await slider.boundingBox())!,width=box.width-18,length=Number(await slider.getAttribute("max"));
    const x=box.x+9+200/length*width, y=box.y+box.height/2;
    await page.evaluate(()=>{
      (window as any).__seekEvents=[];
      const audio=((window as any).__audioElements as HTMLAudioElement[]).find(a=>!!a.src)!;
      audio.addEventListener("seeking",()=> (window as any).__seekEvents.push(audio.currentTime));
    });
    const touch=async(type:"touchStart"|"touchMove"|"touchEnd",tx=x,ty=y)=>cdp.send("Input.dispatchTouchEvent",{type,touchPoints:type==="touchEnd"?[]:[{x:tx,y:ty,id:1}]});
    await touch("touchStart");
    await touch("touchMove",x,y-156);
    await touch("touchMove",x+60,y-156);
    // Touch moves are coalesced by the browser. Read the preview after it paints.
    await expect(slider).toHaveValue(String(Math.floor(200+60/width*length/4)));
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    const preview=Number(await slider.inputValue());
    const text=await slider.getAttribute("aria-valuetext");
    expect((await audioState(page)).position).toBeCloseTo(200,0);
    await touch("touchEnd");
    await expect.poll(async()=>(await audioState(page)).position,{message:JSON.stringify(await page.evaluate(()=>(window as any).__seekEvents))}).toBeCloseTo(preview,0);
    await expect(slider).toHaveAttribute("aria-valuetext",text!);
    expect(await page.evaluate(()=>(window as any).__seekEvents)).toEqual([preview]);

    await page.getByRole("button",{name:"Close dialog",exact:true}).click();
    const compact=page.getByRole("slider",{name:"Playback position",exact:true});
    const compactBox=(await compact.boundingBox())!,compactWidth=compactBox.width-18;
    const cx=compactBox.x+9+preview/length*compactWidth,cy=compactBox.y+compactBox.height/2;
    await touch("touchStart",cx,cy);
    await touch("touchMove",cx,cy-156);
    await touch("touchMove",cx+45,cy-156);
    await expect(compact).toHaveValue(String(Math.floor(preview+45/compactWidth*length/4)));
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    const compactPreview=Number(await compact.inputValue());
    await touch("touchEnd");
    await expect.poll(async()=>(await audioState(page)).position).toBe(compactPreview);
    expect(await page.evaluate(()=>(window as any).__seekEvents)).toEqual([preview,compactPreview]);
  });
});

test.describe("failed source retry",()=>{
 test.use({serviceWorkers:"block"});
 test("a failed source reload preserves the saved listening position on retry",async({page})=>{
  await instrument(page);
  const result=await page.request.post("/api/import",{multipart:{title:"Retry checkpoint",author:"Playback QA",file:{name:"Chapter.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
  const id=(await result.json()).id;
  const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
  await page.goto("/");await playAndPause(page,"Retry checkpoint");await position(page,160);
  await page.evaluate(() => ((window as any).__audioElements as HTMLAudioElement[]).find(a => !!a.src)!.dispatchEvent(new Event("pause")));
  await expect.poll(async()=>(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id).progress?.position).toBeGreaterThanOrEqual(159);
  await page.getByRole("button",{name:"Open title page for Retry checkpoint",exact:true}).click();
  await page.getByRole("button",{name:"Versions & sources",exact:true}).click();
  const manager=page.getByRole("dialog",{name:"Versions & sources"});
  await manager.getByRole("combobox",{name:"Playback source choice"}).selectOption("server");
  const source=(url:URL)=>url.pathname===`/api/media/${book.tracks[0].id}` && url.searchParams.get("source")==="server";
  await page.route(source,route=>route.abort());
  await manager.getByRole("button",{name:"Apply source"}).click();
  await expect.poll(()=>page.evaluate(() => ((window as any).__audioElements as HTMLAudioElement[]).find(a => !!a.src)?.error?.code)).toBeTruthy();
  await page.unroute(source);
  await manager.getByRole("button",{name:"Apply source"}).click();
  await expect.poll(async()=>(await audioState(page)).position).toBeCloseTo(160,0);
  await expect.poll(async()=>(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id).progress?.position).toBeGreaterThanOrEqual(159);
});
});
