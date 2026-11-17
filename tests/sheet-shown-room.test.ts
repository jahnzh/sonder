import { test } from "node:test";
import assert from "node:assert/strict";
import { shownRoom } from "../src/parts/shown-room.ts";

// The Sheet part covers what the screen shows (#582; spec #572, "Request an account as a sheet with the keyboard's
// room"): a phone's keyboard narrows the visual viewport and leaves the layout viewport as it was.
test("without a keyboard the sheet covers the whole layout viewport", () => {
  assert.deepEqual(shownRoom({ height: 844, offsetTop: 0, scale: 1 }, 844), { top: 0, bottom: 0 });
});

test("a 300 px keyboard leaves the sheet the room above it", () => {
  assert.deepEqual(shownRoom({ height: 544, offsetTop: 0, scale: 1 }, 844), { top: 0, bottom: 300 });
});

test("a shown part scrolled down by the browser moves the sheet's top with it", () => {
  assert.deepEqual(shownRoom({ height: 544, offsetTop: 120, scale: 1 }, 844), { top: 120, bottom: 180 });
});

test("a layout viewport the keyboard already shrank needs no room of its own", () => {
  assert.deepEqual(shownRoom({ height: 544, offsetTop: 0, scale: 1 }, 544), { top: 0, bottom: 0 });
});

test("zoomed in, the sheet is left at the layout viewport", () => {
  assert.deepEqual(shownRoom({ height: 422, offsetTop: 200, scale: 2 }, 844), { top: 0, bottom: 0 });
});

test("fractional pixels round, and nothing is ever negative", () => {
  assert.deepEqual(shownRoom({ height: 543.6, offsetTop: 0.2, scale: 1 }, 844), { top: 0, bottom: 300 });
  assert.deepEqual(shownRoom({ height: 900, offsetTop: -4, scale: 1 }, 844), { top: 0, bottom: 0 });
});
