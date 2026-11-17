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
  /** How long a traversal takes to land; a slow browser's can take longer than the app waits for it. */
  delay = 0;
  /** The address each traversal landed on, in turn. */
  landed: string[] = [];
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
    // Traversals queue and apply in turn, each from where the one before left the history.
    setTimeout(() => {
      const target = this.index + delta;
      if (live !== this || target < 0 || target >= this.entries.length) return;
      this.index = target;
      this.landed.push(this.url.hash);
      this.dispatch("popstate", { state: this.entries[this.index].state });
    }, this.delay);
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
      removeEventListener: (type: string, listener: (event: { state: unknown }) => void) => {
        self.listeners.set(type, (self.listeners.get(type) ?? []).filter((each) => each !== listener));
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
  browser.followHash("#series/s1/add");
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

test("an old name is read in place: #downloads becomes #activity, an unknown word the Library, without a new entry", async () => {
  for (const admin of [true, false]) {
    const downloads = new FakeBrowser("/#downloads");
    await load(downloads, admin);
    assert.deepEqual(downloads.hashes, ["#activity"]);
  }
  const unknown = new FakeBrowser("/#nowhere");
  await load(unknown);
  assert.deepEqual(unknown.hashes, ["#library"]);
});

test("Activity's Server for someone else shows Now, and survives for the administrator", async () => {
  const other = new FakeBrowser("/#activity/server");
  await load(other, false);
  assert.deepEqual(other.hashes, ["#activity"]);
  const now = new FakeBrowser("/#activity");
  await load(now, false);
  assert.deepEqual(now.hashes, ["#activity"]);
  const admin = new FakeBrowser("/#activity/server");
  await load(admin, true);
  assert.deepEqual(admin.hashes, ["#activity/server"]);
});

test("switching Activity's parts replaces the entry, so Back leaves Activity", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser, true);
  nav.goPlace("activity");
  nav.navigate({ name: "activity", part: "server" });
  nav.navigate({ name: "activity", part: "now" });
  nav.navigate({ name: "activity", part: "server" });
  assert.deepEqual(browser.hashes, ["#library", "#activity/server"]);
  nav.goBack();
  await until(() => browser.url.hash === "#library" && browser.index === 0, "#library");
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

test("a close heard after its Back has landed moves nothing: Back afterwards still goes one step (#590)", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  nav.goPlace("library");
  const reader = { name: "reader", ebookId: "e1" } as const;
  nav.navigate(reader);
  nav.goBackFrom(reader);
  await until(() => browser.url.hash === "#library", "#library");
  // The kept-mounted reader is told of a focus outside it before it renders again, with the reader's route.
  nav.goBackFrom(reader);
  await settle();
  assert.equal(browser.url.hash, "#library");
  assert.equal(browser.index, 1);
  assert.deepEqual(browser.landed, ["#library"]);
  nav.goBack();
  await until(() => browser.url.hash === "#discover", "#discover");
});

test("a close of the reader before its Back lands goes back one step, like goBack", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  nav.goPlace("library");
  const reader = { name: "reader", ebookId: "e1" } as const;
  nav.navigate(reader);
  nav.goBackFrom(reader);
  nav.goBackFrom(reader);
  await until(() => browser.url.hash === "#library", "#library");
  await settle();
  assert.equal(browser.index, 1);
});

/** A browser whose history already holds these entries, standing on the last one (as after a reload or an upgrade). */
function browserWith(entries: Entry[], index = entries.length - 1) {
  const browser = new FakeBrowser(entries[0].url, entries[0].state);
  browser.entries = entries.map((entry) => ({ ...entry }));
  browser.index = index;
  return browser;
}
const state = (depth: number, key: string, extra: Record<string, unknown> = {}) => ({ sonderDepth: depth, sonderRoot: null, sonderKey: key, ...extra });

test("an old entry without the app's state reached by Back is not taken as one on top: its back button goes to its parent", async () => {
  // An older build: a reader opened by a link (another site behind it), closed forward to Discover; this build loads there.
  const browser = browserWith([{ url: "/#reader/e1", state: null }, { url: "/#discover", state: null }]);
  const nav = await load(browser);
  browser.traverse(-1);
  await until(() => browser.index === 0 && browser.url.hash === "#reader/e1", "the old reader entry");
  await settle();
  assert.equal((browser.entries[0].state as { sonderDepth: number }).sonderDepth, 0);
  // Nothing of the app is known to lie behind it: Close shows the Library in its place instead of leaving the app.
  nav.goBack();
  await settle();
  assert.deepEqual(browser.hashes, ["#library", "#discover"]);
  assert.equal(browser.index, 0);
});

