import {test,expect,type Page,type Locator,type APIRequestContext} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
// Geometry regression checks for issues #1 (seek/heading alignment) and #2 (reader-first Now Playing).
const sizes=[[360,740],[390,844],[430,932],[1280,800]] as const;
const centre=async(l:Locator)=>{const b=(await l.boundingBox())!;return {x:b.x+b.width/2,y:b.y+b.height/2,box:b};};
async function importBook(request:APIRequestContext,title:string,withEbook:boolean){
 const response=await request.post("/api/import",{multipart:{title,author:"Layout QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 if(!withEbook)return;
 const id=(await response.json()).id;
 const book=(await(await request.get("/api/books")).json()).find((b:any)=>b.id===id);
 expect((await request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Companion.epub",mimeType:"application/epub+zip",buffer:await readerFixture({})}}})).ok()).toBe(true);
}
async function open(page:Page,browserName:string,title:string,[width,height]:readonly [number,number]){
 await page.setViewportSize({width,height});
 await page.goto("/");
 await page.getByRole("button",{name:`Play ${title}`,exact:true}).click();
 // Headless Firefox/WebKit may refuse to start audio; the layout only needs the book loaded and paused.
 const dock=page.locator(".player-dock");
 await expect(dock.locator(".dock-book")).toContainText(title);
 if(browserName==="chromium")await dock.getByRole("button",{name:"Pause",exact:true}).click();
 else await expect(async()=>{
  const pause=dock.getByRole("button",{name:"Pause",exact:true}),play=dock.getByRole("button",{name:"Play",exact:true});
  if(await pause.isVisible())await pause.click({timeout:1000});
  await expect(play).toBeVisible({timeout:1000});
  await page.waitForTimeout(500);
  await expect(play).toBeVisible({timeout:100});
 }).toPass({timeout:20000});
 await expect(dock.getByRole("button",{name:"Play",exact:true})).toBeVisible();
 await page.mouse.move(0,0);
 await checkTransport(page,page.locator(".player-dock .transport"));
 await page.locator(".dock-book").click();
 const dialog=page.getByRole("dialog",{name:"Now playing",exact:true});
 await expect(dialog).toBeVisible();
 // Let the open animation (scale/translate) finish before measuring.
 await expect.poll(()=>dialog.evaluate(el=>el.getAnimations().length)).toBe(0);
 return dialog;
}
async function checkTransport(page:Page,transport:Locator){
 await transport.scrollIntoViewIfNeeded();
 const {width,height}=page.viewportSize()!;
 const rewind=transport.getByRole("button",{name:"Rewind 30 seconds",exact:true}),forward=transport.getByRole("button",{name:"Forward 30 seconds",exact:true});
 const play=await centre(transport.getByRole("button",{name:/^(Play|Pause)$/}));
 const seeks=[];
 for(const button of [rewind,forward]){
  const b=await centre(button),icon=await centre(button.locator("svg")),label=await centre(button.locator("span"));
  expect(b.box.width).toBeGreaterThanOrEqual(44);expect(b.box.height).toBeGreaterThanOrEqual(44);
  // The "30" sits in the middle of the arrow, and the arrow in the middle of the button.
  for(const axis of ["x","y"] as const){
   expect(Math.abs(label[axis]-icon[axis])).toBeLessThanOrEqual(1);
   expect(Math.abs(icon[axis]-b[axis])).toBeLessThanOrEqual(1);
  }
  // Seek and play buttons share one horizontal axis.
  expect(Math.abs(b.y-play.y)).toBeLessThanOrEqual(1);
  expect(b.box.x).toBeGreaterThanOrEqual(0);expect(b.box.x+b.box.width).toBeLessThanOrEqual(width);
  expect(b.box.y).toBeGreaterThanOrEqual(0);expect(b.box.y+b.box.height).toBeLessThanOrEqual(height);
  seeks.push(b);
 }
 expect(Math.abs((play.x-seeks[0].x)-(seeks[1].x-play.x))).toBeLessThanOrEqual(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
}
async function checkTimeline(dialog:Locator,transport:Locator){
 const slider=await centre(dialog.getByRole("slider",{name:"Seek in audiobook",exact:true}));
 const row=await centre(transport);
 // Seek bar and transport row are centred on the same vertical line.
 expect(Math.abs(slider.x-row.x)).toBeLessThanOrEqual(1);
 expect(slider.box.y+slider.box.height).toBeLessThanOrEqual(row.box.y+1);
}
test.beforeAll(async({request})=>{
 // One import per spec run; the browser server keeps its temp library for the whole run.
 const books=await(await request.get("/api/books")).json();
 if(!books.some((b:any)=>b.title==="Layout plain"))await importBook(request,"Layout plain",false);
 if(!books.some((b:any)=>b.title==="Layout reader"))await importBook(request,"Layout reader",true);
});
for(const size of sizes){
 test(`Now Playing without an ebook is aligned at ${size[0]}px`,async({page,browserName})=>{
  const dialog=await open(page,browserName,"Layout plain",size);
  const transport=dialog.locator(".transport.large");
  await checkTransport(page,transport);
  await checkTimeline(dialog,transport);
  const close=await centre(dialog.getByRole("button",{name:"Close dialog",exact:true}));
  expect(close.box.x+close.box.width).toBeLessThanOrEqual(size[0]);
  expect(Math.abs((await centre(dialog.getByRole("heading",{name:"Now playing",exact:true}))).y-close.y)).toBeLessThanOrEqual(1);
 });
 test(`reader-first Now Playing is aligned at ${size[0]}px`,async({page,browserName})=>{
  const [width,height]=size;
  const dialog=await open(page,browserName,"Layout reader",size);
  await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible();
  const transport=dialog.locator(".transport.large");
  await checkTransport(page,transport);
  await checkTimeline(dialog,transport);
  // Book title, options trigger and close button share the heading row.
  const close=await centre(dialog.getByRole("button",{name:"Close dialog",exact:true}));
  const trigger=await centre(dialog.getByRole("button",{name:"Playback options",exact:true}));
  const title=await centre(dialog.locator(".now-playing-heading-title"));
  expect(Math.abs(trigger.y-close.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(title.y-close.y)).toBeLessThanOrEqual(1);
  expect(title.box.x+title.box.width).toBeLessThanOrEqual(trigger.box.x);
  expect(close.box.x+close.box.width).toBeLessThanOrEqual(width);
  // The whole surface fits the viewport without scrolling, and the text dominates it.
  const box=(await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(height);
  expect((await page.locator(".reader-viewport").boundingBox())!.height).toBeGreaterThan(height*.6);
  const surface=await dialog.evaluate(el=>getComputedStyle(el).backgroundColor);
  await expect(page.frameLocator(".reader-viewport iframe").locator("body")).toHaveCSS("background-color",surface);
  // Secondary controls are in the options sheet, not on the reading surface.
  for(const name of ["Title page","Versions & sources"])await expect(dialog.getByRole("button",{name,exact:true})).toBeHidden();
  await dialog.getByRole("button",{name:"Playback options",exact:true}).click();
  const panel=page.getByRole("region",{name:"Playback options",exact:true});
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button",{name:"Versions & sources",exact:true})).toBeVisible();
  const sheet=(await panel.boundingBox())!;
  expect(sheet.x).toBeGreaterThanOrEqual(0);expect(sheet.x+sheet.width).toBeLessThanOrEqual(width);
  expect(sheet.y+sheet.height).toBeLessThanOrEqual(height);
  expect(await panel.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(0);
  const heading=await centre(panel.getByRole("heading",{name:"Playback options",exact:true}));
  expect(Math.abs(heading.y-(await centre(panel.getByRole("button",{name:"Close playback options",exact:true}))).y)).toBeLessThanOrEqual(1);
  // Transport stays reachable below the sheet.
  expect(sheet.y+sheet.height).toBeLessThanOrEqual((await transport.boundingBox())!.y);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Playback options",exact:true})).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
 });
}
