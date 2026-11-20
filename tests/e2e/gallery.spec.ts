// @projects firefox, mobile-chrome, mobile-firefox, mobile-safari, mobile-iphone-slice13, mobile-iphone-slice14
import { test, expect, type Page } from "@playwright/test";
import { defaultAppearance, paletteFor, type Appearance } from "../../src/appearance";

// The parts gallery (#486; spec #480, "Tokens" and "Parts"): every part measured in every theme preset, the custom
// palette and both densities, at a phone-sized window; names, roles, keyboard and touch targets; and the Page
// header's back button on the gallery's child page.

type Look = { name: string; appearance: Appearance };
const presets = ["forest", "charcoal", "amoled", "contrast", "light", "system"] as const;
const custom = { background: "#202a33", surface: "#2b3844", text: "#f5efe0", muted: "#c2b8a3", border: "#56677a" };
const looks: Look[] = [];
for (const density of ["comfortable", "compact"] as const) {
  for (const preset of presets)
    looks.push({ name: `${preset}, ${density}`, appearance: { ...defaultAppearance, preset, density } });
  looks.push({
    name: `custom palette, ${density}`,
    appearance: { ...defaultAppearance, preset: "forest", accent: "#8fb8a0", colors: custom, density },
  });
}

// One server serves every spec of a run: each test leaves the stored appearance as it found it.
let before: Appearance | null = null;
test.beforeEach(async ({ page }) => {
  before = await (await page.request.get("/api/appearance")).json();
});
test.afterEach(async ({ page }) => {
  if (before) expect((await page.request.put("/api/appearance", { data: before })).ok()).toBe(true);
});

/** Opens the gallery with an appearance stored for the account, once the app shows that appearance. */
async function openWith(page: Page, appearance: Appearance, address = "/#gallery") {
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
  return palette;
}

/** Everything the measurements need, read in the page in one go. */
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
    const colours = {
      surface: probe("backgroundColor", "var(--surface)"),
      raised: probe("backgroundColor", "var(--raised)"),
      accent: probe("backgroundColor", "var(--accent)"),
      border: probe("color", "var(--border)"),
      text: probe("color", "var(--text)"),
      muted: probe("color", "var(--muted)"),
      onAccent: probe("color", "var(--on-accent)"),
      transparent: probe("backgroundColor", "transparent"),
    };
    const box = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const rows = [...document.querySelectorAll(".part-row")].map((row) => {
      const style = getComputedStyle(row);
      const label = row.querySelector(".part-row-label")!;
      // What stands on the right edge: the control when there is one, otherwise the value.
      const end = row.childElementCount > 1 ? row.lastElementChild : null;
      return {
        box: box(row),
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        label: box(label),
        labelFont: [getComputedStyle(label).fontSize, getComputedStyle(label).lineHeight],
        labelColour: getComputedStyle(label).color,
        end: end ? box(end) : null,
      };
    });
    const groups = [...document.querySelectorAll(".part-group")].map((group) => {
      const style = getComputedStyle(group);
      const items = [...group.children];
      return {
        radius: style.borderTopLeftRadius,
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
        background: style.backgroundColor,
        lines: items.slice(1).map((item, index) => {
          // Each item holds one row of whichever part (Row, File row, Book row).
          const previous = items[index].firstElementChild!.getBoundingClientRect();
          const row = item.firstElementChild!.getBoundingClientRect();
          const itemStyle = getComputedStyle(item);
          return { gap: row.top - previous.bottom, width: itemStyle.borderTopWidth, style: itemStyle.borderTopStyle, colour: itemStyle.borderTopColor };
        }),
        firstLine: getComputedStyle(items[0]).borderTopWidth,
      };
    });
    const buttons = [...document.querySelectorAll(".part-button")].map((button) => {
      const style = getComputedStyle(button);
      return {
        kind: button.getAttribute("data-kind"),
        box: box(button),
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        colour: style.color,
        font: [style.fontSize, style.lineHeight],
      };
    });
    const texts = Object.fromEntries(
      [...document.querySelectorAll("[data-text], .part-page-title")].map((element) => {
        const style = getComputedStyle(element);
        return [
          element.getAttribute("data-text") ?? "page-title",
          {
            family: style.fontFamily,
            weight: style.fontWeight,
            size: style.fontSize,
            lineHeight: style.lineHeight,
            transform: style.textTransform,
            tracking: style.letterSpacing,
            height: element.getBoundingClientRect().height,
          },
        ];
      }),
    );
    return { colours, rows, groups, buttons, texts, viewport: innerWidth };
  });
}

const textSpec = {
  title: { family: /Manrope/, weight: "700", size: "28px", lineHeight: "34px", transform: "none", tracking: "normal" },
  heading: { family: /Manrope/, weight: "700", size: "20px", lineHeight: "26px", transform: "none", tracking: "normal" },
  body: { family: /DM Sans/, weight: "400", size: "16px", lineHeight: "22px", transform: "none", tracking: "normal" },
  label: { family: /DM Sans/, weight: "500", size: "14px", lineHeight: "20px", transform: "none", tracking: "normal" },
  // 0.08em of 12 px.
  caption: { family: /DM Sans/, weight: "600", size: "12px", lineHeight: "16px", transform: "uppercase", tracking: "0.96px" },
} as const;

