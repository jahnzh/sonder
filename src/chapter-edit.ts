// A recording's chapters on the book's Edit page (#719 part c): the words and the pure steps between the server's
// answer (`GET /api/recordings/<id>/chapters`, `RecordingChapters`) and what the page sends (`PUT` of the same
// address). Starts are seconds from the recording's beginning, over its files. The screen is src/pages/edit-page.tsx.
import type { RecordingChapter, RecordingChapters } from "./types";

export const CHAPTERS_CAPTION = "Chapters";
export const EDIT_CHAPTERS = "Edit chapters";
export const ADD_CHAPTER = "Add a chapter";
export const SHIFT_LABEL = "Shift all by seconds";
export const SHIFT = "Shift";
export const LOOK_UP_CHAPTERS = "Look up chapters";
export const LOOKING_UP = "Looking up chapters";
export const ASIN_LABEL = "ASIN";
export const USE_CHAPTERS = "Use these chapters";
export const SAVE_CHAPTERS = "Save chapters";
export const CHAPTERS_SAVED = "Chapters saved";
export const REVERTED_CHAPTERS = "The files' chapters are back";
export const NO_CHAPTER_CHANGES = "No changes";
export const FROM_FILES = "From the files";
export const START_LABEL = "Start";
export const TITLE_LABEL = "Title";
export const LENGTH_UNKNOWN_LINE = "Every file's length must be known to place chapters over the files: play each file once.";

/** What the page holds while chapters are edited: starts as typed. */
export type ChapterDraft = { title: string; start: string }[];

/** `h:mm:ss`, with tenths when the start has them. */
export function formatStart(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const whole = Math.floor(tenths / 10),
    fraction = tenths % 10;
  const h = Math.floor(whole / 3600),
    m = Math.floor((whole % 3600) / 60),
    s = whole % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
}
/** A start as typed (`1:02:03`, `62:03`, `3723`, with a decimal fraction or not) in seconds; null when it is none. */
export function parseStart(text: string): number | null {
  const clean = text.trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:[.,]\d+)?$/.test(clean)) return null;
  const [main, fraction = ""] = clean.replace(",", ".").split(".");
  const parts = main.split(":").map(Number);
  if (parts.slice(1).some((part) => part > 59)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0) + (fraction ? Number(`0.${fraction}`) : 0);
  return Math.round(seconds * 1000) / 1000;
}

export const draftOfChapters = (chapters: RecordingChapter[]): ChapterDraft => chapters.map((chapter) => ({ title: chapter.title, start: formatStart(chapter.start) }));

/** The draft as chapters, sorted; or the first problem with it, in words. */
export function chaptersOfDraft(draft: ChapterDraft, duration: number): { chapters: RecordingChapter[] } | { problem: string } {
  const chapters: RecordingChapter[] = [];
  for (const [index, row] of draft.entries()) {
    const title = row.title.trim();
    if (!title) return { problem: `Name chapter ${index + 1}.` };
    const start = parseStart(row.start);
    if (start === null) return { problem: `"${title}": type its start as h:mm:ss.` };
    if (duration > 0 && start >= duration) return { problem: `"${title}" starts after the recording ends.` };
    chapters.push({ title, start });
  }
  chapters.sort((a, b) => a.start - b.start);
  for (let i = 1; i < chapters.length; i++)
    if (chapters[i].start === chapters[i - 1].start) return { problem: `"${chapters[i - 1].title}" and "${chapters[i].title}" start at the same time.` };
  return { chapters };
}

/**
 * Every chapter moved by `seconds` (earlier when negative), except one at the very start, which stays where the
 * recording begins. Refused, with the reason, when a chapter would leave the recording or meet another.
 */
export function shiftChapters(chapters: RecordingChapter[], seconds: number, duration: number): { chapters: RecordingChapter[] } | { problem: string } {
  if (!Number.isFinite(seconds) || seconds === 0) return { problem: "Type the seconds to shift by, such as 2 or -1.5." };
  const moved = chapters.map((chapter) => (chapter.start === 0 ? chapter : { ...chapter, start: Math.round((chapter.start + seconds) * 1000) / 1000 }));
  for (const chapter of moved) {
    if (chapter.start < 0) return { problem: `"${chapter.title}" would start before the recording begins.` };
    if (duration > 0 && chapter.start >= duration) return { problem: `"${chapter.title}" would start after the recording ends.` };
  }
  const sorted = [...moved].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].start <= sorted[i - 1].start) return { problem: `"${sorted[i].title}" would start with or before "${sorted[i - 1].title}".` };
  return { chapters: sorted };
}

/** A new chapter after `index`: halfway to the next one (or to the recording's end), named by its number. */
export function addChapter(draft: ChapterDraft, index: number, duration: number): ChapterDraft {
  const here = parseStart(draft[index]?.start ?? "") ?? 0;
  const next = parseStart(draft[index + 1]?.start ?? "") ?? (duration > 0 ? duration : here + 120);
  const start = draft.length ? Math.floor((here + next) / 2) : 0;
  const row = { title: `Chapter ${draft.length + 1}`, start: formatStart(start) };
  return [...draft.slice(0, index + 1), row, ...draft.slice(index + 1)];
}

export const sameChapters = (a: RecordingChapter[], b: RecordingChapter[]) => JSON.stringify(a) === JSON.stringify(b);

/** The line under a recording's Chapters row: how many, and where they come from. */
export function chaptersLine(answer: RecordingChapters): string {
  const count = `${answer.chapters.length} ${answer.chapters.length === 1 ? "chapter" : "chapters"}`;
  if (!answer.edited) return `${count} · ${FROM_FILES}`;
  return `${count} · ${answer.from === "audiobookdb" ? "From AudiobookDB" : "Edited"}`;
}
