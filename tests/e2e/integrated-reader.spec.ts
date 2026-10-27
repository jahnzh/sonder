import {test,expect,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
test.afterEach(async({page})=>{await page.unrouteAll({behavior:"wait"});});
async function fixture(page:Page,title:string,language="en"){
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
test("normal playback shows the ebook by default and follows paused seeks across sections without jump notifications or checkpoint writes",async({page})=>{
 const {ebook,map}=await fixture(page,"Integrated narration");
 await start(page,"Integrated narration");
 await expect(page.getByRole("dialog",{name:"Reader",exact:true})).toHaveCount(0);
 await expect(page.getByRole("button",{name:"Following audio",exact:true})).toBeHidden();
 await expect(page.getByRole("button",{name:"Playback options",exact:true})).toHaveAttribute("aria-expanded","false");
 await checkTransport(page,".now-playing-dialog .transport.large");await checkHeading(page);
 const before=(await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint;
 const target=map.intervals.find((i:any)=>i.section===1 && i.start>104);
 await page.getByRole("slider",{name:"Seek in audiobook",exact:true}).fill(String(target.start+1));
 await expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage",target.paragraphId);
 await expect(page.locator(".reader-viewport .sonder-follow").first()).toBeVisible();
 await expect(page.frameLocator(".reader-viewport iframe").locator("h1")).toContainText("The Pool of Tears");
 await page.getByRole("dialog",{name:"Now playing",exact:true}).getByRole("button",{name:"Play",exact:true}).click();
 await expect.poll(()=>page.locator(".inline-reader").getAttribute("data-current-passage")).not.toBe(target.paragraphId);
 await page.getByRole("dialog",{name:"Now playing",exact:true}).getByRole("button",{name:"Pause",exact:true}).click();
 await expect(page.locator(".toast")).toHaveCount(0);
 expect((await(await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint).toEqual(before);
 const box=(await page.locator(".reader-viewport").boundingBox())!;
 const controls=(await page.getByRole("slider",{name:"Seek in audiobook",exact:true}).boundingBox())!;
 expect(box.height).toBeGreaterThan(844*.65);expect(controls.y+controls.height).toBeLessThanOrEqual(844);
 const surface=await page.getByRole("dialog",{name:"Now playing",exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor);
 await expect(page.frameLocator(".reader-viewport iframe").locator("body")).toHaveCSS("background-color",surface);
 const contrast=await page.frameLocator(".reader-viewport iframe").locator("body").evaluate(el=>{
   const style=getComputedStyle(el);
   const luminance=(color:string)=>{
     const rgb=color.match(/\d+/g)!.slice(0,3).map(v=>Number(v)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
     return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
   };
   const a=luminance(style.color),b=luminance(style.backgroundColor);
   return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
 });
 expect(contrast).toBeGreaterThan(7);
 await page.screenshot({path:"artifacts/integrated-reader-mobile.png"});
 await page.getByRole("button",{name:"Playback options",exact:true}).click();
 await expect(page.getByRole("region",{name:"Playback options",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Versions & sources",exact:true})).toBeVisible();
 await page.screenshot({path:"artifacts/integrated-reader-options-mobile.png"});
 await page.getByRole("button",{name:"Search this book",exact:true}).click();
 await expect(page.getByRole("searchbox",{name:"Search inside ebook",exact:true})).toBeVisible();
 await expect(page.getByRole("region",{name:"Playback options",exact:true})).toBeHidden();
 await page.getByRole("button",{name:"Close reader options",exact:true}).click();
 await page.getByRole("button",{name:"Playback options",exact:true}).click();
 await page.keyboard.press("Escape");
 await expect(page.getByRole("button",{name:"Playback options",exact:true})).toBeFocused();
 await expect(page.getByRole("dialog",{name:"Now playing",exact:true})).toBeVisible();
 await expect(page.getByRole("region",{name:"Playback options",exact:true})).toBeHidden();
 await page.setViewportSize({width:1440,height:1000});
 await checkTransport(page,".now-playing-dialog .transport.large");await checkHeading(page);
 await expect(page.locator(".reader-viewport .sonder-follow").first()).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(1440);
 await page.screenshot({path:"artifacts/integrated-reader-desktop.png"});
 await page.getByRole("dialog",{name:"Now playing",exact:true}).getByRole("button",{name:"Close dialog",exact:true}).click();
 for(const width of [320,390,1024,1440]){
   await page.setViewportSize({width,height:844});
   await checkTransport(page,".player-dock .transport");
   expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
 }
});
test("current-segment mode shows the chosen number of words, follows narration, and persists its settings",async({page})=>{
 const appearance=await(await page.request.get("/api/appearance")).json();
 const {book,ebook,map}=await fixture(page,"Segment narration","en-GB");
 try {
  await start(page,"Segment narration");
  await page.getByRole("button",{name:"Playback options",exact:true}).click();
  await page.getByRole("combobox",{name:"Reader display",exact:true}).selectOption("segment");
  await page.getByRole("spinbutton",{name:"Words per segment",exact:true}).fill("12");
  await page.getByRole("button",{name:"Close playback options",exact:true}).click();
  const interval=map.intervals.find((i:any)=>i.section===0 && i.start>6 && i.end-i.start>1);
  await page.getByRole("slider",{name:"Seek in audiobook",exact:true}).fill(String(interval.start+1));
  await expect(page.locator(".reader-segment [data-word]")).toHaveCount(12);
  await expect(page.getByRole("article",{name:"Current ebook segment",exact:true})).toBeVisible();
  await expect(page.locator(".reader-viewport iframe")).toBeHidden();
  await expect(page.locator(".reader-segment [data-active-word]")).toHaveCount(1);
  await expect(page.getByText("Estimated word position",{exact:true})).toBeHidden();
  const first=await page.locator(".reader-segment").innerText();
  const next=map.intervals.find((i:any)=>i.section===1 && i.start>108);
  await page.getByRole("slider",{name:"Seek in audiobook",exact:true}).fill(String(next.start+1));
  await expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage",next.paragraphId);
  await expect.poll(()=>page.locator(".reader-segment").innerText()).not.toBe(first);
  await expect(page.locator(".toast")).toHaveCount(0);
  await page.getByRole("button",{name:"Playback options",exact:true}).click();
  await page.getByRole("spinbutton",{name:"Words per segment",exact:true}).fill("80");
  await page.getByRole("button",{name:"Close playback options",exact:true}).click();
  await expect(page.locator(".reader-segment [data-word]")).toHaveCount(80);
  await expect.poll(async()=>{
    const host=(await page.locator(".reader-segment").boundingBox())!,word=(await page.locator(".reader-segment [data-active-word]").boundingBox())!;
    return word.y>=host.y && word.y+word.height<=host.y+host.height;
  }).toBe(true);
  await page.getByRole("button",{name:"Playback options",exact:true}).click();
  await page.getByRole("spinbutton",{name:"Words per segment",exact:true}).fill("12");
  await page.getByRole("button",{name:"Close playback options",exact:true}).click();
  await expect.poll(async()=>(await(await page.request.get("/api/appearance")).json()).reader.segmentWords).toBe(12);
  await page.screenshot({path:"artifacts/integrated-reader-segment-mobile.png"});
  await page.setViewportSize({width:320,height:740});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);
  expect((await page.getByRole("slider",{name:"Seek in audiobook",exact:true}).boundingBox())!.y+44).toBeLessThanOrEqual(740);
  await page.reload();
  await page.getByRole("button",{name:`Play ${book.title}`,exact:true}).click();
  await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
  await expect(page.locator(".reader-segment [data-word]")).toHaveCount(12);
  await page.getByRole("button",{name:"Playback options",exact:true}).click();
  await expect(page.getByRole("combobox",{name:"Reader display",exact:true})).toHaveValue("segment");
  await expect(page.getByRole("spinbutton",{name:"Words per segment",exact:true})).toHaveValue("12");
  await expect(page.locator(".reader-segment [data-word]")).toHaveCount(12);
 } finally {await page.request.put("/api/appearance",{data:appearance});}
});

test("opening the reader restores saved audio position without starting playback",async({page})=>{
 const {book,map}=await fixture(page,"Paused reading resume","en-AU");
 const interval=map.intervals.find((i:any)=>i.section===1&&i.start>104),position=interval.start+1;
 expect((await page.request.post("/api/progress",{data:{recordingId:book.recordingId,trackId:book.tracks[0].id,position,duration:book.tracks[0].duration,updatedAt:Date.now()}})).ok()).toBe(true);
 await page.goto("/");
 await page.getByRole("button",{name:"Open ebook reader",exact:true}).click();
 await expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage",interval.paragraphId);
 await expect(page.getByRole("slider",{name:"Seek in audiobook",exact:true})).toHaveValue(String(position));
 await expect(page.getByRole("dialog",{name:"Now playing",exact:true}).getByRole("button",{name:"Play",exact:true})).toBeVisible();
 const box=(await page.locator(".reader-viewport").boundingBox())!;
 expect(box.height).toBeGreaterThan(844*.65);
 await expect(page.locator(".reader-viewport .sonder-follow").first()).toBeVisible();
});
