import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {readerFixture} from "../reader-fixture";
import {installReaderWaitBudget,READER_WAIT_MS,timedWait} from "./timing";
// One reading view (ADR 0017, #501): the reader shows the book's own text and nothing else. The Lyrics and Word
// views are gone with their switch, their settings, the `P` key and the timing correction; `F` stays.
test.use({serviceWorkers:"block"});
installReaderWaitBudget(test);
// Every test makes its own book the one in the player; the specs after this file share the server and open
// the player's book, so each book leaves the library again.
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
// An audiobook and its ebook, each chapter narrated at 100 s per chapter for 95 s of the file.
async function fixture(page:Page,title:string){
 const response=await page.request.post("/api/import",{multipart:{title,author:"Reader QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 // A title of its own: the server names an imported EPUB by its bytes.
 const epub=await readerFixture({title:`${title} ${randomUUID()}`,bodies:[chapterOne,chapterTwo]});
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Narrated.epub",mimeType:"application/epub+zip",buffer:epub}}});
 expect(uploaded.ok()).toBe(true);
 const ebook=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings:manifest.sections.map((section:any)=>({section:section.index,trackId:book.tracks[0].id,start:section.index*100,duration:95}))}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:15000}).toBe(manifest.sections.length);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 return {book,ebook,map,manifest};
}
// The player paused on `interval` of the first file, then the inline reader opened from the home page; it follows that sentence.
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
 await expect(room.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi",/^epubcfi\(/,{timeout:READER_WAIT_MS.followHighlight});
 return room;
}
async function withAppearance(page:Page,reader:object,run:()=>Promise<void>){
 const appearance=await(await page.request.get("/api/appearance")).json();
 expect((await page.request.put("/api/appearance",{data:{...appearance,reader:{...appearance.reader,...reader}}})).ok()).toBe(true);
 try{await run();}finally{await page.request.put("/api/appearance",{data:appearance});}
}
const frameOf=(page:Page)=>page.frameLocator(".inline-reader .reader-viewport iframe");
// The book's text is what the reader shows: its pages are visible and nothing covers them.
// `paragraphId`: a sentence that is on the page.
async function expectBookText(page:Page,manifest:any,paragraphId?:string){
 const room=page.locator(".inline-reader");
 if(paragraphId){
  const text=manifest.sections.flatMap((section:any)=>section.paragraphs).find((p:any)=>p.id===paragraphId).text.trim();
  await expect(frameOf(page).getByText(text.slice(0,24))).toBeVisible();
 }
 await expect(room.locator(".reader-viewport")).not.toHaveAttribute("aria-hidden",/.*/);
 await expect(room.locator(".reader-viewport iframe")).toBeVisible();
 await expect(room.getByLabel("Lyrics reader")).toHaveCount(0);
 await expect(room.getByLabel("Word reader")).toHaveCount(0);
}
// A tap on the right edge of the page turns it: the reader pages away from the narration.
async function pageAway(page:Page){
 const room=page.locator(".inline-reader");
 const box=(await room.locator(".reader-viewport").boundingBox())!;
 await page.mouse.click(box.x+box.width*0.9,box.y+box.height/2);
 await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
}

for(const display of ["segment","word"] as const)
test(`a saved appearance that names the removed ${display==="segment"?"Lyrics":"Word"} view opens the book's text`,async({page})=>{
 const {book,map,manifest}=await fixture(page,`Saved ${display} view ${test.info().repeatEachIndex}`);
 const interval=map.intervals.find((i:any)=>i.section===1);
 await withAppearance(page,{display,mode:"paginated"},async()=>{
  await openFollowing(page,book,interval);
  await expectBookText(page,manifest,interval.paragraphId);
  // Opening it saved nothing over the old choice: the stored appearance is left as it was.
  expect((await(await page.request.get("/api/appearance")).json()).reader.display).toBe(display);
 });
});

