// The shell's connection (spec #572, "The shell"; #581): whether the offline line shows. There is no connection while
// the browser says it is offline, or while the app's last request got no answer at all (a request that was refused
// or answered with an error was answered, so it is a connection). Free of React and the DOM so it is testable in
// Node; `api()` in lib.ts reports each request's outcome here.
import type { Route } from "./routes";

export type ConnectionState = { browserOnline: boolean; reached: boolean };

/** No connection: the browser is offline, or the last request got no answer. */
export function offline(state: ConnectionState): boolean {
  return !state.browserOnline || !state.reached;
}

/**
 * A page that says "No connection" itself has no offline line (spec #572: Activity's sections, #458): every part of
 * Activity and a worker's page, a series (its own No connection card, #568) and Reading sync (its No connection
 * line).
 */
export function saysNoConnectionItself(route: Route): boolean {
  switch (route.name) {
    case "activity":
    case "worker":
    case "series":
    case "series-add":
    case "sync-details":
      return true;
    case "book-page":
      return route.page === "sync";
    default:
      return false;
  }
}

/** The offline line is shown: no connection, on a place or page that does not say so itself. */
export function offlineLineShown(state: ConnectionState, route: Route): boolean {
  return offline(state) && !saysNoConnectionItself(route);
}

/** A failed `fetch` that means no answer: not one this tab aborted itself. */
export function isNoAnswer(error: unknown): boolean {
  return !(error instanceof Error && error.name === "AbortError");
}

type Listener = (state: ConnectionState) => void;

/** One store for the tab: `api()` reports to it, the shell reads it. */
export function connectionStore(initialOnline: boolean) {
  let state: ConnectionState = { browserOnline: initialOnline, reached: true };
  const listeners = new Set<Listener>();
  const set = (next: ConnectionState) => {
    if (next.browserOnline === state.browserOnline && next.reached === state.reached) return;
    state = next;
    for (const listener of listeners) listener(state);
  };
  return {
    get: () => state,
    /** A request was answered, whatever its status. */
    answered: () => set({ ...state, reached: true }),
    /** A request got no answer. */
    unanswered: () => set({ ...state, reached: false }),
    /** The browser's `online` and `offline` events. */
    browser: (online: boolean) => set({ ...state, browserOnline: online }),
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type ConnectionStore = ReturnType<typeof connectionStore>;

export const connection = connectionStore(typeof navigator === "undefined" ? true : navigator.onLine);
