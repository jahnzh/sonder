// The Library by work (#577, spec #572 "The Library"; boards Library.dc.html, LibraryList.dc.html and
// DesktopLibrary.dc.html), at 390 by 844 and at desktop width, in Chromium and Firefox: one tile per work (a work with
// two recordings is one tile), the marks of each kind, each chip and the chip kept after a reload, Continue, Search,
// the plus, the empty states, Favorite by work, and the device database's upgrade to favourites by work keeping
// places, downloads, favourites and position history. The guards of spec #572's list 1, 2 and 3 in their new form.
// Each test makes its own books under a title of its own run and takes them out of the library after it.
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";

// Routed answers (`/api/library`) must reach the page: no service worker in between.
test.use({ serviceWorkers: "block" });

// Ask the OS for a free port for the signed-in server of the two-account test.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0)) {
    await page.request.patch(`/api/works/${encodeURIComponent(workId)}/completion`, { data: { status: "derived" } });
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
  }
});

type Imported = { id: string; workId: string; recordingId: string; title: string; tracks: { id: string; duration: number }[] };

/** A recording of this test's own, imported as the administrator imports one. */
async function importRecording(page: Page, title: string, author = "Library QA"): Promise<Imported> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author, file0: { name: "Track 1.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id) as Imported;
  made.push(book.workId);
  return book;
}

/** A second recording of the same work, seeded on the first one's file (as the Audiobook page's spec does). */
async function secondRecording(page: Page, book: Imported) {
  const suffix = randomUUID().slice(0, 8);
  const response = await page.request.post("/api/test/seed-local-audio", {
    data: {
      relPath: `imports/${book.tracks[0].id}.mp3`,
      editionId: `edition-library-${suffix}`,
      recordingId: `recording-library-${suffix}`,
      trackId: `track-library-${suffix}`,
      workId: book.workId,
      narrator: "Second Narrator",
      duration: 3600,
    },
  });
  expect(response.ok()).toBe(true);
  return `recording-library-${suffix}`;
}

