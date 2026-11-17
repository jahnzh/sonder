import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {readerFixture} from "../reader-fixture";
import {installReaderWaitBudget,READER_WAIT_MS,timedWait} from "./timing";
// Back to narration and the manual positions still waiting for their save (#417, ADR 0014): with a
// narration to follow they are dropped, without one they are kept and saved. Sequences 1, 2 and 6 of the issue.
test.use({serviceWorkers:"block"});
installReaderWaitBudget(test);
// Every test makes its own book the one in the player. The specs after this file share the server and open the
// player's book, so each book leaves the library again, as media-controls.spec.ts does with its own.
const imported:string[]=[];
test.afterEach(async({page})=>{
 await page.unrouteAll({behavior:"wait"});
 for(const id of imported.splice(0))expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});
const chapterOne=`<p>The first paragraph opens here. It carries a second sentence. A third sentence closes it.</p>`+
 `<p>The second paragraph begins now. Its middle sentence follows quickly. The last sentence ends the block.</p>`;
const chapterTwo=`<p>Leading words open this block. Then more words follow here.</p>`+
 `<p>Plain emphasis starts this one. A span sits in the second sentence.</p>`+
 `<p>After the code block comes this sentence. Then one more sentence ends the chapter.</p>`;
// An audiobook and its ebook; with `map`, each chapter is narrated at 100 s per chapter for 95 s of the file.
// With two `tracks`, chapter i is narrated on file i, from its start for 95 s. `lead` moves the map's first
// sentence that far into the first file: before it there is no narrated sentence (#502).
async function fixture(page:Page,title:string,{map:align=true,tracks=1,lead=0}={}){
 const audio=readFileSync("server/demo/alice-01.mp3");
 const files=Object.fromEntries(Array.from({length:tracks},(_,i)=>[`file${i}`,{name:`Narration ${i+1}.mp3`,mimeType:"audio/mpeg",buffer:audio}]));
 const response=await page.request.post("/api/import",{multipart:{title,author:"Reader QA",...files}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 // The server names an imported EPUB by its bytes, and the zip's timestamps change only every two seconds: without a
 // title of its own, a book built inside the same two seconds as the last test's is that book, with its saved place.
 const epub=await readerFixture({title:`${title} ${randomUUID()}`,bodies:[chapterOne,chapterTwo]});
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Narrated.epub",mimeType:"application/epub+zip",buffer:epub}}});
 expect(uploaded.ok()).toBe(true);
 const saved=await uploaded.json();expect(saved.alreadySaved).toBe(false);const ebook=saved.id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 if(!align){
  // Linking queued a backfill job; cancel it so this book has no narration map.
  await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs.length,{timeout:20000}).toBeGreaterThan(0);
  const queued=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
  expect((await page.request.patch(`/api/alignments/${queued[0].id}`,{data:{action:"cancel"}})).ok()).toBe(true);
  return {book,ebook,map:null as any,manifest};
 }
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings:manifest.sections.map((section:any)=>tracks>1
  ?{section:section.index,trackId:book.tracks[section.index].id,start:section.index===0?lead:0,duration:95}
  :{section:section.index,trackId:book.tracks[0].id,start:lead+section.index*100,duration:95})}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:15000}).toBe(manifest.sections.length);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 return {book,ebook,map,manifest};
}
// The player at `position` of file `track` (the first by default), then the inline reader opened from the home page.
async function openAt(page:Page,book:any,position:number,track=0){
 await page.goto("about:blank");
 const books=await(await page.request.get("/api/books")).json();
 const previous=books.find((b:any)=>b.recordingId===book.recordingId)?.progress?.updatedAt||0;
 const response=await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[track].id,position,duration:book.tracks[track].duration,updatedAt:Math.max(Date.now(),previous+1)}});
 expect(response.ok()).toBe(true);
 expect((await response.json()).progress.position).toBe(position);
 await page.goto("/");
 await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
 // The book's pages are in the frame: before that, Contents has no view to move.
 await expect(page.frameLocator(".inline-reader .reader-viewport iframe").locator("p").first()).toBeAttached({timeout:READER_WAIT_MS.followHighlight});
}
// Opened on a narrated sentence: the reader follows it.
async function openFollowing(page:Page,book:any,interval:any,track=0){
 await openAt(page,book,interval.start+.5,track);
 await timedWait("follow-highlight",()=>expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage",interval.paragraphId,{timeout:READER_WAIT_MS.followHighlight}),{testName:test.info().title});
}
async function withAppearance(page:Page,patch:{reader?:object;playback?:object},run:()=>Promise<void>){
 const appearance=await(await page.request.get("/api/appearance")).json();
 await page.request.put("/api/appearance",{data:{...appearance,reader:{...appearance.reader,...patch.reader},playback:{...appearance.playback,...patch.playback}}});
 try{await run();}finally{await page.request.put("/api/appearance",{data:appearance});}
}
// The listening place as Read from audio saves it, so a test can tell it from a manual position saved over it.
async function seedListening(page:Page,ebook:string,book:any,manifest:any,paragraphId:string){
 const all=manifest.sections.flatMap((section:any)=>section.paragraphs);
 const section=manifest.sections.find((section:any)=>section.paragraphs.some((p:any)=>p.id===paragraphId));
 const fragment=all.find((p:any)=>p.id===paragraphId);
 const saved=await page.request.put(`/api/reader/${ebook}/progress`,{data:{
  locator:{section:section.index,paragraphId,quote:fragment.text.slice(0,300),progression:all.indexOf(fragment)/Math.max(1,all.length-1)},
  baseRevision:0,eventId:`listening-${ebook}`,deviceId:"e2e-seed",updatedAt:Date.now(),origin:"listening",recordingId:book.recordingId}});
 expect(saved.ok()).toBe(true);
}
async function checkpointOf(page:Page,ebook:string){
 return (await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint;
}
type Saved={origin:string;paragraphId?:string;section?:number};
// The server's checkpoint, as far as `expected` names it.
async function savedAs(page:Page,ebook:string,expected:Saved){
 const checkpoint=await checkpointOf(page,ebook);
 if(!checkpoint)return null;
 const shown:any={origin:checkpoint.origin};
 if(expected.paragraphId!==undefined)shown.paragraphId=checkpoint.locator.paragraphId;
 if(expected.section!==undefined)shown.section=checkpoint.locator.section;
 return shown;
}
// A save that lands: polled until the server has it, however long the pause and the sync take.
async function expectSaved(page:Page,ebook:string,expected:Saved){
 await expect.poll(()=>savedAs(page,ebook,expected),{timeout:10000}).toEqual(expected);
}
// The reader's pages count the manual saves it ran (data-manual-saves) and carry data-save-waiting while one waits.
const pagesOf=(page:Page)=>page.locator(".inline-reader .reader-viewport");
async function manualSaves(page:Page){
 return Number(await pagesOf(page).getAttribute("data-manual-saves")??0);
}
// A save that must not happen: every delayed save had its chance (none waits any more), none ran since
// `before` was counted, and the server still has `expected`.
async function expectKept(page:Page,ebook:string,before:number,expected:Saved){
 await expect(pagesOf(page)).not.toHaveAttribute("data-save-waiting",/.*/,{timeout:10000});
 expect(await manualSaves(page)).toBe(before);
 await expectSaved(page,ebook,expected);
}
// A bookmark on every sentence of a chapter, so the bookmark toggle is pressed once the reader's position is in it.
async function bookmarkChapter(page:Page,ebook:string,manifest:any,section:number,run:number){
 for(const [index,paragraph] of manifest.sections[section].paragraphs.entries()){
  const created=await page.request.post(`/api/reader/${ebook}/bookmarks`,{data:{id:`${ebook}-${run}-chapter-${section}-${index}`,label:paragraph.text.slice(0,40).trim()||`Chapter ${section}`,locator:{section,paragraphId:paragraph.id,progression:0}}});
  expect(created.ok()).toBe(true);
 }
 expect((await(await page.request.get(`/api/reader/${ebook}`)).json()).bookmarks).toHaveLength(manifest.sections[section].paragraphs.length);
}
// Chapters in the player bar (the Chapters page, #590), chapter `index`, and as soon as the reader is shown again and the bookmark toggle shows the chapter
// is the reader's position (its save waits out the half-second pause), `act` in the same frame. Answers the time
// from the relocation showing to `act`.
async function contentsThen(page:Page,index:number,act:"F"|"Read from audio"){
 return page.evaluate(({index,act})=>new Promise<number>((done,fail)=>{
  const scope=document.querySelector(".inline-reader")!;
  const toggle=scope.querySelector<HTMLButtonElement>(".reader-bookmark-toggle")!;
  const limit=Date.now()+10000;
  const hidden=()=>!!scope.closest('[data-state="closed"]');
  const late=()=>Date.now()>limit&&(fail(new Error(`stuck: hidden=${hidden()} pressed=${toggle.getAttribute("aria-pressed")}`)),true);
  scope.querySelector<HTMLButtonElement>(".reader-player-chapters")!.click();
  const wait=()=>{
   // The key handler takes keys once Now playing shows the reader again over the page.
   if(hidden()||toggle.getAttribute("aria-pressed")!=="true"){if(!late())requestAnimationFrame(wait);return;}
   const at=performance.now();
   if(act==="F")document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"f",bubbles:true,cancelable:true}));
   else{
    const read=[...document.querySelectorAll<HTMLButtonElement>(".reader-more button")].find(button=>button.textContent?.includes("Read from audio"));
    if(!read){fail(new Error("no Read from audio button"));return;}
    read.click();
   }
   done(performance.now()-at);
  };
  const choose=()=>{
   const chapter=document.querySelectorAll<HTMLButtonElement>(".reader-pages-chapter")[index];
   if(!chapter){if(!late())requestAnimationFrame(choose);return;}
   chapter.click();
   wait();
  };
  choose();
 }),{index,act});
}
async function openWithoutMap(page:Page,book:any,ebook:string){
 await openAt(page,book,5);
 const room=page.locator(".inline-reader");
 await expect(room.locator(".reader-bookmark-toggle")).toHaveAttribute("aria-pressed","false");
 expect(await checkpointOf(page,ebook)).toBeNull();
 return room;
}
// Closes the Now playing dialog; its close button is hidden with the reader's controls.
async function closeNowPlaying(page:Page){
 await page.keyboard.press("Escape");
 await expect(page.getByRole("dialog",{name:"Now playing",exact:true})).toBeHidden();
}

