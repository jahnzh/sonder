import { test, expect, type Page } from "@playwright/test";
import { defaultAppearance, paletteFor, type Appearance } from "../../src/appearance";

// The parts File row, Book row, Choice row and Steps on the gallery (#490; spec #480, "Parts"): every state measured
// in every theme preset, the custom palette and both densities, at a phone-sized window; their names and roles,
// touch targets, and a group of Choice rows from the keyboard.

type Look = { name: string; appearance: Appearance };
const presets = ["forest", "charcoal", "amoled", "contrast", "light", "system"] as const;
const custom = { background: "#202a33", surface: "#2b3844", text: "#f5efe0", muted: "#c2b8a3", border: "#56677a" };
const looks: Look[] = [];
for (const density of ["comfortable", "compact"] as const) {
  for (const preset of presets) looks.push({ name: `${preset}, ${density}`, appearance: { ...defaultAppearance, preset, density } });
  looks.push({
    name: `custom palette, ${density}`,
    appearance: { ...defaultAppearance, preset: "forest", accent: "#8fb8a0", colors: custom, density },
  });
}

const sections = ["file-row", "book-row", "choice-row", "steps"];
const mine = sections.map((id) => `[data-gallery-section="${id}"]`).join(", ");

// One server serves every spec of a run: each test leaves the stored appearance as it found it.
let before: Appearance | null = null;
test.beforeEach(async ({ page }) => {
  before = await (await page.request.get("/api/appearance")).json();
});
test.afterEach(async ({ page }) => {
  if (before) expect((await page.request.put("/api/appearance", { data: before })).ok()).toBe(true);
});

