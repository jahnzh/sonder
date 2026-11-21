// @projects firefox, mobile-chrome, mobile-firefox, mobile-safari, webkit-iphone-now-playing, mobile-iphone-slice14, prepared-view
import {test,expect,type Page} from "@playwright/test";
import JSZip from "jszip";
import { gotoRead } from "./read-face";
import {textFrame} from "./reader-view";
import {onPreparedView} from "./prepared-view";
// The reader torn down while epub.js is still opening its book (#427). Destroying an epub.js book whose
// navigation or opening is still pending made epub.js's own later callbacks throw page errors such as
// "Cannot read properties of undefined (reading 'navigation')", "(reading 'package')" or "(reading 'displayOptions')".
// A large book (about 12,000 sentences) keeps the opening window wide enough to land in. Switching the reading
// mode and crossing the 900 px breakpoint do not remount the reader, so only closing and reopening does here.
// The book is a standalone ebook: it has no library row and never becomes the player's book.
test.use({serviceWorkers:"block"});
test.setTimeout(240_000);
const CYCLES=10;
// A 30-chapter EPUB: 100 paragraphs of 4 sentences each per chapter, with a nav document.
async function largeEpub(title:string){
 const zip=new JSZip();
 zip.file("mimetype","application/epub+zip",{compression:"STORE"});
 zip.file("META-INF/container.xml",'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
 const chapters=Array.from({length:30},(_,i)=>i);
 zip.file("OEBPS/content.opf",`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">sonder-teardown-${title.replace(/\W+/g,"-")}</dc:identifier><dc:title>${title}</dc:title><dc:creator>Reader QA</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-11-15T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map(i=>`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map(i=>`<itemref idref="c${i}"/>`).join("")}</spine></package>`);
 zip.file("OEBPS/nav.xhtml",`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map(i=>`<li><a href="c${i}.xhtml">Chapter ${i+1}</a></li>`).join("")}</ol></nav></body></html>`);
 for(const i of chapters){
  const paragraphs=Array.from({length:100},(_,p)=>`<p>Chapter ${i+1} paragraph ${p+1} opens with a plain sentence. The second sentence of paragraph ${p+1} adds a few more words. A third sentence keeps the reader company for a while. The fourth sentence closes paragraph ${p+1} of chapter ${i+1}.</p>`).join("");
  zip.file(`OEBPS/c${i}.xhtml`,`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i+1}</title></head><body><h1>Chapter ${i+1}</h1>${paragraphs}</body></html>`);
 }
 return zip.generateAsync({type:"nodebuffer"});
}
async function importLarge(page:Page,title:string){
 const uploaded=await page.request.post("/api/ebooks/import",{multipart:{file:{name:`${title}.epub`,mimeType:"application/epub+zip",buffer:await largeEpub(title)}}});
 expect(uploaded.ok()).toBe(true);
 const {id}=await uploaded.json();
 const manifest=await(await page.request.get(`/api/reader/${id}`)).json();
 expect(manifest.sections.flatMap((section:any)=>section.paragraphs).length).toBeGreaterThan(11000);
 return id as string;
}
function recordErrors(page:Page){
 const errors:string[]=[];
 page.on("pageerror",error=>errors.push(`${error.message} @ ${(error.stack||"").split("\n").slice(1,3).map(line=>line.trim()).join(" < ")}`));
 return errors;
}
const reader=(page:Page)=>page.getByRole("dialog", { name: "Now playing", exact: true });
const pages=(page:Page)=>textFrame(reader(page));
// The reader's manifest has arrived, so the next render starts opening the EPUB.
// (On the new view, #802, the reader's own data is its saved state; the prepared text opens next.)
const manifestLoaded=(page:Page,id:string)=>page.waitForResponse(response=>response.url().endsWith(`/api/reader/${encodeURIComponent(id)}${onPreparedView()?"/state":""}`)&&response.request().method()==="GET");
// Each cycle tears the reader down a little later into the opening (0 to 360 ms after its manifest arrived),
// sweeping the window where epub.js is still loading the book. On main, 62 of 200 such cycles threw.
const delay=(cycle:number)=>cycle*40;
async function settle(page:Page){
 await expect(pages(page)).toBeVisible({timeout:60_000});
 // epub.js callbacks of a destroyed book run after its view is gone; give them time to fire.
 await page.waitForTimeout(1500);
}

test("closing and reopening the reader while a large book opens throws no page error, 10 times",async({page},testInfo)=>{
 const id=await importLarge(page,`Teardown reopen ${testInfo.repeatEachIndex}`);
 const errors=recordErrors(page);
 const perCycle:number[]=[];
 for(let cycle=0;cycle<CYCLES;cycle++){
  const before=errors.length;
  const loaded=manifestLoaded(page,id);
  if(cycle===0)await gotoRead(page, id);
  else await gotoRead(page, id, "hash");
  await loaded;
  await page.waitForTimeout(delay(cycle));
  // Closing unmounts the reader; opening it again mounts a new one.
  await page.evaluate(()=>{location.hash="#library";});
  await expect(reader(page)).toBeHidden();
  await gotoRead(page, id, "hash");
  await settle(page);
  await page.evaluate(()=>{location.hash="#library";});
  await expect(reader(page)).toBeHidden();
  perCycle.push(errors.length-before);
 }
 console.log(`[teardown] reopen run ${testInfo.repeatEachIndex}: errors per cycle ${perCycle.join(",")} :: ${[...new Set(errors)].join(" | ")}`);
 expect(errors).toEqual([]);
});
