// Whether a newer build of the app is on the server (`/build.json`), checked once a minute and when the app comes
// back into view. One check for the whole app: the update notice (AppUpdate.tsx) and Settings › App read it.
import { useSyncExternalStore } from "react";
import { localDB } from "./lib";

declare const __SONDER_BUILD_ID__: string;

/** The build this tab runs. */
export const runningBuild = (): string => (typeof __SONDER_BUILD_ID__ === "string" ? __SONDER_BUILD_ID__ : "");

let available: string | null = null;
let started = false;
const listeners = new Set<() => void>();

function set(next: string | null) {
  if (next === available) return;
  available = next;
  for (const listener of listeners) listener();
}

async function check() {
  if (!navigator.onLine || document.visibilityState === "hidden") return;
  try {
    const response = await fetch("/build.json", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const build = await response.json();
    if (typeof build?.id === "string" && build.id !== runningBuild()) set(build.id);
  } catch {
    // Offline or a slow server: the next check tries again.
  }
}

/** Starts the checks (once). The development server has no build.json of its own build. */
function start() {
  if (started || !import.meta.env.PROD) return;
  started = true;
  void check();
  setInterval(() => void check(), 60000);
  const again = () => void check();
  window.addEventListener("focus", again);
  window.addEventListener("online", again);
  document.addEventListener("visibilitychange", again);
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The id of the newer build on the server, or null while this tab is up to date. */
export function useAvailableUpdate(): string | null {
  return useSyncExternalStore(subscribe, () => available);
}

// The notice's dismissal, one for the app's notice and the reader's message (#591): dismissed, the build's notice
// stays away until the app starts again; Settings › App still says an update is ready.
let dismissed: string | null = null;
// Claims on the notice: a reader on screen (the update is its message in the foot) or Settings › App (its Updates row
// has Reload, #733). While one holds, the app's notice stays away.
let claims = 0;
const notify = () => {
  for (const listener of listeners) listener();
};

/** Dismisses the notice of `build` until the app starts again. */
export function dismissUpdate(build: string) {
  if (dismissed === build) return;
  dismissed = build;
  notify();
}

/** The newer build whose notice is due: available and not dismissed. */
export function useUpdateNotice(): string | null {
  return useSyncExternalStore(subscribe, () => (available && available !== dismissed ? available : null));
}

/** A reader on screen or Settings › App takes the update notice; the returned function gives it back. */
export function claimUpdateNotice(): () => void {
  claims += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims -= 1;
    notify();
  };
}

/** Whether a reader on screen or Settings › App shows the update instead of the app's notice. */
export function useUpdateNoticeClaimed(): boolean {
  return useSyncExternalStore(subscribe, () => claims > 0);
}

/** Reloads into the new build: pauses, lets the page save its place, waits for queued progress, then reloads. */
export async function reloadForUpdate(pause: () => void): Promise<void> {
  pause();
  window.dispatchEvent(new Event("pagehide"));
  await localDB.progress.toArray();
  location.reload();
}
