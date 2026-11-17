import { test } from "node:test";
import assert from "node:assert/strict";
import { parentOf, placeOf, readAddress, resolve, writeAddress } from "../src/routes.ts";
import { backName, pageName } from "../src/parts/back-name.ts";

// The parts gallery's addresses (#486): its own, and its one child page, whose parent is the gallery.
test("the gallery and its child page read, write, resolve and name their parent", () => {
  assert.deepEqual(readAddress("#gallery"), { name: "gallery" });
  assert.deepEqual(readAddress("#gallery/child"), { name: "gallery-child" });
  assert.equal(writeAddress({ name: "gallery" }), "#gallery");
  assert.equal(writeAddress({ name: "gallery-child" }), "#gallery/child");
  assert.deepEqual(parentOf({ name: "gallery-child" }), { name: "gallery" });
  assert.equal(parentOf({ name: "gallery" }), null);
  for (const admin of [true, false]) {
    assert.deepEqual(resolve(readAddress("#gallery"), { admin }), { name: "gallery" });
    assert.deepEqual(resolve(readAddress("#gallery/child"), { admin }), { name: "gallery-child" });
  }
  // It belongs to no tab of its own.
  assert.equal(placeOf({ name: "gallery" }), "library");
});

test("an address under the gallery that names nothing shows the Library", () => {
  for (const address of ["#gallery/", "#gallery/other", "#gallery/child/x", "#Gallery"]) {
    assert.deepEqual(readAddress(address), { name: "unknown", place: "library" }, address);
    assert.equal(writeAddress(resolve(readAddress(address), { admin: true })), "#library", address);
  }
});

test("a back button is named after where it lands", () => {
  assert.equal(backName({ name: "gallery" }), "Back to Gallery");
  assert.equal(backName({ name: "library" }), "Back to Library");
  assert.equal(backName({ name: "discover" }), "Back to Discover");
  assert.equal(backName({ name: "book", workId: "w1" }), "Back to the book");
  // Reading sync's Details goes back to Reading sync (#540); the book's other pages go back to the book.
  assert.equal(backName({ name: "book-page", workId: "w1", page: "sync" }), "Back to Reading sync");
  assert.equal(backName({ name: "book-page", workId: "w1", page: "ebook" }), "Back to the book");
  assert.equal(backName({ name: "activity", part: "server" }), "Back to Server");
  assert.equal(backName({ name: "settings" }), "Back to Settings");
  // A page with a name of its own passes it in; one it does not know falls back to the generic name.
  const named = (route: { name: string }) => (route.name === "series" ? "The Culture" : null);
  assert.equal(backName({ name: "series", id: "s1" }, named), "Back to The Culture");
  assert.equal(backName({ name: "library" }, named), "Back to Library");
  assert.equal(pageName({ name: "gallery-child" }), "Child page");
});
