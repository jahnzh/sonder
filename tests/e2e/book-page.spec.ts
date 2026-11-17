// The Book page (#532, spec #526 "The Book page"; boards Book, BookMore, BookGetting, BookSeries): `#book/<workId>`.
// A book with both files and a ready reading sync, one whose audiobook is downloading, the place line in each, Listen
// and Read, the rows that open the Audiobook and Ebook pages, the series line, Mark as finished and back, Remove from
// library (asks once, Cancel sends nothing, the work's DELETE), the heart and the Favorites filter, the This device
// switch, a Library book without a connection, Back, and the measures against the boards at phone size and desktop.
import { test, expect, type Page, type Request } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

// Every work a test imports leaves the library after it, so a repeat on one server finds one book of each title and
// a book played here is not the Library's featured book for the specs that run next (#645).
const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

const unique = (title: string) => `${title} ${randomUUID().slice(0, 8)}`;
type Made = { id: string; workId: string; recordingId: string; tracks: { id: string; duration: number }[]; title: string; ebookId: string | null };

/** A real book: an imported recording, and with `ebook` an EPUB imported into its work. */
async function importBook(page: Page, title: string, ebook = true): Promise<Made> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Book page QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  let ebookId: string | null = null;
  if (ebook) {
    const imported = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(book.workId)}`, {
      multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } },
    });
    expect(imported.ok()).toBe(true);
    const work = await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json();
    ebookId = work.ebooks[0].id;
  }
  return { id, workId: book.workId, recordingId: book.recordingId, tracks: book.tracks, title, ebookId };
}

/**
 * Answers the library by work (and the work's own read) with `change` applied to the work: a state the suite's
 * server cannot make for real (a ready reading sync, a download on its way, a series). The entity tag is dropped,
 * so the store always takes the changed answer.
 */
async function routeWork(page: Page, workId: string, change: (work: any) => any) {
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    const works = await response.json();
    const next = works.map((work: any) => (work.workId === workId ? change(work) : work));
    await route.fulfill({ status: 200, contentType: "application/json", json: next }).catch(() => {});
  });
  await page.route(`**/api/works/${encodeURIComponent(workId)}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) }).catch(() => {});
  });
}
const readySync = (book: Made) => (work: any) => ({
  ...work,
  description: "A long description of the book. ".repeat(20),
  readingSync: [
    { id: "job-ready", ebookId: book.ebookId, recordingId: book.recordingId, status: "ready", progress: 1, engine: "book", error: null, warning: null, fingerprint: "", audioFingerprint: "", updatedAt: 1, createdAt: 1, coverage: 1, intervalCount: 12, outcome: "mapped" },
  ],
});

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = [];
    (window as any).__audioElements = elements;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        elements.push(this);
      }
    };
  });
}
const audioState = (page: Page) =>
  page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find((a) => !!a.src);
    return audio ? { position: audio.currentTime, src: audio.src, paused: audio.paused } : null;
  });

const address = (workId: string) => `/#book/${encodeURIComponent(workId)}`;
const region = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const files = (page: Page) => region(page).getByRole("list", { name: "Files", exact: true });
const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
const clientHeight = (locator: ReturnType<Page["locator"]>) => locator.evaluate((el) => (el as HTMLElement).clientHeight);
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
const keep = (page: Page) => region(page).getByRole("switch", { name: "Keep on this device", exact: true });

