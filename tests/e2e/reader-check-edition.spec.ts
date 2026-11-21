// @projects firefox, webkit-iphone-now-playing, prepared-view
// #742 second round: the live reader check's automatic pick took a work with no shared default and two EPUBs, sampled
// the map of the second, set this device's choice to it, and Read opened another EPUB ("Read opened EPUB
// libgen-201c3bd3…, not libgen-1dafeaa8… of the sampled map"). The check reloaded the app before opening Read; its
// progress writes are blocked, so after the reload the dock shows the book of the latest saved progress (App.tsx
// `featured`), another work, and Read opens that work's edition. The check now leaves Now playing without a reload,
// so the dock keeps the selected book, and the selection takes only a map of the edition Read opens (`readEdition`,
// chosenEbook's rule).
import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {readerFixture} from "../reader-fixture";
import {installReaderWaitBudget} from "./timing";
import {openRead} from "./now-playing";
import {readEdition,sharedEdition} from "../../scripts/live-check-recording.mjs";
import {protectBrowserMutations} from "../../scripts/verification-safety.mjs";
import {textFrame} from "./reader-view";

test.use({viewport:{width:390,height:844}});
installReaderWaitBudget(test);
const imported:string[]=[];
test.afterEach(async({page})=>{
 await page.unrouteAll({behavior:"ignoreErrors"});
 for(const id of imported.splice(0))await page.request.delete(`/api/library/${id}`);
});
const chapter=(n:number)=>`<p>Chapter ${n} opens with this line. It goes on for a while. Then it stops for now.</p>`+
 `<p>A later paragraph of chapter ${n} comes next. It has its own sentences too. This one closes the block.</p>`;

async function importBook(page:Page,name:string){
 const title=`${name} ${randomUUID().slice(0,8)}`;
 const response=await page.request.post("/api/import",{multipart:{title,author:"Edition QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 return {book,title};
}
async function addEpub(page:Page,workId:string,title:string){
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${workId}`,{multipart:{file:{name:"Edition.epub",mimeType:"application/epub+zip",buffer:await readerFixture({bodies:[chapter(1),chapter(2)],title:`${title} ${randomUUID().slice(0,8)}`})}}});
 expect(uploaded.ok()).toBe(true);
 return (await uploaded.json()).id as string;
}
async function align(page:Page,book:any,ebook:string){
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 const pairings=manifest.sections.map((s:any)=>({section:s.index,trackId:book.tracks[0].id,start:s.index*200,duration:190}));
 expect((await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings}})).ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.status,{timeout:15000}).toMatch(/^(ready|partial)$/);
}
async function savePlace(page:Page,book:any,position:number){
 const response=await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position,duration:book.tracks[0].duration,updatedAt:Date.now()+60_000}});
 expect(response.ok()).toBe(true);
}
const room=(page:Page)=>page.locator(".inline-reader");
const audio=(page:Page)=>page.evaluate(()=>{const a=((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src);return a&&{paused:a.paused,ready:a.readyState};});
async function listenAndPause(page:Page,workId:string){
 await page.goto(`/#book/${encodeURIComponent(workId)}`);
 await page.getByRole("region",{name:"Book",exact:true}).getByRole("button",{name:"Listen",exact:true}).click();
 await expect.poll(async()=>{const a=await audio(page);return !!a&&a.ready>=2&&!a.paused;},{timeout:30000}).toBe(true);
 await page.evaluate(()=>((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src)?.pause());
}

test("the reader check opens the EPUB of the map it sampled for a work with no shared default, though another book was listened to last",async({page,baseURL})=>{
 test.setTimeout(150_000);
 // The selected work: two EPUBs and no shared default; only the second has a map of the recording.
 const {book:target,title:targetTitle}=await importBook(page,"Masquerade");
 const first=await addEpub(page,target.workId,"First edition");
 const mapped=await addEpub(page,target.workId,"Mapped edition");
 await align(page,target,mapped);
 // Another book, listened to after it, as the owner's latest saved progress.
 const {book:other,title:otherTitle}=await importBook(page,"Latest");
 const otherEpub=await addEpub(page,other.workId,"Latest edition");
 await savePlace(page,other,30);

 // The selection's rule on the server's own answer: with the device choice set to the mapped EPUB, Read opens it.
 const works=await(await page.request.get("/api/library")).json();
 const work=works.find((w:any)=>w.workId===target.workId);
 expect(work.chosenEbookId).toBeNull();
 expect(work.ebooks.map((e:any)=>e.id)).toEqual([first,mapped]);
 expect(sharedEdition(works,target.workId)).toBeNull();
 expect(readEdition(work,null)).toBe(first);
 expect(readEdition(work,mapped)).toBe(mapped);

 // The check's setup: this device's choice, the audio elements, and its progress writes blocked.
 await page.addInitScript(({workId,ebook})=>{
  localStorage.setItem(`reader-ebook:${workId}`,ebook);
  const elements:HTMLAudioElement[]=[];(window as any).__audio=elements;
  const NativeAudio=window.Audio;
  window.Audio=class extends NativeAudio{constructor(src?:string){super(src);elements.push(this);}};
 },{workId:target.workId,ebook:mapped});
 const report={errors:[] as string[],protectedWrites:0};
 await protectBrowserMutations(page.context(),baseURL,report);

 // The old path: a reload after Listen. The dock shows the latest saved progress's book and Read opens its EPUB.
 await listenAndPause(page,target.workId);
 await page.goto("/");
 await expect(page.locator(".player-dock .dock-book")).toContainText(otherTitle);
 await openRead(page);
 await expect(room(page)).toHaveAttribute("data-ebook",otherEpub);

 // The check's path now: leave Now playing by its address; the player keeps the selected book.
 await listenAndPause(page,target.workId);
 await page.evaluate(()=>{location.hash="#library";});
 await expect(page.getByRole("dialog",{name:"Now playing",exact:true})).toBeHidden();
 await expect(page.locator(".player-dock .dock-book")).toContainText(targetTitle);
 await openRead(page);
 expect(await page.evaluate(()=>decodeURIComponent(location.hash.slice("#read/".length)))).toBe(target.workId);
 await expect(room(page)).toHaveAttribute("data-ebook",mapped);
 await expect(textFrame(page.locator(".inline-reader"))).toBeVisible();
 expect(report.protectedWrites).toBeGreaterThan(0);
 await page.screenshot({path:`artifacts/reader-check-edition-390-${test.info().project.name}.png`});
 await page.setViewportSize({width:1280,height:800});
 await page.screenshot({path:`artifacts/reader-check-edition-1280-${test.info().project.name}.png`});
});
