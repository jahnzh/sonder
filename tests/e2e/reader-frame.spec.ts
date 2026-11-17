import {test,expect,type Page,type Locator} from "@playwright/test";
import {showControls} from "./reader-bands";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
// WebKit needs allow-scripts so the reader's own listeners run on the page (#37).
// EPUB content itself must still never run script. These checks run in all three engines.
const sandboxFor=(browserName:string)=>browserName==="webkit" ? "allow-same-origin allow-scripts" : "allow-same-origin";
async function importBook(page:Page,title:string,script=false,variant?:"svg-root"|"iframe-root"|"nav-root"|"no-head"|"head-late"|"text-before-head"|"template-root"|"svg-asset",link=true,fixture?:Buffer){
 const audio=await page.request.post("/api/import",{multipart:{title,author:"Frame QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(audio.ok()).toBe(true);
 const audioId=(await audio.json()).id;
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===audioId);
 const upload=await page.request.post(`/api/ebooks/import${link ? `?workId=${book.workId}` : ""}`,{multipart:{file:{name:`${title}.epub`,mimeType:"application/epub+zip",buffer:fixture||await readerFixture({script,variant,title})}}});
 expect(upload.ok()).toBe(true);
 const id=(await upload.json()).id;
 await page.goto(`/#reader/${id}`);
 await expect(page.getByRole("dialog",{name:"Reader"})).toBeVisible();
 return id;
}
async function openReader(page:Page,title:string,script=false,link=true){
 const id=await importBook(page,title,script,undefined,link);
 const room=page.locator(".reader-room:not(.inline-reader)");
 const frame=page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
 await expect(frame.getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
 return {id,room,frame};
}
// Find a line of actual text in the visible part of the current EPUB page. The
// iframe can move or repaginate after the viewport was measured for a tap.
async function visibleSentencePoint(viewport:Locator){
 return viewport.evaluate(host=>{
  const bounds=host.getBoundingClientRect();
  for(const frame of host.querySelectorAll("iframe")){
   const doc=frame.contentDocument,frameBounds=frame.getBoundingClientRect();
   if(!doc || doc.fonts.status!=="loaded")continue;
   for(const paragraph of doc.querySelectorAll("p")){
    const range=doc.createRange();range.selectNodeContents(paragraph);
    for(const rect of range.getClientRects()){
     const left=Math.max(bounds.left,frameBounds.left,frameBounds.left+rect.left,0);
     const right=Math.min(bounds.right,frameBounds.right,frameBounds.left+rect.right,window.innerWidth);
     const top=Math.max(bounds.top,frameBounds.top,frameBounds.top+rect.top,0);
     const bottom=Math.min(bounds.bottom,frameBounds.bottom,frameBounds.top+rect.bottom,window.innerHeight);
     if(right-left<4 || bottom-top<4)continue;
     const x=(left+right)/2,y=(top+bottom)/2;
     const element=doc.elementFromPoint(x-frameBounds.left,y-frameBounds.top);
     if(document.elementFromPoint(x,y)===frame && element && paragraph.contains(element))return {x,y};
    }
   }
  }
  return null;
 });
}
async function longPressSentence(page:Page,viewport:Locator){
 const state:{previous:{x:number,y:number}|null;point:{x:number,y:number}|null}={previous:null,point:null};
 // Wait until the current text line is stable, then press exactly once.
 await expect.poll(async()=>{
  const point=await visibleSentencePoint(viewport),previous=state.previous;
  state.previous=point;
  if(point && previous && Math.abs(point.x-previous.x)<0.5 && Math.abs(point.y-previous.y)<0.5){state.point=point;return true;}
  return false;
 }).toBe(true);
 if(!state.point)throw new Error("No stable visible sentence in the reader");
 await page.mouse.move(state.point.x,state.point.y);
 await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
}
// Without a matching map the long-press says so in the foot's row, as an error (#591, spec #586 "Messages in the foot").
async function expectNoMapInFoot(room:Locator){
 await expect(room.locator(".reader-player .reader-message").getByRole("alert")).toHaveText("Prepare a matching audiobook map for this passage first.");
}
async function expectNoAlignment(page:Page,id:string){
 const response=await page.request.get(`/api/alignments?ebookId=${id}`);
 expect(response.ok()).toBe(true);
 expect((await response.json()).jobs).toEqual([]);
}
test("the reader frame only permits scripts when the engine needs them",async({page,browserName})=>{
 const {room}=await openReader(page,"Frame sandbox");
 const frames=room.locator(".reader-viewport iframe");
 await expect(frames.first()).toHaveAttribute("sandbox",sandboxFor(browserName));
 for(const sandbox of await frames.evaluateAll(els=>els.map(el=>el.getAttribute("sandbox"))))expect(sandbox).toBe(sandboxFor(browserName));
});
test("taps, page turns and long-press on the book page reach the reader",async({page,browserName},testInfo)=>{
 const {id,room}=await openReader(page,`Frame gestures ${browserName} ${testInfo.repeatEachIndex}`,false,false);
 await expectNoAlignment(page,id);
 await expect(room.locator(".reader-viewport iframe").first()).toHaveAttribute("sandbox",sandboxFor(browserName));
 const topbar=room.locator(".reader-topbar"),box=(await room.locator(".reader-viewport").boundingBox())!;
 await expect(topbar).toBeHidden();
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeVisible();
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeHidden();
 // A tap on the right edge turns the page, which saves a reading checkpoint.
 const revision=(await(await page.request.get(`/api/reader/${id}`)).json()).checkpoint?.revision||0;
 await page.mouse.click(box.x+box.width*0.9,box.y+box.height/2);
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${id}`)).json()).checkpoint?.revision||0).toBeGreaterThan(revision);
 // Long-press listens from that sentence; without a narration map it asks for one.
 await longPressSentence(page,room.locator(".reader-viewport"));
 await expectNoMapInFoot(room);
});
// A page busy as the finger lifts (epub.js laying out, a highlight redrawn) runs pointerup late: the tap is still a
// tap, timed by its events, not dropped or taken for a long press that listens from the sentence (#589).
test("a short tap shows the controls while the page is busy as the finger lifts",async({page,browserName},testInfo)=>{
 // Firefox's driver sends the button's release only once the page has handled the press, so the release is stamped
 // after the 700 ms too: there the tap below is a real 700 ms hold and cannot stand for a short one.
 test.skip(browserName==="firefox","the driver stamps the release after the busy press, a 700 ms hold");
 const {id,room}=await openReader(page,`Frame busy tap ${browserName} ${testInfo.repeatEachIndex}`,false,false);
 await expectNoAlignment(page,id);
 const topbar=room.locator(".reader-topbar"),box=(await room.locator(".reader-viewport").boundingBox())!;
 await expect(topbar).toBeHidden();
 // After the reader's own pointerdown listener, the page is held for 700 ms, past the 550 of a long press. The
 // listener comes from the app's window, as the reader's do: the book's frame itself runs no script.
 const blocked=await room.locator(".reader-viewport").evaluate(host=>{
  const frames=[...host.querySelectorAll("iframe")].filter(frame=>frame.contentDocument);
  for(const frame of frames)frame.contentDocument!.addEventListener("pointerdown",()=>{const until=Date.now()+700;while(Date.now()<until);},{once:true});
  return frames.length;
 });
 expect(blocked).toBeGreaterThan(0);
 const started=Date.now();
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeVisible();
 expect(Date.now()-started).toBeGreaterThanOrEqual(700);
 // Not a long press: it would have asked for a narration map for this book without one.
 await page.waitForTimeout(300);
 await expect(page.getByText("Prepare a matching audiobook map for this passage first.")).toHaveCount(0);
});
test("long-press reaches a sentence after the reader is resized",async({page,browserName},testInfo)=>{
 const {id,room}=await openReader(page,`Frame resize ${browserName} ${testInfo.repeatEachIndex}`,false,false);
 await expectNoAlignment(page,id);
 const viewport=room.locator(".reader-viewport"),box=(await viewport.boundingBox())!;
 await page.mouse.click(box.x+box.width*0.9,box.y+box.height/2);
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${id}`)).json()).checkpoint?.revision||0).toBeGreaterThan(0);
 await page.setViewportSize({width:390,height:300});
 await expect.poll(async()=>(await viewport.boundingBox())?.height||0).toBeLessThan(box.height-100);
 const resized=(await viewport.boundingBox())!;
 // The old long-press point is now below the book page, over the player.
 expect(box.y+box.height/3).toBeGreaterThan(resized.y+resized.height);
 await longPressSentence(page,viewport);
 await expectNoMapInFoot(room);
});
test("a no-map long-press stays isolated from an already prepared ebook",async({page,browserName},testInfo)=>{
 const suffix=`${browserName} ${testInfo.repeatEachIndex}`;
 const seedTitle=`Frame prepared ${suffix}`,fixture=await readerFixture({title:seedTitle});
 const seeded=await importBook(page,seedTitle,false,undefined,true,fixture);
 const manifest=await(await page.request.get(`/api/reader/${seeded}`)).json();
 const book=(await(await page.request.get("/api/books")).json()).find((value:any)=>value.workId===manifest.workId);
 const created=await page.request.post("/api/alignments",{data:{ebookId:seeded,recordingId:book.recordingId,pairings:manifest.sections.map((section:any)=>({section:section.index,trackId:book.tracks[0].id,start:section.index*100,duration:95}))}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments?ebookId=${seeded}`)).json()).jobs[0]?.intervals.length||0,{timeout:15000}).toBeGreaterThan(0);
 // The server really does reuse the saved EPUB and its map for identical bytes.
 const duplicate=await page.request.post("/api/ebooks/import",{multipart:{file:{name:`${seedTitle}.epub`,mimeType:"application/epub+zip",buffer:fixture}}});
 expect(duplicate.ok()).toBe(true);
 expect(await duplicate.json()).toEqual({id:seeded,alreadySaved:true});
 const {id,room}=await openReader(page,`Frame isolated ${suffix}`,false,false);
 expect(id).not.toBe(seeded);
 await expectNoAlignment(page,id);
 await longPressSentence(page,room.locator(".reader-viewport"));
 await expectNoMapInFoot(room);
});
// Every section document starts with the CSP and has no script left; scripts, inline handlers and a
// javascript: link added after sanitising are refused too, so nothing reaches the frame's or the app's window.
const attack=(viewport:Locator)=>viewport.evaluate(async(host)=>{
 const run="window.__frameScript=true;parent.__epubScriptExecuted=true";
 const results=[];
 for(const iframe of host.querySelectorAll("iframe")){
  const doc=iframe.contentDocument!,first=doc.head.firstElementChild;
  const section={
   sandbox:iframe.getAttribute("sandbox"),
   csp:first?.matches('meta[http-equiv="Content-Security-Policy"]') ? first.getAttribute("content") : null,
   leftovers:doc.querySelectorAll("script,iframe,object,embed,svg,[onclick],[onerror],[onload],a[href^='javascript:' i]").length,
  };
  const script=doc.createElement("script");script.textContent=run;doc.body.append(script);
  const image=doc.createElement("img");image.setAttribute("onerror",run);image.src="data:,broken";doc.body.append(image);
  const handler=doc.createElement("span");handler.setAttribute("onclick",run);doc.body.append(handler);handler.click();
  const link=doc.createElement("a");link.href="javascript:void(window.__frameScript=true,parent.__epubScriptExecuted=true)";doc.body.append(link);link.click();
  await new Promise(resolve=>setTimeout(resolve,500));
  results.push({...section,ran:!!(iframe.contentWindow as any).__frameScript});
 }
 return {sections:results,parent:(window as any).__epubScriptExecuted};
});
test("EPUB scripts cannot run in the reader frame or reach the app",async({page,browserName})=>{
 const {room,frame}=await openReader(page,"Frame scripts",true);
 const viewport=room.locator(".reader-viewport");
 const expected={sandbox:sandboxFor(browserName),csp:"default-src 'none'; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:; frame-src 'none'; form-action 'none'; base-uri 'none'",leftovers:0,ran:false};
 // Activating the sanitised content runs nothing either.
 await frame.getByText("Inline handler",{exact:true}).evaluate((el:HTMLElement)=>el.click());
 await frame.getByText("Script link",{exact:true}).evaluate((el:HTMLElement)=>el.click());
 const first=await attack(viewport);
 expect(first.sections.length).toBeGreaterThan(0);
 for(const section of first.sections)expect(section).toEqual(expected);
 expect(first.parent).toBeUndefined();
 // A section loaded later is prepared the same way.
 await showControls(page,room);
 await room.getByRole("button",{name:"Chapters",exact:true}).click();
 await page.getByRole("button",{name:"The Pool of Tears"}).click();
 await expect(frame.getByText("This is the beginning of the second chapter",{exact:false})).toBeVisible();
 const later=await attack(viewport);
 for(const section of later.sections)expect(section).toEqual(expected);
 expect(later.parent).toBeUndefined();
});

test("a failed event probe enables scripts while the content defences still block them",async({page,browserName})=>{
 test.skip(browserName!=="chromium","WebKit and Firefox exercise their native sandbox in the other tests");
 // Stop the probe's synthetic pointer events bubbling to its document, as in WebKit's blocked-listener case.
 await page.addInitScript(()=>{
  const OriginalPointerEvent=window.PointerEvent;
  Object.defineProperty(window,"PointerEvent",{configurable:true,value:class extends OriginalPointerEvent{
   constructor(type:string,options?:PointerEventInit){super(type,{...options,bubbles:false});}
  }});
 });
 const {room}=await openReader(page,"Frame failed probe",true);
 const result=await attack(room.locator(".reader-viewport"));
 expect(result.sections.length).toBeGreaterThan(0);
 for(const section of result.sections){
  expect(section.sandbox).toBe("allow-same-origin allow-scripts");
  expect(section.csp).toContain("default-src 'none'");
  expect(section.leftovers).toBe(0);
  expect(section.ran).toBe(false);
 }
 expect(result.parent).toBeUndefined();
});

// A section whose root is not <html>, or that has no <head>, must not skip sanitising or the CSP. Each book's
// payload tries to run script and to remove the frame's own sandbox; a root the sanitiser cannot handle is
// refused and the section renders empty.
for(const variant of ["svg-root","iframe-root","nav-root","template-root"] as const){
 test(`a section with a ${variant.replace("-"," ")} is emptied and runs nothing`,async({page,browserName})=>{
  const leaks:string[]=[];page.on("response",r=>{if(r.url().includes("/leak"))leaks.push(r.url())});
  await importBook(page,`Frame ${variant}`,false,variant);
  const iframe=page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe");
  await expect(iframe.first()).toBeAttached();
  await page.waitForTimeout(1500);
  expect(await page.evaluate(()=>(window as any).__epubScriptExecuted)).toBeUndefined();
  expect(leaks).toEqual([]);
  for(const sandbox of await iframe.evaluateAll(frames=>frames.map(f=>f.getAttribute("sandbox"))))expect(sandbox).toBe(sandboxFor(browserName));
  // Nothing from the book is left in the frame: no text, no script, no handler, no attribute but the namespace.
  expect(await iframe.first().evaluate((f:HTMLIFrameElement)=>{
   const doc=f.contentDocument!;
   return {text:(doc.body.textContent||"").trim(),risky:doc.querySelectorAll("script,[onload],[onerror],[onclick],[srcdoc]").length,templates:[...doc.querySelectorAll("template")].reduce((n,el)=>n+(el as HTMLTemplateElement).content.childNodes.length,0),attrs:[...doc.body.querySelectorAll("*")].flatMap(el=>[...el.attributes].map(a=>a.name)).filter(n=>!n.startsWith("xmlns"))};
  })).toEqual({text:"",risky:0,templates:0,attrs:[]});
 });
}
test("a section without a head still gets the CSP first and runs nothing",async({page,browserName})=>{
 await importBook(page,"Frame no head",false,"no-head");
 const frame=page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
 await expect(frame.getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
 await page.waitForTimeout(1000);
 expect(await page.evaluate(()=>(window as any).__epubScriptExecuted)).toBeUndefined();
 const state=await page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe").first().evaluate((f:HTMLIFrameElement)=>({
  sandbox:f.getAttribute("sandbox"),
  csp:f.contentDocument!.head.firstElementChild?.getAttribute("http-equiv")==="Content-Security-Policy"?f.contentDocument!.head.firstElementChild!.getAttribute("content"):null,
 }));
 expect(state.sandbox).toBe(sandboxFor(browserName));
 expect(state.csp).toContain("default-src 'none'");
 expect(state.csp).toContain("base-uri 'none'");
});

// epub.js turns book resources into blob: URLs on the app's origin after the content hook has run. An SVG that
// carries script must not get such a URL: navigating the frame to it would run the script as the app.
test("a book's SVG asset is a data: URL, so navigating the frame to it reaches nothing",async({page,browserName})=>{
 await importBook(page,"Frame svg asset",false,"svg-asset");
 const frame=page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
 await expect(frame.getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
 const iframe=page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe").first();
 const seen=await iframe.evaluate((f:HTMLIFrameElement)=>{
  const doc=f.contentDocument!;
  const image=doc.querySelector("#svg-image") as HTMLImageElement|null,link=doc.querySelector("#svg-link") as HTMLAnchorElement|null,ext=doc.querySelector("#ext-link") as HTMLAnchorElement|null;
  return {image:image?.getAttribute("src")?.slice(0,22),link:link?.getAttribute("href")?.slice(0,22),ext:ext?.getAttribute("href")?.slice(0,5),areas:doc.querySelectorAll("area,map").length,width:image?.naturalWidth};
 });
 // The image still renders, from a data: URL; the image map is gone.
 // "ext.png?.html" looks like a png before the "?" but epub.js types it by its last dot segment: html.
 expect(seen).toEqual({image:"data:image/svg+xml;bas",link:"data:image/svg+xml;bas",ext:"data:",areas:0,width:20});
 // Navigate the frame to the link target the way a stray link or script would.
 await iframe.evaluate((f:HTMLIFrameElement)=>{f.contentWindow!.location.assign((f.contentDocument!.querySelector("#svg-link") as HTMLAnchorElement).href);});
 await page.waitForTimeout(1500);
 expect(await page.evaluate(()=>(window as any).__epubScriptExecuted)).toBeUndefined();
 expect(await iframe.getAttribute("sandbox")).toBe(sandboxFor(browserName));
});

// Content before <head> makes the HTML parser move the head, CSP meta included, into <body>, where browsers
// ignore it. The head must come first, so the CSP is in force and the remote URLs in srcset and CSS stay blocked.
test("a section with content before its head still has the CSP in the head",async({page})=>{
 const leaks:string[]=[];page.on("response",r=>{if(r.url().includes("/leak"))leaks.push(r.url())});
 await importBook(page,"Frame late head",false,"head-late");
 const frame=page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
 await expect(frame.getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
 await page.waitForTimeout(1000);
 const csp=await page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe").first().evaluate((f:HTMLIFrameElement)=>{
  const doc=f.contentDocument!,meta=doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  // A bare character before <head> also makes the parser move the head into <body>, so the meta must be
  // inside the head the frame parsed, not merely the first element of the head in the source tree.
  return {parent:meta?.parentElement?.tagName,first:doc.head.firstElementChild===meta,inHead:doc.head.contains(meta),srcset:doc.querySelectorAll("[srcset]").length};
 });
 // srcset is removed outright: Firefox fetches its candidates even when the CSP is in force.
 expect(csp).toEqual({parent:"HEAD",first:true,inHead:true,srcset:0});
 expect(leaks).toEqual([]);
 expect(await page.evaluate(()=>(window as any).__epubScriptExecuted)).toBeUndefined();
});

// One non-whitespace character before <head> is enough for the HTML parser to move the head, CSP meta
// included, into <body>: a first-element check passes while the meta silently stops applying.
test("a section with a character before its head still has the CSP in the head",async({page})=>{
 const leaks:string[]=[];page.on("response",r=>{if(r.url().includes("/leak"))leaks.push(r.url())});
 await importBook(page,"Frame text head",false,"text-before-head");
 const frame=page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
 await expect(frame.getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
 await page.waitForTimeout(1000);
 const csp=await page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe").first().evaluate((f:HTMLIFrameElement)=>{
  const doc=f.contentDocument!,meta=doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return {parent:meta?.parentElement?.tagName,first:doc.head.firstElementChild===meta,inHead:doc.head.contains(meta),srcset:doc.querySelectorAll("[srcset]").length};
 });
 // srcset is removed outright: Firefox fetches its candidates even when the CSP is in force.
 expect(csp).toEqual({parent:"HEAD",first:true,inHead:true,srcset:0});
 expect(leaks).toEqual([]);
 expect(await page.evaluate(()=>(window as any).__epubScriptExecuted)).toBeUndefined();
});
// The server's app-level Content-Security-Policy (#76) is the layer behind the section CSP: a srcdoc frame inherits the
// embedding document's policy and a blob: document the creator's, so an inline script in either is refused even where the
// frame has no CSP meta of its own. The scripts set a flag on the app's window, so with CSP_MODE=off this test fails.
test("the app shell is served under the enforced policy",async({page})=>{
 const shell=await page.request.get("/");
 expect(shell.headers()["content-security-policy"]).toContain("script-src 'self';");
 expect(shell.headers()["content-security-policy-report-only"]).toBeUndefined();
});
test("an inline script in a srcdoc frame or a blob: document the page creates is blocked by the app policy",async({page,browserName})=>{
 await openReader(page,"App policy");
 const reports:string[]=[];
 page.on("request",request=>{if(request.url().endsWith("/api/csp-report"))reports.push(request.postData()||"");});
 const ran=await page.evaluate(async()=>{
  const w=window as any;
  const load=(frame:HTMLIFrameElement)=>new Promise<void>(resolve=>{frame.addEventListener("load",()=>resolve(),{once:true});document.body.append(frame);});
  const srcdoc=document.createElement("iframe");
  srcdoc.setAttribute("sandbox","allow-same-origin allow-scripts");
  srcdoc.srcdoc="<!doctype html><html><body><script>parent.__srcdocScript=true<\/script></body></html>";
  await load(srcdoc);
  const blob=document.createElement("iframe");
  blob.setAttribute("sandbox","allow-same-origin allow-scripts");
  blob.src=URL.createObjectURL(new Blob(["<!doctype html><html><body><script>parent.__blobScript=true<\/script></body></html>"],{type:"text/html"}));
  await load(blob);
  await new Promise(resolve=>setTimeout(resolve,500));
  return {srcdoc:!!w.__srcdocScript,blob:!!w.__blobScript,blobLoaded:blob.contentDocument?.body?.tagName==="BODY"};
 });
 // No inline script ran in either frame in any engine. WebKit does not expose a blob: frame's document to the page
 // (blobLoaded is false there) and its violation reports differ, so the loaded check and the reports are asserted in
 // Chromium and Firefox only; in WebKit the two flags staying false is the evidence.
 expect({srcdoc:ran.srcdoc,blob:ran.blob}).toEqual({srcdoc:false,blob:false});
 if(browserName!=="webkit"){
  expect(ran.blobLoaded).toBe(true);
  // The browser also reported both refusals to the server's endpoint.
  await expect.poll(()=>reports.filter(body=>/script-src/.test(body)).length).toBeGreaterThanOrEqual(2);
 }
});