// Sequence 1: without a narration map nothing replaces the manual position, so F records the wish to follow and keeps it.
test("sequence 1: F without a narration map, inside the pause after Contents, keeps the chosen chapter saved",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {ebook,manifest,book}=await fixture(page,`No map then F ${run}`,{map:false});
 await bookmarkChapter(page,ebook,manifest,1,run);
 await withAppearance(page,{reader:{mode:"paginated"}},async()=>{
  await openWithoutMap(page,book,ebook);
  expect(await contentsThen(page,1,"F")).toBeLessThan(400);
  await closeNowPlaying(page);
  await expectSaved(page,ebook,{origin:"reading",section:1});
 });
});

// Sequence 1 through Read from audio: on main it dropped the waiting position before looking for a narration,
// and speech recovery that finds nothing left no saved place at all.
test("sequence 1: Read from audio without a narration map, inside the pause after Contents, keeps the chosen chapter saved",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {ebook,manifest,book}=await fixture(page,`No map then Read from audio ${run}`,{map:false});
 await bookmarkChapter(page,ebook,manifest,1,run);
 let asked=0;
 await page.route("**/api/alignments/recover",route=>{asked++;return route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({error:"Locating text needs the remote alignment pool. Enable it to retry."})});});
 await withAppearance(page,{reader:{mode:"paginated"}},async()=>{
  await openWithoutMap(page,book,ebook);
  expect(await contentsThen(page,1,"Read from audio")).toBeLessThan(400);
  await expect.poll(()=>asked).toBe(1);
  await expectSaved(page,ebook,{origin:"reading",section:1});
 });
});

