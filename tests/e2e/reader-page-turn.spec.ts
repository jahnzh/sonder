import {test,expect,type Page,type Locator} from "@playwright/test";
import {mkdirSync,readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {longBookFixture} from "../long-book-fixture";
import {interpolateWordTimes} from "../../src/word-timing";
import {installReaderWaitBudget,READER_WAIT_MS,timedWait} from "./timing";
import {highlightShown} from "./reader-view";
import {longSentence,pageTurnFixture,PACED_CHARACTERS_PER_SECOND} from "../page-turn-fixture";
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
 return room.locator(".reader-viewport").evaluate(async(host,{sentence,word})=>{
  // The section's fonts first: a layout measured with a fallback font breaks elsewhere (WebKit loads them late).
  for(const frame of host.querySelectorAll("iframe"))await frame.contentDocument?.fonts?.ready;
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

// #509: the turn inside a sentence beyond one plain break. The page-turn fixture (tests/page-turn-fixture.ts) holds a
// sentence over three pages, sentences that are mostly one long hyphenated word and sentences with a picture between
// their halves; its chapters are narrated at reading pace, so each word has a time of its own.
async function turnBook(page:Page,title:string){
 const response=await page.request.post("/api/import",{multipart:{title,author:"Reader QA",file0:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Turns.epub",mimeType:"application/epub+zip",buffer:await pageTurnFixture({title})}}});
 expect(uploaded.ok()).toBe(true);
 const ebook=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 // One pairing per chapter, one after the other on the narration file, each as long as the fixture narrates it.
 let start=0;
 const pairings=manifest.sections.map((section:any)=>{
  const duration=section.paragraphs.reduce((sum:number,p:any)=>sum+Math.max(1,p.text.length/PACED_CHARACTERS_PER_SECOND),0)+2;
  const pairing={section:section.index,trackId:book.tracks[0].id,start,duration};
  start+=duration;
  return pairing;
 });
 expect(start).toBeLessThan(book.tracks[0].duration);
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:30000}).toBe(manifest.sections.length);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 const fragments=new Map<string,any>(manifest.sections.flatMap((s:any)=>s.paragraphs.map((p:any)=>[p.id,p])));
 const chapter=(index:number)=>map.intervals.filter((i:any)=>i.section===manifest.sections[index].index).sort((a:any,b:any)=>a.start-b.start);
 return {book,ebook,chapter,text:(interval:any)=>String(fragments.get(interval.paragraphId).text).trim()};
}
type Box={left:number;right:number;top:number;bottom:number};
type LaidWord={text:string;page:number;x:number;shown:boolean;highlighted:boolean;split:{at:number;page:number;shown:boolean}|null};
// Every word of `sentence` as drawn now: its page (the left edge of its first character's box over the page step, the
// reader's own measure), whether it is on the page shown and highlighted, and for a word hyphenated across a page the
// first of its characters on the later page. Also the page of each picture in the sentence's paragraph, with the
// number of the sentence's words before it. Read character by character, not with the reader's search.
async function layoutOf(room:Locator,sentence:string){
 return room.locator(".reader-viewport").evaluate(async(host,sentence)=>{
  // The section's fonts first: a layout measured with a fallback font breaks elsewhere (WebKit loads them late).
  for(const frame of host.querySelectorAll("iframe"))await frame.contentDocument?.fonts?.ready;
  const bounds=host.getBoundingClientRect(),step=host.clientWidth;
  const overlap=(r:Box,b:Box)=>Math.min(r.right,b.right)-Math.max(r.left,b.left)>0.5&&Math.min(r.bottom,b.bottom)-Math.max(r.top,b.top)>0.5;
  const marks=[...host.querySelectorAll(".sonder-follow rect")].map(r=>r.getBoundingClientRect());
  for(const frame of host.querySelectorAll("iframe")){
   const doc=frame.contentDocument,box=frame.getBoundingClientRect();
   if(!doc?.body)continue;
   const scroll=doc.defaultView?.scrollX??0;
   for(const block of doc.body.querySelectorAll("p")){
    // The block's characters with whitespace collapsed as the server reads the text.
    const chars:{node:Node;offset:number;ch:string}[]=[];
    const walker=doc.createTreeWalker(block,NodeFilter.SHOW_TEXT);
    let space=true;
    for(let node=walker.nextNode();node;node=walker.nextNode())
     for(let offset=0;offset<node.textContent!.length;offset++){
      const ch=node.textContent![offset]!;
      if(/\s/.test(ch)){if(!space)chars.push({node,offset,ch:" "});space=true;}
      else{chars.push({node,offset,ch});space=false;}
     }
    const at=chars.map(c=>c.ch).join("").indexOf(sentence);
    if(at<0)continue;
    const rectOf=(c:{node:Node;offset:number})=>{const r=doc.createRange();r.setStart(c.node,c.offset);r.setEnd(c.node,c.offset+1);return [...r.getClientRects()].find(x=>x.width>0||x.height>0)!;};
    const pageOf=(r:Box)=>Math.floor((r.left+scroll)/step);
    const onScreen=(r:Box)=>({left:box.left+r.left,right:box.left+r.right,top:box.top+r.top,bottom:box.top+r.bottom});
    const tokens=[...sentence.matchAll(/\S+/g)];
    const words=tokens.map(m=>{
     const rects=[...m[0]].map((_,k)=>rectOf(chars[at+m.index!+k]!));
     const page=pageOf(rects[0]!),later=rects.findIndex(r=>pageOf(r)>page);
     return {
      text:m[0],page,x:rects[0]!.left+scroll,
      shown:overlap(onScreen(rects[0]!),bounds),
      highlighted:marks.some(mark=>overlap(onScreen(rects[0]!),mark)),
      split:later<0?null:{at:later,page:pageOf(rects[later]!),shown:overlap(onScreen(rects[later]!),bounds)},
     };
    });
    const pictures=[...block.querySelectorAll("img")].map(img=>({
     page:pageOf(img.getBoundingClientRect()),
     before:tokens.filter(m=>!!(chars[at+m.index!]!.node.compareDocumentPosition(img)&Node.DOCUMENT_POSITION_FOLLOWING)).length,
     shown:overlap(onScreen(img.getBoundingClientRect()),bounds),
    }));
    return {words,pictures,step};
   }
  }
  return null;
 },sentence) as Promise<{words:LaidWord[];pictures:{page:number;before:number;shown:boolean}[];step:number}|null>;
}
// The places where the page of the narrated text changes inside the sentence, with their estimated times: a word that
// starts on a later page than the word before it, or the first character of a word hyphenated across a page on the
// later one, at that share of the word's time.
function breaksOf(words:LaidWord[],interval:{start:number;end:number}){
 const timed=interpolateWordTimes(words,interval.start,interval.end);
 const breaks:{word:number;character:number;page:number;time:number}[]=[];
 let page=words[0]!.page;
 for(const [index,word] of words.entries()){
  if(word.page>page)breaks.push({word:index,character:0,page:word.page,time:timed[index]!.start});
  page=word.page;
  if(word.split){
   const t=timed[index]!;
   breaks.push({word:index,character:word.split.at,page:word.split.page,time:t.start+(t.end-t.start)*word.split.at/word.text.length});
   page=word.split.page;
  }
 }
 return breaks;
}
// Whether the text that starts at a break (or at the sentence's start) is on the page shown.
async function placeShown(room:Locator,sentence:string,place:{word:number;character:number}){
 const word=(await layoutOf(room,sentence))?.words[place.word];
 return !!word&&(place.character?word.split?.shown??false:word.shown);
}
// Waits until a new layout holds still: the sentence's breaks the same for a second, and its start on the page shown.
async function settledLayout(room:Locator,sentence:string,interval:any){
 let last="";
 await expect.poll(async()=>{
  const layout=await layoutOf(room,sentence);
  const key=layout?`${JSON.stringify(breaksOf(layout.words,interval).map(item=>[item.word,item.character]))}:${layout.words[0]!.shown}`:"";
  const still=!!layout&&key===last&&layout.words[0]!.shown;
  last=key;
  return still;
 },{timeout:READER_WAIT_MS.followHighlight,intervals:[1000]}).toBe(true);
}
const sentenceStart={word:0,character:0};
// The page shown is the one that holds `place`, and no other part of the sentence: checked for each break.
async function expectShowing(room:Locator,sentence:string,parts:{word:number;character:number}[],at:number){
 await expect.poll(()=>placeShown(room,sentence,parts[at]!),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
 for(const [index,part] of parts.entries())if(index!==at)expect(await placeShown(room,sentence,part),`part ${index} while ${at} is shown`).toBe(false);
}
// Screenshots of the turns for the pull request, when SONDER_SHOTS_DIR names a folder (#509).
const SHOTS=process.env.SONDER_SHOTS_DIR;
async function shot(page:Page,name:string){
 if(!SHOTS)return;
 mkdirSync(SHOTS,{recursive:true});
 await page.screenshot({path:`${SHOTS}/${name}-${test.info().project.name}.png`});
}
// Opens the reader on `interval`, paused just after its start: the page that holds its first word.
async function followAt(page:Page,book:any,interval:any,sentence:string){
 const room=await openAt(page,book,interval,interval.start+.01);
 expect(await placeShown(room,sentence,sentenceStart)).toBe(true);
 return room;
}
const back=(room:Locator)=>room.getByRole("button",{name:"Back to narration",exact:true});
// Turns at each break of the sentence as laid out now, from its start: just before each break's time the page
// stays, just after it the page that holds the break is shown, and no turn waits for the next sentence.
async function expectTurnsAtEachBreak(page:Page,room:Locator,interval:any,next:any,sentence:string,most=Infinity,shots=""){
 const layout=(await layoutOf(room,sentence))!;
 const breaks=breaksOf(layout.words,interval),parts=[sentenceStart,...breaks];
 for(const [index,item] of breaks.slice(0,most).entries()){
  const previous=index?breaks[index-1]!.time:interval.start;
  expect(item.time-previous,`time before break ${index}`).toBeGreaterThan(.1);
  await narrateAt(page,item.time-.05);
  await expectStays(page,async()=>await placeShown(room,sentence,parts[index]!)&&!await placeShown(room,sentence,item));
  if(shots)await shot(page,`${shots}-turn${index+1}-before`);
  await narrateAt(page,item.time+.02);
  await expectShowing(room,sentence,parts,index+1);
  if(shots)await shot(page,`${shots}-turn${index+1}-after`);
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  expect(item.time+.02).toBeLessThan(next.start);
  // Each part of the sentence is highlighted on its page.
  const word=(await layoutOf(room,sentence))!.words[item.word]!;
  expect(item.character?true:word.highlighted).toBe(true);
  expect(await highlightShown(room)).toBe(true);
  await expect(back(room)).toBeDisabled();
 }
 return breaks;
}

test("a sentence over three pages turns at each page's end, and a jump back over both breaks shows its first page",async({page},testInfo)=>{
 test.setTimeout(180000);
 const {book,chapter,text}=await turnBook(page,`Three pages ${testInfo.repeatEachIndex} ${randomUUID()}`);
 const intervals=chapter(0),at=intervals.findIndex((i:any)=>text(i)===longSentence(45));
 expect(at).toBeGreaterThan(0);
 const interval=intervals[at],next=intervals[at+1],sentence=text(interval);
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  const room=await followAt(page,book,interval,sentence);
  const breaks=await expectTurnsAtEachBreak(page,room,interval,next,sentence,Infinity,"three-pages");
  // Over three pages or more: it turned at least twice, each time to the next page.
  expect(breaks.length).toBeGreaterThanOrEqual(2);
  breaks.forEach((item,index)=>expect(item.page).toBe((index?breaks[index-1]!.page:(breaks[0]!.page-1))+1));
  // A jump back to the sentence's start, over every break, shows its first page; a jump to its end the last.
  const parts=[sentenceStart,...breaks];
  await narrateAt(page,interval.start+.05);
  await expectShowing(room,sentence,parts,0);
  await narrateAt(page,interval.end-.05);
  await expectShowing(room,sentence,parts,parts.length-1);
  await expect(back(room)).toBeDisabled();
 });
});

test("a sentence with a picture in it turns at the word the picture pushed to the next page",async({page},testInfo)=>{
 test.setTimeout(180000);
 const {book,chapter,text}=await turnBook(page,`Picture turn ${testInfo.repeatEachIndex} ${randomUUID()}`);
 const intervals=chapter(2);
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  let room=await openAt(page,book,intervals[0],intervals[0].start+.01);
  // The first sentence whose picture did not fit on its page: the picture and the words after it are on the next.
  let found:{interval:any;next:any;sentence:string;pushed:number}|null=null;
  for(const [index,interval] of intervals.entries()){
   const sentence=text(interval);
   if(!sentence.startsWith("Picture")||index>=intervals.length-1)continue;
   const layout=await layoutOf(room,sentence);
   if(!layout||layout.pictures.length!==1)continue;
   const picture=layout.pictures[0]!,words=layout.words;
   if(words[0]!.page!==words[picture.before-1]!.page||picture.page!==words[0]!.page+1||words[picture.before]!.page!==picture.page)continue;
   found={interval,next:intervals[index+1],sentence,pushed:picture.before};
   break;
  }
  expect(found,"a sentence whose picture is pushed to the next page").not.toBeNull();
  const {interval,next,sentence,pushed}=found!;
  room=await followAt(page,book,interval,sentence);
  const breaks=await expectTurnsAtEachBreak(page,room,interval,next,sentence,Infinity,"picture");
  // One turn, at the first word after the picture: the picture is shown with it, on the later page.
  expect(breaks.map(item=>item.word)).toEqual([pushed]);
  expect((await layoutOf(room,sentence))!.pictures[0]!.shown).toBe(true);
 });
});

test("a word hyphenated across the page turns inside the word's time, at its first character on the later page",async({page},testInfo)=>{
 test.setTimeout(180000);
 const {book,chapter,text}=await turnBook(page,`Hyphen turn ${testInfo.repeatEachIndex} ${randomUUID()}`);
 const intervals=chapter(1);
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  let room=await openAt(page,book,intervals[0],intervals[0].start+.01);
  // The first sentence that starts on one page and whose long hyphenated word goes on on the next.
  let found:{interval:any;next:any;sentence:string;word:number}|null=null;
  for(const [index,interval] of intervals.entries()){
   const sentence=text(interval);
   if(!sentence.includes("-like")||index>=intervals.length-1)continue;
   const words=(await layoutOf(room,sentence))?.words;
   const word=words?.findIndex(w=>w.text.includes("-like"))??-1;
   if(!words||word<0||!words[word]!.split||words[word]!.page!==words[0]!.page||words.slice(word+1).some(w=>w.page!==words[word]!.split!.page))continue;
   found={interval,next:intervals[index+1],sentence,word};
   break;
  }
  expect(found,"a sentence whose hyphenated word crosses a page").not.toBeNull();
  const {interval,next,sentence,word}=found!;
  room=await followAt(page,book,interval,sentence);
  const layout=(await layoutOf(room,sentence))!;
  const timed=interpolateWordTimes(layout.words,interval.start,interval.end)[word]!;
  // The word starts on the page shown: at its start nothing turns.
  await narrateAt(page,timed.start+.02);
  await expectStays(page,async()=>await placeShown(room,sentence,sentenceStart));
  const breaks=await expectTurnsAtEachBreak(page,room,interval,next,sentence,Infinity,"hyphenated");
  // One turn, inside the word's time: after its start and before the next word's, at its share of the word.
  expect(breaks).toHaveLength(1);
  expect(breaks[0]!.word).toBe(word);
  expect(breaks[0]!.character).toBeGreaterThan(0);
  expect(breaks[0]!.time).toBeGreaterThan(timed.start+.1);
  expect(breaks[0]!.time).toBeLessThan(timed.end-.1);
 });
});

