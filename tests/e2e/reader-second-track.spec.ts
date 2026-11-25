// @projects firefox, webkit-iphone-now-playing
// #730 third round: the reader shows the passage of the place the player is at on the recording's second track.
// Production's case is a TorBox recording whose tracks are listed '-1' then '-0' (by file name) while the element
// plays '-0', the second: a paused seek there left the reader on another passage.
import {test,expect,type Page,type Route} from "@playwright/test";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {readerFixture} from "../reader-fixture";
import {installReaderWaitBudget,READER_WAIT_MS} from "./timing";
import {openRead} from "./now-playing";
import {textFrame} from "./reader-view";

test.use({viewport:{width:390,height:844}});
installReaderWaitBudget(test);
const imported:string[]=[];
test.afterEach(async({page})=>{
 await page.unrouteAll({behavior:"ignoreErrors"});
 for(const id of imported.splice(0))await page.request.delete(`/api/library/${id}`);
});
const chapter=(n:number)=>`<p>Chapter ${n} opens with this line. It goes on for a while. Then it stops for now.</p>`+
 `<p>A later paragraph of chapter ${n} comes next. It has its own sentences too. This one closes the block.</p>`+
 `<p>The last paragraph of chapter ${n} is here. One more sentence follows it. And the chapter ends.</p>`;
type Interval={paragraphId:string;start:number;end:number;section:number;trackId:string};
const middle=(i:Interval)=>(i.start+i.end)/2;

