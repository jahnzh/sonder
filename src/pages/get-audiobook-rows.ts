// The rows of the Get audiobook sheet (#601, spec #600 "The rows"; board GetAudiobook.dc.html). Pure: no React, no
// window. One row per recording found: its first line names it (the narrator, or the release's title when the
// source names none), its second line says what it is (format, bitrate, size; the release's title first when it is
// not the book's), and its right edge how soon it plays ("Plays now" for a copy TorBox has, otherwise the seeders).
// The language is English until the language picker (ticket 02).
import { matchesLanguage, mergeReleases, normalizeTitle, sortReleases } from "../releases";
import type { AudiobookRelease } from "../types";

/** The language the sheet shows until the picker (ticket 02) lets the user choose another. */
export const GET_LANGUAGE = "English";

export type RowEdge = { text: string; now: boolean } | null;

export type RecordingRow = {
  id: string;
  first: string;
  second: string;
  edge: RowEdge;
  /** The release the row stands for, as Get this recording sends it. */
  release: AudiobookRelease;
};

/** "64 Kbps" and "64kbps" read "64 kbps"; an unknown bitrate ("?") is left out. */
function bitrateText(bitrate: string | null | undefined): string | null {
  const text = bitrate?.trim();
  if (!text || text === "?") return null;
  const match = /^([\d.,]+)\s*kbps$/i.exec(text);
  return match ? `${match[1]} kbps` : text;
}

/** Whether the release's title is the book's own (ignoring case, punctuation and words such as "Unabridged"). */
export function isBooksTitle(releaseTitle: string, bookTitle: string): boolean {
  const release = normalizeTitle(releaseTitle);
  const book = normalizeTitle(bookTitle);
  return !!release && !!book && release === book;
}

/** The right edge: "Plays now" for a copy TorBox has, the seeders when the source counts them, nothing otherwise. */
export function rowEdge(release: Pick<AudiobookRelease, "cached" | "seeders">): RowEdge {
  if (release.cached) return { text: "Plays now", now: true };
  const seeders = release.seeders;
  if (typeof seeders !== "number" || !Number.isFinite(seeders)) return null;
  if (seeders <= 0) return { text: "No seeders", now: false };
  if (seeders === 1) return { text: "1 seeder", now: false };
  return { text: `${seeders} seeders`, now: false };
}

export function recordingRow(release: AudiobookRelease, bookTitle: string): RecordingRow {
  const narrator = release.narrator?.trim();
  const first = narrator || release.title;
  const facts = [release.format?.trim() || null, bitrateText(release.bitrate), release.size?.trim() || null].filter(
    (fact): fact is string => !!fact,
  );
  // The title is already the first line when the source names no narrator.
  const titleFirst = !!narrator && !isBooksTitle(release.title, bookTitle);
  const second = (titleFirst ? [release.title, ...facts] : facts).join(" · ");
  return { id: release.id, first, second, edge: rowEdge(release), release };
}

/**
 * The rows shown for the releases loaded so far: copies of one torrent merged into one row (with the highest
 * seeders), only English ones (and indexer results that name no language), the book's own title and TorBox's
 * copies first, then by seeders.
 */
export function recordingRows(releases: AudiobookRelease[], bookTitle: string, language = GET_LANGUAGE): RecordingRow[] {
  const merged = mergeReleases(releases);
  return sortReleases(
    merged.filter((release) => matchesLanguage(release, language)),
    bookTitle,
  ).map((release) => recordingRow(release, bookTitle));
}

/** The line under Get this recording (ticket 03 completes it). */
export function getLine(release: Pick<AudiobookRelease, "cached"> | null): string | null {
  if (!release) return null;
  return release.cached ? "Plays from TorBox right away." : "Downloads to your server first.";
}
