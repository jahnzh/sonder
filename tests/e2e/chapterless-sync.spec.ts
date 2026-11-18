import {test,expect} from "@playwright/test";
import {readFileSync} from "node:fs";
import {readerFixture} from "../reader-fixture";
test("a single audio file without chapter markers gets reading sync prepared automatically from narration samples",async({page})=>{
 const audio=await page.request.post("/api/import",{multipart:{title:"Chapterless narration",author:"Lewis Carroll",files:{name:"Complete book.mp3",mimeType:"audio/mpeg",buffer:readFileSync("server/demo/alice-01.mp3")}}});
 expect(audio.ok()).toBe(true);
 const bookId=(await audio.json()).id;
 const book=(await(await page.request.get("/api/books")).json()).find((b:any)=>b.id===bookId);
 expect(book.tracks).toHaveLength(1);
 expect(book.tracks[0].chapters??[]).toHaveLength(0);
 const upload=await page.request.post(`/api/ebooks/import?workId=${book.workId}`,{multipart:{file:{name:"Chapterless companion.epub",mimeType:"application/epub+zip",buffer:await readerFixture()}}});
 expect(upload.ok()).toBe(true);
 const id=(await upload.json()).id;
 await page.goto(`/#reader/${id}`);
 await expect(page.getByRole("dialog",{name:"Reader"})).toBeVisible();
 const reader=page.locator(".reader-dialog");
 await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
 const viewport=(await reader.locator(".reader-viewport").boundingBox())!;
 await page.mouse.click(viewport.x+viewport.width/2,viewport.y+viewport.height/2);
 await reader.getByRole("button",{name:"More",exact:true}).click();
 await reader.locator(".reader-more").getByRole("button",{name:"Reading sync",exact:true}).click();
 // Importing with a workId queues the backfill job; the alignment stub finishes it almost at once.
 await expect.poll(async()=>{
  const jobs=(await(await page.request.get(`/api/alignments?ebookId=${id}`)).json()).jobs;
  return jobs.some((j:any)=>j.recordingId===book.recordingId&&j.origin==="backfill"&&j.mode==="anchored"&&j.anchoring?.anchors?.length>0);
 },{timeout:20000}).toBe(true);
 // More › Reading sync opens the Reading sync page (#543): Ready or Partly ready there.
 await reader.locator(".reader-panel").getByRole("button",{name:/^Reading sync/}).click();
 const sync=page.locator(".reading-sync-page");
 await expect(sync).toHaveAttribute("data-state",/^(ready|partial)$/,{timeout:20000});
 await expect(sync.locator(".reading-sync-block .part-group > li").first()).toHaveText(/^(Ready|Partly ready)/);
 const job=(await(await page.request.get(`/api/alignments?ebookId=${id}`)).json()).jobs.find((j:any)=>j.origin==="backfill");
 expect(job.mode).toBe("anchored");
 expect(job.anchoring.anchors.length).toBeGreaterThanOrEqual(3);
 expect(job.coverage).toBeGreaterThan(.5);
 await expect(page.getByRole("button",{name:"Mark alignment reviewed",exact:true})).toHaveCount(0);
 await page.screenshot({path:"artifacts/chapterless-sync.png"});
 // Details: the older engine's line and its flags.
 await sync.getByRole("button",{name:/^Details/}).click();
 const details=page.locator(".reading-sync-details");
 await expect(details.getByRole("heading",{level:1,name:"Details",exact:true})).toBeVisible();
 await expect(details).toContainText(/\d+ anchors · (\d+) of \1 passages aligned/);
 await expect(details.locator(".reading-sync-flag")).toHaveCount(job.anchoring.flags.length);
 await expect.poll(async()=>(await(await page.request.get(`/api/alignments/${job.id}/map`)).json()).intervals.every((i:any)=>i.verified===undefined)).toBe(true);
});
