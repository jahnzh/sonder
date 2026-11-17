import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coversPage,
  firstPage,
  isSettingsPage,
  SETTINGS_PAGES,
  isFirstPage,
  parentOf,
  placeOf,
  readAddress,
  resolve,
  step,
  writeAddress,
  type Route,
} from "../src/routes.ts";

// Every address in the spec's table (#480, "Addresses and the page stack"), with what it reads as, its place and
// its parent. A row's address is also what writing its route gives back.
const table: { address: string; route: Route; place: string; parent: Route | null }[] = [
  { address: "#library", route: { name: "library" }, place: "library", parent: null },
  { address: "#discover", route: { name: "discover" }, place: "discover", parent: null },
  { address: "#activity", route: { name: "activity", part: "now" }, place: "activity", parent: null },
  { address: "#activity/device", route: { name: "activity", part: "device" }, place: "activity", parent: null },
  { address: "#activity/server", route: { name: "activity", part: "server" }, place: "activity", parent: null },
  { address: "#activity/server/wsl", route: { name: "worker", worker: "wsl" }, place: "activity", parent: { name: "activity", part: "server" } },
  { address: "#settings", route: { name: "settings" }, place: "settings", parent: null },
  { address: "#settings/appearance", route: { name: "settings-page", page: "appearance" }, place: "settings", parent: { name: "settings" } },
  { address: "#book/w1", route: { name: "book", workId: "w1" }, place: "library", parent: { name: "library" } },
  ...(["audiobook", "ebook", "sync", "hardcover", "chapters", "bookmarks", "search"] as const).map((page) => ({
    address: `#book/w1/${page}`,
    route: { name: "book-page", workId: "w1", page } as Route,
    place: "library",
    parent: { name: "book", workId: "w1" } as Route,
  })),
  { address: "#book/w1/get/audiobook", route: { name: "get", workId: "w1", kind: "audiobook" }, place: "library", parent: { name: "book", workId: "w1" } },
  { address: "#book/w1/get/ebook", route: { name: "get", workId: "w1", kind: "ebook" }, place: "library", parent: { name: "book", workId: "w1" } },
  { address: "#series/s1", route: { name: "series", id: "s1" }, place: "library", parent: { name: "library" } },
  { address: "#series/s1/add", route: { name: "series-add", id: "s1" }, place: "library", parent: { name: "series", id: "s1" } },
  { address: "#listen/w1", route: { name: "listen", workId: "w1" }, place: "library", parent: { name: "book", workId: "w1" } },
  { address: "#read/w1", route: { name: "read", workId: "w1" }, place: "library", parent: { name: "book", workId: "w1" } },
];

test("every address in the table reads as its route, writes back the same, and names its place and parent", () => {
  for (const row of table) {
    assert.deepEqual(readAddress(row.address), row.route, row.address);
    assert.equal(writeAddress(row.route), row.address, row.address);
    assert.equal(placeOf(row.route), row.place, row.address);
    assert.deepEqual(parentOf(row.route), row.parent, row.address);
    // Without the "#", as location.hash.slice(1) gives it.
    assert.deepEqual(readAddress(row.address.slice(1)), row.route, row.address);
  }
});

test("a parameter with reserved characters survives writing and reading", () => {
  for (const id of ["hardcover:42", "a b/c?d#e", "ünïcode", "100%"]) {
    for (const route of [
      { name: "book", workId: id },
      { name: "book-page", workId: id, page: "sync" },
      { name: "get", workId: id, kind: "ebook" },
      { name: "series", id },
      { name: "series-add", id },
      { name: "listen", workId: id },
      { name: "read", workId: id },
      { name: "worker", worker: id },
      { name: "settings-page", page: id },
      { name: "reader", ebookId: id },
    ] as Route[]) {
      const address = writeAddress(route);
      assert.equal(address.split("#").length, 2, address);
      assert.deepEqual(readAddress(address), route, address);
    }
  }
});

test("the old names keep working: #downloads opens Activity's Now, #reader/<ebook id> opens that edition", () => {
  assert.deepEqual(readAddress("#downloads"), { name: "activity", part: "now" });
  assert.equal(writeAddress(readAddress("#downloads")), "#activity");
  assert.equal(placeOf(readAddress("#downloads")), "activity");
  assert.deepEqual(readAddress("#reader/upload-abc123"), { name: "reader", ebookId: "upload-abc123" });
  assert.deepEqual(readAddress("#reader/libgen-9%3A1"), { name: "reader", ebookId: "libgen-9:1" });
  // Today's reader took everything after "reader/" as the id, slashes included.
  assert.deepEqual(readAddress("#reader/a/b"), { name: "reader", ebookId: "a/b" });
  assert.equal(writeAddress({ name: "reader", ebookId: "upload-abc123" }), "#reader/upload-abc123");
  assert.deepEqual(parentOf({ name: "reader", ebookId: "x" }), { name: "library" });
  for (const admin of [true, false]) {
    assert.deepEqual(resolve(readAddress("#downloads"), { admin }), { name: "activity", part: "now" });
    assert.deepEqual(resolve(readAddress("#reader/e1"), { admin }), { name: "reader", ebookId: "e1" });
  }
});

