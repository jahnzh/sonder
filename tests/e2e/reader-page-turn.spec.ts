import {test,expect,type Page,type Locator} from "@playwright/test";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {longBookFixture} from "../long-book-fixture";
import {interpolateWordTimes} from "../../src/word-timing";
import {installReaderWaitBudget,READER_WAIT_MS,timedWait} from "./timing";
import {highlightShown} from "./reader-view";
// The page turns inside a sentence that crosses a page (#508, spec #503): in Page mode, when the narration's
// reported position reaches the first word on the next page. The narration's position is set on the player's
// audio element without playing it (headless Firefox plays no audio in this suite).
test.use({serviceWorkers:"block"});
installReaderWaitBudget(test);
const imported:string[]=[];
test.beforeEach(async({page})=>{
 await page.addInitScript(()=>{
  const audio:HTMLAudioElement[]=[];(window as any).__turnAudio=audio;
  const NativeAudio=window.Audio;
  window.Audio=class extends NativeAudio{constructor(src?:string){super(src);audio.push(this);}};
 });
});
test.afterEach(async({page})=>{
 await page.unrouteAll({behavior:"wait"});
 for(const id of imported.splice(0))expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});
// The full-length book fixture (#428): 30 chapters of 600 sentences, in paragraphs of six; one narration file whose
// map covers the first 150 sentences of chapter 1 (0–300 s, 2 s each). At 390 by 844 with the bundled Literata a
// page holds about a dozen of its sentences, so sentences of chapter 1 cross pages: the test finds the first one
// whose break falls inside it (not on its first or last two words) by reading the word boxes epub.js rendered.
async function longBook(page:Page,title:string){
 const response=await page.request.post("/api/import",{multipart:{title,author:"Reader QA",file0:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Long.epub",mimeType:"application/epub+zip",buffer:await longBookFixture({chapters:30,sentences:600,title})}}});
 expect(uploaded.ok()).toBe(true);
 const ebook=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings:[
  {section:manifest.sections[0].index,trackId:book.tracks[0].id,start:0,duration:300},
 ]}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:30000}).toBe(1);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 const fragments=new Map<string,any>(manifest.sections.flatMap((s:any)=>s.paragraphs.map((p:any)=>[p.id,p])));
 const intervals=map.intervals.filter((i:any)=>i.section===manifest.sections[0].index).sort((a:any,b:any)=>a.start-b.start);
 return {book,ebook,intervals,text:(interval:any)=>String(fragments.get(interval.paragraphId).text).trim()};
}
async function withReader(page:Page,reader:object,run:()=>Promise<void>){
 const appearance=await(await page.request.get("/api/appearance")).json();
 await page.request.put("/api/appearance",{data:{...appearance,reader:{...appearance.reader,...reader}}});
 try{await run();}finally{await page.request.put("/api/appearance",{data:appearance});}
}
// The player paused at `position` on `interval`, then the inline reader opened from the home page; it follows that sentence.
async function openAt(page:Page,book:any,interval:any,position:number){
 await page.goto("about:blank");
 const books=await(await page.request.get("/api/books")).json();
 const previous=books.find((b:any)=>b.recordingId===book.recordingId)?.progress?.updatedAt||0;
 const response=await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position,duration:book.tracks[0].duration,updatedAt:Math.max(Date.now(),previous+1)}});
 expect(response.ok()).toBe(true);
 await page.goto("/");
 await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
 const room=page.locator(".inline-reader");
 await timedWait("follow-highlight",()=>expect(room).toHaveAttribute("data-current-passage",interval.paragraphId,{timeout:READER_WAIT_MS.followHighlight}),{testName:test.info().title});
 await expect.poll(()=>highlightShown(room),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
 await expect(room.locator(".reader-viewport")).not.toHaveAttribute("data-jumping",/.*/);
 return room;
}
// The narration's reported position, set on the paused audio element as a seek would: the player reads it on timeupdate.
async function narrateAt(page:Page,position:number){
 await expect.poll(()=>page.evaluate((position)=>{
  const audio=((window as any).__turnAudio as HTMLAudioElement[]).find(a=>!!a.src);
  if(!audio||audio.readyState<1||!Number.isFinite(audio.duration))return null;
  audio.currentTime=position;
  audio.dispatchEvent(new Event("timeupdate"));
  return audio.currentTime;
 },position),{timeout:READER_WAIT_MS.followHighlight}).toBeCloseTo(position,3);
}
// Word `word` of the sentence `sentence` in the section's frame: its page (the left edge of its first box divided by the
// page width, as epub.js pages), whether it is drawn inside the reader's page now, and whether the follow highlight covers it.
async function wordState(room:Locator,sentence:string,word:number){
 return room.locator(".reader-viewport").evaluate((host,{sentence,word})=>{
  const bounds=host.getBoundingClientRect();
  for(const frame of host.querySelectorAll("iframe")){
   const doc=frame.contentDocument,box=frame.getBoundingClientRect();
   if(!doc?.body)continue;
   const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT);
   for(let node=walker.nextNode();node;node=walker.nextNode()){
    const at=node.textContent!.indexOf(sentence);
    if(at<0)continue;
    const starts=[...sentence.matchAll(/\S+/g)].map(m=>m.index!);
    const range=doc.createRange();range.setStart(node,at+starts[word]!);range.setEnd(node,at+starts[word]!+1);
    const rect=[...range.getClientRects()].find(r=>r.width>0)!;
    const screen={left:box.left+rect.left,right:box.left+rect.right,top:box.top+rect.top,bottom:box.top+rect.bottom};
    const overlap=(r:{left:number;right:number;top:number;bottom:number},b:{left:number;right:number;top:number;bottom:number})=>
     Math.min(r.right,b.right)-Math.max(r.left,b.left)>0.5&&Math.min(r.bottom,b.bottom)-Math.max(r.top,b.top)>0.5;
    const marks=[...host.querySelectorAll(".sonder-follow rect")].map(r=>r.getBoundingClientRect());
    return {
     page:Math.floor((rect.left+(doc.defaultView?.scrollX??0))/host.clientWidth),
     shown:overlap(screen,bounds),
     highlighted:marks.some(mark=>overlap(screen,mark)),
    };
   }
  }
  return null;
 },{sentence,word});
}
const shown=async(room:Locator,sentence:string,word:number)=>(await wordState(room,sentence,word))?.shown??false;
// The first mapped sentence of chapter 1 (after the first few) that crosses a page, with its break inside it,
// starting on page `fromPage` of the chapter or later.
async function crossingSentence(room:Locator,intervals:any[],text:(interval:any)=>string,fromPage=0){
 for(const [at,interval] of intervals.entries()){
  if(at<3||at>=intervals.length-2)continue;
  const sentence=text(interval),count=[...sentence.matchAll(/\S+/g)].length;
  const first=await wordState(room,sentence,0),last=await wordState(room,sentence,count-1);
  if(!first||!last||first.page===last.page||first.page<fromPage)continue;
  let breakWord=-1;
  for(let word=1;word<count;word++)if((await wordState(room,sentence,word))!.page>first.page){breakWord=word;break;}
  if(last.page!==first.page+1||breakWord<2||breakWord>count-3)continue;
  const words=[...sentence.matchAll(/\S+/g)].map(m=>({text:m[0]}));
  // The break's time: the estimated start of its word, as the reader interpolates it.
  const breakTime=interpolateWordTimes(words,interval.start,interval.end)[breakWord]!.start;
  return {interval,next:intervals[at+1],sentence,breakWord,breakTime,firstPage:first.page};
 }
 throw new Error("no sentence of chapter 1 crosses a page inside it at this size");
}
const expectStays=async(page:Page,check:()=>Promise<boolean>)=>{
 // Nothing should change: sampled for a second and a half.
 for(let i=0;i<6;i++){expect(await check()).toBe(true);await page.waitForTimeout(250);}
};