// Sequence 1 through the switch: "Follow the narration" switched on without a narration keeps the place too.
test("sequence 1: switching on Follow the narration without a narration map keeps the chosen chapter saved",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {ebook,book}=await fixture(page,`No map then Follow ${run}`,{map:false});
 await page.setViewportSize({width:1440,height:900});
 await withAppearance(page,{reader:{mode:"paginated"}},async()=>{
  await openAt(page,book,5);
  const room=page.locator(".inline-reader");
  const sidebar=room.getByLabel("Contents sidebar");
  await expect(sidebar).toBeVisible();
  expect(await checkpointOf(page,ebook)).toBeNull();
  // Open the Reading sync panel first, so the switch is there to press inside the pause.
  await room.locator(".reader-topbar").getByRole("button",{name:"More",exact:true}).click();
  await page.locator(".reader-more:visible").getByRole("button",{name:"Reading sync",exact:true}).click();
  const follow=room.getByRole("checkbox",{name:"Follow the narration"});
  await expect(follow).toBeVisible();
  const title=(await sidebar.getByRole("button").nth(1).textContent())!.trim();
  const elapsed=await page.evaluate((title)=>new Promise<number>((done,fail)=>{
   const scope=document.querySelector(".inline-reader")!;
   const chapter=[...scope.querySelectorAll<HTMLButtonElement>('[aria-label="Contents sidebar"] button')].find(button=>button.textContent?.trim()===title)!;
   const box=scope.querySelector<HTMLInputElement>(".reader-follow input[type=checkbox]")!;
   const limit=Date.now()+10000;
   chapter.click();
   const wait=()=>{
    if(chapter.getAttribute("aria-current")!=="location"||box.checked){if(Date.now()>limit){fail(new Error(`stuck: current=${chapter.getAttribute("aria-current")} checked=${box.checked}`));return;}requestAnimationFrame(wait);return;}
    const at=performance.now();
    box.click();
    done(performance.now()-at);
   };
   wait();
  }),title);
  expect(elapsed).toBeLessThan(400);
  await expect(follow).toBeChecked();
  await expectSaved(page,ebook,{origin:"reading",section:1});
 });
});

