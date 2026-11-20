// @projects firefox, mobile-chrome, mobile-firefox, mobile-safari, mobile-iphone-slice14
import { test, expect, type Page } from "@playwright/test";
import { defaultAppearance, paletteFor, type Appearance } from "../../src/appearance";

// The gallery's controls (#489; spec #480, "Parts"): Chip, Segmented control, Switch and Stepper measured in every
// state, in every theme preset, the custom palette and both densities, at a phone-sized window; their names, roles
// and announced states; the keyboard; and a touch target of at least 44 for each. The looks and openWith are the
// ones of tests/e2e/gallery.spec.ts (a spec file is not imported, or its tests would run twice).

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
  await expect(page.locator('[data-gallery-section="stepper"]')).toBeVisible();
}

const sections = ["chip", "segmented", "switch", "stepper"] as const;

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
      background: probe("backgroundColor", "var(--background)"),
      raised: probe("backgroundColor", "var(--raised)"),
      accent: probe("backgroundColor", "var(--accent)"),
      line: probe("backgroundColor", "var(--border)"),
      text: probe("color", "var(--text)"),
      textFill: probe("backgroundColor", "var(--text)"),
      backgroundText: probe("color", "var(--background)"),
      muted: probe("color", "var(--muted)"),
      onAccent: probe("backgroundColor", "var(--on-accent)"),
      knobOff: probe("backgroundColor", "var(--text)"),
    };
    const box = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const px = (value: string) => Number.parseFloat(value);
    const sample = (element: Element) => element.closest("[data-sample]")!.getAttribute("data-sample");
    const chips = [...document.querySelectorAll(".part-chip")].map((chip) => {
      const style = getComputedStyle(chip);
      return {
        sample: sample(chip),
        box: box(chip),
        radius: px(style.borderTopLeftRadius),
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
        background: style.backgroundColor,
        colour: style.color,
        font: [style.fontSize, style.lineHeight, style.fontWeight],
        pressed: chip.getAttribute("aria-pressed"),
        disabled: (chip as HTMLButtonElement).disabled,
      };
    });
    const segmented = [...document.querySelectorAll(".part-segmented")].map((control) => {
      const style = getComputedStyle(control);
      const track = box(control);
      return {
        sample: sample(control),
        box: track,
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        disabled: control.getAttribute("aria-disabled") === "true",
        segments: [...control.querySelectorAll(".part-segment")].map((segment) => {
          const face = segment.querySelector(".part-segment-face")!;
          const faceStyle = getComputedStyle(face);
          const faceBox = box(face);
          return {
            box: box(segment),
            checked: segment.getAttribute("aria-checked"),
            disabled: (segment as HTMLButtonElement).disabled,
            faceInset: [faceBox.y - track.y, track.bottom - faceBox.bottom],
            faceBackground: faceStyle.backgroundColor,
            colour: getComputedStyle(segment).color,
            font: [faceStyle.fontSize, faceStyle.lineHeight, faceStyle.fontWeight],
          };
        }),
      };
    });
    const switches = [...document.querySelectorAll(".part-switch")].map((button) => {
      const track = button.querySelector(".part-switch-track")!;
      const knob = button.querySelector(".part-switch-knob")!;
      const trackStyle = getComputedStyle(track);
      return {
        sample: sample(button),
        box: box(button),
        track: box(track),
        knob: box(knob),
        trackRadius: px(trackStyle.borderTopLeftRadius),
        trackBackground: trackStyle.backgroundColor,
        knobBackground: getComputedStyle(knob).backgroundColor,
        checked: button.getAttribute("aria-checked"),
        disabled: (button as HTMLButtonElement).disabled,
      };
    });
    const steppers = [...document.querySelectorAll(".part-stepper")].map((stepper) => {
      const [minus, plus] = [...stepper.querySelectorAll(".part-stepper-button")] as HTMLButtonElement[];
      const value = stepper.querySelector('[role="spinbutton"]')!;
      const buttonStyle = getComputedStyle(minus);
      return {
        sample: sample(stepper),
        box: box(stepper),
        minus: box(minus),
        plus: box(plus),
        value: box(value),
        buttonRadius: buttonStyle.borderTopLeftRadius,
        buttonBackground: buttonStyle.backgroundColor,
        valueFont: [getComputedStyle(value).fontSize, getComputedStyle(value).lineHeight],
        minusDisabled: minus.disabled,
        plusDisabled: plus.disabled,
        now: Number(value.getAttribute("aria-valuenow")),
        min: Number(value.getAttribute("aria-valuemin")),
        max: Number(value.getAttribute("aria-valuemax")),
        valueDisabled: value.getAttribute("aria-disabled") === "true",
        valueOrderMiddle: box(minus).right <= box(value).x && box(value).right <= box(plus).x,
      };
    });
    return { colours, chips, segmented, switches, steppers, viewport: innerWidth };
  });
}

