// @projects firefox, webkit-iphone-now-playing
import { test, expect, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { longBookFixture } from "../long-book-fixture";
import { readerFixture } from "../reader-fixture";
import { preparedFixture, tinyPng } from "../prepared-text-fixture";
import { installReaderWaitBudget, READER_WAIT_MS } from "./timing";
import { highlightShown, textShown } from "./reader-view";
import { gotoRead } from "./read-face";
// The reading view in scroll mode (#802, step 3 of the reader plan #799; ADR 0025; the only view since #806): the
// server's prepared text in the application's own page. What is its own is checked here: what an open asks the
// server for, the guard on a part's HTML, the text's length against the manifest, and that places and bookmarks,
// also those the earlier EPUB reader saved with a CFI, open on their sentence.
test.use({ serviceWorkers: "block" });
installReaderWaitBudget(test);
const imported: string[] = [];
// Everything here is about the view in scroll mode; pages mode has its own spec (prepared-pages.spec.ts).
let appearance: any = null;
test.beforeEach(async ({ page }) => {
  appearance = await (await page.request.get("/api/appearance")).json();
  expect((await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, mode: "scroll" } } })).ok()).toBe(true);
});
test.afterEach(async ({ page }) => {
  if (appearance) await page.request.put("/api/appearance", { data: appearance });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

type Opened = { book: any; ebook: string; sentences: any; map: any };
/** A recording with an EPUB and, with `pairings`, a reading sync map of it. */
async function bookWith(page: Page, title: string, epub: Buffer, pairings?: (sentences: any, book: any) => object[]): Promise<Opened> {
  const response = await page.request.post("/api/import", { multipart: { title, author: "Reader QA", file0: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((entry: any) => entry.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Book.epub", mimeType: "application/epub+zip", buffer: epub } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id;
  const sentences = await (await page.request.get(`/api/reader/${ebook}`)).json();
  let map: any = null;
  if (pairings) {
    const wanted = pairings(sentences, book);
    expect((await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings: wanted } })).ok()).toBe(true);
    await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 30000 }).toBe(wanted.length);
    const jobs = (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
    map = await (await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
  }
  return { book, ebook, sentences, map };
}
// The long book of #428: 30 chapters of 600 sentences and one narration file whose map covers the first 150
// sentences of chapter 1 (0–300 s) and the first 150 of chapter 30 (320–620 s).
const longBook = async (page: Page, title: string) =>
  bookWith(page, title, await longBookFixture({ chapters: 30, sentences: 600, title }), (sentences, book) => [
    { section: sentences.sections[0].index, trackId: book.tracks[0].id, start: 0, duration: 300 },
    { section: sentences.sections.at(-1).index, trackId: book.tracks[0].id, start: 320, duration: 300 },
  ]);
/** The player's saved place for the recording, so the reader opens following that sentence. */
async function narrateAt(page: Page, book: any, position: number) {
  const books = await (await page.request.get("/api/books")).json();
  const previous = books.find((entry: any) => entry.recordingId === book.recordingId)?.progress?.updatedAt || 0;
  expect((await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position, duration: book.tracks[0].duration, updatedAt: Math.max(Date.now(), previous + 1) } })).ok()).toBe(true);
}
const band = (page: Page) => page.locator(".reader-room .reader-viewport");
const pathOf = (request: Request) => new URL(request.url()).pathname;
/** What a part of the page's requests asked the server for, by path. */
function counted(page: Page) {
  const paths: string[] = [];
  page.on("request", (request) => paths.push(pathOf(request)));
  return {
    paths,
    of: (pattern: RegExp) => paths.filter((path) => pattern.test(path)),
  };
}