for (const look of looks) {
  test(`the parts measure as the tokens say: ${look.name}`, async ({ page }) => {
    await openWith(page, look.appearance);
    const m = await measure(page);
    expect(m.viewport).toBeLessThanOrEqual(412);

    // Row: 52 high, 16 inset, label on the left edge and its value or control on the right edge.
    expect(m.rows.length).toBeGreaterThanOrEqual(10);
    for (const row of m.rows) {
      expect(row.box.height).toBe(52);
      expect([row.paddingLeft, row.paddingRight]).toEqual(["16px", "16px"]);
      expect(row.label.x - row.box.x).toBeCloseTo(16, 0);
      expect(row.labelFont).toEqual(["16px", "22px"]);
      expect(row.labelColour).toBe(m.colours.text);
      if (row.end) expect(row.box.right - row.end.right).toBeCloseTo(16, 0);
    }

    // Group: a surface card with corner 14 and a 1 px line in the line colour between rows, none above the first.
    expect(m.groups.length).toBeGreaterThanOrEqual(8);
    let lines = 0;
    for (const group of m.groups) {
      expect(group.radii).toEqual(["14px", "14px", "14px", "14px"]);
      expect(group.background).toBe(m.colours.surface);
      expect(group.firstLine).toBe("0px");
      for (const line of group.lines) {
        expect(line).toEqual({ gap: 1, width: "1px", style: "solid", colour: m.colours.border });
        lines++;
      }
    }
    expect(lines).toBeGreaterThanOrEqual(3);

    // Button: 44 high, corner 8, Label size, in its three kinds with their fills.
    const kinds = new Set(m.buttons.map((b) => b.kind));
    expect([...kinds].sort()).toEqual(["primary", "quiet", "secondary"]);
    for (const button of m.buttons) {
      expect(button.box.height).toBe(44);
      expect(button.box.width).toBeGreaterThanOrEqual(44);
      expect(button.radius).toBe("8px");
      expect(button.font).toEqual(["14px", "20px"]);
      if (button.kind === "primary") expect([button.background, button.colour]).toEqual([m.colours.accent, m.colours.onAccent]);
      if (button.kind === "secondary") expect([button.background, button.colour]).toEqual([m.colours.raised, m.colours.text]);
      if (button.kind === "quiet") expect([button.background, button.colour]).toEqual([m.colours.transparent, m.colours.text]);
    }

    // The five text styles, and the page's Title in the Title style.
    for (const [name, spec] of Object.entries(textSpec)) {
      const text = m.texts[name];
      expect(text, name).toBeTruthy();
      expect(text.family, name).toMatch(spec.family);
      expect([text.weight, text.size, text.lineHeight, text.transform, text.tracking], name).toEqual([
        spec.weight,
        spec.size,
        spec.lineHeight,
        spec.transform,
        spec.tracking,
      ]);
      expect(text.height, name).toBe(Number.parseInt(spec.lineHeight));
    }
    expect(m.texts["page-title"]).toMatchObject({ size: "28px", lineHeight: "34px", weight: "700" });
  });
}