test("after a change of text size and after a resize the turn comes at the new break",async({page},testInfo)=>{
 test.setTimeout(240000);
 const {book,chapter,text}=await turnBook(page,`New layout ${testInfo.repeatEachIndex} ${randomUUID()}`);
 const intervals=chapter(0),at=intervals.findIndex((i:any)=>text(i)===longSentence(45));
 const interval=intervals[at],next=intervals[at+1],sentence=text(interval);
 await withReader(page,{mode:"paginated",font:"serif",size:18},async()=>{
  const room=await followAt(page,book,interval,sentence);
  // The first break's word, null while the section is being laid out anew (epub.js replaces its frame on a resize).
  const firstBreak=async()=>{const layout=await layoutOf(room,sentence);return layout?breaksOf(layout.words,interval)[0]?.word??null:null;};
  const movedFrom=async(previous:number|null|undefined)=>{const now=await firstBreak();return now!==null&&now!==previous;};
  const before=await firstBreak();
  // A larger text size, set in the reader's options while it follows the sentence's start.
  const topbar=room.locator(".reader-topbar");
  if(!await topbar.isVisible()){
   const box=(await room.locator(".reader-viewport").boundingBox())!;
   await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  }
  await topbar.getByRole("button",{name:"Reader appearance",exact:true}).click();
  await page.getByRole("slider",{name:"Reader text size",exact:true}).fill("26");
  await room.locator(".reader-panel-heading").getByRole("button",{name:"Close reader options",exact:true}).click();
  await expect.poll(()=>movedFrom(before),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
  // Still following, on the page of the word being narrated: the sentence's start.
  await settledLayout(room,sentence,interval);
  await expect(back(room)).toBeDisabled();
  const larger=await expectTurnsAtEachBreak(page,room,interval,next,sentence,2,"text-size-26");
  expect(larger[0]!.word).not.toBe(before);
  // A resize (a narrower and shorter window, as a rotation or a split screen gives) moves the breaks again.
  await narrateAt(page,interval.start+.05);
  await expectShowing(room,sentence,[sentenceStart,...larger],0);
  await page.setViewportSize({width:340,height:700});
  await expect.poll(()=>movedFrom(larger[0]!.word),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
  await settledLayout(room,sentence,interval);
  await expect(back(room)).toBeDisabled();
  const resized=await expectTurnsAtEachBreak(page,room,interval,next,sentence,2,"resized-340x700");
  expect(resized[0]!.word).not.toBe(larger[0]!.word);
 });
});

test("at desktop width with two pages side by side the turn comes when the narration leaves the second page",async({page},testInfo)=>{
 test.setTimeout(240000);
 test.skip(!!testInfo.project.use.isMobile,"a desktop window");
 await page.setViewportSize({width:1440,height:900});
 // The chapter with pictures: its tall pictures spread it over many pairs of pages.
 const {book,chapter,text}=await turnBook(page,`Two pages ${testInfo.repeatEachIndex} ${randomUUID()}`);
 const intervals=chapter(2);
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  let room=await openAt(page,book,intervals[0],intervals[0].start+.01);
  // Wide enough for epub.js to lay out two pages side by side: one turn moves both (the page step is the pair).
  expect(await room.locator(".reader-viewport").evaluate(host=>host.clientWidth)).toBeGreaterThanOrEqual(800);
  // A sentence that runs from the first page of a pair onto the second, and one that leaves the second page of a pair.
  let inside:{interval:any;sentence:string}|null=null,leaving:{interval:any;next:any;sentence:string}|null=null;
  for(const [at,interval] of intervals.entries()){
   if(at<1||at>=intervals.length-1||(inside&&leaving))continue;
   const sentence=text(interval),layout=(await layoutOf(room,sentence))!,words=layout.words,half=layout.step/2;
   const column=(word:LaidWord)=>Math.floor(word.x/half);
   const breaks=breaksOf(words,interval);
   if(!inside&&!breaks.length&&column(words[0]!)%2===0&&column(words.at(-1)!)===column(words[0]!)+1)inside={interval,sentence};
   if(!leaving&&breaks.length===1&&breaks[0]!.character===0&&column(words[breaks[0]!.word-1]!)%2===1)leaving={interval,next:intervals[at+1],sentence};
  }
  expect(inside,"a sentence across the two pages of a pair").not.toBeNull();
  expect(leaving,"a sentence that leaves the second page of a pair").not.toBeNull();
  // Across the two pages of a pair both parts are on the screen at once, and nothing turns while the narration reads its second part.
  room=await followAt(page,book,inside!.interval,inside!.sentence);
  const all=async()=>(await layoutOf(room,inside!.sentence))!.words.every(word=>word.shown);
  expect(await all()).toBe(true);
  await narrateAt(page,inside!.interval.end-.05);
  await expectStays(page,all);
  // Leaving the second page of a pair: the turn comes when the narration reaches its first word on the next pair, not before.
  room=await followAt(page,book,leaving!.interval,leaving!.sentence);
  const breaks=await expectTurnsAtEachBreak(page,room,leaving!.interval,leaving!.next,leaving!.sentence,Infinity,"two-pages");
  expect(breaks).toHaveLength(1);
 });
});

