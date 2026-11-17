// The marks on a book's cover (#556; decided in #467, boards `Library.dc.html` and `DesktopLibrary.dc.html`):
// what the book has, for the Library's tiles of S13 to draw. Pure: the stored work of the library by work (#528).
// A page module: the server imports none of it.
import type { LibraryWork } from "./types";

export type CoverMark = "audiobook" | "ebook" | "reading-sync";

/** Their names, as the boards label the marks. */
export const COVER_MARK_NAMES: Record<CoverMark, string> = {
  audiobook: "Audiobook",
  ebook: "Ebook",
  "reading-sync": "Reading sync ready",
};

export type CoverMarks =
  /** What the book has, in the boards' order: audiobook, ebook, reading sync. Empty for a book with nothing yet. */
  | { kind: "marks"; marks: CoverMark[] }
  /** The book has no file yet and its first one is downloading: the percentage, 0 to 100. */
  | { kind: "downloading"; percent: number };

/**
 * The cover's marks: the audiobook mark for a recording with a track, the ebook mark for an EPUB or a PDF that is
 * there, and the reading sync mark for a reading sync that is ready. A book with none of them shows the
 * percentage while its first file downloads (an acquisition with a known progress), otherwise no mark.
 */
export function coverMarks(work: LibraryWork): CoverMarks {
  const marks: CoverMark[] = [];
  if (work.recordings.some((recording) => recording.tracks.length > 0)) marks.push("audiobook");
  if (work.ebooks.some((ebook) => ebook.available && (ebook.format === "epub" || ebook.format === "pdf"))) marks.push("ebook");
  if (work.readingSync.some((job) => job.status === "ready")) marks.push("reading-sync");
  if (marks.length) return { kind: "marks", marks };
  const progress = work.mediaState?.state === "queued" ? work.mediaState.acquisition?.progress : null;
  if (typeof progress === "number" && Number.isFinite(progress))
    return { kind: "downloading", percent: Math.max(0, Math.min(100, Math.floor(progress * 100))) };
  return { kind: "marks", marks: [] };
}
