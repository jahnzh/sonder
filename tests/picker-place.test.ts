// The Picker part (#578; spec #572 "The Picker part"): where it stands on a desktop, under the button that opened it,
// its right edge on the button's, kept inside the window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickerPlace, PICKER_DESKTOP_WIDTH } from "../src/parts/picker-place.ts";

const window = { width: 1280, height: 800 };

test("under its button, the right edges lined up, 8 below it", () => {
  assert.deepEqual(pickerPlace({ top: 100, bottom: 144, left: 900, right: 1000 }, window, 360), { top: 152, left: 640, maxHeight: 632 });
});

test("kept 16 inside the window's left and right edges", () => {
  assert.equal(pickerPlace({ top: 100, bottom: 144, left: 10, right: 100 }, window, 360).left, 16);
  assert.equal(pickerPlace({ top: 100, bottom: 144, left: 1200, right: 1280 }, window, 360).left, 1280 - 360 - 16);
});

test("a button low in the window still leaves the picker room to scroll", () => {
  assert.equal(pickerPlace({ top: 700, bottom: 744, left: 900, right: 1000 }, window, 360).maxHeight, 160);
});

test("a desktop is 760 wide and more, as the rail's", () => {
  assert.equal(PICKER_DESKTOP_WIDTH, 760);
});
