import {test,expect,type Page,type Locator,type APIRequestContext} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
import {skipOnMobile} from "./mobile";
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
 test(`Now Playing without an ebook is aligned at ${size[0]}px`,async({page,browserName,isMobile})=>{
  skipOnMobile(isMobile&&size[0]>=900,"desktop layout (min-width: 900px) is not reachable on a phone profile");
  const dialog=await open(page,browserName,"Layout plain",size);
  const transport=dialog.locator(".transport.large");
  await checkTransport(page,transport);
  await checkTimeline(dialog,transport);
  const close=await centre(dialog.getByRole("button",{name:"Close dialog",exact:true}));
  expect(close.box.x+close.box.width).toBeLessThanOrEqual(size[0]);
  expect(Math.abs((await centre(dialog.getByRole("heading",{name:"Now playing",exact:true}))).y-close.y)).toBeLessThanOrEqual(1);
 });
 test(`reader-first Now Playing is aligned at ${size[0]}px`,async({page,browserName,isMobile})=>{
  skipOnMobile(isMobile&&size[0]>=900,"desktop layout (min-width: 900px) is not reachable on a phone profile");
  const [width,height]=size;
  const dialog=await open(page,browserName,"Layout reader",size);
  await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible();
  // With an ebook, Now Playing is the full-screen reader with one player bar (#22).
  await expect(dialog.locator(".now-playing-transport")).toBeHidden();
  const player=dialog.getByRole("region",{name:"Player",exact:true});
  const back=player.getByRole("button",{name:"Back 30 seconds",exact:true}),forward=player.getByRole("button",{name:"Forward 30 seconds",exact:true});
  const play=await centre(player.getByRole("button",{name:/^(Play|Pause) narration$/}));
  const seeks=[];
  for(const button of [back,forward]){
   const b=await centre(button),icon=await centre(button.locator("svg")),label=await centre(button.locator("span"));
   expect(b.box.width).toBeGreaterThanOrEqual(44);expect(b.box.height).toBeGreaterThanOrEqual(44);
   for(const axis of ["x","y"] as const){
    expect(Math.abs(label[axis]-icon[axis])).toBeLessThanOrEqual(1);
    expect(Math.abs(icon[axis]-b[axis])).toBeLessThanOrEqual(1);
   }
   expect(Math.abs(b.y-play.y)).toBeLessThanOrEqual(1);
   seeks.push(b);
  }
  expect(Math.abs((play.x-seeks[0].x)-(seeks[1].x-play.x))).toBeLessThanOrEqual(1);
  const timer=player.getByRole("button",{name:"Sleep timer",exact:true});
  const timerBox=await centre(timer),forwardBox=(await forward.boundingBox())!;
  // Phones keep the timer on the transport row; desktop centres it in the footer.
  const bar=await centre(player);
  expect(Math.abs(timerBox.y-(width<900 ? play.y : bar.y))).toBeLessThanOrEqual(2);
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
  const surface=await page.locator(".inline-reader").evaluate(el=>getComputedStyle(el).backgroundColor);
  await expect(page.frameLocator(".inline-reader .reader-viewport iframe").locator("body")).toHaveCSS("background-color",surface);
  if(width<900){
   const viewport=(await page.locator(".inline-reader .reader-viewport").boundingBox())!;
   await page.mouse.click(viewport.x+viewport.width/2,viewport.y+viewport.height/2);
  }
  // The bar is the narration's position; the page follows it.
  await expect(player.getByRole("slider",{name:/^Seek in /})).toBeVisible();
  await expect(player.getByRole("slider",{name:"Position in book"})).toHaveCount(0);
  const names=["Close reader","Bookmark current sentence","Search this book","Reader appearance","More","Back 30 seconds","Play narration","Forward 30 seconds","Sleep timer"];
  if(width<900)names.push("Chapters");
  for(const name of names){
   const button=dialog.locator(".inline-reader").getByRole("button",{name,exact:true});
   await expect(button).toBeVisible();
   const rect=(await button.boundingBox())!;
   expect(rect.width).toBeGreaterThanOrEqual(44);
   expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x+rect.width).toBeLessThanOrEqual(width);
   expect(rect.y).toBeGreaterThanOrEqual(0); expect(rect.y+rect.height).toBeLessThanOrEqual(height);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
  if(width>=900) await expect(page.getByLabel("Contents sidebar")).toBeVisible();
  // A tap on the page leaves focus in the EPUB frame; Escape works from the reader's own controls.
  await dialog.locator(".inline-reader").getByRole("button",{name:"Search this book",exact:true}).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
 });
}

 test("Now Playing keeps keyboard focus inside the open dialog",async({page,browserName,isMobile})=>{
  skipOnMobile(isMobile,"needs a hardware keyboard (Tab, Escape)");
  const dialog=await open(page,browserName,"Layout plain",[390,844]);
  const close=dialog.getByRole("button",{name:"Close dialog"});
  await close.focus();
  for(let i=0;i<30;i++){
   await page.keyboard.press("Tab");
   expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  }
  expect(await page.locator("#root").evaluate(el => (el as HTMLElement).inert)).toBe(true);
  await close.click();
  expect(await page.locator("#root").evaluate(el => (el as HTMLElement).inert)).toBe(false);
  await expect(page.locator(".player-dock .dock-book")).toBeFocused();
  expect(await page.locator(".now-playing-dialog").evaluate(el => el.contains(document.activeElement))).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).visibility)).toBe("visible");
  await page.locator(".player-dock .dock-book").click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(".player-dock .dock-book")).toBeFocused();
  await page.locator(".mobile-nav").getByRole("button", {name:"Settings",exact:true}).click();
 });