// Sequence 2 on the book's text: a place chosen by hand waits out its pause; F with a narration to follow drops it.
test("sequence 2: F inside the pause after a Contents choice keeps the listening place saved",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {book,ebook,map,manifest}=await fixture(page,`Contents then F ${run}`);
 const interval=map.intervals.find((i:any)=>i.section===1);
 await bookmarkChapter(page,ebook,manifest,0,run);
 await seedListening(page,ebook,book,manifest,interval.paragraphId);
 await withAppearance(page,{reader:{mode:"paginated"}},async()=>{
  await openFollowing(page,book,interval);
  const room=page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi",/^epubcfi\(/);
  await expect(pagesOf(page)).not.toHaveAttribute("data-jumping",/.*/);
  const before=await manualSaves(page);
  // Chapter one by hand, then F well inside the pause after which it would be saved.
  expect(await contentsThen(page,0,"F")).toBeLessThan(400);
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  await expectKept(page,ebook,before,{origin:"listening",paragraphId:interval.paragraphId});
 });
});

// The saved place (a sentence without a CFI) is restored by a display of our own, which opens its chapter with
// the pages hidden: it landed once the sentence is in the frame and the pages are shown again. A Contents
// choice before that can be undone by the restore's last step.
async function restored(page:Page,manifest:any,paragraphId:string){
 const text=manifest.sections.flatMap((section:any)=>section.paragraphs).find((p:any)=>p.id===paragraphId).text.trim();
 await expect(page.frameLocator(".inline-reader .reader-viewport iframe").getByText(text.slice(0,24))).toBeVisible();
 await expect(pagesOf(page)).not.toHaveAttribute("data-jumping",/.*/);
}
// Sequence 6: the audio scrubber decides from where the scrub ends. Desktop width: the player bar and the
// Contents sidebar are always shown. The map starts 40 s into the file: before that there is no narrated
// sentence, so no narration to follow (`before`). After the last narrated sentence the file goes on without any:
// a gap far from every interval, where the last sentence stays the narrated one (#502).
async function scrubberSetup(page:Page,title:string){
 const {book,ebook,map,manifest}=await fixture(page,title,{lead:40});
 const track=book.tracks[0];
 const intervals=map.intervals.filter((i:any)=>i.trackId===track.id);
 const lastEnd=Math.max(...intervals.map((i:any)=>i.end));
 expect(track.duration-lastEnd).toBeGreaterThan(30);
 const gap=Math.round((lastEnd+track.duration)/2);
 expect(intervals.some((i:any)=>i.start<=gap&&i.end>gap)).toBe(false);
 const before=20;
 expect(Math.min(...intervals.map((i:any)=>i.start))).toBeGreaterThan(before+5);
 // The narrated sentence in the gap: the one with the latest start.
 const last=[...intervals].sort((a:any,b:any)=>b.start-a.start)[0];
 return {book,ebook,map,manifest,gap,before,last};
}
// Chooses chapter `chapter` (the first by default) in the Contents sidebar, and as soon as the reader's position is in it (its save
// waiting out the pause) moves the audio scrubber to `second`: a click with the real mouse (pointer released),
// or `fill` (the change a key makes), made in the frame the chapter shows: a round trip from the test can take
// longer than the pause on a loaded host, and the scrub then comes after the chapter was saved. Answers the time between.
async function contentsThenScrub(page:Page,second:number,via:"mouse"|"fill",chapter=0){
 const room=page.locator(".inline-reader");
 const slider=room.locator(".reader-audio-timeline input[type=range]");
 await expect(slider).toBeVisible();
 const box=(await slider.boundingBox())!;
 const length=Number(await slider.getAttribute("max"));
 expect(length).toBeGreaterThan(second);
 const x=box.x+9+(second/length)*(box.width-18),y=box.y+box.height/2;
 const title=(await room.getByLabel("Contents sidebar").getByRole("button").nth(chapter).textContent())!.trim();
 await page.evaluate(({title,via,second})=>new Promise<void>((done,fail)=>{
  const scope=document.querySelector(".inline-reader")!;
  const chapter=()=>[...scope.querySelectorAll<HTMLButtonElement>('[aria-label="Contents sidebar"] button')].find(button=>button.textContent?.trim()===title)!;
  // The time of the scrubber press, for the elapsed check below.
  scope.querySelector(".reader-audio-timeline")!.addEventListener(via==="mouse"?"pointerdown":"input",()=>{(window as any).__scrubAt=performance.now();},{capture:true,once:true});
  // Acts once the sidebar marks the chapter as the reader's position, on that change itself: polling by
  // animation frame lags on a loaded host, where frames come late, while the DOM already shows the chapter.
  let settled=false;
  const observer=new MutationObserver(()=>arrived());
  const limit=setTimeout(()=>{if(settled)return;settled=true;observer.disconnect();fail(new Error("Contents did not relocate"));},10000);
  const arrived=()=>{
   if(settled||chapter().getAttribute("aria-current")!=="location")return;
   settled=true;observer.disconnect();clearTimeout(limit);
   (window as any).__arrivedAt=performance.now();
   if(via==="fill"){
    // What Playwright's fill does to a range input: focus, set the value, then the input and change events. Its fill
    // sets the value from an isolated world; here the native setter does it, past React's own value tracking.
    const range=scope.querySelector<HTMLInputElement>(".reader-audio-timeline input[type=range]")!;
    range.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(range,String(second));
    range.dispatchEvent(new Event("input",{bubbles:true,composed:true}));
    range.dispatchEvent(new Event("change",{bubbles:true}));
   }
   done();
  };
  observer.observe(scope,{subtree:true,attributes:true,attributeFilter:["aria-current"]});
  chapter().click();
  arrived();
 }),{title,via,second});
 if(via==="mouse")await page.mouse.click(x,y);
 return page.evaluate(()=>(window as any).__scrubAt-(window as any).__arrivedAt);
}

