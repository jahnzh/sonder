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
  parentOf,
  placeOf,
  readAddress,
  resolve,
  sameRoute,
  step,
  writeAddress,
} from "./routes";

type Entry = {
  route: Route;
  /** How many of the app's own entries lie behind this one. */
  depth: number;
  /** Depth of the current place's first page, when it lies behind with only this place's pages after it. */
  root: number | null;
  /** Names the entry for its scroll position. */
  key: string;
};
type EntryState = { sonderDepth: number; sonderRoot: number | null; sonderKey: string; sonderScroll?: number };

let current: Entry | null = null;
let admin = false;
let listening = false;
const listeners = new Set<() => void>();
/** Scroll positions of entries left by Back or Forward, whose own state can no longer be written. */
const scrolls = new Map<string, number>();
let restoring = 0;
/** Set while a Back the app asked for is on its way, so a second close before it lands does not go back twice. */
let leaving: ReturnType<typeof setTimeout> | null = null;

const newKey = () => Math.random().toString(36).slice(2, 10);
const urlOf = (route: Route) => `${location.pathname}${location.search}${writeAddress(route)}`;

function stateOf(entry: Entry, scroll?: number): EntryState {
  return { sonderDepth: entry.depth, sonderRoot: entry.root, sonderKey: entry.key, ...(scroll === undefined ? {} : { sonderScroll: scroll }) };
}
function entryState(state: unknown): EntryState | null {
  const s = state as Partial<EntryState> | null;
  return s && typeof s.sonderDepth === "number" && typeof s.sonderKey === "string" ? (s as EntryState) : null;
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
function restoreScroll(y: number) {
  const token = ++restoring;
  const deadline = performance.now() + 2000;
  const tick = () => {
    if (token !== restoring) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    // The page under the address renders after the change; wait until it is tall enough to hold the position.
    if (max >= y || performance.now() > deadline) window.scrollTo(0, Math.max(0, Math.min(y, max)));
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function onPopState(event: PopStateEvent) {
  if (leaving) clearTimeout(leaving);
  leaving = null;
  if (!current) return;
  // Scroll restoration is manual, so the page still stands where the entry being left had it.
  scrolls.set(current.key, window.scrollY);
  const route = resolve(readAddress(location.hash), { admin });
  const saved = entryState(event.state);
  const entry: Entry = saved
    ? { route, depth: saved.sonderDepth, root: saved.sonderRoot, key: saved.sonderKey }
    : // An address the app did not write (a link, a typed address): the browser added an entry on top.
      { route, depth: current.depth + 1, root: rootAfter(current, route, current.depth + 1, "push"), key: newKey() };
  current = entry;
  if (!saved || writeAddress(route) !== location.hash) history.replaceState(stateOf(entry), "", urlOf(route));
  emit();
  if (!coversPage(route)) restoreScroll(scrolls.get(entry.key) ?? saved?.sonderScroll ?? 0);
}
function onPageHide() {
  if (current) history.replaceState(stateOf(current, window.scrollY), "");
}

/**
 * Reads the address the page was opened on, for a signed-in user: called by the shell before it renders a page.
 * An address that names nothing, a page not built yet or another user's administrator page is replaced by
 * what it shows. A reload keeps its entry's depth, so the back button still knows what lies behind.
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
  };
  const first = !current;
  current = entry;
  if (!saved || writeAddress(route) !== location.hash) history.replaceState(stateOf(entry), "", urlOf(route));
  if (!listening) {
    listening = true;
    history.scrollRestoration = "manual";
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pagehide", onPageHide);
  }
  if (first && saved?.sonderScroll) restoreScroll(saved.sonderScroll);
  emit();
}
function ensure(): Entry {
  if (!current) startNavigation({ admin });
  return current!;
}

/** Moves to a route: adds an entry or replaces the current one as routes.step says, or as asked. */
export function navigate(to: Route, options: { replace?: boolean } = {}) {
  const from = ensure();
  const route = resolve(to, { admin });
  const kind = options.replace ? "replace" : step(from.route, route);
  if (kind === "none") return;
  if (kind === "push") {
    // The entry being left keeps its scroll position for Back, in its own state so a reload keeps it too.
    scrolls.set(from.key, window.scrollY);
    history.replaceState(stateOf(from, window.scrollY), "");
    const depth = from.depth + 1;
    current = { route, depth, root: rootAfter(from, route, depth, "push"), key: newKey() };
    history.pushState(stateOf(current), "", urlOf(route));
    restoring++;
    if (!coversPage(route)) window.scrollTo(0, 0);
  } else {
    current = { route, depth: from.depth, root: rootAfter(from, route, from.depth, "replace"), key: newKey() };
    history.replaceState(stateOf(current), "", urlOf(route));
  }
  emit();
}

/** A page's own back button: back in history, or to the page's parent when no entry of the app lies behind. */
export function goBack(fallback?: Route) {
  const entry = ensure();
  if (leaving) return;
  if (entry.depth > 0) {
    leaving = setTimeout(() => (leaving = null), 1000);
    history.back();
  } else navigate(fallback ?? parentOf(entry.route) ?? firstPage(placeOf(entry.route)), { replace: true });
}

/**
 * The tab bar and the rail. Another place adds an entry. The current place returns to its first page:
 * back to it when it lies behind, otherwise by moving there.
 */
export function goPlace(place: Place) {
  const entry = ensure();
  const first = firstPage(place);
  if (placeOf(entry.route) === place && !sameRoute(entry.route, first) && entry.root !== null && entry.root < entry.depth) {
    history.go(entry.root - entry.depth);
    return;
  }
  navigate(first);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => ensure();

/** The current address for a screen, and the ways to move. */
export function useAddress() {
  const entry = useSyncExternalStore(subscribe, snapshot);
  return { route: entry.route, canGoBack: entry.depth > 0, navigate, goBack, goPlace };
}
