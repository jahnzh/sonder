import { test, expect, type Page } from "@playwright/test";
import { defaultAppearance, paletteFor, type Appearance } from "../../src/appearance";

// The Tooltip part on the gallery (#491; spec #480, "Parts"; board Tooltips.dc.html): the info mark and its
// explanation measured in every preset, the custom palette and both densities; a tap opens it under its entry, a tap
// elsewhere and Escape close it, a second one closes the first; on a desktop hover and keyboard focus open it; names
// and the announcement; an icon without a label shows its name on hover; and a tooltip is not in the address.

// Taps need touch input; the desktop projects get it here, the phone projects have it already.
test.use({ hasTouch: true });

type Look = { name: string; appearance: Appearance };
const presets = ["forest", "charcoal", "amoled", "contrast", "light", "system"] as const;
const custom = { background: "#202a33", surface: "#2b3844", text: "#f5efe0", muted: "#c2b8a3", border: "#56677a" };
const looks: Look[] = [];
for (const density of ["comfortable", "compact"] as const) {
  for (const preset of presets) looks.push({ name: `${preset}, ${density}`, appearance: { ...defaultAppearance, preset, density } });
  looks.push({ name: `custom palette, ${density}`, appearance: { ...defaultAppearance, preset: "forest", accent: "#8fb8a0", colors: custom, density } });
}

// One server serves every spec of a run: each test leaves the stored appearance as it found it.
let before: Appearance | null = null;
test.beforeEach(async ({ page }) => {
  before = await (await page.request.get("/api/appearance")).json();
});
test.afterEach(async ({ page }) => {
  if (before) expect((await page.request.put("/api/appearance", { data: before })).ok()).toBe(true);
});

async function openWith(page: Page, appearance: Appearance = defaultAppearance, address = "/#gallery") {
  expect((await page.request.put("/api/appearance", { data: appearance })).ok()).toBe(true);
  await page.goto(address);
  const dark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const palette = paletteFor(appearance, dark);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        return [root.dataset.theme, root.dataset.density, root.style.getPropertyValue("--surface"), root.style.getPropertyValue("--accent")];
      }),
    )
    .toEqual([appearance.preset, appearance.density, palette.surface, appearance.accent]);
  if (address.includes("gallery")) await expect(page.locator('[data-gallery-section="tooltip"]')).toBeVisible();
}

const mark = (page: Page, name: string) => page.getByRole("button", { name: `About ${name}`, exact: true });
const tip = (page: Page) => page.locator(".part-tooltip");
const texts = {
  storage: /^On: the browser keeps these files/,
  recordings: /^Each recording keeps its own place/,
  plays: /^Automatic uses the device copy/,
};

/** A tap on a mark scrolled to the middle of the screen, so its explanation has room under it (at the bottom of
 *  the screen it opens above instead). */
