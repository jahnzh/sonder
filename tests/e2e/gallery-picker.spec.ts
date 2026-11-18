import { test, expect, type Page } from "@playwright/test";
import { defaultAppearance, paletteFor, type Appearance } from "../../src/appearance";

// The Picker part on the gallery (#578; spec #572, "The Picker part"; boards LibrarySort.dc.html, LibraryShelf.dc.html):
// named as a dialog; open, choose, Done, Escape and a tap outside; focus in and back to its button; a picker row's
// second list and its back button; no address of its own; from the bottom edge on a phone and under its button on a
// desktop; measured in every theme preset, the custom palette and both densities. The looks and openWith are the
// ones of tests/e2e/gallery.spec.ts (a spec file is not imported, or its tests would run twice).

type Look = { name: string; appearance: Appearance };
const presets = ["forest", "charcoal", "amoled", "contrast", "light", "system"] as const;
const custom = { background: "#202a33", surface: "#2b3844", text: "#f5efe0", muted: "#c2b8a3", border: "#56677a" };
const looks: Look[] = [];
for (const density of ["comfortable", "compact"] as const) {
  for (const preset of presets) looks.push({ name: `${preset}, ${density}`, appearance: { ...defaultAppearance, preset, density } });
  looks.push({ name: `custom palette, ${density}`, appearance: { ...defaultAppearance, preset: "forest", accent: "#8fb8a0", colors: custom, density } });
}

let before: Appearance | null = null;
test.beforeEach(async ({ page }) => {
  before = await (await page.request.get("/api/appearance")).json();
});
test.afterEach(async ({ page }) => {
  if (before) expect((await page.request.put("/api/appearance", { data: before })).ok()).toBe(true);
});

async function openWith(page: Page, appearance: Appearance) {
  expect((await page.request.put("/api/appearance", { data: appearance })).ok()).toBe(true);
  await page.goto("/#gallery");
  const dark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const palette = paletteFor(appearance, dark);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        return [root.dataset.theme, root.dataset.density, root.style.getPropertyValue("--surface")];
      }),
    )
    .toEqual([appearance.preset, appearance.density, palette.surface]);
  await expect(page.locator('[data-gallery-section="picker"]')).toBeVisible();
}

const section = (page: Page) => page.locator('[data-gallery-section="picker"]');
const fullButton = (page: Page) => section(page).getByRole("button", { name: "Sort and view", exact: true });
const oneButton = (page: Page) => section(page).getByRole("button", { name: /^Shelf: / });
const picker = (page: Page, name = "Sort and view") => page.getByRole("dialog", { name, exact: true });
const status = (page: Page) => page.locator(".gallery-status");
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return "body";
    return element.getAttribute("aria-label") ?? element.innerText.replace(/\s+/g, " ").trim();
  });