test("an open asks for each resource once, loads only the part it shows, and neither the sentences, the EPUB, epub.js nor DOMPurify", async ({ page }) => {
  test.setTimeout(120000);
  const { book, ebook, map } = await longBook(page, `Requests ${randomUUID()}`);
  const manifest = await (await page.request.get(`/api/reader/${ebook}/prepared`)).json();
  expect(manifest.parts.length).toBeGreaterThan(8);
  // The narration is in the last chapter: the place being opened is far into the book.
  const last = map.intervals.filter((interval: any) => interval.section === manifest.sections.at(-1).index).sort((a: any, b: any) => a.start - b.start);
  await narrateAt(page, book, last[20].start + 0.5);
  const requests = counted(page);
  await gotoRead(page, ebook);
  const room = page.locator(".reader-room");
  await expect(room).toHaveAttribute("data-current-passage", last[20].paragraphId, { timeout: READER_WAIT_MS.followHighlight });
  await expect.poll(() => highlightShown(room), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
  await expect(room.locator(".reader-loading")).toHaveCount(0);
  // Let anything the open still starts be asked for.
  await page.waitForTimeout(1500);
  const reader = `/api/reader/${ebook}`;
  const once = (path: string) => requests.paths.filter((entry) => entry === path).length;
  expect(once(`${reader}/prepared`), "the manifest").toBe(1);
  expect(once(`${reader}/state`), "the user's place and bookmarks").toBe(1);
  expect(once(reader), "the book's sentences").toBe(0);
  expect(requests.of(/^\/api\/ebooks\/[^/]+\/file$/), "the EPUB file").toEqual([]);
  expect(requests.of(/^\/api\/alignments\/[^/]+\/map$/).length, "the reading sync map").toBe(1);
  const parts = requests.of(/\/prepared\/[0-9a-f]+\/parts\/\d+$/);
  expect(new Set(parts).size, "no part twice").toBe(parts.length);
  // The part with the narrated sentence and the neighbours the view may reach for, never the book.
  expect(parts.length).toBeGreaterThanOrEqual(1);
  expect(parts.length).toBeLessThanOrEqual(3);
  const loaded = ((await band(page).getAttribute("data-parts")) || "").split(",").map(Number);
  expect(loaded.length).toBeLessThanOrEqual(3);
  expect(Math.min(...loaded)).toBeGreaterThan(manifest.parts.length - 5);
  // Neither epub.js nor DOMPurify is loaded (#806 removed them): the build names their chunks after what they hold.
  const scripts = requests.of(/^\/assets\/.*\.js$/);
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) {
    const source = await (await page.request.get(script)).text();
    expect(/DOMPurify|isSupported:.{0,40}setConfig/.test(source), `${script} holds DOMPurify`).toBe(false);
    expect(/epubcfi\(|EpubCFI/.test(source), `${script} holds epub.js`).toBe(false);
  }
  // Scrolling towards the end of the loaded text brings the next part, once.
  await band(page).locator(".prepared-scroll").evaluate((scroller) => scroller.scrollTo(0, 0));
  await expect.poll(async () => ((await band(page).getAttribute("data-parts")) || "").split(",").length).toBeGreaterThan(loaded.length);
  const after = requests.of(/\/prepared\/[0-9a-f]+\/parts\/\d+$/);
  expect(new Set(after).size).toBe(after.length);
});

test("a second open of an unchanged book transfers neither the manifest, its parts nor its pictures", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the bytes of a request served from the browser's cache are read through Chromium's protocol");
  const { ebook } = await bookWith(
    page,
    `Warm ${randomUUID()}`,
    await preparedFixture({ files: { "pic.png": tinyPng }, chapters: { "one.xhtml": `<h1>Warm ${randomUUID()}</h1><p>A first sentence. A second one.</p><p><img src="pic.png" alt=""/></p>` } }),
  );
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  const urls = new Map<string, string>();
  const transfers: { path: string; status: number; cached: boolean; bytes: number }[] = [];
  const statuses = new Map<string, { status: number; cached: boolean }>();
  session.on("Network.requestWillBeSent", (event) => void urls.set(event.requestId, new URL(event.request.url).pathname));
  session.on("Network.responseReceived", (event) => void statuses.set(event.requestId, { status: event.response.status, cached: !!event.response.fromDiskCache }));
  session.on("Network.loadingFinished", (event) => {
    const path = urls.get(event.requestId), status = statuses.get(event.requestId);
    if (path && status) transfers.push({ path, ...status, bytes: event.encodedDataLength });
  });
  const prepared = (entry: { path: string }) => entry.path.includes(`/api/reader/${ebook}/prepared`);
  await gotoRead(page, ebook);
  await expect(band(page).locator(".prepared-text p").first()).toBeVisible();
  await expect(band(page).locator(".prepared-text img").first()).toBeVisible();
  await expect.poll(() => transfers.filter(prepared).length).toBeGreaterThanOrEqual(3);
  const cold = transfers.splice(0).filter(prepared);
  expect(cold.every((entry) => entry.status === 200 && !entry.cached)).toBe(true);
  const coldBytes = cold.reduce((sum, entry) => sum + entry.bytes, 0);
  await page.reload();
  await expect(band(page).locator(".prepared-text p").first()).toBeVisible();
  await expect(band(page).locator(".prepared-text img").first()).toBeVisible();
  await page.waitForTimeout(1000);
  const warm = transfers.filter(prepared);
  expect(warm.length).toBeGreaterThanOrEqual(1);
  for (const entry of warm) {
    // The manifest is asked about and answered "unchanged" without a body; parts and pictures are not asked for.
    // (Chromium's protocol reports a revalidated answer with the status of the kept one; its bytes are the 304's.)
    if (entry.path.endsWith("/prepared")) expect(entry.bytes, entry.path).toBeLessThan(500);
    else expect(entry.cached && entry.bytes === 0, entry.path).toBe(true);
  }
  const warmBytes = warm.reduce((sum, entry) => sum + entry.bytes, 0);
  expect(warmBytes).toBeLessThan(1000);
  expect(warmBytes).toBeLessThan(coldBytes / 4);
});

