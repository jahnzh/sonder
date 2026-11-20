import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseRange } from "../../server/range";
import { listenFace, openListen } from "./now-playing";
import { installCpuThrottle } from "./cpu-throttle";
test.use({ serviceWorkers: "block" });
// SONDER_E2E_CPU_THROTTLE=4 runs it on a slow processor, as on a busy check host (#783).
installCpuThrottle(test);
let ALICE_WORK = "";
test.beforeEach(async ({ page }) => {
  ALICE_WORK = (await (await page.request.get("/api/books")).json()).find((book: any) => book.id === "alice").workId;
});
/** The library by work answers Alice with the same tracks as the books do, so the Book page counts the same files. */
async function sliceLibrary(page: Page, count: number) {
  const slice = (work: any) => ({
    ...work,
    recordings: work.recordings.map((recording: any) => ({ ...recording, tracks: recording.tracks.slice(0, count) })),
  });
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    const works = await response.json();
    await route.fulfill({ status: 200, contentType: "application/json", json: works.map((w: any) => (w.workId === ALICE_WORK ? slice(w) : w)) });
  });
}

test("offline downloads retry temporary HTTP errors at different chapter boundaries", async ({
  page,
}) => {
  const media = readFileSync("server/demo/alice-01.mp3");
  const attempts = new Map<string, number>();
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const books = await response.json();
    const alice = books.find((book: any) => book.id === "alice");
    alice.tracks = alice.tracks.slice(0, 2);
    await route.fulfill({ response, json: books });
  });
  await sliceLibrary(page, 2);
  await page.route(/\/api\/media\/alice-[01]$/, (route) => {
    if (!route.request().headers()["x-sonder-download"])
      return route.continue();
    const range = parseRange(route.request().headers()["range"], media.length);
    if (!range || range === "invalid")
      throw new Error("Expected a valid range");
    const track = route.request().url().split("/").at(-1);
    const key = `${track}:${range.start}`;
    const count = (attempts.get(key) || 0) + 1;
    attempts.set(key, count);
    if (
      count === 1 &&
      ((track === "alice-0" && range.start > 0) ||
        (track === "alice-1" && range.start === 0))
    )
      return route.fulfill({
        status: track === "alice-1" ? 429 : 503,
        headers: { "Retry-After": "0" },
        json: {
          error: "Temporary source error",
          retryable: true,
          retryAfterMs: 0,
        },
      });
    return route.fulfill({
      status: 206,
      body: media.subarray(range.start, range.end + 1),
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Range": `bytes ${range.start}-${range.end}/${media.length}`,
        "X-Sonder-Media-Version": `retry-fixture-${track}`,
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  // The Book page's Keep on this device switch starts today's save (#532).
  const keep = page.getByRole("switch", { name: "Keep on this device", exact: true });
  await keep.click();
  await expect(keep).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#book-keep-line")).toHaveText(/^Audiobook( and ebook)? · /, { timeout: 20000 });
  expect(attempts.get(`alice-0:${4 * 1024 * 1024}`)).toBe(2);
  expect(attempts.get("alice-1:0")).toBe(2);
  // No saving toasts (#550): the line is the outcome.
  await expect(page.locator(".toast")).toHaveCount(0);
});
test("player downloads retain verified sections after connection failure and resume by themselves after reload", async ({
  page,
}) => {
  const media = readFileSync("server/demo/alice-01.mp3");
  const starts: number[] = [];
  let fail = true;
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const books = await response.json();
    books.find((book: any) => book.id === "alice").tracks = books
      .find((book: any) => book.id === "alice")
      .tracks.slice(0, 1);
    await route.fulfill({ response, json: books });
  });
  await sliceLibrary(page, 1);
  await page.route("**/api/media/alice-0", (route) => {
    if (!route.request().headers()["x-sonder-download"])
      return route.continue();
    const range = parseRange(route.request().headers()["range"], media.length);
    if (!range || range === "invalid")
      throw new Error("Device download must request a bounded range");
    starts.push(range.start);
    if (range.start > 0 && fail) return route.abort("failed");
    return route.fulfill({
      status: 206,
      body: media.subarray(range.start, range.end + 1),
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Range": `bytes ${range.start}-${range.end}/${media.length}`,
        "X-Sonder-Media-Version": "fixture-v1",
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  });
  // The save starts from the Book page's Keep on this device switch (#532); the player's own button follows it.
  await page.goto(`/#book/${encodeURIComponent(ALICE_WORK)}`);
  const keep = page.getByRole("switch", { name: "Keep on this device", exact: true });
  await keep.click();
  // The connection failed: no toast (#550), the line says what is missing; the switch stays on, the row offers Resume.
  await expect(page.locator("#book-keep-line")).toHaveText("Not complete · 0 of 1 files", { timeout: 20000 });
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(keep).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  // Now playing's Listen face shows the same Keep row and line (#593; the device download progress left it).
  await openListen(page);
  await expect(page.locator("#listen-keep-line")).toHaveText("Not complete · 0 of 1 files", { timeout: 20000 });
  await expect(listenFace(page).getByRole("button", { name: "Resume", exact: true })).toBeVisible({ timeout: 20000 });
  expect(starts.filter((start) => start === 0)).toHaveLength(1);
  expect(starts.filter((start) => start === 4 * 1024 * 1024)).toHaveLength(4);
  const pending = await page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const req = indexedDB.open("sonder");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(["downloadParts", "downloads"], "readonly");
          const part = tx.objectStore("downloadParts").get("alice-0");
          const complete = tx.objectStore("downloads").get("alice-0");
          tx.oncomplete = () => {
            resolve({ part: part.result, complete: complete.result });
            db.close();
          };
        };
      }),
  );
  expect(pending.part.loaded).toBe(4 * 1024 * 1024);
  expect(pending.complete).toBeUndefined();
  fail = false;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  // After a reload the switch is still on and the save carries on by itself from the saved sections (#550).
  await expect(keep).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#book-keep-line")).toHaveText(/^Audiobook( and ebook)? · /, { timeout: 20000 });
  await openListen(page);
  await expect(listenFace(page).getByRole("switch", { name: "Keep on this device", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#listen-keep-line")).toHaveText(/^Audiobook( and ebook)? · /, { timeout: 20000 });
  expect(starts.filter((start) => start === 0)).toHaveLength(1);
  const checksum = await page.evaluate(async () => {
    const chunks = await new Promise<any[]>((resolve) => {
      const req = indexedDB.open("sonder");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("downloadChunks", "readonly");
        const data = tx
          .objectStore("downloadChunks")
          .index("trackId")
          .getAll("alice-0");
        data.onsuccess = () => resolve(data.result);
        tx.oncomplete = () => db.close();
      };
    });
    const blob = new Blob(
      chunks.sort((a, b) => a.offset - b.offset).map((chunk) => chunk.blob),
    );
    return [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
      ),
    ]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  });
  expect(checksum).toBe(createHash("sha256").update(media).digest("hex"));
  // No overflow: against the window, which is 393 wide with the iPhone profile (#596).
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
  await page.screenshot({
    path: "artifacts/player-device-download-mobile.png",
  });
  await listenFace(page).getByRole("button", { name: "Open this book’s page", exact: true }).click();
  // The player's book button opens the Book page (#532): its Audiobook row opens the Audiobook page (#530), where
  // Get another recording is.
  const bookPage = page.getByRole("region", { name: "Book", exact: true });
  await expect(bookPage.getByRole("button", { name: /^Audiobook / })).toBeVisible();
  // The ebook's actions pass through the Ebook row (#531): Get when the book has no edition yet, otherwise the
  // row opens the Ebook page, whose Get another edition opens the same sheet.
  const ebookRow = bookPage.getByRole("list", { name: "Files", exact: true }).getByRole("listitem").nth(1);
  await expect(ebookRow.getByText("Ebook", { exact: true })).toBeVisible();
  const getEbook = ebookRow.getByRole("button", { name: "Get an ebook", exact: true });
  if (await getEbook.count()) {
    await expect(ebookRow).toContainText("Not added");
    await getEbook.click();
  } else {
    await ebookRow.getByRole("button", { name: /^Ebook / }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Ebook", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Get another edition", exact: true }).click();
  }
  // The Get ebook sheet for the book (#604).
  await expect(page).toHaveURL(/#book\/[^/]+\/get\/ebook$/);
  await expect(page.getByRole("dialog", { name: "Get ebook", exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Get ebook", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Get ebook", exact: true })).toHaveCount(0);
  await page.reload();
  // Listen makes the book ready to play; then the mini player names where it plays from.
  await openListen(page);
  await page.getByRole("button", { name: "Close now playing", exact: true }).click();
  await expect(page.locator(".player-dock").getByLabel("Playback source")).toHaveText("Device cache", { timeout: 20000 });
});
