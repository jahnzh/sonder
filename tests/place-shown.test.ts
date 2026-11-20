// #713: a saved series beside the Library (a desktop) shows the Library alone, whatever place was shown before it.
import test from "node:test";
import assert from "node:assert/strict";
import { placeShown } from "../src/place-shown";

test("a series beside the Library shows only the Library, whatever place was under it", () => {
  for (const under of ["library", "discover", "activity", "settings"] as const) assert.equal(placeShown(under, true), "library");
});

test("without a series beside the Library the place under the page is shown", () => {
  for (const under of ["library", "discover", "activity", "settings"] as const) assert.equal(placeShown(under, false), under);
});