/** Opens the gallery with an appearance stored for the account, once the app shows that appearance. */
async function openWith(page: Page, appearance: Appearance) {
  expect((await page.request.put("/api/appearance", { data: appearance })).ok()).toBe(true);
  await page.goto("/#gallery");
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
  for (const id of sections) await expect(page.locator(`[data-gallery-section="${id}"]`)).toBeVisible();
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
      accentText: probe("color", "var(--accent)"),
      border: probe("backgroundColor", "var(--border)"),
      borderText: probe("color", "var(--border)"),
      text: probe("color", "var(--text)"),
      muted: probe("color", "var(--muted)"),
      transparent: probe("backgroundColor", "transparent"),
    };
    type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
    const box = (element: Element | null): Box | null => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const font = (element: Element | null) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return { size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight, colour: style.color };
    };
    const bar = (root: Element) => {
      const track = root.querySelector(".part-progress");
      if (!track) return null;
      const fill = track.querySelector(".part-progress-fill")!;
      return {
        box: box(track)!,
        fill: box(fill)!,
        radius: getComputedStyle(track).borderTopLeftRadius,
        track: getComputedStyle(track).backgroundColor,
        colour: getComputedStyle(fill).backgroundColor,
        hidden: track.getAttribute("aria-hidden"),
      };
    };
    const fileRows = [...document.querySelectorAll(".part-file-row")].map((row) => {
      const icon = row.querySelector(".part-file-row-icon")!;
      const end = row.querySelector(".part-file-row-end");
      return {
        kind: row.getAttribute("data-kind"),
        moving: row.hasAttribute("data-moving"),
        tag: row.tagName,
        box: box(row)!,
        icon: box(icon.querySelector("svg"))!,
        iconKind: icon.querySelector("svg")!.getAttribute("data-kind"),
        iconColour: getComputedStyle(icon).color,
        name: font(row.querySelector(".part-file-row-name")),
        status: font(row.querySelector(".part-file-row-status")),
        statusBox: box(row.querySelector(".part-file-row-status")),
        bar: bar(row),
        button: box(end?.querySelector(".part-button") ?? null),
        chevron: box(end?.querySelector(".part-chevron") ?? null),
      };
    });
    const bookRows = [...document.querySelectorAll(".part-book-row")].map((row) => {
      const cover = row.querySelector(".part-book-row-cover")!;
      const number = row.querySelector(".part-book-row-number");
      return {
        numbered: row.hasAttribute("data-numbered"),
        box: box(row)!,
        cover: box(cover)!,
        coverRadius: getComputedStyle(cover).borderTopLeftRadius,
        number: number ? { box: box(number)!, text: number.textContent, font: font(number) } : null,
        title: font(row.querySelector(".part-book-row-title")),
        status: font(row.querySelector(".part-book-row-line")),
        marks: [...row.querySelectorAll(".part-book-row-mark svg")].map((mark) => ({ name: mark.getAttribute("aria-label"), box: box(mark)! })),
        bar: bar(row),
        chevron: box(row.querySelector(".part-chevron")),
      };
    });
    const choiceGroups = [...document.querySelectorAll(".part-choice-group")].map((group) => {
      const style = getComputedStyle(group);
      const rows = [...group.children];
      return {
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
        background: style.backgroundColor,
        firstLine: getComputedStyle(rows[0]).borderTopWidth,
        lines: rows.slice(1).map((row) => ({ width: getComputedStyle(row).borderTopWidth, colour: getComputedStyle(row).borderTopColor })),
        rows: rows.map((row) => {
          const label = row.querySelector(".part-choice-row-label")!;
          const detail = row.querySelector(".part-choice-row-detail")!;
          const tick = row.querySelector(".part-choice-row-tick");
          return {
            checked: row.getAttribute("aria-checked"),
            box: box(row)!,
            // The row's own height, without the line above it.
            height: row.getBoundingClientRect().height - parseFloat(getComputedStyle(row).borderTopWidth),
            background: getComputedStyle(row).backgroundColor,
            label: { ...font(label)!, box: box(label)! },
            detail: { ...font(detail)!, box: box(detail)! },
            tick: tick ? { box: box(tick)!, colour: getComputedStyle(tick).color } : null,
          };
        }),
      };
    });
    const steps = [...document.querySelectorAll(".part-steps")].map((list) => {
      const style = getComputedStyle(list);
      const items = [...list.children];
      return {
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        steps: items.map((item, index) => {
          const mark = item.querySelector(".part-step-mark")!;
          const label = item.querySelector(".part-step-label")!;
          const dot = item.querySelector(".part-step-dot");
          const ring = item.querySelector(".part-step-ring");
          const tick = item.querySelector(".part-step-tick");
          return {
            state: item.getAttribute("data-state"),
            box: box(item)!,
            gapAbove: index ? item.getBoundingClientRect().top - items[index - 1].getBoundingClientRect().bottom : 0,
            borders: [getComputedStyle(item).borderTopWidth, getComputedStyle(item).borderBottomWidth],
            mark: { box: box(mark)!, name: mark.getAttribute("aria-label") },
            label: font(label),
            dot: dot ? { box: box(dot)!, colour: getComputedStyle(dot).backgroundColor } : null,
            ring: ring ? { box: box(ring)!, colour: getComputedStyle(ring).borderTopColor, width: getComputedStyle(ring).borderTopWidth } : null,
            tick: tick ? { box: box(tick)!, colour: getComputedStyle(tick).color } : null,
            bar: bar(item),
            value: font(item.querySelector(".part-step-value")),
          };
        }),
      };
    });
    return { colours, fileRows, bookRows, choiceGroups, steps, viewport: innerWidth };
  });
}

const rgb = (value: string) => value.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);

type Bar = { box: { x: number; width: number; height: number; bottom: number }; fill: { width: number }; radius: string; track: string; colour: string; hidden: string | null };
function expectBar(bar: Bar | null, row: { y: number; bottom: number }, colours: { accent: string; border: string }) {
  expect(bar).not.toBeNull();
  expect(bar!.box.height).toBe(4);
  expect(bar!.radius).toBe("999px");
  expect(bar!.colour).toBe(colours.accent);
  expect(bar!.track).toBe(colours.border);
  expect(bar!.hidden).toBe("true");
  expect(bar!.fill.width).toBeGreaterThan(0);
  expect(bar!.fill.width).toBeLessThan(bar!.box.width);
  // Inside the row's height: the bar does not make the row taller.
  expect(bar!.box.bottom).toBeLessThanOrEqual(row.bottom);
}