for (const look of looks) {
  test(`the controls measure as the spec says in every state: ${look.name}`, async ({ page }) => {
    await openWith(page, look.appearance);
    const m = await measure(page);
    expect(m.viewport).toBeLessThanOrEqual(412);

    // Chip: round, 44 high, Label text; selected in the text colour with the ground colour as its text, not selected
    // on the raised fill; both also disabled.
    expect(m.chips.filter((c) => c.pressed === "true" && !c.disabled).length).toBeGreaterThanOrEqual(2);
    expect(m.chips.filter((c) => c.pressed === "false" && !c.disabled).length).toBeGreaterThanOrEqual(2);
    expect(m.chips.filter((c) => c.disabled).map((c) => c.pressed).sort()).toEqual(["false", "true"]);
    for (const chip of m.chips) {
      expect(chip.box.height).toBe(44);
      expect(chip.box.width).toBeGreaterThanOrEqual(44);
      // Round: every corner at least half the height, so the ends are half circles.
      expect(chip.radius).toBeGreaterThanOrEqual(chip.box.height / 2);
      expect(new Set(chip.radii).size).toBe(1);
      expect(chip.font.slice(0, 2)).toEqual(["14px", "20px"]);
      if (chip.pressed === "true") expect([chip.background, chip.colour, chip.font[2]]).toEqual([m.colours.textFill, m.colours.backgroundText, "600"]);
      else expect([chip.background, chip.colour, chip.font[2]]).toEqual([m.colours.raised, m.colours.text, "500"]);
    }

    // Segmented control: 44 high on the raised fill with corner 8, one segment chosen; each segment 44 high where it is
    // tapped, the chosen one drawn 4 inside on the ground colour, its text bold.
    expect(m.segmented.length).toBeGreaterThanOrEqual(4);
    expect(m.segmented.some((s) => s.disabled)).toBe(true);
    expect(m.segmented.some((s) => s.segments.length === 3)).toBe(true);
    for (const control of m.segmented) {
      expect(control.box.height).toBe(44);
      expect(control.radius).toBe("8px");
      expect(control.background).toBe(m.colours.raised);
      expect(control.segments.filter((s) => s.checked === "true").length).toBe(1);
      for (const segment of control.segments) {
        expect(segment.box.height).toBe(44);
        expect(segment.box.width).toBeGreaterThanOrEqual(44);
        expect(segment.disabled).toBe(control.disabled);
        expect(segment.font.slice(0, 2)).toEqual(["14px", "20px"]);
        if (segment.checked === "true") {
          expect(segment.faceInset).toEqual([4, 4]);
          expect([segment.faceBackground, segment.colour, segment.font[2]]).toEqual([m.colours.background, m.colours.text, "600"]);
        } else {
          expect(segment.faceBackground).toBe("rgba(0, 0, 0, 0)");
          expect([segment.colour, segment.font[2]]).toEqual([m.colours.muted, "500"]);
        }
      }
    }
    expect(m.segmented.map((s) => s.segments.findIndex((x) => x.checked === "true"))).toContain(0);
    expect(m.segmented.some((s) => s.segments.findIndex((x) => x.checked === "true") === s.segments.length - 1)).toBe(true);

    // Switch: 52 by 32, round, the 24 knob 4 inside it; on: on the accent, knob on the right; off: on the line colour,
    // knob on the left. The button around it is 44 high where it is tapped.
    const states = m.switches.map((s) => `${s.checked}${s.disabled ? " disabled" : ""}`).sort();
    expect(states).toEqual(["false", "false disabled", "true", "true disabled"]);
    for (const sw of m.switches) {
      expect([sw.track.width, sw.track.height]).toEqual([52, 32]);
      expect(sw.trackRadius).toBeGreaterThanOrEqual(16);
      expect([sw.knob.width, sw.knob.height]).toEqual([24, 24]);
      expect(sw.knob.y - sw.track.y).toBe(4);
      expect(sw.box.width).toBeGreaterThanOrEqual(44);
      expect(sw.box.height).toBeGreaterThanOrEqual(44);
      if (sw.checked === "true") {
        expect(sw.track.right - sw.knob.right).toBe(4);
        expect([sw.trackBackground, sw.knobBackground]).toEqual([m.colours.accent, m.colours.onAccent]);
      } else {
        expect(sw.knob.x - sw.track.x).toBe(4);
        expect([sw.trackBackground, sw.knobBackground]).toEqual([m.colours.line, m.colours.knobOff]);
      }
    }

    // Stepper: 44 high, the value between a minus and a plus that are 44 by 44 on the raised fill with corner 8. At
    // its smallest the minus is disabled, at its largest the plus; disabled, both and the value are.
    const bySample = Object.fromEntries(m.steppers.map((s) => [s.sample, s]));
    expect(Object.keys(bySample).sort()).toEqual(["stepper-between", "stepper-disabled", "stepper-max", "stepper-min"]);
    for (const stepper of m.steppers) {
      expect(stepper.box.height).toBe(44);
      expect([stepper.minus.width, stepper.minus.height, stepper.plus.width, stepper.plus.height]).toEqual([44, 44, 44, 44]);
      expect(stepper.value.height).toBe(44);
      expect(stepper.value.width).toBeGreaterThanOrEqual(44);
      expect(stepper.valueOrderMiddle).toBe(true);
      expect([stepper.buttonRadius, stepper.buttonBackground]).toEqual(["8px", m.colours.raised]);
      expect(stepper.valueFont).toEqual(["14px", "20px"]);
    }
    expect(bySample["stepper-between"]).toMatchObject({ minusDisabled: false, plusDisabled: false, valueDisabled: false });
    expect(bySample["stepper-min"]).toMatchObject({ minusDisabled: true, plusDisabled: false, valueDisabled: false });
    expect(bySample["stepper-min"].now).toBe(bySample["stepper-min"].min);
    expect(bySample["stepper-max"]).toMatchObject({ minusDisabled: false, plusDisabled: true, valueDisabled: false });
    expect(bySample["stepper-max"].now).toBe(bySample["stepper-max"].max);
    expect(bySample["stepper-disabled"]).toMatchObject({ minusDisabled: true, plusDisabled: true, valueDisabled: true });
  });
}