test("a book with both files and a ready reading sync, as the boards draw it, at phone size and on a desktop", async ({ page }) => {
  const book = await importBook(page, unique("Board book"));
  await routeWork(page, book.workId, readySync(book));
  // The boards draw the page without Hardcover: answered as not connected, whatever an earlier spec left on the
  // suite's shared server (a connected Hardcover adds its row to the last group).
  await page.route("**/api/hardcover", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, configured: false } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(address(book.workId));
  const shown = region(page);
  await expect(shown).toBeVisible();
  // One Title: the book's. The head: the back button named after where it goes, and Favorite.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText([book.title]);
  await expect(shown.getByRole("button", { name: "Back to Library", exact: true })).toBeVisible();
  await expect(shown.getByRole("button", { name: "Favorite", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(shown.getByText("Book page QA", { exact: true })).toBeVisible();
  await expect(shown.getByTestId("book-place")).toHaveText("Not started");
  await expect(shown.getByRole("button", { name: "Listen", exact: true })).toBeEnabled();
  await expect(shown.getByRole("button", { name: "Read", exact: true })).toBeEnabled();
  // The groups in the boards' order: Files, This device, About; then the group of Hardcover, Mark as finished, Remove.
  await expect(shown.getByRole("heading", { level: 2 })).toHaveText(["Files", "This device", "About"]);
  await expect(files(page).getByRole("listitem")).toHaveText([/^Audiobook/, /^Ebook/, /^Reading sync/]);
  await expect(files(page).getByRole("button", { name: /^Audiobook Book page QA · \d+ min · On server$/ })).toBeVisible();
  await expect(files(page).getByRole("button", { name: /^Ebook EPUB · [\d.]+ (KB|MB) · On server/ })).toBeVisible();
  const sync = files(page).getByRole("listitem").nth(2);
  await expect(sync.getByRole("button", { name: "About Reading sync", exact: true })).toBeVisible();
  // With both files Reading sync opens its page (#540): the name is the link, the info mark a button beside it.
  await expect(sync.getByRole("button", { name: "Reading sync Ready · estimated timings", exact: true })).toBeVisible();
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await expect(shown.getByRole("button", { name: "About Keep on this device", exact: true })).toBeVisible();
  const about = shown.getByRole("button", { name: "Show the whole description", exact: true });
  await expect(about).toHaveAttribute("aria-expanded", "false");
  const more = shown.getByRole("list", { name: "Book", exact: true });
  await expect(more.getByRole("button")).toHaveText(["Mark as finished", "Remove from library"]);
  // Measures: file rows 64, rows 52, the head's buttons and Listen/Read 44.
  for (const row of await files(page).locator(".part-file-row").all()) expect(await clientHeight(row)).toBe(64);
  expect(await clientHeight(shown.locator(".book-page-keep"))).toBe(64);
  for (const row of await more.locator(".part-row").all()) expect(await clientHeight(row)).toBe(52);
  for (const name of ["Back to Library", "Favorite", "Listen", "Read"]) expect((await box(shown.getByRole("button", { name, exact: true }))).height).toBe(44);
  expect((await box(shown.locator(".book-page-cover"))).width).toBe(96);
  // The description is collapsed to three lines, and expands in place.
  const collapsed = (await box(about)).height;
  expect(collapsed).toBeLessThanOrEqual(3 * 20 + 32 + 1);
  await about.click();
  await expect(about).toHaveAttribute("aria-expanded", "true");
  expect((await box(about)).height).toBeGreaterThan(collapsed);
  await about.click();
  const tops = await Promise.all([shown.getByRole("button", { name: "Listen", exact: true }), files(page), keep(page), about, more].map(async (l) => (await box(l)).y));
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-phone.png`, fullPage: true });
  // A reload keeps the address and the page.
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}$`));
  await expect(files(page)).toBeVisible();
  // Desktop: one centred column beside the rail, the same measures.
  await page.setViewportSize({ width: 1440, height: 900 });
  const main = await box(page.locator("main"));
  const column = await box(region(page));
  expect(column.width).toBeLessThanOrEqual(560);
  expect(Math.abs(column.x + column.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
  for (const row of await files(page).locator(".part-file-row").all()) expect(await clientHeight(row)).toBe(64);
  for (const row of await region(page).getByRole("list", { name: "Book", exact: true }).locator(".part-row").all()) expect(await clientHeight(row)).toBe(52);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText([book.title]);
  await noOverflow(page);
  // No explanation left open by the pointer resting on a mark.
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-desktop.png` });
  expect(errors).toEqual([]);
});

test("Listen plays the chosen recording from its place; Read opens the chosen EPUB; the rows open their pages and Back returns", async ({ page }) => {
  const book = await importBook(page, unique("Listen book"));
  await instrument(page);
  // A place in the recording: the place line reads its chapter and the time left, and Listen starts there.
  const saved = await page.request.post("/api/progress", {
    data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 61, duration: book.tracks[0].duration, updatedAt: Date.now() },
  });
  expect(saved.ok()).toBe(true);
  await page.goto(address(book.workId));
  await expect(region(page).getByTestId("book-place")).toHaveText(/^Chapter 1 · \d+ min left$/);
  // The Audiobook row opens the Audiobook page, whose back button returns to the book.
  await files(page).getByRole("button", { name: /^Audiobook / }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Audiobook", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}/audiobook$`));
  await page.getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}$`));
  // The Ebook row opens the Ebook page.
  await files(page).getByRole("button", { name: /^Ebook / }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ebook", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(region(page)).toBeVisible();
  // Read opens the chosen EPUB in the reader, without a chooser.
  await region(page).getByRole("button", { name: "Read", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#reader/${encodeURIComponent(book.ebookId!)}$`));
  await expect(page.getByRole("dialog", { name: "Reader" })).toBeVisible();
  await page.goBack();
  await expect(region(page)).toBeVisible();
  // Listen plays the chosen recording from its place and opens the player.
  await region(page).getByRole("button", { name: "Listen", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Now playing" })).toBeVisible();
  await expect.poll(async () => (await audioState(page))?.src ?? "").toContain(book.tracks[0].id);
  await expect.poll(async () => Math.round((await audioState(page))?.position ?? 0)).toBe(61);
  await page.getByRole("dialog", { name: "Now playing" }).getByRole("button", { name: "Pause narration" }).first().click().catch(() => {});
  await page.evaluate(() => ((window as any).__audioElements as HTMLAudioElement[]).forEach((audio) => audio.pause()));
});