for (const look of looks) {
  test(`file, book and choice rows and steps measure as the spec says: ${look.name}`, async ({ page }) => {
    await openWith(page, look.appearance);
    const m = await measure(page);
    expect(m.viewport).toBeLessThanOrEqual(412);
    const c = m.colours;

    // File row: 64 high with its 20 px icon, name and status line, with and without the bar and the button.
    expect(new Set(m.fileRows.map((row) => row.kind))).toEqual(new Set(["audiobook", "ebook", "sync"]));
    const combos = new Set(m.fileRows.map((row) => `${row.moving ? "moving" : "still"}, ${row.button ? "button" : "no button"}`));
    expect([...combos].sort()).toEqual(["moving, button", "moving, no button", "still, button", "still, no button"]);
    for (const row of m.fileRows) {
      expect(row.box.height).toBe(64);
      expect([row.icon.width, row.icon.height]).toEqual([20, 20]);
      expect(row.icon.x - row.box.x).toBeCloseTo(16, 0);
      expect(row.iconKind).toBe(row.kind);
      expect(row.iconColour).toBe(c.muted);
      expect(row.name).toMatchObject({ size: "16px", lineHeight: "22px", colour: c.text });
      expect(row.status).toMatchObject({ size: "14px", lineHeight: "20px", colour: c.muted });
      expect(row.statusBox!.height).toBe(20);
      if (row.moving) expectBar(row.bar, row.box, c);
      else expect(row.bar).toBeNull();
      if (row.button) {
        expect(row.button.height).toBe(44);
        expect(row.box.right - row.button.right).toBeCloseTo(16, 0);
        expect(row.tag).toBe("DIV");
      } else {
        // A row without a button opens its page: one button with a chevron on the right edge.
        expect(row.tag).toBe("BUTTON");
        expect(row.box.right - row.chevron!.right).toBeCloseTo(16, 0);
      }
    }

    // Book row: a 40 cover with corner 8, title and status line; 64 high, 56 with a number in front.
    expect(m.bookRows.some((row) => row.numbered)).toBe(true);
    expect(m.bookRows.some((row) => !row.numbered)).toBe(true);
    expect(m.bookRows.some((row) => row.bar)).toBe(true);
    for (const row of m.bookRows) {
      expect(row.box.height).toBe(row.numbered ? 56 : 64);
      expect([row.cover.width, row.cover.height]).toEqual([40, 40]);
      expect(row.coverRadius).toBe("8px");
      expect(row.cover.y - row.box.y).toBeCloseTo((row.box.height - 40) / 2, 0);
      expect(row.title).toMatchObject({ size: "16px", lineHeight: "22px", weight: "500", colour: c.text });
      expect(row.status).toMatchObject({ size: "14px", lineHeight: "20px", colour: c.muted });
      for (const mark of row.marks) {
        expect([mark.box.width, mark.box.height]).toEqual([16, 16]);
        expect(["Audiobook", "Ebook", "Reading sync"]).toContain(mark.name);
      }
      if (row.numbered) {
        expect(row.number!.box.x - row.box.x).toBeCloseTo(16, 0);
        expect(row.number!.box.right).toBeLessThanOrEqual(row.cover.x);
        expect(row.number!.font).toMatchObject({ size: "14px", colour: c.muted });
      } else {
        expect(row.number).toBeNull();
        expect(row.cover.x - row.box.x).toBeCloseTo(16, 0);
      }
      if (row.bar) expectBar(row.bar, row.box, c);
      if (row.chevron) expect(row.box.right - row.chevron.right).toBeCloseTo(16, 0);
    }

    // Choice row: two lines; the chosen one has the raised fill and a tick on the right edge, the others neither.
    expect(m.choiceGroups.length).toBe(2);
    const checked = m.choiceGroups.flatMap((group) => group.rows).filter((row) => row.checked === "true");
    const unchecked = m.choiceGroups.flatMap((group) => group.rows).filter((row) => row.checked === "false");
    expect(checked.length).toBe(1);
    expect(unchecked.length).toBeGreaterThanOrEqual(3);
    for (const group of m.choiceGroups) {
      expect(group.radii).toEqual(["14px", "14px", "14px", "14px"]);
      expect(group.background).toBe(c.surface);
      expect(group.firstLine).toBe("0px");
      expect(group.lines.length).toBe(group.rows.length - 1);
      for (const line of group.lines) expect(line).toEqual({ width: "1px", colour: c.borderText });
      for (const row of group.rows) {
        expect(row.height).toBe(64);
        expect(row.label).toMatchObject({ size: "16px", lineHeight: "22px", colour: c.text });
        expect(row.detail).toMatchObject({ size: "14px", lineHeight: "20px", colour: c.muted });
        // Two lines: the detail under the label.
        expect(row.detail.box.y).toBeCloseTo(row.label.box.bottom, 0);
        expect(row.label.box.x - row.box.x).toBeCloseTo(16, 0);
        // The two lines stand in the middle of the row.
        expect(row.label.box.y - (row.box.bottom - row.height)).toBeCloseTo(11, 0);
      }
    }
    for (const row of checked) {
      expect(row.background).toBe(c.raised);
      expect(row.tick).not.toBeNull();
      expect([row.tick!.box.width, row.tick!.box.height]).toEqual([20, 20]);
      expect(row.box.right - row.tick!.box.right).toBeCloseTo(16, 0);
      expect(row.tick!.colour).toBe(c.accentText);
    }
    for (const row of unchecked) {
      expect(row.background).toBe(c.transparent);
      expect(row.tick).toBeNull();
    }

    // Steps: 36 high in each of its three states, no lines between them.
    const all = m.steps.flatMap((list) => list.steps);
    expect(new Set(all.map((step) => step.state))).toEqual(new Set(["done", "running", "waiting"]));
    for (const list of m.steps) {
      expect(list.radius).toBe("14px");
      expect(list.background).toBe(c.surface);
    }
    for (const step of all) {
      expect(step.box.height).toBe(36);
      expect(step.gapAbove).toBe(0);
      expect(step.borders).toEqual(["0px", "0px"]);
      expect([step.mark.box.width, step.mark.box.height]).toEqual([20, 20]);
      expect(step.mark.box.x - step.box.x).toBeCloseTo(16, 0);
      expect(step.label).toMatchObject({ size: "16px", lineHeight: "22px" });
      if (step.state === "done") {
        expect(step.mark.name).toBe("Done");
        expect(step.tick).not.toBeNull();
        // A green tick: green leads red and blue in every preset.
        const [r, g, b] = rgb(step.tick!.colour);
        expect(g).toBeGreaterThan(r);
        expect(g).toBeGreaterThan(b);
        expect(step.label!.colour).toBe(c.text);
        expect(Number(step.label!.weight)).toBe(400);
      }
      if (step.state === "running") {
        expect(step.mark.name).toBe("Running");
        expect(step.dot!.colour).toBe(c.accent);
        expect([step.dot!.box.width, step.dot!.box.height]).toEqual([10, 10]);
        expect(Number(step.label!.weight)).toBeGreaterThanOrEqual(600);
        expect(step.label!.colour).toBe(c.text);
        if (step.bar) expectBar(step.bar, step.box, c);
      }
      if (step.state === "waiting") {
        expect(step.mark.name).toBe("Not started");
        expect(step.ring).toMatchObject({ colour: c.muted, width: "2px" });
        expect([step.ring!.box.width, step.ring!.box.height]).toEqual([10, 10]);
        expect(step.label!.colour).toBe(c.muted);
        expect(step.bar).toBeNull();
      }
    }
    expect(all.some((step) => step.state === "running" && step.bar)).toBe(true);
  });
}

