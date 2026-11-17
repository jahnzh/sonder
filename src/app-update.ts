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

/** Reloads into the new build: pauses, lets the page save its place, waits for queued progress, then reloads. */
export async function reloadForUpdate(pause: () => void): Promise<void> {
  pause();
  window.dispatchEvent(new Event("pagehide"));
  await localDB.progress.toArray();
  location.reload();
}
