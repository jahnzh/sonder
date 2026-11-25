// @projects firefox, webkit
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { gotoRead } from "./read-face";
// A document named .html whose title is written <title/> (#812, The Picture of Dorian Gray in Delphi's Parts Edition):
// parsed as HTML, the title never ends and takes the page with it (epub.js did so, #812). The reader shows its text.

test.use({ serviceWorkers: "block" });
const imported: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

const TITLE_PAGE = "The Complete Works of a careful author.";
const CHAPTER = "The studio was filled with the rich odour of roses.";

async function emptyTitleEpub(title: string) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    "content.opf",
    `<?xml version='1.0' encoding='utf-8'?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uuid_id" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="uuid_id" opf:scheme="uuid">sonder-empty-title</dc:identifier><dc:title>${title}</dc:title><dc:creator opf:role="aut">Reader QA</dc:creator><dc:language>en</dc:language></metadata><manifest><item href="002.html" id="front" media-type="application/xhtml+xml"/><item href="013.html" id="chapter" media-type="application/xhtml+xml"/><item href="toc.ncx" id="ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="front"/><itemref idref="chapter"/></spine></package>`,
  );
  zip.file(
    "toc.ncx",
    `<?xml version='1.0' encoding='utf-8'?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="sonder-empty-title"/></head><docTitle><text>${title}</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Title page</text></navLabel><content src="002.html"/></navPoint><navPoint id="n2" playOrder="2"><navLabel><text>Chapter I</text></navLabel><content src="013.html"/></navPoint></navMap></ncx>`,
  );
  // The head as the book writes it: the empty title between a link and a meta, all self-closing.
  zip.file(
    "002.html",
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"> <head> <meta content="application/xhtml+xml; charset=utf-8" http-equiv="Content-Type"/> <title/> <meta content="urn:uuid:0" name="Adept.expected.resource"/> </head> <body> <p class="p0"><a id="a4"/> </p> <p class="p1"><span class="t2">${TITLE_PAGE}</span></p> <h1 class="h10"><a id="ncx3"/><span class="th11">A CAREFUL AUTHOR</span></h1> </body> </html>`,
  );
  zip.file(
    "013.html",
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>Chapter I</title></head><body><h2>CHAPTER I</h2><p>${CHAPTER}</p></body></html>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("a .html page whose title is written <title/> shows its text", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const title = `Empty title ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Reader QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((entry: { id: string }) => entry.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "EmptyTitle.epub", mimeType: "application/epub+zip", buffer: await emptyTitleEpub(title) } } });
  expect(uploaded.ok()).toBe(true);
  await gotoRead(page, (await uploaded.json()).id as string);
  const text = page.locator(".reader-room .reader-viewport .prepared-text");
  // The book opens on its first page, the one with the empty title.
  await expect(text.getByText(TITLE_PAGE)).toBeVisible();
  await expect(text.getByText("A CAREFUL AUTHOR", { exact: true })).toBeVisible();
  // Nothing of the page ended up in a title: not the app's, and no title element in the text.
  expect(await page.title()).not.toContain(TITLE_PAGE);
  await expect(text.locator("title")).toHaveCount(0);
  expect(errors).toEqual([]);
});