/** An ebook without a book chosen: its work joins the library through a placeholder (#555). */
async function importEbookOnly(page: Page, title: string, format: "epub" | "pdf") {
  const buffer =
    format === "epub"
      ? await readerFixture({ title, bodies: ["<p>Chapter one of the book, a short line.</p>", "<p>Chapter two of the book.</p>"] })
      : Buffer.from(`%PDF-1.4\n% ${title}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
  const response = await page.request.post("/api/ebooks/import", {
    multipart: { file: { name: `${title}.${format}`, mimeType: format === "epub" ? "application/epub+zip" : "application/pdf", buffer } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id as string;
  const ebook = ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === id)!;
  made.push(ebook.workId);
  return { id, workId: ebook.workId };
}

/** Saves a reading place in an EPUB, as the reader does. */
async function read(page: Page, ebookId: string, progression: number) {
  const manifest = await (await page.request.get(`/api/reader/${encodeURIComponent(ebookId)}`)).json();
  const response = await page.request.put(`/api/reader/${encodeURIComponent(ebookId)}/progress`, {
    data: {
      locator: { section: manifest.sections[0].index, paragraphId: manifest.sections[0].paragraphs[0].id, progression },
      baseRevision: 0,
      eventId: randomUUID(),
      deviceId: "library-spec",
      updatedAt: Date.now(),
      origin: "reading",
    },
  });
  expect(response.ok()).toBe(true);
}

/** Saves a listening place past the start of the recording. */
async function listen(page: Page, book: Imported, position: number) {
  const response = await page.request.post("/api/progress", {
    data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position, duration: book.tracks[0].duration, updatedAt: Date.now() },
  });
  expect(response.ok()).toBe(true);
}

const tile = (page: Page, title: string) => page.locator(".library-tile").filter({ has: page.getByRole("button", { name: `About ${title}`, exact: true }) });
const row = (page: Page, title: string) => page.locator(".library-row").filter({ has: page.getByRole("button", { name: `About ${title}`, exact: true }) });
const chips = (page: Page) => page.getByRole("group", { name: "Filter your library", exact: true });
const chip = (page: Page, name: string) => chips(page).getByRole("button", { name, exact: true });
const box = async (page: Page, selector: ReturnType<Page["locator"]>) => (await selector.boundingBox())!;

async function choose(page: Page, name: string) {
  await chip(page, name).click();
  await expect(chip(page, name)).toHaveAttribute("aria-pressed", "true");
}

async function openLibrary(page: Page) {
  await page.goto("/#library");
  await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
}

test("the Library against its boards at 390 by 844 and on a desktop: one tile per work, the marks of each kind, the list rows", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const run = randomUUID().slice(0, 6);
  const left = await importRecording(page, `The Left Hand of Darkness ${run}`, "Ursula K. Le Guin");
  await secondRecording(page, left);
  const books = (await (await page.request.get("/api/books")).json()) as { workId: string }[];
  // The server has two library entries for the work, one per recording.
  expect(books.filter((b) => b.workId === left.workId)).toHaveLength(2);
  const epub = await importEbookOnly(page, `Piranesi ${run}`, "epub");
  const pdf = await importEbookOnly(page, `Capitalist Realism ${run}`, "pdf");
  // A book with nothing yet and one whose first file downloads cannot be made on this server without a torrent: the
  // library's answer gains them, copied from the PDF's work, and a ready reading sync for the two recordings.
  await page.route("**/api/library", async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const works = (await response.json()) as Record<string, any>[];
    const base = works.find((w) => w.workId === pdf.workId)!;
    const shown = works.map((w) =>
      w.workId === left.workId
        ? { ...w, readingSync: [{ id: `sync-${run}`, status: "ready", outcome: "complete", coverage: 1, progress: 1, recordingId: left.recordingId, ebookId: "none", updatedAt: Date.now(), intervalCount: 4 }] }
        : w,
    );
    shown.push({ ...base, workId: `work-nothing-${run}`, title: `Kindred ${run}`, author: "Octavia E. Butler", ebooks: [], addedAt: Date.now() + 2 });
    shown.push({
      ...base,
      workId: `work-downloading-${run}`,
      title: `Snow Crash ${run}`,
      author: "Neal Stephenson",
      ebooks: [],
      addedAt: Date.now() + 1,
      mediaState: { state: "queued", holdReason: null, acquisition: { id: `acq-${run}`, status: "downloading", progress: 0.43, error: null } },
    });
    await route.fulfill({ response, json: shown, headers: { ...response.headers(), etag: `"routed-${run}"` } });
  });

  await openLibrary(page);
  // One Title; Search and the plus, 44 by 44 (Library.dc.html's head).
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Library"]);
  for (const name of ["Search your library", "Add a book"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    expect(await box(page, button)).toMatchObject({ width: 44, height: 44 });
  }
  // The chips in the boards' order, each 44 high, All chosen; the heading names it.
  await expect(chips(page).getByRole("button")).toHaveText(["All", "Series", "In progress", "Not started", "Finished", "On device", "Favorites"]);
  for (const button of await chips(page).getByRole("button").all()) expect((await box(page, button)).height).toBe(44);
  await expect(chip(page, "All")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 2, name: "All books", exact: true })).toBeVisible();

  // One tile for the work's two recordings.
  await expect(tile(page, left.title)).toHaveCount(1);
  // The marks of each kind (#556's cover-mark function): audiobook and reading sync; an EPUB; a PDF; nothing; the percentage.
  await expect(tile(page, left.title).locator(".library-marks")).toHaveAttribute("aria-label", "Audiobook, Reading sync ready");
  await expect(tile(page, `Piranesi ${run}`).locator(".library-marks")).toHaveAttribute("aria-label", "Ebook");
  await expect(tile(page, `Capitalist Realism ${run}`).locator(".library-marks")).toHaveAttribute("aria-label", "Ebook");
  await expect(tile(page, `Kindred ${run}`).locator(".library-marks")).toHaveCount(0);
  await expect(tile(page, `Snow Crash ${run}`).locator(".library-marks")).toHaveAttribute("aria-label", "Downloading · 43%");
  await expect(tile(page, `Snow Crash ${run}`).locator(".library-marks")).toHaveText("43%");
  await expect(tile(page, `Snow Crash ${run}`).locator(".library-marks svg")).toHaveCount(1);
  // The tile: the title on one line with an ellipsis, the author under it.
  await expect(tile(page, left.title).locator(".library-tile-author")).toHaveText("Ursula K. Le Guin");
  expect(await tile(page, left.title).locator(".library-tile-title").evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  // Three columns on the phone, a square cover.
  const tiles = page.locator(".library-tile");
  const [a, b, c, d] = await Promise.all([0, 1, 2, 3].map(async (i) => box(page, tiles.nth(i))));
  expect(Math.round(a.y)).toBe(Math.round(b.y));
  expect(Math.round(b.y)).toBe(Math.round(c.y));
  expect(d.y).toBeGreaterThan(a.y);
  const cover = await box(page, tiles.first().locator(".library-cover"));
  expect(Math.round(cover.width)).toBe(Math.round(cover.height));
  // Guard 1 (spec #572): no horizontal overflow, the dark ground, no page error.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(16, 21, 16)");
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/library-phone.png` });

  // The list (LibraryList.dc.html): Book rows without a chevron, the author and the place line or the download's line,
  // the marks muted on the right.
  await page.getByRole("button", { name: "List view", exact: true }).click();
  const epubAuthor = ((await (await page.request.get(`/api/works/${encodeURIComponent(epub.workId)}`)).json()) as { author: string }).author;
  await expect(row(page, `Piranesi ${run}`).locator(".library-row-line")).toHaveText(epubAuthor ? `${epubAuthor} · Not started` : "Not started");
  await expect(row(page, `Snow Crash ${run}`).locator(".library-row-line")).toHaveText("Downloading to server · 43%");
  await expect(row(page, left.title).locator(".library-row-line")).toHaveText("Ursula K. Le Guin · Not started");
  expect(await row(page, left.title).locator(".library-row-marks svg").evaluateAll((svgs) => svgs.map((svg) => svg.getAttribute("aria-label")))).toEqual(["Audiobook", "Reading sync ready"]);
  await expect(row(page, `Kindred ${run}`).locator(".library-row-marks svg")).toHaveCount(0);
  await expect(page.locator(".library-row .part-chevron")).toHaveCount(0);
  expect((await box(page, row(page, left.title))).height).toBeGreaterThanOrEqual(64);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/library-list-phone.png` });
  await page.getByRole("button", { name: "Grid view", exact: true }).click();

  // A desktop (DesktopLibrary.dc.html): the search field beside the Title, Add a book with its words, a wider grid.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("searchbox", { name: "Search your library", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search your library", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add a book", exact: true })).toHaveText("Add a book");
  const [first, second, third, fourth] = await Promise.all([0, 1, 2, 3].map(async (i) => box(page, tiles.nth(i))));
  expect(Math.round(fourth.y)).toBe(Math.round(first.y));
  expect(second.x).toBeGreaterThan(first.x);
  expect(third.width).toBeGreaterThanOrEqual(140);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Library"]);
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/library-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  // A tile opens its Book page.
  await tile(page, left.title).getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`#book/${left.workId}$`));
  expect(errors).toEqual([]);
});

