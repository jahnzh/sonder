// The browser's history as the page stack (ADR 0020). Every address the app moves to goes through here;
// routes.ts says what an address means. Each entry the app makes carries its depth (how many of the app's own
// entries lie behind it) and, while the user stays in one place, the depth of that place's first page.
import { useSyncExternalStore } from "react";
import {
  type Place,
  type Route,
  coversPage,
  firstPage,
  isFirstPage,
  keepsScroll,
  parentOf,
  placeOf,
  readAddress,
  resolve,
  sameRoute,
  step,
  writeAddress,
} from "./routes";

/**
 * Something shown over the page that has an entry of its own but no address yet: Now playing (with its reader).
 * Its entry keeps the page's address and names the sheet in its state; `#listen/<work>` and `#read/<work>` come
 * with their slice.
 */
export type Sheet = "now-playing";

type Entry = {
  route: Route;
  /** How many of the app's own entries lie behind this one; 0 when that is not known. */
  depth: number;
  /** Depth of the current place's first page, when it lies behind with only this place's pages after it. */
  root: number | null;
  /** Names the entry for its scroll position. */
  key: string;
  sheet: Sheet | null;
  /** The route of the app's entry right behind this one, when the app knows it; Back goes there. */
  from: Route | null;
  /** What the page keeps in its own entry (Search's words, #590), so Back and a reload show it again. */
  data?: unknown;
};
type EntryState = {
  sonderDepth: number;
  sonderRoot: number | null;
  sonderKey: string;
  sonderScroll?: number;
  sonderSheet?: Sheet;
  /** The address of the app's entry right behind, written by this build; older entries have none. */
  sonderFrom?: string;
  /** The page's own data for this entry (see Entry.data). */
  sonderData?: unknown;
};

/** How long a Back the app asked for may take to land before the app takes it as one the browser could not make. */
export const BACK_WAIT_MS = 1000;
/**
 * How long after its fallback ran a traversal the app asked for may still land and be taken as that late traversal,
 * which then must not move the page a second time.
 */
export const LATE_BACK_MS = 3000;
/** How long a returning list may take to grow tall enough for its position; after that nothing is restored. */
export const RESTORE_WAIT_MS = 5000;

let current: Entry | null = null;
let admin = false;
let listening = false;
const listeners = new Set<() => void>();
/** Scroll positions of entries left by Back or Forward, whose own state can no longer be written. */
const scrolls = new Map<string, number>();
/** The page shown under any reader or sheet: Back to it leaves its scroll alone, since it was never left. */
let shownPage: Route | null = null;
/** history.length as last seen, to tell an entry the browser added on top from an old one reached by Back. */
let lengthSeen = 0;
/**
 * A traversal the app asked for (Back, or back to a place's first page) that has not landed yet. Moves asked for
 * meanwhile wait for it, so a close followed by a move does not move first and then lose the move to the Back.
 */
let pending: { timer: ReturnType<typeof setTimeout>; fallback: () => void; queue: (() => void)[] } | null = null;
/** A traversal whose fallback ran because it had not landed in time: if it lands after all, the app undoes it. */
let overdue: { delta: number; until: number } | null = null;
/** Set while the listeners hear of a traversal (Back, Forward, a typed address), not of a move the app made. */
let traversing = false;
/** Stops the scroll restoration that is waiting, if any. */
let stopRestoring: (() => void) | null = null;

const newKey = () => Math.random().toString(36).slice(2, 10);
const urlOf = (route: Route) => `${location.pathname}${location.search}${writeAddress(route)}`;
const covers = (entry: Entry) => coversPage(entry.route) || entry.sheet !== null;

