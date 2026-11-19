import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coversPage,
  firstPage,
  isSettingsPage,
  SETTINGS_PAGES,
  isFirstPage,
  OLD_NAMES,
  editionRoute,
  parentOf,
  placeOf,
  readAddress,
  readLink,
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
  ...(["audiobook", "ebook", "sync", "chapters", "bookmarks", "search", "match"] as const).map((page) => ({
    address: `#book/w1/${page}`,
    route: { name: "book-page", workId: "w1", page } as Route,
    place: "library",
    parent: { name: "book", workId: "w1" } as Route,
  })),
  { address: "#book/w1/sync/details", route: { name: "sync-details", workId: "w1" }, place: "library", parent: { name: "book-page", workId: "w1", page: "sync" } },
  { address: "#book/w1/get/audiobook", route: { name: "get", workId: "w1", kind: "audiobook" }, place: "library", parent: { name: "book", workId: "w1" } },
  { address: "#book/w1/get/ebook", route: { name: "get", workId: "w1", kind: "ebook" }, place: "library", parent: { name: "book", workId: "w1" } },
  // Paste a magnet link (#606): its parent is the Get audiobook sheet it covers.
  { address: "#book/w1/get/audiobook/magnet", route: { name: "get-magnet", workId: "w1" }, place: "library", parent: { name: "get", workId: "w1", kind: "audiobook" } },
  { address: "#series/s1", route: { name: "series", id: "s1" }, place: "library", parent: { name: "library" } },
  { address: "#series/s1/add", route: { name: "series-add", id: "s1" }, place: "library", parent: { name: "series", id: "s1" } },
  { address: "#listen/w1", route: { name: "listen", workId: "w1" }, place: "library", parent: { name: "book", workId: "w1" } },
  { address: "#read/w1", route: { name: "read", workId: "w1" }, place: "library", parent: { name: "book", workId: "w1" } },
  // Discover's "Search for a recording" (#575): the Get sheet without a book, whose parent is Discover.
  { address: "#discover/get/banks", route: { name: "discover-get", query: "banks" }, place: "discover", parent: { name: "discover" } },
  { address: "#discover/get/The%20Lamplighter%E2%80%99s%20Atlas", route: { name: "discover-get", query: "The Lamplighter’s Atlas" }, place: "discover", parent: { name: "discover" } },
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
      { name: "sync-details", workId: id },
      { name: "get", workId: id, kind: "ebook" },
      { name: "get-magnet", workId: id },
      { name: "series", id },
      { name: "series-add", id },
      { name: "listen", workId: id },
      { name: "read", workId: id },
      { name: "worker", worker: id },
      { name: "settings-page", page: id },
    ] as Route[]) {
      const address = writeAddress(route);
      assert.equal(address.split("#").length, 2, address);
      assert.deepEqual(readAddress(address), route, address);
    }
  }
});

test("the old names keep working: #downloads opens Activity's Now, #reader/<ebook id> opens that edition's Read", () => {
  assert.deepEqual(readAddress("#downloads"), { name: "activity", part: "now" });
  assert.equal(writeAddress(readAddress("#downloads")), "#activity");
  assert.equal(placeOf(readAddress("#downloads")), "activity");
  // #613 part 2: the reader on its own is gone. The link names an edition whose work only the server knows: it reads
  // as the Library (the link's place) with that edition to look up, and the answer's work gives Now playing's Read.
  assert.deepEqual(readLink("#reader/upload-abc123"), { route: { name: "unknown", place: "library" }, redirect: true, edition: "upload-abc123" });
  assert.equal(readLink("#reader/libgen-9%3A1").edition, "libgen-9:1");
  // Today's reader took everything after "reader/" as the id, slashes included.
  assert.equal(readLink("#reader/a/b").edition, "a/b");
  assert.equal(readLink("reader/a/b").edition, "a/b", "without the #");
  for (const admin of [true, false]) {
    assert.deepEqual(resolve(readAddress("#downloads"), { admin }), { name: "activity", part: "now" });
    assert.deepEqual(resolve(readAddress("#reader/e1"), { admin }), { name: "library" });
  }
  // The server's answer for the edition: its work's Read face, or nothing when it names no work (the ebook is gone).
  assert.deepEqual(editionRoute({ workId: "w1" }), { name: "read", workId: "w1" });
  assert.equal(writeAddress(editionRoute({ workId: "a b" })!), "#read/a%20b");
  assert.equal(editionRoute({ workId: "" }), null);
  assert.equal(editionRoute({}), null);
  assert.equal(editionRoute(null), null);
  // A reader link without an id names no edition: the Library, as any address that names nothing there.
  for (const address of ["#reader", "#reader/", "#reader/%E0%A4%A"])
    assert.deepEqual(readLink(address), { route: { name: "unknown", place: "library" }, redirect: true }, address);
});