test("the parts take the palette's colours: a custom palette colours them", async ({ page }) => {
  const appearance = looks.find((look) => look.name === "custom palette, comfortable")!.appearance;
  await openWith(page, appearance);
  const hex = (value: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)).join(", ")})`;
  const m = await measure(page);
  expect(m.colours.surface).toBe(hex(custom.surface));
  expect(m.groups[0].background).toBe(hex(custom.surface));
  expect(m.groups.find((g) => g.lines.length)!.lines[0].colour).toBe(hex(custom.border));
  expect(m.buttons.find((b) => b.kind === "primary")!.background).toBe(hex("#8fb8a0"));
});

test("every part has a name and a role, and every control is at least 44 where it is tapped", async ({ page }) => {
  await openWith(page, defaultAppearance);
  await expect(page.getByRole("heading", { level: 1, name: "Gallery" })).toBeVisible();
  // Groups are lists named by their caption, or by their label when they show none.
  await expect(page.getByRole("list", { name: "Playback", exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Account", exact: true })).toBeVisible();
  // A row that shows a value is an item named by its label and value; one that acts is a button.
  await expect(page.getByRole("listitem", { name: "Plays from Server copy" }).first()).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Version 1.0" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Appearance Forest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark as finished" })).toBeVisible();
  await expect(page.getByRole("button", { name: "AudiobookDB Not connected" })).toBeDisabled();
  await expect(page.getByRole("listitem", { name: "Ebook Not added" }).getByRole("button", { name: "Get" })).toBeVisible();
  // Buttons, in their kinds; one that shows only its icon is named.
  for (const name of ["Listen", "Read", "Cancel"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(3);
    await expect(page.getByRole("button", { name: `${name} (icon only)`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Child page", exact: true })).toBeVisible();

  // Nothing in the gallery that can be tapped is below 44 in either direction, and every part is named.
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("main button, main a, main [tabindex]")]
      .filter((element) => {
        const r = element.getBoundingClientRect();
        return r.width < 44 || r.height < 44;
      })
      .map((element) => element.outerHTML.slice(0, 80)),
  );
  expect(small).toEqual([]);
  for (const button of await page.locator("main button").all()) expect((await button.getAttribute("aria-label")) ?? (await button.innerText())).not.toBe("");
});

test("every part is reachable by keyboard, in order, and acts on Enter and Space", async ({ page, browserName }) => {
  await openWith(page, defaultAppearance);
  // The parts of #486, which stand first on the gallery; later parts' sections test their own keyboard use.
  const expected = await page.evaluate(() =>
    [...document.querySelectorAll(["row", "group", "button", "page-header"].map((id) => `[data-gallery-section="${id}"] button:not(:disabled)`).join(", "))].map((element) => element.getAttribute("aria-label") ?? (element as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
  );
  expect(expected.length).toBeGreaterThanOrEqual(17);
  await page.locator("main").click({ position: { x: 2, y: 2 } });
  const reached: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    reached.push(
      await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        return element.getAttribute("aria-label") ?? element.innerText.replace(/\s+/g, " ").trim();
      }),
    );
  }
  expect(reached).toEqual(expected);
  // A row acts on Enter, a button on Space.
  await page.getByRole("button", { name: "Appearance Forest" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Appearance pressed");
  await page.getByRole("button", { name: "Read", exact: true }).first().focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("status")).toHaveText("Read pressed");
  // The focused part shows it.
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(ring).toBe("solid");
});

test("the child page's back button goes back when opened from the gallery, and is named for where it goes", async ({ page }) => {
  await openWith(page, defaultAppearance);
  await page.getByRole("button", { name: "Child page", exact: true }).click();
  await expect(page).toHaveURL(/#gallery\/child$/);
  await expect(page.getByRole("heading", { level: 1, name: "Child page" })).toBeVisible();
  const back = page.getByRole("button", { name: "Back to Gallery", exact: true });
  await expect(back).toBeVisible();
  // One Title on the page, after the back button, both in a 44 header.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  expect((await back.boundingBox())!).toMatchObject({ width: 44, height: 44 });
  const length = await page.evaluate(() => history.length);
  await back.click();
  await expect(page).toHaveURL(/#gallery$/);
  await expect(page.getByRole("heading", { level: 1, name: "Gallery" })).toBeVisible();
  // It went back in history: the child page is ahead, for Forward, and nothing was added.
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goForward();
  await expect(page).toHaveURL(/#gallery\/child$/);
  // From the keyboard too.
  await page.getByRole("button", { name: "Back to Gallery", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#gallery$/);
});

test("the child page's back button goes to the gallery when the page was opened by a link", async ({ context }) => {
  // A new tab opened on the child page's address: no entry of the app lies behind.
  const page = await context.newPage();
  await openWith(page, defaultAppearance, "/#gallery/child");
  await expect(page.getByRole("heading", { level: 1, name: "Child page" })).toBeVisible();
  // Firefox replaces the new tab's blank entry, Chromium keeps it: count from what the tab holds now.
  const length = await page.evaluate(() => history.length);
  const back = page.getByRole("button", { name: "Back to Gallery", exact: true });
  await back.click();
  await expect(page).toHaveURL(/#gallery$/);
  await expect(page.getByRole("heading", { level: 1, name: "Gallery" })).toBeVisible();
  // The gallery took the child page's entry: the app was not left and nothing was added.
  expect(await page.evaluate(() => history.length)).toBe(length);
  await expect(page.getByRole("button", { name: "Child page", exact: true })).toBeVisible();
  await page.close();
});

test("a reload keeps the child page and where its back button goes", async ({ page }) => {
  await openWith(page, defaultAppearance);
  await page.getByRole("button", { name: "Child page", exact: true }).click();
  await expect(page).toHaveURL(/#gallery\/child$/);
  await page.reload();
  const back = page.getByRole("button", { name: "Back to Gallery", exact: true });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/#gallery$/);
  await page.goForward();
  await expect(page).toHaveURL(/#gallery\/child$/);
});

test("nothing in the app links to the gallery", async ({ page }) => {
  await page.goto("/#library");
  await expect(page.getByRole("navigation", { name: "Main", exact: true })).toBeVisible();
  for (const address of ["#library", "#discover", "#settings"]) {
    await page.goto(`/${address}`);
    await expect(page.getByRole("navigation", { name: "Main", exact: true })).toBeVisible();
    expect(await page.locator('a[href*="gallery"]').count()).toBe(0);
    await expect(page.getByText("Gallery", { exact: true })).toHaveCount(0);
  }
});
