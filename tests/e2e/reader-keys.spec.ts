import {test,expect,type Page} from "@playwright/test";
import {showControls} from "./reader-bands";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {readerFixture} from "../reader-fixture";
import {installReaderWaitBudget,READER_WAIT_MS,timedWait} from "./timing";
import {highlightShown,textShown} from "./reader-view";
// `F` returns to the narration only when the reader has the keyboard (#501 review): not behind a sheet or a dialog
// above the reader, not while typing in a field (also one inside the book's pages), not with a modifier and not
// without the book's narration in the player. A focused button does not take it.
test.use({serviceWorkers:"block"});
installReaderWaitBudget(test);
const imported:string[]=[];
test.afterEach(async({page})=>{
 await page.unrouteAll({behavior:"wait"});
 for(const id of imported.splice(0))expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});
const sentences=(chapter:number)=>Array.from({length:14},(_,i)=>`<p>Chapter ${chapter} paragraph ${i+1} opens a short scene. The rabbit hurried past the trees again. Alice wondered what would happen to her next.</p>`).join("");
// Chapter two carries the fields a book keeps once the reader has sanitised it (it removes <input>, <button> and
// contenteditable): a text area and a list to choose from.
const fields=`<p>Notes for this chapter follow here.</p><p><textarea id="note" aria-label="Note"></textarea></p>`+
 `<p><select id="choice" aria-label="Choice"><option value="apple">apple</option><option value="fig">fig</option></select></p>`;
async function fixture(page:Page,title:string,{link=true}={}){
 const response=await page.request.post("/api/import",{multipart:{title,author:"Reader QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 const epub=await readerFixture({title:`${title} ${randomUUID()}`,bodies:[sentences(1),fields+sentences(2)]});
 const uploaded=await page.request.post(`/api/ebooks/import${link?`?workId=${book.workId}`:""}`,{multipart:{file:{name:"Keys.epub",mimeType:"application/epub+zip",buffer:epub}}});
 expect(uploaded.ok()).toBe(true);
 const ebook=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 if(!link)return {book,ebook,manifest,map:null};
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings:manifest.sections.map((section:any)=>({section:section.index,trackId:book.tracks[0].id,start:section.index*100,duration:95}))}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:15000}).toBe(manifest.sections.length);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 return {book,ebook,map,manifest};
}
const textOf=(manifest:any,paragraphId:string)=>manifest.sections.flatMap((section:any)=>section.paragraphs).find((p:any)=>p.id===paragraphId).text as string;
// The first narrated sentence of the book: one page turn takes it off the page.
const firstInterval=(map:any)=>[...map.intervals].sort((a:any,b:any)=>a.section-b.section||a.start-b.start)[0];
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
// A tap on the right edge of the page turns it: the reader pages away from the narration.
async function pageAway(page:Page,room=page.locator(".inline-reader")){
 const box=(await room.locator(".reader-viewport").boundingBox())!;
 await page.mouse.click(box.x+box.width*0.9,box.y+box.height/2);
 await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
}
// F has had time to act, and the reader is still paged away. The positive F at the end of each test shows the
// same press would have brought the narration back.
async function stillAway(page:Page,room=page.locator(".inline-reader")){
 await page.waitForTimeout(600);
 await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
}
async function backWithF(page:Page,room:ReturnType<Page["locator"]>,interval:any,manifest:any){
 await page.keyboard.press("f");
 await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
 await expect.poll(()=>highlightShown(room)).toBe(true);
 await expect.poll(()=>textShown(room,textOf(manifest,interval.paragraphId))).toBe(true);
}

