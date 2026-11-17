import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {longBookFixture,longBookSentence} from "../long-book-fixture";
import {readerFixture} from "../reader-fixture";
import {installReaderWaitBudget,READER_WAIT_MS,timedWait} from "./timing";
import {highlightShown,textShown} from "./reader-view";
import {setTextSize} from "./reader-appearance";
// What the deleted Lyrics long-book test guarded that also holds for the book's text (#501 review): a search
// result and a bookmark far away in a long book show their sentence on the page, and the text size setting
// changes the size of the book's text that is drawn.
test.use({serviceWorkers:"block"});
installReaderWaitBudget(test);
const imported:string[]=[];
test.afterEach(async({page})=>{
 await page.unrouteAll({behavior:"wait"});
 for(const id of imported.splice(0))expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});
// The long book of #428: 30 chapters of 600 sentences (18,000) and one narration file whose map covers the first 150
// sentences of chapter 1 (0–300 s) and the first 150 of chapter 30 (320–620 s) at 2 s each.
async function longBook(page:Page,title:string){
 const response=await page.request.post("/api/import",{multipart:{title,author:"Reader QA",file0:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Long.epub",mimeType:"application/epub+zip",buffer:await longBookFixture({chapters:30,sentences:600,title})}}});
 expect(uploaded.ok()).toBe(true);
 const ebook=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 const last=manifest.sections[manifest.sections.length-1].index;
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings:[
  {section:manifest.sections[0].index,trackId:book.tracks[0].id,start:0,duration:300},
  {section:last,trackId:book.tracks[0].id,start:320,duration:300},
 ]}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:30000}).toBe(2);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 return {book,ebook,manifest,map};
}
// The player paused on `interval`, then the inline reader opened from the home page; it follows that sentence.
async function openFollowing(page:Page,book:any,interval:any){
 await page.goto("about:blank");
 const books=await(await page.request.get("/api/books")).json();
 const previous=books.find((b:any)=>b.recordingId===book.recordingId)?.progress?.updatedAt||0;
 const response=await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position:interval.start+.5,duration:book.tracks[0].duration,updatedAt:Math.max(Date.now(),previous+1)}});
 expect(response.ok()).toBe(true);
 await page.goto("/");
 await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
 const room=page.locator(".inline-reader");
 await timedWait("follow-highlight",()=>expect(room).toHaveAttribute("data-current-passage",interval.paragraphId,{timeout:READER_WAIT_MS.followHighlight}),{testName:test.info().title});
 await expect.poll(()=>highlightShown(room),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
 return room;
}
async function showTopbar(page:Page,room:ReturnType<Page["locator"]>){
 const topbar=room.locator(".reader-topbar");
 if(await topbar.isVisible())return topbar;
 const box=(await room.locator(".reader-viewport").boundingBox())!;
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeVisible();
 return topbar;
}