/** The open picker's measures, read in the page in one go. */
function measure(page: Page) {
  return page.evaluate(() => {
    const probe = (value: string) => {
      const element = document.createElement("div");
      element.style.backgroundColor = value;
      document.body.append(element);
      const resolved = getComputedStyle(element).backgroundColor;
      element.remove();
      return resolved;
    };
    const panel = document.querySelector(".part-picker")!;
    const r = (element: Element) => element.getBoundingClientRect();
    const head = panel.querySelector(".part-picker-head")!;
    const rows = [...panel.querySelectorAll(".part-picker-choice, .part-picker-row")];
    const chosen = panel.querySelector(".part-picker-choice[data-chosen]")!;
    const lists = [...panel.querySelectorAll(".part-picker-list")];
    return {
      panel: { ...r(panel).toJSON(), background: getComputedStyle(panel).backgroundColor, radius: getComputedStyle(panel).borderTopLeftRadius },
      head: r(head).height,
      done: r(panel.querySelector(".part-picker-done")!).height,
      rows: rows.map((row) => r(row).height),
      lines: lists.flatMap((list) => [...list.children].slice(1).map((item) => getComputedStyle(item).borderTopWidth)),
      chosen: { background: getComputedStyle(chosen).backgroundColor, weight: getComputedStyle(chosen).fontWeight },
      listBackground: getComputedStyle(lists[0]).backgroundColor,
      tick: getComputedStyle(chosen.querySelector(".part-picker-tick")!).color,
      colours: { surface: probe("var(--surface)"), raised: probe("var(--raised)"), background: probe("var(--background)"), accent: probe("var(--accent)") },
      window: { width: innerWidth, height: innerHeight },
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

for (const look of looks) {
  test(`the Picker's measures: ${look.name}`, async ({ page }) => {
    await openWith(page, look.appearance);
    await fullButton(page).click();
    await expect(picker(page)).toBeVisible();
    const m = await measure(page);
    // From the bottom edge, the window's width, corner 14 at its top, on the surface.
    expect(Math.round(m.panel.bottom)).toBe(m.window.height);
    expect(Math.round(m.panel.width)).toBe(m.window.width);
    expect(m.panel.radius).toBe("14px");
    expect(m.panel.background).toBe(m.colours.surface);
    expect(m.head).toBe(44);
    expect(m.done).toBe(44);
    // Four sort rows and two picker rows, 52 each, a 1 px line between rows, on the ground colour.
    expect(m.rows).toEqual([52, 52, 52, 52, 52, 52]);
    expect(m.lines).toEqual(["1px", "1px", "1px", "1px"]);
    expect(m.listBackground).toBe(m.colours.background);
    expect(m.chosen.background).toBe(m.colours.raised);
    expect(Number(m.chosen.weight)).toBeGreaterThanOrEqual(600);
    expect(m.tick).toBe(m.colours.accent);
    expect(m.overflow).toBe(0);
    // The second list is measured the same.
    await picker(page).getByRole("button", { name: "List: All lists", exact: true }).click();
    const rows = await page.locator(".part-picker-choice").evaluateAll((all) => all.map((row) => row.getBoundingClientRect().height));
    expect(rows).toEqual([52, 52, 52]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  });
}

test("named as a dialog; focus moves in and returns; a choice applies at once; Done, Escape and a tap outside close it; no address", async ({ page }) => {
  await openWith(page, defaultAppearance);
  const address = page.url();
  const length = await page.evaluate(() => history.length);
  await fullButton(page).click();
  await expect(picker(page)).toBeVisible();
  // Focus in: on the chosen sort row. The rest of the page is out of reach.
  expect(await focusedName(page)).toBe("Recently added");
  await expect(picker(page).getByRole("radiogroup", { name: "Sort", exact: true }).getByRole("radio")).toHaveText(["Recently added", "Title", "Author", "Progress"]);
  await expect(picker(page).getByRole("radiogroup", { name: "View", exact: true })).toBeVisible();
  // A choice applies at once and keeps the picker open.
  await picker(page).getByRole("radio", { name: "Author", exact: true }).click();
  await expect(status(page)).toHaveText("Sort: Author");
  await expect(picker(page).getByRole("radio", { name: "Author", exact: true })).toHaveAttribute("aria-checked", "true");
  await picker(page).getByRole("radio", { name: "List", exact: true }).click();
  await expect(status(page)).toHaveText("View: List");
  await expect(picker(page)).toBeVisible();
  // No address: opening it added no entry.
  expect(page.url()).toBe(address);
  expect(await page.evaluate(() => history.length)).toBe(length);
  // Done closes it, and focus returns to its button.
  await picker(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
  expect(await focusedName(page)).toBe("Sort and view");
  // Escape.
  await fullButton(page).click();
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  expect(await focusedName(page)).toBe("Sort and view");
  // A tap outside (above the panel, on the dimmed page).
  await fullButton(page).click();
  await expect(picker(page)).toBeVisible();
  await page.mouse.click(195, 20);
  await expect(picker(page)).toHaveCount(0);
  expect(page.url()).toBe(address);
  // The one-list form: a choice closes it, focus back on its button.
  await oneButton(page).click();
  await expect(picker(page, "Shelf")).toBeVisible();
  await expect(picker(page, "Shelf").getByRole("radio", { name: "Want to read", exact: true })).toHaveAttribute("aria-checked", "true");
  await picker(page, "Shelf").getByRole("radio", { name: "Paused", exact: true }).click();
  await expect(picker(page, "Shelf")).toHaveCount(0);
  await expect(oneButton(page)).toHaveText("Shelf: Paused");
  await expect(oneButton(page)).toBeFocused();
});

test("a picker row opens its second list inside the picker, with a back button; a choice there comes back to the first", async ({ page }) => {
  await openWith(page, defaultAppearance);
  await fullButton(page).click();
  const shelfRow = picker(page).getByRole("button", { name: "Shelf: All shelves", exact: true });
  await shelfRow.click();
  // The same dialog, its second list named Shelf, a back button to the first, the first list's rows gone.
  await expect(picker(page)).toBeVisible();
  const shelves = picker(page).getByRole("radiogroup", { name: "Shelf", exact: true }).getByRole("radio");
  await expect(shelves).toHaveText(["All shelves", "Want to read", "Currently reading", "Read", "Paused", "Did not finish"]);
  await expect(picker(page).getByRole("radiogroup", { name: "Sort", exact: true })).toHaveCount(0);
  expect(await focusedName(page)).toBe("All shelves");
  // Back returns to the first list, focus on the row that opened the second.
  await picker(page).getByRole("button", { name: "Back to Sort and view", exact: true }).click();
  await expect(picker(page).getByRole("radiogroup", { name: "Sort", exact: true })).toBeVisible();
  await expect(shelfRow).toBeFocused();
  // A choice in the second list applies and comes back with the row showing it.
  await shelfRow.click();
  await picker(page).getByRole("radio", { name: "Want to read", exact: true }).click();
  await expect(status(page)).toHaveText("Shelf: Want to read");
  await expect(picker(page).getByRole("button", { name: "Shelf: Want to read", exact: true })).toBeFocused();
  // A list's count is read with its name.
  await picker(page).getByRole("button", { name: "List: All lists", exact: true }).click();
  await expect(picker(page).getByRole("radio", { name: "Weekend escapes · 3", exact: true })).toBeVisible();
  // Escape in the second list closes the whole picker; it opens again on the first list.
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await fullButton(page).click();
  await expect(picker(page).getByRole("radiogroup", { name: "Sort", exact: true })).toBeVisible();
});

test("on a desktop the picker opens under its button, the page not dimmed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWith(page, defaultAppearance);
  await fullButton(page).evaluate((element) => element.scrollIntoView({ block: "start" }));
  await fullButton(page).click();
  await expect(picker(page)).toBeVisible();
  // By its class: the page under a dialog is hidden from its roles.
  const button = (await page.locator('[data-sample="picker-full"] button').boundingBox())!;
  const panel = (await picker(page).boundingBox())!;
  expect(Math.round(panel.y)).toBe(Math.round(button.y + button.height + 8));
  expect(panel.width).toBe(360);
  expect(panel.x).toBeGreaterThanOrEqual(16);
  expect(panel.x + panel.width).toBeLessThanOrEqual(1280 - 16);
  expect(await page.locator(".part-picker-overlay").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  // A tap outside closes it there too.
  await page.mouse.click(5, 795);
  await expect(picker(page)).toHaveCount(0);
});
