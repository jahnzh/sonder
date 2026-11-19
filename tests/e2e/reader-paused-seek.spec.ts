// A paused seek moves the reader's highlight (#730, a regression from #593's seek fix). The player holds a load's
// seek target as the place until that seek is seen to land (src/seek-landing.ts). A seek made while the hold was
// still waiting (on the live check's TorBox stream the load's own seek was still being read) kept the reader on the
// held, older passage, or sought back to it. Every paused seek, backwards and forwards, to a mapped sentence in
// another passage must move the highlight there: on a stream whose load seek is still being read, on a stream
// whose load seek has landed, and on a device copy (#593's Firefox case).
import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {readerFixture} from "../reader-fixture";
import {installReaderWaitBudget,READER_WAIT_MS} from "./timing";
import {openRead,openListen,listenFace,showReadControls} from "./now-playing";

test.use({viewport:{width:390,height:844}});
installReaderWaitBudget(test);
const imported:string[]=[];
test.afterEach(async({page})=>{
 await page.unrouteAll({behavior:"ignoreErrors"});
 for(const id of imported.splice(0))await page.request.delete(`/api/library/${id}`);
});

const first=`<p>The first paragraph opens here. It carries a second sentence. A third sentence closes it.</p>`+
 `<p>The second paragraph begins now. Its middle sentence follows quickly. The last sentence ends the block.</p>`;
const second=`<p>Another chapter starts with this line. It goes on for a while. Then it stops.</p>`+
 `<p>A later paragraph comes next. It has its own sentences too. This one closes the chapter.</p>`;

type Interval={paragraphId:string;start:number;end:number;section:number};
/** An audiobook of one file with an EPUB of two chapters, narrated from 0 s and from 100 s. */
async function fixture(page:Page,name:string){
 const title=`${name} ${randomUUID().slice(0,8)}`;
 const response=await page.request.post("/api/import",{multipart:{title,author:"Seek QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Seek.epub",mimeType:"application/epub+zip",buffer:await readerFixture({bodies:[first,second],title})}}});
 expect(uploaded.ok()).toBe(true);const ebook=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings:manifest.sections.map((section:any)=>({section:section.index,trackId:book.tracks[0].id,start:section.index*100,duration:95}))}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:15000}).toBe(manifest.sections.length);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 const intervals=(map.intervals as Interval[]).slice().sort((a,b)=>a.start-b.start);
 /** The middle of the first sentence of a passage other than `other`'s, in `section`, first or last of them. */
 const pick=(section:number,last:boolean,other?:Interval)=>{
  const candidates=intervals.filter(i=>i.section===section&&i.paragraphId!==other?.paragraphId&&i.end-i.start>1);
  const passage=(last?candidates[candidates.length-1]:candidates[0]).paragraphId;
  return candidates.find(i=>i.paragraphId===passage)!;
 };
 const saved=pick(1,true);
 return {book,title,intervals,saved,backwards:pick(0,false,saved),forwards:pick(1,false,saved)};
}
const middle=(interval:Interval)=>(interval.start+interval.end)/2;

async function instrument(page:Page){
 await page.addInitScript(()=>{
  const elements:HTMLAudioElement[]=[];(window as any).__audio=elements;
  const NativeAudio=window.Audio;
  window.Audio=class extends NativeAudio{constructor(src?:string){super(src);elements.push(this);}};
 });
}
const audio=(page:Page)=>page.evaluate(()=>{const a=((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src)!;return {position:a.currentTime,paused:a.paused,src:a.src};});
/** Seeks the element itself, as the live check does (scripts/verify-integrated-reader.mjs), and as a seek from outside the player would. */
const seekElement=(page:Page,position:number)=>page.evaluate(position=>{((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src)!.currentTime=position;},position);
const room=(page:Page)=>page.locator(".inline-reader");
async function savePlace(page:Page,book:any,position:number){
 const books=await(await page.request.get("/api/books")).json();
 const previous=books.find((b:any)=>b.recordingId===book.recordingId)?.progress?.updatedAt||0;
 const response=await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position,duration:book.tracks[0].duration,updatedAt:Math.max(Date.now(),previous+1)}});
 expect(response.ok()).toBe(true);
}
/** Seeks the paused element to a sentence and waits for the reader to highlight its passage, keeping the pause. */
async function seekTo(page:Page,interval:Interval){
 const position=middle(interval);
 await seekElement(page,position);
 await expect(room(page)).toHaveAttribute("data-current-passage",interval.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
 await expect(page.locator(".inline-reader .reader-viewport .sonder-follow").first()).toBeVisible();
 await expect.poll(async()=>(await audio(page)).position).toBeCloseTo(position,0);
 // The highlight stays: no later look at the load's seek takes the place back.
 await page.waitForTimeout(1000);
 await expect(room(page)).toHaveAttribute("data-current-passage",interval.paragraphId);
 expect((await audio(page)).position).toBeCloseTo(position,0);
 expect((await audio(page)).paused).toBe(true);
}

/**
 * A slow upstream, as the live check's TorBox stream: the opening request returns only the file's first 256 KiB (some
 * 30 s), and a read further in comes 6 s later, so the load's seek to the saved place is still being read when the
 * seeks begin. Resolves to a count of the delayed reads.
 */
async function slowUpstream(page:Page){
 let delayed=0;
 await page.route(/\/api\/media\//,async route=>{
  const range=/bytes=(\d+)-/.exec(route.request().headers().range??"");
  if(!range||Number(range[1])===0){
   const response=await route.fetch();
   const body=await response.body(),part=256*1024;
   await route.fulfill({status:206,headers:{...response.headers(),"content-range":`bytes 0-${part-1}/${body.length}`,"content-length":String(part)},body:body.subarray(0,part)});
   return;
  }
  delayed++;
  await new Promise(resolve=>setTimeout(resolve,6000));
  await route.continue().catch(()=>{});
 });
 return ()=>delayed;
}