async function tap(page: Page, name: string) {
  await mark(page, name).evaluate((element) => element.scrollIntoView({ block: "center" }));
  // A touch at the mark's centre: Playwright's own tap in Firefox may scroll the mark to the screen's bottom first.
  const box = (await mark(page, name).boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/** A tap on a spot of the page that holds nothing. */
async function tapElsewhere(page: Page) {
  const status = page.locator(".gallery-section-title").first();
  await status.scrollIntoViewIfNeeded();
  const box = (await status.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width - 4, box.y + box.height / 2);
}

for (const look of looks) {
  test(`the info mark and its explanation measure as the board says: ${look.name}`, async ({ page }) => {
    await openWith(page, look.appearance);
    // Every mark: a 20 px circled i in the muted colour, in a target of at least 44 by 44.
    const marks = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--muted)";
      document.body.append(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      return [...document.querySelectorAll(".part-info-mark")].map((element) => {
        const target = element.getBoundingClientRect();
        const icon = element.querySelector("svg")!.getBoundingClientRect();
        return { width: target.width, height: target.height, icon: [icon.width, icon.height], colour: getComputedStyle(element).color, muted };
      });
    });
    expect(marks.length).toBe(6);
    for (const m of marks) {
      expect(m.width).toBeGreaterThanOrEqual(44);
      expect(m.height).toBeGreaterThanOrEqual(44);
      expect(m.icon).toEqual([20, 20]);
      expect(m.colour).toBe(m.muted);
    }
    // The marks do not grow what they stand in: the row stays 52, the caption line no taller than the target.
    const row = page.locator('[data-sample="tooltip-row"] .part-row');
    expect((await row.boundingBox())!.height).toBe(52);

    await tap(page, "Protected storage");
    await expect(tip(page)).toBeVisible();
    await expect(tip(page)).toHaveText(texts.storage);
    // Settle the positioning before reading boxes.
    await page.waitForTimeout(50);
    const m = await page.evaluate(() => {
      const probe = (property: "color" | "backgroundColor", value: string) => {
        const element = document.createElement("div");
        element.style[property] = value;
        document.body.append(element);
        const resolved = getComputedStyle(element)[property];
        element.remove();
        return resolved;
      };
      const tooltip = document.querySelector(".part-tooltip")!;
      const style = getComputedStyle(tooltip);
      const arrow = tooltip.querySelector(".part-tooltip-arrow")!.getBoundingClientRect();
      const markBox = document.querySelector('[data-sample="tooltip-row"] .part-info-mark svg')!.getBoundingClientRect();
      const rowBox = document.querySelector('[data-sample="tooltip-row"] .part-row')!.getBoundingClientRect();
      const box = tooltip.getBoundingClientRect();
      return {
        box: { x: box.x, y: box.y, width: box.width, right: box.right },
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
        font: [style.fontSize, style.lineHeight, style.fontWeight],
        family: style.fontFamily,
        fill: style.backgroundColor,
        colour: style.color,
        arrowFill: getComputedStyle(tooltip.querySelector(".part-tooltip-arrow")!).fill,
        arrow: { x: arrow.x + arrow.width / 2, top: arrow.top, bottom: arrow.bottom },
        mark: { x: markBox.x + markBox.width / 2, bottom: markBox.bottom },
        row: { bottom: rowBox.bottom },
        light: probe("backgroundColor", "var(--text)"),
        dark: probe("color", "var(--background)"),
        textFill: probe("color", "var(--text)"),
        viewport: innerWidth,
      };
    });
    // At most 300 wide and inside the screen edge; corner 8; Label size; the palette's text colour as the fill and
    // its ground as the text.
    expect(m.box.width).toBeLessThanOrEqual(300);
    expect(m.box.width).toBeGreaterThan(200);
    expect(m.box.x).toBeGreaterThanOrEqual(16 - 0.5);
    expect(m.box.right).toBeLessThanOrEqual(m.viewport - 16 + 0.5);
    expect(m.radii).toEqual(["8px", "8px", "8px", "8px"]);
    expect(m.font).toEqual(["14px", "20px", "500"]);
    expect(m.family).toMatch(/DM Sans/);
    expect(m.fill).toBe(m.light);
    expect(m.colour).toBe(m.dark);
    expect(m.arrowFill).toBe(m.textFill);
    // Under its entry, its pointer under the mark and pointing up at it.
    expect(m.box.y).toBeGreaterThanOrEqual(m.mark.bottom);
    expect(m.arrow.bottom).toBeLessThanOrEqual(m.box.y + 1);
    expect(m.arrow.top).toBeGreaterThanOrEqual(m.mark.bottom - 0.5);
    expect(Math.abs(m.arrow.x - m.mark.x)).toBeLessThanOrEqual(1);
  });
}

test("a tap opens the explanation under its entry; a tap elsewhere, Escape and a second tap close it", async ({ page }) => {
  await openWith(page);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await tap(page, "Protected storage");
  await expect(page.getByRole("tooltip")).toHaveText(texts.storage);
  const entry = (await page.locator('[data-sample="tooltip-row"] .part-row-label').boundingBox())!;
  expect((await tip(page).boundingBox())!.y).toBeGreaterThanOrEqual(entry.y + entry.height);
  // A tap elsewhere closes it, and does what that tap does (nothing here).
  await tapElsewhere(page);
  await expect(tip(page)).toHaveCount(0);
  // A tap on the explanation itself keeps it.
  await tap(page, "Protected storage");
  await expect(tip(page)).toBeVisible();
  await tip(page).tap();
  await expect(tip(page)).toBeVisible();
  // A second tap on the mark closes it.
  await tap(page, "Protected storage");
  await expect(tip(page)).toHaveCount(0);
  // Escape closes it.
  await tap(page, "Recordings");
  await expect(tip(page)).toHaveText(texts.recordings);
  await page.keyboard.press("Escape");
  await expect(tip(page)).toHaveCount(0);
  // After a group caption and a page title too.
  for (const [name, text] of [
    ["Workers", /^The machines that prepare reading sync/],
    ["Reading sync", /^The ebook follows the narration/],
  ] as const) {
    await tap(page, name);
    await expect(tip(page)).toHaveText(text);
    const markBox = (await mark(page, name).boundingBox())!;
    expect((await tip(page).boundingBox())!.y).toBeGreaterThanOrEqual(markBox.y + markBox.height / 2 + 10);
    await tapElsewhere(page);
    await expect(tip(page)).toHaveCount(0);
  }
});

