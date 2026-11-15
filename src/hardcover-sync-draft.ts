import type { HardcoverState } from "./types";

export type SyncPreferences = Pick<HardcoverState, "mode" | "syncLists">;

/**
 * The sync preferences the Settings form shows after a Hardcover state arrives (#422). The form is a draft:
 * it takes the server's saved preferences when they first arrive and whenever they change, and otherwise keeps
 * what the user picked. A refresh that returns the same saved preferences (the token save and the settings
 * reload each refresh, and the page refreshes once a minute) must not undo an unsaved choice.
 */
export function followSavedPreferences(
  draft: SyncPreferences,
  previous: SyncPreferences | null,
  saved: SyncPreferences,
): SyncPreferences {
  if (previous && previous.mode === saved.mode && previous.syncLists === saved.syncLists) return draft;
  return { mode: saved.mode, syncLists: saved.syncLists };
}
