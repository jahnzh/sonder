// @projects firefox, mobile-chrome, mobile-firefox, mobile-safari, webkit-iphone-now-playing, prepared-view
import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {readerFixture} from "../reader-fixture";
import {installReaderWaitBudget,READER_WAIT_MS,timedWait} from "./timing";
import {openRead} from "./now-playing";
import {bookText,textFrame} from "./reader-view";
import {installReaderFrames} from "./reader-frames";
import {notOnPreparedView,onPreparedView} from "./prepared-view";
// The service worker would answer the script request below before page.route sees it.
test.use({serviceWorkers:"block"});
// Per-step expect ceilings are up to 45 s; leave room for many highlight waits.
installReaderWaitBudget(test);
installReaderFrames(test);
test.afterEach(async({page})=>{await page.unrouteAll({behavior:"wait"});});
// Chapter one: counted blocks inside <nav> and text inside <svg> before the narrated text (#69).
const navChapter=`<nav epub:type="landmarks" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li>Skip to the story</li><li>Notes on this edition</li></ol></nav>`+
 `<p><svg xmlns="http://www.w3.org/2000/svg" width="40" height="12"><text x="0" y="10">Ornament</text></svg></p>`+
 `<p>The first paragraph opens here. It carries a second sentence. A third sentence closes it.</p>`+
 `<p>The second paragraph begins now. Its middle sentence follows quickly. The last sentence ends the block.</p>`;
// Chapter two: leading whitespace, runs of spaces, characters NFKC changes, inline markup, <noscript> and <br/> line breaks.
const textChapter=`<p>\n      Leading whitespace opens this block.   Then   spaced   words   follow here.\n   </p>`+
 `<p>The ﬁrst ligature sentence ﬁnds its place. A full width ＡＢＣ sentence comes next. A non&#160;breaking space ends it.</p>`+
 `<p>Plain <em>emphasis</em> starts this one. A <span>span</span> sits in the second sentence.</p>`+
 `<noscript><p>Hidden fallback paragraph.</p></noscript>`+
 `<p>After the code block comes this sentence. Then one more sentence ends the chapter.</p>`+
 // A line break is "\n" to the server's parser and no character in the browser: each <br> shifted every later sentence.
 `<p>Roses are red.<br/>Violets are blue.<br/>Sugar is sweet.<br/>And so are you.</p>`;