test("each control has a name, a role and an announced state, and is at least 44 where it is tapped", async ({ page }) => {
  await openWith(page, defaultAppearance);
  // Chip: a toggle button, named by its text.
  await expect(page.getByRole("button", { name: "Series", exact: true, pressed: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "On device", exact: true, pressed: false })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Not started", exact: true, pressed: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Shelf", exact: true, pressed: false })).toBeDisabled();
  const filters = page.getByRole("group", { name: "Filter your library" });
  await expect(filters.getByRole("button", { pressed: true })).toHaveText(["All"]);
  // Segmented control: a radio group named for what it chooses, one radio checked.
  const mode = page.getByRole("radiogroup", { name: "Reading mode", exact: true });
  await expect(mode.getByRole("radio")).toHaveText(["Pages", "Scroll"]);
  await expect(mode.getByRole("radio", { name: "Pages", checked: true })).toBeVisible();
  await expect(mode.getByRole("radio", { name: "Scroll", checked: false })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Progress bar shows" }).getByRole("radio", { checked: true })).toHaveText("Current chapter");
  await expect(page.getByRole("radiogroup", { name: "Activity" }).getByRole("radio", { checked: true })).toHaveText("This device");
  const off = page.getByRole("radiogroup", { name: "Reading mode (disabled)" });
  await expect(off).toHaveAttribute("aria-disabled", "true");
  for (const radio of await off.getByRole("radio").all()) await expect(radio).toBeDisabled();
  await expect(off.getByRole("radio", { checked: true })).toHaveText("Scroll");
  // Switch: the switch role, named for what it switches, checked or not.
  await expect(page.getByRole("switch", { name: "Follow the narration", checked: true })).toBeEnabled();
  await expect(page.getByRole("switch", { name: "Keep on this device", checked: false })).toBeEnabled();
  await expect(page.getByRole("switch", { name: "Start new reading sync work", checked: true })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Start new series searches", checked: false })).toBeDisabled();
  // The row that holds a switch is named by its label.
  await expect(page.getByRole("listitem", { name: "Follow the narration" }).getByRole("switch")).toHaveCount(1);
  // Stepper: a spin button with its value, its ends and the value as it is shown; a minus and a plus named for what
  // they do.
  const speed = page.getByRole("spinbutton", { name: "Speed", exact: true });
  await expect(speed).toHaveAttribute("aria-valuenow", "1.2");
  await expect(speed).toHaveAttribute("aria-valuetext", "1.2×");
  await expect(speed).toHaveAttribute("aria-valuemin", "0.5");
  await expect(speed).toHaveAttribute("aria-valuemax", "3");
  await expect(speed).toHaveText("1.2×");
  await expect(page.getByRole("button", { name: "Slower (Speed)", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Faster (Speed)", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Slower (Slowest speed)" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Faster (Fastest speed)" })).toBeDisabled();
  await expect(page.getByRole("spinbutton", { name: "Speed (disabled)" })).toHaveAttribute("aria-disabled", "true");

  // Nothing in these sections that can be tapped is below 44 in either direction, and everything is named.
  const found = await page.evaluate((ids) => {
    const elements = ids.flatMap((id) => [...document.querySelectorAll(`[data-gallery-section="${id}"] :is(button, a, [tabindex], [role="spinbutton"])`)]);
    return {
      count: elements.length,
      small: elements
        .filter((element) => {
          const r = element.getBoundingClientRect();
          return r.width < 44 || r.height < 44;
        })
        .map((element) => element.outerHTML.slice(0, 80)),
      unnamed: elements.filter((element) => !(element.getAttribute("aria-label") ?? (element as HTMLElement).innerText).trim()).map((element) => element.outerHTML.slice(0, 80)),
    };
  }, [...sections]);
  expect(found.count).toBeGreaterThanOrEqual(30);
  expect(found.small).toEqual([]);
  expect(found.unnamed).toEqual([]);
});

/** The name of the focused element, as the tests read it. */
function focused(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    return `${element.getAttribute("role") ?? element.tagName.toLowerCase()}:${element.getAttribute("aria-label") ?? element.innerText.trim()}`;
  });
}

test("Tab reaches every enabled control once, in order: a chip each, the chosen segment, a switch each, the stepper's value", async ({ page, browserName }) => {
  await openWith(page, defaultAppearance);
  // Each of the controls' own sections, walked on its own: other sections (the rows, the steps) sit between them on
  // the page, so the walk starts at a section's first control and stops when focus leaves the section.
  const expected = {
    chip: ["button:Series", "button:On device", "button:All", "button:In progress", "button:Finished", "button:Favorites"],
    segmented: ["radio:Pages", "radio:Current chapter", "radio:This device"],
    switch: ["switch:Follow the narration", "switch:Keep on this device"],
    stepper: ["spinbutton:Speed", "spinbutton:Slowest speed", "spinbutton:Fastest speed"],
  } as const;
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  for (const [id, names] of Object.entries(expected)) {
    const section = page.locator(`[data-gallery-section="${id}"]`);
    const tabbable = await section.evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")].filter((element) => element.tabIndex >= 0 && !element.matches(":disabled")).length,
    );
    // Every enabled control of the section is in the list: the first by its name, the rest by Tab (the segmented
    // control is one stop per group, for its chosen segment).
    expect(tabbable, id).toBe(names.length);
    await section.locator("button, [role=radio], [role=switch], [role=spinbutton]").evaluateAll((elements, name) => {
      const first = elements.find((element) => element.tabIndex >= 0) as HTMLElement;
      first.focus();
      return name;
    }, id);
    const reached = [await focused(page)];
    for (let i = 1; i < names.length; i++) {
      await page.keyboard.press(tab);
      reached.push(await focused(page));
    }
    expect(reached, id).toEqual([...names]);
    // One more Tab leaves the section.
    await page.keyboard.press(tab);
    expect(await section.evaluate((root) => root.contains(document.activeElement)), `${id}: Tab leaves`).toBe(false);
  }
  // Each shows it has the focus, once reached from the keyboard: the ring is on the chip, on the segment's face, on
  // the switch's track and on the stepper's value.
  const rings = [
    [page.getByRole("button", { name: "Series", exact: true }), ""],
    [page.getByRole("radiogroup", { name: "Reading mode", exact: true }).getByRole("radio", { name: "Pages" }), ".part-segment-face"],
    [page.getByRole("switch", { name: "Follow the narration" }), ".part-switch-track"],
    [page.getByRole("spinbutton", { name: "Speed", exact: true }), ""],
  ] as const;
  for (const [control, inner] of rings) {
    await control.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(control).toBeFocused();
    const ring = await control.evaluate((element, selector) => getComputedStyle(selector ? element.querySelector(selector)! : element).outlineStyle, inner);
    expect(ring).toBe("solid");
  }
});