test("a back button whose Back lands nowhere goes to the page's parent, and counts from there", async () => {
  // The entries behind this reader were thrown away (Firefox keeps 50), but its state still says two lie behind.
  const browser = browserWith([{ url: "/#reader/e1", state: state(2, "r") }]);
  const nav = await load(browser);
  nav.goBack();
  await settle();
  assert.equal(browser.url.hash, "#reader/e1", "it waits for the Back first");
  const hash = () => browser.url.hash;
  for (let i = 0; i < 100 && hash() !== "#library"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(browser.url.hash, "#library");
  assert.equal(browser.entries.length, 1);
  assert.equal((browser.entries[0].state as { sonderDepth: number }).sonderDepth, 0);
});

test("where the browser says there is nothing behind (the Navigation API), the back button goes to the parent at once", async () => {
  const browser = browserWith([{ url: "/#reader/e1", state: state(3, "r") }]);
  const nav = await load(browser);
  const g = globalThis as Record<string, unknown>;
  g.navigation = { canGoBack: false };
  try {
    nav.goBack();
    assert.equal(browser.url.hash, "#library");
  } finally {
    delete g.navigation;
  }
});

test("a scroll restoration that waits stops when the user scrolls, touches or types", async () => {
  for (const input of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    const browser = new FakeBrowser("/#library");
    const nav = await load(browser);
    browser.scrollY = 3000;
    nav.goPlace("settings");
    browser.scrollHeight = 1000;
    nav.goBack();
    await until(() => browser.url.hash === "#library", "#library");
    await settle();
    browser.scrollY = 100;
    browser.dispatch(input, { state: null });
    browser.scrollHeight = 5000;
    await settle();
    await settle();
    assert.equal(browser.scrollY, 100, `${input} ends the wait`);
  }
});

test("a scroll restoration that waits never runs on a reader reached by Forward", async () => {
  const browser = browserWith([
    { url: "/#library", state: state(0, "l", { sonderRoot: 0, sonderScroll: 1200 }) },
    { url: "/#reader/e1", state: state(1, "r", { sonderRoot: 0 }) },
  ]);
  await load(browser);
  browser.scrollHeight = 1000;
  browser.traverse(-1);
  await until(() => browser.url.hash === "#library", "#library");
  await settle();
  browser.traverse(1);
  await until(() => browser.url.hash === "#reader/e1", "#reader/e1");
  browser.scrollHeight = 5000;
  await settle();
  await settle();
  assert.equal(browser.scrollY, 0);
});

test("a list that does not grow back in time is left alone rather than set to a wrong offset", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  browser.scrollY = 3000;
  nav.goPlace("settings");
  browser.scrollHeight = 1000;
  nav.goBack();
  await until(() => browser.url.hash === "#library", "#library");
  const restore = await import("../src/navigation.ts");
  await new Promise((resolve) => setTimeout(resolve, restore.RESTORE_WAIT_MS + 100));
  assert.equal(browser.scrollY, 0);
  browser.scrollHeight = 5000;
  await settle();
  assert.equal(browser.scrollY, 0);
});

test("Discover starts at its top after Back: its results are gone, so an old offset would point into another list", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  browser.scrollY = 900;
  nav.goPlace("library");
  browser.scrollY = 400;
  nav.goBack();
  await until(() => browser.url.hash === "#discover", "#discover");
  await settle();
  assert.equal(browser.scrollY, 0);
});

test("Now playing has an entry of its own: Back closes it and leaves the page where it was", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  browser.scrollY = 900;
  nav.openSheet("now-playing");
  assert.equal(nav.shownSheet(), "now-playing");
  // It keeps the page's address and names itself in its state.
  assert.deepEqual(browser.hashes, ["#library", "#library"]);
  assert.equal((browser.entries[1].state as { sonderSheet?: string }).sonderSheet, "now-playing");
  assert.equal(browser.scrollY, 900);
  nav.openSheet("now-playing");
  assert.equal(browser.entries.length, 2, "opening it again adds nothing");
  browser.traverse(-1);
  await until(() => browser.index === 0, "the page's entry");
  await settle();
  assert.equal(nav.shownSheet(), null);
  assert.equal(browser.scrollY, 900);
  // Forward opens it again.
  browser.traverse(1);
  await until(() => nav.shownSheet() === "now-playing", "Forward");
});

test("closing Now playing with its own control goes back, and a move asked for right after waits for that Back", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  nav.openSheet("now-playing");
  nav.closeSheet("now-playing");
  // "Manage device downloads": close, then open Activity (Downloads' place since #516) in the same moment.
  nav.navigate({ name: "activity", part: "now" });
  await until(() => browser.url.hash === "#activity", "#activity");
  await settle();
  assert.deepEqual(browser.hashes, ["#library", "#activity"]);
  assert.equal(nav.shownSheet(), null);
  nav.goBack();
  await until(() => browser.url.hash === "#library" && browser.index === 0, "#library");
});

