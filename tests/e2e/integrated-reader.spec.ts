import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
import {skipOnMobile} from "./mobile";
test.afterEach(async({page})=>{await page.unrouteAll({behavior:"wait"});});
async function fixture(page:Page,title:string,language="en-US"){
 const response=await page.request.post("/api/import",{multipart:{title,author:"Reader QA",file:{name:"Narration.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(response.ok()).toBe(true);
 const id=(await response.json()).id;
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===id);
 const uploaded=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Companion.epub",mimeType:"application/epub+zip",buffer:await readerFixture({language})}}});
 expect(uploaded.ok()).toBe(true);const ebook=(await uploaded.json()).id;
 const manifest=await(await page.request.get(`/api/reader/${ebook}`)).json();
 const created=await page.request.post("/api/alignments",{data:{ebookId:ebook,recordingId:book.recordingId,pairings:manifest.sections.map((section:any)=>({section:section.index,trackId:book.tracks[0].id,start:section.index*100,duration:95}))}});
 expect(created.ok()).toBe(true);
 await expect.poll(async()=>{
   const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
   return jobs[0]?.sectionsDone.length;
 },{timeout:15000}).toBe(manifest.sections.length);
 const jobs=(await(await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
 const map=await(await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
 return {book,ebook,map,manifest};
}
async function start(page:Page,title:string){
 await page.goto("/");
 await page.getByRole("button",{name:`Play ${title}`,exact:true}).click();
 await page.locator(".player-dock").getByRole("button",{name:"Pause",exact:true}).click();
 await page.locator(".dock-book").click();
 await expect(page.getByRole("dialog",{name:"Now playing",exact:true})).toBeVisible();
 await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible();
}
async function showControls(page:Page,scope:string){
 const topbar=page.locator(`${scope} .reader-topbar`);
 if(await topbar.isVisible())return;
 const box=(await page.locator(`${scope} .reader-viewport`).boundingBox())!;
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await expect(topbar).toBeVisible();
}
// Reading mode lives in the More sheet: Now Playing's options panel, or the standalone reader's panel.
async function readingMode(page:Page,scope:string,mode:"Page"|"Lyrics"){
 const room=page.locator(scope);
 if(await room.locator(".reader-topbar").isHidden()){
  // A tap outside the lines toggles the controls in Lyrics mode.
  if(await room.locator(".lyrics-reader").count())await room.locator(".lyrics-reader").evaluate((el:HTMLElement)=>el.click());
  else await showControls(page,scope);
 }
 await room.locator(".reader-topbar").getByRole("button",{name:"More",exact:true}).click();
 await page.locator(".reader-more:visible").getByRole("group",{name:"Reading mode"}).getByRole("button",{name:mode,exact:true}).click();
}
async function checkTransport(page:Page,scope:string){
 const transport=page.locator(scope);
 const previous=transport.getByRole("button",{name:"Rewind 30 seconds",exact:true}),next=transport.getByRole("button",{name:"Forward 30 seconds",exact:true});
 for(const button of [previous,next]){
  const box=(await button.boundingBox())!,icon=(await button.locator("svg").boundingBox())!,label=(await button.locator("span").boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
  expect(Math.abs((label.x+label.width/2)-(icon.x+icon.width/2))).toBeLessThan(1);
  expect(Math.abs((label.y+label.height/2)-(icon.y+icon.height/2))).toBeLessThan(1);
 }
 const left=(await previous.boundingBox())!,right=(await next.boundingBox())!,play=(await transport.getByRole("button",{name:/^(Play|Pause)$/}).boundingBox())!;
 expect(Math.abs((play.x+play.width/2-left.x-left.width/2)-(right.x+right.width/2-play.x-play.width/2))).toBeLessThan(1);
}
async function checkHeading(page:Page){
 const dialog=page.getByRole("dialog",{name:"Now playing",exact:true});
 const centre=async(l:any)=>{const b=(await l.boundingBox())!;return b.y+b.height/2;};
 const close=await centre(dialog.getByRole("button",{name:"Close dialog",exact:true}));
 expect(Math.abs(await centre(dialog.getByRole("button",{name:"Playback options",exact:true}))-close)).toBeLessThan(1);
 expect(Math.abs(await centre(dialog.locator(".now-playing-heading-title"))-close)).toBeLessThan(1);
}
test("page gestures show controls and long-press listens from that sentence",async({page})=>{
 const {ebook,map,manifest}=await fixture(page,"Integrated narration");
 await start(page,"Integrated narration");
 const before=(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint;
 const room=page.locator(".inline-reader");
 await expect(room.locator(".reader-topbar")).toBeHidden();
 // The player bar stays visible while reading.
 await expect(room.getByRole("button",{name:"Play narration",exact:true})).toBeVisible();
 await expect(room.getByRole("slider",{name:/^Seek in /})).toBeHidden();
 await showControls(page,".inline-reader");
 await expect(room.getByRole("slider",{name:/^Seek in /})).toBeVisible();
 const text=page.frameLocator(".inline-reader .reader-viewport iframe").locator("p").nth(1);
 await text.waitFor();
 const box=(await text.boundingBox())!;
 await page.mouse.move(box.x+Math.min(box.width/2,80),box.y+Math.min(box.height/2,10));
 await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
 // Long-press plays the narration from that sentence, with Undo.
 const toast=room.getByRole("status").filter({hasText:"Listening from here"});
 await expect(toast).toBeVisible();
 await expect(room.getByRole("button",{name:"Pause narration",exact:true})).toBeVisible();
 await toast.getByRole("button",{name:"Undo",exact:true}).click();
 await expect(toast).toBeHidden();
 expect((await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint).toEqual(before);
 const target=map.intervals.find((interval:any)=>interval.section===1 && interval.start>105);
 await room.getByRole("button",{name:"Pause narration",exact:true}).click();
 // Page away from the narration, then scrub the narration: the page follows it again.
 const pageBox=(await room.locator(".reader-viewport").boundingBox())!;
 await page.mouse.click(pageBox.x+pageBox.width*0.9,pageBox.y+pageBox.height/2);
 await expect(room).not.toHaveAttribute("data-current-passage",/.+/);
 await showControls(page,".inline-reader");
 const slider=room.getByRole("slider",{name:/^Seek in /});
 await slider.fill(String(Math.ceil(target.start)+1));
 await expect(room).toHaveAttribute("data-current-passage",target.paragraphId);
 await expect(room.locator(".reader-player-info")).toContainText("% of book");
 const more=page.getByRole("region",{name:"Playback options"});
 await showControls(page,".inline-reader");
 await room.getByRole("button",{name:"More",exact:true}).click();
 await more.getByRole("button",{name:"Listen from here"}).click();
 await expect(room).toHaveAttribute("data-current-passage",target.paragraphId);
 await showControls(page,".inline-reader");
 await room.getByRole("button",{name:"More",exact:true}).click();
 await more.getByRole("button",{name:"Read from audio"}).click();
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint?.origin).toBe("listening");
});
test("page controls and lyrics follow the prepared narration",async({page})=>{
 const appearance=await(await page.request.get("/api/appearance")).json();
 await fixture(page,"Lyrics narration","en-GB");
 try {
  await start(page,"Lyrics narration");
  await expect(page.locator(".inline-reader .reader-topbar")).toBeHidden();
  await readingMode(page,".inline-reader","Lyrics");
  const lyrics=page.getByLabel("Lyrics reader");
  await expect(lyrics).toBeVisible();
  await expect(lyrics.locator(".lyrics-line").first()).toBeVisible();
  await lyrics.locator(".lyrics-line").nth(3).click();
  await expect(lyrics.locator(".lyrics-line.current")).toHaveCount(1);
  const player=page.getByRole("region",{name:"Player",exact:true});
  const backToNarration=player.getByRole("button",{name:"Back to narration",exact:true});
  // Always in the player bar between Chapters and Back 30 seconds (#122).
  await expect(backToNarration).toBeVisible();
  await expect(backToNarration).toBeDisabled();
  const order=await player.evaluate((bar)=>{
   const names=["Chapters","Back to narration","Back 30 seconds"];
   const buttons=[...bar.querySelectorAll("button")].filter((button)=>names.includes(button.getAttribute("aria-label")||""));
   return {
    dom:buttons.map((button)=>button.getAttribute("aria-label")),
    visual:[...buttons].sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left).map((button)=>button.getAttribute("aria-label")),
   };
  });
  expect(order.dom).toEqual(["Chapters","Back to narration","Back 30 seconds"]);
  expect(order.visual).toEqual(["Chapters","Back to narration","Back 30 seconds"]);
  await lyrics.hover(); await page.mouse.wheel(0,250);
  await expect(backToNarration).toBeEnabled();
  await backToNarration.click();
  await expect(backToNarration).toBeDisabled();
  await page.setViewportSize({width:320,height:740});
  await page.setViewportSize({width:1440,height:900});
  await expect(lyrics.locator(".lyrics-line.current")).toBeInViewport();
  await readingMode(page,".inline-reader","Page");
  await expect(page.locator(".inline-reader .reader-viewport .sonder-follow").first()).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible();
  // Returning from Lyrics keeps the narrated passage highlighted, also after a resize.
  await expect(page.locator(".inline-reader .reader-viewport .sonder-follow").first()).toBeVisible();
  await page.setViewportSize({width:1440,height:900});
  await expect(page.locator(".inline-reader .reader-viewport .sonder-follow").first()).toBeVisible();
  await expect(page.getByLabel("Contents sidebar")).toBeVisible();
  await expect(page.locator(".inline-reader").getByRole("button",{name:"Previous page",exact:true})).toBeVisible();
  await readingMode(page,".inline-reader","Lyrics");
  await expect(page.getByLabel("Lyrics information")).toBeVisible();
 } finally {await page.request.put("/api/appearance",{data:appearance});}
});

test("opening the reader restores saved audio position without starting playback",async({page})=>{
 const {book,map}=await fixture(page,"Paused reading resume","en-AU");
 const interval=map.intervals.find((i:any)=>i.section===1&&i.start>104),position=interval.start+1;
 expect((await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position,duration:book.tracks[0].duration,updatedAt:Date.now()}})).ok()).toBe(true);
 await page.goto("/");
 await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
 await expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage",interval.paragraphId);
 await expect(page.locator(".inline-reader").getByRole("button",{name:"Play narration",exact:true})).toBeVisible();
 const box=(await page.locator(".inline-reader .reader-viewport").boundingBox())!;
 expect(box.height).toBeGreaterThan(844*.65);
 await expect(page.locator(".inline-reader .reader-viewport .sonder-follow").first()).toBeVisible();
});

test("lyrics without a map remains readable and offers sync setup", async ({page}) => {
 const appearance=await(await page.request.get("/api/appearance")).json();
 try {
 const uploaded=await page.request.post("/api/ebooks/import",{multipart:{file:{name:"Unmapped.epub",mimeType:"application/epub+zip",buffer:await readerFixture()}}});
 expect(uploaded.ok()).toBe(true);
 const {id}=await uploaded.json();
 await page.goto(`/#reader/${id}`);
 // The closed Now Playing reader stays mounted, so scope to the standalone reader.
 const reader=page.getByRole("dialog",{name:"Reader"});
 await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
 await readingMode(page,".reader-dialog","Lyrics");
 await expect(reader.locator(".lyrics-line").first()).toBeVisible();
 await reader.getByRole("button",{name:"Prepare reading sync",exact:true}).click();
 await expect(reader.locator(".reader-panel-heading").getByRole("heading",{name:"Reading sync",exact:true})).toBeVisible();
 } finally { await page.request.put("/api/appearance",{data:appearance}); }
});

test("lyrics keys without a current line and with modifiers leave playback and display alone", async ({page}) => {
 skipOnMobile(true,"needs a hardware keyboard (Control/Alt/Arrow keys)");
 const appearance=await(await page.request.get("/api/appearance")).json();
 const {book,ebook}=await fixture(page,"Lyrics gap","en-IE");
 try {
  // 97 s falls between the two mapped chapters (0–95 s and 100–195 s).
  expect((await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position:97,duration:book.tracks[0].duration,updatedAt:Date.now()}})).ok()).toBe(true);
  await page.setViewportSize({width:1440,height:900});
  await page.goto(`/#reader/${ebook}`);
  const reader=page.getByRole("dialog",{name:"Reader"});
  await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
  await readingMode(page,".reader-dialog","Lyrics");
  const lyrics=reader.getByLabel("Lyrics reader");
  await expect(lyrics.locator(".lyrics-line").first()).toBeVisible();
  await expect(lyrics.locator(".lyrics-line.current")).toHaveCount(0);
  // Browser shortcuts (print, Alt+key) are not reader keys.
  await page.keyboard.press("Control+p");
  await page.keyboard.press("Alt+p");
  await page.waitForTimeout(300);
  await expect(lyrics).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(800);
  await expect(lyrics.locator(".lyrics-line.current")).toHaveCount(0);
  await expect(page.getByRole("button",{name:/^Pause/})).toHaveCount(0);
 } finally { await page.request.put("/api/appearance",{data:appearance}); }
});

test("Contents navigation during a follow jump wins and is saved", async ({page}) => {
 const {book,ebook,map}=await fixture(page,"Follow interrupted","en-NZ");
 const interval=map.intervals.find((i:any)=>i.section===1&&i.start>104);
 expect((await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position:interval.start+1,duration:book.tracks[0].duration,updatedAt:Date.now()}})).ok()).toBe(true);
 await page.setViewportSize({width:1440,height:900});
 await page.goto("/");
 await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
 const room=page.locator(".inline-reader");
 await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
 const sidebar=room.getByLabel("Contents sidebar");
 await sidebar.getByRole("button",{name:"Down the Rabbit-Hole",exact:true}).click();
 await expect(sidebar.getByRole("button",{name:"Down the Rabbit-Hole",exact:true})).toHaveAttribute("aria-current","location");
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint?.locator.section).toBe(0);
 const before=(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint.revision;
 // Start a follow jump to chapter two and choose chapter one before it lands.
 await page.evaluate(()=>{
  const scope=document.querySelector(".inline-reader")!;
  const read=[...document.querySelectorAll<HTMLButtonElement>('.playback-options-panel .reader-more button')].find(b=>b.textContent?.includes("Read from audio"))!;
  const chapter=[...scope.querySelectorAll<HTMLButtonElement>('[aria-label="Contents sidebar"] button')].find(b=>b.textContent==="Down the Rabbit-Hole")!;
  read.click(); chapter.click();
 });
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint.revision).toBeGreaterThan(before);
 await page.waitForTimeout(1500);
 await expect(sidebar.getByRole("button",{name:"Down the Rabbit-Hole",exact:true})).toHaveAttribute("aria-current","location");
 const saved=(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint;
 expect(saved.locator.section).toBe(0);
 expect(saved.origin).toBe("reading");
});