test("a chip toggles on Space and Enter, and on a tap", async ({ page }) => {
  await openWith(page, defaultAppearance);
  const chip = page.getByRole("button", { name: "On device", exact: true });
  await chip.focus();
  await page.keyboard.press("Space");
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status")).toHaveText("On device selected");
  await page.keyboard.press("Enter");
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status")).toHaveText("On device not selected");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  // In a row of filters, the one tapped is the one selected.
  const filters = page.getByRole("group", { name: "Filter your library" });
  await filters.getByRole("button", { name: "Finished" }).click();
  await expect(filters.getByRole("button", { pressed: true })).toHaveText(["Finished"]);
  // A disabled chip does not change.
  const disabled = page.getByRole("button", { name: "Shelf", exact: true });
  await disabled.click({ force: true });
  await expect(disabled).toHaveAttribute("aria-pressed", "false");
});

test("a segmented control moves its choice with the arrows, Home and End, and on a tap", async ({ page }) => {
  await openWith(page, defaultAppearance);
  const mode = page.getByRole("radiogroup", { name: "Reading mode", exact: true });
  const pages = mode.getByRole("radio", { name: "Pages" });
  const scroll = mode.getByRole("radio", { name: "Scroll" });
  await pages.focus();
  await page.keyboard.press("ArrowRight");
  await expect(scroll).toHaveAttribute("aria-checked", "true");
  await expect(pages).toHaveAttribute("aria-checked", "false");
  await expect(scroll).toBeFocused();
  await expect(page.getByRole("status")).toHaveText("Reading mode: Scroll");
  // The chosen segment is the one Tab reaches.
  await expect(scroll).toHaveAttribute("tabindex", "0");
  await expect(pages).toHaveAttribute("tabindex", "-1");
  // The arrows wrap at the ends.
  await page.keyboard.press("ArrowRight");
  await expect(pages).toHaveAttribute("aria-checked", "true");
  await expect(pages).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(scroll).toHaveAttribute("aria-checked", "true");
  // Three segments: Home and End, Up and Down.
  const activity = page.getByRole("radiogroup", { name: "Activity" });
  await activity.getByRole("radio", { name: "This device" }).focus();
  await page.keyboard.press("End");
  await expect(activity.getByRole("radio", { checked: true })).toHaveText("Server");
  await page.keyboard.press("Home");
  await expect(activity.getByRole("radio", { checked: true })).toHaveText("Now");
  await page.keyboard.press("ArrowDown");
  await expect(activity.getByRole("radio", { checked: true })).toHaveText("This device");
  await page.keyboard.press("ArrowUp");
  await expect(activity.getByRole("radio", { checked: true })).toHaveText("Now");
  // A tap chooses.
  await activity.getByRole("radio", { name: "Server" }).click();
  await expect(activity.getByRole("radio", { checked: true })).toHaveText("Server");
  await expect(page.getByRole("status")).toHaveText("Activity: Server");
  // The disabled one does not change.
  const off = page.getByRole("radiogroup", { name: "Reading mode (disabled)" });
  await off.getByRole("radio", { name: "Pages" }).click({ force: true });
  await expect(off.getByRole("radio", { checked: true })).toHaveText("Scroll");
});

