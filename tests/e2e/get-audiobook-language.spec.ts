// The Get audiobook sheet's language and Load more (#602, spec #600 "The sheet", "The rows", "Searching, a failing
// source, nothing found"; board GetAudiobook.dc.html): the stored language on open, a change kept after a reload of
// the sheet and in a new sheet, All languages showing every row with its language, Load more adding AudioBookBay's
// second page and going after it (Prowlarr asked once, the choice kept), a failing second page beside the first
// page's rows with Retry for that page, nothing in the language, and the Picker measured at phone size and on a
// desktop. Guard 1 of the spec's list in full: recordings of an existing book filtered by language, English first,
// paged with Load more, and shown in every language with All languages.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { AudiobookRelease } from "../../src/types";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const ALICE = { workId: "work-alice", title: "Alice’s Adventures in Wonderland" };
const SHEET = `/#book/${ALICE.workId}/get/audiobook`;
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const PROWLARR_ID = `prowlarr-${"b".repeat(32)}`;
const abb = (id: string, over: Partial<AudiobookRelease> = {}): AudiobookRelease => ({
  id,
  title: ALICE.title,
  author: "Lewis Carroll",
  url: `https://audiobookbay.lu/abss/${id}/`,
  language: "English",
  narrator: `Reader ${id}`,
  format: "M4B",
  bitrate: "64 Kbps",
  size: `${100 + id.length * 37} MB`,
  posted: null,
  uploader: null,
  description: "",
  source: "abb",
  ...over,
});
const PAGE1 = [abb("en-one", { narrator: "Eleanor One" }), abb("fr-one", { language: "French", narrator: "Lecteur Un" }), abb("de-one", { language: "German", narrator: "Leser Eins" })];
// The second page lists the first page's English row again, and two new ones.
const PAGE2 = [abb("en-one", { narrator: "Eleanor One" }), abb("en-two", { narrator: "Edward Two", size: "777 MB" }), abb("fr-two", { language: "French", narrator: "Lecteur Deux", size: "888 MB" })];
const PROWLARR = [abb(PROWLARR_ID, { source: "prowlarr", indexer: "Fixture Tracker", narrator: null, language: null, title: "Carroll - Alice [MP3]", format: null, bitrate: null, size: "480 MB", seeders: 12 })];

const sheet = (page: Page) => page.getByRole("dialog", { name: "Get audiobook", exact: true });
const rows = (page: Page) => sheet(page).getByRole("radiogroup", { name: "Recordings", exact: true }).getByRole("radio");
const picker = (page: Page) => page.getByRole("dialog", { name: "Language", exact: true });
const languageButton = (page: Page) => sheet(page).getByRole("button", { name: /^Language: / });
const loadMore = (page: Page) => sheet(page).getByRole("button", { name: "Load more recordings", exact: true });
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));

type Asked = { abb: { q: string; page: string }[]; prowlarr: string[] };

/** AudioBookBay's pages and Prowlarr answered by the test (Prowlarr shown as connected); every ask counted. */
async function sources(page: Page, options: { page?: (n: number, q: string) => unknown } = {}) {
  const asked: Asked = { abb: [], prowlarr: [] };
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), prowlarrConfigured: true } }).catch(() => {});
  });
  await page.route("**/api/discover/abb/releases?*", async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q") || "";
    const n = url.searchParams.get("page") || "";
    asked.abb.push({ q, page: n });
    const answer = (options.page ?? ((p: number) => (p === 1 ? { results: PAGE1, nextPage: 2 } : { results: PAGE2, nextPage: null })))(Number(n), q) as {
      status?: number;
      error?: string;
    };
    if (typeof answer.status === "number") await route.fulfill({ status: answer.status, json: { error: answer.error } }).catch(() => {});
    else await route.fulfill({ json: answer }).catch(() => {});
  });
  await page.route("**/api/discover/prowlarr/releases?*", async (route) => {
    asked.prowlarr.push(new URL(route.request().url()).searchParams.get("q") || "");
    await route.fulfill({ json: { results: PROWLARR } }).catch(() => {});
  });
  await page.route("**/api/discover/*/add", (route) => route.fulfill({ status: 500, json: { error: "Not in this spec." } }));
  return asked;
}

