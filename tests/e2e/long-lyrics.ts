import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { longBookFixture } from "../long-book-fixture";
import { READER_WAIT_MS } from "./timing";
// The long book of #428: 30 chapters of 600 sentences (18,000 sentences) and one 640 s narration file. The browser
// fixture times each sentence at 2 s from its pairing's start, so the map covers the first 150 sentences of the first
// chapter (0–300 s) and the first 150 of the last chapter (320–620 s); the rest of the book has no interval.
export const LONG_CHAPTERS = 30;
export const LONG_SENTENCES = 600;
export const LAST_CHAPTER_START = 320;
export async function longLyricsBook(page: Page, title: string, imported: string[]) {
  const audio = readFileSync("server/demo/alice-01.mp3");
  const response = await page.request.post("/api/import", { multipart: { title, author: "Reader QA", file0: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: audio } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const epub = await longBookFixture({ chapters: LONG_CHAPTERS, sentences: LONG_SENTENCES, title });
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Long.epub", mimeType: "application/epub+zip", buffer: epub } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id;
  const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const last = manifest.sections[manifest.sections.length - 1].index;
  const created = await page.request.post("/api/alignments", {
    data: {
      ebookId: ebook,
      recordingId: book.recordingId,
      pairings: [
        { section: manifest.sections[0].index, trackId: book.tracks[0].id, start: 0, duration: 300 },
        { section: last, trackId: book.tracks[0].id, start: LAST_CHAPTER_START, duration: 300 },
      ],
    },
  });
  expect(created.ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 30000 }).toBe(2);
  const jobs = (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
  const map = await (await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
  return { book, ebook, manifest, map };
}
// The player at `position` of the file, then the inline reader opened from the home page, as back-to-narration.spec.ts does.
export async function openLongAt(page: Page, book: any, position: number) {
  await page.goto("about:blank");
  const books = await (await page.request.get("/api/books")).json();
  const previous = books.find((b: any) => b.recordingId === book.recordingId)?.progress?.updatedAt || 0;
  const response = await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position, duration: book.tracks[0].duration, updatedAt: Math.max(Date.now(), previous + 1) } });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open ebook reader", exact: true }).click();
  await expect(page.frameLocator(".inline-reader .reader-viewport iframe").locator("p").first()).toBeAttached({ timeout: READER_WAIT_MS.followHighlight });
}
export async function withReaderDisplay(page: Page, display: "book" | "segment", run: () => Promise<void>) {
  const appearance = await (await page.request.get("/api/appearance")).json();
  await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, display } } });
  try {
    await run();
  } finally {
    await page.request.put("/api/appearance", { data: appearance });
  }
}
