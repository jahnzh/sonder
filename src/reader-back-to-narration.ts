// What Back to narration does (#592, spec #586 "The More sheet goes"): the button in the foot and `F` take the same
// answer. With a narrated sentence for the recording in the player it follows that sentence, as before; with none
// (no map for the recording, or a position before the map's first sentence) the administrator's Back to narration
// locates the passage from the audio (`/api/alignments/recover`, once the More sheet's Read from audio); for anyone
// else it is off, as is the button while the reader already follows or while a locating runs.

export type BackToNarration = "follow" | "locate" | null;

export type BackToNarrationState = {
  /** The player holds a recording of this book. */
  narration: boolean;
  /** The map for that recording has a narrated sentence at the player's position. */
  sentence: boolean;
  /** The reader follows the narration already. */
  following: boolean;
  /** The account is the administrator: only it may run speech recovery. */
  admin: boolean;
  /** A locating is still running. */
  locating: boolean;
};

/** What Back to narration does now, or null when it is off. */
export function backToNarration(state: BackToNarrationState): BackToNarration {
  if (!state.narration || state.locating) return null;
  if (state.sentence) return state.following ? null : "follow";
  return state.admin ? "locate" : null;
}
