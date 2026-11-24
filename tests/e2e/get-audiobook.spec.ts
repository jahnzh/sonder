// @projects firefox
// The Get audiobook sheet (#601, spec #600; boards GetAudiobook.dc.html, BookGetting.dc.html):
// `#book/<workId>/get/audiobook`, opened from the Book page and the Audiobook page, on a reload and from a link
// (Close to the Book page); the search with the title and author; rows from AudioBookBay and Prowlarr; a tap that
// sends nothing; Get this recording sending the slug or the Prowlarr id with the workId and closing to the Book page
// with the download's line; a refusal kept above the button; Get on a book outside the library sending the PUT first;
// a failing source with its Retry, nothing found and fewer than two characters; the administrator-only address; and
// the sheet measured against the board at phone size and on a desktop.
import { test, expect, type Locator, type Page, type Request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { AudiobookRelease } from "../../src/types";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

// A seeded LibriVox book no other spec keeps in the library: shown here without audio, so its Audiobook row has Get.
const WAR = { workId: "work-war", title: "The Art of War" };
const ALICE = { workId: "work-alice", title: "Alice’s Adventures in Wonderland" };
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect((await page.request.delete(`/api/works/${WAR.workId}/library`)).ok()).toBe(true);
});

const PROWLARR_ID = `prowlarr-${"a".repeat(32)}`;
const abb = (id: string, over: Partial<AudiobookRelease> = {}): AudiobookRelease => ({
  id,
  title: "The Art of War",
  author: "Sun Tzu",
  url: `https://audiobookbay.lu/abss/${id}/`,
  language: "English",
  narrator: "Aidan Gillen",
  format: "M4B",
  bitrate: "64 Kbps",
  size: "120 MB",
  posted: null,
  uploader: null,
  description: "",
  source: "abb",
  ...over,
});
const RELEASES = {
  abb: [abb("war-gillen"), abb("war-french", { language: "French", narrator: "Lecteur", size: "300 MB" }), abb("war-giles", { narrator: "Lionel Giles", format: "MP3", bitrate: "128 Kbps", size: "1.1 GB", title: "The Art of War: Complete Edition" })],
  prowlarr: [abb(PROWLARR_ID, { source: "prowlarr", indexer: "Fixture Tracker", narrator: null, language: null, title: "Sun Tzu - The Art of War [MP3]", size: "480 MB", bitrate: null, format: null, seeders: 1 })],
};

/** The chosen row is inside the sheet's body, not left under the footer that has grown over it (#889). */
async function expectInBody(row: Locator, body: Locator) {
  await expect(async () => {
    const [r, b] = [await row.boundingBox(), await body.boundingBox()];
    expect(r!.y).toBeGreaterThanOrEqual(b!.y - 1);
    expect(r!.y + r!.height).toBeLessThanOrEqual(b!.y + b!.height + 1);
  }).toPass();
}

const sheet = (page: Page) => page.getByRole("dialog", { name: "Get audiobook", exact: true });
const rows = (page: Page) => sheet(page).getByRole("radiogroup", { name: "Recordings", exact: true }).getByRole("radio");
const bookRegion = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const getButton = (page: Page) => sheet(page).getByRole("button", { name: "Get this recording", exact: true });
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));

/** An answer with a numeric `status` is the server's refusal with that status and its `error`. */
async function answerWith(route: import("@playwright/test").Route, json: unknown) {
  const refused = json as { status?: unknown; error?: string };
  if (typeof refused.status === "number") await route.fulfill({ status: refused.status, json: { error: refused.error } }).catch(() => {});
  else await route.fulfill({ json }).catch(() => {});
}

type Asked = { abb: string[]; prowlarr: string[]; posts: { url: string; body: unknown }[]; order: string[] };