test("back to narration right after a Contents navigation keeps following", async ({page}) => {
 const {book,map}=await fixture(page,"Follow resumed","en-NZ");
 const interval=map.intervals.find((i:any)=>i.section===1&&i.start>104);
 expect((await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position:interval.start+1,duration:book.tracks[0].duration,updatedAt:Date.now()}})).ok()).toBe(true);
 await page.setViewportSize({width:1440,height:900});
 await page.goto("/");
 await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
 const room=page.locator(".inline-reader");
 await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
 const sidebar=room.getByLabel("Contents sidebar");
 // The narrated chapter is also announced as "Narrating".
 const two=sidebar.getByRole("button",{name:/^The Pool of Tears/});
 await expect(two).toHaveAttribute("aria-current","location");
 // Choose chapter one, then go back to the narration within the second after
 // that navigation lands: the follow jump is our own layout, not navigation.
 await page.evaluate(()=>new Promise<void>(done=>{
  const scope=document.querySelector(".inline-reader")!;
  const chapter=[...scope.querySelectorAll<HTMLButtonElement>('[aria-label="Contents sidebar"] button')].find(b=>b.textContent==="Down the Rabbit-Hole")!;
  chapter.click();
  const wait=()=>{
   const back=scope.querySelector<HTMLButtonElement>(".reader-back-narration");
   if(chapter.getAttribute("aria-current")==="location"&&back&&!back.disabled){back.click();done();}
   else requestAnimationFrame(wait);
  };
  wait();
 }));
 await expect(two).toHaveAttribute("aria-current","location");
 await page.waitForTimeout(1500);
 await expect(two).toHaveAttribute("aria-current","location");
 await expect(room.locator(".reader-back-narration")).toBeDisabled();
});