test("opening a second explanation closes the first: one is open at a time", async ({ page }) => {
  await openWith(page);
  // An open explanation lies over what is under it (or over it, at the bottom of the page), so each next mark is one
  // it does not cover, as for a finger.
  await tap(page, "Recordings");
  await expect(tip(page)).toHaveText(texts.recordings);
  await tap(page, "Protected storage");
  await expect(tip(page)).toHaveCount(1);
  await expect(tip(page)).toHaveText(texts.storage);
  await expect(mark(page, "Recordings")).toHaveAttribute("aria-expanded", "false");
  await expect(mark(page, "Protected storage")).toHaveAttribute("aria-expanded", "true");
  // Then one in the same group as the first.
  await tap(page, "Plays from");
  await expect(tip(page)).toHaveCount(1);
  await expect(tip(page)).toHaveText(texts.plays);
  await expect(mark(page, "Protected storage")).toHaveAttribute("aria-expanded", "false");
  // A hover on another mark (a desktop) takes over as well.
  await mark(page, "Workers").evaluate((element) => element.scrollIntoView({ block: "center" }));
  await mark(page, "Workers").hover();
  await expect(tip(page)).toHaveCount(1);
  await expect(tip(page)).toHaveText(/^The machines that prepare reading sync/);
  await expect(mark(page, "Plays from")).toHaveAttribute("aria-expanded", "false");
});