// `unique`: the EPUB gets a title of its own, so a repeat on the same server imports a new ebook rather than the last run's.
async function fixture(page:Page,title:string,unique=false){
 const response=await page.request.post("/api/import",{multipart:{title,author:"Reader QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Offsets.epub",mimeType:"application/epub+zip",buffer:await readerFixture({bodies:[navChapter,textChapter],...(unique?{title:`${title} ${randomUUID()}`}:{})})}}});
 expect(uploaded.ok()).toBe(true);const ebook=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings:manifest.sections.map((section:any)=>({section:section.index,trackId:book.tracks[0].id,start:section.index*100,duration:95}))}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length,{timeout:15000}).toBe(manifest.sections.length);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 return {book,ebook,map,manifest};
}
// The text of the follow highlight: its CFI resolved in the page by epub.js's own CFI class.
// In the view of prepared text (#802) the highlight is the sentence's own elements: its text is theirs.
async function highlighted(page:Page){
 const follow=page.locator(".inline-reader .reader-viewport .sonder-follow");
 if(onPreparedView()){
  await timedWait("follow-highlight",()=>expect(follow.first()).toBeVisible({timeout:READER_WAIT_MS.followHighlight}),{testName:test.info().title});
  return (await follow.allTextContents()).join("").replace(/\s+/g," ");
 }
 await timedWait("follow-highlight",()=>expect(follow).toHaveAttribute("data-epubcfi",/^epubcfi\(/,{timeout:READER_WAIT_MS.followHighlight}),{testName:test.info().title});
 if(!await page.evaluate(()=>"ePub" in window)){
  // An inline script (addScriptTag with a path) would be refused by the app's script-src 'self' (#76), so serve the file from the app's own origin.
  await page.route("**/__epub-test.js",route=>route.fulfill({path:"node_modules/epubjs/dist/epub.min.js",contentType:"text/javascript"}));
  await page.addScriptTag({url:"/__epub-test.js"});
 }
 const cfi=(await follow.getAttribute("data-epubcfi"))!;
 return textFrame(page.locator(".inline-reader")).evaluate((iframe:HTMLIFrameElement,cfi)=>
  new (window as any).ePub.CFI(cfi).toRange(iframe.contentDocument).toString().replace(/\s+/g," "),cfi);
}
async function open(page:Page,book:any,interval:any){
 // Leave the previous page first: it saves its own position as it unloads.
 await page.goto("about:blank");
 const books=await(await page.request.get("/api/books")).json();
 const previous=books.find((b:any)=>b.recordingId===book.recordingId)?.progress?.updatedAt||0;
 const response=await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position:interval.start+.5,duration:book.tracks[0].duration,updatedAt:Math.max(Date.now(),previous+1)}});
 expect(response.ok()).toBe(true);
 const saved=await response.json();
 expect(saved.conflict).toBe(false);
 expect(saved.progress.position).toBe(interval.start+.5);
 await page.goto("/");
 await openRead(page);
 await timedWait("follow-highlight",()=>expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage",interval.paragraphId,{timeout:READER_WAIT_MS.followHighlight}),{testName:test.info().title});
}
async function withReader(page:Page,reader:object,run:()=>Promise<void>){
 const appearance=await(await page.request.get("/api/appearance")).json();
 await page.request.put("/api/appearance",{data:{...appearance,reader:{...appearance.reader,...reader}}});
 try{await run();}finally{await page.request.put("/api/appearance",{data:appearance});}
}
// Every narrated sentence, also the ones after a <nav> and <svg> and in blocks with leading whitespace or
// NFKC-changed characters, is highlighted from its first to its last character (#69: it was one character late).
for(const [mode,label] of [["paginated","Page"],["scroll","Scroll"]] as const)
test(`the follow highlight covers exactly the narrated sentence in ${label} mode`,async({page})=>{
 const {book,map,manifest}=await fixture(page,`Highlight offsets ${label}`);
 const fragments=new Map(manifest.sections.flatMap((s:any)=>s.paragraphs.map((p:any)=>[p.id,p])));
 await withReader(page,{mode},async()=>{
  const wrong=[];
  for(const interval of map.intervals){
   await open(page,book,interval);
   const narrated=(fragments.get(interval.paragraphId) as any).text,shown=(await highlighted(page)).normalize("NFKC").trim();
   if(shown!==narrated)wrong.push({paragraphId:interval.paragraphId,narrated,shown});

  }
  expect(wrong).toEqual([]);
 });
});
// The highlight stays (#502): chapter one is narrated from 0 s and chapter two from 100 s, so after chapter one's last
// sentence the file goes on with no sentence until 100 s. Playing through that gap, the highlight stays on chapter one's last
// sentence and the view does not move; it moves to chapter two's first sentence once that begins. A jump into the gap
// marks the last sentence that started before it.
for(const [mode,label] of [["paginated","Page"],["scroll","Scroll"]] as const)
test(`the follow highlight stays through a gap and moves when the next sentence begins in ${label} mode`,async({page},testInfo)=>{
 await page.addInitScript(()=>{
  const audio:HTMLAudioElement[]=[];(window as any).__gapAudio=audio;
  const NativeAudio=window.Audio;
  window.Audio=class extends NativeAudio{constructor(src?:string){super(src);audio.push(this);}};
 });
 const {book,map,manifest}=await fixture(page,`Highlight gap ${label} ${testInfo.repeatEachIndex}`,true);
 const fragments=new Map(manifest.sections.flatMap((s:any)=>s.paragraphs.map((p:any)=>[p.id,p])));
 const text=(interval:any)=>(fragments.get(interval.paragraphId) as any).text;
 const last=map.intervals.filter((i:any)=>i.section===0).sort((a:any,b:any)=>b.start-a.start)[0];
 const next=map.intervals.filter((i:any)=>i.section===1).sort((a:any,b:any)=>a.start-b.start)[0];
 // A gap of seconds with no sentence in it: no interval covers it.
 expect(next.start-last.end).toBeGreaterThan(3);
 expect(map.intervals.some((i:any)=>i.start<next.start&&i.end>last.end)).toBe(false);
 await withReader(page,{mode},async()=>{
  // Shortly before the end of chapter one's last sentence, so the narration crosses the whole gap.
  await open(page,book,{...last,start:Math.max(last.start,last.end-1.5)-.5});
  expect((await highlighted(page)).normalize("NFKC").trim()).toBe(text(last));
  if(!onPreparedView()){
   await page.route("**/__epub-test.js",route=>route.fulfill({path:"node_modules/epubjs/dist/epub.min.js",contentType:"text/javascript"}));
   if(!await page.evaluate(()=>"ePub" in window))await page.addScriptTag({url:"/__epub-test.js"});
  }
  const room=page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport")).not.toHaveAttribute("data-jumping",/.*/);
  await room.getByRole("button",{name:"Play narration",exact:true}).click();
  // The audio position, the passage followed, the text the highlight covers and where the view is scrolled, all
  // at one instant, until the highlight has moved on or 20 s passed.
  // The fixture's gap lasts over a minute: a second and a half into it the audio skips, still inside it, to two
  // seconds before the next sentence, as a seek in the player would.
  await page.waitForFunction(()=>((window as any).__gapAudio as HTMLAudioElement[]|undefined)?.some(a=>!!a.src));
  const samples:{time:number;passage:string|null;text:string|null;view:string}[]=await page.evaluate(async({previous,end,next})=>{
   const out:any[]=[];
   const audio=((window as any).__gapAudio as HTMLAudioElement[]).find(a=>!!a.src)!;
   const deadline=Date.now()+20000;
   let skipped=false;
   for(;;){
    if(!skipped&&audio.currentTime>end+1.5){skipped=true;audio.currentTime=next-2;}
    const room=document.querySelector(".inline-reader")!;
    const viewport=room.querySelector(".reader-viewport")!;
    const follow=viewport.querySelector(".sonder-follow");
    const iframe=viewport.querySelector("iframe") as HTMLIFrameElement|null;
    const container=viewport.querySelector(":is(.epub-container,.prepared-scroll)") as HTMLElement|null;
    const cfi=follow?.getAttribute("data-epubcfi");
    let text:string|null=null;
    try{if(cfi&&iframe?.contentDocument)text=new (window as any).ePub.CFI(cfi).toRange(iframe.contentDocument).toString().replace(/\s+/g," ").trim();}catch{}
    // The view of prepared text: the marked elements' own text.
    if(!iframe&&follow)text=[...viewport.querySelectorAll(".sonder-follow")].map(element=>element.textContent).join("").replace(/\s+/g," ").trim();
    const passage=room.getAttribute("data-current-passage");
    out.push({time:audio.currentTime,passage,text,view:`${container?.scrollLeft}:${container?.scrollTop}:${iframe?.contentWindow?.scrollX}:${iframe?.contentWindow?.scrollY}`});
    if((passage&&passage!==previous)||Date.now()>deadline)break;
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   audio.pause();
   return out;
  },{previous:last.paragraphId,end:last.end,next:next.start});
  const moved=samples.at(-1)!;
  // It moved, to the next sentence, and only once that sentence had begun.
  expect(moved.passage).toBe(next.paragraphId);
  expect(moved.time).toBeGreaterThanOrEqual(next.start-.05);
  const before=samples.slice(0,-1);
  expect(before.every(sample=>sample.passage===last.paragraphId)).toBe(true);
  // Through the gap: the highlight is on chapter one's last sentence the whole time, and the view stays put.
  const gap=before.filter(sample=>sample.time>last.end+.3&&sample.time<next.start-.05);
  expect(gap.length).toBeGreaterThan(15);
  // Both sides of the skip are in the gap.
  expect(gap.some(sample=>sample.time<last.end+2)&&gap.some(sample=>sample.time>next.start-2)).toBe(true);
  expect(gap.filter(sample=>sample.text?.normalize("NFKC")!==text(last))).toEqual([]);
  expect(new Set(gap.map(sample=>sample.view)).size).toBe(1);
  await expect.poll(async()=>(await highlighted(page)).normalize("NFKC").trim()).toBe(text(next));
  // A jump into the gap marks the last sentence that started before the new position.
  await open(page,book,{...last,start:(last.end+next.start)/2-.5});
  expect((await highlighted(page)).normalize("NFKC").trim()).toBe(text(last));
 });
});
test("long-press on a sentence's first letter listens from that sentence, not the one before",async({page})=>{
 await page.addInitScript(()=>{
  const time=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"currentTime")!;
  Object.defineProperty(HTMLMediaElement.prototype,"currentTime",{configurable:true,get(){return time.get!.call(this);},set(value){((window as any).__seeks||=[]).push(value);time.set!.call(this,value);}});
 });
 const {book,map}=await fixture(page,"Highlight offsets long-press");
 const second=map.intervals.find((interval:any)=>interval.paragraphId==="0:2");
 await withReader(page,{mode:"paginated"},async()=>{
  await open(page,book,map.intervals[0]);
  await bookText(page,".inline-reader").getByText("It carries a second sentence.").waitFor();
  // The left edge of "It carries a second sentence.": a caret there sits right after the previous sentence's space.
  const point=await page.locator(".inline-reader .reader-viewport").evaluate((host)=>{
   const iframe=(window as any).__readerFrames(host)[0] as HTMLIFrameElement;
   const doc=iframe.contentDocument!,walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT),box=iframe.getBoundingClientRect();
   let node:Node|null;
   while((node=walker.nextNode())){
    const at=(node.textContent||"").indexOf("It carries");
    if(at<0)continue;
    const range=doc.createRange();range.setStart(node,at);range.setEnd(node,at+1);
    const r=range.getBoundingClientRect();
    return {x:box.x+r.x+1,y:box.y+r.y+r.height/2};
   }
   throw new Error("sentence not rendered");
  });
  await page.evaluate(()=>{(window as any).__seeks=[];});
  await page.mouse.move(point.x,point.y);
  await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
  await expect(page.locator(".inline-reader").getByRole("status").filter({hasText:"Listening from here"})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as any).__seeks.at(-1))).toBe(second.start);
 });
});
test("the follow highlight is re-measured when fonts finish loading and cleans up listeners on chapter change",async({page})=>{
 notOnPreparedView("it watches epub.js's drawn highlight (SVG rectangles over the frame) being measured again when the frame's fonts load, and the frame's own listeners; in the new view the highlight is the sentence's own elements, which the browser lays out with the text, and there is no frame");
 const {book,map}=await fixture(page,"Highlight font load redraw");
 await withReader(page,{mode:"paginated"},async()=>{
  await open(page,book,map.intervals[0]);
  const rect=page.locator(".inline-reader .reader-viewport .sonder-follow rect").first();
  await expect(rect).toBeVisible();
  const widthBefore=await rect.evaluate((el:SVGRectElement)=>el.width.baseVal.value);

  // Alter letter-spacing in the rendered chapter to change text width
  await textFrame(page.locator(".inline-reader")).evaluate((iframe:HTMLIFrameElement)=>{
    iframe.contentDocument!.body.style.letterSpacing="8px";
  });

  // Dispatch loadingdone on document.fonts
  await page.evaluate(()=>{
    document.fonts.dispatchEvent(new Event("loadingdone"));
  });

  // The highlight boxes must be re-measured afterwards
  let widthAfterDocFonts=0;
  await expect.poll(async()=>{
    widthAfterDocFonts=await rect.evaluate((el:SVGRectElement)=>el.width.baseVal.value);
    return widthAfterDocFonts;
  },{timeout:3000}).not.toBe(widthBefore);

  // Alter letter-spacing again and dispatch loadingdone on the frame document's fonts
  await textFrame(page.locator(".inline-reader")).evaluate((iframe:HTMLIFrameElement)=>{
    iframe.contentDocument!.body.style.letterSpacing="16px";
    iframe.contentDocument!.fonts.dispatchEvent(new Event("loadingdone"));
  });
  await expect.poll(async()=>{
    return rect.evaluate((el:SVGRectElement)=>el.width.baseVal.value);
  },{timeout:3000}).not.toBe(widthAfterDocFonts);

  // Chapter change: listeners on the old section document are cleaned up
  const ch2Interval=map.intervals.find((i:any)=>i.paragraphId==="1:0");
  await open(page,book,ch2Interval);
  const ch2Rect=page.locator(".inline-reader .reader-viewport .sonder-follow rect").first();
  await expect(ch2Rect).toBeVisible();
  const ch2Before=await ch2Rect.evaluate((el:SVGRectElement)=>el.width.baseVal.value);

  // Changing letter-spacing in chapter 2 and dispatching loadingdone on chapter 2 re-measures
  await textFrame(page.locator(".inline-reader")).evaluate((iframe:HTMLIFrameElement)=>{
    iframe.contentDocument!.body.style.letterSpacing="8px";
    iframe.contentDocument!.fonts.dispatchEvent(new Event("loadingdone"));
  });
  await expect.poll(async()=>{
    return ch2Rect.evaluate((el:SVGRectElement)=>el.width.baseVal.value);
  },{timeout:3000}).not.toBe(ch2Before);
 });
});

