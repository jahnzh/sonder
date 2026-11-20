// @projects firefox, mobile-iphone-slice14
import { test, expect, type Page } from "@playwright/test";

// Settings › Playback › Keyboard shortcuts (#614; spec #608 "Keyboard shortcuts"; board SettingsKeys.dc.html, the row on
// SettingsPlayback.dc.html, beside the list as on DesktopSettings.dc.html): the page opens from Playback's row and by
// its address, is measured against its board, sits beside the list at a desktop width, and Back returns to Playback.
// And `/`: it focuses the Library's search (opened in place of the Title row) and Discover's field, and types a `/`
// into a field that already has the focus.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const GROUPS = ["Listening", "Reading", "Library and Discover"];
const ROWS = [
  ["Play or pause", "Space", ""],
  ["Back 30 seconds", "←", ""],
  ["Forward 30 seconds", "→", ""],
  ["Back to narration", "F", ""],
  ["Previous page", "←", "While nothing plays"],
  ["Next page", "→", "While nothing plays"],
  ["Search", "/", ""],
];

const hash = (page: Page) => page.evaluate(() => location.hash);
const back = (page: Page) => page.getByRole("button", { name: "Back to Playback", exact: true });
const keysPage = (page: Page, desktop: boolean) =>
  desktop ? page.locator('section.settings-split-page[data-page="keyboard"]') : page.locator('.settings-phone[data-page="keyboard"]');

async function openFromPlayback(page: Page) {
  await page.goto("/#settings/playback");
  await page.locator("main").getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await expect.poll(() => hash(page)).toBe("#settings/keyboard");
}

/** The page against its board: one Title, the back button's name, the groups in order, rows of 52, each key a kbd. */
async function expectBoard(page: Page, desktop: boolean) {
  const shown = keysPage(page, desktop);
  await expect(shown).toBeVisible();
  const heading = desktop ? shown.getByRole("heading", { level: 2, name: "Keyboard shortcuts", exact: true }) : page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Keyboard shortcuts");
  await expect(back(page)).toBeVisible();
  await expect(shown.locator(".part-group-caption")).toHaveText(GROUPS);
  const measured = await shown.evaluate((root) => {
    const main = document.querySelector("main")!;
    const width = document.documentElement.clientWidth;
    return {
      titles: main.querySelectorAll("h1").length,
      scrolls: document.documentElement.scrollWidth > width,
      rows: [...root.querySelectorAll(".part-row")].map((row) => {
        const label = row.querySelector(".part-row-label")!.textContent;
        const detail = row.querySelector(".part-row-detail")?.textContent ?? "";
        const kbd = row.querySelector("kbd")!;
        const look = getComputedStyle(kbd);
        const raised = getComputedStyle(document.documentElement).getPropertyValue("--raised").trim();
        const probe = document.createElement("span");
        probe.style.color = raised;
        document.body.append(probe);
        const raisedColour = getComputedStyle(probe).color;
        probe.remove();
        return {
          text: [label, kbd.textContent, detail],
          height: Math.round(row.getBoundingClientRect().height),
          kbd: {
            height: Math.round(kbd.getBoundingClientRect().height),
            corner: look.borderTopLeftRadius,
            raised: look.backgroundColor === raisedColour,
            right: Math.round(row.getBoundingClientRect().right - kbd.getBoundingClientRect().right),
          },
        };
      }),
    };
  });
  expect(measured.titles, "one Title").toBe(1);
  expect(measured.scrolls, "no horizontal overflow").toBe(false);
  expect(measured.rows.map((row) => row.text)).toEqual(ROWS);
  for (const row of measured.rows) {
    // A row of one line is 52 high; a row with "While nothing plays" under it is at least 52, the two lines 8 from its edges.
    if (row.text[2]) expect(row.height, row.text[0]).toBe(58);
    else expect(row.height, row.text[0]).toBe(52);
    expect(row.kbd, row.text[0]).toEqual({ height: 32, corner: "8px", raised: true, right: 16 });
  }
}

for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  const desktop = size === "desktop";
  test.describe(`at ${viewport.width} by ${viewport.height}`, () => {
    test.use({ viewport });

    test("Keyboard shortcuts opens from Playback's row, is its board, and Back returns to Playback", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await openFromPlayback(page);
      await expectBoard(page, desktop);
      // Beside its board for the slice's final check, as settings-pages.spec.ts leaves its pages.
      if (test.info().project.name === "chromium") await page.screenshot({ path: `OUT/settings-page-keyboard-${size}.png` });
      // No dialog: the keys are a page (#614 replaces the keyboard help dialog).
      await expect(page.getByRole("dialog")).toHaveCount(0);
      if (desktop) {
        // Beside the Settings list, with Playback chosen in it.
        const list = page.getByRole("navigation", { name: "Settings", exact: true });
        await expect(list).toBeVisible();
        await expect(list.getByRole("button", { name: /^Playback\b/ })).toHaveAttribute("aria-current", "page");
        await expect(list.locator('[aria-current="page"]')).toHaveCount(1);
      }
      await back(page).click();
      await expect.poll(() => hash(page)).toBe("#settings/playback");
      await expect(page.locator("main").getByRole("button", { name: "Keyboard shortcuts", exact: true })).toBeVisible();
      // Back went back in history: the browser's Forward returns to the keys.
      await page.goForward();
      await expect.poll(() => hash(page)).toBe("#settings/keyboard");
      await expect(keysPage(page, desktop)).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("Keyboard shortcuts opens by its address, and its Back goes to Playback", async ({ page }) => {
      await page.goto("/#settings/keyboard");
      await expectBoard(page, desktop);
      await back(page).click();
      await expect.poll(() => hash(page)).toBe("#settings/playback");
      if (!desktop) await expect(page.getByRole("heading", { level: 1 })).toHaveText("Playback");
      else await expect(page.locator("#settings-page-title")).toHaveText("Playback");
      // Opened by a link, Back put Playback in its place: Back on Playback leaves the keys behind.
      await expect(page.getByRole("button", { name: "Back to Playback", exact: true })).toHaveCount(0);
    });
  });
}

test.describe("/ and the search", () => {
  test.use({ viewport: PHONE });

  test("/ focuses the Library's search, opened in place of the Title row, and types into a focused field", async ({ page }) => {
    await page.goto("/#library");
    const title = page.locator(".library-head").getByRole("heading", { level: 1, name: "Library", exact: true });
    await expect(title).toBeVisible();
    const field = page.getByRole("searchbox", { name: "Search your library", exact: true });
    await expect(field).toBeHidden();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("/");
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(title).toBeHidden();
    // The key opened the search; it typed nothing.
    await expect(field).toHaveValue("");
    // In the field, `/` is typed.
    await page.keyboard.type("a/b");
    await expect(field).toHaveValue("a/b");
    expect(await hash(page)).toBe("#library");
  });

  test("/ focuses Discover's field, and types into a focused field", async ({ page }) => {
    await page.goto("/#discover");
    const field = page.locator("main").getByRole("searchbox", { name: "Search for a book", exact: true });
    await expect(field).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(field).not.toBeFocused();
    await page.keyboard.press("/");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("");
    await page.keyboard.type("1/2");
    await expect(field).toHaveValue("1/2");
  });

  test("/ does nothing on a page without a search", async ({ page }) => {
    await page.goto("/#settings/keyboard");
    await expect(back(page)).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("/");
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await hash(page)).toBe("#settings/keyboard");
    expect(await page.locator("[data-search-key]").count()).toBe(0);
  });
});
