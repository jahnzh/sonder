import { test, expect, type Page } from "@playwright/test";
import { defaultAppearance, paletteFor, type Appearance } from "../../src/appearance";

// The Sheet part on the gallery's own sheet, `#gallery/sheet` (#492; spec #480, "Parts" and "Addresses and the page
// stack"; boards GetAudiobook.dc.html, SeriesAdd.dc.html): its entry and Back, a reload and a link straight to it,
// its name, focus and Escape, and its measures in every preset at a phone size and at a desktop width.

const presets = ["forest", "charcoal", "amoled", "contrast", "light", "system"] as const;
const custom = { background: "#202a33", surface: "#2b3844", text: "#f5efe0", muted: "#c2b8a3", border: "#56677a" };

// One server serves every spec of a run: each test leaves the stored appearance as it found it.
let before: Appearance | null = null;
test.beforeEach(async ({ page }) => {
  before = await (await page.request.get("/api/appearance")).json();
});
test.afterEach(async ({ page }) => {
  if (before) expect((await page.request.put("/api/appearance", { data: before })).ok()).toBe(true);
});

/** Opens an address with an appearance stored for the account, once the app shows that appearance. */
async function openWith(page: Page, appearance: Appearance, address = "/#gallery") {
  expect((await page.request.put("/api/appearance", { data: appearance })).ok()).toBe(true);
  await page.goto(address);
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
}

const opener = (page: Page) => page.getByRole("button", { name: "Sheet", exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Sheet" });
const gallery = (page: Page) => page.locator('main[aria-label="Gallery"]');

/** Scrolls the gallery to its sheet sample, so there is a scroll position for Back to keep. */
async function scrollToOpener(page: Page) {
  // In the middle of the window, so a click on it does not scroll the page by itself.
  await opener(page).evaluate((element) => element.scrollIntoView({ block: "center" }));
  const y = await page.evaluate(() => Math.round(window.scrollY));
  expect(y).toBeGreaterThan(200);
  return y;
}
const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));
/** The focused element's name, or "dialog:<name>" for the sheet itself. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return "body";
    if (element.getAttribute("role") === "dialog") return `dialog:${document.getElementById(element.getAttribute("aria-labelledby")!)?.textContent}`;
    return element.getAttribute("aria-label") ?? element.innerText.replace(/\s+/g, " ").trim();
  });

test("opening the sheet adds an entry; Back closes it, and the gallery is where it was scrolled to", async ({ page }) => {
  await openWith(page, defaultAppearance);
  const y = await scrollToOpener(page);
  const length = await page.evaluate(() => history.length);
  await opener(page).click();
  await expect(page).toHaveURL(/#gallery\/sheet$/);
  await expect(sheet(page)).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  // The page under it stays, unmoved and out of reach.
  await expect(gallery(page)).toBeAttached();
  expect(await scrollY(page)).toBe(y);
  expect(await page.locator("#root").getAttribute("inert")).toBe("");

  await page.goBack();
  await expect(page).toHaveURL(/#gallery$/);
  await expect(sheet(page)).toHaveCount(0);
  expect(await scrollY(page)).toBe(y);
  // A moment later it has still not moved: nothing restores or resets it late.
  await page.waitForTimeout(300);
  expect(await scrollY(page)).toBe(y);
  expect(await page.locator("#root").getAttribute("inert")).toBeNull();
  // Forward opens it again.
  await page.goForward();
  await expect(sheet(page)).toBeVisible();
  expect(await scrollY(page)).toBe(y);
});

test("the sheet is a dialog with a name; focus moves in and returns, and Escape closes it", async ({ page, browserName }) => {
  await openWith(page, defaultAppearance);
  const y = await scrollToOpener(page);
  await opener(page).focus();
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toHaveAttribute("aria-modal", "true");
  expect(await focused(page)).toBe("dialog:Sheet");
  // Tab stays in the sheet: Close, then the foot's button, and round again; the page under is inert.
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  const reached: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(tab);
    reached.push(await focused(page));
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]') || document.activeElement === document.body)).toBe(true);
  }
  expect(reached.filter((name) => name !== "body").slice(0, 2)).toEqual(["Close", "Done"]);

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#gallery$/);
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe("Sheet");
  expect(await scrollY(page)).toBe(y);
});

test("Close and the foot's button go back: the sheet's entry stays ahead and focus returns", async ({ page }) => {
  await openWith(page, defaultAppearance);
  const y = await scrollToOpener(page);
  const length = await page.evaluate(() => history.length);
  for (const name of ["Close", "Done"]) {
    await opener(page).click();
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole("button", { name, exact: true }).click();
    await expect(page).toHaveURL(/#gallery$/);
    await expect(sheet(page)).toHaveCount(0);
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    expect(await scrollY(page)).toBe(y);
    await expect.poll(() => focused(page)).toBe("Sheet");
  }
});

test("a reload on the sheet shows the sheet over its page, and Back then returns to the page's position", async ({ page }) => {
  await openWith(page, defaultAppearance);
  const y = await scrollToOpener(page);
  await opener(page).click();
  await expect(sheet(page)).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#gallery\/sheet$/);
  await expect(sheet(page)).toBeVisible();
  await expect(gallery(page)).toBeAttached();
  expect(await focused(page)).toBe("dialog:Sheet");
  await page.goBack();
  await expect(page).toHaveURL(/#gallery$/);
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => scrollY(page)).toBe(y);
});

test("a link straight to the sheet's address opens it over its page, and Close lands on that page", async ({ context }) => {
  // A new tab opened on the sheet's address: no entry of the app lies behind.
  const page = await context.newPage();
  await openWith(page, defaultAppearance, "/#gallery/sheet");
  await expect(sheet(page)).toBeVisible();
  await expect(gallery(page)).toBeAttached();
  const length = await page.evaluate(() => history.length);
  await sheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/#gallery$/);
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Gallery" })).toBeVisible();
  // The gallery took the sheet's entry: the app was not left and nothing was added.
  expect(await page.evaluate(() => history.length)).toBe(length);
  // Escape does the same.
  await page.goto("/#gallery/sheet");
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#gallery$/);
  await expect(sheet(page)).toHaveCount(0);
  await page.close();
});

/** The sheet's boxes and styles, read in the page in one go. */
function measure(page: Page) {
  return page.evaluate(() => {
    const probe = (property: "color" | "backgroundColor", value: string) => {
      const element = document.createElement("div");
      element.style[property] = value;
      document.body.append(element);
      const resolved = getComputedStyle(element)[property];
      element.remove();
      return resolved;
    };
    const box = (element: Element | Range) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const dialog = document.querySelector('[role="dialog"]')!;
    const head = dialog.querySelector(".part-sheet-head")!;
    const close = head.querySelector("button")!;
    const title = head.querySelector(".part-sheet-title")!;
    const body = dialog.querySelector(".part-sheet-body")!;
    const first = body.firstElementChild!;
    const done = dialog.querySelector(".part-sheet-foot .part-button")!;
    const titleStyle = getComputedStyle(title);
    const range = document.createRange();
    range.selectNodeContents(title);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      colours: {
        background: probe("backgroundColor", "var(--background)"),
        raised: probe("backgroundColor", "var(--raised)"),
        accent: probe("backgroundColor", "var(--accent)"),
        text: probe("color", "var(--text)"),
        muted: probe("color", "var(--muted)"),
      },
      sheet: { box: box(dialog), background: getComputedStyle(dialog).backgroundColor, colour: getComputedStyle(dialog).color },
      head: box(head),
      close: { box: box(close), radius: getComputedStyle(close).borderTopLeftRadius, background: getComputedStyle(close).backgroundColor },
      title: {
        text: box(range),
        colour: titleStyle.color,
        font: [titleStyle.fontSize, titleStyle.lineHeight, titleStyle.fontWeight, titleStyle.textTransform, titleStyle.letterSpacing],
      },
      first: box(first),
      done: { box: box(done), radius: getComputedStyle(done).borderTopLeftRadius, background: getComputedStyle(done).backgroundColor },
    };
  });
}