test("each chip, the chip kept after a reload, Continue, Search, the plus and the empty states", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const run = `Shelf ${randomUUID().slice(0, 6)}`;
  // A title long enough to run past the Continue card's edge: it is cut, the page does not widen.
  const listening = await importRecording(page, `${run} Listening, a title long enough to run past the card's edge`);
  const finished = await importRecording(page, `${run} Finished`);
  const fresh = await importRecording(page, `${run} Fresh`);
  const reading = await importEbookOnly(page, `${run} Reading`, "epub");
  await openLibrary(page);
  // Guard 3 (spec #572): Finished with no finished book of this run says "No books", names what is in use, and Clear filters.
  await page.getByRole("button", { name: "Search your library", exact: true }).click();
  const field = page.getByRole("searchbox", { name: "Search your library", exact: true });
  await expect(field).toBeFocused();
  await field.fill(run.toUpperCase());
  await choose(page, "Finished");
  await expect(page.getByRole("heading", { name: "No books", exact: true })).toBeVisible();
  await expect(page.locator(".library-empty")).toContainText(`Finished · “${run.toUpperCase()}”`);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(chip(page, "All")).toHaveAttribute("aria-pressed", "true");
  await expect(field).toBeHidden();

  await listen(page, listening, 20);
  await page.request.patch(`/api/works/${encodeURIComponent(finished.workId)}/completion`, { data: { status: "finished" } });
  // The book read in the reader has the newest place: Continue shows it.
  await read(page, reading.id, 0.38);
  await page.reload();
  const card = page.getByRole("region", { name: "Continue", exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: `Continue ${run} Reading`, exact: true })).toBeVisible();
  await expect(card).toContainText("38% of the ebook");
  // An ebook read in the reader has nothing to play.
  await expect(card.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
  // Listening later makes the audiobook the newest place: Continue shows it, with Play.
  await listen(page, listening, 25);
  await page.reload();
  await expect(card.getByRole("button", { name: `Continue ${listening.title}`, exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await card.locator(".library-continue-title").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  if (test.info().project.name === "chromium") await card.screenshot({ path: `${OUT}/library-continue-phone.png` });
  expect((await box(page, card.locator(".library-continue-cover"))).width).toBe(72);

  // Search: on the device, by title (words, any case); Continue stays away while a search is in use.
  await page.getByRole("button", { name: "Search your library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeHidden();
  await field.fill(`fresh ${run.toLowerCase()}`);
  await expect(page.locator(".library-tile")).toHaveCount(1);
  await expect(tile(page, `${run} Fresh`)).toBeVisible();
  await expect(card).toHaveCount(0);
  await field.fill("library qa");
  await expect(tile(page, listening.title)).toBeVisible();
  await page.getByRole("button", { name: "Close search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  await expect(card).toBeVisible();

  const mine = [listening.title, `${run} Finished`, `${run} Fresh`, `${run} Reading`];
  const shownOfMine = async () => {
    const shown: string[] = [];
    for (const title of mine) if ((await tile(page, title).count()) > 0) shown.push(title);
    return shown;
  };
  const expectUnder = async (name: string, heading: string, titles: string[]) => {
    await choose(page, name);
    await expect(page.getByRole("heading", { level: 2, name: heading, exact: true })).toBeVisible();
    // Continue only on All.
    await expect(card).toHaveCount(name === "All" ? 1 : 0);
    await expect.poll(shownOfMine).toEqual(titles);
  };
  await expectUnder("In progress", "In progress", [listening.title, `${run} Reading`]);
  await expectUnder("Not started", "Not started", [`${run} Fresh`]);
  await expectUnder("Finished", "Finished", [`${run} Finished`]);
  // Nothing of these is kept on this device; Keep's own spec (keep-not-complete) fills On device.
  await expectUnder("On device", "On device", []);
  await expectUnder("Favorites", "Favorites", []);
  await expectUnder("All", "All books", mine);

  // The chip is kept after a reload.
  await choose(page, "Finished");
  await page.reload();
  await expect(chip(page, "Finished")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 2, name: "Finished", exact: true })).toBeVisible();
  await expect.poll(shownOfMine).toEqual([`${run} Finished`]);
  // The Library's own place in the tab bar shows All again.
  await choose(page, "All");

  // The plus opens Discover.
  await page.getByRole("button", { name: "Add a book", exact: true }).click();
  await expect(page).toHaveURL(/#discover$/);
  await expect(page.getByRole("heading", { name: "Discover", level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("an empty library says No books yet with Find a book", async ({ page }) => {
  await page.route("**/api/library", (route) => route.fulfill({ json: [], headers: { etag: `"empty-${randomUUID()}"` } }));
  await openLibrary(page);
  await expect(page.getByRole("heading", { name: "No books yet", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Find a book", exact: true }).click();
  await expect(page).toHaveURL(/#discover$/);
});

test("Favorite on the Book page puts the work under Favorites, one tile for its two recordings, also after a reload", async ({ page }) => {
  const run = randomUUID().slice(0, 6);
  const left = await importRecording(page, `Favourite two recordings ${run}`);
  await secondRecording(page, left);
  await openLibrary(page);
  await choose(page, "Favorites");
  await expect(tile(page, left.title)).toHaveCount(0);
  await choose(page, "All");
  await tile(page, left.title).getByRole("button").click();
  const favorite = page.getByRole("button", { name: "Favorite", exact: true });
  await expect(favorite).toHaveAttribute("aria-pressed", "false");
  await favorite.click();
  await expect(favorite).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Back/ }).first().click();
  await choose(page, "Favorites");
  // Guard 2 (spec #572): under Favorites, also after a reload.
  await expect(tile(page, left.title)).toHaveCount(1);
  await page.reload();
  await expect(chip(page, "Favorites")).toHaveAttribute("aria-pressed", "true");
  await expect(tile(page, left.title)).toHaveCount(1);
  // The device keeps work ids, not the editions of its two recordings.
  const stored = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open("sonder");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const get = request.result.transaction("preferences").objectStore("preferences").get("workFavorites");
          get.onsuccess = () => resolve(get.result?.value);
          get.onerror = () => reject(get.error);
        };
      }),
  );
  expect(stored).toEqual([left.workId]);
  // Favorite again takes it out.
  await tile(page, left.title).getByRole("button").click();
  await page.getByRole("button", { name: "Favorite", exact: true }).click();
  await expect(page.getByRole("button", { name: "Favorite", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.goto("/#library");
  await expect(chip(page, "Favorites")).toHaveAttribute("aria-pressed", "true");
  await expect(tile(page, left.title)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No books", exact: true }).or(page.locator(".library-tile").first())).toBeVisible();
});

test("the device database's upgrade keeps places, downloads, favourites and position history; earlier favourites are under Favorites", async ({ page }) => {
  const run = randomUUID().slice(0, 6);
  const left = await importRecording(page, `Upgraded favourite ${run}`);
  const second = await secondRecording(page, left);
  const ebookOnly = await importEbookOnly(page, `Upgraded placeholder ${run}`, "epub");
  const other = await importRecording(page, `Not a favourite ${run}`);
  const books = ((await (await page.request.get("/api/books")).json()) as { id: string; workId: string; recordingId: string }[]).filter((b) =>
    [left.workId, ebookOnly.workId, other.workId].includes(b.workId),
  );
  const secondEdition = books.find((b) => b.recordingId === second)!.id;
  // The placeholder edition of the EPUB-only book is in the device's books like any other entry.
  const placeholder = books.find((b) => b.workId === ebookOnly.workId)!.id;
  const now = Date.now();
  await page.goto("/build.json");
  // Dexie opens IndexedDB at ten times its version: 60 is a device that last ran version 6 (before favourites by work).
  const seeded = await page.evaluate(
    async ({ books, favorites, now }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("sonder", 60);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("books", { keyPath: "id" });
          db.createObjectStore("progress", { keyPath: "recordingId" });
          db.createObjectStore("preferences", { keyPath: "key" });
          db.createObjectStore("downloads", { keyPath: "trackId" }).createIndex("recordingId", "recordingId");
          db.createObjectStore("downloadParts", { keyPath: "trackId" }).createIndex("recordingId", "recordingId");
          db.createObjectStore("downloadChunks", { keyPath: ["trackId", "offset"] }).createIndex("trackId", "trackId");
          db.createObjectStore("positionHistory", { keyPath: "recordingId" });
          db.createObjectStore("works", { keyPath: "workId" });
          db.createObjectStore("keep", { keyPath: "workId" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["books", "progress", "preferences", "downloads", "downloadParts", "downloadChunks", "positionHistory", "keep"], "readwrite");
        for (const book of books) tx.objectStore("books").put(book);
        tx.objectStore("preferences").put({ key: "favorites", value: favorites });
        tx.objectStore("progress").put({ recordingId: "old-recording", trackId: "old-track", position: 12.5, duration: 300, updatedAt: 12345 });
        // A complete download (its blob of its size: the app drops an incomplete one), an earlier part, a chunk.
        tx.objectStore("downloads").put({ trackId: "old-track", recordingId: "old-recording", name: "Track 1", size: 1, storage: "idb", completedAt: 1, blob: new Blob(["x"]) });
        tx.objectStore("downloadParts").put({ trackId: "old-part", recordingId: "old-recording", size: 4, loaded: 1, updatedAt: 2 });
        tx.objectStore("downloadChunks").put({ trackId: "old-track", offset: 0, blob: new Blob(["x"]) });
        // A recent entry (the app prunes entries older than a day on its own).
        tx.objectStore("positionHistory").put({ recordingId: "old-recording", entries: [{ trackId: "old-track", position: 3, timestamp: now, kind: "seek" }] });
        tx.objectStore("keep").put({ workId: "old-work", on: true, updatedAt: 5 });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      const version = db.version;
      db.close();
      return version;
    },
    { books, favorites: [secondEdition, placeholder, "edition-the-device-does-not-know"], now },
  );
  expect(seeded).toBe(60);
  await openLibrary(page);
  await choose(page, "Favorites");
  // Today's favourites, kept: the work of the favourite edition (one tile) and the placeholder's book.
  await expect(tile(page, left.title)).toHaveCount(1);
  await expect(tile(page, `Upgraded placeholder ${run}`)).toHaveCount(1);
  await expect(tile(page, other.title)).toHaveCount(0);
  const after = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const get = (store: string, key: IDBValidKey) =>
      new Promise<any>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const result = {
      version: db.version,
      favorites: (await get("preferences", "favorites"))?.value,
      workFavorites: (await get("preferences", "workFavorites"))?.value,
      progress: await get("progress", "old-recording"),
      download: await get("downloads", "old-track").then((d) => d && { ...d, blob: d.blob?.size }),
      part: await get("downloadParts", "old-part"),
      chunk: !!(await get("downloadChunks", ["old-track", 0])),
      history: await get("positionHistory", "old-recording"),
      keep: await get("keep", "old-work"),
    };
    db.close();
    return result;
  });
  expect(after).toEqual({
    version: 70,
    // An older tab's own list is left as it was.
    favorites: [secondEdition, placeholder, "edition-the-device-does-not-know"],
    workFavorites: [left.workId, ebookOnly.workId],
    progress: { recordingId: "old-recording", trackId: "old-track", position: 12.5, duration: 300, updatedAt: 12345 },
    download: { trackId: "old-track", recordingId: "old-recording", name: "Track 1", size: 1, storage: "idb", completedAt: 1, blob: 1 },
    part: { trackId: "old-part", recordingId: "old-recording", size: 4, loaded: 1, updatedAt: 2 },
    chunk: true,
    history: { recordingId: "old-recording", entries: [{ trackId: "old-track", position: 3, timestamp: now, kind: "seek" }] },
    // Keep's record stays this account's choice; the app's Keep runtime may add its own fields to it.
    keep: expect.objectContaining({ workId: "old-work", on: true, updatedAt: 5 }),
  });
});

// Two accounts on one device (spec #572 guard 7; #577 "anything one account could learn about another's books"): the
// chip and the favourites by work are each account's own, and the Library shows only the account's own works.
test.describe("two accounts on one device", () => {
  let server: ChildProcess | undefined;
  let base = "";
  test.beforeAll(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
        env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: String(port) },
        stdio: "ignore",
      });
      for (let i = 0; i < 100 && server.exitCode === null; i++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      server.kill();
    }
    throw new Error("Authenticated browser server did not start");
  });
  test.afterAll(() => {
    server?.kill();
  });

  async function signIn(page: Page, username: string | null, password: string) {
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    if (username) await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeHidden();
    // Signing in lands on the address asked for (Settings › Account after Sign out); the Library is the test's.
    await page.goto(`${base}/#library`);
    await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
  }
  async function signOut(page: Page) {
    await page.goto(`${base}/#settings/account`);
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Sign out" }).click()]);
  }

  test("the chip and the favourites are each account's own; the second account sees only its own books", async ({ page }) => {
    await page.goto(base);
    await signIn(page, null, "admin-password");
    const created = await page.request.post(`${base}/api/users`, { data: { username: "shelf-reader", password: "reader-password" } });
    expect(created.ok() || created.status() === 409).toBe(true);
    const adminBooks = (await (await page.request.get(`${base}/api/books`)).json()) as { title: string; workId: string; inLibrary: boolean }[];
    const frankenstein = adminBooks.find((b) => b.title === "Frankenstein")!;
    const adminCount = new Set(adminBooks.filter((b) => b.inLibrary).map((b) => b.workId)).size;
    expect(adminCount).toBeGreaterThan(1);
    // The administrator's favourite and chip.
    await page.getByRole("button", { name: "About Frankenstein", exact: true }).click();
    await page.getByRole("button", { name: "Favorite", exact: true }).click();
    await expect(page.getByRole("button", { name: "Favorite", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.goto(`${base}/#library`);
    await choose(page, "Favorites");
    await expect(page.locator(".library-tile")).toHaveCount(1);
    await signOut(page);

    // The reader has Frankenstein in their own library and nothing else.
    await signIn(page, "shelf-reader", "reader-password");
    expect((await page.request.put(`${base}/api/works/${encodeURIComponent(frankenstein.workId)}/library`)).ok()).toBe(true);
    await page.reload();
    await expect(chip(page, "All")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".library-tile")).toHaveCount(1);
    await expect(tile(page, "Frankenstein")).toHaveCount(1);
    // The administrator's favourite is not the reader's.
    await choose(page, "Favorites");
    await expect(page.getByRole("heading", { name: "No books", exact: true })).toBeVisible();
    await choose(page, "Not started");
    await signOut(page);

    // Back as the administrator: the administrator's chip and favourite, as they were left.
    await signIn(page, null, "admin-password");
    await expect(chip(page, "Favorites")).toHaveAttribute("aria-pressed", "true");
    await expect(tile(page, "Frankenstein")).toHaveCount(1);
    await choose(page, "All");
    await expect(page.locator(".library-tile")).toHaveCount(adminCount);
  });
});