async function choose(page: Page, name: string) {
  await languageButton(page).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByRole("radio", { name, exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
}

test("the language: English the first time, the Picker's choices, a change applied at once, kept after a reload and in a new sheet", async ({ page, context }) => {
  const asked = await sources(page);
  await page.goto(SHEET);
  // English the first time: the English row, and Prowlarr's row that names no language.
  await expect(languageButton(page)).toHaveAccessibleName("Language: English");
  await expect(languageButton(page)).toHaveText("English");
  await expect(rows(page)).toHaveCount(2);
  await expect(sheet(page).getByRole("heading", { name: "Recordings · 2" })).toBeVisible();
  await expect(sheet(page)).not.toContainText("Lecteur Un");
  // Beside the search field, on its line.
  const field = (await sheet(page).locator(".get-sheet-field").boundingBox())!;
  const button = (await languageButton(page).boundingBox())!;
  expect(button.x).toBeGreaterThan(field.x + field.width);
  expect(Math.abs(button.y - field.y)).toBeLessThanOrEqual(1);
  expect(button.height).toBe(44);

  // The Picker: All languages, English, then every language of the loaded rows in alphabetical order.
  await languageButton(page).click();
  await expect(picker(page).getByRole("radio")).toHaveText(["All languages", "English", "French", "German"]);
  await expect(picker(page).getByRole("radio", { name: "English", exact: true })).toHaveAttribute("aria-checked", "true");
  await picker(page).getByRole("radio", { name: "French", exact: true }).click();
  // Applied at once: the picker closes, French rows (and the one without a language), nothing asked again.
  await expect(picker(page)).toHaveCount(0);
  await expect(languageButton(page)).toHaveAccessibleName("Language: French");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: "Lecteur Un" })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: "Carroll - Alice [MP3]" })).toHaveCount(1);
  await expect(sheet(page).getByRole("heading", { name: "Recordings · 2" })).toBeVisible();
  expect(asked.abb.length).toBe(1);
  expect(asked.prowlarr.length).toBe(1);
  // Stored on this device under today's key.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const open = indexedDB.open("sonder");
            open.onsuccess = () => {
              try {
                const read = open.result.transaction("preferences").objectStore("preferences").get("release-language");
                read.onsuccess = () => resolve(read.result?.value ?? null);
                read.onerror = () => resolve(null);
              } catch {
                resolve(null);
              }
            };
            open.onerror = () => resolve(null);
          }),
      ),
    )
    .toBe("French");

  // A reload of the sheet keeps French.
  await page.reload();
  await expect(languageButton(page)).toHaveAccessibleName("Language: French");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: "Lecteur Un" })).toHaveCount(1);

  // A new sheet (another tab, from a link) starts with the stored French.
  const other = await context.newPage();
  await sources(other);
  await other.goto(SHEET);
  await expect(languageButton(other)).toHaveAccessibleName("Language: French");
  await expect(rows(other)).toHaveCount(2);
  await expect(rows(other).filter({ hasText: "Lecteur Un" })).toHaveCount(1);
  // Back to English in the new sheet: the device now stores English, for the specs after this one too.
  await choose(other, "English");
  await expect(rows(other)).toHaveCount(2);
  await other.close();
  // The first sheet's own history entry keeps its French across a reload, whatever the device stores since.
  await page.reload();
  await expect(languageButton(page)).toHaveAccessibleName("Language: French");
  await expect(rows(page).filter({ hasText: "Lecteur Un" })).toHaveCount(1);
});

