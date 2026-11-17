import { test } from "node:test";
import assert from "node:assert/strict";
import { coversPage, parentOf, placeOf, readAddress, resolve, step, writeAddress } from "../src/routes.ts";
import { backName } from "../src/parts/back-name.ts";

// The gallery's own sheet (#492): an address of its own, shown over the gallery, its parent.
test("the gallery's sheet reads, writes and resolves, covers the gallery and names it as its parent", () => {
  assert.deepEqual(readAddress("#gallery/sheet"), { name: "gallery-sheet" });
  assert.equal(writeAddress({ name: "gallery-sheet" }), "#gallery/sheet");
  for (const admin of [true, false]) assert.deepEqual(resolve(readAddress("#gallery/sheet"), { admin }), { name: "gallery-sheet" });
  assert.deepEqual(parentOf({ name: "gallery-sheet" }), { name: "gallery" });
  // A sheet is shown over a page, not in place of it, so leaving it keeps the page's scroll.
  assert.equal(coversPage({ name: "gallery-sheet" }), true);
  assert.equal(coversPage({ name: "gallery" }), false);
  // Opening it from the gallery adds an entry.
  assert.equal(step({ name: "gallery" }, { name: "gallery-sheet" }), "push");
  assert.equal(placeOf({ name: "gallery-sheet" }), "library");
  assert.equal(backName({ name: "gallery-sheet" }), "Back to the sheet");
});

test("an address under the gallery's sheet that names nothing shows the Library", () => {
  for (const address of ["#gallery/sheet/x", "#gallery/Sheet", "#gallery/sheets"]) {
    assert.deepEqual(readAddress(address), { name: "unknown", place: "library" }, address);
  }
});