test("the installed app's start, with no address, is the Library", () => {
  assert.deepEqual(readAddress(""), { name: "library" });
  assert.deepEqual(readAddress("#"), { name: "library" });
});

test("an address that names nothing reads as nothing in the place it points into", () => {
  const cases: [string, string][] = [
    ["#nowhere", "library"],
    ["#Library", "library"],
    ["#library/extra", "library"],
    ["#discover/x", "discover"],
    ["#downloads/x", "activity"],
    ["#activity/now", "activity"],
    ["#activity/device/x", "activity"],
    ["#activity/server/", "activity"],
    ["#activity/server/a/b", "activity"],
    ["#settings/", "settings"],
    ["#settings/a/b", "settings"],
    ["#book", "library"],
    ["#book/", "library"],
    ["#book/w1/unknown", "library"],
    ["#book/w1/get", "library"],
    ["#book/w1/get/film", "library"],
    ["#book/w1/audiobook/x", "library"],
    ["#series", "library"],
    ["#series/s1/remove", "library"],
    ["#listen", "library"],
    ["#listen/w1/x", "library"],
    ["#read/", "library"],
    ["#reader/", "library"],
    ["#book/%E0%A4%A", "library"],
  ];
  for (const [address, place] of cases) {
    assert.deepEqual(readAddress(address), { name: "unknown", place }, address);
    // Writing it gives the first page it shows.
    assert.equal(writeAddress(readAddress(address)), writeAddress(firstPage(place as never)), address);
    assert.equal(parentOf(readAddress(address)), null, address);
  }
});

test("what an address shows: built pages as they are, everything else the first page of its place", () => {
  const shows = (address: string, admin = true) => writeAddress(resolve(readAddress(address), { admin }));
  // Built today.
  for (const address of ["#library", "#discover", "#settings", "#activity", "#activity/server", "#reader/e1"])
    assert.equal(shows(address), address, address);
  // The old name of the Downloads page shows Now.
  assert.equal(shows("#downloads"), "#activity");
  assert.equal(shows("#downloads", false), "#activity");
  // Names nothing.
  assert.equal(shows("#nowhere"), "#library");
  assert.equal(shows("#settings/a/b"), "#settings");
  assert.equal(shows("#activity/bogus"), "#activity");
  // Not built yet: behaves like an address that names nothing.
  assert.equal(shows("#book/w1"), "#library");
  assert.equal(shows("#book/w1/audiobook"), "#library");
  assert.equal(shows("#book/w1/get/ebook"), "#library");
  assert.equal(shows("#series/s1"), "#library");
  assert.equal(shows("#series/s1/add"), "#library");
  assert.equal(shows("#listen/w1"), "#library");
  assert.equal(shows("#read/w1"), "#library");
  assert.equal(shows("#activity/device"), "#activity/device");
  // A worker's address is the administrator's worker page (#520): it stays in the address.
  assert.equal(shows("#activity/server/wsl"), "#activity/server/wsl");
  // Activity is everyone's place (#516); its Server part and workers are the administrator's: someone else gets Now.
  for (const address of ["#activity", "#activity/server", "#activity/server/wsl", "#activity/bogus"])
    assert.equal(shows(address, false), "#activity", address);
  // This device is everyone's (#518).
  assert.equal(shows("#activity/device", false), "#activity/device");
  assert.equal(shows("#settings", false), "#settings");
  assert.equal(shows("#discover", false), "#discover");
});

test("#settings/<page>: each page, an unknown word, and the administrator's pages for someone else", () => {
  const shows = (address: string, admin: boolean) => writeAddress(resolve(readAddress(address), { admin }));
  assert.deepEqual([...SETTINGS_PAGES], ["account", "appearance", "playback", "connections", "users", "library", "app"]);
  for (const page of SETTINGS_PAGES) {
    const address = `#settings/${page}`;
    assert.deepEqual(readAddress(address), { name: "settings-page", page }, address);
    assert.equal(writeAddress({ name: "settings-page", page }), address);
    assert.equal(placeOf(readAddress(address)), "settings", address);
    assert.deepEqual(parentOf(readAddress(address)), { name: "settings" }, address);
    // The administrator has every page.
    assert.equal(shows(address, true), address, address);
  }
  // Someone else has every page but Users and Library and storage, which show Settings.
  for (const page of ["account", "appearance", "playback", "connections", "app"])
    assert.equal(shows(`#settings/${page}`, false), `#settings/${page}`, page);
  for (const page of ["users", "library"]) assert.equal(shows(`#settings/${page}`, false), "#settings", page);
  // A word that names no page shows Settings, for everyone.
  for (const admin of [true, false]) {
    assert.equal(shows("#settings/reading", admin), "#settings");
    assert.equal(shows("#settings/keyboard", admin), "#settings");
    assert.equal(shows("#settings/Account", admin), "#settings");
    assert.equal(shows("#settings/account/more", admin), "#settings");
  }
  assert.equal(isSettingsPage("account"), true);
  assert.equal(isSettingsPage("nothing"), false);
});

