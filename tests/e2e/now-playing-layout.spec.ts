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
 expect((await request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Companion.epub",mimeType:"application/epub+zip",buffer:await readerFixture({language:"en-NZ"})}}})).ok()).toBe(true);
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
 const appearance=await(await request.get("/api/appearance")).json();
 await request.put("/api/appearance",{data:{...appearance,reader:{...appearance.reader,display:"book"}}});
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
  const transport=dialog.locator(".now-playing-transport .transport.large");
  await checkTransport(page,transport);
  await checkTimeline(dialog,transport);
  await expect(dialog.getByRole("button",{name:"Playback options",exact:true})).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Close dialog",exact:true})).toBeVisible();
  const timer=dialog.getByRole("button",{name:"Sleep timer",exact:true});
  const timerBox=await centre(timer), transportBox=await centre(transport);
  const forwardBox=(await transport.getByRole("button",{name:"Forward 30 seconds",exact:true}).boundingBox())!;
  expect(Math.abs(timerBox.y-transportBox.y)).toBeLessThanOrEqual(2);
  expect(timerBox.box.width).toBeGreaterThanOrEqual(44);
  expect(timerBox.box.x+timerBox.box.width).toBeLessThanOrEqual(width);
  expect(timerBox.box.x).toBeGreaterThanOrEqual(forwardBox.x+forwardBox.width);
  await timer.click();
  const minutes=dialog.getByRole("button",{name:"15 minutes",exact:true});
  await expect(minutes).toBeVisible();
  const menuBox=(await minutes.boundingBox())!;
  expect(menuBox.x).toBeGreaterThanOrEqual(0);expect(menuBox.x+menuBox.width).toBeLessThanOrEqual(width);
  await minutes.click();
  await expect(timer).toContainText("15m");
  await timer.click();
  await dialog.getByRole("button",{name:"Turn off",exact:true}).click();
  const box=(await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y+box.height).toBeLessThanOrEqual(height);
  expect((await page.locator(".inline-reader .reader-viewport").boundingBox())!.height).toBeGreaterThan(height*.6);
  const surface=await dialog.evaluate(el=>getComputedStyle(el).backgroundColor);
  await expect(page.frameLocator(".inline-reader .reader-viewport iframe").locator("body")).toHaveCSS("background-color",surface);
  if(width<900) await page.getByRole("button",{name:"Show reader controls"}).click();
  const controls=dialog.locator(".reader-page-actions");
  await expect(controls.getByRole("slider",{name:"Book progress"})).toBeVisible();
  for(const name of ["Contents","Back 30 seconds","Play reader audio","Forward 30 seconds","Bookmark this passage"]) {
    const button=controls.getByRole("button",{name,exact:true});
    await expect(button).toBeVisible();
    const rect=(await button.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x+rect.width).toBeLessThanOrEqual(width);
    expect(rect.y+rect.height).toBeLessThanOrEqual(height);
  }
  const lyrics=dialog.getByRole("button",{name:"Lyrics",exact:true});
  const rewind=dialog.locator(".now-playing-transport").getByRole("button",{name:"Rewind 30 seconds",exact:true});
  const lyricsBox=(await lyrics.boundingBox())!, rewindBox=(await rewind.boundingBox())!;
  expect(lyricsBox.x+lyricsBox.width).toBeLessThanOrEqual(rewindBox.x+1);
  expect(Math.abs((lyricsBox.y+lyricsBox.height/2)-(rewindBox.y+rewindBox.height/2))).toBeLessThanOrEqual(2);
  await expect(transport).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
  if(width>=900) await expect(page.getByLabel("Contents sidebar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
 });
}