test("a reload with Now playing open shows the page without it, on the page's own entry", async () => {
  const browser = new FakeBrowser("/#library");
  let nav = await load(browser);
  nav.goPlace("discover");
  nav.openSheet("now-playing");
  nav = await load(browser);
  assert.equal(nav.shownSheet(), null);
  await until(() => browser.index === 1, "the page's entry");
  assert.equal(browser.url.hash, "#discover");
  nav.goBack();
  await until(() => browser.url.hash === "#library", "#library");
});

test("a sheet opened on the first entry closes back to that entry", async () => {
  const browser = browserWith([{ url: "/#library", state: state(0, "l", { sonderRoot: 0 }) }]);
  const nav = await load(browser);
  // Its entry is pushed, so it always has the page's entry behind it; closing it there goes back to it.
  nav.openSheet("now-playing");
  nav.closeSheet("now-playing");
  await until(() => browser.index === 0, "the page's entry");
  assert.equal(nav.shownSheet(), null);
});

test("the shell hears of a page left by Back or Forward, not of its own moves or of a reader closing", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  const heard: string[] = [];
  nav.onPageLeftByHistory((page) => heard.push(page.name));
  nav.goPlace("discover");
  nav.navigate({ name: "reader", ebookId: "e1" });
  assert.deepEqual(heard, []);
  nav.goBack();
  await until(() => browser.url.hash === "#discover", "#discover");
  await settle();
  assert.deepEqual(heard, [], "the reader covered Discover, which stayed");
  browser.traverse(-1);
  await until(() => browser.url.hash === "#library", "#library");
  await settle();
  assert.deepEqual(heard, ["library"]);
});

test("a scroll restoration that waits stops when the app moves to another page", async () => {
  const browser = new FakeBrowser("/#library");
  const nav = await load(browser);
  browser.scrollY = 3000;
  nav.goPlace("settings");
  browser.scrollHeight = 1000;
  nav.goBack();
  await until(() => browser.url.hash === "#library", "#library");
  await settle();
  // The Library is still short, so its position waits; the user opens Discover meanwhile.
  nav.goPlace("discover");
  assert.equal(browser.scrollY, 0);
  browser.scrollHeight = 5000;
  await settle();
  await settle();
  assert.equal(browser.scrollY, 0);
});

test("a Back that lands after its fallback ran does not move the page a second time", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  const { BACK_WAIT_MS } = nav;
  nav.navigate({ name: "reader", ebookId: "e1" });
  const heard: string[] = [];
  nav.onPageLeftByHistory((page) => heard.push(page.name));
  // The browser takes longer than the app waits: the fallback shows the reader's parent, the Library.
  browser.delay = BACK_WAIT_MS + 200;
  nav.goBack();
  await until(() => browser.url.hash === "#library", "the fallback's #library");
  assert.deepEqual(browser.hashes, ["#discover", "#library"]);
  // Then the Back lands on Discover after all; the app returns to the entry it shows.
  browser.delay = 0;
  await until(() => browser.landed.length === 2, "the late Back, and the way back");
  await settle();
  assert.deepEqual(browser.landed, ["#discover", "#library"]);
  assert.equal(browser.url.hash, "#library");
  assert.deepEqual(browser.hashes, ["#discover", "#library"]);
  assert.deepEqual(heard, [], "the page did not move again");
  // The phone's Back from there is the user's own and moves the page.
  browser.traverse(-1);
  await until(() => heard.length === 1, "the user's Back");
  assert.deepEqual(heard, ["discover"]);
  assert.equal(browser.url.hash, "#discover");
});

test("a move queued behind a late Back runs once, and the late Back moves nothing afterwards", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  const { BACK_WAIT_MS } = nav;
  nav.navigate({ name: "reader", ebookId: "e1" });
  browser.delay = BACK_WAIT_MS + 200;
  nav.goBack();
  // A move asked for while the Back is on its way waits for it, and runs after the fallback.
  nav.goPlace("settings");
  assert.deepEqual(browser.hashes, ["#discover", "#reader/e1"]);
  await until(() => browser.url.hash === "#settings", "the queued #settings");
  assert.deepEqual(browser.hashes, ["#discover", "#library", "#settings"]);
  browser.delay = 0;
  // The late Back lands on the Library, one entry behind Settings; the app returns to Settings.
  await until(() => browser.landed.length === 2, "the late Back, and the way back");
  assert.deepEqual(browser.landed, ["#library", "#settings"]);
  await new Promise((resolve) => setTimeout(resolve, BACK_WAIT_MS + 100));
  assert.deepEqual(browser.hashes, ["#discover", "#library", "#settings"], "the queued move ran once");
  assert.equal(browser.index, 2);
  assert.equal(browser.url.hash, "#settings");
});