test("sequence 6: the audio scrubber from a narrated sentence to before the first sentence keeps the chosen chapter saved",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {book,ebook,map,manifest,before:gap}=await scrubberSetup(page,`Scrub before the first sentence ${run}`);
 const interval=map.intervals.find((i:any)=>i.section===1);
 await seedListening(page,ebook,book,manifest,interval.paragraphId);
 await page.setViewportSize({width:1440,height:900});
 await withAppearance(page,{reader:{mode:"paginated"},playback:{progressScope:"book"}},async()=>{
  await openFollowing(page,book,interval);
  // The opening follow jump has shown its sentence: a Contents choice now is not undone by its last display.
  const room=page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi",/^epubcfi\(/);
  await expect(room.locator(".reader-viewport")).not.toHaveAttribute("data-jumping",/.*/);
  expect(await contentsThenScrub(page,gap,"mouse")).toBeLessThan(400);
  // The narration is before the map's first sentence now: nothing replaces the chapter chosen by hand.
  const slider=room.locator(".reader-audio-timeline input[type=range]");
  await expect.poll(async()=>Math.abs(Number(await slider.inputValue())-gap)).toBeLessThan(5);
  await expectSaved(page,ebook,{origin:"reading",section:0});
 });
});

test("sequence 6: the audio scrubber from before the first sentence onto a narrated sentence keeps the listening place saved",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {book,ebook,map,manifest,before:gap}=await scrubberSetup(page,`Scrub onto the first sentences ${run}`);
 // A narrated sentence of chapter two that holds a whole second, the scrubber's step.
 const interval=map.intervals.find((i:any)=>i.section===1&&Math.floor(i.end)>Math.ceil(i.start));
 await seedListening(page,ebook,book,manifest,interval.paragraphId);
 await page.setViewportSize({width:1440,height:900});
 await withAppearance(page,{reader:{mode:"paginated"},playback:{progressScope:"book"}},async()=>{
  await openAt(page,book,gap);
  const room=page.locator(".inline-reader");
  const sidebar=room.getByLabel("Contents sidebar");
  await expect(sidebar).toBeVisible();
  await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
  await expect(sidebar.getByRole("button").nth(1)).toHaveAttribute("aria-current","location");
  await restored(page,manifest,interval.paragraphId);
  const before=await manualSaves(page);
  // Onto the narrated sentence whose place was saved as the listening place.
  const target=Math.ceil(interval.start);
  expect(await contentsThenScrub(page,target,"fill")).toBeLessThan(400);
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  await expectKept(page,ebook,before,{origin:"listening",paragraphId:interval.paragraphId});
 });
});

