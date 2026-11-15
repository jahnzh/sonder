import type { LyricsLine } from "./lyrics-lines";

/** The lines Lyrics mode renders: indices `from` (inclusive) to `to` (exclusive) of the book's lines (#428). */
export type LyricsWindow = { from: number; to: number };

/** Lines kept before and after the line a window is placed around. */
export const LINES_BEFORE = 50;
export const LINES_AFTER = 100;
/** A line closer than this to an edge that has more lines beyond it places the window again. */
export const EDGE_LINES = 15;
/** Lines added at an edge the reader scrolls towards, and the most lines a window holds. */
export const EXTEND_LINES = 60;
export const MAX_LINES = 300;

/** A window placed around `anchor`. */
export function windowAround(anchor: number, length: number): LyricsWindow {
  const at = Math.max(0, Math.min(length - 1, anchor));
  return { from: Math.max(0, at - LINES_BEFORE), to: Math.min(length, at + LINES_AFTER + 1) };
}

/** Whether `index` lies in the window with room around it, or at an edge of the book. */
export function windowHolds(window: LyricsWindow, index: number, length: number): boolean {
  if (index < window.from || index >= window.to) return false;
  if (window.from > 0 && index < window.from + EDGE_LINES) return false;
  if (window.to < length && index >= window.to - EDGE_LINES) return false;
  return true;
}

/** The window that shows `anchor`: the same one when it already holds it, otherwise one placed around it. */
export function windowFor(window: LyricsWindow, anchor: number, length: number): LyricsWindow {
  if (!length) return { from: 0, to: 0 };
  return windowHolds(window, anchor, length) && window.to <= length ? window : windowAround(anchor, length);
}

/** The window with more lines at the edge being scrolled towards; past MAX_LINES the far edge drops lines. */
export function extendWindow(window: LyricsWindow, edge: "start" | "end", length: number): LyricsWindow {
  if (edge === "start") {
    const from = Math.max(0, window.from - EXTEND_LINES);
    return { from, to: Math.min(window.to, from + MAX_LINES) };
  }
  const to = Math.min(length, window.to + EXTEND_LINES);
  return { from: Math.max(window.from, to - MAX_LINES), to };
}

/** The first line of every paragraph; a paragraph's lines are consecutive. */
export function firstLines(lines: LyricsLine[]): Map<string, number> {
  const first = new Map<string, number>();
  lines.forEach((line, index) => {
    if (!first.has(line.paragraphId)) first.set(line.paragraphId, index);
  });
  return first;
}

/** The narrated line: the last line of the narrated paragraph that starts at or before `fraction`; -1 without one. */
export function activeLine(lines: LyricsLine[], first: Map<string, number>, paragraphId: string | undefined, fraction: number): number {
  if (!paragraphId) return -1;
  const start = first.get(paragraphId);
  if (start === undefined) return -1;
  let active = -1;
  for (let index = start; index < lines.length && lines[index].paragraphId === paragraphId; index++)
    if (lines[index].fraction <= fraction) active = index;
  return active;
}