/** The sources answered by the test (Prowlarr shown as connected), and every request the sheet sends counted. */
async function sources(page: Page, options: { abb?: (q: string) => unknown; prowlarr?: (q: string) => unknown; add?: () => unknown } = {}) {
  const asked: Asked = { abb: [], prowlarr: [], posts: [], order: [] };
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), prowlarrConfigured: true } }).catch(() => {});
  });
  await page.route("**/api/discover/abb/releases?*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") || "";
    asked.abb.push(q);
    await answerWith(route, await (options.abb ? options.abb(q) : { results: RELEASES.abb, nextPage: null }));
  });
  await page.route("**/api/discover/prowlarr/releases?*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") || "";
    asked.prowlarr.push(q);
    await answerWith(route, await (options.prowlarr ? options.prowlarr(q) : { results: RELEASES.prowlarr, nextPage: null }));
  });
  for (const path of ["abb", "prowlarr"])
    await page.route(`**/api/discover/${path}/add`, async (route) => {
      asked.posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
      asked.order.push(`POST ${path}`);
      await answerWith(route, options.add ? options.add() : { id: "acq-test", backend: "local", status: "downloading", progress: 0.1, error: null });
    });
  page.on("request", (request: Request) => {
    if (request.method() === "PUT" && request.url().includes("/library")) asked.order.push("PUT library");
  });
  return asked;
}

/** The work shown without audio (and, once `after()` holds, with its download queued): a state the suite's server cannot make. */
async function withoutAudio(page: Page, workId: string, after: () => boolean = () => false) {
  const change = (work: any) =>
    work.workId !== workId
      ? work
      : {
          ...work,
          recordings: [],
          chosenRecordingId: null,
          ebooks: [],
          chosenEbookId: null,
          readingSync: [],
          mediaState: after() ? { state: "queued", holdReason: null, acquisition: { id: "acq-test", status: "downloading", progress: 0.1, error: null } } : null,
        };
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    await route.fulfill({ status: 200, contentType: "application/json", json: (await response.json()).map(change) }).catch(() => {});
  });
  await page.route(`**/api/works/${encodeURIComponent(workId)}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) }).catch(() => {});
  });
}

test("from the Book page: the search with title and author, rows from both sources, a tap sends nothing, Get closes to the Book page with the download's line", async ({ page }) => {
  expect((await page.request.put(`/api/works/${WAR.workId}/library`)).ok()).toBe(true);
  const asked = await sources(page);
  await withoutAudio(page, WAR.workId, () => asked.posts.length > 0);
  await page.goto(`/#book/${WAR.workId}`);
  const get = bookRegion(page).getByRole("button", { name: "Get an audiobook", exact: true });
  await get.click();
  await expect(page).toHaveURL(new RegExp(`#book/${WAR.workId}/get/audiobook$`));
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText(WAR.title);
  await expect(sheet(page).getByRole("searchbox", { name: "Search for a recording" })).toHaveValue("The Art of War Sun Tzu");
  await expect.poll(() => asked.abb).toEqual(["The Art of War Sun Tzu"]);
  await expect.poll(() => asked.prowlarr).toEqual(["The Art of War Sun Tzu"]);
  // English only (Prowlarr's row names no language and stays); the book's own title first.
  await expect(rows(page)).toHaveCount(3);
  await expect(sheet(page).getByRole("heading", { name: "Recordings · 3" })).toBeVisible();
  await expect(rows(page).nth(0)).toHaveAccessibleName("Aidan Gillen M4B · 64 kbps · 120 MB");
  // The release's title first on its second line when it is not the book's; an indexer's row without a narrator
  // names its release's title first; the seeders on the right.
  await expect(rows(page).nth(1)).toHaveAccessibleName("Lionel Giles The Art of War: Complete Edition · MP3 · 128 kbps · 1.1 GB");
  const indexed = rows(page).nth(2);
  await expect(indexed).toContainText("Sun Tzu - The Art of War [MP3]");
  await expect(indexed).toContainText("480 MB");
  await expect(indexed).toContainText("1 seeder");
  await expect(sheet(page)).not.toContainText("Lecteur");
  await expect(sheet(page).getByText("From AudioBookBay and Prowlarr.", { exact: true })).toBeVisible();
  // Nothing chosen at first: Get is off and has no line.
  for (const row of await rows(page).all()) await expect(row).toHaveAttribute("aria-checked", "false");
  await expect(getButton(page)).toBeDisabled();
  // The other ways are drawn, named and on: the magnet link (#606) and the import (#605).
  await expect(sheet(page).getByRole("button", { name: "Paste a magnet link", exact: true })).not.toHaveAttribute("aria-disabled", "true");
  await expect(sheet(page).getByRole("button", { name: "Import files from this device", exact: true })).not.toHaveAttribute("aria-disabled", "true");
  // A tap only chooses.
  await indexed.click();
  await expect(indexed).toHaveAttribute("aria-checked", "true");
  await expect(sheet(page).getByText("Downloads to your server first.", { exact: true })).toBeVisible();
  await rows(page).nth(0).click();
  await expect(rows(page).nth(0)).toHaveAttribute("aria-checked", "true");
  expect(asked.posts).toEqual([]);
  // Get this recording: the Prowlarr id with the workId, then the Book page with the download's line.
  await indexed.click();
  await getButton(page).click();
  await expect.poll(() => asked.posts.length).toBe(1);
  expect(asked.posts[0]).toEqual({ url: expect.stringContaining("/api/discover/prowlarr/add"), body: { id: PROWLARR_ID, workId: WAR.workId } });
  expect(asked.order).toEqual(["POST prowlarr"]);
  await expect(page).toHaveURL(new RegExp(`#book/${WAR.workId}$`));
  await expect(sheet(page)).toHaveCount(0);
  await expect(bookRegion(page).getByRole("list", { name: "Files", exact: true })).toContainText("Downloading to server · 10%");
});