test("a switch turns on and off on Space and Enter, and on a tap", async ({ page }) => {
  await openWith(page, defaultAppearance);
  const sw = page.getByRole("switch", { name: "Follow the narration" });
  await sw.focus();
  await page.keyboard.press("Space");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("status")).toHaveText("Follow the narration off");
  await page.keyboard.press("Enter");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("status")).toHaveText("Follow the narration on");
  // The knob moves with it.
  const knobAt = () => sw.locator(".part-switch-knob").evaluate((knob) => knob.getBoundingClientRect().x - knob.parentElement!.getBoundingClientRect().x);
  expect(await knobAt()).toBe(24);
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  expect(await knobAt()).toBe(4);
  // A tap in the 44 high button above or below the track counts too.
  const box = (await sw.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 2);
  await expect(sw).toHaveAttribute("aria-checked", "true");
  // A disabled switch does not change.
  const disabled = page.getByRole("switch", { name: "Start new reading sync work" });
  await disabled.click({ force: true });
  await expect(disabled).toHaveAttribute("aria-checked", "true");
});

test("a stepper steps with its keys and its buttons, and stops at its ends", async ({ page }) => {
  await openWith(page, defaultAppearance);
  const speed = page.getByRole("spinbutton", { name: "Speed", exact: true });
  const slower = page.getByRole("button", { name: "Slower (Speed)" });
  const faster = page.getByRole("button", { name: "Faster (Speed)" });
  await speed.focus();
  await page.keyboard.press("ArrowUp");
  await expect(speed).toHaveAttribute("aria-valuenow", "1.3");
  await expect(speed).toHaveText("1.3×");
  await expect(page.getByRole("status")).toHaveText("Speed 1.3×");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(speed).toHaveAttribute("aria-valuetext", "1.1×");
  await page.keyboard.press("PageUp");
  await expect(speed).toHaveAttribute("aria-valuenow", "2.1");
  // Home is the smallest value: the minus is disabled there and Arrow Down stays.
  await page.keyboard.press("Home");
  await expect(speed).toHaveAttribute("aria-valuenow", "0.5");
  await expect(slower).toBeDisabled();
  await page.keyboard.press("ArrowDown");
  await expect(speed).toHaveAttribute("aria-valuenow", "0.5");
  // End is the largest: the plus is disabled there.
  await page.keyboard.press("End");
  await expect(speed).toHaveAttribute("aria-valuenow", "3");
  await expect(faster).toBeDisabled();
  await expect(slower).toBeEnabled();
  await page.keyboard.press("ArrowUp");
  await expect(speed).toHaveAttribute("aria-valuenow", "3");
  // A tap on the minus and the plus.
  await slower.click();
  await expect(speed).toHaveAttribute("aria-valuenow", "2.9");
  await expect(faster).toBeEnabled();
  await faster.click();
  await expect(speed).toHaveAttribute("aria-valuenow", "3");
  // At its smallest, the plus leaves the end and the minus comes back.
  const slowest = page.getByRole("spinbutton", { name: "Slowest speed" });
  await page.getByRole("button", { name: "Faster (Slowest speed)" }).click();
  await expect(slowest).toHaveAttribute("aria-valuenow", "0.6");
  await expect(page.getByRole("button", { name: "Slower (Slowest speed)" })).toBeEnabled();
  // Disabled: not reached by Tab, and neither keys nor taps change it.
  const disabled = page.getByRole("spinbutton", { name: "Speed (disabled)" });
  await expect(disabled).toHaveAttribute("tabindex", "-1");
  await disabled.focus();
  await page.keyboard.press("ArrowUp");
  await page.getByRole("button", { name: "Faster (Speed (disabled))" }).click({ force: true });
  await expect(disabled).toHaveAttribute("aria-valuenow", "1");
});