test("a book whose audiobook is downloading: the download's line and bar, Get for the ebook, Needs an ebook", async ({ page }) => {
  const book = await importBook(page, unique("Getting book"), false);
  await routeWork(page, book.workId, (work) => ({
    ...work,
    recordings: [],
    chosenRecordingId: null,
    mediaState: { state: "queued", holdReason: null, acquisition: { id: "acq-getting", status: "downloading", progress: 0.43, error: null } },
  }));
  await page.goto(address(book.workId));
  const shown = region(page);
  await expect(shown.getByTestId("book-place")).toHaveText("Not started");
  await expect(shown.getByRole("button", { name: "Listen", exact: true })).toBeDisabled();
  await expect(shown.getByRole("button", { name: "Read", exact: true })).toBeDisabled();
  const audiobook = files(page).getByRole("button", { name: "Audiobook Downloading to server · 43%", exact: true });
  await expect(audiobook).toBeVisible();
  await expect(audiobook.locator(".part-progress")).toBeVisible();
  await expect(files(page).getByRole("listitem").nth(1)).toHaveAccessibleName("Ebook Not added");
  await expect(files(page).getByRole("button", { name: "Get an ebook", exact: true })).toBeVisible();
  await expect(files(page).getByRole("listitem").nth(2)).toHaveAccessibleName("Reading sync Needs an ebook");
  // This device shows for every book in the library (#550), with nothing to save yet.
  await expect(shown.getByRole("heading", { name: "This device" })).toHaveCount(1);
  for (const row of await files(page).locator(".part-file-row").all()) expect(await clientHeight(row)).toBe(64);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-getting-phone.png`, fullPage: true });
  // The moving row opens Activity.
  await audiobook.click();
  await expect(page).toHaveURL(/#activity$/);
});

test("the series line opens the series; Mark as finished and back", async ({ page }) => {
  const book = await importBook(page, unique("Series book"), false);
  await routeWork(page, book.workId, (work) => ({ ...work, series: [{ id: 4242, name: "The Culture", position: 8, saved: false }] }));
  await page.route("**/api/series/4242**", (route) => route.fulfill({ status: 404, json: { error: "Series not found." } }));
  await page.goto(address(book.workId));
  const shown = region(page);
  await shown.getByRole("button", { name: "The Culture · Book 8", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const marks: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/works/${encodeURIComponent(book.workId)}/completion`)) marks.push(request.postDataJSON());
  });
  await shown.getByRole("button", { name: "Mark as finished", exact: true }).click();
  await expect(shown.getByRole("button", { name: "Mark as not finished", exact: true })).toBeVisible();
  await expect(shown.getByTestId("book-place")).toHaveText("Finished");
  expect((await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json()).finished).toBe(true);
  await shown.getByRole("button", { name: "Mark as not finished", exact: true }).click();
  await expect(shown.getByRole("button", { name: "Mark as finished", exact: true })).toBeVisible();
  await expect(shown.getByTestId("book-place")).toHaveText("Not started");
  expect(marks).toEqual([{ status: "finished" }, { status: "unread" }]);
});

