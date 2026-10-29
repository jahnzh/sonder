import {test,expect,type Page,type Locator} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
// The EPUB frame allows scripts so that WebKit (Safari, iOS) runs the reader's own listeners on the page:
// without allow-scripts it runs none of them (#37). EPUB content itself must still never run script.
// Both checks run in Chromium, Firefox and WebKit.
async function openReader(page:Page,title:string,script=false){
 const audio=await page.request.post("/api/import",{multipart:{title,author:"Frame QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(audio.ok()).toBe(true);
 const audioId=(await audio.json()).id;
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===audioId);
 const upload=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Frame.epub",mimeType:"application/epub+zip",buffer:await readerFixture({script})}}});
 expect(upload.ok()).toBe(true);
 const id=(await upload.json()).id;
 await page.goto(`/#reader/${id}`);
 await expect(page.getByRole("dialog",{name:"Reader"})).toBeVisible();
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
 const expected={sandbox:"allow-same-origin allow-scripts",csp:"default-src 'none'; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:",leftovers:0,ran:false};
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
