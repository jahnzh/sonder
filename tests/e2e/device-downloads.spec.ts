import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseRange } from "../../server/range";
test.use({ serviceWorkers: "block" });
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
  await page.getByRole("button", { name: "Save offline", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Downloaded", exact: true }),
  ).toBeDisabled({ timeout: 20000 });
  expect(attempts.get(`alice-0:${4 * 1024 * 1024}`)).toBe(2);
  expect(attempts.get("alice-1:0")).toBe(2);
  await expect(page.locator(".toast")).not.toContainText("error");
});
test("player downloads retain verified sections after connection failure and resume after reload", async ({
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
  await page.goto("/");
  await page.locator(".dock-book").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Save on device", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume download", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".toast")).toContainText(
    "downloaded sections are kept",
  );
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
  await page.reload();
  await page.locator(".dock-book").click();
  await page
    .getByRole("button", { name: "Resume download", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Saved on device", exact: true }),
  ).toBeDisabled();
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: "artifacts/player-device-download-mobile.png",
  });
  await page
    .getByRole("button", { name: "Book details and editions", exact: true })
    .click();
  // The Audiobook row opens the Audiobook page (#530), where Get another recording is.
  await expect(
    page.getByRole("dialog", { name: "Book details" }).getByRole("button", { name: /^Audiobook / }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Find ebook", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await page.locator(".dock-book").click();
  await expect(
    page.getByRole("dialog").getByLabel("Playback source"),
  ).toHaveText("Source: Device cache");
});
