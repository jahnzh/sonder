// @projects firefox, webkit, mobile-chrome, mobile-firefox, mobile-safari, mobile-iphone-slice13, webkit-iphone-now-playing
import {type Page,type Locator,type APIRequestContext} from "@playwright/test";
import {test,expect} from "./fixtures";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
import {skipOnMobile} from "./mobile";
import {READER_SPEC_TIMEOUT_MS,READER_WAIT_MS} from "./timing";
import { playFromLibrary } from "./library-play";
import {openListen,openRead} from "./now-playing";
// Geometry regression checks for issues #1 (seek/heading alignment) and #2 (reader-first Now Playing), on Now playing's
// two faces (#593): Listen measured against NowPlaying.dc.html, Read with the reader's head and foot.
const sizes=[[360,740],[390,844],[430,932],[1280,800]] as const;
const readerCentreSizes=[[360,740],[390,844],[412,915]] as const;
// Desktop (#122, #595): Back to narration stays in the footer's control row at these widths, from 760 where the desktop starts.
const readerDesktopSizes=[[760,800],[900,800],[1280,800],[1600,800]] as const;
// Smoke (#122): phone + one desktop width for Firefox/WebKit (Chromium runs the full sweep).
const readerSmokeSizes=[[390,844],[1280,800]] as const;
/** Geometry via getBoundingClientRect — Playwright's boundingBox waits for "stable", which WebKit never reaches while the EPUB keeps reflowing. */
const boxOf=async(l:Locator)=>{
 await expect(l).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
 return l.evaluate((el)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
};
const centre=async(l:Locator)=>{const b=await boxOf(l);return {x:b.x+b.width/2,y:b.y+b.height/2,box:b};};
async function importBook(request:APIRequestContext,title:string,withEbook:boolean){
 const response=await request.post("/api/import",{multipart:{title,author:"Layout QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 if(!withEbook)return;
 const id=(await response.json()).id;
 const book=(await(await request.get("/api/books")).json()).find((b:any)=>b.id===id);
 // EPUB imports deduplicate by bytes across the whole browser run, not by work.
 expect((await request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Companion.epub",mimeType:"application/epub+zip",buffer:await readerFixture({language:"en-NZ",title})}}})).ok()).toBe(true);
}
async function open(page:Page,browserName:string,title:string,[width,height]:readonly [number,number],face:"listen"|"read"="listen"){
 await page.setViewportSize({width,height});
 await page.goto("/");
 await playFromLibrary(page, title);
 // Headless Firefox/WebKit may refuse to start audio; the layout only needs the book loaded and paused.
 const dock=page.locator(".player-dock");
 await expect(dock.locator(".dock-book")).toContainText(title);
 if(browserName==="chromium")await dock.getByRole("button",{name:"Pause",exact:true}).click();
 else{
  // Headless Firefox/WebKit may refuse to start, or restart after a pause; wait on the Play control
  // instead of sleeping between clicks.
  const pause=dock.getByRole("button",{name:"Pause",exact:true});
  const play=dock.getByRole("button",{name:"Play",exact:true});
  await expect.poll(async()=>{
   if(await pause.isVisible()){
    try{await pause.click({timeout:1000});}
    catch{/* Pause raced away or was not clickable; retry on the next poll. */}
   }
   return play.isVisible();
  },{timeout:20000}).toBe(true);
 }
 // Firefox and WebKit may start the audio between the wait above and here, which turns Play into Pause; the layout
 // checks that follow do not depend on which one the dock shows.
 await expect(dock.getByRole("button",{name:/^(Play|Pause)$/})).toBeVisible();
 await page.mouse.move(0,0);
 await checkTransport(page,page.locator(".player-dock .transport"));
 // The mini player opens Now playing on its face rule (Listen the first time); the head's control switches faces (#593).
 if(face==="read")await openRead(page);else await openListen(page);
 const dialog=page.getByRole("dialog",{name:"Now playing",exact:true});
 await expect(dialog).toBeVisible();
 // Wait until the open animation (scale/translate) has finished before measuring.
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
/** Listen's transport (board NowPlaying.dc.html): −30 and +30 at 56, Play or Pause at 72, on one axis, centred, in the window. */
async function checkListenTransport(page:Page,transport:Locator){
 await transport.scrollIntoViewIfNeeded();
 const {width,height}=page.viewportSize()!;
 const play=await centre(transport.getByRole("button",{name:/^(Play|Pause)$/}));
 expect([Math.round(play.box.width),Math.round(play.box.height)]).toEqual([72,72]);
 const seeks=[];
 for(const name of ["Rewind 30 seconds","Forward 30 seconds"]){
  const b=await centre(transport.getByRole("button",{name,exact:true}));
  expect([Math.round(b.box.width),Math.round(b.box.height)]).toEqual([56,56]);
  expect(Math.abs(b.y-play.y)).toBeLessThanOrEqual(1);
  expect(b.box.x).toBeGreaterThanOrEqual(0);expect(b.box.x+b.box.width).toBeLessThanOrEqual(width);
  expect(b.box.y).toBeGreaterThanOrEqual(0);expect(b.box.y+b.box.height).toBeLessThanOrEqual(height);
  seeks.push(b);
 }
 expect(seeks[0].x).toBeLessThan(play.x);expect(seeks[1].x).toBeGreaterThan(play.x);
 expect(Math.abs((play.x-seeks[0].x)-(seeks[1].x-play.x))).toBeLessThanOrEqual(1);
 expect(Math.round(play.box.x-(seeks[0].box.x+seeks[0].box.width))).toBe(24);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
}
/** Listen's footer on a desktop (#595, board DesktopNowPlaying.dc.html): −30, Play or Pause and +30 at 44, 8 apart, then
 *  the timeline, on one axis at the bottom of the window. */
async function checkDesktopListenFooter(page:Page,dialog:Locator){
 const {width,height}=page.viewportSize()!;
 const footer=await boxOf(dialog.locator(".now-playing-footer"));
 expect(Math.abs(footer.y+footer.height-height)).toBeLessThanOrEqual(1);
 const transport=dialog.locator(".now-playing-footer .now-playing-transport");
 const play=await centre(transport.getByRole("button",{name:/^(Play|Pause)$/}));
 const rewind=await centre(transport.getByRole("button",{name:"Rewind 30 seconds",exact:true}));
 const forward=await centre(transport.getByRole("button",{name:"Forward 30 seconds",exact:true}));
 for(const b of [rewind,play,forward]){
  expect([Math.round(b.box.width),Math.round(b.box.height)]).toEqual([44,44]);
  expect(Math.abs(b.y-play.y)).toBeLessThanOrEqual(1);
 }
 expect(Math.round(play.box.x-(rewind.box.x+rewind.box.width))).toBe(8);
 expect(Math.round(forward.box.x-(play.box.x+play.box.width))).toBe(8);
 const slider=await centre(dialog.getByRole("slider",{name:/^Seek in /}));
 expect(slider.box.x).toBeGreaterThan(forward.box.x+forward.box.width);
 expect(Math.abs(slider.y-play.y)).toBeLessThanOrEqual(2);
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
  skipOnMobile(size[0]>=760,"desktop layout (min-width: 760px) is not reachable on a phone profile");
  // A book without an EPUB opens on Listen, measured against its board (#593).
  const dialog=await open(page,browserName,"Layout plain",size);
  await expect(dialog.locator(".now-playing-listen")).toBeVisible();
  const transport=dialog.locator(".now-playing-transport");
  if(size[0]<760){
   await checkListenTransport(page,transport);
   await checkTimeline(dialog,transport);
  }else await checkDesktopListenFooter(page,dialog);
  // The head: Close, Listen or Read, the book's page, 44 high on one line and in the window.
  const close=await centre(dialog.getByRole("button",{name:"Close now playing",exact:true}));
  const faces=await centre(dialog.getByRole("radiogroup",{name:"Listen or read",exact:true}));
  const bookPage=await centre(dialog.getByRole("button",{name:"Open this book’s page",exact:true}));
  for(const item of [close,faces,bookPage]){
   expect(Math.round(item.box.height)).toBe(44);
   expect(Math.abs(item.y-close.y)).toBeLessThanOrEqual(1);
   expect(item.box.x).toBeGreaterThanOrEqual(0);expect(item.box.x+item.box.width).toBeLessThanOrEqual(size[0]);
  }
  expect(close.x).toBeLessThan(faces.x);expect(faces.x).toBeLessThan(bookPage.x);
  // Read does not exist for this book; the suite's administrator gets Get ebook from it, so it is not off.
  await expect(dialog.getByRole("radio",{name:"Listen",exact:true})).toHaveAttribute("aria-checked","true");
 });
 test(`reader-first Now Playing is aligned at ${size[0]}px`,async({page,browserName})=>{
  // On the Steam Deck this WebKit test takes 18-45 s (33 runs), right under the global 45 s limit, so it flakes with host load.
  test.setTimeout(READER_SPEC_TIMEOUT_MS);
  skipOnMobile(size[0]>=760,"desktop layout (min-width: 760px) is not reachable on a phone profile");
  const [width,height]=size;
  const dialog=await open(page,browserName,"Layout reader",size,"read");
  await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible();
  // On a phone the foot's transport row shows with the controls (#587); at rest the foot has a small Play only.
  if(width<760)await showReaderTopbar(page,dialog.locator(".inline-reader"));
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
  const timer=player.getByRole("button",{name:/^Sleep timer: /});
  const timerBox=await centre(timer),forwardBox=await boxOf(forward);
  // The timer is on the transport's row: the foot's lower row on a phone, the footer's one row on a desktop (#595).
  expect(Math.abs(timerBox.y-play.y)).toBeLessThanOrEqual(2);
  expect(timerBox.box.width).toBeGreaterThanOrEqual(44);
  expect(timerBox.box.x+timerBox.box.width).toBeLessThanOrEqual(width);
  expect(timerBox.box.x).toBeGreaterThanOrEqual(forwardBox.x+forwardBox.width);
  // The sleep timer opens its pop-up above its button with its stepper (#589, #890); it stays in the window and the
  // transport row stays.
  await timer.click();
  const popup=page.getByRole("group",{name:"Sleep timer",exact:true});
  const longer=popup.getByRole("button",{name:"Longer",exact:true});
  await expect(longer).toBeVisible();
  const rowBox=await boxOf(popup);
  expect(rowBox.x).toBeGreaterThanOrEqual(0);expect(rowBox.x+rowBox.width).toBeLessThanOrEqual(width);
  await expect(forward).toBeVisible();
  await longer.click();await longer.click();
  await expect(popup.getByRole("spinbutton",{name:"Sleep timer",exact:true})).toHaveText("15 min");
  await timer.click();
  await expect(popup).toHaveCount(0);
  await expect(timer).toContainText("15 min");
  await timer.click();
  await popup.getByRole("spinbutton",{name:"Sleep timer",exact:true}).press("Home");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(timer).toHaveAccessibleName("Sleep timer: off");
  const box=await boxOf(dialog);
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y+box.height).toBeLessThanOrEqual(height);
  expect((await boxOf(page.locator(".inline-reader .reader-viewport"))).height).toBeGreaterThan(height*.6);
  const surface=await page.locator(".inline-reader").evaluate(el=>getComputedStyle(el).backgroundColor);
  await expect(page.frameLocator(".inline-reader .reader-viewport iframe").locator("body")).toHaveCSS("background-color",surface);
  // The controls shown above stay until the next tap (#587: no timer); this shows them if anything hid them.
  if(width<760)await showReaderTopbar(page,dialog.locator(".inline-reader"));
  // The bar is the narration's position; the page follows it.
  await expect(player.getByRole("slider",{name:/^Seek in /})).toBeVisible();
  await expect(player.getByRole("slider",{name:"Position in book"})).toHaveCount(0);
  // Read's head carries the face control after Close (#593).
  await expect(dialog.locator(".inline-reader .reader-topbar").getByRole("radio",{name:"Read",exact:true})).toHaveAttribute("aria-checked","true");
  const names=["Close reader","Bookmark current sentence","Search this book","Reader appearance","Back to narration","Back 30 seconds","Play narration","Forward 30 seconds",/^Sleep timer: /];
  if(width<760)names.push("Chapters");
  for(const name of names){
   // The transport button reads "Play narration" or "Pause narration" depending on whether the tap above started playback.
   const button=dialog.locator(".inline-reader").getByRole("button",{name:name==="Play narration"?/^(Play|Pause) narration$/:name,exact:true});
   await expect(button).toBeVisible();
   const rect=await boxOf(button);
   expect(rect.width).toBeGreaterThanOrEqual(44);
   expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x+rect.width).toBeLessThanOrEqual(width);
   expect(rect.y).toBeGreaterThanOrEqual(0); expect(rect.y+rect.height).toBeLessThanOrEqual(height);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
  if(width>=760) await expect(page.getByLabel("Contents sidebar")).toBeVisible();
  // A tap on the page leaves focus in the EPUB frame; Escape works from the reader's own controls.
  await dialog.locator(".inline-reader").getByRole("button",{name:"Search this book",exact:true}).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
 });
}

async function installLayoutAlignment(request:APIRequestContext,title:string){
 const books=await(await request.get("/api/books")).json();
 const book=books.find((entry:any)=>entry.title===title);
 expect(book).toBeTruthy();
 const ebooks=await(await request.get("/api/ebooks")).json();
 const ebook=ebooks.find((entry:any)=>entry.workId===book.workId&&entry.format==="epub");
 expect(ebook).toBeTruthy();
 const manifest=await(await request.get(`/api/reader/${ebook.id}`)).json();
 const pairings=manifest.sections.map((section:any)=>({section:section.index,trackId:book.tracks[0].id,start:section.index*100,duration:95}));
 const matches=(job:any)=>job.recordingId===book.recordingId&&job.mode!=="anchored"&&job.pairings.length===pairings.length&&pairings.every((pair:any)=>job.pairings.some((actual:any)=>actual.section===pair.section&&actual.trackId===pair.trackId&&actual.start===pair.start&&actual.duration===pair.duration));
 const existing=await(await request.get(`/api/alignments?ebookId=${ebook.id}`)).json();
 let job=existing.jobs?.find(matches);
 if(!job){
  // Import can auto-queue a sparse anchored map; this layout test needs its own chapter map.
  const created=await request.post("/api/alignments",{data:{ebookId:ebook.id,recordingId:book.recordingId,pairings}});
  expect(created.ok()).toBe(true);
  job=await created.json();
 }
 await expect.poll(async()=>{
  const jobs=(await(await request.get(`/api/alignments?ebookId=${ebook.id}`)).json()).jobs;
  const current=jobs.find((entry:any)=>entry.id===job.id&&matches(entry));
  return !!current&&["ready","partial"].includes(current.status)&&current.sectionsDone.length===manifest.sections.length&&current.intervals.some((entry:any)=>entry.section===1&&entry.trackId===book.tracks[0].id&&entry.start>104);
 },{timeout:15000}).toBe(true);
 return {book,ebookId:ebook.id as string,jobId:job.id as string};
}
async function assertReaderTransportCentred(dialog:Locator,player:Locator){
 const play=await centre(player.getByRole("button",{name:/^(Play|Pause) narration$/}));
 const bar=await centre(player);
 expect(Math.abs(play.x-bar.x)).toBeLessThanOrEqual(2);
 await expect(dialog.locator(".player-undo-jump")).toHaveCount(0);
 await expect(dialog.getByRole("button",{name:"Undo jump",exact:true})).toHaveCount(0);
 const below=await dialog.evaluate(()=>{
  const bar=document.querySelector<HTMLElement>(".reader-player");
  // Nothing of Now playing lies below the Read face's foot: the face is the reader's page alone (#593).
  const face=document.querySelector<HTMLElement>(".now-playing-face");
  if(!bar||!face)return Infinity;
  const bottom=bar.getBoundingClientRect().bottom;
  return Math.max(0,...[...face.children].map((child)=>{
   const el=child as HTMLElement;
   if(getComputedStyle(el).display==="none")return 0;
   const box=el.getBoundingClientRect();
   return box.height>0?box.bottom-bottom:0;
  }));
 });
 expect(below).toBeLessThanOrEqual(2);
 const back=player.getByRole("button",{name:"Back to narration",exact:true});
 const chapters=player.getByRole("button",{name:"Chapters",exact:true});
 const rewind=player.getByRole("button",{name:"Back 30 seconds",exact:true});
 const backBox=await boxOf(back);
 expect(backBox.width).toBeGreaterThanOrEqual(44);
 expect(backBox.height).toBeGreaterThanOrEqual(44);
 const chaptersBox=await boxOf(chapters);
 const rewindBox=await boxOf(rewind);
 expect(chaptersBox.x+chaptersBox.width).toBeLessThanOrEqual(backBox.x+1);
 expect(backBox.x+backBox.width).toBeLessThanOrEqual(rewindBox.x+1);
}
/** Scrubber, Chapters, Back to narration, Back 30 — in that DOM index order at every width. */
async function assertPlayerControlDomOrder(player:Locator){
 const order=await player.evaluate((bar)=>{
  const scrub=bar.querySelector<HTMLElement>(".reader-audio-timeline input[type=range], .reader-scrubber");
  const chapters=bar.querySelector<HTMLElement>('[aria-label="Chapters"]');
  const back=bar.querySelector<HTMLElement>('[aria-label="Back to narration"]');
  const rewind=bar.querySelector<HTMLElement>('[aria-label="Back 30 seconds"]');
  if(!scrub||!chapters||!back||!rewind)return null;
  const all=[...bar.querySelectorAll("*")];
  const index=(el:Element)=>all.indexOf(el);
  return {scrub:index(scrub),chapters:index(chapters),back:index(back),rewind:index(rewind)};
 });
 expect(order).not.toBeNull();
 expect(order!.scrub).toBeLessThan(order!.chapters);
 expect(order!.chapters).toBeLessThan(order!.back);
 expect(order!.back).toBeLessThan(order!.rewind);
}
/** Tab from the scrubber reaches Chapters (when shown), then Back to narration when enabled, then Back 30. */
async function assertPlayerControlTabOrder(page:Page,player:Locator,backEnabled:boolean){
 const scrub=player.getByRole("slider",{name:/^Seek in /});
 await scrub.focus();
 await expect(scrub).toBeFocused();
 // Chapters is display:none on desktop; query the node directly so Playwright does not wait for a11y visibility.
 const chaptersNode=player.locator(".reader-player-chapters");
 const chaptersShown=await chaptersNode.evaluate((el)=>getComputedStyle(el).display!=="none");
 await page.keyboard.press("Tab");
 if(chaptersShown){
  await expect(player.getByRole("button",{name:"Chapters",exact:true})).toBeFocused();
  await page.keyboard.press("Tab");
 }
 const back=player.getByRole("button",{name:"Back to narration",exact:true});
 if(backEnabled){
  await expect(back).toBeFocused();
  await page.keyboard.press("Tab");
 }else await expect(back).toBeDisabled();
 await expect(player.getByRole("button",{name:"Back 30 seconds",exact:true})).toBeFocused();
}
/** Desktop (#595, board DesktopReader.dc.html): the footer's one row is Back to narration, −30, Play or Pause, +30, the
 *  timeline, Sleep timer, Speed; Chapters is the contents beside the text. Back to narration stays in that row, 8
 *  before −30, in both its states, and Play does not move between them. */
async function assertDesktopBackNarration(dialog:Locator,player:Locator,width:number){
 await expect(dialog.locator(".player-undo-jump")).toHaveCount(0);
 const order=await player.evaluate((bar)=>{
  const names=["Chapters","Back to narration","Back 30 seconds"];
  const buttons=[...bar.querySelectorAll("button")].filter((button)=>names.includes(button.getAttribute("aria-label")||""));
  const visible=buttons.filter((button)=>getComputedStyle(button).display!=="none");
  const shown=[...bar.querySelectorAll<HTMLElement>("button, input[type=range]")].filter((node)=>getComputedStyle(node).display!=="none"&&getComputedStyle(node).visibility!=="hidden"&&node.getBoundingClientRect().width>0);
  return {
   dom:buttons.map((button)=>button.getAttribute("aria-label")),
   visual:visible
    .slice()
    .sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left)
    .map((button)=>button.getAttribute("aria-label")),
   row:shown.sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left).map((node)=>node.getAttribute("aria-label")||""),
  };
 });
 expect(order.dom).toEqual(["Chapters","Back to narration","Back 30 seconds"]);
 expect(order.visual).toEqual(["Back to narration","Back 30 seconds"]);
 expect(order.row).toEqual(["Back to narration","Back 30 seconds",expect.stringMatching(/^(Play|Pause) narration$/),"Forward 30 seconds",expect.stringMatching(/^Seek in /),expect.stringMatching(/^Sleep timer: /),expect.stringMatching(/^Speed [\d.]+ times$/)]);
 const back=player.getByRole("button",{name:"Back to narration",exact:true});
 const rewind=player.getByRole("button",{name:"Back 30 seconds",exact:true});
 const play=player.getByRole("button",{name:/^(Play|Pause) narration$/});
 const backBox=await boxOf(back);
 const rewindBox=await boxOf(rewind);
 const playBox=await boxOf(play);
 const bar=await boxOf(player);
 expect(backBox.width).toBeGreaterThanOrEqual(44);
 expect(backBox.height).toBeGreaterThanOrEqual(44);
 // The footer's row starts 24 in, with Back to narration, 8 before −30, on the transport's axis.
 expect(Math.abs(backBox.x-(bar.x+24))).toBeLessThanOrEqual(1);
 expect(Math.abs(rewindBox.x-(backBox.x+backBox.width+8))).toBeLessThanOrEqual(1);
 expect(Math.abs((backBox.y+backBox.height/2)-(playBox.y+playBox.height/2))).toBeLessThanOrEqual(2);
 expect(Math.abs((playBox.y+playBox.height/2)-(bar.y+bar.height/2))).toBeLessThanOrEqual(2);
 expect(backBox.x+backBox.width).toBeLessThanOrEqual(playBox.x+1);
 expect(bar.x+bar.width).toBeLessThanOrEqual(width+0.5);
 const playVsMain=await dialog.evaluate(()=>{
  const play=document.querySelector<HTMLElement>(".reader-play");
  const main=document.querySelector<HTMLElement>(".now-playing-face");
  if(!play||!main)return null;
  const playBox=play.getBoundingClientRect(),mainBox=main.getBoundingClientRect();
  return {x:playBox.left+playBox.width/2-(mainBox.left+mainBox.width/2),y:playBox.top+playBox.height/2-(mainBox.top+mainBox.height/2)};
 });
 expect(playVsMain).not.toBeNull();
 return playVsMain!;
}
/** Show the reader top bar when the phone chrome has auto-hidden it. */
async function showReaderTopbar(page:Page,room:Locator){
 const topbar=room.locator(".reader-topbar");
 if(await topbar.isVisible())return;
 await expect(room.locator(".reader-viewport iframe")).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
 const box=await boxOf(room.locator(".reader-viewport"));
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
}
/** Seed narration progress and open the aligned Layout reader once for a #122 fixture. */
async function openAlignedReader(page:Page,browserName:string,request:APIRequestContext,size:readonly [number,number],title="Layout reader"){
 const {book,ebookId,jobId}=await installLayoutAlignment(request,title);
 const detail=await(await request.get(`/api/alignments/${jobId}/map`)).json();
 expect(detail.recordingId).toBe(book.recordingId);
 const interval=detail.intervals.find((entry:any)=>entry.section===1&&entry.trackId===book.tracks[0].id&&entry.start>104);
 expect(interval).toBeTruthy();
 expect((await request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position:interval.start+1,duration:book.tracks[0].duration,updatedAt:Date.now()}})).ok()).toBe(true);
 // Wait for the initial play request to settle before pausing: WebKit can show
 // Play while autoplay is still pending, then start during the layout checks.
 await page.addInitScript(()=>{
  const play=HTMLMediaElement.prototype.play;
  let attempt=0;
  (window as any).__layoutPlaySettled=false;
  HTMLMediaElement.prototype.play=function(){
   const current=++attempt;
   (window as any).__layoutPlaySettled=false;
   const result=play.call(this);
   void result.then(()=>{if(current===attempt)(window as any).__layoutPlaySettled=true;},()=>{if(current===attempt)(window as any).__layoutPlaySettled=true;});
   return result;
  };
 });
 const dialog=await open(page,browserName,title,size,"read");
 await expect.poll(()=>page.evaluate(()=>(window as any).__layoutPlaySettled),{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
 await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible({timeout:READER_WAIT_MS.checkpointRestore});
 const player=dialog.getByRole("region",{name:"Player",exact:true});
 await expect(player).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
 const pause=player.getByRole("button",{name:"Pause narration",exact:true});
 if(await pause.isVisible())await pause.click();
 await expect(player.getByRole("button",{name:"Play narration",exact:true})).toBeVisible();
 await expect(dialog.locator(".inline-reader")).toHaveAttribute("data-current-passage",/./,{timeout:READER_WAIT_MS.followHighlight});
 // On a phone the foot's controls show with the head's (#587).
 if(size[0]<760)await showReaderTopbar(page,dialog.locator(".inline-reader"));
 return {dialog,player,book,ebookId};
}
async function pageAwayFromNarration(page:Page,dialog:Locator,back:Locator){
 const next=dialog.getByRole("button",{name:"Next page",exact:true});
 if(await next.isVisible())await next.click();
 else{
  const pageBox=await boxOf(dialog.locator(".inline-reader .reader-viewport"));
  await page.mouse.click(pageBox.x+pageBox.width*0.9,pageBox.y+pageBox.height/2);
 }
 await expect(back).toBeEnabled({timeout:READER_WAIT_MS.followHighlight});
}
async function ensureFollowingNarration(back:Locator){
 if(await back.isEnabled()){
  await back.click();
  await expect(back).toBeDisabled({timeout:READER_WAIT_MS.followHighlight});
 }else await expect(back).toBeDisabled();
}
async function resizeAlignedReader(page:Page,dialog:Locator,player:Locator,[width,height]:readonly [number,number]){
 await page.setViewportSize({width,height});
 await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
 await expect(player).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
 if(width>=760)await expect(page.getByLabel("Contents sidebar")).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
 else{
  await showReaderTopbar(page,dialog.locator(".inline-reader"));
  await expect(player.getByRole("button",{name:"Chapters",exact:true})).toBeVisible({timeout:READER_WAIT_MS.followHighlight});
 }
}

test.describe("#122 reader Back to narration layout",()=>{
 // Full width / mode sweep is Chromium-only: engine-independent CSS grid maths; WebKit is slow on the Deck.
 // Firefox/WebKit keep a narrow smoke at 390px and 1280px (both states, centring and order).
 for(const state of ["disabled","enabled"] as const){
  test(`chromium: phone transport centred with Back to narration ${state}`,async({page,browserName,request})=>{
   test.skip(browserName!=="chromium","Full width sweep is Chromium-only: engine-independent CSS grid maths; WebKit is slow on the Deck");
   test.setTimeout(READER_SPEC_TIMEOUT_MS);
   const {dialog,player}=await openAlignedReader(page,browserName,request,readerCentreSizes[0]);
   const back=player.getByRole("button",{name:"Back to narration",exact:true});
   await expect(back).toBeVisible();
   if(state==="enabled")await pageAwayFromNarration(page,dialog,back);
   else await expect(back).toBeDisabled();
   for(const size of readerCentreSizes){
    const [width]=size;
    await resizeAlignedReader(page,dialog,player,size);
    if(state==="enabled")await expect(back).toBeEnabled();
    else await expect(back).toBeDisabled();
    await assertReaderTransportCentred(dialog,player);
    if(width===360){
     for(const name of [/^Sleep timer: /,/^Speed [\d.]+ times$/] as const){
      const box=await boxOf(player.getByRole("button",{name}));
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x+box.width).toBeLessThanOrEqual(width);
     }
     await showReaderTopbar(page,dialog.locator(".inline-reader"));
     // Reader appearance is the head's last control since More left it (#592).
     const last=await boxOf(dialog.locator(".inline-reader .reader-topbar").getByRole("button",{name:"Reader appearance",exact:true}));
     expect(last.x).toBeGreaterThanOrEqual(0);
     expect(last.x+last.width).toBeLessThanOrEqual(width);
    }
   }
  });
 }
 test("chromium: desktop Back to narration stays in the control row across widths",async({page,browserName,request})=>{
  test.skip(browserName!=="chromium","Full width sweep is Chromium-only: engine-independent CSS grid maths; WebKit is slow on the Deck");
  skipOnMobile(true,"desktop layout (min-width: 760px) is not reachable on a phone profile");
  test.setTimeout(READER_SPEC_TIMEOUT_MS);
  const {dialog,player}=await openAlignedReader(page,browserName,request,readerDesktopSizes[0]);
  const back=player.getByRole("button",{name:"Back to narration",exact:true});
  await expect(back).toBeVisible();
  for(const size of readerDesktopSizes){
   const [width]=size;
   await resizeAlignedReader(page,dialog,player,size);
   await ensureFollowingNarration(back);
   const disabledPlay=await assertDesktopBackNarration(dialog,player,width);
   await pageAwayFromNarration(page,dialog,back);
   const enabledPlay=await assertDesktopBackNarration(dialog,player,width);
   expect(Math.abs(enabledPlay.x-disabledPlay.x)).toBeLessThanOrEqual(1);
   expect(Math.abs(enabledPlay.y-disabledPlay.y)).toBeLessThanOrEqual(1);
  }
 });
 test("chromium: player control DOM and Tab order across phone and desktop",async({page,browserName,request})=>{
  test.skip(browserName!=="chromium","Full width sweep is Chromium-only: engine-independent CSS grid maths; WebKit is slow on the Deck");
  skipOnMobile(true,"needs a hardware keyboard (Tab); desktop layout is not reachable on a phone profile");
  test.setTimeout(READER_SPEC_TIMEOUT_MS);
  const {dialog,player}=await openAlignedReader(page,browserName,request,readerSmokeSizes[0]);
  const back=player.getByRole("button",{name:"Back to narration",exact:true});
  for(const size of readerSmokeSizes){
   const [width]=size;
   await resizeAlignedReader(page,dialog,player,size);
   if(width<760)await showReaderTopbar(page,dialog.locator(".inline-reader"));
   await expect(player.getByRole("slider",{name:/^Seek in /})).toBeVisible();
   await ensureFollowingNarration(back);
   await assertPlayerControlDomOrder(player);
   await assertPlayerControlTabOrder(page,player,false);
   await pageAwayFromNarration(page,dialog,back);
   if(width<760)await showReaderTopbar(page,dialog.locator(".inline-reader"));
   await assertPlayerControlDomOrder(player);
   await assertPlayerControlTabOrder(page,player,true);
  }
 });
 test("firefox/webkit smoke: transport centred and ordered at 390px and 1280px",async({page,browserName,request})=>{
  test.skip(browserName==="chromium","Chromium runs the full width sweep instead");
  skipOnMobile(true,"needs a hardware keyboard (Tab); desktop layout is not reachable on a phone profile");
  test.setTimeout(READER_SPEC_TIMEOUT_MS);
  const {dialog,player}=await openAlignedReader(page,browserName,request,readerSmokeSizes[0]);
  const back=player.getByRole("button",{name:"Back to narration",exact:true});
  for(const size of readerSmokeSizes){
   const [width]=size;
   await resizeAlignedReader(page,dialog,player,size);
   if(width<760)await showReaderTopbar(page,dialog.locator(".inline-reader"));
   await ensureFollowingNarration(back);
   if(width<760)await assertReaderTransportCentred(dialog,player);
   else await assertDesktopBackNarration(dialog,player,width);
   await assertPlayerControlDomOrder(player);
   await assertPlayerControlTabOrder(page,player,false);
   await pageAwayFromNarration(page,dialog,back);
   if(width<760){
    await assertReaderTransportCentred(dialog,player);
    await showReaderTopbar(page,dialog.locator(".inline-reader"));
   }else await assertDesktopBackNarration(dialog,player,width);
   await assertPlayerControlDomOrder(player);
   await assertPlayerControlTabOrder(page,player,true);
  }
 });
 test("a controls tap does not turn a later relocation into a page turn",async({page,browserName,request})=>{
  test.setTimeout(READER_SPEC_TIMEOUT_MS);
  const title=`Layout controls tap ${randomUUID()}`;
  await importBook(request,title,true);
  const {dialog,player,ebookId}=await openAlignedReader(page,browserName,request,readerSmokeSizes[0],title);
  const room=dialog.locator(".inline-reader");
  const back=player.getByRole("button",{name:"Back to narration",exact:true});
  await showReaderTopbar(page,room);
  await ensureFollowingNarration(back);

  const bookmark=room.locator(".reader-bookmark-toggle");
  const bookmarkPath=`/api/reader/${ebookId}/bookmarks`;
  let saved:ReturnType<Page["waitForResponse"]>|undefined;
  try{
   // The pressed state changes only after the reader processes a different location.
   await expect(bookmark).toHaveAttribute("aria-pressed","false");
   saved=page.waitForResponse(response=>response.url().endsWith(bookmarkPath)&&response.request().method()==="POST",{timeout:READER_WAIT_MS.followHighlight});
   await bookmark.evaluate((button:HTMLButtonElement)=>button.click());
   expect((await saved).ok()).toBe(true);
   await expect(bookmark).toHaveAttribute("aria-pressed","true");
   const viewport=await boxOf(room.locator(".reader-viewport"));
   const x=viewport.x+viewport.width/2,y=viewport.y+viewport.height/2;
   const scroller=room.locator(".reader-viewport .epub-container");

   // A programmatic scroll makes epub.js report a real relocation without a
   // new page gesture. Retry while initial layout work is still settling: a
   // controls tap immediately precedes every attempted relocation.
   let scrolled=false;
   await expect.poll(async()=>{
    if(scrolled&&await bookmark.getAttribute("aria-pressed")==="false")return true;
    await page.mouse.click(x,y);
    await expect(room).toHaveAttribute("data-controls-visible","false");
    await page.mouse.click(x,y);
    await expect(room).toHaveAttribute("data-controls-visible","true");
    await scroller.evaluate((element:HTMLElement)=>{
     const max=element.scrollWidth-element.clientWidth;
     if(max<=0)throw new Error("Expected the fixture chapter to have multiple pages");
     element.scrollLeft=element.scrollLeft<max/2?max:0;
    });
    scrolled=true;
    return false;
   },{timeout:READER_WAIT_MS.followHighlight}).toBe(true);
   await expect(back).toBeDisabled();
   await expect(room).toHaveAttribute("data-current-passage",/./);
   await pageAwayFromNarration(page,dialog,back);
  }finally{
   // Wait for any queued POST before deleting, even when an assertion fails.
   if(saved)await saved.catch(()=>{});
   const response=await request.get(`/api/reader/${ebookId}`);
   expect(response.ok()).toBe(true);
   const {bookmarks}=await response.json();
   for(const entry of bookmarks){
    expect((await request.delete(`${bookmarkPath}/${entry.id}`)).ok()).toBe(true);
   }
   expect((await(await request.get(`/api/reader/${ebookId}`)).json()).bookmarks).toEqual([]);
  }
 });
});

 // An info mark's explanation is a Radix popover whose focus scope pauses Now playing's while it is open and resumes
 // it only in a timer after it closed: a Tab from the last control before that timer ran left the dialog (#737).
 // The timer is held back here, so the Tab always comes first.
 test("Tab wraps inside Now playing while a closed explanation still holds the focus scope",async({page,browserName})=>{
  skipOnMobile(true,"needs a hardware keyboard (Tab)");
  const dialog=await open(page,browserName,"Layout plain",[390,844]);
  const keep=dialog.getByRole("switch",{name:"Keep on this device",exact:true});
  await expect(keep).toBeEnabled();
  await dialog.getByRole("button",{name:"Earlier positions",exact:true}).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button",{name:"About Keep on this device",exact:true})).toBeFocused();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.evaluate(()=>{
   const w=window as typeof window&{__heldTimeout?:typeof setTimeout};
   w.__heldTimeout=window.setTimeout;
   window.setTimeout=((run:TimerHandler,ms?:number,...rest:unknown[])=>w.__heldTimeout!(run,ms?ms:1500,...rest)) as typeof setTimeout;
  });
  try{
   await page.keyboard.press("Tab");
   await expect(keep).toBeFocused();
   await expect(page.getByRole("tooltip")).toHaveCount(0);
   await page.keyboard.press("Tab");
   await expect(dialog.getByRole("button",{name:"Close now playing",exact:true})).toBeFocused();
   await page.keyboard.press("Shift+Tab");
   await expect(keep).toBeFocused();
  }finally{
   await page.evaluate(()=>{
    const w=window as typeof window&{__heldTimeout?:typeof setTimeout};
    if(w.__heldTimeout)window.setTimeout=w.__heldTimeout;
   });
  }
 });

 test("Now Playing keeps keyboard focus inside the open dialog",async({page,browserName})=>{
  skipOnMobile(true,"needs a hardware keyboard (Tab, Escape)");
  const dialog=await open(page,browserName,"Layout plain",[390,844]);
  const close=dialog.getByRole("button",{name:"Close now playing",exact:true});
  await close.focus();
  for(let i=0;i<30;i++){
   await page.keyboard.press("Tab");
   expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  }
  expect(await page.locator("#root").evaluate(el => (el as HTMLElement).inert)).toBe(true);
  await close.click();
  expect(await page.locator("#root").evaluate(el => (el as HTMLElement).inert)).toBe(false);
  await expect(page.locator(".player-dock .dock-book")).toBeFocused();
  // Closed, Now playing leaves the page (it stays mounted only under the Read face's own pages); focus is not in it.
  expect(await page.evaluate(() => !!document.activeElement?.closest(".now-playing-screen"))).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).visibility)).toBe("visible");
  await page.locator(".player-dock .dock-book").click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(".player-dock .dock-book")).toBeFocused();
  await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("button", {name:"Settings",exact:true}).click();
 });