test("in Page mode the page turns inside a crossing sentence when the narration reaches its first word on the next page",async({page},testInfo)=>{
 test.setTimeout(180000);
 const {book,intervals,text}=await longBook(page,`Page turn ${testInfo.repeatEachIndex} ${randomUUID()}`);
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  // Opened on the first sentence to find the crossing one; then reopened on it at its start.
  let room=await openAt(page,book,intervals[0],intervals[0].start+.05);
  const crossing=await crossingSentence(room,intervals,text);
  const {interval,next,sentence,breakWord,breakTime}=crossing;
  expect(breakTime-interval.start).toBeGreaterThan(.3);
  expect(interval.end-breakTime).toBeGreaterThan(.3);
  room=await openAt(page,book,interval,interval.start+.05);
  const back=room.getByRole("button",{name:"Back to narration",exact:true});
  // Not turned at the sentence's start: its first word is on the page, the break's word is not.
  expect(await shown(room,sentence,0)).toBe(true);
  expect(await shown(room,sentence,breakWord)).toBe(false);
  // Both parts of the sentence are highlighted, each on its page: the first part is on the page shown.
  expect((await wordState(room,sentence,0))!.highlighted).toBe(true);
  expect((await wordState(room,sentence,breakWord))!.highlighted).toBe(true);
  // Just before the break's time: no turn.
  await narrateAt(page,breakTime-.2);
  await expectStays(page,async()=>await shown(room,sentence,0)&&!await shown(room,sentence,breakWord));
  // At the break's time the page turns, inside the sentence: it does not wait for the next one.
  await narrateAt(page,breakTime+.02);
  await expect.poll(()=>shown(room,sentence,breakWord),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
  expect(await shown(room,sentence,0)).toBe(false);
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  expect(breakTime+.02).toBeLessThan(next.start);
  // The second part is highlighted on the page now shown.
  expect((await wordState(room,sentence,breakWord))!.highlighted).toBe(true);
  expect(await highlightShown(room)).toBe(true);
  // The automatic turn is not the reader's own navigation: still following, and a pause (no new position) keeps the page.
  await expect(back).toBeDisabled();
  await expectStays(page,async()=>await shown(room,sentence,breakWord)&&!await shown(room,sentence,0));
  // A jump back to before the break shows the first page; a jump past it the second.
  await narrateAt(page,interval.start+.1);
  await expect.poll(()=>shown(room,sentence,0),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
  expect(await shown(room,sentence,breakWord)).toBe(false);
  await narrateAt(page,interval.end-.1);
  await expect.poll(()=>shown(room,sentence,breakWord),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
  expect(await shown(room,sentence,0)).toBe(false);
  await expect(back).toBeDisabled();
  // Following goes on after the turn: the next sentence is followed and highlighted.
  await narrateAt(page,next.start+.05);
  await expect(room).toHaveAttribute("data-current-passage",next.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
  await expect.poll(()=>highlightShown(room),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
  await expect(back).toBeDisabled();
 });
});

test("a page turned by hand inside a crossing sentence turns nothing until Back to narration, which shows the narrated word's page",async({page},testInfo)=>{
 test.setTimeout(180000);
 const {book,intervals,text}=await longBook(page,`Page turn by hand ${testInfo.repeatEachIndex} ${randomUUID()}`);
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  let room=await openAt(page,book,intervals[0],intervals[0].start+.05);
  // Not on the chapter's first page, so that a page back by hand goes to a page of its own.
  const {interval,sentence,breakWord,breakTime}=await crossingSentence(room,intervals,text,1);
  room=await openAt(page,book,interval,interval.start+.05);
  const back=room.getByRole("button",{name:"Back to narration",exact:true});
  expect(await shown(room,sentence,0)).toBe(true);
  // A tap on the page's left edge turns back a page by hand: paged away.
  const box=(await room.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(box.x+20,box.y+box.height/2);
  await expect(back).toBeEnabled();
  await expect.poll(()=>shown(room,sentence,0)).toBe(false);
  // The narration passes the break: nothing turns.
  await narrateAt(page,breakTime+.3);
  await expectStays(page,async()=>!await shown(room,sentence,0)&&!await shown(room,sentence,breakWord));
  await expect(back).toBeEnabled();
  // Back to narration shows the page of the word being narrated: the second part, not the sentence's start.
  await back.click();
  await expect.poll(()=>shown(room,sentence,breakWord),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
  expect(await shown(room,sentence,0)).toBe(false);
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  await expect(back).toBeDisabled();
  expect((await wordState(room,sentence,breakWord))!.highlighted).toBe(true);
 });
});

test("in Scroll mode a crossing sentence moves nothing inside it, as before",async({page},testInfo)=>{
 test.setTimeout(180000);
 const {book,intervals,text}=await longBook(page,`Page turn scroll ${testInfo.repeatEachIndex} ${randomUUID()}`);
 // The crossing sentence as Page mode lays it out.
 let crossing:Awaited<ReturnType<typeof crossingSentence>>;
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  const room=await openAt(page,book,intervals[0],intervals[0].start+.05);
  crossing=await crossingSentence(room,intervals,text);
 });
 await withReader(page,{mode:"scroll",font:"serif"},async()=>{
  const {interval,sentence,breakTime}=crossing!;
  const room=await openAt(page,book,interval,interval.start+.05);
  const view=()=>room.locator(".reader-viewport").evaluate(host=>{
   const container=host.querySelector(".epub-container") as HTMLElement|null,frame=host.querySelector("iframe") as HTMLIFrameElement|null;
   return `${container?.scrollLeft}:${container?.scrollTop}:${frame?.contentWindow?.scrollX}:${frame?.contentWindow?.scrollY}`;
  });
  const before=await view();
  expect(await shown(room,sentence,0)).toBe(true);
  await narrateAt(page,breakTime+.3);
  await narrateAt(page,interval.end-.1);
  // The same sentence stays narrated and highlighted, and the view does not move inside it.
  await expectStays(page,async()=>await view()===before);
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  expect(await highlightShown(room)).toBe(true);
 });
});
