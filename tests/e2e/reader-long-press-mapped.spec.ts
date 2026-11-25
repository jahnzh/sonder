// @projects firefox, webkit-iphone-now-playing
// #742: on a partly mapped edition (Consider Phlebas), the live reader check's long-press got no "Listening from here".
// It pressed near the left edge of the narrated sentence's highlight box; a sentence that starts in the middle of a
// line and runs on has a box from the text's left edge, so the press landed on the sentence before, which the map
// does not cover. The check now presses inside one of the highlight's own lines (narratedPressPoint, the helper the
// check uses). A long-press on a sentence the map does not cover says so in the foot.
import {test,expect,type Page,type Locator} from "@playwright/test";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {readerFixture} from "../reader-fixture";
import {installReaderWaitBudget,READER_WAIT_MS} from "./timing";
import {openRead} from "./now-playing";
import {playFromLibrary} from "./library-play";
import {narratedPressPoint} from "../../scripts/live-reader-controls.mjs";
import {textFrame} from "./reader-view";
import { installReaderFrames } from "./reader-frames";

test.use({viewport:{width:390,height:844}});
installReaderWaitBudget(test);
installReaderFrames(test);
const imported:string[]=[];
test.afterEach(async({page})=>{
 await page.unrouteAll({behavior:"ignoreErrors"});
 for(const id of imported.splice(0))await page.request.delete(`/api/library/${id}`);
});

// The opening sentence fills a line and more; the narrated one starts in the middle of its last line and runs on.
const opening="<p>The opening sentence of this chapter is the one the reading sync did not match, and it runs on well past the end of the first line of the page. "+
 "The narrated sentence begins in the middle of a line, after that one, and it keeps going over the next line and the line after that before it ends.</p>"+
 "<p>Another paragraph follows it here. It has two short sentences of its own.</p>";
type Interval={paragraphId:string;start:number;end:number;section:number;trackId:string};