type Look = { name: string; appearance: Appearance };
const looks: Look[] = [
  ...presets.map((preset) => ({ name: preset, appearance: { ...defaultAppearance, preset } })),
  { name: "custom palette", appearance: { ...defaultAppearance, preset: "forest", accent: "#8fb8a0", colors: custom } },
  { name: "forest, compact", appearance: { ...defaultAppearance, preset: "forest", density: "compact" } },
];
const widths = [
  // The boards' phone (the Pixel profile of the phone projects keeps its own 412 by 839).
  { name: "phone", viewport: null, edge: 16 },
  // The desktop layout starts at 760.
  { name: "desktop", viewport: { width: 1280, height: 900 }, edge: 32 },
] as const;

for (const width of widths) {
  for (const look of looks) {
    test(`the sheet measures as the boards draw it: ${look.name}, ${width.name}`, async ({ page }) => {
      if (width.viewport) await page.setViewportSize(width.viewport);
      await openWith(page, look.appearance, "/#gallery/sheet");
      await expect(sheet(page)).toBeVisible();
      const m = await measure(page);
      const { edge } = width;
      if (!width.viewport) expect(m.viewport.width).toBeLessThanOrEqual(412);
      // The whole screen, in the ground colour with the text colour.
      expect(m.sheet.box).toMatchObject({ x: 0, y: 0, width: m.viewport.width, height: m.viewport.height });
      expect([m.sheet.background, m.sheet.colour]).toEqual([m.colours.background, m.colours.text]);
      // One column at the screen edge; on a desktop at most 640 wide, centred.
      const column = Math.min(640, m.viewport.width - 2 * edge);
      const left = (m.viewport.width - column) / 2;
      // The head: 44 high at the top edge; Close 44 by 44, corner 8, raised, on the column's left edge.
      expect(m.head).toMatchObject({ y: edge, height: 44 });
      expect(m.head.x).toBeCloseTo(left, 0);
      expect(m.head.width).toBeCloseTo(column, 0);
      expect(m.close.box).toMatchObject({ y: edge, width: 44, height: 44 });
      expect(m.close.box.x).toBeCloseTo(left, 0);
      expect([m.close.radius, m.close.background]).toEqual(["8px", m.colours.raised]);
      // The task's name in the Caption style, muted, centred in the head.
      expect(m.title.font).toEqual(["12px", "16px", "600", "uppercase", "0.96px"]);
      expect(m.title.colour).toBe(m.colours.muted);
      expect(m.title.text.x + m.title.text.width / 2).toBeCloseTo(left + column / 2, 0);
      // 16 under the head, the body starts on the column's edge.
      expect(m.first.y).toBeCloseTo(edge + 44 + 16, 0);
      expect(m.first.x).toBeCloseTo(left, 0);
      // The foot's one primary button: 44 high, corner 8, the column's width, at the bottom edge.
      expect(m.done.box.height).toBe(44);
      expect([m.done.radius, m.done.background]).toEqual(["8px", m.colours.accent]);
      expect(m.done.box.x).toBeCloseTo(left, 0);
      expect(m.done.box.width).toBeCloseTo(column, 0);
      expect(m.done.box.bottom).toBeCloseTo(m.viewport.height - edge, 0);
    });
  }
}
