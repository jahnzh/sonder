import {test,expect,type Page,type Locator} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
// The EPUB frame allows scripts so that WebKit (Safari, iOS) runs the reader's own listeners on the page:
// without allow-scripts it runs none of them (#37). EPUB content itself must still never run script.
// Both checks run in Chromium, Firefox and WebKit.
async function importBook(page:Page,title:string,script=false,variant?:"svg-root"|"iframe-root"|"nav-root"|"no-head"|"svg-asset"){
 const audio=await page.request.post("/api/import",{multipart:{title,author:"Frame QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(audio.ok()).toBe(true);
 const audioId=(await audio.json()).id;
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===audioId);
 const upload=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Frame.epub",mimeType:"application/epub+zip",buffer:await readerFixture({script,variant})}}});
 expect(upload.ok()).toBe(true);
 const id=(await upload.json()).id;
 await page.goto(`/#reader/${id}`);
 await expect(page.getByRole("dialog",{name:"Reader"})).toBeVisible();
 return id;
}
async function openReader(page:Page,title:string,script=false){
 const id=await importBook(page,title,script);
 const room=page.locator(".reader-room:not(.inline-reader)");
 const frame=page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
 await expect(frame.getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
 return {id,room,frame};
}
test("taps, page turns and long-press on the book page reach the reader",async({page})=>{
 const {id,room}=await openReader(page,"Frame gestures");
 const topbar=room.locator(".reader-topbar"),box=(await room.locator(".reader-viewport").boundingBox())!;
 await expect(topbar).toBeHidden();
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeVisible();
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeHidden();
 // A tap on the right edge turns the page, which saves a reading checkpoint.
 await page.mouse.click(box.x+box.width*0.9,box.y+box.height/2);
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${id}`)).json()).checkpoint?.revision||0).toBeGreaterThan(0);
 // Long-press listens from that sentence; without a narration map it asks for one.
 await page.mouse.move(box.x+box.width/2,box.y+box.height/3);
 await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
 await expect(page.getByText("Prepare a matching audiobook map for this passage first.")).toBeVisible();
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
test("EPUB scripts cannot run in the reader frame or reach the app",async({page})=>{
 const {room,frame}=await openReader(page,"Frame scripts",true);
 const viewport=room.locator(".reader-viewport");
 const expected={sandbox:"allow-same-origin allow-scripts",csp:"default-src 'none'; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:; frame-src 'none'; form-action 'none'; base-uri 'none'",leftovers:0,ran:false};
 // Activating the sanitised content runs nothing either.
 await frame.getByText("Inline handler",{exact:true}).evaluate((el:HTMLElement)=>el.click());
 await frame.getByText("Script link",{exact:true}).evaluate((el:HTMLElement)=>el.click());
 const first=await attack(viewport);
 expect(first.sections.length).toBeGreaterThan(0);
 for(const section of first.sections)expect(section).toEqual(expected);
 expect(first.parent).toBeUndefined();
 // A section loaded later is prepared the same way.
 await room.getByRole("button",{name:"Chapters",exact:true}).click();
 await page.getByRole("button",{name:"The Pool of Tears"}).click();
 await expect(frame.getByText("This is the beginning of the second chapter",{exact:false})).toBeVisible();
 const later=await attack(viewport);
 for(const section of later.sections)expect(section).toEqual(expected);
 expect(later.parent).toBeUndefined();
});

// A section whose root is not <html>, or that has no <head>, must not skip sanitising or the CSP. Each book's
// payload tries to run script and to remove the frame's own sandbox; a root the sanitiser cannot handle is
// refused and the section renders empty.
for(const variant of ["svg-root","iframe-root","nav-root"] as const){
 test(`a section with a ${variant.replace("-"," ")} is emptied and runs nothing`,async({page})=>{
  await importBook(page,`Frame ${variant}`,false,variant);
  const iframe=page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe");
  await expect(iframe.first()).toBeAttached();
  await page.waitForTimeout(1500);
  expect(await page.evaluate(()=>(window as any).__epubScriptExecuted)).toBeUndefined();
  for(const sandbox of await iframe.evaluateAll(frames=>frames.map(f=>f.getAttribute("sandbox"))))expect(sandbox).toBe("allow-same-origin allow-scripts");
  // Nothing from the book is left in the frame: no text, no script, no handler, no attribute but the namespace.
  expect(await iframe.first().evaluate((f:HTMLIFrameElement)=>{
   const doc=f.contentDocument!;
   return {text:(doc.body.textContent||"").trim(),risky:doc.querySelectorAll("script,[onload],[onerror],[onclick],[srcdoc]").length,attrs:[...doc.body.querySelectorAll("*")].flatMap(el=>[...el.attributes].map(a=>a.name)).filter(n=>!n.startsWith("xmlns"))};
  })).toEqual({text:"",risky:0,attrs:[]});
 });
}
test("a section without a head still gets the CSP first and runs nothing",async({page})=>{
 await importBook(page,"Frame no head",false,"no-head");
 const frame=page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
 await expect(frame.getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
 await page.waitForTimeout(1000);
 expect(await page.evaluate(()=>(window as any).__epubScriptExecuted)).toBeUndefined();
 const state=await page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe").first().evaluate((f:HTMLIFrameElement)=>({
  sandbox:f.getAttribute("sandbox"),
  csp:f.contentDocument!.head.firstElementChild?.getAttribute("http-equiv")==="Content-Security-Policy"?f.contentDocument!.head.firstElementChild!.getAttribute("content"):null,
 }));
 expect(state.sandbox).toBe("allow-same-origin allow-scripts");
 expect(state.csp).toContain("default-src 'none'");
 expect(state.csp).toContain("base-uri 'none'");
});

// epub.js turns book resources into blob: URLs on the app's origin after the content hook has run. An SVG that
// carries script must not get such a URL: navigating the frame to it would run the script as the app.
test("a book's SVG asset is a data: URL, so navigating the frame to it reaches nothing",async({page})=>{
 await importBook(page,"Frame svg asset",false,"svg-asset");
 const frame=page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
 await expect(frame.getByText("Alice was beginning to get very tired",{exact:false})).toBeVisible();
 const iframe=page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe").first();
 const seen=await iframe.evaluate((f:HTMLIFrameElement)=>{
  const doc=f.contentDocument!;
  const image=doc.querySelector("#svg-image") as HTMLImageElement|null,link=doc.querySelector("#svg-link") as HTMLAnchorElement|null;
  return {image:image?.getAttribute("src")?.slice(0,22),link:link?.getAttribute("href")?.slice(0,22),areas:doc.querySelectorAll("area,map").length,width:image?.naturalWidth};
 });
 // The image still renders, from a data: URL; the image map is gone.
 expect(seen).toEqual({image:"data:image/svg+xml;bas",link:"data:image/svg+xml;bas",areas:0,width:20});
 // Navigate the frame to the link target the way a stray link or script would.
 await iframe.evaluate((f:HTMLIFrameElement)=>{f.contentWindow!.location.assign((f.contentDocument!.querySelector("#svg-link") as HTMLAnchorElement).href);});
 await page.waitForTimeout(1500);
 expect(await page.evaluate(()=>(window as any).__epubScriptExecuted)).toBeUndefined();
 expect(await iframe.getAttribute("sandbox")).toBe("allow-same-origin allow-scripts");
});