test("a hostile part runs nothing in the application: its nodes are made from the allow-list", async ({ page }) => {
  const { ebook } = await bookWith(page, `Hostile ${randomUUID()}`, await readerFixture({ title: `Hostile ${randomUUID()}` }));
  const manifest = await (await page.request.get(`/api/reader/${ebook}/prepared`)).json();
  const pictures = `/api/reader/${ebook}/prepared/${manifest.key}/pictures/`;
  // What a miss in the server's sanitiser could let through, around one honest sentence.
  const hostile = [
    `<section data-section="${manifest.sections[0].index}">`,
    `<script>window.__ran = "script"</script>`,
    `<p class="t-c"><span data-s="${manifest.parts[0].first}">The honest sentence.</span> <span onmouseover="window.__ran='over'" onpointerdown="window.__ran='down'">A sentence with handlers.</span></p>`,
    `<p onclick="window.__ran='onclick'" style="position:fixed;inset:0" id="root" class="t-c reader-topbar">A paragraph over the whole page.</p>`,
    `<img src="x" onerror="window.__ran='onerror'">`,
    `<img src="https://attacker.example/pixel.png" alt="outside">`,
    `<img src="${pictures}../../../../../auth/logout" alt="inside">`,
    `<svg onload="window.__ran='svg'"><script>window.__ran = "svg script"</script><a href="javascript:window.__ran='svg link'"><text>svg text</text></a></svg>`,
    `<math><mtext><img src="x" onerror="window.__ran='math'"></mtext></math>`,
    `<iframe srcdoc="<script>parent.__ran='frame'</script>"></iframe>`,
    `<object data="javascript:window.__ran='object'"></object><embed src="javascript:window.__ran='embed'">`,
    `<form action="javascript:window.__ran='form'"><button formaction="javascript:window.__ran='button'" autofocus onfocus="window.__ran='focus'">press</button><input onfocus="window.__ran='input'" autofocus></form>`,
    `<p><a href="javascript:window.__ran='link'" class="js">a script link</a> <a href="data:text/html,<script>opener.__ran='data'</script>" class="data">a data link</a> <a href="https://example.org/" target="_self" rel="opener">a web link</a></p>`,
    `<details open ontoggle="window.__ran='toggle'"><summary>details</summary></details>`,
    // An element named "body" stands in for the parsed document's own in Firefox; the walk must not start from it.
    `<form id="forms" name="body"><input name="innerHTML" id="attributes"></form><img name="body" src="x">`,
    `<style>.reader-head{display:none}</style><link rel="stylesheet" href="https://attacker.example/x.css"><base href="https://attacker.example/"><meta http-equiv="refresh" content="0;url=https://attacker.example/">`,
    `<template><img src="x" onerror="window.__ran='template'"></template><noscript><img src="x" onerror="window.__ran='noscript'"></noscript>`,
    `<p>After it all.</p>`,
    `</section>`,
  ].join("");
  const outside: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname.endsWith("attacker.example")) outside.push(request.url());
  });
  await page.route(/\/prepared\/[0-9a-f]+\/parts\/\d+$/, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: hostile }));
  const reports: any[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && pathOf(request) === `/api/reader/${ebook}/prepared-refused`) reports.push(request.postDataJSON());
  });
  await gotoRead(page, ebook);
  const text = band(page).locator(".prepared-text");
  await expect(text.getByText("The honest sentence.")).toBeVisible();
  await expect(text.getByText("After it all.")).toBeVisible();
  // An element with anything off the list stays out with everything under it.
  await expect(text.getByText("A sentence with handlers.")).toHaveCount(0);
  await expect(text.getByText("A paragraph over the whole page.")).toHaveCount(0);
  await expect(text.getByText("svg text")).toHaveCount(0);
  // Give every handler its chance: move over, press and click the sentence and each link, and wait.
  await text.getByText("The honest sentence.").hover();
  for (const link of await text.locator("a").all()) if (!(await link.getAttribute("href"))) await link.click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__ran)).toBeUndefined();
  expect(outside).toEqual([]);
  expect(new URL(page.url()).pathname).toBe("/");
  const made = await text.evaluate((root) => {
    const elements = [...root.querySelectorAll("*")];
    return {
      tags: [...new Set(elements.map((element) => element.localName))].sort(),
      handlers: elements.flatMap((element) => element.getAttributeNames().filter((name) => name.startsWith("on"))),
      attributes: [...new Set(elements.flatMap((element) => element.getAttributeNames()))].sort(),
      links: [...root.querySelectorAll("a")].map((link) => [link.className, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]),
      pictures: [...root.querySelectorAll("img")].map((image) => image.getAttribute("src")),
    };
  });
  // An element with anything off the list stays out whole: the paragraph with a handler, every picture, the
  // script and data links. What is left is the honest markup.
  expect(made.tags).toEqual(["a", "div", "p", "section", "span"]);
  await expect(text.getByText("a script link")).toHaveCount(0);
  expect(made.handlers).toEqual([]);
  expect(made.attributes).toEqual(["class", "data-part", "data-s", "data-section", "href", "rel", "target"]);
  // A web address opens outside the application and without its opener, whatever the part said.
  expect(made.links).toEqual([["", "https://example.org/", "_blank", "noopener noreferrer nofollow"]]);
  expect(made.pictures).toEqual([]);
  // What was left out is reported to the server, once for the part, so the miss in its sanitiser is seen.
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0].key).toBe(manifest.key);
  expect(reports[0].part).toBe(0);
  expect(reports[0].refused).toEqual(expect.arrayContaining(["element script", "attribute onclick on p", "a picture's address", "element svg of another namespace", "element iframe"]));
  expect(reports[0].refused.length).toBeLessThanOrEqual(20);
  // A part the sanitiser wrote as it should reports nothing: the next test's books are opened without a report.
  // The reader's own head is still there: the part's stylesheet did not reach the page.
  await expect(page.locator(".reader-room .reader-head")).toBeVisible();
});

