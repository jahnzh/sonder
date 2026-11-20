// @projects firefox
// The slice pass (#794, scripts/verify-slice-pass.mjs) against the suite's server: the same walk the deploy runs on
// production, at 390 by 844 and 1280 by 800, on a book with audio, an EPUB and a narration map, and an ebook-only book
// made here first. Every item passes, a screenshot of each is written, and no write reaches the server: what the server
// holds for both books and the appearance is the same before and after.
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { PACED_MARKER } from "../page-turn-fixture";
// @ts-expect-error a script without types
import { runSlicePass } from "../../scripts/verify-slice-pass.mjs";

const OUT = "artifacts/slice-pass-local";
const works: string[] = [];

test.afterEach(async ({ page }) => {
  for (const workId of works.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

// Narrated at reading pace by the alignment fixture (PACED_MARKER): each sentence lasts by its length, so the long ones
// below are more than 4 s, as the reader check's samples need (live-reader-samples.mjs).
const sentence = (n: number, i: number) => `In chapter ${n} sentence ${i + 1} walks on past the long garden wall and the quiet orchard, past the river where the boats are tied, and on along the road that climbs the hill towards the town before it stops.`;
const chapter = (n: number) => `<p>${PACED_MARKER}</p>` + Array.from({ length: 4 }, (_, p) => `<p>${Array.from({ length: 3 }, (_, i) => sentence(n, p * 3 + i)).join(" ")}</p>`).join("");
// A book with the suite's audio, an EPUB of two chapters and a narration map: chapter one from 0 s, chapter two from 200 s.
async function narrated(page: Page, title: string) {
  const response = await page.request.post("/api/import", { multipart: { title, author: "Slice QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  works.push(book.workId);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Slice.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title, bodies: [chapter(1), chapter(2)] }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const created = await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings: manifest.sections.map((section: any) => ({ section: section.index, trackId: book.tracks[0].id, start: section.index * 200, duration: 190 })) } });
  expect(created.ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 15000 }).toBe(manifest.sections.length);
  return { book, ebook };
}

/** An EPUB imported on its own: its work joins the library with no recording (#555). */
async function ebookOnly(page: Page, title: string) {
  const response = await page.request.post("/api/ebooks/import", { multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const ebook = ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === id)!;
  works.push(ebook.workId);
  return ebook;
}

/** What the server holds that the walk could change: progress, reading places, bookmarks, the library, appearance. */
async function serverState(page: Page, ebooks: string[]) {
  const json = async (path: string) => (await page.request.get(path)).json();
  const books = (await json("/api/books")).map((b: any) => ({ id: b.id, inLibrary: b.inLibrary, status: b.status, progress: b.progress ?? null }));
  const readers = await Promise.all(ebooks.map(async (id) => { const r = await json(`/api/reader/${encodeURIComponent(id)}`); return { id, checkpoint: r.checkpoint ?? null, bookmarks: r.bookmarks ?? [] }; }));
  const library = (await json("/api/library")).map((w: any) => ({ workId: w.workId, inLibrary: w.inLibrary, finished: w.finished, wantToRead: w.wantToRead ?? null }));
  return { books, readers, library, appearance: await json("/api/appearance") };
}

test("the slice pass walks every item at 390 by 844 and 1280 by 800 against the suite's server, and writes nothing", async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000);
  const run = randomUUID().slice(0, 8);
  const { book, ebook } = await narrated(page, `Slice pass ${run}`);
  const alone = await ebookOnly(page, `Slice alone ${run}`);
  const before = await serverState(page, [ebook, alone.id]);
  rmSync(OUT, { recursive: true, force: true });
  const report = await runSlicePass({
    browser,
    baseURL,
    out: OUT,
    preferred: book.recordingId,
    preferredEbookWork: alone.workId,
    // The suite's server would ask AudioBookBay and Prowlarr for the Get sheet's search: answered here, empty.
    prepareContext: async (context: any) => {
      await context.route("**/api/discover/abb/releases?*", (route: any) => route.fulfill({ json: { results: [], nextPage: null } }));
      await context.route("**/api/discover/prowlarr/releases?*", (route: any) => route.fulfill({ json: { results: [] } }));
    },
  });
  // The report the live check writes to artifacts/, here beside the screenshots.
  writeFileSync(`${OUT}/slice-pass-verification-${test.info().project.name}.json`, JSON.stringify(report, null, 2));
  expect(report.errors).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.skipped).toEqual([]);
  expect(report.selection).toMatchObject({ recordingId: book.recordingId, ebookId: ebook, ebookOnly: { workId: alone.workId } });
  const names = report.checks.map((c: any) => `${c.size}: ${c.name}`);
  for (const size of ["phone", "desktop"])
    for (const item of [
      "Discover search", "The Get sheet opened and closed", "A Book page", "Library chips", "The Shelf picker",
      "Settings › Account", "Settings › Appearance", "Settings › Playback", "Settings › Connections", "Settings › Users", "Settings › Library and storage", "Settings › App",
      "The offline line", "Read in Now playing on the narrated sentence", "A tap that moves nothing shows the controls",
      "Appearance opened and closed with the narrated sentence kept", "The sleep timer from the foot", "Search, a bookmark and Back to narration",
      "A long-press listens from the sentence and Undo returns", "The face remembered across a reopen", "An ebook-only book on Read with its slider and no narration",
    ]) expect(names).toContain(`${size}: ${item}`);
  // A screenshot of each step, at both sizes.
  expect(report.screenshots.length).toBeGreaterThanOrEqual(2 * 22);
  for (const file of report.screenshots) expect(existsSync(file), file).toBe(true);
  // The app's writes (progress, the reading place, the bookmark and its removal) were answered in the browser...
  expect(report.writes.length).toBeGreaterThan(0);
  expect(report.protectedWrites).toBeGreaterThanOrEqual(report.writes.length);
  // ...and none reached the server.
  expect(await serverState(page, [ebook, alone.id])).toEqual(before);
});