test.describe("on a stream",()=>{
 // The routes below must see the media requests; the service worker would answer them first.
 test.use({serviceWorkers:"block"});

 test("paused seeks move the highlight while the load's own seek is still being read",async({page})=>{
  test.setTimeout(120_000);
  await instrument(page);
  const {book,saved,backwards,forwards}=await fixture(page,"Paused seek slow");
  const delayed=await slowUpstream(page);
  await savePlace(page,book,middle(saved));
  await page.goto("/");
  await openRead(page);
  // The held place is the saved one; the read at it is still on its way.
  await expect(room(page)).toHaveAttribute("data-current-passage",saved.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
  expect(delayed()).toBeGreaterThan(0);
  expect((await audio(page)).paused).toBe(true);
  await seekTo(page,backwards);
  await seekTo(page,forwards);
  await seekTo(page,backwards);
  await seekTo(page,saved);
 });

 // The player's own seeks aimed the held landing already; the foot's skip, from the held place, must still move it.
 test("a paused skip from the Read face's foot moves the highlight while the load's own seek is still being read",async({page})=>{
  test.setTimeout(120_000);
  await instrument(page);
  const {book,intervals,saved}=await fixture(page,"Paused skip slow");
  await slowUpstream(page);
  await savePlace(page,book,middle(saved));
  await page.goto("/");
  await openRead(page);
  await expect(room(page)).toHaveAttribute("data-current-passage",saved.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
  const target=middle(saved)-30;
  const landed=intervals.filter(i=>i.start<=target).pop()!;
  expect(landed.paragraphId).not.toBe(saved.paragraphId);
  await expect(page.locator(".inline-reader .reader-viewport .sonder-follow").first()).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
  await showReadControls(page);
  await page.locator(".reader-player").getByRole("button",{name:"Back 30 seconds",exact:true}).click();
  await expect(room(page)).toHaveAttribute("data-current-passage",landed.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
  await expect.poll(async()=>(await audio(page)).position).toBeCloseTo(target,0);
  await page.waitForTimeout(1000);
  await expect(room(page)).toHaveAttribute("data-current-passage",landed.paragraphId);
  expect((await audio(page)).paused).toBe(true);
 });

 test("paused seeks move the highlight once the load's seek has landed",async({page})=>{
  await instrument(page);
  const {book,saved,backwards,forwards}=await fixture(page,"Paused seek landed");
  await savePlace(page,book,middle(saved));
  await page.goto("/");
  await openRead(page);
  await expect(room(page)).toHaveAttribute("data-current-passage",saved.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
  await expect.poll(async()=>(await audio(page)).position).toBeCloseTo(middle(saved),0);
  await seekTo(page,backwards);
  await seekTo(page,forwards);
  await seekTo(page,saved);
 });
});

// #593's case: a device copy plays from a Blob of 4 MiB chunks, which Firefox reads only forward, so the load's
// seek to the saved place lands short and is held. Its fix must stay (now-playing-faces.spec.ts checks the switch).
test("paused seeks move the highlight on a device copy",async({page})=>{
 test.setTimeout(120_000);
 await instrument(page);
 const {book,saved,backwards,forwards}=await fixture(page,"Paused seek device");
 await page.goto("/");
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
 await page.reload();
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 await savePlace(page,book,middle(saved));
 await page.goto("about:blank");
 await page.goto("/");
 await openListen(page);
 const keep=listenFace(page).getByRole("switch",{name:"Keep on this device",exact:true});
 await keep.click();
 await expect(keep).toHaveAttribute("aria-checked","true");
 await expect(page.locator("#listen-keep-line")).toHaveText(/^Audiobook and ebook · /,{timeout:30_000});
 // A fresh load from the device copy: the saved place is sought from loadedmetadata, where Firefox lands it short.
 await page.goto("about:blank");
 await page.goto("/");
 await openRead(page);
 await expect.poll(async()=>(await audio(page)).src).toMatch(/^blob:/);
 await expect(room(page)).toHaveAttribute("data-current-passage",saved.paragraphId,{timeout:READER_WAIT_MS.followHighlight});
 await seekTo(page,backwards);
 await seekTo(page,forwards);
 await seekTo(page,backwards);
 await seekTo(page,saved);
});