// Releases of every kind of page address (#889): AudioBookBay's, an older server's (no source), two Prowlarr results
// (one naming its indexer, one not) and a Prowlarr result with no address, or one that is not a web page.
const PAGES = {
  abb: [
    abb("page-abb", { narrator: "Abby Voice", size: "110 MB" }),
    (({ source: _source, ...older }) => older)(abb("page-older", { narrator: "Older Voice", size: "210 MB" })) as AudiobookRelease,
  ],
  prowlarr: [
    abb(`prowlarr-${"b".repeat(32)}`, { source: "prowlarr", indexer: "Fixture Tracker", url: "https://tracker.example/details/1", narrator: "Tracker Voice", language: null, size: "310 MB", seeders: 4 }),
    abb(`prowlarr-${"c".repeat(32)}`, { source: "prowlarr", indexer: null, url: "https://tracker.example/details/2", narrator: "Nameless Voice", language: null, size: "410 MB", seeders: 3 }),
    abb(`prowlarr-${"d".repeat(32)}`, { source: "prowlarr", indexer: "Fixture Tracker", url: "", narrator: "Addressless Voice", language: null, size: "510 MB", seeders: 2 }),
    abb(`prowlarr-${"e".repeat(32)}`, { source: "prowlarr", indexer: "Fixture Tracker", url: "magnet:?xt=urn:btih:" + "e".repeat(40), narrator: "Magnet Voice", language: null, size: "610 MB", seeders: 1 }),
  ],
};