test("each part's text in the page is as long as the manifest says", async ({ page }) => {
  // The reader fixture's odd documents and a long plain book: the same count from a browser's parser, from the
  // nodes the page makes, and from the server.
  const books = [
    await bookWith(page, `Counts ${randomUUID()}`, await readerFixture({ title: `Counts ${randomUUID()}`, cover: true })),
    await bookWith(page, `Counts ${randomUUID()}`, await readerFixture({ title: `Counts ${randomUUID()}`, variant: "text-before-head" })),
    await bookWith(page, `Counts ${randomUUID()}`, await longBookFixture({ chapters: 6, sentences: 500, title: `Counts ${randomUUID()}` })),
  ];
  for (const { ebook, sentences } of books) {
    const manifest = await (await page.request.get(`/api/reader/${ebook}/prepared`)).json();
    expect(manifest.problems).toEqual([]);
    const reports: string[] = [];
    page.on("request", (request) => void (pathOf(request).endsWith("/prepared-refused") && reports.push(request.url())));
    await gotoRead(page, ebook);
    await expect(band(page).locator(".prepared-part").first()).toBeVisible();
    // The allow-list left nothing out of what the server prepared.
    expect(reports).toEqual([]);
    // Every part as a browser parses it.
    const parsed = await page.evaluate(async ({ ebook, key, count }) => {
      const lengths: number[] = [];
      for (let part = 0; part < count; part++) {
        const html = await (await fetch(`/api/reader/${ebook}/prepared/${key}/parts/${part}`)).text();
        lengths.push(new DOMParser().parseFromString(html, "text/html").body.textContent!.length);
      }
      return lengths;
    }, { ebook, key: manifest.key, count: manifest.parts.length });
    expect(parsed).toEqual(manifest.parts.map((part: any) => part.chars));
    // The parts in the page, as the view made them, and each sentence's text against the stored one.
    const shown = await band(page).evaluate((host) => [...host.querySelectorAll(".prepared-part")].map((part) => {
      const texts = new Map<string, string>();
      for (const span of part.querySelectorAll("[data-s]")) texts.set(span.getAttribute("data-s")!, (texts.get(span.getAttribute("data-s")!) ?? "") + span.textContent);
      return { part: Number(part.getAttribute("data-part")), length: part.textContent!.length, sentences: [...texts] };
    }));
    expect(shown.length).toBeGreaterThan(0);
    const stored = new Map<string, string>(sentences.sections.flatMap((section: any) => section.paragraphs.map((paragraph: any) => [paragraph.id, paragraph.text])));
    for (const part of shown) {
      expect(part.length, `part ${part.part}`).toBe(manifest.parts[part.part].chars);
      expect(part.sentences.length).toBe(manifest.parts[part.part].sentences);
      for (const [id, text] of part.sentences) expect(text.normalize("NFKC").replace(/\s+/g, " ").trim(), id).toBe(stored.get(id));
    }
  }
});

test("the narrated sentence is marked and followed, a long press listens from there, and a scroll by hand pages away and saves the place", async ({ page }) => {
  test.setTimeout(150000);
  const { book, ebook, sentences, map } = await longBook(page, `Followed ${randomUUID()}`);
  const first = map.intervals.filter((interval: any) => interval.section === sentences.sections[0].index).sort((a: any, b: any) => a.start - b.start);
  await narrateAt(page, book, first[20].start + 0.5);
  await gotoRead(page, ebook);
  const room = page.locator(".reader-room");
  // Following: the narrated sentence is marked and in view.
  await expect(room).toHaveAttribute("data-current-passage", first[20].paragraphId, { timeout: READER_WAIT_MS.followHighlight });
  await expect.poll(() => highlightShown(room), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
  const marked = band(page).locator(".sonder-follow");
  const textOf = (id: string) => sentences.sections.flatMap((section: any) => section.paragraphs).find((paragraph: any) => paragraph.id === id).text;
  expect((await marked.allTextContents()).join("").trim()).toBe(textOf(first[20].paragraphId));
  // Nothing is drawn over the text (ADR 0019): the mark is the sentence's own elements.
  expect(await marked.first().evaluate((span) => span.localName === "span" && getComputedStyle(span).position === "static")).toBe(true);
  // Listen from here: a long press on a later mapped sentence moves the narration to it.
  const target = band(page).locator(`[data-s="${first[24].paragraphId}"]`).first();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await expect(room).toHaveAttribute("data-current-passage", first[24].paragraphId, { timeout: READER_WAIT_MS.followHighlight });
  await expect(room.locator(".reader-player")).toContainText("Undo");
  // Paged away by hand: the place is saved as the sentence at the top of the band.
  // (Paused first where the narration plays; a browser without a sound device on the host never started it.)
  const pause = page.getByRole("button", { name: /Pause narration/ }).first();
  if (await pause.isVisible()) await pause.click();
  await band(page).hover();
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, 2400);
  await expect(room).not.toHaveAttribute("data-current-passage", /.+/);
  const saved = async () => (await (await page.request.get(`/api/reader/${ebook}/state`)).json()).checkpoint;
  await expect.poll(async () => (await saved())?.origin, { timeout: 15000 }).toBe("reading");
  const place = (await saved()).locator;
  expect(place.cfi).toBeUndefined();
  const placeText = textOf(place.paragraphId);
  expect(await textShown(room, placeText)).toBe(true);
});

