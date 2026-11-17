// Follow the narration (Settings › Playback; board SettingsPlayback.dc.html): whether the reader starts out following
// the sentence being read aloud. Kept on this device for the signed-in account; on unless it was turned off. The
// reader's own switch still pages away or follows again while it is open.
import { useSyncExternalStore } from "react";
import { userStorageKey } from "./lib";

const KEY = "sonder-follow-narration";
const listeners = new Set<() => void>();

export function followsNarration(): boolean {
  return localStorage.getItem(userStorageKey(KEY)) !== "off";
}
export function setFollowsNarration(on: boolean) {
  localStorage.setItem(userStorageKey(KEY), on ? "on" : "off");
  for (const listener of listeners) listener();
}
export function useFollowsNarration(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    followsNarration,
  );
}
