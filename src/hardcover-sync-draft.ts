import type { HardcoverState } from "./types";

export type SyncPreferences = Pick<HardcoverState, "mode" | "syncLists">;

/**
 * The saved sync preferences the Settings form must take from a Hardcover state that arrived, or null when the
 * form keeps what it shows (#422). The form is a draft: it follows the server's saved preferences when they first
 * arrive and whenever they change. A refresh that returns the same saved preferences (the token save and the
 * settings reload each refresh, and the page refreshes once a minute) must not touch the form at all: writing the
 * draft back from the effect is not harmless, because React runs a pending effect before it renders a change
 * event, so the effect's draft is the value from before the user's pick.
 */
export function savedPreferencesToFollow(previous: SyncPreferences | null, saved: SyncPreferences): SyncPreferences | null {
  if (previous && previous.mode === saved.mode && previous.syncLists === saved.syncLists) return null;
  return { mode: saved.mode, syncLists: saved.syncLists };
}