async function fixture(page:Page){
 const title=`Long press ${randomUUID().slice(0,8)}`;
 const response=await page.request.post("/api/import",{multipart:{title,author:"Press QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;imported.push(id);
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Press.epub",mimeType:"application/epub+zip",buffer:await readerFixture({bodies:[opening,"<p>The second chapter is short. It ends here.</p>"],title})}}});
 expect(uploaded.ok()).toBe(true);const ebook=(await uploaded.json()).id as string;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 const sentences=manifest.sections.flatMap((s:any)=>s.paragraphs) as {id:string;text:string}[];
 const idOf=(start:string)=>sentences.find(p=>p.text.trim().startsWith(start))!.id;
 const UNMAPPED=idOf("The opening sentence"),NARRATED=idOf("The narrated sentence");
 expect(sentences.findIndex(p=>p.id===NARRATED)).toBe(sentences.findIndex(p=>p.id===UNMAPPED)+1);
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings:manifest.sections.map((s:any)=>({section:s.index,trackId:book.tracks[0].id,start:s.index*200,duration:190}))}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:15000}).toBe(manifest.sections.length);
 const job=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0];
 const intervals=(await(await page.request.get(`/api/alignments/${job.id}/map`)).json()).intervals as Interval[];
 // A partly mapped edition: the map does not cover the opening sentence (the server's map and its listing, as served).
 const partial=intervals.filter(i=>i.paragraphId!==UNMAPPED);
 expect(partial.length).toBe(intervals.length-1);
 await page.route(new RegExp(`/api/alignments/${job.id}/map$`),async route=>{
  const answer=await route.fetch();const body=await answer.json();
  await route.fulfill({response:answer,json:{...body,status:"partial",intervals:body.intervals.filter((i:Interval)=>i.paragraphId!==UNMAPPED)}});
 });
 return {title,narrated:partial.find(i=>i.paragraphId===NARRATED)!,UNMAPPED,NARRATED};
}
async function instrument(page:Page){
 await page.addInitScript(()=>{
  const elements:HTMLAudioElement[]=[];(window as any).__audio=elements;
  const NativeAudio=window.Audio;
  window.Audio=class extends NativeAudio{constructor(src?:string){super(src);elements.push(this);}};
 });
}
const position=(page:Page)=>page.evaluate(()=>((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src)?.currentTime??0);
async function seek(page:Page,to:number){
 await expect.poll(async()=>{
  await page.evaluate(to=>{const a=((window as any).__audio as HTMLAudioElement[]).find(a=>!!a.src);if(a&&a.readyState>=1)a.currentTime=to;},to);
  return position(page);
 }).toBeCloseTo(to,1);
}
async function longPressAt(page:Page,point:{x:number;y:number}){
 await page.mouse.move(point.x,point.y);await page.mouse.down();await page.waitForTimeout(800);await page.mouse.up();
}
// A point on the first line of the sentence before the narrated one: where the live check's earlier point, near the
// left edge of a highlight's bounding box, landed.
async function openingPoint(room:Locator){
 return room.locator(".reader-viewport").evaluate(host=>{
  const span=[...host.querySelectorAll("[data-s]")].find(element=>element.textContent?.includes("The opening sentence"))!;
  const line=span.getClientRects()[0]!;
  return {x:line.left+Math.min(line.width/2,40),y:line.top+line.height/2};
 });
}
// The sentence a press at `point` reaches, by the caret there: the text it starts in.
async function textAt(room:Locator,point:{x:number;y:number}){
 return room.locator(".reader-viewport").evaluate((host,point)=>{
  for(const frame of (window as any).__readerFrames(host)){
   const doc=frame.contentDocument,b=frame.getBoundingClientRect();
   if(!doc||point.x<b.left||point.x>b.right||point.y<b.top||point.y>b.bottom)continue;
   const x=point.x-b.left,y=point.y-b.top;
   const range=(doc as any).caretRangeFromPoint?.(x,y)??(()=>{const c=(doc as any).caretPositionFromPoint?.(x,y);if(!c)return null;const r=doc.createRange();r.setStart(c.offsetNode,c.offset);return r;})();
   if(!range)return null;
   // By the place in the paragraph, whatever elements its sentences are in.
   const inside=range.startContainer.nodeType===1?range.startContainer as Element:range.startContainer.parentElement;
   const block=inside?.closest("p"),text=block?.textContent||"",start=text.indexOf("The narrated sentence begins");
   if(!block||!text.includes("The opening sentence"))return "elsewhere";
   const before=doc.createRange();
   before.selectNodeContents(block);
   before.setEnd(range.startContainer,range.startOffset);
   return before.toString().length>=start?"narrated":"opening";
  }
  return null;
 },point);
}

test("the live check's long-press lands on the narrated sentence of a partly mapped edition and listens from there; the unmapped sentence before it asks for a map",async({page})=>{
 test.setTimeout(120_000);
 await instrument(page);
 const {title,narrated,NARRATED}=await fixture(page);
 await page.goto("/");
 await playFromLibrary(page,title);
 await page.evaluate(()=>((window as any).__audio as HTMLAudioElement[]).forEach(a=>a.pause()));
 await openRead(page);
 const room=page.locator(".inline-reader");
 await expect(textFrame(room)).toBeVisible();
 const middle=(narrated.start+narrated.end)/2;
 await seek(page,middle);
 await expect(room).toHaveAttribute("data-current-passage",NARRATED,{timeout:READER_WAIT_MS.followHighlight});
 await expect(room).toHaveAttribute("data-controls-visible","false");
 // The narrated sentence starts mid-line: a press must land inside one of its own lines, not before it on that line.
 let point:{x:number;y:number}|null=null,last:{x:number;y:number}|null=null;
 await expect.poll(async()=>{const p=await narratedPressPoint(room);const same=!!p&&!!last&&Math.abs(p.x-last.x)<0.5&&Math.abs(p.y-last.y)<0.5;last=p;if(same)point=p;return same;}).toBe(true);
 // The highlight is the sentence's own elements (#802); the point on the unmapped sentence before it is taken from
 // that sentence's own first line.
 const unmapped=()=>openingPoint(room);
 const old=await unmapped();
 expect(await textAt(room,old),"the opening point is on the sentence before the narrated one").toBe("opening");
 expect(await textAt(room,point!),"the check's point is on the narrated sentence").toBe("narrated");
 // The press the check makes: Listening from here, and the narration moves to the narrated sentence's start.
 await longPressAt(page,point!);
 const message=room.locator(".reader-player > .reader-message");
 await expect(message.getByRole("status")).toHaveText("Listening from here");
 await page.screenshot({path:`artifacts/reader-long-press-listening-390-${test.info().project.name}.png`});
 await expect.poll(()=>position(page)).toBeGreaterThanOrEqual(narrated.start-0.5);
 await message.getByRole("button",{name:"Undo",exact:true}).click();
 await expect(message).toHaveCount(0);
 await page.evaluate(()=>((window as any).__audio as HTMLAudioElement[]).forEach(a=>a.pause()));
 await seek(page,middle);
 await expect(room).toHaveAttribute("data-current-passage",NARRATED);
 // A press on the sentence the map does not cover says so in the foot, and plays nothing.
 const before=await position(page);
 await longPressAt(page,await unmapped());
 await expect(message.getByRole("alert")).toHaveText("Prepare a matching audiobook map for this passage first.");
 await expect(message.getByRole("status")).toHaveCount(0);
 expect(Math.abs((await position(page))-before)).toBeLessThan(1);
 await page.screenshot({path:`artifacts/reader-long-press-unmapped-390-${test.info().project.name}.png`});
 await page.setViewportSize({width:1280,height:900});
 await expect(message.getByRole("alert")).toHaveText("Prepare a matching audiobook map for this passage first.");
 await page.screenshot({path:`artifacts/reader-long-press-unmapped-1280-${test.info().project.name}.png`});
});
