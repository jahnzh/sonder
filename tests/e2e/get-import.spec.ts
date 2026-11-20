// @projects firefox
// Import from this device into the book (#605, spec #600 "Import from this device"): "Import files from this device"
// on Get audiobook and "Import a file from this device" on Get ebook open the device's file chooser, and choosing
// starts the upload at once, with the book's workId. While it runs the row is a File row with its bar ("Uploading ·
// N%", then "Preparing the audio…" or "Importing…"); a second import waits (the row is off); the end with the sheet
// open closes it to the Book page with the new recording or edition; the sheet closed meanwhile leaves the upload going
// and its end is the toast; a refusal stands in the row in the failed colour and the row can be tapped again. The
// uploads reach the suite's own server: only their answer is held back by a route, so the test sees the row while it
// runs (a slowed upload). An ebook imported into the book persists after a reload (guard 14 of spec #600, for a book).
import { test, expect, type Page, type Route, type Request } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0)) await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`).catch(() => {});
});

const unique = (label: string) => `${label} ${test.info().repeatEachIndex} ${randomBytes(3).toString("hex")}`;
const MP3 = readFileSync("server/demo/alice-01.mp3");

const audioSheet = (page: Page) => page.getByRole("dialog", { name: "Get audiobook", exact: true });
const ebookSheet = (page: Page) => page.getByRole("dialog", { name: "Get ebook", exact: true });
const bookRegion = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const files = (page: Page) => bookRegion(page).getByRole("list", { name: "Files", exact: true });
const importAudio = (page: Page) => audioSheet(page).getByRole("button", { name: /^Import files from this device/ });
const importEbook = (page: Page) => ebookSheet(page).getByRole("button", { name: /^Import a file from this device/ });
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));

/** A book with only an ebook, in the administrator's library (#555); its work's title and author as the server has them. */
async function ebookOnlyBook(page: Page, title: string) {
  const response = await page.request.post("/api/ebooks/import", {
    multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id as string;
  const ebook = ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === id)!;
  made.push(ebook.workId);
  const work = await (await page.request.get(`/api/works/${encodeURIComponent(ebook.workId)}`)).json();
  return { workId: ebook.workId as string, title: work.title as string, author: work.author as string };
}

/** A book with a recording and no ebook, in the administrator's library. */
async function audioOnlyBook(page: Page, title: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Get Import QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: MP3 } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id as string;
  const book = ((await (await page.request.get("/api/books")).json()) as { id: string; workId: string }[]).find((b) => b.id === id)!;
  made.push(book.workId);
  return { workId: book.workId, title };
}

/** The searches answered with nothing: the suite's server cannot reach AudioBookBay or Library Genesis. */
async function quietSources(page: Page) {
  await page.route("**/api/discover/abb/releases?*", (route) => route.fulfill({ json: { results: [], nextPage: null } }).catch(() => {}));
  await page.route("**/api/discover/prowlarr/releases?*", (route) => route.fulfill({ json: { results: [] } }).catch(() => {}));
  await page.route("**/api/discover/ebooks?*", (route) => route.fulfill({ json: { files: [], website: "https://libgen.li" } }).catch(() => {}));
}

type Held = { requests: Request[]; release: () => void };
/**
 * Uploads to `pattern` wait in the browser until `release()` is called, then go to the suite's server: until then the
 * upload is under way as far as the page knows (a slowed upload, its row at "Uploading · 0%").
 */
async function holdUploads(page: Page, pattern: RegExp): Promise<Held> {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const held: Held = { requests: [], release: () => open() };
  await page.route(pattern, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    held.requests.push(route.request());
    await gate;
    await route.continue().catch(() => {});
  });
  return held;
}

/**
 * Chromium's network slowed for the page (CDP: the upload throttled and every answer late), so the bytes' progress
 * and then the server's turn are each on screen long enough to be read. Not a route: an intercepted request reports
 * no upload progress in Chromium. Other browsers get null and hold the upload instead.
 */
async function slowNetwork(page: Page, browserName: string) {
  if (browserName !== "chromium") return null;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: 2 * 1024 * 1024 });
  return { restore: () => cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }) };
}

/** The parts of a multipart body in order: each field's name, and a file's name. */
function partsOf(body: Buffer) {
  const text = body.toString("latin1");
  return [...text.matchAll(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r]*\r\n)?\r\n([^\r]*)/g)].map((m) =>
    m[2] !== undefined ? { name: m[1], file: m[2] } : { name: m[1], value: m[3] },
  );
}

async function chooseFiles(page: Page, row: ReturnType<Page["locator"]>, chosen: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent("filechooser");
  await row.click();
  const fileChooser = await chooser;
  await fileChooser.setFiles(chosen);
  return fileChooser;
}

test("audio files imported into a book from Get audiobook: progress in the row, the sheet closing to the book, the new recording on the Audiobook page", async ({ page, browserName }) => {
  const book = await ebookOnlyBook(page, unique("Import audio"));
  await quietSources(page);
  const sent: Buffer[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/import$/.test(request.url())) sent.push(request.postDataBuffer() ?? Buffer.alloc(0));
  });
  await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
  await expect(files(page)).toContainText("Not added");
  await page.goto(`/#book/${encodeURIComponent(book.workId)}/get/audiobook`);
  await expect(audioSheet(page).getByRole("heading", { level: 1 })).toHaveText(book.title);
  const slow = await slowNetwork(page, browserName);
  const held = slow ? null : await holdUploads(page, /\/api\/import$/);
  const chooser = await chooseFiles(page, importAudio(page), [
    { name: "10 Ten.mp3", mimeType: "audio/mpeg", buffer: MP3 },
    { name: "2 Two.mp3", mimeType: "audio/mpeg", buffer: MP3 },
  ]);
  // Several audio files of today's list.
  expect(chooser.isMultiple()).toBe(true);
  expect(await chooser.element().getAttribute("accept")).toBe(".mp3,.m4b,.m4a,.ogg,.opus,.flac,.wav,audio/*");
  // While it runs: a File row with its bar, "Uploading · N%" while the bytes go, then "Preparing the audio…".
  const running = audioSheet(page).locator(".part-file-row").filter({ hasText: "Import files from this device" });
  await expect(running).toContainText(/Uploading · \d+%/);
  await expect(running.locator(".part-progress")).toBeVisible();
  // The button and the other rows stay usable.
  await expect(audioSheet(page).getByRole("searchbox", { name: "Search for a recording" })).toBeEnabled();
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/get-import-audio-running-mobile-${browserName}.png` });
  if (slow) {
    await expect(running).toContainText(/Uploading · ([1-9]\d?)%/);
    await expect(running).toContainText("Preparing the audio…", { timeout: 20_000 });
  }
  held?.release();
  // The end with the sheet open: the sheet closes to the Book page, which shows the recording. No toast.
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}$`));
  await expect(audioSheet(page)).toHaveCount(0);
  await expect(files(page)).not.toContainText("Not added");
  await expect(page.locator(".toast")).toHaveCount(0);
  // The new recording on the Audiobook page, under the book's own title.
  await files(page).getByRole("button", { name: /^Audiobook/ }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}/audiobook$`));
  const audiobook = page.getByRole("region", { name: "Audiobook", exact: true });
  await expect(audiobook.getByText(book.title, { exact: true })).toBeVisible();
  await expect(audiobook.getByRole("radiogroup", { name: "Recordings", exact: true }).getByRole("radio")).toHaveCount(1);
  await slow?.restore();
  // The book first, then the files in name order ("2" before "10"); no title or author typed.
  expect(sent).toHaveLength(1);
  expect(partsOf(sent[0])).toEqual([
    { name: "workId", value: book.workId },
    { name: "files", file: "2 Two.mp3" },
    { name: "files", file: "10 Ten.mp3" },
  ]);
});

test("the sheet closed during an upload: the upload goes on, another import waits, and its end is the toast", async ({ page }) => {
  const book = await ebookOnlyBook(page, unique("Import closed"));
  await quietSources(page);
  const held = await holdUploads(page, /\/api\/import$/);
  await page.goto(`/#book/${encodeURIComponent(book.workId)}/get/audiobook`);
  await expect(audioSheet(page).getByRole("heading", { level: 1 })).toHaveText(book.title);
  await chooseFiles(page, importAudio(page), [{ name: "Part 1.mp3", mimeType: "audio/mpeg", buffer: MP3 }]);
  await expect(audioSheet(page).locator(".part-file-row")).toContainText(/Import files from this deviceUploading · \d+%/);
  // Close: back to the Book page; the upload is not stopped.
  await audioSheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(audioSheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}$`));
  // A second import waits until the first ends: Get ebook's import row is off.
  await page.goto(`/#book/${encodeURIComponent(book.workId)}/get/ebook`);
  await expect(importEbook(page)).toHaveAttribute("aria-disabled", "true");
  let chose = false;
  page.once("filechooser", () => (chose = true));
  // A tap on the row that is off (Playwright waits for an aria-disabled button to turn on: forced).
  await importEbook(page).click({ force: true });
  await page.waitForTimeout(300);
  expect(chose).toBe(false);
  await ebookSheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(ebookSheet(page)).toHaveCount(0);
  expect(held.requests).toHaveLength(1);
  held.release();
  // Its end is the app's toast; the Book page shows the recording.
  await expect(page.locator(".toast")).toHaveText(`${book.title}: audio files imported.`);
  await expect(page.locator(".toast")).not.toHaveClass(/error/);
  await expect(files(page)).not.toContainText("Not added");
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}$`));
  await page.screenshot({ path: `${OUT}/get-import-toast-mobile.png` });
});

test("an EPUB imported into a book from Get ebook: Importing… in the row, the sheet closing to the book with the edition, kept after a reload", async ({ page, browserName }) => {
  const title = unique("Import ebook");
  const book = await audioOnlyBook(page, title);
  await quietSources(page);
  const asked: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/ebooks/import?")) asked.push(request);
  });
  await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
  await expect(files(page).getByRole("button", { name: "Get an ebook", exact: true })).toBeVisible();
  await files(page).getByRole("button", { name: "Get an ebook", exact: true }).click();
  await expect(ebookSheet(page).getByRole("heading", { level: 1 })).toHaveText(title);
  const slow = await slowNetwork(page, browserName);
  const held = slow ? null : await holdUploads(page, /\/api\/ebooks\/import\?/);
  const chooser = await chooseFiles(page, importEbook(page), [{ name: "Book.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) }]);
  // One EPUB or PDF.
  expect(chooser.isMultiple()).toBe(false);
  expect(await chooser.element().getAttribute("accept")).toBe(".epub,.pdf,application/epub+zip,application/pdf");
  const running = ebookSheet(page).locator(".part-file-row").filter({ hasText: "Import a file from this device" });
  // "Uploading · N%", then "Importing…" in the slowed network; the upload held before it is sent elsewhere.
  if (slow) await expect(running).toContainText("Importing…", { timeout: 20_000 });
  else await expect(running).toContainText(/Uploading · \d+%/);
  await expect(running.locator(".part-progress")).toBeVisible();
  await expect.poll(() => asked.length).toBe(1);
  expect(new URL(asked[0].url()).searchParams.get("workId")).toBe(book.workId);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${OUT}/get-import-ebook-running-desktop-${browserName}.png` });
  await noOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  held?.release();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}$`));
  await expect(ebookSheet(page)).toHaveCount(0);
  // The Ebook row shows the edition: it opens the Ebook page now.
  const ebookRow = files(page).getByRole("button", { name: /^Ebook/ });
  await expect(ebookRow).toBeVisible();
  await expect(files(page).getByRole("button", { name: "Get an ebook", exact: true })).toHaveCount(0);
  await slow?.restore();
  // Kept after a reload.
  await page.reload();
  await expect(files(page).getByRole("button", { name: /^Ebook/ })).toBeVisible();
  const work = await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json();
  expect(work.ebooks).toHaveLength(1);
});

test("a refused file stands in the row in the failed colour, and the row can be tapped again", async ({ page, browserName }) => {
  const book = await ebookOnlyBook(page, unique("Import refused"));
  await quietSources(page);
  await page.goto(`/#book/${encodeURIComponent(book.workId)}/get/audiobook`);
  await expect(audioSheet(page).getByRole("heading", { level: 1 })).toHaveText(book.title);
  // A file the chooser would not offer (its list is audio), as a drop or another browser can still give.
  await chooseFiles(page, importAudio(page), [{ name: "Notes.txt", mimeType: "text/plain", buffer: Buffer.from("not audio") }]);
  const refusal = audioSheet(page).getByRole("alert").filter({ hasText: "Choose MP3, M4B, M4A, OGG, Opus, FLAC, or WAV audio files." });
  await expect(refusal).toBeVisible();
  const danger = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  await expect(refusal).toHaveCSS("color", danger);
  await expect(importAudio(page)).not.toHaveAttribute("aria-disabled", "true");
  // The sheet stays, on its own address; nothing was added.
  await expect(page).toHaveURL(new RegExp(`/get/audiobook$`));
  await expect(page.locator(".toast")).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/get-import-refused-mobile-${browserName}.png` });
  await noOverflow(page);
  // Tapped again: the chooser opens, and a good file goes in.
  await chooseFiles(page, importAudio(page), [{ name: "Part 1.mp3", mimeType: "audio/mpeg", buffer: MP3 }]);
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}$`), { timeout: 20_000 });
  await expect(files(page)).not.toContainText("Not added");
  // An ebook refused in Get ebook stands in its row the same way.
  await page.goto(`/#book/${encodeURIComponent(book.workId)}/get/ebook`);
  await chooseFiles(page, importEbook(page), [{ name: "Broken.epub", mimeType: "application/epub+zip", buffer: Buffer.from("not a zip") }]);
  await expect(ebookSheet(page).getByRole("alert")).toBeVisible();
  await expect(ebookSheet(page).getByRole("alert")).toHaveCSS("color", danger);
  await expect(importEbook(page)).not.toHaveAttribute("aria-disabled", "true");
});