/** Section 0 (chapter 1) narrated on the first track, section 1 (chapters 2 and 3) on the second, from its start. */
const narrated=(book:any,manifest:any,lead=0)=>manifest.sections.map((section:any)=>({section:section.index,trackId:book.tracks[section.index===0?0:1].id,start:section.index===0?0:lead,duration:190}));
async function fixture(page:Page,name:string){
 const title=`${name} ${randomUUID().slice(0,8)}`;
 const audio=readFileSync("server/demo/alice-01.mp3");
 const response=await page.request.post("/api/import",{multipart:{title,author:"Track QA",
  file0:{name:"Part 1.mp3",mimeType:"audio/mpeg",buffer:audio},file1:{name:"Part 2.mp3",mimeType:"audio/mpeg",buffer:audio}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 expect(book.tracks.length).toBe(2);
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Tracks.epub",mimeType:"application/epub+zip",buffer:await readerFixture({bodies:[chapter(1),chapter(2)+chapter(3)],title})}}});
 expect(uploaded.ok()).toBe(true);const ebook=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 const pairings=narrated(book,manifest);
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:15000}).toBe(manifest.sections.length);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 const intervals=(map.intervals as Interval[]).filter(i=>i.end-i.start>1);
 return {book,intervals,ebook};
}
async function instrument(page:Page){
 await page.addInitScript(()=>{
  const elements:HTMLAudioElement[]=[];(window as any).__audio=elements;
  const NativeAudio=window.Audio;
  window.Audio=class extends NativeAudio{constructor(src?:string){super(src);elements.push(this);}};
 });
}
const audio=(page:Page)=>page.evaluate(()=>{const a=((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src);return a&&{position:a.currentTime,paused:a.paused,src:a.src,ready:a.readyState};});
// The page has no audio element with a source for a moment after it opens; taking one at once fails the test for nothing.
const audioThere=(page:Page)=>page.waitForFunction(()=>((window as any).__audio as HTMLAudioElement[]|undefined)?.some(a=>!!a.src));
const seekElement=async(page:Page,position:number)=>{await audioThere(page);await page.evaluate(position=>{((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src)!.currentTime=position;},position);};
const room=(page:Page)=>page.locator(".inline-reader");
async function savePlace(page:Page,book:any,track:number,position:number){
 const books=await(await page.request.get("/api/books")).json();
 const previous=books.find((b:any)=>b.recordingId===book.recordingId)?.progress?.updatedAt||0;
 const response=await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[track].id,position,duration:book.tracks[track].duration,updatedAt:Math.max(Date.now(),previous+1)}});
 expect(response.ok()).toBe(true);
}
async function seekTo(page:Page,interval:Interval){
 await seekElement(page,middle(interval));
 await expect(room(page)).toHaveAttribute("data-current-passage",interval.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
 await expect.poll(async()=>(await audio(page))!.position).toBeCloseTo(middle(interval),0);
 await page.waitForTimeout(1000);
 await expect(room(page)).toHaveAttribute("data-current-passage",interval.paragraphId);
 expect((await audio(page))!.paused).toBe(true);
}

test("paused seeks on the second track move the highlight to that track's passages, on the live check's path",async({page})=>{
 test.setTimeout(120_000);
 await instrument(page);
 const {book,intervals}=await fixture(page,"Second track");
 const second=intervals.filter(i=>i.trackId===book.tracks[1].id).sort((a,b)=>a.start-b.start);
 const passages=[...new Set(second.map(i=>i.paragraphId))];
 const firstOf=(p:string)=>second.find(i=>i.paragraphId===p)!;
 const saved=firstOf(passages[passages.length-1]!),early=firstOf(passages[0]!),mid=firstOf(passages[Math.floor(passages.length/2)]!);
 expect(passages.length).toBeGreaterThan(3);
 await savePlace(page,book,1,middle(saved));
 await page.goto("/");
 await openRead(page);
 await expect(room(page)).toHaveAttribute("data-current-passage",saved.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
 // The live check: Listen from the Book page, pause, then Read from the home page.
 await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
 await page.getByRole("region",{name:"Book",exact:true}).getByRole("button",{name:"Listen",exact:true}).click();
 await expect.poll(async()=>{const a=await audio(page);return !!a&&a.ready>=2&&!a.paused;},{timeout:30000}).toBe(true);
 expect(decodeURIComponent((await audio(page))!.src)).toContain(book.tracks[1].id);
 await page.evaluate(()=>((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src)?.pause());
 await page.goto("/");
 await openRead(page);
 await expect(textFrame(page.locator(".inline-reader"))).toBeVisible();
 await seekTo(page,early);
 await seekTo(page,mid);
 await seekTo(page,saved);
 await seekTo(page,early);
});

/** Routes the work's reads so its shared default (ADR 0004) is `shared`, as an ebook set's evaluation would make it. */
async function shareDefault(page:Page,workId:string,shared:string){
 const rewrite=(work:any)=>work.workId===workId?{...work,chosenEbookId:shared}:work;
 const answer=async(route:Route,many:boolean)=>{
  if(route.request().method()!=="GET")return route.fallback();
  const headers={...route.request().headers()};delete headers["if-none-match"];
  const response=await route.fetch({headers});const body=await response.json();
  await route.fulfill({status:response.status(),contentType:"application/json",body:JSON.stringify(many?(Array.isArray(body)?body.map(rewrite):{...body,works:body.works.map(rewrite)}):rewrite(body))});
 };
 await page.route(/\/api\/library$/,route=>answer(route,true));
 await page.route(new RegExp(`/api/works/${encodeURIComponent(workId).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}$`),route=>answer(route,false));
}
/** The passage the reader highlights at `position` of `trackId` by `intervals`: the last sentence started there. */
const passageAt=(intervals:Interval[],trackId:string,position:number)=>intervals.filter(i=>i.trackId===trackId&&i.start<=position).sort((a,b)=>a.start-b.start).pop()?.paragraphId;

// The live check's case (#730 third round): the check sets this device's edition (`reader-ebook:<work>`) to the EPUB
// of the map it samples, as the old Playback reader honoured first. Now playing's Read opens the work's chosen
// edition (#531, `chosenEbook`): a shared default wins over this device's choice. With another edition as the shared
// default, the reader follows that edition's map, whose passages are numbered from its own sections: a seek to the
// sampled edition's passage on the second track shows the other edition's passage (production: 11:3 asked, 12:4 shown).
test("Read follows the shared default's map over this device's edition, on the live check's path",async({page})=>{
 test.setTimeout(120_000);
 await instrument(page);
 const {book,intervals:own,ebook}=await fixture(page,"Chosen edition");
 const work=book.workId;
 // A second edition with a note of its own before chapter 2, whose map there starts 3 s later: at one time its
 // passages are numbered other than the first edition's.
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${work}`,{multipart:{file:{name:"Front.epub",mimeType:"application/epub+zip",buffer:await readerFixture({bodies:[chapter(1),`<p>A note of this edition only stands here.</p>`+chapter(2)+chapter(3)],title:`Front ${randomUUID()}`})}}});
 expect(uploaded.ok()).toBe(true);const front=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${front}`)).json();
 const pairings=narrated(book,manifest,3);
 expect((await page.request.post("/api/alignments",{data:{ebookId:front,recordingId:book.recordingId,pairings}})).ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${front}`)).json()).jobs[0]?.sectionsDone.length,{timeout:15000}).toBe(manifest.sections.length);
 const job=(await(await page.request.get(`/api/alignments?ebookId=${front}`)).json()).jobs[0];
 const theirs=((await(await page.request.get(`/api/alignments/${job.id}/map`)).json()).intervals as Interval[]);
 await shareDefault(page,work,front);
 // The check's own setting: this device reads the edition of the map it samples.
 await page.addInitScript(({work,ebook})=>localStorage.setItem(`reader-ebook:${work}`,ebook),{work,ebook});
 const second=own.filter(i=>i.trackId===book.tracks[1].id).sort((a,b)=>a.start-b.start);
 const saved=second[second.length-1]!;
 // A sampled passage whose time is another passage of the shared default's edition (production: 11:3 and 12:4).
 const sample=second.find(i=>i!==saved&&passageAt(theirs,book.tracks[1].id,middle(i))!==i.paragraphId)!;
 expect(sample).toBeTruthy();
 await savePlace(page,book,1,middle(saved));
 await page.goto(`/#book/${encodeURIComponent(work)}`);
 await page.getByRole("region",{name:"Book",exact:true}).getByRole("button",{name:"Listen",exact:true}).click();
 await expect.poll(async()=>{const a=await audio(page);return !!a&&a.ready>=2&&!a.paused;},{timeout:30000}).toBe(true);
 await page.evaluate(()=>((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src)?.pause());
 await page.goto("/");
 await openRead(page);
 await expect(room(page)).toHaveAttribute("data-ebook",front);
 await seekElement(page,middle(sample));
 const shown=passageAt(theirs,book.tracks[1].id,middle(sample))!;
 expect(shown).not.toBe(sample.paragraphId);
 await expect(room(page)).toHaveAttribute("data-current-passage",shown,{timeout:READER_WAIT_MS.followHighlight});
 expect((await audio(page))!.position).toBeCloseTo(middle(sample),0);
 // The check samples the map of the edition Read opens (scripts/live-check-recording.mjs `sharedEdition`): each of
 // its passages on the second track is the one highlighted.
 const shared=theirs.filter(i=>i.trackId===book.tracks[1].id&&i.end-i.start>1).sort((a,b)=>a.start-b.start);
 for(const passage of [...new Set(shared.map(i=>i.paragraphId))].reverse())await seekTo(page,shared.find(i=>i.paragraphId===passage)!);
 await page.screenshot({path:`artifacts/reader-second-track-390-${test.info().project.name}.png`});
 await page.setViewportSize({width:1280,height:800});
 await seekTo(page,shared[0]!);
 await page.screenshot({path:`artifacts/reader-second-track-1280-${test.info().project.name}.png`});
});
