// The preview of a recording cached on TorBox in the Get audiobook sheet (#889; issue comment "Design discussion,
// 24 Nov 2026"): what its button says and whether it can be pressed, the footer's line about it, where it starts and
// how long it plays. Pure: no React, no audio element.
import type { AudiobookRelease } from "../types";

/** A preview stops by itself after this much played. */
export const PREVIEW_SECONDS = 120;
/** A file longer than this starts at PREVIEW_FROM; a shorter one from its start. */
export const PREVIEW_LONG_FILE = 6 * 60;
export const PREVIEW_FROM = 3 * 60;
/** Nothing sounds this long after the seek: the preview starts again from the file's start. */
export const PREVIEW_SILENT_MS = 5000;
/** The server ends a preview 30 minutes after it was made; the sheet asks for a new one before that. */
export const PREVIEW_KEEP_MS = 25 * 60_000;

export const PAUSE_THE_BOOK = "Pause the book to preview.";
export const NOT_PREVIEWED = "This recording could not be previewed.";

export type PreviewPhase = "idle" | "preparing" | "playing" | "failed";

/** Where the preview starts in a file of `duration` seconds (known at `loadedmetadata`). */
export function previewStart(duration: number): number {
  return Number.isFinite(duration) && duration > PREVIEW_LONG_FILE ? PREVIEW_FROM : 0;
}

/** "0:07", "1:59": the time played, as the button shows it. */
export function previewTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Only a chosen row that says "Plays now" can be previewed. */
export function canPreview(chosen: Pick<AudiobookRelease, "cached"> | null | undefined): boolean {
  return !!chosen?.cached;
}

export type PreviewControl = {
  /** The words on the button. */
  label: string;
  disabled: boolean;
  /** The footer's line about the preview, or null. */
  line: { text: string; failed: boolean } | null;
};

/**
 * The button and its line for the chosen row, or null when the row cannot be previewed. While the book plays the
 * button is off and the line says to pause it; preparing, it says so; playing, "Stop" with the time played; after a
 * failure, the plain sentence.
 */
export function previewControl({
  chosen,
  phase,
  played,
  bookPlaying,
  online,
}: {
  chosen: Pick<AudiobookRelease, "cached"> | null | undefined;
  phase: PreviewPhase;
  played: number;
  bookPlaying: boolean;
  online: boolean;
}): PreviewControl | null {
  if (!canPreview(chosen)) return null;
  if (phase === "playing") return { label: `Stop ${previewTime(played)}`, disabled: false, line: null };
  if (phase === "preparing") return { label: "Preparing…", disabled: true, line: null };
  if (bookPlaying) return { label: "Preview", disabled: true, line: { text: PAUSE_THE_BOOK, failed: false } };
  return { label: "Preview", disabled: !online, line: phase === "failed" ? { text: NOT_PREVIEWED, failed: true } : null };
}