test("the rows and steps have names and roles, and every row is at least 44 where it is tapped", async ({ page }) => {
  await openWith(page, defaultAppearance);
  // File rows: one that opens is a button named by its name and status line; one with a button is a named item.
  await expect(page.getByRole("button", { name: "Ebook Matches the narration", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Audiobook Downloading to server · 43%", exact: true })).toBeVisible();
  const toGet = page.getByRole("listitem", { name: "Audiobook Not added", exact: true });
  await expect(toGet).toBeVisible();
  await expect(toGet.getByRole("button", { name: "Get an audiobook", exact: true })).toHaveText("Get");
  // Book rows: named by number, title, marks and status line.
  await expect(page.getByRole("button", { name: "1 Consider Phlebas Audiobook Ebook Finished", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Feral Gods Audiobook Ebook Chapter 3 · 5 h left", exact: true })).toBeVisible();
  await expect(page.getByRole("listitem", { name: "2.5 The State of the Art Not in your library", exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Series", exact: true }).getByRole("listitem")).toHaveCount(4);
  // Choice rows: a radio group named, its rows radios named by both lines, the chosen one checked.
  const recordings = page.getByRole("radiogroup", { name: "Recordings", exact: true });
  await expect(recordings.getByRole("radio")).toHaveCount(3);
  await expect(recordings.getByRole("radio", { name: "Narrator One English · 9 h 12 min · M4B", exact: true })).toBeChecked();
  await expect(recordings.getByRole("radio", { name: "Narrator Two English · 9 h 40 min · MP3", exact: true })).not.toBeChecked();
  const editions = page.getByRole("radiogroup", { name: "Editions", exact: true });
  for (const radio of await editions.getByRole("radio").all()) await expect(radio).not.toBeChecked();
  // Steps: an ordered list named for the work, each mark named by its state.
  const preparing = page.getByRole("list", { name: "Preparing", exact: true });
  await expect(preparing.getByRole("listitem")).toHaveCount(5);
  await expect(preparing.getByRole("img", { name: "Done", exact: true })).toHaveCount(2);
  await expect(preparing.getByRole("img", { name: "Running", exact: true })).toHaveCount(1);
  await expect(preparing.getByRole("img", { name: "Not started", exact: true })).toHaveCount(2);

  const report = await page.evaluate((selector) => {
    const roots = [...document.querySelectorAll(selector)];
    const tappable = roots.flatMap((root) => [...root.querySelectorAll("button, a, [tabindex], [role=radio]")]);
    const rows = roots.flatMap((root) => [...root.querySelectorAll(".part-file-row, .part-book-row, .part-choice-row")]);
    const name = (element: Element) =>
      (element.getAttribute("aria-labelledby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim() ||
      element.getAttribute("aria-label") ||
      (element as HTMLElement).innerText.trim();
    return {
      tappable: tappable.length,
      small: tappable.filter((element) => {
        const r = element.getBoundingClientRect();
        return r.width < 44 || r.height < 44;
      }).map((element) => element.outerHTML.slice(0, 80)),
      // A row is named by itself (a button, a radio) or by its item.
      unnamed: rows.filter((row) => !name(row.tagName === "DIV" ? row.parentElement! : row)).map((row) => row.outerHTML.slice(0, 80)),
      rows: rows.length,
    };
  }, mine);
  expect(report.tappable).toBeGreaterThanOrEqual(15);
  expect(report.rows).toBeGreaterThanOrEqual(20);
  expect(report.small).toEqual([]);
  expect(report.unnamed).toEqual([]);
});

test("a group of choice rows works from the keyboard and announces the chosen one", async ({ page, browserName }) => {
  await openWith(page, defaultAppearance);
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  const recordings = page.getByRole("radiogroup", { name: "Recordings", exact: true });
  const one = recordings.getByRole("radio", { name: /^Narrator One/ });
  const two = recordings.getByRole("radio", { name: /^Narrator Two/ });
  const three = recordings.getByRole("radio", { name: /^Narrator Three/ });

  // Tab reaches the chosen row of the group, and only that one.
  await page.locator('[data-sample="choice-row-chosen"] .gallery-state').click();
  await page.keyboard.press(tab);
  await expect(one).toBeFocused();
  await expect(two).toHaveAttribute("tabindex", "-1");
  // The arrow keys move to the next row and choose it, and go round at the ends.
  await page.keyboard.press("ArrowDown");
  await expect(two).toBeFocused();
  await expect(two).toBeChecked();
  await expect(one).not.toBeChecked();
  await expect(page.getByRole("status")).toHaveText("Narrator Two chosen");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(one).toBeFocused();
  await expect(one).toBeChecked();
  await page.keyboard.press("ArrowUp");
  await expect(three).toBeChecked();
  await page.keyboard.press("Home");
  await expect(one).toBeChecked();
  await page.keyboard.press("End");
  await expect(three).toBeChecked();
  await expect(three).toBeFocused();
  // The chosen row carries the raised fill and the tick.
  await expect(three.locator(".part-choice-row-tick")).toHaveCount(1);
  await expect(recordings.locator(".part-choice-row-tick")).toHaveCount(1);

  // Tab leaves the group in one step, into the next group, where none is chosen yet: it lands on the first row.
  await page.keyboard.press(tab);
  const editions = page.getByRole("radiogroup", { name: "Editions", exact: true });
  const epub = editions.getByRole("radio", { name: /^EPUB/ });
  await expect(epub).toBeFocused();
  await expect(epub).not.toBeChecked();
  // Space chooses the focused row; Enter too.
  await page.keyboard.press("Space");
  await expect(epub).toBeChecked();
  await expect(page.getByRole("status")).toHaveText("EPUB chosen");
  const pdf = editions.getByRole("radio", { name: /^PDF/ });
  await page.keyboard.press("ArrowRight");
  await expect(pdf).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(epub).toBeChecked();
  // Choosing in one group leaves the other as it was.
  await expect(three).toBeChecked();

  // A tap chooses too.
  await pdf.click();
  await expect(pdf).toBeChecked();
  await expect(epub).not.toBeChecked();
  await expect(page.getByRole("status")).toHaveText("PDF chosen");
});

test("every row that acts is reached by keyboard, in order, and acts on Enter", async ({ page, browserName }) => {
  await openWith(page, defaultAppearance);
  const expected = await page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)]
        .flatMap((root) => [...root.querySelectorAll<HTMLElement>("button:not(:disabled)")])
        .filter((element) => element.tabIndex >= 0)
        .map((element) => element.getAttribute("aria-label") ?? element.getAttribute("aria-labelledby") ?? element.innerText),
    mine,
  );
  // Six file rows that open and three Get buttons, seven book rows that open, one radio per choice group.
  expect(expected.length).toBe(18);
  // Start from the last part before these sections.
  await page.locator('[data-gallery-section="file-row"] .gallery-section-title').click();
  const reached: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    reached.push(
      await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        return element.getAttribute("aria-label") ?? element.getAttribute("aria-labelledby") ?? element.innerText;
      }),
    );
  }
  expect(reached).toEqual(expected);
  await page.getByRole("button", { name: "Reading sync Ready · estimated timings", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Reading sync pressed");
  await page.getByRole("button", { name: "Get an audiobook", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("status")).toHaveText("Get an audiobook pressed");
  await page.getByRole("button", { name: /^3 Use of Weapons/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Use of Weapons pressed");
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(ring).toBe("solid");
});