test("on a desktop it opens on hover and closes when the pointer leaves", async ({ page }) => {
  await openWith(page);
  await mark(page, "Recordings").scrollIntoViewIfNeeded();
  await mark(page, "Recordings").hover();
  await expect(tip(page)).toHaveText(texts.recordings);
  // The pointer can move onto the explanation without closing it.
  const box = (await tip(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.waitForTimeout(300);
  await expect(tip(page)).toBeVisible();
  // Leaving both closes it.
  await page.mouse.move(2, 2);
  await expect(tip(page)).toHaveCount(0);
  // A click while hovered keeps it open after the pointer leaves; a click elsewhere closes it.
  await mark(page, "Recordings").hover();
  await expect(tip(page)).toBeVisible();
  await mark(page, "Recordings").click();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  await expect(tip(page)).toHaveText(texts.recordings);
  await page.mouse.click(2, 2);
  await expect(tip(page)).toHaveCount(0);
});

test("on a desktop it opens on keyboard focus, and closes on Escape and when focus moves on", async ({ page, browserName }) => {
  await openWith(page);
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  // From the last control before the section, Tab reaches the marks in order.
  await page.getByRole("button", { name: "Child page", exact: true }).focus();
  await page.keyboard.press(tab);
  await expect(mark(page, "Protected storage")).toBeFocused();
  await expect(tip(page)).toHaveText(texts.storage);
  await page.keyboard.press(tab);
  await expect(mark(page, "Workers")).toBeFocused();
  await expect(tip(page)).toHaveCount(1);
  await expect(tip(page)).toHaveText(/^The machines that prepare reading sync/);
  await page.keyboard.press("Escape");
  await expect(tip(page)).toHaveCount(0);
  await expect(mark(page, "Workers")).toBeFocused();
  // Enter opens it again, and closes it.
  await page.keyboard.press("Enter");
  await expect(tip(page)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(tip(page)).toHaveCount(0);
  // Shift+Tab back to the first mark opens that one.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");
  await expect(tip(page)).toHaveText(texts.storage);
  // Focus leaving the marks closes it.
  await page.getByRole("button", { name: "Child page", exact: true }).focus();
  await expect(tip(page)).toHaveCount(0);
});

test("the info mark has a name, and a screen reader is told the explanation when it opens", async ({ page }) => {
  await openWith(page);
  for (const name of ["Protected storage", "Workers", "Reading sync", "Recordings", "Available from", "Plays from"])
    await expect(mark(page, name)).toHaveCount(1);
  const storage = mark(page, "Protected storage");
  await expect(storage).toHaveAttribute("aria-expanded", "false");
  const live = page.locator('[data-sample="tooltip-row"] [aria-live="polite"]');
  await expect(live).toHaveText("");
  await tap(page, "Protected storage");
  await expect(storage).toHaveAttribute("aria-expanded", "true");
  // The explanation is a tooltip that describes its mark, and the polite live region beside the mark reads it out.
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText(texts.storage);
  const id = await tooltip.getAttribute("id");
  expect(id).toBeTruthy();
  await expect(storage).toHaveAttribute("aria-describedby", id!);
  await expect(storage).toHaveAttribute("aria-controls", id!);
  await expect(storage).toHaveAccessibleDescription(texts.storage);
  await expect(live).toHaveText(texts.storage);
  // Focus stays on the mark.
  await expect(storage).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(live).toHaveText("");
  await expect(storage).not.toHaveAttribute("aria-describedby", /.+/);
  // The row is still named by its label and value only.
  await expect(page.getByRole("listitem", { name: "Protected storage On", exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Workers", exact: true })).toBeVisible();
});

test("an icon without a label shows its name on hover, on one line in the Caption size", async ({ page }) => {
  await openWith(page);
  const remove = page.getByRole("button", { name: "Remove from this device", exact: true });
  await remove.scrollIntoViewIfNeeded();
  const name = page.locator(".part-icon-name");
  await expect(name).toHaveCount(0);
  await remove.hover();
  await expect(name).toHaveText("Remove from this device");
  const m = await name.evaluate((element) => {
    const style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      font: [style.fontSize, style.lineHeight, style.fontWeight],
      lines: range.getClientRects().length,
      whiteSpace: style.whiteSpace,
      height: element.getBoundingClientRect().height,
      radius: style.borderTopLeftRadius,
    };
  });
  expect(m.font).toEqual(["12px", "16px", "600"]);
  expect(m.whiteSpace).toBe("nowrap");
  expect(m.lines).toBe(1);
  expect(m.height).toBe(16 + 12);
  expect(m.radius).toBe("8px");
  // It names the button only once for a screen reader: the shown name is hidden from it.
  await expect(name).toHaveAttribute("aria-hidden", "true");
  const box = (await remove.boundingBox())!;
  const shown = (await name.boundingBox())!;
  // Beside the icon, under it or (at the bottom of the screen) over it, never on it.
  expect(shown.y >= box.y + box.height || shown.y + shown.height <= box.y).toBe(true);
  // Over the icon's width, kept inside the screen edge.
  expect(shown.x).toBeLessThanOrEqual(box.x + box.width / 2);
  expect(shown.x + shown.width).toBeGreaterThanOrEqual(box.x + box.width / 2);
  expect(shown.x).toBeGreaterThanOrEqual(16 - 0.5);
  // Leaving the icon hides it; so does pressing it.
  await page.mouse.move(2, 2);
  await expect(name).toHaveCount(0);
  await page.getByRole("button", { name: "Report a problem", exact: true }).hover();
  await expect(name).toHaveText("Report a problem");
  await page.mouse.down();
  await expect(name).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByRole("status")).toHaveText("Report a problem pressed");
  // A tap shows no name.
  await page.mouse.move(2, 2);
  await remove.tap();
  await page.waitForTimeout(500);
  await expect(name).toHaveCount(0);
});

test("a tooltip is not in the address: Back with one open leaves the page", async ({ page }) => {
  await openWith(page, defaultAppearance, "/#library");
  await expect(page.locator(".topbar")).toBeVisible();
  await page.evaluate(() => {
    location.hash = "#gallery";
  });
  await expect(page.locator('[data-gallery-section="tooltip"]')).toBeVisible();
  const address = page.url();
  const length = await page.evaluate(() => history.length);
  await tap(page, "Recordings");
  await expect(tip(page)).toBeVisible();
  expect(page.url()).toBe(address);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.locator(".topbar")).toBeVisible();
  await expect(tip(page)).toHaveCount(0);
});