// The cost of following (#509): the time the reader takes to measure where each narrated sentence breaks, on the
// full-length book fixture and on the sentence over three pages, as it is and with the processor slowed six times
// (Chromium's CPU throttling). The reader keeps each measurement's time only when the page asks for it.
test("finding the break of a narrated sentence takes a few milliseconds, also with the processor slowed six times",async({page},testInfo)=>{
 test.setTimeout(300000);
 test.skip(testInfo.project.name!=="chromium","CPU throttling is a Chromium DevTools feature");
 await page.addInitScript(()=>{(window as any).__sonderBreakTimings=[];});
 const long=await longBook(page,`Break cost ${testInfo.repeatEachIndex} ${randomUUID()}`);
 const turns=await turnBook(page,`Break cost turns ${testInfo.repeatEachIndex} ${randomUUID()}`);
 const cdp=await page.context().newCDPSession(page);
 const summary=(values:number[])=>{
  const sorted=[...values].sort((a,b)=>a-b),at=(q:number)=>sorted[Math.min(sorted.length-1,Math.floor(q*sorted.length))]!;
  return {count:sorted.length,median:+at(.5).toFixed(2),p95:+at(.95).toFixed(2),max:+sorted.at(-1)!.toFixed(2)};
 };
 const results:Record<string,any>={};
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  for(const rate of [1,6]){
   await cdp.send("Emulation.setCPUThrottlingRate",{rate});
   // Sentence after sentence of chapter 1, as the narration reaches each.
   const room=await openAt(page,long.book,long.intervals[0],long.intervals[0].start+.05);
   await page.evaluate(()=>{(window as any).__sonderBreakTimings.length=0;});
   for(const interval of long.intervals.slice(1,61)){
    await narrateAt(page,interval.start+.05);
    await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
   }
   const book=await page.evaluate(()=>[...(window as any).__sonderBreakTimings] as number[]);
   expect(book.length).toBeGreaterThanOrEqual(60);
   // The sentence over three pages, followed from its start through each turn.
   const intervals=turns.chapter(0),at=intervals.findIndex((i:any)=>turns.text(i)===longSentence(45));
   const interval=intervals[at],sentence=turns.text(interval);
   const turnRoom=await openAt(page,turns.book,interval,interval.start+.01);
   await page.evaluate(()=>{(window as any).__sonderBreakTimings.length=0;});
   const breaks=breaksOf((await layoutOf(turnRoom,sentence))!.words,interval);
   for(const item of breaks){
    await narrateAt(page,item.time+.02);
    await expect.poll(()=>placeShown(turnRoom,sentence,item),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
   }
   await expect.poll(()=>page.evaluate(()=>(window as any).__sonderBreakTimings.length)).toBeGreaterThanOrEqual(breaks.length);
   const long3=await page.evaluate(()=>[...(window as any).__sonderBreakTimings] as number[]);
   results[`slowed ${rate}x`]={"full-length book, chapter 1 sentences":summary(book),"sentence over three pages, after each turn":summary(long3)};
  }
  await cdp.send("Emulation.setCPUThrottlingRate",{rate:1});
 });
 console.log(`break measurement (ms): ${JSON.stringify(results)}`);
 await testInfo.attach("break-timings.json",{body:JSON.stringify(results,null,1),contentType:"application/json"});
 // Nothing a reader notices: well under one frame as it is, and under a few frames on a processor slowed six times.
 expect(results["slowed 1x"]["full-length book, chapter 1 sentences"].p95).toBeLessThan(16);
 expect(results["slowed 6x"]["full-length book, chapter 1 sentences"].p95).toBeLessThan(50);
 expect(results["slowed 6x"]["sentence over three pages, after each turn"].max).toBeLessThan(100);
});

