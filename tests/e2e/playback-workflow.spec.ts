import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { playFromLibrary } from "./library-play";

// Books a test imports get a title unique to the run, so a repeat on the same server finds one
// "Play <title>" button, and leave the library afterwards, so what a test played does not become
// the latest played book that the next spec on the server finds in the dock.
const imported: string[] = [];
const unique = (title: string) => `${title} ${randomUUID().slice(0,8)}`;
async function importBook(page: Page, multipart: Record<string, unknown>) {
  const response = await page.request.post("/api/import", {multipart: multipart as any});
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  imported.push(id);
  return id;
}
test.afterEach(async ({page}) => {
  // The books leave first, so a hook that runs out of time still leaves the library as it found it. Then the
  // catalog routes go without waiting for a handler: "wait" sometimes never returned after the page gave up on a
  // catalog read, which held the hook to the test's timeout and skipped the clean-up (the handlers already ignore
  // a fulfil that comes too late, and errors after unrouting are dropped).
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
  await page.unrouteAll({behavior:"ignoreErrors"});
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
  await playFromLibrary(page, title);
  const pause=page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true});
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(async()=>(await audioState(page)).paused).toBe(true);
}
async function showReaderControls(page: Page) {
  const topbar=page.locator(".inline-reader .reader-topbar");
  if(await topbar.isVisible()) return;
  const box=(await page.locator(".inline-reader .reader-viewport").boundingBox())!;
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await expect(topbar).toBeVisible();
}
async function manage(page: Page) {
  await page.locator(".dock-book").click();
  await expect(page.getByText("Loading ebook…",{exact:true})).toBeHidden();
  // With an ebook, Playback options open from the reader's More button.
  if(await page.locator(".inline-reader").count()){
    await showReaderControls(page);
    await page.locator(".inline-reader .reader-topbar").getByRole("button",{name:"More",exact:true}).click();
  }
  // The player's "Audiobook" opens the Audiobook page (#530).
  await page.getByRole("button",{name:"Audiobook",exact:true}).click();
  const audiobook=page.getByRole("region",{name:"Audiobook",exact:true});
  await expect(audiobook.getByRole("radiogroup",{name:"Recordings",exact:true})).toBeVisible();
  return audiobook;
}
// Plays from: a picker that keeps the place (#530).
async function playFrom(page: Page, audiobook: ReturnType<Page["getByRole"]>, source: string) {
  await audiobook.getByRole("button",{name:/^Plays from: /}).click();
  const picker=page.getByRole("dialog",{name:"Plays from",exact:true});
  await picker.getByRole("radio",{name:source,exact:true}).click();
  await expect(picker).toBeHidden();
}
// Report a problem (administrator): what is faulty, the reason and a note.
async function report(page: Page, audiobook: ReturnType<Page["getByRole"]>, what: string, reason?: string) {
  await audiobook.getByRole("button",{name:"Report a problem",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Report a problem",exact:true});
  await dialog.getByRole("radiogroup",{name:"What is faulty",exact:true}).getByRole("radio",{name:what,exact:true}).click();
  if(reason) await dialog.getByRole("radiogroup",{name:"Reason",exact:true}).getByRole("radio",{name:reason,exact:true}).click();
  await dialog.getByRole("button",{name:"Mark as faulty",exact:true}).click();
  await expect(dialog).toBeHidden();
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
    // Settings › Playback saves the choice when it is made (#579).
    await page.goto("/#settings/playback");
    const scope=page.getByRole("radiogroup",{name:"Progress bar shows",exact:true});
    await scope.getByRole("radio",{name:"Current chapter",exact:true}).click();
    await expect.poll(async()=>(await (await page.request.get("/api/appearance")).json()).playback.progressScope).toBe("chapter");
    await page.reload();
    await expect(scope.getByRole("radio",{name:"Current chapter",exact:true})).toHaveAttribute("aria-checked","true");
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
    await page.getByRole("button",{name:/^Playback\b/}).click();
    await page.getByRole("radiogroup",{name:"Progress bar shows",exact:true}).getByRole("radio",{name:"Whole audiobook",exact:true}).click();
    await page.locator(".dock-book").click();
    await expect(page.getByRole("slider",{name:"Seek in audiobook",exact:true})).toHaveValue("151");
    expect((await audioState(page)).paused).toBe(true);
    await page.setViewportSize({width:320,height:740});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);
  } finally { await page.request.put("/api/appearance",{data:appearance}); }
});