test("old names (spec #608): one table; each reads as its new route, marked a redirect", () => {
  // The table names each old address once, with the address of the page that took its place.
  assert.deepEqual(OLD_NAMES.map((entry) => [entry.head, entry.becomes]), [["downloads", "#activity"], ["reader", "#read/<workId>"]]);
  for (const entry of OLD_NAMES.filter((entry) => !entry.edition)) {
    const read = readLink(`#${entry.head}`);
    assert.equal(read.redirect, true, entry.head);
    assert.equal(writeAddress(read.route), entry.becomes, entry.head);
    // Without the "#" too, and readAddress gives the same route.
    assert.deepEqual(readLink(entry.head), read, entry.head);
    assert.deepEqual(readAddress(`#${entry.head}`), read.route, entry.head);
    // Extra parts after an old name name nothing in the place of its new page; still a redirect.
    const extra = readLink(`#${entry.head}/x`);
    assert.deepEqual(extra, { route: { name: "unknown", place: entry.place }, redirect: true }, entry.head);
  }
  assert.deepEqual(readLink("#downloads"), { route: { name: "activity", part: "now" }, redirect: true });
  // An old name whose page the server must find (#reader/<ebook id>) reads as its place's first page with the
  // edition named, and becomes its new route once the server named the work.
  for (const entry of OLD_NAMES.filter((entry) => entry.edition)) {
    const read = readLink(`#${entry.head}/e1`);
    assert.equal(read.redirect, true, entry.head);
    assert.equal(read.edition, "e1", entry.head);
    assert.equal(writeAddress(resolve(read.route, { admin: true })), writeAddress(firstPage(entry.place)), entry.head);
    assert.deepEqual(readLink(`${entry.head}/e1`), read, entry.head);
    assert.equal(writeAddress(editionRoute({ workId: "w1" })!), entry.becomes.replace("<workId>", "w1"), entry.head);
  }
  // Every address of #480's table is not a redirect and reads as before.
  for (const row of table) assert.deepEqual(readLink(row.address), { route: row.route, redirect: false }, row.address);
  for (const address of ["", "#", "#nowhere", "#Downloads", "#Reader/e1", "#activity", "#read/e1"]) {
    assert.equal(readLink(address).redirect, false, address);
    assert.equal(readLink(address).edition, undefined, address);
  }
});

