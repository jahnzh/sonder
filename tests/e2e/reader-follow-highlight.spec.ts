import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
test.afterEach(async({page})=>{await page.unrouteAll({behavior:"wait"});});
// Chapter one: counted blocks inside <nav> and text inside <svg> before the narrated text (#69).
const navChapter=`<nav epub:type="landmarks" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li>Skip to the story</li><li>Notes on this edition</li></ol></nav>`+
 `<p><svg xmlns="http://www.w3.org/2000/svg" width="40" height="12"><text x="0" y="10">Ornament</text></svg></p>`+
 `<p>The first paragraph opens here. It carries a second sentence. A third sentence closes it.</p>`+
 `<p>The second paragraph begins now. Its middle sentence follows quickly. The last sentence ends the block.</p>`;
// Chapter two: leading whitespace, runs of spaces, characters NFKC changes, inline markup and <noscript>.
const textChapter=`<p>\n      Leading whitespace opens this block.   Then   spaced   words   follow here.\n   </p>`+
 `<p>The ﬁrst ligature sentence ﬁnds its place. A full width ＡＢＣ sentence comes next. A non&#160;breaking space ends it.</p>`+
 `<p>Plain <em>emphasis</em> starts this one. A <span>span</span> sits in the second sentence.</p>`+
 `<noscript><p>Hidden fallback paragraph.</p></noscript>`+
 `<p>After the code block comes this sentence. Then one more sentence ends the chapter.</p>`;
async function fixture(page:Page,title:string){
 const response=await page.request.post("/api/import",{multipart:{title,author:"Reader QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Offsets.epub",mimeType:"application/epub+zip",buffer:await readerFixture({bodies:[navChapter,textChapter]})}}});
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
async function highlighted(page:Page){
 const follow=page.locator(".inline-reader .reader-viewport .sonder-follow");
 await expect(follow).toHaveAttribute("data-epubcfi",/^epubcfi\(/);
 if(!await page.evaluate(()=>"ePub" in window))await page.addScriptTag({path:"node_modules/epubjs/dist/epub.min.js"});
 const cfi=(await follow.getAttribute("data-epubcfi"))!;
 return page.locator(".inline-reader .reader-viewport iframe").evaluate((iframe:HTMLIFrameElement,cfi)=>
  new (window as any).ePub.CFI(cfi).toRange(iframe.contentDocument).toString().replace(/\s+/g," "),cfi);
}
async function open(page:Page,book:any,interval:any){
 // Leave the previous page first: it saves its own position as it unloads.
 await page.goto("about:blank");
 expect((await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position:interval.start+.5,duration:book.tracks[0].duration,updatedAt:Date.now()}})).ok()).toBe(true);
 await page.goto("/");
 await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
 await expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage",interval.paragraphId);
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
 await withReader(page,{mode,display:"book"},async()=>{
  const wrong=[];
  for(const interval of map.intervals){
   await open(page,book,interval);
   const narrated=(fragments.get(interval.paragraphId) as any).text,shown=(await highlighted(page)).normalize("NFKC").trim();
   if(shown!==narrated)wrong.push({paragraphId:interval.paragraphId,narrated,shown});

  }
  expect(wrong).toEqual([]);
 });
});
test("lyrics mode shows the narrated sentence as the current line in the same chapters",async({page})=>{
 const {book,map,manifest}=await fixture(page,"Highlight offsets Lyrics");
 const fragments=new Map(manifest.sections.flatMap((s:any)=>s.paragraphs.map((p:any)=>[p.id,p])));
 await withReader(page,{display:"segment"},async()=>{
  for(const interval of map.intervals){
   await open(page,book,interval);
   await expect(page.locator(".inline-reader .lyrics-line.current")).toHaveText((fragments.get(interval.paragraphId) as any).text);
  }
 });
});
test("long-press on a sentence's first letter listens from that sentence, not the one before",async({page})=>{
 await page.addInitScript(()=>{
  const time=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"currentTime")!;
  Object.defineProperty(HTMLMediaElement.prototype,"currentTime",{configurable:true,get(){return time.get!.call(this);},set(value){((window as any).__seeks||=[]).push(value);time.set!.call(this,value);}});
 });
 const {book,map}=await fixture(page,"Highlight offsets long-press");
 const second=map.intervals.find((interval:any)=>interval.paragraphId==="0:2");
 await withReader(page,{mode:"paginated",display:"book"},async()=>{
  await open(page,book,map.intervals[0]);
  await page.frameLocator(".inline-reader .reader-viewport iframe").getByText("It carries a second sentence.").waitFor();
  // The left edge of "It carries a second sentence.": a caret there sits right after the previous sentence's space.
  const point=await page.locator(".inline-reader .reader-viewport iframe").evaluate((iframe:HTMLIFrameElement)=>{
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