test("whole-audiobook seeking crosses real audio files and preserves pause",async({page})=>{
  await instrument(page);
  const title=unique("Timeline across files");
  const id=await importBook(page,{title,author:"Playback QA",one:{name:"One.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")},two:{name:"Two.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}});
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
  await playAndPause(page,title);
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
  const title=unique("Managed playback story");
  const id=await importBook(page,{title,author:"Playback QA",file:{name:"Chapter.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}});
  const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
  expect((await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Companion.epub",mimeType:"application/epub+zip",buffer:await readerFixture()}}})).ok()).toBe(true);
  await page.goto("/");
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.reload();
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await playAndPause(page,title);
  await position(page,160);
  await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Now playing"})).toBeVisible();
  await expect(page.frameLocator(".inline-reader .reader-viewport iframe").getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
  await showReaderControls(page);
  await page.getByRole("button",{name:"Close reader",exact:true}).click();
  await page.getByRole("button",{name:`Open title page for ${title}`,exact:true}).click();
  // The player's "Open title page" opens the Book page (#532), with Read; its This device switch saves the book.
  const bookPage=page.getByRole("region",{name:"Book",exact:true});
  await expect(bookPage).toBeVisible();
  await expect(bookPage.getByRole("button",{name:"Read",exact:true})).toBeEnabled();
  const keep=bookPage.getByRole("switch",{name:"Keep on this device",exact:true});
  await keep.click();
  await expect(keep).toHaveAttribute("aria-checked","true");
  await expect(page.locator("#book-keep-line")).toHaveText(/^Audiobook and ebook · /,{timeout:20000});
  // The Book page's Audiobook row opens the Audiobook page, and only the page (#530).
  await bookPage.getByRole("button",{name:/^Audiobook /}).click();
  const manager=page.getByRole("region",{name:"Audiobook",exact:true});
  await expect(manager).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(manager.getByRole("button",{name:/^Plays from: Automatic$/})).toBeEnabled();
  await playFrom(page,manager,"Device copy");
  await expect.poll(async()=>(await audioState(page)).src).toMatch(/^blob:/);
  expect((await audioState(page)).paused).toBe(true);
  expect((await audioState(page)).position).toBeCloseTo(160,0);
  await playFrom(page,manager,"Server copy");
  await expect.poll(async()=>(await audioState(page)).src).toContain("?source=server");
  await expect.poll(async()=>(await audioState(page)).position).toBeCloseTo(160,0);
  const response=await page.evaluate(async(id)=>{
    const response=await fetch(`/api/media/${id}?source=server`,{headers:{Range:"bytes=0-43"}});
    return {status:response.status,source:response.headers.get("X-Sonder-Media-Source")};
  },book.tracks[0].id);
  expect(response).toEqual({status:206,source:"server"});
  await report(page,manager,"Device copy");
  // The device copy's row says it is marked, and its dialog says so with the reason.
  const deviceRow=manager.getByRole("button",{name:"Device copy Marked faulty",exact:true});
  await expect(deviceRow).toBeVisible();
  await deviceRow.click();
  const copy=page.getByRole("dialog",{name:"Device copy",exact:true});
  await expect(copy.getByText("Device copy marked faulty",{exact:true})).toBeVisible();
  await copy.getByRole("button",{name:"Close dialog",exact:true}).click();
  await expect.poll(async()=>(await audioState(page)).src).toContain(`/api/media/${book.tracks[0].id}`);
  expect((await audioState(page)).paused).toBe(true);
  // The page's address survives a reload, and so does the mark.
  await page.reload();
  await expect(manager.getByRole("button",{name:"Device copy Marked faulty",exact:true})).toBeVisible();
  await page.locator(".mobile-nav").getByRole("button",{name:"My library",exact:true}).click();
  await playFromLibrary(page, title);
  await expect(page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true})).toBeVisible();
  await page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true}).click();
  expect((await audioState(page)).src).not.toMatch(/^blob:/);
  await manage(page);
  // Removing the device copy asks once, says what stays, and clears its mark.
  await manager.getByRole("button",{name:"Device copy Marked faulty",exact:true}).click();
  await page.getByRole("dialog",{name:"Device copy",exact:true}).getByRole("button",{name:"Remove from this device",exact:true}).click();
  const confirm=page.getByRole("dialog",{name:"Remove from this device?",exact:true});
  await expect(confirm).toHaveAccessibleDescription("Your place and the library entry stay.");
  await confirm.getByRole("button",{name:"Remove",exact:true}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(manager.getByRole("listitem").filter({hasText:"Device copy"})).toHaveText("Device copyNone");
  await expect(manager.getByRole("button",{name:/^Device copy/})).toHaveCount(0);
  await expect(manager.getByText("Marked faulty",{exact:true})).toHaveCount(0);
  await report(page,manager,"Recording","Wrong language");
  await expect(manager.getByText("Recording marked faulty",{exact:true})).toBeVisible();
  await expect(manager.getByRole("radio",{name:/Marked faulty/})).toHaveAttribute("aria-checked","true");
  // A faulty recording rules out every source.
  await manager.getByRole("button",{name:/^Plays from: /}).click();
  for (const source of ["Automatic","Device copy","Server copy","Original stream"])
    await expect(page.getByRole("dialog",{name:"Plays from",exact:true}).getByRole("radio",{name:source,exact:true})).toBeDisabled();
  await page.keyboard.press("Escape");
  const saved=(await(await page.request.get(`/api/recordings/${book.recordingId}/sources`)).json());
  expect(saved.faults.recording.reason).toBe("wrong-language");
  expect((await page.request.get(`/api/media/${book.tracks[0].id}`)).status()).toBe(409);
  await manager.getByRole("button",{name:"Clear the mark",exact:true}).click();
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
  const title=unique("Release choice");
  const id=await importBook(page,{title,author:"Version QA",file:{name:"Chapter.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}});
  const english=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
  // A second recording of the same work on the same audio file (#530: the Audiobook page lists the work's recordings).
  const suffix=Math.random().toString(36).slice(2,8);
  const french={editionId:`edition-french-${suffix}`,recordingId:`recording-french-${suffix}`,trackId:`track-french-${suffix}`};
  expect((await page.request.post("/api/test/seed-local-audio",{data:{relPath:`imports/${english.tracks[0].id}.mp3`,editionId:french.editionId,recordingId:french.recordingId,trackId:french.trackId,workId:english.workId,narrator:"French Reader",language:"French",duration:english.tracks[0].duration}})).ok()).toBe(true);
  // The seeded recording leaves the library after the test too (#645).
  imported.push(french.editionId);
  await page.request.post("/api/progress",{data:{recordingId:french.recordingId,trackId:french.trackId,position:42,duration:english.tracks[0].duration,updatedAt:Date.now()}});
  // The Library still shows one tile per recording: the French one gets a title of its own there.
  await page.route("**/api/books",async route=>{
    const response=await route.fetch(), all=await response.json();
    for (const b of all) if(b.recordingId===french.recordingId) b.title=`${title} French`;
    // A read the app gave up on meanwhile is already answered.
    await route.fulfill({response,json:all}).catch(()=>{});
  });
  await page.goto("/");
  await playAndPause(page,title);
  await position(page,210);
  const dialog=await manage(page);
  await dialog.getByRole("radio",{name:/French Reader/}).click();
  // French has an older checkpoint than the English place being left: it is offered, not applied.
  await page.getByRole("button",{name:"Resume saved position (00:00:42)",exact:true}).click();
  await expect.poll(async()=>(await audioState(page)).src).toContain(french.trackId);
  await expect.poll(async()=>(await audioState(page)).position).toBeGreaterThanOrEqual(42);
  expect((await audioState(page)).position).toBeLessThan(50);
  await dialog.getByRole("radio",{name:/Version QA/}).click();
  await page.getByRole("button",{name:"Resume saved position (00:03:30)",exact:true}).click();
  await expect.poll(async()=>(await audioState(page)).src).toContain(english.tracks[0].id);
  await expect.poll(async()=>(await audioState(page)).position).toBeGreaterThanOrEqual(210);
  expect((await audioState(page)).position).toBeLessThan(220);
});

test.describe("touch seeking",()=>{
  test.use({hasTouch:true,isMobile:true});
  test("releasing a fine-seek gesture keeps the exact previewed destination",async({page,context})=>{
    await instrument(page);
    const title=unique("Touch seek story");
    await importBook(page,{title,author:"Seek QA",file:{name:"Chapter.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}});
    await page.goto("/");
    await playAndPause(page,title);
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
  const title=unique("Retry checkpoint");
  const id=await importBook(page,{title,author:"Playback QA",file:{name:"Chapter.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}});
  const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
  await page.goto("/");await playAndPause(page,title);await position(page,160);
  await page.evaluate(() => ((window as any).__audioElements as HTMLAudioElement[]).find(a => !!a.src)!.dispatchEvent(new Event("pause")));
  await expect.poll(async()=>(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id).progress?.position).toBeGreaterThanOrEqual(159);
  await page.getByRole("button",{name:`Open title page for ${title}`,exact:true}).click();
  await page.getByRole("region",{name:"Book",exact:true}).getByRole("button",{name:/^Audiobook /}).click();
  const manager=page.getByRole("region",{name:"Audiobook",exact:true});
  const source=(url:URL)=>url.pathname===`/api/media/${book.tracks[0].id}` && url.searchParams.get("source")==="server";
  await page.route(source,route=>route.abort());
  await playFrom(page,manager,"Server copy");
  await expect.poll(()=>page.evaluate(() => ((window as any).__audioElements as HTMLAudioElement[]).find(a => !!a.src)?.error?.code)).toBeTruthy();
  await page.unroute(source);
  await page.locator(".player-dock").getByRole("button",{name:"Play",exact:true}).click();
  await expect.poll(async()=>(await audioState(page)).position).toBeGreaterThanOrEqual(159);
  await expect.poll(async()=>(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id).progress?.position).toBeGreaterThanOrEqual(159);
});
});
