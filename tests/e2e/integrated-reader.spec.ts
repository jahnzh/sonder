import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
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
test("page gestures expose controls and sentence actions",async({page})=>{
 const {ebook,map,manifest}=await fixture(page,"Integrated narration");
 await start(page,"Integrated narration");
 const before=(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint;
 const room=page.locator(".inline-reader");
 await expect(room.locator(".reader-page-actions")).toBeHidden();
 const frameBox=(await page.locator(".reader-viewport").boundingBox())!;
 await page.mouse.click(frameBox.x+frameBox.width/2,frameBox.y+100);
 await expect(room.locator(".reader-page-actions")).toBeVisible();
 await expect(room.getByRole("slider",{name:"Book progress"})).toBeVisible();
 const text=page.frameLocator(".reader-viewport iframe").locator("p").first();
 await text.waitFor();
 const box=(await text.boundingBox())!;
 await page.mouse.move(box.x+Math.min(box.width/2,80),box.y+Math.min(box.height/2,10));
 await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
 const sheet=room.getByRole("dialog",{name:"Sentence actions"});
 await expect(sheet).toBeVisible();
 await expect(sheet.getByRole("button",{name:"Listen from here"})).toBeVisible();
 await expect(sheet.getByText(/Estimated audio time|Audio time/)).toBeVisible();
 await sheet.getByRole("button",{name:"Close sentence actions"}).click();
 expect((await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint).toEqual(before);
 const passages=manifest.sections.flatMap((section:any)=>section.paragraphs);
 const target=map.intervals.find((interval:any)=>interval.section===1 && interval.start>105);
 const index=passages.findIndex((passage:any)=>passage.id===target.paragraphId);
 await room.getByRole("slider",{name:"Book progress"}).fill(String(Math.round(index/(passages.length-1)*1000)));
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint?.locator.paragraphId).toBe(target.paragraphId);
 const sync=room.getByRole("group",{name:"Sync reading and audio positions"});
 await sync.getByRole("button",{name:"Listen from here"}).click();
 await expect(room).toHaveAttribute("data-current-passage",target.paragraphId);
 await sync.getByRole("button",{name:"Read from audio"}).click();
 await expect.poll(async()=>(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint?.origin).toBe("listening");
});
test("page controls and lyrics follow the prepared narration",async({page})=>{
 const appearance=await(await page.request.get("/api/appearance")).json();
 await fixture(page,"Lyrics narration","en-GB");
 try {
  await start(page,"Lyrics narration");
  const controls=page.locator(".inline-reader .reader-page-actions");
  await expect(controls).toBeHidden();
  const display=page.locator(".now-playing-transport").getByRole("button",{name:"Lyrics",exact:true});
  await expect(display).toBeVisible();
  await display.click();
  const lyrics=page.getByLabel("Lyrics reader");
  await expect(lyrics).toBeVisible();
  await expect(lyrics.locator(".lyrics-line").first()).toBeVisible();
  await lyrics.locator(".lyrics-line").nth(3).click();
  await expect(lyrics.locator(".lyrics-line.current")).toHaveCount(1);
  await lyrics.hover(); await page.mouse.wheel(0,250);
  await expect(page.getByRole("button",{name:"Back to narration"})).toBeVisible();
  await page.getByRole("button",{name:"Back to narration"}).click();
  await expect(page.getByRole("button",{name:"Back to narration"})).toBeHidden();
  await page.locator(".now-playing-transport").getByRole("button",{name:"Page",exact:true}).click();
  await expect(page.locator(".reader-viewport iframe")).toBeVisible();
  await page.setViewportSize({width:1440,height:900});
  await expect(page.getByLabel("Contents sidebar")).toBeVisible();
  await expect(page.getByRole("button",{name:"Previous ebook page",exact:true})).toBeVisible();
  await page.locator(".now-playing-transport").getByRole("button",{name:"Lyrics",exact:true}).click();
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
 await page.getByRole("button",{name:"Show reader controls"}).click();
 await expect(page.getByRole("button",{name:"Play reader audio",exact:true})).toBeVisible();
 const box=(await page.locator(".reader-viewport").boundingBox())!;
 expect(box.height).toBeGreaterThan(844*.65);
 await expect(page.locator(".reader-viewport .sonder-follow").first()).toBeVisible();
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
 await reader.getByRole("button",{name:"Show reader controls"}).click();
 await reader.locator(".reader-page-actions").getByRole("button",{name:"Lyrics",exact:true}).click();
 await expect(reader.locator(".lyrics-line").first()).toBeVisible();
 await reader.getByRole("button",{name:"Prepare reading sync",exact:true}).click();
 await expect(reader.locator(".reader-panel-heading").getByRole("heading",{name:"Reading sync",exact:true})).toBeVisible();
 } finally { await page.request.put("/api/appearance",{data:appearance}); }
});