// The gap case (#502): in a gap the last sentence stays the narrated one, so there is a narration to follow and
// back to narration works there: the chapter chosen by hand is dropped and the reader follows that sentence.
test("sequence 6: the audio scrubber from a narrated sentence into a gap follows the last narrated sentence and keeps the listening place saved",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {book,ebook,map,manifest,gap,last}=await scrubberSetup(page,`Scrub into a gap ${run}`);
 const interval=map.intervals.find((i:any)=>i.section===1);
 await seedListening(page,ebook,book,manifest,interval.paragraphId);
 await page.setViewportSize({width:1440,height:900});
 await withAppearance(page,{reader:{mode:"paginated"},playback:{progressScope:"book"}},async()=>{
  await openFollowing(page,book,interval);
  const room=page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi",/^epubcfi\(/);
  await expect(pagesOf(page)).not.toHaveAttribute("data-jumping",/.*/);
  const before=await manualSaves(page);
  expect(await contentsThenScrub(page,gap,"mouse")).toBeLessThan(400);
  const slider=room.locator(".reader-audio-timeline input[type=range]");
  await expect.poll(async()=>Math.abs(Number(await slider.inputValue())-gap)).toBeLessThan(5);
  // Following again, on the last sentence that started before the gap; the chapter chosen by hand is not saved.
  await expect(room).toHaveAttribute("data-current-passage",last.paragraphId);
  await expectKept(page,ebook,before,{origin:"listening",paragraphId:interval.paragraphId});
 });
});

