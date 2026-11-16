import { test } from "node:test";
import assert from "node:assert/strict";

// The history wiring of src/navigation.ts against a small fake of the browser's history: one entry list, an index,
// popstate after a traversal (asynchronously, as browsers do) and after a fragment navigation the app did not make.
type Entry = { url: string; state: unknown };
let live: FakeBrowser | null = null;
class FakeBrowser {
  entries: Entry[];
  index = 0;
  scrollY = 0;
  scrollHeight = 5000;
  innerHeight = 800;
  listeners = new Map<string, ((event: { state: unknown }) => void)[]>();
  constructor(url: string, state: unknown = null) {
    this.entries = [{ url, state }];
  }
  get url() {
    return new URL(this.entries[this.index].url, "http://app.test");
  }
  dispatch(type: string, event: { state: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  traverse(delta: number) {
    const target = this.index + delta;
    if (target < 0 || target >= this.entries.length) return;
    setTimeout(() => {
      if (live !== this) return;
      this.index = target;
      this.dispatch("popstate", { state: this.entries[this.index].state });
    }, 0);
  }
  /** A link or a typed address: the browser adds an entry with no state and fires popstate. */
  followHash(hash: string) {
    this.entries.splice(this.index + 1);
    this.entries.push({ url: `${this.url.pathname}${hash}`, state: null });
    this.index++;
    this.dispatch("popstate", { state: null });
  }
  install() {
    const self = this;
    // Timers of an earlier page (or test) must not reach this one through the shared globals.
    live = this;
    const g = globalThis as Record<string, unknown>;
    g.location = {
      get hash() { return self.url.hash; },
      get pathname() { return self.url.pathname; },
      get search() { return self.url.search; },
    };
    g.history = {
      scrollRestoration: "auto",
      get state() { return self.entries[self.index].state; },
      get length() { return self.entries.length; },
      pushState(state: unknown, _title: string, url: string) {
        self.entries.splice(self.index + 1);
        self.entries.push({ url, state: structuredClone(state) });
        self.index++;
      },
      replaceState(state: unknown, _title: string, url?: string) {
        self.entries[self.index] = { url: url ?? self.entries[self.index].url, state: structuredClone(state) };
      },
      back: () => self.traverse(-1),
      go: (delta: number) => self.traverse(delta),
    };
    g.window = {
      get scrollY() { return self.scrollY; },
      get innerHeight() { return self.innerHeight; },
      scrollTo: (_x: number, y: number) => { self.scrollY = y; },
      addEventListener: (type: string, listener: (event: { state: unknown }) => void) => {
        self.listeners.set(type, [...(self.listeners.get(type) ?? []), listener]);
      },
    };
    g.document = { documentElement: { get scrollHeight() { return self.scrollHeight; } } };
    g.requestAnimationFrame = (callback: () => void) => setTimeout(() => live === self && callback(), 0);
    return this;
  }
  get hashes() {
    return this.entries.map((entry) => new URL(entry.url, "http://app.test").hash);
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
/** Waits until a condition holds, for traversals and scroll restores that land after a few timer turns. */
async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out: ${what}`);
}
let generation = 0;
/** A fresh copy of the module, as after a page load. */
async function load(browser: FakeBrowser, admin = true) {
  // A page load drops the old document's listeners.
  browser.listeners.clear();
  browser.install();
  const module = (await import(`../src/navigation.ts?load=${generation++}`)) as typeof import("../src/navigation.ts");
  module.startNavigation({ admin });
  return module;
}

test("the installed app's start, with no address, is the Library, written into the entry it opened on", async () => {
  const browser = new FakeBrowser("/");
  await load(browser);
  assert.deepEqual(browser.hashes, ["#library"]);
});

test("switching place adds a step, and Back returns to the place before", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  nav.goPlace("discover");
  nav.goPlace("settings");
  assert.deepEqual(browser.hashes, ["#library", "#discover", "#settings"]);
  nav.goBack();
  await until(() => browser.url.hash === "#discover", "#discover");
  nav.goBack();
  await until(() => browser.url.hash === "#library", "#library");
});

test("the tab of the current place adds no step on its first page, and goes back to the first page behind", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  nav.goPlace("discover");
  assert.deepEqual(browser.hashes, ["#discover"]);
  nav.goPlace("library");
  nav.navigate({ name: "reader", ebookId: "e1" });
  assert.deepEqual(browser.hashes, ["#discover", "#library", "#reader/e1"]);
  // The reader is in the Library's place; its tab goes back to the Library instead of adding an entry.
  nav.goPlace("library");
  await until(() => browser.url.hash === "#library", "#library");
  assert.equal(browser.entries.length, 3);
});

test("the tab of another place adds a step even when that place lies behind", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  nav.goPlace("discover");
  nav.goPlace("library");
  assert.deepEqual(browser.hashes, ["#library", "#discover", "#library"]);
});

test("closing the reader goes back when an entry of the app lies behind, so Back does not reopen it", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  nav.goPlace("library");
  nav.navigate({ name: "reader", ebookId: "e1" });
  nav.goBack();
  await until(() => browser.url.hash === "#library", "#library");
  // The reader's entry is ahead now, not behind: Back goes to Discover.
  nav.goBack();
  await until(() => browser.url.hash === "#discover", "#discover");
});

test("a reader opened by a link closes to its parent in place, adding nothing behind", async () => {
  const browser = new FakeBrowser("/#reader/e1");
  const nav = await load(browser);
  assert.deepEqual(browser.hashes, ["#reader/e1"]);
  nav.goBack();
  await settle();
  assert.deepEqual(browser.hashes, ["#library"]);
  assert.equal(browser.index, 0);
});

test("a reload keeps the entry's place in the stack", async () => {
  const browser = new FakeBrowser("/#library");
  let nav = await load(browser);
  nav.goPlace("discover");
  nav.goPlace("settings");
  // Reload: the same entries and states, a fresh module.
  nav = await load(browser);
  assert.equal(browser.url.hash, "#settings");
  nav.goBack();
  await until(() => browser.url.hash === "#discover", "#discover");
});

test("an address the app did not write counts as a step, and one that names nothing is replaced by what it shows", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  browser.followHash("#book/w1/sync");
  await settle();
  assert.deepEqual(browser.hashes, ["#library", "#library"]);
  browser.followHash("#settings/nothing");
  assert.deepEqual(browser.hashes, ["#library", "#library", "#settings"]);
  nav.goBack();
  await until(() => browser.index === 1, "index 1");
  nav.goBack();
  await until(() => browser.index === 0, "index 0");
  assert.deepEqual(browser.hashes, ["#library", "#library", "#settings"]);
});

test("an old name is read in place: #downloads stays, an unknown word becomes the Library without a new entry", async () => {
  const downloads = new FakeBrowser("/#downloads");
  await load(downloads);
  assert.deepEqual(downloads.hashes, ["#downloads"]);
  const unknown = new FakeBrowser("/#nowhere");
  await load(unknown);
  assert.deepEqual(unknown.hashes, ["#library"]);
});

test("the administrator's page for someone else shows the Library, and survives for the administrator", async () => {
  const other = new FakeBrowser("/#activity");
  await load(other, false);
  assert.deepEqual(other.hashes, ["#library"]);
  const admin = new FakeBrowser("/#activity");
  await load(admin, true);
  assert.deepEqual(admin.hashes, ["#activity"]);
});

test("Back restores the scroll position the entry had, and a new page starts at its top", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  browser.scrollY = 1234;
  nav.goPlace("discover");
  assert.equal(browser.scrollY, 0);
  browser.scrollY = 50;
  nav.goBack();
  await until(() => browser.url.hash === "#library", "#library");
  await until(() => browser.scrollY === 1234, "scroll 1234");
  // Opening a page again starts it at its top.
  nav.navigate({ name: "discover" });
  assert.equal(browser.scrollY, 0);
});

test("a scroll position waits for the page to be tall enough, then is restored", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  browser.scrollY = 3000;
  nav.goPlace("settings");
  browser.scrollHeight = 1000;
  nav.goBack();
  await until(() => browser.url.hash === "#library", "#library");
  await settle();
  assert.equal(browser.scrollY, 0);
  browser.scrollHeight = 5000;
  await until(() => browser.scrollY === 3000, "scroll 3000");
});

test("closing twice before the first Back lands goes back one step", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  nav.goPlace("library");
  nav.navigate({ name: "reader", ebookId: "e1" });
  // The close button and Escape in the same moment.
  nav.goBack();
  nav.goBack();
  await until(() => browser.url.hash === "#library", "#library");
  await settle();
  assert.equal(browser.url.hash, "#library");
  assert.equal(browser.index, 1);
});