test("F does nothing behind Playback options, a dialog above the reader or with a modifier key",async({page})=>{
 const {book,map,manifest}=await fixture(page,`Keys above ${test.info().repeatEachIndex}`);
 const interval=firstInterval(map);
 const room=await openFollowing(page,book,interval);
 await pageAway(page);
 // Browser and system shortcuts with F are not the reader's key: with the focus in the pages after the page
 // turn, and outside them.
 for(const key of ["Control+f","Alt+f","Meta+f","Control+Shift+F"])await page.keyboard.press(key);
 await stillAway(page);
 // Outside them: on the player's Back to narration button (Firefox keeps the focus in the frame after a blur),
 // in the foot's row that the controls show (#587).
 await showControls(page,room);
 const backButton=room.getByRole("button",{name:"Back to narration",exact:true});
 await backButton.focus();
 expect(await backButton.evaluate(button=>document.activeElement===button)).toBe(true);
 for(const key of ["Control+f","Alt+f","Meta+f","Control+Shift+F"])await page.keyboard.press(key);
 await stillAway(page);
 const options=page.getByRole("region",{name:"Playback options"});
 // The reader's More opens Now Playing's Playback options sheet; no reader panel is open with it.
 await showControls(page,room);
 await room.locator(".reader-topbar").getByRole("button",{name:"More",exact:true}).click();
 await expect(options).toBeVisible();
 await expect(room.locator(".reader-panel")).toHaveCount(0);
 await page.keyboard.press("f");
 await stillAway(page);
 // Dialogs without a text field focus their container, so the key reaches the window while the reader is mounted.
 for(const [button,title] of [["Keyboard shortcuts","Keyboard shortcuts"],["Position history","Position history"]]){
  await options.getByRole("button",{name:button,exact:true}).click();
  const dialog=page.getByRole("dialog",{name:title,exact:true});
  await expect(dialog).toBeVisible();
  await expect.poll(()=>dialog.evaluate(element=>element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("f");
  await stillAway(page);
  await dialog.getByRole("button",{name:"Close dialog",exact:true}).click();
  await expect(dialog).toBeHidden();
 }
 await options.getByRole("button",{name:"Close playback options",exact:true}).click();
 await expect(options).toBeHidden();
 await backWithF(page,room,interval,manifest);
});

test("F typed into a field goes into the field, in the book's pages and in the reader's search",async({page})=>{
 const {book,map,manifest}=await fixture(page,`Keys fields ${test.info().repeatEachIndex}`);
 const interval=firstInterval(map);
 const room=await openFollowing(page,book,interval);
 const frame=page.frameLocator(".inline-reader .reader-viewport iframe");
 // Contents → chapter two, which holds the fields: the reader pages away from the narration in chapter one.
 await showControls(page,room);
 await room.getByRole("button",{name:"Chapters",exact:true}).click();
 await room.locator(".reader-panel").getByRole("button",{name:"The Pool of Tears"}).click();
 await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
 const note=frame.locator("#note");
 await expect(note).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
 const playing=room.getByRole("button",{name:"Pause narration",exact:true});
 // Every key typed into a field of the book stays there: F, Space and the arrows are not shortcuts there.
 await note.focus();
 await page.keyboard.type("f F");
 await page.keyboard.press("ArrowLeft");
 await page.keyboard.type("x");
 await expect(note).toHaveValue("f xF");
 // In a list, F picks the option that starts with it.
 const choice=frame.locator("#choice");
 await choice.focus();
 await page.keyboard.press("f");
 await expect(choice).toHaveValue("fig");
 await stillAway(page);
 await expect(playing).toHaveCount(0);
 // The reader's own search field takes F as a letter too.
 await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
 // The controls shown for Chapters stay until the next tap (#587); a tap shows them only if they are hidden.
 if(!await room.locator(".reader-topbar").isVisible()){
  const box=(await room.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(box.x+box.width/2,box.y+box.height*0.75);
 }
 await room.locator(".reader-topbar").getByRole("button",{name:"Search this book",exact:true}).click();
 const search=page.getByRole("searchbox",{name:"Search inside ebook"});
 await search.focus();
 await page.keyboard.type("f");
 await expect(search).toHaveValue("f");
 await stillAway(page);
 await room.locator(".reader-panel-heading").getByRole("button",{name:"Close reader options",exact:true}).click();
 await expect(room.locator(".reader-panel")).toHaveCount(0);
 await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
 await backWithF(page,room,interval,manifest);
});

test("F right after a desktop page button returns to the narration's page",async({page})=>{
 await page.setViewportSize({width:1440,height:900});
 const {book,map,manifest}=await fixture(page,`Keys desktop ${test.info().repeatEachIndex}`);
 const interval=firstInterval(map);
 const room=await openFollowing(page,book,interval);
 const next=room.getByRole("button",{name:"Next page",exact:true});
 await next.click();
 // Firefox leaves the focus on a clicked button; this makes it so in every engine.
 await next.focus();
 await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
 await expect.poll(()=>textShown(room,textOf(manifest,interval.paragraphId))).toBe(false);
 expect(await next.evaluate(button=>document.activeElement===button)).toBe(true);
 await backWithF(page,room,interval,manifest);
 // The same with the other page button.
 const previous=room.getByRole("button",{name:"Previous page",exact:true});
 await next.click();
 await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
 await next.click();
 await previous.click();
 await previous.focus();
 await expect.poll(()=>textShown(room,textOf(manifest,interval.paragraphId))).toBe(false);
 await backWithF(page,room,interval,manifest);
});

test("F does nothing in the reader without the book's narration in the player",async({page})=>{
 const {ebook}=await fixture(page,`Keys unlinked ${test.info().repeatEachIndex}`,{link:false});
 await page.goto(`/#reader/${ebook}`);
 const reader=page.getByRole("dialog",{name:"Reader"});
 const room=reader.locator(".reader-room");
 await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
 await pageAway(page,room);
 await page.keyboard.press("f");
 await page.waitForTimeout(600);
 // F would switch following on and arm a return for a narration that is not there.
 const box=(await room.locator(".reader-viewport").boundingBox())!;
 await page.mouse.click(box.x+box.width/2,box.y+box.height*0.75);
 await room.locator(".reader-topbar").getByRole("button",{name:"More",exact:true}).click();
 await reader.locator(".reader-more").getByRole("button",{name:"Reading sync",exact:true}).click();
 await expect(room.getByRole("checkbox",{name:"Follow the narration"})).not.toBeChecked();
});