test("a search result and a bookmark far away in a long book show their sentence on the page",async({page},testInfo)=>{
 test.setTimeout(120000);
 const run=testInfo.repeatEachIndex;
 const {book,ebook,manifest,map}=await longBook(page,`Long book jumps ${run} ${randomUUID()}`);
 // A bookmark on sentence 450 of chapter 20.
 const section=manifest.sections[19];
 const markedText=longBookSentence(19,449);
 const marked=section.paragraphs.find((paragraph:any)=>paragraph.text.trim().startsWith("Chapter 20 sentence 450 "));
 expect(marked).toBeTruthy();
 expect((await page.request.post(`/api/reader/${ebook}/bookmarks`,{data:{id:`${ebook}-${run}-long`,label:"Long bookmark",locator:{section:section.index,paragraphId:marked.id,progression:0}}})).ok()).toBe(true);
 const first=map.intervals.filter((interval:any)=>interval.section===manifest.sections[0].index).sort((a:any,b:any)=>a.start-b.start);
 const room=await openFollowing(page,book,first[20]);
 // Search → sentence 333 of chapter 25, which is not on the page yet.
 const foundText=longBookSentence(24,332);
 expect(await textShown(room,foundText)).toBe(false);
 await (await showTopbar(page,room)).getByRole("button",{name:"Search this book",exact:true}).click();
 // Search is a page of its own (#590): a result opens the reader there.
 await page.getByRole("searchbox",{name:"Search this book"}).fill("Chapter 25 sentence 333 walks");
 await page.locator(".reader-pages-result",{hasText:"Chapter 25 sentence 333 walks"}).click();
 await expect.poll(()=>textShown(room,foundText),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
 await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
 // Bookmarks → sentence 450 of chapter 20, back across five chapters.
 expect(await textShown(room,markedText)).toBe(false);
 await (await showTopbar(page,room)).getByRole("button",{name:"More",exact:true}).click();
 await page.locator(".reader-more:visible").getByRole("button",{name:"Bookmarks",exact:true}).click();
 // The Bookmarks page lists the saved sentence in full.
 await page.locator(".reader-pages-bookmark-open",{hasText:markedText.trim().slice(0,40)}).click();
 await expect.poll(()=>textShown(room,markedText),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
 expect(await textShown(room,foundText)).toBe(false);
});

// The rule in Reader.tsx: the body's font size is clamp(max(14, size − 2) px, 4.6vw, size + 1 px), where vw is the
// width of the book's frame; paragraphs inherit it.
async function drawnSize(page:Page){
 return page.locator(".reader-room:not(.inline-reader) .reader-viewport").evaluate(host=>{
  for(const frame of host.querySelectorAll("iframe")){
   const doc=frame.contentDocument,paragraph=doc?.querySelector("p");
   if(paragraph)return {px:parseFloat(getComputedStyle(paragraph).fontSize),frameWidth:doc!.defaultView!.innerWidth};
  }
  return null;
 });
}
const expectedSize=(size:number,frameWidth:number)=>Math.min(size+1,Math.max(Math.max(14,size-2),frameWidth*0.046));

test("the text size setting changes the size of the book's text that is drawn, also after a reload",async({page})=>{
 const defaults=await(await page.request.get("/api/appearance")).json();
 try{
  const audio=await page.request.post("/api/import",{multipart:{title:`Text size ${randomUUID()}`,author:"Reader QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
  expect(audio.ok()).toBe(true);
  const id=(await audio.json()).id;imported.push(id);
  const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
  const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Size.epub",mimeType:"application/epub+zip",buffer:await readerFixture({title:`Text size ${randomUUID()}`})}}});
  expect(uploaded.ok()).toBe(true);
  const ebook=(await uploaded.json()).id;
  await page.goto(`/#reader/${ebook}`);
  const room=page.locator(".reader-room:not(.inline-reader)");
  await expect(page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("p").first()).toBeVisible();
  const sizes:number[]=[];
  for(const size of [16,26]){
   // From Appearance docked under the text (#588).
   await showTopbar(page,room);
   await setTextSize(page,room,size);
   await expect.poll(async()=>{
    const drawn=await drawnSize(page);
    return drawn && Math.abs(drawn.px-expectedSize(size,drawn.frameWidth))<0.5;
   },{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
   const drawn=(await drawnSize(page))!;
   expect(drawn.px).toBeGreaterThanOrEqual(Math.max(14,size-2)-0.5);
   expect(drawn.px).toBeLessThanOrEqual(size+1+0.5);
   sizes.push(drawn.px);
  }
  expect(sizes[1]).toBeGreaterThan(sizes[0]+4);
  await expect.poll(async()=>(await(await page.request.get("/api/appearance")).json()).reader.size).toBe(26);
  // The saved size is what the reader draws when it opens again.
  await page.reload();
  await expect(page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("p").first()).toBeVisible();
  await expect.poll(async()=>{
   const drawn=await drawnSize(page);
   return drawn && Math.abs(drawn.px-expectedSize(26,drawn.frameWidth))<0.5;
  },{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
 }finally{
  await page.request.put("/api/appearance",{data:defaults});
 }
});
