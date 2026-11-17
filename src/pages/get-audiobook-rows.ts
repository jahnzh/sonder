// The rows of the Get audiobook sheet (#601, spec #600 "The rows"; board GetAudiobook.dc.html). Pure: no React, no
// window. One row per recording found: its first line names it (the narrator, or the release's title when the
// source names none), its second line says what it is (format, bitrate, size; the release's title first when it is
// not the book's), and its right edge how soon it plays ("Plays now" for a copy TorBox has, otherwise the seeders).
// The language (#602) narrows the rows: English the first time, then the one stored on this device; with All
// languages each row's second line starts with its language.
import { matchesLanguage, mergeReleases, normalizeTitle, sortReleases } from "../releases";
import type { AudiobookRelease } from "../types";

/** The language the sheet starts with the first time, before one is stored on this device. */
export const GET_LANGUAGE = "English";
/** The language choice that keeps every row, as today's `release-language` stores it. */
export const ALL_LANGUAGES = "all";
/** The key the choice is stored under on this device (today's, shared with the release picker). */
export const LANGUAGE_KEY = "release-language";
export const UNKNOWN_LANGUAGE = "Language unknown";

/** The language's name, as the button and the picker show it. */
export function languageName(language: string): string {
  return language === ALL_LANGUAGES ? "All languages" : language;
}

/** A row in the language: today's `matchesLanguage`, and a row whose source gives no language stays under every one. */
export function inLanguage(release: Pick<AudiobookRelease, "language" | "source">, language: string): boolean {
  if (!release.language?.trim()) return true;
  return matchesLanguage(release as AudiobookRelease, language);
}

/**
 * The picker's choices: All languages, English, then every other language of the loaded rows in alphabetical order
 * (each once, whatever its case), and the chosen one even when no loaded row is in it.
 */
export function languageChoices(releases: Pick<AudiobookRelease, "language">[], chosen: string): { value: string; label: string }[] {
  const others = new Map<string, string>();
  const add = (language: string | null | undefined) => {
    const name = language?.trim();
    if (!name || name === ALL_LANGUAGES || name.toLowerCase() === GET_LANGUAGE.toLowerCase()) return;
    if (!others.has(name.toLowerCase())) others.set(name.toLowerCase(), name);
  };
  for (const release of releases) add(release.language);
  add(chosen);
  return [
    { value: ALL_LANGUAGES, label: languageName(ALL_LANGUAGES) },
    { value: GET_LANGUAGE, label: GET_LANGUAGE },
    ...[...others.values()].sort((a, b) => a.localeCompare(b)).map((name) => ({ value: name, label: name })),
  ];
}

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

export function recordingRow(release: AudiobookRelease, bookTitle: string, language = GET_LANGUAGE): RecordingRow {
  const narrator = release.narrator?.trim();
  const first = narrator || release.title;
  const facts = [release.format?.trim() || null, bitrateText(release.bitrate), release.size?.trim() || null].filter(
    (fact): fact is string => !!fact,
  );
  // The title is already the first line when the source names no narrator.
  const titleFirst = !!narrator && !isBooksTitle(release.title, bookTitle);
  // With All languages the row says its language first.
  const named = language === ALL_LANGUAGES ? [release.language?.trim() || UNKNOWN_LANGUAGE] : [];
  const second = [...named, ...(titleFirst ? [release.title] : []), ...facts].join(" · ");
  return { id: release.id, first, second, edge: rowEdge(release), release };
}

/**
 * The rows shown for the releases loaded so far: copies of one torrent merged into one row (with the highest
 * seeders), only the ones in the language (and those whose source names none; every row with All languages),
 * the book's own title and TorBox's copies first, then by seeders.
 */
export function recordingRows(releases: AudiobookRelease[], bookTitle: string, language = GET_LANGUAGE): RecordingRow[] {
  const merged = mergeReleases(releases);
  return sortReleases(
    merged.filter((release) => inLanguage(release, language)),
    bookTitle,
  ).map((release) => recordingRow(release, bookTitle, language));
}

/** The line under Get this recording (ticket 03 completes it). */
export function getLine(release: Pick<AudiobookRelease, "cached"> | null): string | null {
  if (!release) return null;
  return release.cached ? "Plays from TorBox right away." : "Downloads to your server first.";
}