test("the footer links to the chosen recording's own page, follows the choice, and no row holds a link (#889)", async ({ page }) => {
  // Get is refused once the test says so: the refusal stands above the footer's other lines, the button stays.
  let refuse = false;
  const asked = await sources(page, {
    abb: () => ({ results: PAGES.abb, nextPage: null }),
    prowlarr: () => ({ results: PAGES.prowlarr }),
    add: () => (refuse ? { status: 502, error: "The release could not be added. Choose another." } : { id: "acq-test", backend: "local", status: "downloading", progress: 0.1, error: null }),
  });
  let opened = 0;
  page.context().on("page", () => opened++);
  await page.goto(`/#book/${WAR.workId}/get/audiobook`);
  await expect(rows(page)).toHaveCount(6);
  const row = (voice: string) => rows(page).filter({ hasText: voice });
  const foot = sheet(page).locator(".part-sheet-foot");
  const link = foot.getByRole("link");
  // Nothing chosen: the footer is the button alone, at the foot, as high as on main.
  await expect(link).toHaveCount(0);
  await expect(foot.locator(":scope > *")).toHaveCount(1);
  expect((await foot.boundingBox())!.height).toBe(44);
  await page.screenshot({ path: `${OUT}/get-audiobook-nothing-chosen-phone.png` });
  const home = await getButton(page).boundingBox();
  const stays = async () => expect(await getButton(page).boundingBox()).toEqual(home);

  const expectLink = async (voice: string, name: string, href: string) => {
    await row(voice).click();
    await expect(row(voice)).toHaveAttribute("aria-checked", "true");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAccessibleName(name);
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link.locator(".get-sheet-leaving")).toBeVisible();
    await stays();
  };
  await expectLink("Abby Voice", "On AudioBookBay", "https://audiobookbay.lu/abss/page-abb/");
  await page.screenshot({ path: `${OUT}/get-audiobook-source-link-phone.png` });
  // Above the button: the link's 44 high row, then the sentence 8 above the button (the footer grew upward).
  const sentence = foot.getByTestId("get-line");
  const above = async () => {
    const [l, t, b] = [await link.boundingBox(), await sentence.boundingBox(), await getButton(page).boundingBox()];
    expect(l!.height).toBe(44);
    expect(Math.round(l!.y + l!.height + 8)).toBe(Math.round(t!.y));
    expect(Math.round(t!.y + t!.height + 8)).toBe(Math.round(b!.y));
  };
  await above();
  await stays();
  // It follows the choice: its words and its address.
  await expectLink("Tracker Voice", "On Fixture Tracker", "https://tracker.example/details/1");
  await expectLink("Nameless Voice", "On the indexer's page", "https://tracker.example/details/2");
  // An older server's release (no source) is AudioBookBay's.
  await expectLink("Older Voice", "On AudioBookBay", "https://audiobookbay.lu/abss/page-older/");
  // No address, or one that is not a web page: no link and no gap; the sentence is 8 above the button.
  for (const voice of ["Addressless Voice", "Magnet Voice"]) {
    await row(voice).click();
    await expect(row(voice)).toHaveAttribute("aria-checked", "true");
    await expect(link).toHaveCount(0);
    await expect(foot.locator("a")).toHaveCount(0);
    await expect(foot.locator(":scope > *")).toHaveCount(2);
    const [t, b] = [await sentence.boundingBox(), await getButton(page).boundingBox()];
    expect(Math.round(t!.y + t!.height + 8)).toBe(Math.round(b!.y));
    await stays();
  }
  // Choosing a row opened nothing, and no row holds a link or anything with an address.
  expect(opened).toBe(0);
  await expect(rows(page).locator("a, [href]")).toHaveCount(0);
  await expect(sheet(page).getByRole("radiogroup", { name: "Recordings", exact: true }).getByRole("link")).toHaveCount(0);

  // A new search clears the choice, and the link with it.
  await row("Abby Voice").click();
  await expect(link).toHaveCount(1);
  const search = sheet(page).getByRole("searchbox", { name: "Search for a recording" });
  const before = asked.abb.length;
  await search.fill("art of war");
  await search.press("Enter");
  await expect.poll(() => asked.abb.length).toBe(before + 1);
  await expect(link).toHaveCount(0);
  await stays();
  expect(asked.posts).toEqual([]);
  expect(opened).toBe(0);

  // The link opens the release's own page in a new tab.
  await page.context().route("https://audiobookbay.lu/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>AudioBookBay</title>" }));
  await row("Abby Voice").click();
  const [tab] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
  await expect.poll(() => tab.url()).toBe("https://audiobookbay.lu/abss/page-abb/");
  await tab.close();
  await expect(page).toHaveURL(new RegExp(`#book/${WAR.workId}/get/audiobook$`));
  await expect(row("Abby Voice")).toHaveAttribute("aria-checked", "true");

  // A refused Get: the refusal stands above the link, the sentence and the button, and the button stays.
  refuse = true;
  await getButton(page).click();
  const alert = foot.getByRole("alert");
  await expect(alert).toHaveText("The release could not be added. Choose another.");
  await expect.poll(() => asked.posts.length).toBe(1);
  const [a, l, t] = [await alert.boundingBox(), await link.boundingBox(), await sentence.boundingBox()];
  expect(Math.round(a!.y + a!.height + 8)).toBe(Math.round(l!.y));
  expect(Math.round(l!.y + l!.height + 8)).toBe(Math.round(t!.y));
  await stays();

  // On a short screen the footer grows over the list: with nothing chosen and the row at the bottom edge of the list,
  // choosing it adds the link and the sentence, and the row is scrolled back into view, not left under them.
  await page.setViewportSize({ width: 390, height: 560 });
  const again = sheet(page).getByRole("searchbox", { name: "Search for a recording" });
  await again.fill("art of war again");
  await again.press("Enter");
  await expect(link).toHaveCount(0);
  await expect(rows(page)).toHaveCount(6);
  await row("Older Voice").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await row("Older Voice").click();
  await expect(link).toHaveCount(1);
  await expectInBody(row("Older Voice"), sheet(page).locator(".part-sheet-body"));
});

