import { test } from "node:test";
import assert from "node:assert/strict";
import { SPREAD_GAP, SPREAD_MIN_HOST, spreadHostWidth, textMeasure, textPadding } from "../src/reader-spread.ts";
import { defaultAppearance } from "../src/appearance.ts";

// Two pages side by side on a desktop (#762). `available` is the text area between the page arrows: the window less
// the contents (clamp(200px, 22vw, 280px) when open), the page area's padding (2 × 24) and the arrows (2 × (44 + 16)).
const area = (window: number, contents: boolean) => window - (contents ? Math.min(280, Math.max(200, 0.22 * window)) : 0) - 48 - 120;
const text = defaultAppearance.reader;

test("the default text: two pages at 1920 with the contents open and hidden, and at 1280 with them hidden", () => {
  assert.equal(area(1920, true), 1472);
  assert.equal(spreadHostWidth(area(1920, true), text, "paginated"), 1472);
  // Hidden, the host spans two pages of the whole measure (34em of 20 px, 32 of padding each side), no wider.
  assert.equal(spreadHostWidth(area(1920, false), text, "paginated"), 2 * (680 + 64 + SPREAD_GAP));
  assert.equal(spreadHostWidth(area(1280, false), text, "paginated"), 1112);
});

test("one page at 1280 with the contents open, at 760, and in Scroll mode", () => {
  assert.equal(spreadHostWidth(area(1280, true), text, "paginated"), null);
  assert.equal(spreadHostWidth(area(760, true), text, "paginated"), null);
  assert.equal(spreadHostWidth(area(760, false), text, "paginated"), null);
  assert.equal(spreadHostWidth(area(1920, true), text, "scroll"), null);
  assert.equal(spreadHostWidth(area(1920, false), text, "scroll"), null);
  assert.equal(spreadHostWidth(0, text, "paginated"), null);
});

test("the threshold follows the measure: a larger font falls back to one page sooner", () => {
  // Each page keeps at least 60% of the measure: 2 × (0.6 × 34em + 2 × 32 + 48).
  const least = (size: number) => 2 * (0.6 * 34 * (size + 1) + 64 + SPREAD_GAP);
  assert.equal(spreadHostWidth(Math.ceil(least(19)), text, "paginated"), Math.ceil(least(19)));
  assert.equal(spreadHostWidth(Math.ceil(least(19)) - 1, text, "paginated"), null);
  // 1280 with the contents hidden holds two pages up to size 20, not at 22.
  assert.notEqual(spreadHostWidth(area(1280, false), { ...text, size: 20 }, "paginated"), null);
  assert.equal(spreadHostWidth(area(1280, false), { ...text, size: 22 }, "paginated"), null);
  // 1920 with the contents open holds two pages at size 26, not at 30.
  assert.notEqual(spreadHostWidth(area(1920, true), { ...text, size: 26 }, "paginated"), null);
  assert.equal(spreadHostWidth(area(1920, true), { ...text, size: 30 }, "paginated"), null);
  // A wider chosen measure needs a wider area, a narrower one less.
  assert.equal(spreadHostWidth(area(1280, false), { ...text, width: 1000 }, "paginated"), null);
  assert.equal(spreadHostWidth(area(1920, false), { ...text, width: 500 }, "paginated"), 2 * (500 + 64 + SPREAD_GAP));
  assert.equal(spreadHostWidth(800, { ...text, width: 500 }, "paginated"), null);
  assert.equal(spreadHostWidth(840, { ...text, width: 500 }, "paginated"), 840);
});

test("a spread's host is never narrower than epub.js's minimum, so epub.js always lays out the two pages", () => {
  for (const size of [14, 19, 36])
    for (const margin of [8, 20, 80])
      for (const width of [350, 720, 1100])
        for (let available = 0; available <= 3000; available += 7) {
          const host = spreadHostWidth(available, { size, margin, width }, "paginated");
          if (host === null) continue;
          assert.ok(host >= SPREAD_MIN_HOST && host <= available, `${host} for ${available} at ${size}/${margin}/${width}`);
          // Each page holds the padding and at least 60% of the measure.
          assert.ok(host / 2 - SPREAD_GAP - 2 * textPadding({ size, margin, width }, host) >= 0.6 * textMeasure({ size, margin, width }, host) - 1);
        }
});