test("Remove from library asks once; Cancel sends nothing; Remove sends the work's DELETE and the book stays gone", async ({ page }) => {
  const book = await importBook(page, unique("Removed book"), false);
  // A place in the recording, which Remove from library keeps.
  const place = { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 44, duration: book.tracks[0].duration, updatedAt: Date.now() };
  expect((await page.request.post("/api/progress", { data: place })).ok()).toBe(true);
  const sent: Request[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/library") && request.method() !== "GET") sent.push(request);
  });
  await page.goto("/#library");
  await page.getByRole("button", { name: `About ${book.title}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}$`));
  const shown = region(page);
  await shown.getByRole("button", { name: "Remove from library", exact: true }).click();
  const confirm = shown.getByRole("group", { name: "Remove from library?", exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(sent).toEqual([]);
  await shown.getByRole("button", { name: "Remove from library", exact: true }).click();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.locator(".toast")).toContainText("Removed from your library");
  expect(sent.map((request) => `${request.method()} ${new URL(request.url()).pathname}`)).toEqual([`DELETE /api/works/${encodeURIComponent(book.workId)}/library`]);
  expect(sent[0].postData()).toBeNull();
  expect(await sent[0].headerValue("content-type")).toBeNull();
  await page.reload();
  await expect(page.getByRole("heading", { name: /Your library/ })).toBeVisible();
  await expect(page.getByRole("button", { name: `About ${book.title}`, exact: true })).toHaveCount(0);
  expect((await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json()).inLibrary).toBe(false);
  // The recording keeps its own place: added back, the work has it as it was.
  expect((await page.request.put(`/api/works/${encodeURIComponent(book.workId)}/library`)).ok()).toBe(true);
  const back = await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json();
  expect(back.recordings.map((r: any) => [r.recordingId, r.progress?.position])).toEqual([[book.recordingId, 44]]);
});