function stateOf(entry: Entry, scroll?: number): EntryState {
  return {
    sonderDepth: entry.depth,
    sonderRoot: entry.root,
    sonderKey: entry.key,
    ...(scroll === undefined ? {} : { sonderScroll: scroll }),
    ...(entry.sheet ? { sonderSheet: entry.sheet } : {}),
    ...(entry.from ? { sonderFrom: writeAddress(entry.from) } : {}),
    ...(entry.data === undefined ? {} : { sonderData: entry.data }),
  };
}
function entryState(state: unknown): EntryState | null {
  const s = state as Partial<EntryState> | null;
  return s && typeof s.sonderDepth === "number" && typeof s.sonderKey === "string" ? (s as EntryState) : null;
}
/** The route behind, as an entry's state names it; null when it names none. */
function fromState(saved: EntryState | null): Route | null {
  return typeof saved?.sonderFrom === "string" ? resolve(readAddress(saved.sonderFrom), { admin }) : null;
}
function rootAfter(from: Entry | null, to: Route, depth: number, kind: "push" | "replace"): number | null {
  if (isFirstPage(to)) return depth;
  if (!from || placeOf(from.route) !== placeOf(to)) return null;
  // Replacing the place's first page takes it out of the history.
  return kind === "replace" && from.root === from.depth ? null : from.root;
}
function emit() {
  for (const listener of listeners) listener();
}
function show(entry: Entry) {
  current = entry;
  if (!covers(entry)) shownPage = entry.route;
}

function stopRestore() {
  const stop = stopRestoring;
  stopRestoring = null;
  stop?.();
}
/**
 * Returns the page to a saved position once it is tall enough to hold it. Anything the user does meanwhile (a
 * wheel, a touch, a key, a click) or any other move ends the wait, so it never pulls the page from under them; a
 * page that does not grow tall enough in time is left alone, since its list is not the one that was left.
 */