test("a place and a bookmark saved here open again, and so does a bookmark the earlier reader saved with a CFI", async ({ page }) => {
  test.setTimeout(150000);
  // With "Follow the narration" off (Settings › Playback) the reader opens at the saved place, not at the narration.
  await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
  const { ebook, sentences } = await bookWith(page, `Places ${randomUUID()}`, await longBookFixture({ chapters: 8, sentences: 300, title: `Places ${randomUUID()}` }));
  const paragraphs = sentences.sections.flatMap((section: any) => section.paragraphs);
  const textOf = (id: string) => paragraphs.find((paragraph: any) => paragraph.id === id).text;
  const state = async () => (await page.request.get(`/api/reader/${ebook}/state`)).json();
  const address = await gotoRead(page, ebook);
  const room = page.locator(".reader-room");
  const open = async () => {
    await page.goto("/api/health");
    await page.goto(`/${address}`);
    await expect(band(page).locator(".prepared-text p").first()).toBeVisible();
  };
  const showControls = async () => {
    if (await room.locator(".reader-topbar").isVisible()) return;
    const area = (await band(page).boundingBox())!;
    await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
    await expect(room.locator(".reader-topbar")).toBeVisible();
  };
  const openBookmark = async (text: string) => {
    await showControls();
    await room.locator(".reader-player").getByRole("button", { name: "Chapters", exact: true }).click();
    await page.getByRole("radio", { name: "Bookmarks", exact: true }).click();
    await page.locator(".reader-pages-bookmark-open", { hasText: text.slice(0, 40) }).click();
  };

  // Scrolled by hand, the place is saved as a sentence, with no CFI.
  await open();
  await band(page).hover();
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, 5000);
  await expect.poll(async () => (await state()).checkpoint?.origin, { timeout: 15000 }).toBe("reading");
  const scrolled = (await state()).checkpoint.locator;
  expect(scrolled.cfi).toBeUndefined();
  expect(scrolled.paragraphId).not.toBe(paragraphs[0].id);
  expect(await textShown(room, textOf(scrolled.paragraphId))).toBe(true);
  // A bookmark, on the sentence at the top of the band.
  await showControls();
  await room.locator(".reader-bookmark-toggle").click();
  await expect.poll(async () => (await state()).bookmarks.length).toBe(1);
  const made = (await state()).bookmarks[0];
  expect(made.locator.paragraphId).toBe(scrolled.paragraphId);
  expect(made.label).toBe(textOf(scrolled.paragraphId).slice(0, 90));

  // Opened again, the reader is at that place; it goes to another chapter by its Chapters page, a place of its own.
  await open();
  await expect.poll(() => textShown(room, textOf(scrolled.paragraphId)), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
  await showControls();
  await room.locator(".reader-player").getByRole("button", { name: "Chapters", exact: true }).click();
  await page.locator(".reader-pages-chapter").nth(5).click();
  const sixth = sentences.sections[5];
  await expect.poll(async () => (await state()).checkpoint?.locator.section, { timeout: 15000 }).toBe(sixth.index);
  const chapter = (await state()).checkpoint.locator;
  expect(chapter.cfi).toBeUndefined();
  await openBookmark(textOf(made.locator.paragraphId));
  await expect.poll(() => textShown(room, textOf(made.locator.paragraphId)), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
  // A bookmark the earlier EPUB reader saved, far from both places: its locator has a CFI as well as the sentence.
  const far = sentences.sections[7].paragraphs[200];
  expect((await page.request.post(`/api/reader/${ebook}/bookmarks`, { data: { id: `old-${randomUUID()}`, label: far.text.slice(0, 90), locator: { cfi: "epubcfi(/6/2!/4/2)", section: sentences.sections[7].index, paragraphId: far.id, progression: 0.9 } } })).ok()).toBe(true);

  // Opened again, the reader is at the chapter's place, and opens the earlier reader's bookmark on its sentence.
  await open();
  await expect.poll(() => textShown(room, textOf(chapter.paragraphId)), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
  expect(await textShown(room, far.text)).toBe(false);
  await openBookmark(far.text);
  await expect.poll(() => textShown(room, far.text), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
  // Chapters and Search: a chapter's start, then a sentence found by its words.
  await showControls();
  await room.locator(".reader-player").getByRole("button", { name: "Chapters", exact: true }).click();
  await page.locator(".reader-pages-chapter").nth(2).click();
  await expect.poll(() => textShown(room, sentences.sections[2].paragraphs[0].text), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
  const found = sentences.sections[6].paragraphs[150];
  await showControls();
  await room.getByRole("button", { name: "Search this book", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search this book" }).fill(found.text.slice(0, 28));
  await page.locator(".reader-pages-result", { hasText: found.text.slice(0, 28) }).first().click();
  await expect.poll(() => textShown(room, found.text), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
});

// A failed request must never become a stream of requests (review of #828): one open reader asking 500 times a second
// would use up the account's request limit, and a refusal for that limit is itself a failed request.
const partRequests = (requests: ReturnType<typeof counted>, part: number) => requests.of(new RegExp(`/prepared/[0-9a-f]+/parts/${part}$`)).length;
const footError = (page: Page) => page.locator(".reader-room .reader-player > .reader-message").getByRole("alert");
const toEnd = (page: Page) => band(page).locator(".prepared-scroll").evaluate((scroller) => scroller.scrollTo(0, scroller.scrollHeight));
/**
 * Forgets what this device stored of the user's state of a book at its last open (`reader-state:<id>`, and the
 * details the earlier reader stored, `reader-book:<id>`): since #805 the reader opens with them when the server does not
 * answer, so a device that has them never says the book could not be loaded for that. Run on a page of the app's
 * origin with no app open, which would store them again.
 */
const forgetStoredState = (page: Page, ebook: string) =>
  page.evaluate(
    (ebook) =>
      new Promise<void>((done, fail) => {
        const open = indexedDB.open("sonder");
        open.onerror = () => fail(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("preferences", "readwrite");
          for (const key of [`reader-state:${ebook}`, `reader-book:${ebook}`]) tx.objectStore("preferences").delete(key);
          tx.oncomplete = () => {
            open.result.close();
            done();
          };
          tx.onerror = () => fail(tx.error);
        };
      }),
    ebook,
  );

test("a part that always fails is asked for three times, then the foot says so and Retry loads it", async ({ page }) => {
  test.setTimeout(120000);
  // Following is off here (Settings › Playback), as in "reading far": the fixture's book has a reading sync map, and a
  // reader that follows lands on the narrated sentence once the map has answered. On a loaded host that was after the
  // scroll to the end below: the view went back to the top, the failed part's answer was one nobody waited for any
  // more, and no message was owed (#861).
  await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
  const { ebook } = await bookWith(page, `Failing part ${randomUUID()}`, await longBookFixture({ chapters: 12, sentences: 400, title: `Failing part ${randomUUID()}` }));
  const manifest = await (await page.request.get(`/api/reader/${ebook}/prepared`)).json();
  expect(manifest.parts.length).toBeGreaterThan(3);
  let failing = true;
  await page.route(/\/prepared\/[0-9a-f]+\/parts\/1$/, (route) => (failing ? route.fulfill({ status: 500, json: { error: "The server's own sentence." } }) : route.continue()));
  const requests = counted(page);
  await gotoRead(page, ebook);
  await expect(band(page).locator(".prepared-part").first()).toBeVisible();
  await toEnd(page);
  // Three attempts with their waits (1 s, 3 s), and then no more, however long the reader stays and scrolls.
  await expect(footError(page)).toHaveText("This part of the book could not be loaded.", { timeout: 15000 });
  expect(partRequests(requests, 1)).toBe(3);
  // Up a little and down to the end again, twice: each is a scroll towards the missing part.
  for (let turn = 0; turn < 2; turn++) {
    await band(page).locator(".prepared-scroll").evaluate((scroller) => scroller.scrollBy(0, -900));
    await page.waitForTimeout(300);
    await toEnd(page);
    await page.waitForTimeout(1200);
  }
  expect(partRequests(requests, 1)).toBe(3);
  expect(await band(page).getAttribute("data-parts")).toBe("0");
  // The view itself stopped: it was told of the failure once, and scrolling towards the missing part does not make
  // it ask the failure it keeps again and again.
  expect(await band(page).getAttribute("data-load-failures")).toBe("1");
  // Retry asks again; the part arrives and the message leaves.
  failing = false;
  await page.locator(".reader-room .reader-message").getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(async () => (await band(page).getAttribute("data-parts"))!.split(",").includes("1")).toBe(true);
  await expect(footError(page)).toHaveCount(0);
  expect(partRequests(requests, 1)).toBe(4);
});

test("a part answered with 429 is not asked for again by itself", async ({ page }) => {
  test.setTimeout(120000);
  // Following is off, as in the test above (#861).
  await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
  const { ebook } = await bookWith(page, `Limited part ${randomUUID()}`, await longBookFixture({ chapters: 12, sentences: 400, title: `Limited part ${randomUUID()}` }));
  await page.route(/\/prepared\/[0-9a-f]+\/parts\/1$/, (route) => route.fulfill({ status: 429, headers: { "Retry-After": "60" }, json: { error: "Rate limit exceeded, retry in 1 minute" } }));
  const requests = counted(page);
  await gotoRead(page, ebook);
  await expect(band(page).locator(".prepared-part").first()).toBeVisible();
  await toEnd(page);
  await expect(footError(page)).toHaveText("This part of the book could not be loaded.", { timeout: 15000 });
  await toEnd(page);
  await page.waitForTimeout(5000);
  expect(partRequests(requests, 1)).toBe(1);
});

test("a book whose manifest, saved place or first part cannot be loaded says so in the foot after three tries, in the reader's words", async ({ page }) => {
  test.setTimeout(150000);
  const { ebook } = await bookWith(page, `Failing book ${randomUUID()}`, await readerFixture({ title: `Failing book ${randomUUID()}` }));
  for (const [what, pattern] of [
    ["the manifest", new RegExp(`/api/reader/${ebook}/prepared$`)],
    ["the saved place", new RegExp(`/api/reader/${ebook}/state$`)],
    ["the first part", /\/prepared\/[0-9a-f]+\/parts\/0$/],
  ] as const) {
    let failing = true;
    let asked = 0;
    await page.route(pattern, (route) => {
      asked++;
      return failing ? route.fulfill({ status: 503, json: { error: "The server's own sentence." } }) : route.continue();
    });
    await page.goto("/api/health");
    if (what === "the saved place") {
      // The opens before stored what the user saved on this device, and the reader takes that when the server does
      // not answer (#805): the book opens, after the same three tries, and says nothing.
      await gotoRead(page, ebook);
      await expect(band(page).locator(".prepared-text p").first(), "the stored state").toBeVisible({ timeout: 20000 });
      await expect(footError(page)).toHaveCount(0);
      expect(asked, "the stored state").toBe(3);
      // A device that has not stored it, as one that never opened the book, cannot open it without the server.
      await page.goto("/api/health");
      await forgetStoredState(page, ebook);
      asked = 0;
    }
    await gotoRead(page, ebook);
    await expect(footError(page), what).toHaveText("This book could not be loaded.", { timeout: 20000 });
    await expect(page.locator(".reader-room")).not.toContainText("The server's own sentence.");
    await page.waitForTimeout(2500);
    // Playback warming asks for the same manifest as the reader: the two share the request and its three attempts.
    expect(asked, what).toBeLessThanOrEqual(what === "the manifest" ? 6 : 3);
    expect(asked, what).toBeGreaterThanOrEqual(3);
    failing = false;
    await page.locator(".reader-room .reader-message").getByRole("button", { name: "Retry", exact: true }).click();
    await expect(band(page).locator(".prepared-text p").first(), what).toBeVisible({ timeout: 20000 });
    await expect(footError(page)).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("without a connection the reader says in its own words that this view needs one", async ({ page, context }) => {
  const { book, ebook } = await bookWith(page, `Offline ${randomUUID()}`, await readerFixture({ title: `Offline ${randomUUID()}` }));
  // The app is loaded and the book chosen; then the connection goes and Read is opened.
  await gotoRead(page, ebook);
  await expect(band(page).locator(".prepared-text p").first()).toBeVisible();
  await page.goto("/#library");
  await expect(page.locator("nav[aria-label='Main']").first()).toBeVisible();
  await page.evaluate(() => new Promise((done) => setTimeout(done, 400)));
  // That open stored what the user saved on this device, which the reader takes without an answer (#805), and the
  // browser keeps the manifest and the parts it fetched in its own cache, which Firefox offline may answer even the
  // `no-cache` manifest from: with the state stored the book can read there (it did in the 25 Nov check). Here the
  // device holds no state of the book, as one that never opened it, and the reader needs the server for it.
  await page.goto("/api/health");
  await forgetStoredState(page, ebook);
  await page.goto("/#library");
  await expect(page.locator("nav[aria-label='Main']").first()).toBeVisible();
  await context.setOffline(true);
  try {
    await page.reload().catch(() => {});
    await context.setOffline(false);
    await page.goto("/#library");
    await expect(page.locator("nav[aria-label='Main']").first()).toBeVisible();
    await context.setOffline(true);
    await page.evaluate((workId) => { location.hash = `#read/${encodeURIComponent(workId)}`; }, book.workId);
    await expect(footError(page)).toHaveText("This book needs a connection to be read.", { timeout: 20000 });
    await expect(page.locator(".reader-room")).not.toContainText(/Failed to fetch|NetworkError/);
    // Back online, Retry opens the book.
    await context.setOffline(false);
    await page.locator(".reader-room .reader-message").getByRole("button", { name: "Retry", exact: true }).click();
    await expect(band(page).locator(".prepared-text p").first()).toBeVisible({ timeout: 20000 });
  } finally {
    await context.setOffline(false);
  }
});

test("reading far: a part is asked for once however often it comes back, and never more than five parts are in the page", async ({ page }) => {
  test.setTimeout(150000);
  const { ebook, sentences } = await bookWith(page, `Far ${randomUUID()}`, await longBookFixture({ chapters: 30, sentences: 600, title: `Far ${randomUUID()}` }));
  const manifest = await (await page.request.get(`/api/reader/${ebook}/prepared`)).json();
  expect(manifest.parts.length).toBeGreaterThan(10);
  await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
  const requests = counted(page);
  await gotoRead(page, ebook);
  await expect(band(page).locator(".prepared-part").first()).toBeVisible();
  const loaded = async () => ((await band(page).getAttribute("data-parts")) || "").split(",").filter(Boolean).map(Number);
  // Down through eight parts: the page never holds more than five, and the first ones are taken out again.
  for (let step = 0; step < 40 && Math.max(...(await loaded())) < 8; step++) {
    await toEnd(page);
    await page.waitForTimeout(250);
    expect((await loaded()).length).toBeLessThanOrEqual(5);
  }
  expect(Math.max(...(await loaded()))).toBeGreaterThanOrEqual(8);
  expect(Math.min(...(await loaded()))).toBeGreaterThan(0);
  // Back to the book's start by its Chapters page, and down again: parts come back without being asked for again.
  const room = page.locator(".reader-room");
  const area = (await band(page).boundingBox())!;
  if (!(await room.locator(".reader-topbar").isVisible())) await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
  await room.locator(".reader-player").getByRole("button", { name: "Chapters", exact: true }).click();
  await page.locator(".reader-pages-chapter").first().click();
  await expect.poll(() => textShown(room, sentences.sections[0].paragraphs[0].text)).toBe(true);
  for (let step = 0; step < 20 && Math.max(...(await loaded())) < 3; step++) {
    await toEnd(page);
    await page.waitForTimeout(250);
  }
  const parts = requests.of(/\/prepared\/[0-9a-f]+\/parts\/\d+$/);
  expect(parts.length).toBeGreaterThanOrEqual(9);
  expect(new Set(parts).size, "no part twice").toBe(parts.length);
});

test("a scroll that no wheel or touch made (a scrollbar, a key) pages away and saves the place too", async ({ page }) => {
  test.setTimeout(120000);
  const { book, ebook, map, sentences } = await longBook(page, `Scrollbar ${randomUUID()}`);
  const first = map.intervals.filter((interval: any) => interval.section === sentences.sections[0].index).sort((a: any, b: any) => a.start - b.start);
  await narrateAt(page, book, first[20].start + 0.5);
  await gotoRead(page, ebook);
  const room = page.locator(".reader-room");
  await expect(room).toHaveAttribute("data-current-passage", first[20].paragraphId, { timeout: READER_WAIT_MS.followHighlight });
  await expect.poll(() => highlightShown(room), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
  await page.waitForTimeout(1500);
  // The text is moved as a scrollbar moves it: no wheel, no touch, no key event reaches the reader.
  await band(page).locator(".prepared-scroll").evaluate((scroller) => scroller.scrollBy(0, 2600));
  await expect(room).not.toHaveAttribute("data-current-passage", /.+/);
  await expect.poll(async () => (await (await page.request.get(`/api/reader/${ebook}/state`)).json()).checkpoint?.origin, { timeout: 15000 }).toBe("reading");
});

test("a place saved on another device, also one the earlier reader saved with a CFI, opens on its sentence when the first display is slow", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the slow first display is made by slowing the processor through Chromium's protocol");
  test.setTimeout(180000);
  // Places are sentences (#802); the earlier EPUB reader saved a CFI beside the sentence, and the live library holds
  // such places. The reader opens one by its sentence, with the processor slowed so that its first display is late.
  await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
  const { ebook, sentences } = await bookWith(page, `Sentence place ${randomUUID()}`, await longBookFixture({ chapters: 8, sentences: 300, title: `Sentence place ${randomUUID()}` }));
  const section = sentences.sections[5];
  const sentence = section.paragraphs[120];
  expect((await page.request.put(`/api/reader/${ebook}/progress`, { data: { locator: { cfi: "epubcfi(/6/14!/4/2)", section: section.index, paragraphId: sentence.id, quote: sentence.text, progression: 0.7 }, baseRevision: 0, eventId: `place-${randomUUID()}`, deviceId: "another-device", updatedAt: Date.now(), origin: "reading" } })).ok()).toBe(true);
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await gotoRead(page, ebook);
  const room = page.locator(".reader-room");
  await expect.poll(() => textShown(room, sentence.text), { timeout: 90000 }).toBe(true);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  // It is still the saved place: the head names its chapter, and nothing was saved over it.
  await expect(room.locator(".reader-head-rest")).toContainText(section.title);
  await page.waitForTimeout(1500);
  expect((await (await page.request.get(`/api/reader/${ebook}/state`)).json()).checkpoint.locator.paragraphId).toBe(sentence.id);
});