test("from the Audiobook page, on a reload and from a link; Close goes back, or to the Book page", async ({ page, context }) => {
  const asked = await sources(page);
  await page.goto(`/#book/${ALICE.workId}/audiobook`);
  await page.getByRole("button", { name: "Get another recording", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${ALICE.workId}/get/audiobook$`));
  await expect(sheet(page).getByRole("searchbox", { name: "Search for a recording" })).toHaveValue(`${ALICE.title} Lewis Carroll`);
  await expect(rows(page)).toHaveCount(3);
  // The words, the rows and the choice stay with the entry: a reload searches again and keeps the choice.
  const search = sheet(page).getByRole("searchbox", { name: "Search for a recording" });
  await search.fill("art of war");
  await search.press("Enter");
  await expect.poll(() => asked.abb.at(-1)).toBe("art of war");
  await rows(page).nth(2).click();
  await expect(rows(page).nth(2)).toHaveAttribute("aria-checked", "true");
  const before = asked.abb.length;
  await page.reload();
  await expect(sheet(page).getByRole("searchbox", { name: "Search for a recording" })).toHaveValue("art of war");
  await expect.poll(() => asked.abb.length).toBe(before + 1);
  expect(asked.abb.at(-1)).toBe("art of war");
  await expect(rows(page).nth(2)).toHaveAttribute("aria-checked", "true");
  // Close: back to the Audiobook page under it.
  await sheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${ALICE.workId}/audiobook$`));
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Audiobook", exact: true })).toBeVisible();
  expect(asked.posts).toEqual([]);

  // A link: the sheet over the Book page; Close lands on it.
  const linked = await context.newPage();
  await sources(linked);
  await linked.goto(`/#book/${ALICE.workId}/get/audiobook`);
  await expect(sheet(linked)).toBeVisible();
  await expect(rows(linked)).toHaveCount(3);
  await sheet(linked).getByRole("button", { name: "Close", exact: true }).click();
  await expect(linked).toHaveURL(new RegExp(`#book/${ALICE.workId}$`));
  await expect(bookRegion(linked).getByRole("heading", { level: 1 })).toHaveText(ALICE.title);
  await linked.close();
});