function restoreScroll(y: number) {
  stopRestore();
  if (y <= 0) {
    window.scrollTo(0, 0);
    return;
  }
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const deadline = performance.now() + RESTORE_WAIT_MS;
  const stop = () => {
    for (const type of inputs) window.removeEventListener(type, stopRestore, true);
  };
  stopRestoring = stop;
  for (const type of inputs) window.addEventListener(type, stopRestore, { capture: true, passive: true });
  const tick = () => {
    if (stopRestoring !== stop) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    // The page under the address renders after the change; wait until it is tall enough to hold the position.
    if (max >= y) {
      stopRestore();
      window.scrollTo(0, y);
    } else if (performance.now() > deadline) stopRestore();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
/** After moving to an entry: a page that was left gets its position back; one that stayed under a cover keeps it. */
function placeScroll(entry: Entry, before: Route | null, saved: number | undefined) {
  if (covers(entry)) return stopRestore();
  if (before && sameRoute(before, entry.route)) return stopRestore();
  if (keepsScroll(entry.route)) restoreScroll(saved ?? 0);
  else restoreScroll(0);
}

/**
 * Asks the browser to go `delta` entries; `fallback` runs when it cannot (nothing there), so no button is dead.
 * A traversal that lands after its fallback ran is undone, unless it was itself such an undoing (`undoing`).
 */
function traverse(delta: number, fallback: () => void, undoing = false) {
  const navigation = (globalThis as { navigation?: { canGoBack?: boolean } }).navigation;
  // Where the browser says so outright (the Navigation API), do not wait for a traversal that cannot happen.
  if (navigation && navigation.canGoBack === false) return fallback();
  const timer = setTimeout(() => {
    const waiting = pending;
    pending = null;
    if (!waiting) return;
    overdue = undoing ? null : { delta, until: performance.now() + LATE_BACK_MS };
    waiting.fallback();
    for (const run of waiting.queue) run();
  }, BACK_WAIT_MS);
  pending = { timer, fallback, queue: [] };
  history.go(delta);
}
/** Runs a move after the traversal on its way; true when it was put off. */
function afterPending(run: () => void): boolean {
  if (!pending) return false;
  pending.queue.push(run);
  return true;
}
/** What lies behind turned out to be nothing of the app's: the entry shows `route` and counts from 0. */
function replaceAtStart(route: Route) {
  const entry: Entry = { route, depth: 0, root: isFirstPage(route) ? 0 : null, key: newKey(), sheet: null, from: null };
  const before = shownPage;
  show(entry);
  history.replaceState(stateOf(entry), "", urlOf(route));
  emit();
  if (!covers(entry) && !(before && sameRoute(before, route))) restoreScroll(0);
}

function onPopState(event: PopStateEvent) {
  const waiting = pending;
  if (waiting) clearTimeout(waiting.timer);
  pending = null;
  const late = overdue;
  overdue = null;
  if (!current) return;
  if (late && !waiting && performance.now() <= late.until) {
    // The traversal whose fallback already moved the page (and ran the moves queued behind it) landed after all:
    // go back to the entry the app shows instead of moving the page a second time. Should that not land either,
    // the entry the browser stands on takes the shown page's place.
    lengthSeen = history.length;
    const shown = current;
    traverse(-late.delta, () => history.replaceState(stateOf(shown), "", urlOf(shown.route)), true);
    return;
  }
  // Scroll restoration is manual, so the page still stands where the entry being left had it.
  scrolls.set(current.key, window.scrollY);
  const route = resolve(readAddress(location.hash), { admin });
  const saved = entryState(event.state);
  // An entry without the app's state: one the browser added on top (a link, a typed address) makes the history
  // longer. Otherwise it is an old one reached by Back or Forward (an older build's, a typed one): what lies behind
  // it is not known, so its back button goes to its parent rather than out of the app or nowhere.
  const added = history.length > lengthSeen;
  const depth = saved ? saved.sonderDepth : added ? current.depth + 1 : 0;
  const entry: Entry = saved
    ? { route, depth, root: saved.sonderRoot, key: saved.sonderKey, sheet: saved.sonderSheet ?? null, from: fromState(saved), data: saved.sonderData }
    : {
        route,
        depth,
        root: added ? rootAfter(current, route, depth, "push") : isFirstPage(route) ? 0 : null,
        key: newKey(),
        sheet: null,
        from: added ? current.route : null,
      };
  const before = shownPage;
  show(entry);
  if (!saved || writeAddress(route) !== location.hash) history.replaceState(stateOf(entry), "", urlOf(route));
  lengthSeen = history.length;
  traversing = true;
  try {
    emit();
  } finally {
    traversing = false;
  }
  placeScroll(entry, before, scrolls.get(entry.key) ?? saved?.sonderScroll);
  if (waiting) for (const run of waiting.queue) run();
}
function onPageHide() {
  // A Back the app asked for that left the document: if the page comes back from the cache, nothing is waiting.
  if (pending) clearTimeout(pending.timer);
  pending = null;
  overdue = null;
  if (current) history.replaceState(stateOf(current, window.scrollY), "");
}

/**
 * Reads the address the page was opened on, for a signed-in user: called by the shell before it renders a page.
 * An address that names nothing, a page not built yet or another user's administrator page is replaced by
 * what it shows. A reload keeps its entry's depth, so the back button still knows what lies behind; a reload
 * with Now playing open shows the page without it, back on the page's own entry.
 */
export function startNavigation(options: { admin: boolean }) {
  admin = options.admin;
  const route = resolve(readAddress(location.hash), { admin });
  const saved = entryState(history.state);
  const depth = saved?.sonderDepth ?? 0;
  const entry: Entry = {
    route,
    depth,
    root: isFirstPage(route) ? depth : saved ? saved.sonderRoot : null,
    key: saved?.sonderKey ?? newKey(),
    sheet: null,
    from: fromState(saved),
    // A reload with Now playing open goes back to the page's entry, whose own data the browser still holds.
    data: saved?.sonderSheet ? undefined : saved?.sonderData,
  };
  const first = !current;
  show(entry);
  if (!saved || writeAddress(route) !== location.hash) history.replaceState(stateOf(entry), "", urlOf(route));
  lengthSeen = history.length;
  if (!listening) {
    listening = true;
    history.scrollRestoration = "manual";
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pagehide", onPageHide);
  }
  if (saved?.sonderSheet) {
    // The sheet's entry lies on the page's own: go back to that one, so Back afterwards does not show this page
    // again. The sheet's entry stays ahead, for Forward.
    if (depth > 0) traverse(-1, () => replaceAtStart(route));
    else history.replaceState(stateOf(entry), "");
  } else if (first && saved?.sonderScroll && keepsScroll(route) && !covers(entry)) restoreScroll(saved.sonderScroll);
  emit();
}
function ensure(): Entry {
  if (!current) startNavigation({ admin });
  return current!;
}

/** Moves to a route: adds an entry or replaces the current one as routes.step says, or as asked. */
export function navigate(to: Route, options: { replace?: boolean } = {}) {
  if (afterPending(() => navigate(to, options))) return;
  const from = ensure();
  const route = resolve(to, { admin });
  // Over a sheet, the page the sheet covers is already there: closing the sheet is the move.
  if (from.sheet && sameRoute(from.route, route) && !options.replace) return closeSheet(from.sheet);
  const kind = options.replace ? "replace" : step(from.route, route);
  if (kind === "none") return;
  stopRestore();
  if (kind === "push") {
    // The entry being left keeps its scroll position for Back, in its own state so a reload keeps it too.
    scrolls.set(from.key, window.scrollY);
    history.replaceState(stateOf(from, window.scrollY), "");
    const depth = from.depth + 1;
    const entry: Entry = {
      route,
      depth,
      root: rootAfter(from, route, depth, "push"),
      key: newKey(),
      sheet: null,
      from: from.route,
    };
    const before = shownPage;
    show(entry);
    history.pushState(stateOf(entry), "", urlOf(route));
    lengthSeen = history.length;
    if (!covers(entry) && !(before && sameRoute(before, route))) window.scrollTo(0, 0);
  } else {
    show({
      route,
      depth: from.depth,
      root: rootAfter(from, route, from.depth, "replace"),
      key: newKey(),
      sheet: null,
      from: from.from,
    });
    history.replaceState(stateOf(current!), "", urlOf(route));
  }
  emit();
}

/** Where a page's own back button lands without a traversal: the fallback, the page's parent or its place. */
function parentFor(entry: Entry, fallback?: Route): Route {
  return fallback ?? parentOf(entry.route) ?? firstPage(placeOf(entry.route));
}
/**
 * Where a page's own back button goes, for its name: the app's entry behind when there is one and its address is
 * known, otherwise the page's parent (or `fallback`). An entry of an older build behind names no address: its
 * parent is named, which is where the button lands when that entry turns out not to be the app's.
 */
export function backTarget(fallback?: Route): Route {
  const entry = ensure();
  // An entry is told what lies behind only when the app put it there, so it never has one at depth 0.
  return entry.from ?? parentFor(entry, fallback);
}

/** A page's own back button: back in history, or to the page's parent when no entry of the app lies behind. */
export function goBack(fallback?: Route) {
  const entry = ensure();
  if (pending) return;
  const parent = () => parentFor(entry, fallback);
  if (entry.depth > 0) traverse(-1, () => replaceAtStart(parent()));
  else navigate(parent(), { replace: true });
}
/**
 * Closes a sheet and the sheet it was opened over (the magnet sheet over Get audiobook, #606) to the page under
 * both: Back past the two entries when the app made them, so Back on that page reopens neither; when the sheet
 * under lies behind but nothing of the app's behind it, back to it and `page` in its place; when no sheet of the
 * app lies behind (a link), `page` in place of this entry.
 */
export function closeSheets(page: Route) {
  const entry = ensure();
  if (pending) return;
  const under = entry.depth > 0 && entry.from && coversPage(entry.from);
  if (!under) navigate(page, { replace: true });
  else if (entry.depth >= 2) traverse(-2, () => replaceAtStart(page));
  else {
    traverse(-1, () => replaceAtStart(page));
    afterPending(() => navigate(page, { replace: true }));
  }
}
/**
 * Closes the page that shows `route` (the reader, #590): back as goBack, but only while the current entry still
 * shows it. A close heard after its Back has landed (a kept-mounted dialog told of a focus outside it, with the
 * route of the render before) then moves nothing, rather than going a second step back.
 */
export function goBackFrom(route: Route, fallback?: Route) {
  const entry = ensure();
  if (!sameRoute(entry.route, route)) return;
  goBack(fallback);
}

/**
 * The tab bar and the rail. Another place adds an entry. The current place returns to its first page:
 * back to it when it lies behind, otherwise by moving there.
 */
export function goPlace(place: Place) {
  if (afterPending(() => goPlace(place))) return;
  const entry = ensure();
  const first = firstPage(place);
  if (placeOf(entry.route) === place && !sameRoute(entry.route, first) && entry.root !== null && entry.root < entry.depth) {
    traverse(entry.root - entry.depth, () => replaceAtStart(first));
    return;
  }
  navigate(first);
}

/** Opens a sheet over the current page with an entry of its own, so Back closes it. */
export function openSheet(sheet: Sheet) {
  if (afterPending(() => openSheet(sheet))) return;
  const from = ensure();
  if (from.sheet === sheet) return;
  stopRestore();
  scrolls.set(from.key, window.scrollY);
  history.replaceState(stateOf(from, window.scrollY), "");
  const entry: Entry = { route: from.route, depth: from.depth + 1, root: from.root, key: newKey(), sheet, from: from.route };
  show(entry);
  history.pushState(stateOf(entry), "", urlOf(entry.route));
  lengthSeen = history.length;
  emit();
}
/** Closes a sheet with its own control: back to the page's entry, or in place when none of the app's lies behind. */
export function closeSheet(sheet: Sheet) {
  const entry = ensure();
  if (pending || entry.sheet !== sheet) return;
  if (entry.depth > 0) traverse(-1, () => replaceAtStart(entry.route));
  else replaceAtStart(entry.route);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => ensure();

/** The current address for a screen, and the ways to move. */
export function useAddress() {
  const entry = useSyncExternalStore(subscribe, snapshot);
  return { route: entry.route, canGoBack: entry.depth > 0, backTarget, navigate, goBack, goPlace };
}
/**
 * What the current page keeps in its own entry (#590): written in place, so Back to this entry and a reload of it
 * give it back. Moving to another entry leaves it with the entry it was written to.
 */
export function setPageData(data: unknown) {
  const entry = ensure();
  if (pending) return;
  entry.data = data;
  history.replaceState(stateOf(entry), "");
}
/** The current entry's own data, as the page last wrote it; undefined when it wrote none. */
export function pageData(): unknown {
  return ensure().data;
}
/**
 * The page shown under a sheet or the reader: the route last shown in place of the page, or null when the app was
 * opened on a cover (a link to a sheet), whose parent then stands under it (#601).
 */
export function coveredPage(): Route | null {
  return shownPage;
}
/** The sheet the current entry shows, for code outside React. */
export function shownSheet(): Sheet | null {
  return ensure().sheet;
}
/** Whether a sheet is open, and opening or closing it through the history. */
export function useSheet(sheet: Sheet) {
  const entry = useSyncExternalStore(subscribe, snapshot);
  return {
    open: entry.sheet === sheet,
    setOpen: (open: boolean) => (open ? openSheet(sheet) : closeSheet(sheet)),
  };
}
/**
 * Calls `listener` after Back, Forward or any other traversal of the history changed the page under any cover,
 * with the page now shown. The shell closes its dialogs then: they belonged to the page that was left.
 */
export function onPageLeftByHistory(listener: (page: Route) => void) {
  let last = shownPage;
  const check = () => {
    const now = shownPage;
    const changed = now && last && !sameRoute(now, last);
    last = now;
    if (changed && traversing) listener(now);
  };
  listeners.add(check);
  return () => {
    listeners.delete(check);
  };
}
