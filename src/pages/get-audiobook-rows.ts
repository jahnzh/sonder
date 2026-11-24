// The rows of the Get audiobook sheet (#601, spec #600 "The rows"; board GetAudiobook.dc.html). Pure: no React, no
// window. One row per recording found: its first line names it (the narrator, or the release's title when the
// source names none), its second line says what it is (format, bitrate, size; the release's title first when it is
// not the book's), and its right edge how soon it plays ("Plays now" for a copy TorBox has, otherwise the seeders).
// The language (#602) narrows the rows: English the first time, then the one stored on this device; with All
// languages each row's second line starts with its language.
import { matchesLanguage, mergeReleases, normalizeTitle, sortReleases } from "../releases";
import { downloadLine, type DownloadFacts } from "../status-lines";
import type { AudiobookRelease, TorrentHealth, WorkMediaState } from "../types";
import { isWebAddress, type SourceLink } from "./get-source-link";

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

/** What a row's second line says the recording is: format, bitrate, size, each when the source names it. */
function rowFacts(release: AudiobookRelease): string[] {
  return [release.format?.trim() || null, bitrateText(release.bitrate), release.size?.trim() || null].filter(
    (fact): fact is string => !!fact,
  );
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

/**
 * `titleFirst` (the sheet without a book, #576): the release's own title is the first line and the narrator starts
 * the second, as there is no book's title for it to differ from.
 */
export function recordingRow(release: AudiobookRelease, bookTitle: string, language = GET_LANGUAGE, titleFirst = false): RecordingRow {
  const narrator = release.narrator?.trim();
  if (titleFirst) {
    const named = language === ALL_LANGUAGES ? [release.language?.trim() || UNKNOWN_LANGUAGE] : [];
    const second = [...named, ...(narrator ? [narrator] : []), ...rowFacts(release)].join(" · ");
    return { id: release.id, first: release.title, second, edge: rowEdge(release), release };
  }
  const first = narrator || release.title;
  const facts = rowFacts(release);
  // The title is already the first line when the source names no narrator.
  const titleSecond = !!narrator && !isBooksTitle(release.title, bookTitle);
  // With All languages the row says its language first.
  const named = language === ALL_LANGUAGES ? [release.language?.trim() || UNKNOWN_LANGUAGE] : [];
  const second = [...named, ...(titleSecond ? [release.title] : []), ...facts].join(" · ");
  return { id: release.id, first, second, edge: rowEdge(release), release };
}

/**
 * The rows shown for the releases loaded so far: copies of one torrent merged into one row (with the highest
 * seeders), only the ones in the language (and those whose source names none; every row with All languages),
 * the book's own title and TorBox's copies first, then by seeders.
 */
export function recordingRows(releases: AudiobookRelease[], bookTitle: string, language = GET_LANGUAGE, titleFirst = false): RecordingRow[] {
  const merged = mergeReleases(releases);
  return sortReleases(
    merged.filter((release) => inLanguage(release, language)),
    bookTitle,
  ).map((release) => recordingRow(release, bookTitle, language, titleFirst));
}

/** What the line under Get this recording says, and whether the add is sent with `replaceActive: true`. */
export type GetLine = {
  text: string;
  /** In the failed colour: the torrent client the recording needs is not working. */
  failed: boolean;
  /** The add replaces the download on its way; true exactly when the line says so. */
  replaceActive: boolean;
};

export type GetLineFacts = {
  /** The chosen row's release, a pasted magnet link (nothing known about it yet), or nothing chosen. */
  chosen: Pick<AudiobookRelease, "cached" | "source" | "infoHash"> | "magnet" | null;
  /** The work's media state for this user (ADR 0011), as the library read gives it. */
  mediaState: WorkMediaState | null | undefined;
  /** TorBox is connected (the settings' `torboxConfigured`). */
  torboxConnected: boolean;
  /** The torrent client's health (`GET /api/torrents/health`), null until it is read. */
  health: Pick<TorrentHealth, "status" | "message"> | null | undefined;
};

/** The download on its way's own status line (#494), as the Book page's Audiobook row shows it. */
function onItsWay(acquisition: NonNullable<WorkMediaState["acquisition"]>): string {
  const status = (acquisition.status ?? "checking") as DownloadFacts["status"];
  return downloadLine({ status, progress: acquisition.progress }) ?? downloadLine({ status: "checking" })!;
}

/**
 * The line under Get this recording (spec #600 "What the line under the button says"), the first that holds:
 * nothing chosen, no line; a download for the book on its way, "Replaces the download on its way (<its line>)." and
 * the add replaces it; a copy TorBox has, "Plays from TorBox right away."; TorBox not connected, or the row checked
 * against TorBox and not there (an info hash: a Prowlarr row), "Downloads to your server first.", or the torrent
 * client's own message in the failed colour while it is neither ok nor unconfigured; otherwise (an AudioBookBay row
 * or a magnet link with TorBox connected) "Plays at once if TorBox has it, else downloads to your server."
 */
export function getLine({ chosen, mediaState, torboxConnected, health }: GetLineFacts): GetLine | null {
  if (!chosen) return null;
  const line = (text: string, failed = false, replaceActive = false): GetLine => ({ text, failed, replaceActive });
  if (mediaState?.state === "queued" && mediaState.acquisition)
    return line(`Replaces the download on its way (${onItsWay(mediaState.acquisition)}).`, false, true);
  const release = chosen === "magnet" ? null : chosen;
  if (release?.cached) return line("Plays from TorBox right away.");
  const checked = !!release && (release.source === "prowlarr" || !!release.infoHash);
  if (!torboxConnected || checked) {
    if (health && health.status !== "ok" && health.status !== "unconfigured" && health.message?.trim())
      return line(health.message.trim(), true);
    return line("Downloads to your server first.");
  }
  return line("Plays at once if TorBox has it, else downloads to your server.");
}

/**
 * What the server writes as the indexer of a Prowlarr result that names none (server/sources/prowlarr.ts,
 * `item.indexer || "Prowlarr"`): not a site's name, so no name.
 */
const NO_INDEXER = "prowlarr";

/**
 * The link in the footer to the chosen recording's own page (#889): "On AudioBookBay" for an AudioBookBay release
 * (and one from an older server, which names no source), "On <indexer>" for a Prowlarr release that names its
 * indexer, "On the indexer's page" for one that does not (the server's stand-in name "Prowlarr" counts as none: the
 * address is the tracker's own page, not Prowlarr's). No link for nothing chosen, the magnet link, or a release
 * whose address is not a web address.
 */
export function sourceLink(chosen: Pick<AudiobookRelease, "url" | "source" | "indexer"> | "magnet" | null | undefined): SourceLink | null {
  if (!chosen || chosen === "magnet" || !isWebAddress(chosen.url)) return null;
  const href = chosen.url.trim();
  if (chosen.source !== "prowlarr") return { text: "On AudioBookBay", href };
  const indexer = chosen.indexer?.trim();
  return { text: indexer && indexer.toLowerCase() !== NO_INDEXER ? `On ${indexer}` : "On the indexer's page", href };
}