test("a book outside the library: Get sends the PUT first, then the slug with the workId", async ({ page }) => {
  expect((await page.request.delete(`/api/works/${WAR.workId}/library`)).ok()).toBe(true);
  const asked = await sources(page);
  await withoutAudio(page, WAR.workId, () => asked.posts.length > 0);
  await page.goto(`/#book/${WAR.workId}`);
  await expect(bookRegion(page).getByTestId("book-place")).toHaveText("Not in your library");
  await bookRegion(page).getByRole("button", { name: "Get an audiobook", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await rows(page).nth(0).click();
  await getButton(page).click();
  await expect.poll(() => asked.posts.length).toBe(1);
  expect(asked.order).toEqual(["PUT library", "POST abb"]);
  expect(asked.posts[0].body).toEqual({ slug: "war-gillen", workId: WAR.workId });
  await expect(page).toHaveURL(new RegExp(`#book/${WAR.workId}$`));
  await expect(bookRegion(page).getByRole("list", { name: "Files", exact: true })).toContainText("Downloading to server · 10%");
  const library = await (await page.request.get("/api/library")).json();
  expect(library.find((work: { workId: string }) => work.workId === WAR.workId)?.inLibrary).toBe(true);
});

test("a refusal, or an acquisition in error, stands above the button and keeps the choice", async ({ page }) => {
  let answer: unknown = { status: 400, error: "TorBox refused this torrent." };
  const asked = await sources(page, { add: () => answer });
  await page.goto(`/#book/${ALICE.workId}/get/audiobook`);
  await rows(page).nth(0).click();
  await getButton(page).click();
  const alert = sheet(page).getByRole("alert");
  await expect(alert).toHaveText("TorBox refused this torrent.");
  await expect(page).toHaveURL(/\/get\/audiobook$/);
  await expect(rows(page).nth(0)).toHaveAttribute("aria-checked", "true");
  // Above the button.
  expect((await alert.boundingBox())!.y).toBeLessThan((await getButton(page).boundingBox())!.y);
  answer = { id: "acq", backend: "local", status: "error", error: "No peers have this torrent." };
  await getButton(page).click();
  await expect(alert).toHaveText("No peers have this torrent.");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-checked", "true");
  expect(asked.posts.length).toBe(2);
});

test("a failing source with its Retry, nothing found, fewer than two characters, an older answer dropped", async ({ page }) => {
  let prowlarrFails = true;
  let slow: (() => void) | null = null;
  const asked = await sources(page, {
    abb: (q) =>
      q === "slow words"
        ? new Promise((resolve) => (slow = () => resolve({ results: [abb("late", { narrator: "Late Reader" })], nextPage: null })))
        : q === "nothing"
          ? { results: [], nextPage: null }
          : { results: RELEASES.abb, nextPage: null },
    prowlarr: (q) => (prowlarrFails && q !== "nothing" ? { status: 502, error: "Prowlarr returned 500." } : { results: q === "nothing" ? [] : RELEASES.prowlarr }),
  });
  await page.goto(`/#book/${WAR.workId}/get/audiobook`);
  await expect(sheet(page).getByText("Prowlarr could not be searched.", { exact: false })).toContainText("Prowlarr returned 500.");
  await expect(rows(page)).toHaveCount(2);
  prowlarrFails = false;
  await sheet(page).getByRole("button", { name: "Retry Prowlarr", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(sheet(page).getByText("Prowlarr could not be searched.", { exact: false })).toHaveCount(0);
  expect(asked.abb.length).toBe(1);

  const search = sheet(page).getByRole("searchbox", { name: "Search for a recording" });
  await search.fill("nothing");
  await search.press("Enter");
  await expect(sheet(page).getByRole("status").filter({ hasText: "No recordings found." })).toContainText("Try the title alone");
  await expect(rows(page)).toHaveCount(0);

  await search.fill("x");
  await search.press("Enter");
  await expect(sheet(page).getByText("Enter at least two characters to search.", { exact: true })).toBeVisible();
  expect(asked.abb.at(-1)).toBe("nothing");

  // An older search's answer is dropped.
  await search.fill("slow words");
  await search.press("Enter");
  await expect.poll(() => asked.abb.at(-1)).toBe("slow words");
  await search.fill("The Art of War");
  await search.press("Enter");
  await expect(rows(page)).toHaveCount(3);
  (slow as unknown as () => void)();
  await page.waitForTimeout(300);
  await expect(sheet(page)).not.toContainText("Late Reader");
});

test("the address is the administrator's: someone else gets the Book page", async ({ page }) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
  const asked = await sources(page);
  await page.goto(`/#book/${ALICE.workId}/get/audiobook`);
  await expect(page).toHaveURL(new RegExp(`#book/${ALICE.workId}$`));
  await expect(bookRegion(page).getByRole("heading", { level: 1 })).toHaveText(ALICE.title);
  await expect(sheet(page)).toHaveCount(0);
  expect(asked.abb).toEqual([]);
});

for (const size of [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
])
  test(`measured against the board at ${size.name} size`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await sources(page, { prowlarr: () => ({ results: [abb(PROWLARR_ID, { source: "prowlarr", narrator: null, language: null, title: "Sun Tzu - The Art of War [MP3]", size: "480 MB", cached: true, seeders: 24 })] }) });
    await page.goto(`/#book/${WAR.workId}/get/audiobook`);
    await expect(rows(page)).toHaveCount(3);
    const now = rows(page).filter({ hasText: "Plays now" });
    await expect(now).toHaveCount(1);
    await now.click();
    await expect(sheet(page).getByText("Plays from TorBox right away.", { exact: true })).toBeVisible();
    // One heading, the book's title; the dialog's name is the caption.
    await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveCount(1);
    // The page under the sheet is inert.
    expect(await page.evaluate(() => document.getElementById("root")!.hasAttribute("inert"))).toBe(true);
    await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText(WAR.title);
    const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
    const close = await box(sheet(page).getByRole("button", { name: "Close", exact: true }));
    const field = await box(sheet(page).locator(".get-sheet-field"));
    const cover = await box(sheet(page).locator(".get-sheet-cover"));
    // The first row: the ones after it carry the 1 px line above their 64.
    const row = await box(rows(page).nth(0));
    const other = await box(sheet(page).getByRole("button", { name: "Paste a magnet link", exact: true }));
    const button = await box(getButton(page));
    // The chosen candidate's own page (#889): the foot's last line, a 44 high target under the button's line.
    const source = await box(sheet(page).locator(".part-sheet-foot").getByRole("link"));
    expect(source.height).toBe(44);
    const line = await box(sheet(page).getByText("Plays from TorBox right away.", { exact: true }));
    const recordings = await box(sheet(page).getByRole("heading", { name: "Recordings · 3" }));
    expect([close.width, close.height]).toEqual([44, 44]);
    expect(field.height).toBe(44);
    expect([cover.width, cover.height]).toEqual([56, 56]);
    expect(row.height).toBe(64);
    expect(other.height).toBe(52);
    expect(button.height).toBe(44);
    // The order of the parts: head, book, search, Recordings, the other ways, then the button and its line at the foot.
    // Bottom to top the foot is the button, the sentence 8 above it, the link's 44 high row 8 above that.
    const order = [close.y, cover.y, field.y, recordings.y, row.y, other.y, source.y, line.y, button.y];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The foot at the bottom of the screen, 16 from its edge: the button's bottom, as before #889.
    const edge = size.name === "phone" ? 16 : 32;
    expect(Math.round(button.y + button.height)).toBe(size.height - edge);
    expect(Math.round(line.y + line.height + 8)).toBe(Math.round(button.y));
    expect(Math.round(source.y + source.height + 8)).toBe(Math.round(line.y));
    // One centred column on a desktop.
    const column = await box(sheet(page).locator(".part-sheet-column"));
    if (size.name === "desktop") expect(Math.abs(column.x + column.width / 2 - size.width / 2)).toBeLessThanOrEqual(1);
    else expect(column.width).toBe(size.width - 32);
    await noOverflow(page);
    await page.screenshot({ path: `${OUT}/get-audiobook-${size.name}.png` });
  });