// Records on every animation frame which paragraphs of which chapter are painted in the reader viewport.
async function sampleFrames(page:Page){
 await page.evaluate(()=>{
  const w=window as any;
  w.__frames=[];w.__mark="";
  const tick=()=>{
   const vp=document.querySelector(".inline-reader .reader-viewport")?.getBoundingClientRect();
   const shown:string[]=[];
   if(vp)for(const frame of Array.from(document.querySelectorAll<HTMLIFrameElement>(".inline-reader .reader-viewport iframe"))){
    const doc=frame.contentDocument,box=frame.getBoundingClientRect();
    let hidden=getComputedStyle(frame).visibility!=="visible";
    for(let el:Element|null=frame;el&&!hidden;el=el.parentElement)hidden=getComputedStyle(el).opacity==="0";
    if(!doc||hidden)continue;
    const chapter=doc.querySelector("h1")?.textContent||"";
    for(const p of Array.from(doc.querySelectorAll<HTMLElement>("p[id]"))){
     const r=p.getBoundingClientRect();
     if(r.right+box.left>vp.left+4&&r.left+box.left<vp.right-4&&r.bottom+box.top>vp.top&&r.top+box.top<vp.bottom)shown.push(`${chapter}/${p.id}`);
    }
   }
   w.__frames.push({mark:w.__mark,shown});
   requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
 });
}
for(const [label,viewport] of [["phone",{width:390,height:844}],["desktop",{width:1440,height:900}]] as const)
test(`following narration on ${label} never paints another page on the way`,async({page})=>{
 skipOnMobile(label==="desktop","desktop layout (min-width: 900px) is not reachable on a phone profile");
 await page.setViewportSize(viewport);
 const {map}=await fixture(page,`Follow pages ${label}`);
 await start(page,`Follow pages ${label}`);
 const room=page.locator(".inline-reader");
 await readingMode(page,".inline-reader","Page");
 await sampleFrames(page);
 // The page shown before the first jump is where it starts from.
 await page.waitForFunction(()=>(window as any).__frames.some((f:any)=>f.shown.length));
 const slider=room.getByRole("slider",{name:/^Seek in /});
 // The slider moves in whole seconds.
 const at=(i:any)=>Math.ceil(i.start+0.01);
 const usable=map.intervals.filter((i:any)=>at(i)<i.end);
 const one=usable.filter((i:any)=>i.section===0),two=usable.filter((i:any)=>i.section===1);
 const late=one.length-6;
 // Sentence by sentence on a later page of a chapter, across the chapter end, and long jumps in both directions.
 const jumps:[string,any][]=[
  ["chapter one late",one[late]],
  ["next sentence",one[late+1]],
  ["next sentence again",one[late+2]],
  ["chapter two start",two[0]],
  ["chapter two end",two[two.length-1]],
  ["chapter one end",one[one.length-1]],
  ["chapter two end again",two[two.length-1]],
 ];
 for(const [name,interval] of jumps){
  await page.evaluate((mark)=>{(window as any).__mark=mark;},name);
  await showControls(page,".inline-reader");
  await slider.fill(String(at(interval)));
  await expect(room).toHaveAttribute("data-current-passage",interval.paragraphId);
  await expect(room.locator(".reader-viewport .sonder-follow").first()).toBeVisible();
  await page.waitForTimeout(500);
 }
 const frames:{mark:string;shown:string[]}[]=await page.evaluate(()=>(window as any).__frames);
 for(const [name] of jumps){
  const first=frames.findIndex(f=>f.mark===name);
  const origin=frames.slice(0,first).map(f=>f.shown).filter(s=>s.length).at(-1)||[];
  const painted=frames.filter(f=>f.mark===name).map(f=>f.shown).filter(s=>s.length);
  const target=painted.at(-1)||[];
  expect(painted.length,name).toBeGreaterThan(0);
  // A frame may show the page being left or the page being followed to, nothing else.
  const allowed=new Set([...origin,...target]);
  for(const shown of painted)expect(shown.filter(key=>!allowed.has(key)),name).toEqual([]);
 }
});

test("a cached sync map is not used once the server refuses it", async ({page}) => {
 const appearance=await(await page.request.get("/api/appearance")).json();
 const {ebook}=await fixture(page,"Changed narration","en-ZA");
 try {
  await page.goto(`/#reader/${ebook}`);
  const reader=page.getByRole("dialog",{name:"Reader"});
  await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
  await readingMode(page,".reader-dialog","Lyrics");
  const prompt=reader.getByRole("button",{name:"Prepare reading sync",exact:true});
  await expect(reader.locator(".lyrics-line").first()).toBeVisible();
  // The map is loaded and cached on this device.
  await expect(prompt).toBeHidden();
  // The audio changes in place: the job summary is unchanged, but the server
  // no longer serves the map.
  await page.route("**/api/alignments/*/map",route=>route.fulfill({status:410,json:{error:"The ebook or audio changed. Rebuild this alignment before using it.",code:"alignment_stale"}}));
  await page.reload();
  await expect(reader.locator(".lyrics-line").first()).toBeVisible();
  // The prompt also shows briefly before a cached map loads; give that time.
  await page.waitForTimeout(1500);
  await expect(prompt).toBeVisible();
 } finally { await page.request.put("/api/appearance",{data:appearance}); }
});

test("a cached sync map survives a server that is restarting", async ({page}) => {
 const appearance=await(await page.request.get("/api/appearance")).json();
 const {ebook}=await fixture(page,"Restarting server","en-IE");
 try {
  await page.goto(`/#reader/${ebook}`);
  const reader=page.getByRole("dialog",{name:"Reader"});
  await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
  await readingMode(page,".reader-dialog","Lyrics");
  const prompt=reader.getByRole("button",{name:"Prepare reading sync",exact:true});
  await expect(reader.locator(".lyrics-line").first()).toBeVisible();
  await expect(prompt).toBeHidden();
  for(const failure of [
   {status:502,contentType:"text/html",body:"<html><body>Bad gateway</body></html>"},
   {status:503,json:{error:"The media drive is not available."}},
   {status:400,json:{error:"ENOENT: no such file or directory"}},
  ]){
   await page.unrouteAll({behavior:"wait"});
   await page.route("**/api/alignments/*/map",route=>route.fulfill(failure));
   await page.reload();
   await expect(reader.locator(".lyrics-line").first()).toBeVisible();
   await page.waitForTimeout(1500);
   await expect(prompt).toBeHidden();
   expect(await page.evaluate(async()=>{
    const names=(await indexedDB.databases()).map(d=>d.name).filter(n=>n?.startsWith("sonder"));
    for(const name of names){
     const db=await new Promise<IDBDatabase>((ok,fail)=>{const r=indexedDB.open(name!);r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});
     if(!db.objectStoreNames.contains("preferences")){db.close();continue;}
     const keys=await new Promise<IDBValidKey[]>(ok=>{const r=db.transaction("preferences").objectStore("preferences").getAllKeys();r.onsuccess=()=>ok(r.result);});
     db.close();
     if(keys.some(k=>String(k).startsWith("reader-map:")))return true;
    }
    return false;
   })).toBe(true);
  }
 } finally { await page.request.put("/api/appearance",{data:appearance}); }
});