test("first pages, and what covers a page", () => {
  assert.deepEqual(firstPage("library"), { name: "library" });
  assert.deepEqual(firstPage("activity"), { name: "activity", part: "now" });
  assert.equal(isFirstPage({ name: "settings" }), true);
  assert.equal(isFirstPage({ name: "activity", part: "now" }), true);
  assert.equal(isFirstPage({ name: "activity", part: "server" }), false);
  assert.equal(isFirstPage({ name: "book", workId: "w" }), false);
  assert.equal(isFirstPage({ name: "unknown", place: "library" }), true);
  for (const address of ["#book/w/get/ebook", "#series/s/add", "#listen/w", "#read/w", "#reader/e"])
    assert.equal(coversPage(readAddress(address)), true, address);
  for (const address of ["#library", "#book/w", "#series/s", "#activity", "#settings/x"])
    assert.equal(coversPage(readAddress(address)), false, address);
});

test("what adds a history entry and what replaces the current one", () => {
  const r = readAddress;
  // Adds one: opening a page, switching place, a sheet, Now playing.
  assert.equal(step(r("#library"), r("#discover")), "push");
  assert.equal(step(r("#library"), r("#book/w")), "push");
  assert.equal(step(r("#book/w"), r("#book/w/audiobook")), "push");
  assert.equal(step(r("#book/w"), r("#book/w/get/ebook")), "push");
  assert.equal(step(r("#book/w"), r("#listen/w")), "push");
  assert.equal(step(r("#settings"), r("#activity")), "push");
  assert.equal(step(r("#activity/server"), r("#activity/server/wsl")), "push");
  assert.equal(step(r("#library"), r("#reader/e")), "push");
  // Replaces: Activity's parts, Listen and Read of one work.
  assert.equal(step(r("#activity"), r("#activity/device")), "replace");
  assert.equal(step(r("#activity/device"), r("#activity/server")), "replace");
  assert.equal(step(r("#activity/server"), r("#activity")), "replace");
  // Choosing another worker beside the Server list replaces the worker's page shown (#520).
  assert.equal(step(r("#activity/server/wsl"), r("#activity/server/lisa")), "replace");
  assert.equal(step(r("#listen/w"), r("#read/w")), "replace");
  assert.equal(step(r("#read/w"), r("#listen/w")), "replace");
  assert.equal(step(r("#read/w"), r("#listen/other")), "push");
  // The same address does not move.
  assert.equal(step(r("#library"), r("#library")), "none");
  assert.equal(step(r("#book/w"), r("#book/w")), "none");
});

test("#book/<workId>/hardcover is built (#529) for everyone; the Book page and its unbuilt pages are not yet", () => {
  const shows = (address: string, admin: boolean) => writeAddress(resolve(readAddress(address), { admin }));
  for (const admin of [true, false]) {
    assert.equal(shows("#book/w1/hardcover", admin), "#book/w1/hardcover");
    assert.equal(shows("#book/hardcover%3A42/hardcover", admin), "#book/hardcover%3A42/hardcover");
    assert.equal(shows("#book/w1", admin), "#library");
    assert.equal(shows("#book/w1/sync", admin), "#library");
  }
  assert.deepEqual(parentOf(readAddress("#book/w1/hardcover")), { name: "book", workId: "w1" });
});

test("#book/<workId>/ebook shows the Ebook page for everyone, its parent the book (#531)", () => {
  for (const admin of [true, false]) {
    assert.deepEqual(resolve(readAddress("#book/w1/ebook"), { admin }), { name: "book-page", workId: "w1", page: "ebook" });
    assert.equal(writeAddress(resolve(readAddress("#book/w%2F1/ebook"), { admin })), "#book/w%2F1/ebook");
  }
  assert.deepEqual(parentOf(readAddress("#book/w1/ebook")), { name: "book", workId: "w1" });
  assert.equal(placeOf(readAddress("#book/w1/ebook")), "library");
});
