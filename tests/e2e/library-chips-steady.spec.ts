// @projects firefox
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
// The Library's chips do not move after they first appear (#841). The Continue block stands above them, and whether
// there is one is known only from the library's works: on a device that has none stored, the chips used to be drawn
// at once and pushed down 118 px when the server's answer brought a book in progress. A tap or a test's click in
// that moment pressed a chip and was released on the Continue block, so it chose nothing.
test.use({ serviceWorkers: "block" });
const works: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of works.splice(0)) expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

/** An ebook read to its middle: the book In progress that the Continue block shows. */
async function bookInProgress(request: APIRequestContext) {
  const title = `Steady chips ${randomUUID().slice(0, 8)}`;
  const epub = await readerFixture({ title, bodies: ["<p>Chapter 1 is a short line of the book.</p>", "<p>Chapter 2 is a short line of the book.</p>"] });
  const imported = await request.post("/api/ebooks/import", { multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: epub } } });
  expect(imported.ok()).toBe(true);
  const id = (await imported.json()).id as string;
  const ebook = ((await (await request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((entry) => entry.id === id)!;
  works.push(ebook.workId);
  const manifest = await (await request.get(`/api/reader/${encodeURIComponent(id)}`)).json();
  const saved = await request.put(`/api/reader/${encodeURIComponent(id)}/progress`, {
    data: {
      locator: { section: manifest.sections[0].index, paragraphId: manifest.sections[0].paragraphs[0].id, progression: 0.5 },
      baseRevision: 0,
      eventId: randomUUID(),
      deviceId: "browser-test",
      updatedAt: Date.now(),
      origin: "reading",
    },
  });
  expect(saved.ok()).toBe(true);
  return title;
}

type Seen = { top: number; continue: boolean; tiles: boolean };
/** Records where the chips stand at every change of the page, from the first moment they are in it. */
const watchChips = (page: Page) =>
  page.addInitScript(() => {
    const seen: { top: number; continue: boolean; tiles: boolean }[] = [];
    (window as unknown as { __chipsSeen: typeof seen }).__chipsSeen = seen;
    const look = () => {
      const chips = document.querySelector(".library-chips");
      if (!chips) return;
      seen.push({
        top: Math.round(chips.getBoundingClientRect().top),
        continue: !!document.querySelector(".library-continue"),
        tiles: !!document.querySelector(".library-grid, .library-list"),
      });
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  });
const seenChips = (page: Page) => page.evaluate(() => (window as unknown as { __chipsSeen: Seen[] }).__chipsSeen);
const chips = (page: Page) => page.getByRole("group", { name: "Filter your library", exact: true });
const continueBlock = (page: Page) => page.getByRole("region", { name: "Continue", exact: true });

test("on a device with no stored library the chips appear together with the Continue block and never move", async ({ page }) => {
  const title = await bookInProgress(page.request);
  // The library's answer takes a moment, as on a phone: long enough that chips drawn before it would be seen.
  await page.route("**/api/library", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await watchChips(page);
  await page.goto("/#library");
  await expect(continueBlock(page).getByRole("button", { name: `Continue ${title}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `About ${title}`, exact: true })).toBeVisible();
  const seen = await seenChips(page);
  expect(seen.length).toBeGreaterThan(0);
  // From their first moment the chips stand under the Continue block, where they stay.
  expect(seen[0]).toMatchObject({ continue: true });
  expect([...new Set(seen.map((entry) => entry.top))], "the places the chips stood at").toHaveLength(1);
  expect(seen.at(-1)!.tiles).toBe(true);
});

test("a device with a stored library shows the chips at once, before the server answers, and they do not move when it does", async ({ page }) => {
  const title = await bookInProgress(page.request);
  // The first open stores the library on the device.
  await page.goto("/#library");
  await expect(continueBlock(page).getByRole("button", { name: `Continue ${title}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `About ${title}`, exact: true })).toBeVisible();
  // Opened again with the server's answer held back: the stored library decides the Continue block.
  let answer = () => {};
  const held = new Promise<void>((resolve) => (answer = resolve));
  let asked = 0;
  await page.route("**/api/library", async (route) => {
    asked++;
    await held;
    await route.continue();
  });
  await watchChips(page);
  await page.reload();
  await expect(chips(page).getByRole("button", { name: "Series", exact: true })).toBeVisible();
  await expect(continueBlock(page)).toBeVisible();
  await expect(page.getByRole("button", { name: `About ${title}`, exact: true })).toBeVisible();
  expect(asked, "the library was asked for and has not been answered").toBeGreaterThan(0);
  const before = await seenChips(page);
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library");
  answer();
  await answered;
  // The answer has been taken in when the page has seen two more frames.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const seen = await seenChips(page);
  expect(before.length).toBeGreaterThan(0);
  expect([...new Set(seen.map((entry) => entry.top))], "the places the chips stood at").toHaveLength(1);
});