test("after each turn the break is measured again: a picture that grows on the page now shown moves the next turn",async({page},testInfo)=>{
 test.setTimeout(180000);
 const {book,chapter,text}=await turnBook(page,`Measured again ${testInfo.repeatEachIndex} ${randomUUID()}`);
 const intervals=chapter(0),at=intervals.findIndex((i:any)=>text(i)===longSentence(45));
 const interval=intervals[at],next=intervals[at+1],sentence=text(interval);
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  const room=await followAt(page,book,interval,sentence);
  // Measured as the sentence began.
  const before=breaksOf((await layoutOf(room,sentence))!.words,interval);
  expect(before.length).toBeGreaterThanOrEqual(2);
  // Then a picture grows inside the sentence's second part (one that loads late): a tall box between two of the
  // words on the second page, which pushes the end of that page onto the third. The first page does not change.
  const grown=Math.floor((before[0]!.word+before[1]!.word)/2);
  await room.locator(".reader-viewport").evaluate((host,{sentence,word})=>{
   for(const frame of host.querySelectorAll("iframe")){
    const doc=frame.contentDocument;if(!doc?.body)continue;
    const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT);
    for(let node=walker.nextNode() as Text|null;node;node=walker.nextNode() as Text|null){
     const at=node.data.indexOf(sentence);if(at<0)continue;
     const offset=at+[...sentence.matchAll(/\S+/g)][word]!.index!;
     const box=doc.createElement("span");
     box.style.cssText=`display:inline-block;width:2px;height:${Math.round(host.clientHeight*.6)}px`;
     node.splitText(offset).before(box);
     return;
    }
   }
   throw new Error("sentence not found");
  },{sentence,word:grown});
  let after:ReturnType<typeof breaksOf>=[];
  await expect.poll(async()=>{after=breaksOf((await layoutOf(room,sentence))!.words,interval);return after[1]?.word??0;}).toBeLessThan(before[1]!.word);
  expect(after[0]).toEqual(before[0]);
  // The first turn, at the break measured when the sentence began; then the second at the break as drawn after the
  // turn, earlier than the one measured at the start.
  await narrateAt(page,after[0]!.time+.02);
  await expectShowing(room,sentence,[sentenceStart,...after],1);
  expect(after[1]!.time+.02).toBeLessThan(before[1]!.time);
  await narrateAt(page,after[1]!.time+.02);
  await expectShowing(room,sentence,[sentenceStart,...after],2);
  expect(after[1]!.time).toBeLessThan(next.start);
  await expect(back(room)).toBeDisabled();
 });
});