test("the heart and today's Favorites filter agree", async ({ page }) => {
  const book = await importBook(page, unique("Favorite book"), false);
  await page.goto(address(book.workId));
  const heart = region(page).getByRole("button", { name: "Favorite", exact: true });
  await heart.click();
  await expect(heart).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.getByRole("button", { name: `Remove ${book.title} from favorites`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("navigation", { name: "Your shelves" }).getByRole("button", { name: /^Favorites/ }).click();
  await expect(page.getByRole("button", { name: `About ${book.title}`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: `About ${book.title}`, exact: true }).click();
  await expect(heart).toHaveAttribute("aria-pressed", "true");
  await heart.click();
  await expect(heart).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page.getByRole("button", { name: `About ${book.title}`, exact: true })).toHaveCount(0);
});

test("the This device switch: on saves the recording and the EPUB; off asks with the size and keeps the place", async ({ page }) => {
  test.setTimeout(90_000);
  const book = await importBook(page, unique("Kept book"));
  const place = { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 33, duration: book.tracks[0].duration, updatedAt: Date.now() };
  expect((await page.request.post("/api/progress", { data: place })).ok()).toBe(true);
  await page.goto(address(book.workId));
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await keep(page).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await expect(region(page).locator("#book-keep-line")).toHaveText(/^Audiobook and ebook · [\d.]+ (KB|MB)$/, { timeout: 30_000 });
  const files = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open("sonder");
        request.onsuccess = () => {
          const count = request.result.transaction("downloads").objectStore("downloads").count();
          count.onsuccess = () => resolve(count.result);
        };
      }),
  );
  expect(files).toBeGreaterThanOrEqual(1);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-kept-phone.png`, fullPage: true });
  await keep(page).click();
  const ask = page.getByRole("dialog", { name: "Remove from this device?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText(/[\d.]+ (KB|MB) on this device\. Your place, bookmarks and the library entry stay\./);
  // Closing it changes nothing.
  await ask.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await keep(page).click();
  await page.getByRole("dialog", { name: "Remove from this device?" }).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await expect(region(page).locator("#book-keep-line")).toHaveCount(0);
  // The place stays, on the server and on the page.
  const after = (await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json()).recordings[0].progress;
  expect(after.position).toBe(33);
  await expect(region(page).getByTestId("book-place")).toHaveText(/^Chapter 1 · /);
});

test("without a connection a Library book opens from the stored work, with this device's newer place", async ({ page }) => {
  const book = await importBook(page, unique("Offline book"), false);
  await page.goto("/#library");
  // The stored library by work holds the book once the Library has read it.
  await expect(page.getByRole("button", { name: `About ${book.title}`, exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (workId) =>
          new Promise<boolean>((resolve) => {
            const request = indexedDB.open("sonder");
            request.onsuccess = () => {
              const db = request.result;
              if (!db.objectStoreNames.contains("works")) return resolve(false);
              const read = db.transaction("works").objectStore("works").get(workId);
              read.onsuccess = () => resolve(!!read.result);
            };
          }),
        book.workId,
      ),
    )
    .toBe(true);
  // A newer place saved on this device than the server has (none): 2 min into the recording.
  await page.evaluate(
    (place) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.open("sonder");
        request.onsuccess = () => {
          const tx = request.result.transaction("progress", "readwrite");
          tx.objectStore("progress").put(place);
          tx.oncomplete = () => resolve();
        };
      }),
    { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 120, duration: book.tracks[0].duration, updatedAt: Date.now() + 60_000 },
  );
  // No connection: every request to the server fails, the app itself is still served.
  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.reload();
  await page.getByRole("button", { name: `About ${book.title}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText([book.title]);
  await expect(region(page).getByTestId("book-place")).toHaveText(/^Chapter 1 · \d+ min left$/);
  await expect(files(page).getByRole("button", { name: /^Audiobook / })).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Back: from the Library to the page and back; a link straight to the page; a reload", async ({ page }) => {
  const book = await importBook(page, unique("Back book"), false);
  await page.goto("/#library");
  await page.getByRole("button", { name: `About ${book.title}`, exact: true }).click();
  await expect(region(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(region(page)).toHaveCount(0);
  await page.goForward();
  await expect(region(page)).toBeVisible();
  await region(page).getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  // A link straight to the page: its back button goes to the Library, its parent.
  await page.goto("about:blank");
  await page.goto(address(book.workId));
  await expect(region(page)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText([book.title]);
  await region(page).getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.getByRole("button", { name: `About ${book.title}`, exact: true })).toBeVisible();
});

test("every row, switch and button has a role and a name; someone who is not the administrator sees no Get", async ({ page }) => {
  const book = await importBook(page, unique("Named book"), false);
  await page.goto(address(book.workId));
  await expect(files(page)).toBeVisible();
  const unnamed = await region(page).evaluate((root) =>
    [...root.querySelectorAll("button, a, [role=switch], li")]
      .filter((el) => !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el.textContent ?? "").trim()))
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(unnamed).toEqual([]);
  // The administrator: Get for the missing ebook.
  await expect(files(page).getByRole("button", { name: "Get an ebook", exact: true })).toBeVisible();
  await files(page).getByRole("button", { name: "Get an ebook", exact: true }).click();
  await expect(page).toHaveURL(/#discover$/);
});