// The gap case through the player-bar button: opened in a gap the reader follows the last narrated sentence; paged
// away by a Contents choice, Back to narration is offered and returns to that sentence.
test("gap case: Back to narration in a gap is offered and returns to the last narrated sentence",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {book,ebook,manifest,gap,last}=await scrubberSetup(page,`Back in a gap ${run}`);
 await seedListening(page,ebook,book,manifest,last.paragraphId);
 await page.setViewportSize({width:1440,height:900});
 await withAppearance(page,{reader:{mode:"paginated"}},async()=>{
  await openAt(page,book,gap);
  const room=page.locator(".inline-reader");
  await timedWait("follow-highlight",()=>expect(room).toHaveAttribute("data-current-passage",last.paragraphId,{timeout:READER_WAIT_MS.followHighlight}),{testName:test.info().title});
  await expect(room.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi",/^epubcfi\(/);
  await expect(pagesOf(page)).not.toHaveAttribute("data-jumping",/.*/);
  const back=room.getByRole("button",{name:"Back to narration",exact:true});
  await expect(back).toBeDisabled();
  const sidebar=room.getByLabel("Contents sidebar");
  await sidebar.getByRole("button").nth(0).click();
  await expect(sidebar.getByRole("button").nth(0)).toHaveAttribute("aria-current","location");
  await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
  await expect(back).toBeEnabled();
  await back.click();
  await expect(room).toHaveAttribute("data-current-passage",last.paragraphId);
  await expect(sidebar.getByRole("button").nth(1)).toHaveAttribute("aria-current","location");
 });
});

// Review round 1: the scrubber released on another file. The player loads that file first; back to narration is
// decided once the player reports the place, not for the narrated sentence of the file left.
// The map starts 40 s into the first file: before that there is no narrated sentence (`before`, on the first file).
async function twoFileSetup(page:Page,title:string){
 const {book,ebook,map,manifest}=await fixture(page,title,{tracks:2,lead:40});
 expect(book.tracks).toHaveLength(2);
 const [first,second]=book.tracks;
 const onFirst=map.intervals.filter((i:any)=>i.trackId===first.id),onSecond=map.intervals.filter((i:any)=>i.trackId===second.id);
 expect(onFirst.length).toBeGreaterThan(0);expect(onSecond.length).toBeGreaterThan(0);
 // Past the last narrated sentence of a file it goes on without any: a gap far from every interval.
 const gapIn=(track:any,intervals:any[])=>{
  const lastEnd=Math.max(...intervals.map((i:any)=>i.end));
  expect(track.duration-lastEnd).toBeGreaterThan(30);
  return Math.round((lastEnd+track.duration)/2);
 };
 const before=20;
 expect(Math.min(...onFirst.map((i:any)=>i.start))).toBeGreaterThan(before+5);
 return {book,ebook,map,manifest,onFirst,onSecond,gapFirst:gapIn(first,onFirst),gapSecond:gapIn(second,onSecond),first,before};
}

// From the second file back to the first, before its first sentence: there the narration has no sentence to follow.
test("review: the audio scrubber released before the first sentence of another file keeps the chosen chapter saved",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {book,ebook,manifest,onSecond,before}=await twoFileSetup(page,`Scrub before another file's first sentence ${run}`);
 const interval=onSecond[0];
 await seedListening(page,ebook,book,manifest,interval.paragraphId);
 await page.setViewportSize({width:1440,height:900});
 await withAppearance(page,{reader:{mode:"paginated"},playback:{progressScope:"book"}},async()=>{
  await openFollowing(page,book,interval,1);
  const room=page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi",/^epubcfi\(/);
  await expect(pagesOf(page)).not.toHaveAttribute("data-jumping",/.*/);
  // Chapter one by hand, then the scrubber released before the first sentence of the first file.
  const target=before;
  expect(await contentsThenScrub(page,target,"mouse",0)).toBeLessThan(400);
  // The player is on the first file, before the map's first sentence.
  const slider=room.locator(".reader-audio-timeline input[type=range]");
  await expect.poll(async()=>Math.abs(Number(await slider.inputValue())-target)).toBeLessThan(5);
  await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
  await expectSaved(page,ebook,{origin:"reading",section:0});
 });
});