test("All languages shows every row with its language first; Prowlarr's row reads Language unknown and stays under English", async ({ page }) => {
  await sources(page);
  await page.goto(SHEET);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: "Carroll - Alice [MP3]" })).toContainText("12 seeders");
  await choose(page, "All languages");
  await expect(languageButton(page)).toHaveAccessibleName("Language: All languages");
  await expect(rows(page)).toHaveCount(4);
  await expect(sheet(page).getByRole("heading", { name: "Recordings · 4" })).toBeVisible();
  await expect(rows(page).filter({ hasText: "Eleanor One" })).toHaveAccessibleName(/^Eleanor One English · M4B · 64 kbps · /);
  await expect(rows(page).filter({ hasText: "Lecteur Un" })).toHaveAccessibleName(/^Lecteur Un French · M4B · /);
  await expect(rows(page).filter({ hasText: "Leser Eins" })).toHaveAccessibleName(/^Leser Eins German · M4B · /);
  await expect(rows(page).filter({ hasText: "Carroll - Alice [MP3]" })).toHaveAccessibleName("Carroll - Alice [MP3] Language unknown · 480 MB 12 seeders");
  // The page never contains Prowlarr's download key.
  expect(await page.content()).not.toContain("downloadUrl");
  await noOverflow(page);
  await choose(page, "English");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: "Carroll - Alice [MP3]" })).toHaveAccessibleName("Carroll - Alice [MP3] 480 MB 12 seeders");
});

test("Load more adds AudioBookBay's second page, keeps the choice, goes after the last page and comes back with Back and a reload", async ({ page }) => {
  const asked = await sources(page);
  await page.goto(`/#book/${ALICE.workId}`);
  await page.goto(SHEET);
  await expect(rows(page)).toHaveCount(2);
  const search = sheet(page).getByRole("searchbox", { name: "Search for a recording" });
  const words = await search.inputValue();
  await rows(page).filter({ hasText: "Eleanor One" }).click();
  // After the last row.
  const lastRow = (await rows(page).last().boundingBox())!;
  expect((await loadMore(page).boundingBox())!.y).toBeGreaterThan(lastRow.y + lastRow.height - 1);
  // The words of the search shown, not what the field holds now.
  await search.fill("something else");
  await loadMore(page).click();
  await expect.poll(() => asked.abb.length).toBe(2);
  expect(asked.abb[1]).toEqual({ q: words, page: "2" });
  // Page 2's copy of Eleanor One is not listed twice; Edward Two joins; the French row stays out.
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: "Eleanor One" })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: "Edward Two" })).toHaveCount(1);
  await expect(sheet(page).getByRole("heading", { name: "Recordings · 3" })).toBeVisible();
  await expect(rows(page).filter({ hasText: "Eleanor One" })).toHaveAttribute("aria-checked", "true");
  // No next page: Load more goes. Prowlarr was asked once.
  await expect(loadMore(page)).toHaveCount(0);
  expect(asked.prowlarr.length).toBe(1);
  // A change of language keeps the choice while its row is shown, and drops it when it is not.
  await choose(page, "All languages");
  await expect(rows(page)).toHaveCount(6);
  await expect(rows(page).filter({ hasText: "Eleanor One" })).toHaveAttribute("aria-checked", "true");
  await choose(page, "French");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: "Lecteur Deux" })).toHaveCount(1);
  for (const row of await rows(page).all()) await expect(row).toHaveAttribute("aria-checked", "false");
  await expect(sheet(page).getByRole("button", { name: "Get this recording", exact: true })).toBeDisabled();
  await rows(page).filter({ hasText: "Lecteur Deux" }).click();

  // Back to the Book page and Forward: the entry's rows, pages, language and choice, nothing asked again.
  const before = asked.abb.length;
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await page.goForward();
  await expect(languageButton(page)).toHaveAccessibleName("Language: French");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: "Lecteur Deux" })).toHaveAttribute("aria-checked", "true");
  await expect(loadMore(page)).toHaveCount(0);
  expect(asked.abb.length).toBe(before);

  // A reload asks the kept words again, both pages one after the other, and keeps the language and the choice.
  await page.reload();
  await expect.poll(() => asked.abb.slice(before)).toEqual([
    { q: words, page: "1" },
    { q: words, page: "2" },
  ]);
  await expect(languageButton(page)).toHaveAccessibleName("Language: French");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: "Lecteur Deux" })).toHaveAttribute("aria-checked", "true");
  await expect(loadMore(page)).toHaveCount(0);
  await choose(page, "English");
});