test("a follow jump that a newer one replaces while it is in flight is no failure: the reader shows the sentence",async({page},testInfo)=>{
 test.setTimeout(180000);
 const {book,chapter,text}=await turnBook(page,`Replaced jumps ${testInfo.repeatEachIndex} ${randomUUID()}`);
 const first=chapter(0)[0],target=chapter(1)[4];
 await withReader(page,{mode:"paginated",font:"serif"},async()=>{
  const room=await openAt(page,book,first,first.start+.01);
  // The narration moves to a sentence of the next chapter, and while its section opens the fonts report loading
  // done again and again (each lays the text out anew and follows the sentence again, replacing the jump in flight).
  await page.evaluate(()=>{
   let count=0;
   const timer=setInterval(()=>{document.fonts.dispatchEvent(new Event("loadingdone"));if(++count>=10)clearInterval(timer);},40);
  });
  await narrateAt(page,target.start+.01);
  await expect(room).toHaveAttribute("data-current-passage",target.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
  await page.waitForTimeout(1500);
  await expect(room.getByText("Could not display the current passage",{exact:false})).toHaveCount(0);
  await expect.poll(()=>placeShown(room,text(target),sentenceStart),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
  await expect.poll(()=>highlightShown(room),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
  await expect(back(room)).toBeDisabled();
 });
});
