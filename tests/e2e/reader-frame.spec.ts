// @projects firefox, webkit, mobile-chrome, mobile-firefox, mobile-safari, webkit-iphone-now-playing, mobile-iphone-slice14
import {test,expect,type Page,type Locator} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
import { gotoRead } from "./read-face";
import {bookText} from "./reader-view";
// The book page's gestures reach the reader in every engine, and the app's own policy refuses inline script. The EPUB's
// frame, its sandbox and its per-section Content-Security-Policy went with epub.js (#806); the reader shows the server's
// prepared text, whose hostile-markup checks are in prepared-view.spec.ts and prepared-text.spec.ts.
async function importBook(page:Page,title:string,link=true,fixture?:Buffer){
 const audio=await page.request.post("/api/import",{multipart:{title,author:"Frame QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(audio.ok()).toBe(true);
 const audioId=(await audio.json()).id;
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===audioId);
 const upload=await page.request.post(`/api/ebooks/import${link ? `?workId=${book.workId}` : ""}`,{multipart:{file:{name:`${title}.epub`,mimeType:"application/epub+zip",buffer:fixture||await readerFixture({title})}}});
 expect(upload.ok()).toBe(true);
 const id=(await upload.json()).id;
 await gotoRead(page, id);
 await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeVisible();
 return id;
}
async function openReader(page:Page,title:string,link=true){
 const id=await importBook(page,title,link);
 const room=page.locator(".reader-room");
 const frame=bookText(page);
 await expect(frame.getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
 return {id,room,frame};
}
// Find a line of actual text in the visible part of the reader's band. The text can move or repaginate after the
// viewport was measured for a tap.
async function visibleSentencePoint(viewport:Locator){
 return viewport.evaluate(host=>{
  const bounds=host.getBoundingClientRect();
  const text=host.querySelector(".prepared-text");
  if(!text || document.fonts.status!=="loaded")return null;
  for(const paragraph of text.querySelectorAll("p")){
   const range=document.createRange();range.selectNodeContents(paragraph);
   for(const rect of range.getClientRects()){
    const left=Math.max(bounds.left,rect.left,0);
    const right=Math.min(bounds.right,rect.right,window.innerWidth);
    const top=Math.max(bounds.top,rect.top,0);
    const bottom=Math.min(bounds.bottom,rect.bottom,window.innerHeight);
    if(right-left<4 || bottom-top<4)continue;
    const x=(left+right)/2,y=(top+bottom)/2;
    // The point is on the book's text itself, not on a control drawn over it.
    const hit=document.elementFromPoint(x,y);
    if(hit && paragraph.contains(hit))return {x,y};
   }
  }
  return null;
 });
}
async function longPressSentence(page:Page,viewport:Locator){
 const state:{previous:{x:number,y:number}|null;point:{x:number,y:number}|null}={previous:null,point:null};
 // Wait until the current text line is stable, then press exactly once.
 await expect.poll(async()=>{
  const point=await visibleSentencePoint(viewport),previous=state.previous;
  state.previous=point;
  if(point && previous && Math.abs(point.x-previous.x)<0.5 && Math.abs(point.y-previous.y)<0.5){state.point=point;return true;}
  return false;
 }).toBe(true);
 if(!state.point)throw new Error("No stable visible sentence in the reader");
 await page.mouse.move(state.point.x,state.point.y);
 await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
}
// Without a matching map the long-press says so in the foot's row, as an error (#591, spec #586 "Messages in the foot").
async function expectNoMapInFoot(room:Locator){
 await expect(room.locator(".reader-player .reader-message").getByRole("alert")).toHaveText("Prepare a matching audiobook map for this passage first.");
}
async function expectNoAlignment(page:Page,id:string){
 const response=await page.request.get(`/api/alignments?ebookId=${id}`);
 expect(response.ok()).toBe(true);
 expect((await response.json()).jobs).toEqual([]);
}
test("taps, page turns and long-press on the book page reach the reader",async({page,browserName},testInfo)=>{
 const {id,room}=await openReader(page,`Frame gestures ${browserName} ${testInfo.repeatEachIndex}`,false);
 await expectNoAlignment(page,id);
 const topbar=room.locator(".reader-topbar"),box=(await room.locator(".reader-viewport").boundingBox())!;
 await expect(topbar).toBeHidden();
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeVisible();
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeHidden();
 // A tap on the right edge turns the page, which saves a reading checkpoint.
 const revision=(await(await page.request.get(`/api/reader/${id}`)).json()).checkpoint?.revision||0;
 await page.mouse.click(box.x+box.width*0.9,box.y+box.height/2);
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${id}`)).json()).checkpoint?.revision||0).toBeGreaterThan(revision);
 // Long-press listens from that sentence; without a narration map it asks for one.
 await longPressSentence(page,room.locator(".reader-viewport"));
 await expectNoMapInFoot(room);
});
// A page busy as the finger lifts (a part laid out, a highlight redrawn) runs pointerup late: the tap is still a
// tap, timed by its events, not dropped or taken for a long press that listens from the sentence (#589).
test("a short tap shows the controls while the page is busy as the finger lifts",async({page,browserName},testInfo)=>{
 // Firefox's driver sends the button's release only once the page has handled the press, so the release is stamped
 // after the 700 ms too: there the tap below is a real 700 ms hold and cannot stand for a short one.
 test.skip(browserName==="firefox","the driver stamps the release after the busy press, a 700 ms hold");
 const {id,room}=await openReader(page,`Frame busy tap ${browserName} ${testInfo.repeatEachIndex}`,false);
 await expectNoAlignment(page,id);
 const topbar=room.locator(".reader-topbar"),box=(await room.locator(".reader-viewport").boundingBox())!;
 await expect(topbar).toBeHidden();
 // After the reader's own pointerdown listener (on the band's scroller, src/prepared-view.ts), the page is held for
 // 700 ms, past the 550 of a long press.
 const blocked=await room.locator(".reader-viewport").evaluate(host=>{
  const scroller=host.querySelector(".prepared-scroll");
  scroller?.addEventListener("pointerdown",()=>{const until=Date.now()+700;while(Date.now()<until);},{once:true});
  return !!scroller;
 });
 expect(blocked).toBe(true);
 const started=Date.now();
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeVisible();
 expect(Date.now()-started).toBeGreaterThanOrEqual(700);
 // Not a long press: it would have asked for a narration map for this book without one.
 await page.waitForTimeout(300);
 await expect(page.getByText("Prepare a matching audiobook map for this passage first.")).toHaveCount(0);
});
test("long-press reaches a sentence after the reader is resized",async({page,browserName},testInfo)=>{
 const {id,room}=await openReader(page,`Frame resize ${browserName} ${testInfo.repeatEachIndex}`,false);
 await expectNoAlignment(page,id);
 const viewport=room.locator(".reader-viewport"),box=(await viewport.boundingBox())!;
 await page.mouse.click(box.x+box.width*0.9,box.y+box.height/2);
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${id}`)).json()).checkpoint?.revision||0).toBeGreaterThan(0);
 await page.setViewportSize({width:390,height:300});
 await expect.poll(async()=>(await viewport.boundingBox())?.height||0).toBeLessThan(box.height-100);
 const resized=(await viewport.boundingBox())!;
 // The old long-press point is now below the book page, over the player.
 expect(box.y+box.height/3).toBeGreaterThan(resized.y+resized.height);
 await longPressSentence(page,viewport);
 await expectNoMapInFoot(room);
});
test("a no-map long-press stays isolated from an already prepared ebook",async({page,browserName},testInfo)=>{
 const suffix=`${browserName} ${testInfo.repeatEachIndex}`;
 const seedTitle=`Frame prepared ${suffix}`,fixture=await readerFixture({title:seedTitle});
 const seeded=await importBook(page,seedTitle,true,fixture);
 const manifest=await(await page.request.get(`/api/reader/${seeded}`)).json();
 const book=(await(await page.request.get("/api/books")).json()).find((value:any)=>value.workId===manifest.workId);
 const created=await page.request.post("/api/alignments",{data:{ebookId:seeded,recordingId:book.recordingId,pairings:manifest.sections.map((section:any)=>({section:section.index,trackId:book.tracks[0].id,start:section.index*100,duration:95}))}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${seeded}`)).json()).jobs[0]?.intervals.length||0,{timeout:15000}).toBeGreaterThan(0);
 // The server really does reuse the saved EPUB and its map for identical bytes.
 const duplicate=await page.request.post("/api/ebooks/import",{multipart:{file:{name:`${seedTitle}.epub`,mimeType:"application/epub+zip",buffer:fixture}}});
 expect(duplicate.ok()).toBe(true);
 expect(await duplicate.json()).toEqual({id:seeded,alreadySaved:true});
 const {id,room}=await openReader(page,`Frame isolated ${suffix}`,false);
 expect(id).not.toBe(seeded);
 await expectNoAlignment(page,id);
 await longPressSentence(page,room.locator(".reader-viewport"));
 await expectNoMapInFoot(room);
});
// The server's app-level Content-Security-Policy (#76): a srcdoc frame inherits the embedding document's policy and a
// blob: document the creator's, so an inline script in either is refused even where the frame has no CSP meta of its own. The scripts set a flag on the app's window, so with CSP_MODE=off this test fails.
test("the app shell is served under the enforced policy",async({page})=>{
 const shell=await page.request.get("/");
 expect(shell.headers()["content-security-policy"]).toContain("script-src 'self';");
 expect(shell.headers()["content-security-policy-report-only"]).toBeUndefined();
});
test("an inline script in a srcdoc frame or a blob: document the page creates is blocked by the app policy",async({page,browserName})=>{
 await openReader(page,"App policy");
 const reports:string[]=[];
 page.on("request",request=>{if(request.url().endsWith("/api/csp-report"))reports.push(request.postData()||"");});
 const ran=await page.evaluate(async()=>{
  const w=window as any;
  const load=(frame:HTMLIFrameElement)=>new Promise<void>(resolve=>{frame.addEventListener("load",()=>resolve(),{once:true});document.body.append(frame);});
  const srcdoc=document.createElement("iframe");
  srcdoc.setAttribute("sandbox","allow-same-origin allow-scripts");
  srcdoc.srcdoc="<!doctype html><html><body><script>parent.__srcdocScript=true<\/script></body></html>";
  await load(srcdoc);
  const blob=document.createElement("iframe");
  blob.setAttribute("sandbox","allow-same-origin allow-scripts");
  blob.src=URL.createObjectURL(new Blob(["<!doctype html><html><body><script>parent.__blobScript=true<\/script></body></html>"],{type:"text/html"}));
  await load(blob);
  await new Promise(resolve=>setTimeout(resolve,500));
  return {srcdoc:!!w.__srcdocScript,blob:!!w.__blobScript,blobLoaded:blob.contentDocument?.body?.tagName==="BODY"};
 });
 // No inline script ran in either frame in any engine. WebKit does not expose a blob: frame's document to the page
 // (blobLoaded is false there) and its violation reports differ, so the loaded check and the reports are asserted in
 // Chromium and Firefox only; in WebKit the two flags staying false is the evidence.
 expect({srcdoc:ran.srcdoc,blob:ran.blob}).toEqual({srcdoc:false,blob:false});
 if(browserName!=="webkit"){
  expect(ran.blobLoaded).toBe(true);
  // The browser also reported both refusals to the server's endpoint.
  await expect.poll(()=>reports.filter(body=>/script-src/.test(body)).length).toBeGreaterThanOrEqual(2);
 }
});