test("a failing second page is AudioBookBay's line with Retry for that page beside the first page's rows; nothing in the language", async ({ page }) => {
  let down = true;
  const asked = await sources(page, {
    page: (n) =>
      n === 1
        ? { results: PAGE1.filter((release) => release.language !== "English"), nextPage: 2 }
        : down
          ? { status: 503, error: "AudioBookBay returned 503. Try another mirror in Settings." }
          : { results: PAGE2, nextPage: null },
  });
  await page.goto(SHEET);
  // Rows were loaded, none in English but Prowlarr's, which names no language.
  await expect(rows(page)).toHaveCount(1);
  await choose(page, "All languages");
  await expect(rows(page)).toHaveCount(3);
  await choose(page, "English");
  // Nothing in the language: Prowlarr off this time, so only the language's line and Load more stay.
  await page.unroute("**/api/discover/prowlarr/releases?*");
  await page.route("**/api/discover/prowlarr/releases?*", (route) => route.fulfill({ json: { results: [] } }));
  const search = sheet(page).getByRole("searchbox", { name: "Search for a recording" });
  await search.fill("Alice Carroll");
  await search.press("Enter");
  await expect(sheet(page).getByRole("status").filter({ hasText: "No recordings in English on the loaded pages." })).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(loadMore(page)).toBeVisible();

  // The second page fails: AudioBookBay's line with the server's sentence, the first page's rows stay (All languages).
  await choose(page, "All languages");
  await expect(rows(page)).toHaveCount(2);
  await loadMore(page).click();
  const line = sheet(page).getByRole("status").filter({ hasText: "AudioBookBay could not be searched." });
  await expect(line).toContainText("AudioBookBay returned 503. Try another mirror in Settings.");
  await expect(rows(page)).toHaveCount(2);
  await expect(loadMore(page)).toHaveCount(0);
  await expect(sheet(page).getByRole("alert")).toHaveCount(0);
  await noOverflow(page);
  // Retry asks that page again; its rows join and the line goes.
  down = false;
  await sheet(page).getByRole("button", { name: "Retry AudioBookBay", exact: true }).click();
  await expect.poll(() => asked.abb.at(-1)).toEqual({ q: "Alice Carroll", page: "2" });
  await expect(line).toHaveCount(0);
  await expect(rows(page)).toHaveCount(5);
  await expect(loadMore(page)).toHaveCount(0);
  expect(asked.abb.filter((ask) => ask.q === "Alice Carroll").map((ask) => ask.page)).toEqual(["1", "2", "2"]);
  await choose(page, "English");
  await expect(rows(page)).toHaveCount(2);
});

for (const size of [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
])
  test(`the language and the Picker measured at ${size.name} size`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await sources(page);
    await page.goto(SHEET);
    await expect(rows(page)).toHaveCount(2);
    const field = (await sheet(page).locator(".get-sheet-field").boundingBox())!;
    const button = (await languageButton(page).boundingBox())!;
    // The field and the button on one 44 high line, 8 apart, filling the column.
    expect([field.height, button.height]).toEqual([44, 44]);
    expect(Math.round(button.x - (field.x + field.width))).toBe(8);
    const column = (await sheet(page).locator(".part-sheet-column").boundingBox())!;
    expect(Math.round(button.x + button.width)).toBe(Math.round(column.x + column.width));
    // Load more after the last row, at least 44 high.
    const more = (await loadMore(page).boundingBox())!;
    expect(more.height).toBeGreaterThanOrEqual(44);
    await languageButton(page).click();
    await expect(picker(page)).toBeVisible();
    const choices = picker(page).getByRole("radio");
    await expect(choices).toHaveCount(4);
    for (const choice of await choices.all()) expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const box = (await picker(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    await expect(picker(page).getByRole("radio", { name: "English", exact: true })).toHaveAttribute("aria-checked", "true");
    await noOverflow(page);
    await page.screenshot({ path: `${OUT}/get-audiobook-language-${size.name}.png` });
    // Escape closes it without choosing.
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
    await expect(languageButton(page)).toHaveAccessibleName("Language: English");
    await expect(languageButton(page)).toBeFocused();
  });