test("no route or place named downloads or reader is read, written or returned", () => {
  const addresses = [
    "#downloads", "#downloads/", "#downloads/x", "#downloads/a/b",
    "#reader", "#reader/", "#reader/e1", "#reader/a/b", "#reader/libgen-9%3A1",
    ...table.map((row) => row.address),
    ...OLD_NAMES.map((entry) => `#${entry.head}`),
  ];
  for (const address of addresses) {
    for (const admin of [true, false]) {
      const read = readLink(address);
      for (const route of [read.route, resolve(read.route, { admin }), ...(read.edition ? [editionRoute({ workId: "w1" })!] : [])]) {
        for (const old of ["downloads", "reader"]) {
          assert.notEqual(route.name, old, address);
          assert.notEqual(placeOf(route), old, address);
          assert.ok(!writeAddress(route).startsWith(`#${old}`), address);
          const parent = parentOf(route);
          if (parent) assert.ok(!writeAddress(parent).startsWith(`#${old}`), address);
          assert.ok(!writeAddress(firstPage(placeOf(route))).startsWith(`#${old}`), address);
        }
      }
    }
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
    ["#discover/get", "discover"],
    ["#discover/get/", "discover"],
    ["#discover/get/a/b", "discover"],
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
    // An unknown fourth part of a Get sheet's address names nothing (#606); the magnet sheet is Get audiobook's only.
    ["#book/w1/get/audiobook/film", "library"],
    ["#book/w1/get/audiobook/", "library"],
    ["#book/w1/get/ebook/magnet", "library"],
    ["#book/w1/get/audiobook/magnet/x", "library"],
    ["#book/w1/audiobook/x", "library"],
    ["#series", "library"],
    ["#series/s1/remove", "library"],
    ["#listen", "library"],
    ["#listen/w1/x", "library"],
    ["#read/", "library"],
    ["#reader/", "library"],
    ["#reader", "library"],
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
  for (const address of ["#library", "#discover", "#settings", "#activity", "#activity/server"])
    assert.equal(shows(address), address, address);
  // An old reader link shows the Library until the server names the edition's work.
  assert.equal(shows("#reader/e1"), "#library");
  assert.equal(shows("#reader/e1", false), "#library");
  // The old name of the Downloads page shows Now.
  assert.equal(shows("#downloads"), "#activity");
  assert.equal(shows("#downloads", false), "#activity");
  // Names nothing.
  assert.equal(shows("#nowhere"), "#library");
  assert.equal(shows("#settings/a/b"), "#settings");
  assert.equal(shows("#activity/bogus"), "#activity");
  // The Book page (#532) is built, for everyone.
  assert.equal(shows("#book/w1"), "#book/w1");
  assert.equal(shows("#book/w1", false), "#book/w1");
  // The Get audiobook sheet (#601) is the administrator's; someone else gets the Book page at its address.
  assert.equal(shows("#book/w1/get/audiobook"), "#book/w1/get/audiobook");
  assert.equal(shows("#book/w1/get/audiobook", false), "#book/w1");
  // The Series page (#562) is built, for everyone; so is its Add sheet (#563).
  assert.equal(shows("#series/701"), "#series/701");
  assert.equal(shows("#series/701", false), "#series/701");
  assert.equal(shows("#series/s1/add"), "#series/s1/add");
  assert.equal(shows("#series/s1/add", false), "#series/s1/add");
  // The Get ebook sheet (#604) is the administrator's, as the Get audiobook sheet is.
  assert.equal(shows("#book/w1/get/ebook"), "#book/w1/get/ebook");
  assert.equal(shows("#book/w1/get/ebook", false), "#book/w1");
  // Its magnet sheet (#606) likewise: the administrator's; someone else gets the Book page.
  assert.equal(shows("#book/w1/get/audiobook/magnet"), "#book/w1/get/audiobook/magnet");
  assert.equal(shows("#book/w1/get/audiobook/magnet", false), "#book/w1");
  // Now playing's faces (#593) are built, for everyone.
  assert.equal(shows("#listen/w1"), "#listen/w1");
  assert.equal(shows("#read/w1", false), "#read/w1");
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
  // The Audiobook page (#530) is built, for everyone.
  assert.equal(shows("#book/w1/audiobook"), "#book/w1/audiobook");
  assert.equal(shows("#book/w1/audiobook", false), "#book/w1/audiobook");
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
  // Someone else has every page but Connections (since Hardcover went, #721 part d), Users and Library and storage,
  // which show Settings.
  for (const page of ["account", "appearance", "playback", "app"])
    assert.equal(shows(`#settings/${page}`, false), `#settings/${page}`, page);
  for (const page of ["connections", "users", "library"]) assert.equal(shows(`#settings/${page}`, false), "#settings", page);
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
  for (const address of ["#book/w/get/ebook", "#book/w/get/audiobook/magnet", "#series/s/add", "#listen/w", "#read/w"])
    assert.equal(coversPage(readAddress(address)), true, address);
  // An old reader link covers nothing: it reads as the Library until the Read face replaces it.
  assert.equal(coversPage(readAddress("#reader/e")), false);
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
  assert.equal(step(r("#book/w/get/audiobook"), r("#book/w/get/audiobook/magnet")), "push");
  assert.equal(step(r("#book/w"), r("#listen/w")), "push");
  assert.equal(step(r("#settings"), r("#activity")), "push");
  assert.equal(step(r("#activity/server"), r("#activity/server/wsl")), "push");
  assert.equal(step(r("#library"), r("#read/w")), "push");
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

test("#book/<workId>/hardcover, the Hardcover page an older build linked to, opens the match page (#721 part d)", () => {
  const shows = (address: string, admin: boolean) => writeAddress(resolve(readAddress(address), { admin }));
  for (const admin of [true, false]) {
    assert.equal(shows("#book/w1/hardcover", admin), "#book/w1/match");
    assert.equal(shows("#book/hardcover%3A42/hardcover", admin), "#book/hardcover%3A42/match");
    assert.equal(shows("#book/w1", admin), "#book/w1");
  }
  assert.deepEqual(readAddress("#book/w1/hardcover"), { name: "book-page", workId: "w1", page: "match" });
  assert.equal(readAddress("#book/w1/hardcover/x").name, "unknown");
});

test("#book/<workId>/sync and /sync/details are built for everyone (#540): Details' parent is Reading sync, its parent the book", () => {
  for (const admin of [true, false]) {
    assert.deepEqual(resolve(readAddress("#book/w1/sync"), { admin }), { name: "book-page", workId: "w1", page: "sync" });
    assert.deepEqual(resolve(readAddress("#book/w1/sync/details"), { admin }), { name: "sync-details", workId: "w1" });
    assert.equal(writeAddress(resolve(readAddress("#book/w%2F1/sync/details"), { admin })), "#book/w%2F1/sync/details");
  }
  assert.deepEqual(parentOf(readAddress("#book/w1/sync")), { name: "book", workId: "w1" });
  assert.deepEqual(parentOf(readAddress("#book/w1/sync/details")), { name: "book-page", workId: "w1", page: "sync" });
  // Anything else under sync names nothing.
  assert.equal(readAddress("#book/w1/sync/other").name, "unknown");
  assert.equal(readAddress("#book/w1/sync/details/x").name, "unknown");
  assert.equal(step(readAddress("#book/w1/sync"), readAddress("#book/w1/sync/details")), "push");
});

test("#book/<workId>/ebook shows the Ebook page for everyone, its parent the book (#531)", () => {
  for (const admin of [true, false]) {
    assert.deepEqual(resolve(readAddress("#book/w1/ebook"), { admin }), { name: "book-page", workId: "w1", page: "ebook" });
    assert.equal(writeAddress(resolve(readAddress("#book/w%2F1/ebook"), { admin })), "#book/w%2F1/ebook");
  }
  assert.deepEqual(parentOf(readAddress("#book/w1/ebook")), { name: "book", workId: "w1" });
  assert.equal(placeOf(readAddress("#book/w1/ebook")), "library");
});

test("the reader's pages: Chapters, Bookmarks and Search are built for everyone, their parent the book (#590)", () => {
  for (const admin of [true, false])
    for (const page of ["chapters", "bookmarks", "search"] as const) {
      assert.deepEqual(resolve(readAddress(`#book/w1/${page}`), { admin }), { name: "book-page", workId: "w1", page });
      assert.equal(writeAddress(resolve(readAddress(`#book/w%2F1/${page}`), { admin })), `#book/w%2F1/${page}`);
      assert.deepEqual(parentOf(readAddress(`#book/w1/${page}`)), { name: "book", workId: "w1" });
    }
  const r = readAddress;
  // The segmented control between Chapters and Bookmarks replaces the entry; Search and other works add one.
  assert.equal(step(r("#book/w/chapters"), r("#book/w/bookmarks")), "replace");
  assert.equal(step(r("#book/w/bookmarks"), r("#book/w/chapters")), "replace");
  assert.equal(step(r("#book/w/chapters"), r("#book/w/search")), "push");
  assert.equal(step(r("#book/w/chapters"), r("#book/v/bookmarks")), "push");
  assert.equal(step(r("#read/w"), r("#book/w/chapters")), "push");
  assert.equal(step(r("#book/w/search"), r("#read/w")), "push");
});

test("#discover/get/<query> (#575): a sheet over Discover, the administrator's; someone else gets Discover", () => {
  const shows = (address: string, admin: boolean) => writeAddress(resolve(readAddress(address), { admin }));
  assert.equal(shows("#discover/get/banks", true), "#discover/get/banks");
  assert.equal(shows("#discover/get/banks", false), "#discover");
  assert.equal(coversPage(readAddress("#discover/get/banks")), true);
  assert.equal(step(readAddress("#discover"), readAddress("#discover/get/banks")), "push");
});

test("#discover/get/<query> (#576): a query with a slash is one part of the address, read and written back the same", () => {
  for (const query of ["AC/DC", "1/2 of a yellow sun", "a/b/c", "/"]) {
    const route: Route = { name: "discover-get", query };
    const address = writeAddress(route);
    assert.equal(address.split("/").length, 3, address);
    assert.deepEqual(readAddress(address), route, address);
    assert.deepEqual(parentOf(route), { name: "discover" });
  }
  assert.equal(writeAddress({ name: "discover-get", query: "AC/DC" }), "#discover/get/AC%2FDC");
  // An unencoded slash names nothing: Discover.
  assert.equal(writeAddress(resolve(readAddress("#discover/get/AC/DC"), { admin: true })), "#discover");
});