test("review: the audio scrubber released on a narrated sentence of another file keeps the listening place saved",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {book,ebook,manifest,onSecond,before:unmapped}=await twoFileSetup(page,`Scrub onto another file's sentence ${run}`);
 // The longest narrated sentence of the second file, aimed at its middle.
 const interval=[...onSecond].sort((a:any,b:any)=>(b.end-b.start)-(a.end-a.start))[0];
 expect(interval.end-interval.start).toBeGreaterThan(1.5);
 await seedListening(page,ebook,book,manifest,interval.paragraphId);
 await page.setViewportSize({width:1440,height:900});
 await withAppearance(page,{reader:{mode:"paginated"},playback:{progressScope:"book"}},async()=>{
  // Before the map's first sentence: no narrated sentence, so the reader shows the saved listening place.
  await openAt(page,book,unmapped);
  const room=page.locator(".inline-reader");
  const sidebar=room.getByLabel("Contents sidebar");
  await expect(sidebar).toBeVisible();
  await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
  await expect(sidebar.getByRole("button").nth(1)).toHaveAttribute("aria-current","location");
  await restored(page,manifest,interval.paragraphId);
  const before=await manualSaves(page);
  // Chapter one by hand, then the scrubber onto the sentence of the second file saved as the listening place.
  // The second file starts where the whole book's length, as the player knows it, leaves room for it.
  const length=Number(await room.locator(".reader-audio-timeline input[type=range]").getAttribute("max"));
  const target=Math.round(length-book.tracks[1].duration+(interval.start+interval.end)/2);
  expect(await contentsThenScrub(page,target,"fill",0)).toBeLessThan(400);
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  await expectKept(page,ebook,before,{origin:"listening",paragraphId:interval.paragraphId});
 });
});

// Review round 1, blocking: a map restored from the cache is shown before the server confirmed it for the current
// audio. Following it works, but it is no narration to drop a manual save for: the audio may have changed in place.
test("review: F on a cached map the server has not confirmed yet keeps a Contents choice saved, and the refusal changes nothing",async({page},testInfo)=>{
 const run=testInfo.repeatEachIndex;
 const {book,ebook,map,manifest}=await fixture(page,`Unconfirmed map then F ${run}`);
 const interval=map.intervals.find((i:any)=>i.section===1);
 await bookmarkChapter(page,ebook,manifest,0,run);
 await seedListening(page,ebook,book,manifest,interval.paragraphId);
 await withAppearance(page,{reader:{mode:"paginated"}},async()=>{
  // Opened once: the map is fetched, confirmed and cached on this device.
  await openFollowing(page,book,interval);
  // From now on the map endpoint holds its answer until the test lets it go, then refuses the map
  // (the audio changed in place): the reader shows the cached map meanwhile.
  let asked=0,answer=()=>{};
  const held=new Promise<void>(done=>{answer=done;});
  await page.route("**/api/alignments/*/map",async route=>{asked++;await held;await route.fulfill({status:410,json:{error:"The ebook or audio changed. Rebuild this alignment before using it.",code:"alignment_stale"}});});
  try{
   await openFollowing(page,book,interval);
   await expect.poll(()=>asked).toBeGreaterThan(0);
   const room=page.locator(".inline-reader");
   await expect(room.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi",/^epubcfi\(/);
   await expect(pagesOf(page)).not.toHaveAttribute("data-jumping",/.*/);
   // Chapter one by hand, then F inside its pause.
   expect(await contentsThen(page,0,"F")).toBeLessThan(400);
   // Following the cached map is unchanged; the chapter chosen is still saved.
   await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
   await expectSaved(page,ebook,{origin:"reading",section:0});
   expect(asked).toBeGreaterThan(0);
   answer();
   // Refused: the reader shows no map, and the chapter stays the saved place.
   await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
   await expect(pagesOf(page)).not.toHaveAttribute("data-save-waiting",/.*/);
   await expectSaved(page,ebook,{origin:"reading",section:0});
  }finally{answer();}
 });
});