test("the reader offers no view switch, P does nothing and F returns to the narration",async({page})=>{
 const {book,map,manifest}=await fixture(page,`View keys ${test.info().repeatEachIndex}`);
 const interval=map.intervals.find((i:any)=>i.section===1);
 // A saved Lyrics choice is the case P used to act on: it switched the reader to the pages and saved that.
 await withAppearance(page,{display:"segment",mode:"paginated"},async()=>{
  const room=await openFollowing(page,book,interval);
  // More holds the reader's options and no switch between views.
  const box=(await room.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await room.locator(".reader-topbar").getByRole("button",{name:"More",exact:true}).click();
  const more=page.locator(".reader-more:visible");
  await expect(more.getByRole("button",{name:"Listen from here",exact:true})).toBeVisible();
  await expect(more.getByRole("group",{name:"Reading mode"})).toHaveCount(0);
  for(const name of ["Page","Lyrics","Word"])await expect(more.getByRole("button",{name,exact:true})).toHaveCount(0);
  await page.getByRole("region",{name:"Playback options"}).getByRole("button",{name:"Close playback options",exact:true}).click();
  await expect(more).toHaveCount(0);
  // Now Playing has no view button either.
  const nowPlaying=page.getByRole("dialog",{name:"Now playing",exact:true});
  for(const name of ["Page","Lyrics","Word"])await expect(nowPlaying.getByRole("button",{name,exact:true})).toHaveCount(0);
  const appearanceWrites:string[]=[];
  page.on("request",request=>{if(request.method()==="PUT"&&request.url().endsWith("/api/appearance"))appearanceWrites.push(request.url());});
  // P, with the focus in the pages and outside them: nothing moves, nothing is saved.
  await pageAway(page);
  await page.keyboard.press("p");
  await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
  await page.keyboard.press("p");
  await page.keyboard.press("Shift+P");
  // F would bring the reader back by now; P leaves it paged away.
  await page.waitForTimeout(1000);
  await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
  await expectBookText(page,manifest);
  expect(appearanceWrites).toEqual([]);
  // F with the focus outside the pages returns to the narration.
  await page.keyboard.press("f");
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  await expect(room.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi",/^epubcfi\(/);
  // And with the focus in the pages, after a page turn there.
  await pageAway(page);
  await page.keyboard.press("f");
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  expect(appearanceWrites).toEqual([]);
 });
});

test("Settings offers no view choice and no words per minute",async({page})=>{
 await page.goto("/#settings");
 const playback=page.getByRole("region",{name:"Playback settings",exact:true});
 await expect(playback.getByRole("combobox",{name:"Playback progress bar",exact:true})).toBeVisible();
 await expect(page.getByRole("combobox",{name:"Ebook view"})).toHaveCount(0);
 for(const text of ["Ebook view","Words per minute","Lyrics"])await expect(page.getByText(text)).toHaveCount(0);
 await expect(page.getByRole("slider",{name:/words per minute/i})).toHaveCount(0);
});

test("the Reading sync card offers no timing correction for the sentence on the page",async({page})=>{
 const {book,map}=await fixture(page,`No timing correction ${test.info().repeatEachIndex}`);
 const interval=map.intervals.find((i:any)=>i.section===1);
 // The place the correction showed: a ready map of the recording in the player, and a sentence on the page.
 const room=await openFollowing(page,book,interval);
 const box=(await room.locator(".reader-viewport").boundingBox())!;
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await room.locator(".reader-topbar").getByRole("button",{name:"More",exact:true}).click();
 await page.locator(".reader-more:visible").getByRole("button",{name:"Reading sync",exact:true}).click();
 const card=room.locator(".reader-panel");
 await expect(card.locator(".reader-panel-heading").getByRole("heading",{name:"Reading sync",exact:true})).toBeVisible();
 await expect(card.getByRole("button",{name:"Rebuild reading sync",exact:true})).toBeVisible();
 await expect(card.getByText(/Correct this sentence/)).toHaveCount(0);
 await expect(card.getByRole("button",{name:"Save sentence timing",exact:true})).toHaveCount(0);
 await expect(card.getByRole("spinbutton")).toHaveCount(0);
});