test("a Back long after a fallback ran is the user's own, and moves the page", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  const { BACK_WAIT_MS, LATE_BACK_MS } = nav;
  nav.navigate({ name: "reader", ebookId: "e1" });
  // A Back the browser never makes: the traversal is lost, the fallback shows the Library.
  const go = history.go;
  history.go = () => {};
  nav.goBack();
  await until(() => browser.url.hash === "#library", "the fallback's #library");
  history.go = go;
  await new Promise((resolve) => setTimeout(resolve, LATE_BACK_MS + 50));
  const heard: string[] = [];
  nav.onPageLeftByHistory((page) => heard.push(page.name));
  browser.traverse(-1);
  await until(() => browser.index === 0, "the user's Back");
  await new Promise((resolve) => setTimeout(resolve, BACK_WAIT_MS / 4));
  assert.equal(browser.index, 0);
  assert.deepEqual(heard, ["discover"]);
});

test("when the way back from a late Back is late too, the entry the browser stands on shows the page, and nothing bounces", async () => {
  const browser = new FakeBrowser("/#discover");
  const nav = await load(browser);
  const { BACK_WAIT_MS } = nav;
  nav.navigate({ name: "reader", ebookId: "e1" });
  const heard: string[] = [];
  nav.onPageLeftByHistory((page) => heard.push(page.name));
  // Every traversal takes longer than the app waits.
  browser.delay = BACK_WAIT_MS + 200;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Traversals that kept bouncing would outlive the test: the fake stops when it ends.
  try {
    nav.goBack();
    // t = 1000: the fallback shows the Library; t = 1200: the Back lands on Discover, and the app asks to go forward.
    await wait(BACK_WAIT_MS + 300);
    assert.deepEqual(browser.landed, ["#discover"]);
    assert.equal(browser.url.hash, "#discover");
    // t = 2200: the way back is late too, and its fallback writes the shown page into the entry the browser stands on.
    await wait(BACK_WAIT_MS);
    assert.equal(browser.url.hash, "#library");
    // t = 2400: it lands, on an entry that shows the same page; it is not taken as a late Back to undo.
    await until(() => browser.landed.length === 2, "the late way back");
    await new Promise((resolve) => setTimeout(resolve, BACK_WAIT_MS + 400));
    assert.deepEqual(browser.landed, ["#discover", "#library"]);
    assert.equal(browser.url.hash, "#library");
    assert.deepEqual(heard, []);
  } finally {
    live = null;
  }
});

test("the back button is told where it goes: the entry behind when the app made it, else the page's parent", async () => {
  const browser = new FakeBrowser("/#gallery");
  let nav = await load(browser);
  nav.navigate({ name: "gallery-child" });
  assert.deepEqual(nav.backTarget(), { name: "gallery" });
  // Opened from Discover, a page goes back to Discover, not to its parent.
  nav.goPlace("discover");
  nav.navigate({ name: "gallery-child" });
  assert.deepEqual(nav.backTarget(), { name: "discover" });
  // A replacing move keeps the entry behind.
  nav.navigate({ name: "gallery" }, { replace: true });
  assert.deepEqual(nav.backTarget(), { name: "discover" });
  // A reload keeps it, from the entry's state.
  nav = await load(browser);
  assert.deepEqual(nav.backTarget(), { name: "discover" });
  // After Back, the entry reached names its own one behind: the child page Discover was opened from.
  nav.goBack();
  await until(() => browser.url.hash === "#discover", "#discover");
  assert.deepEqual(nav.backTarget(), { name: "gallery-child" });
});

test("a page opened by a link names its parent, and its back button lands there in place", async () => {
  const browser = new FakeBrowser("/#gallery/child");
  const nav = await load(browser);
  assert.deepEqual(nav.backTarget(), { name: "gallery" });
  nav.goBack();
  await settle();
  assert.deepEqual(browser.hashes, ["#gallery"]);
  // A link the browser added on top counts the page it was followed from as the one behind.
  browser.followHash("#gallery/child");
  await settle();
  assert.deepEqual(nav.backTarget(), { name: "gallery" });
  nav.goPlace("discover");
  browser.followHash("#gallery/child");
  await settle();
  assert.deepEqual(nav.backTarget(), { name: "discover" });
});

test("an older build's entry behind names no address: the back button names the page's parent", async () => {
  const browser = new FakeBrowser("/#discover", { sonderDepth: 0, sonderRoot: 0, sonderKey: "old0" });
  browser.entries.push({ url: "/#gallery/child", state: { sonderDepth: 1, sonderRoot: null, sonderKey: "old1" } });
  browser.index = 1;
  const nav = await load(browser);
  assert.deepEqual(nav.backTarget(), { name: "gallery" });
  nav.goBack();
  await until(() => browser.url.hash === "#discover", "#discover");
});
