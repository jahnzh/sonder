// A book's search sheet on the Series page (#898, `#series/<id>/book/<bookId>`): what the series queue's searches for
// the book do, what the audio search found and chose, and why; the other releases it found, with Choose this one
// instead; and Search now, Search again and Skip. Pure: no React, no window, no fetch. The rows are the Get sheet's
// (`get-audiobook-rows.ts`), with each release's title first and its language leading the second line.
import { leftToChooseLine, NOTHING_FOUND_LINE, SEARCH_SKIPPED_LINE, SEARCH_STOPPED_LINE, seriesSearchLine } from "../status-lines";
import type { AudiobookRelease, SeriesWorkAcquisition, WorkMediaState } from "../types";
import { ALL_LANGUAGES, getLine, recordingRow, sourceLink, type GetLine, type RecordingRow } from "./get-audiobook-rows";
import type { SourceLink } from "./get-source-link";

const DOT = " · ";

/** A release the audio search found (`StoredSeriesCandidate` in `server/series-queue-store.ts`). */
export type SeriesCandidate = {
  key: string;
  source: "abb" | "prowlarr";
  id: string;
  title: string;
  size: string | null;
  format: string | null;
  narrator: string | null;
  language: string | null;
  url: string | null;
  indexer: string | null;
  seeders: number | null;
  cached: boolean;
  kind: "plain" | "episodic" | "compilation";
  reasons: SeriesCandidateReason[];
};
export type SeriesCandidateReason = "one-book" | "episodic" | "compilation" | "torbox" | "narrator" | "length";

/** `GET /api/series/<id>/works/<bookId>/acquisition`. */
export type SeriesWorkSearch = {
  bookId: string;
  workId: string;
  title: string;
  audio: SeriesWorkAcquisition | null;
  ebook: SeriesWorkAcquisition | null;
  choice: { at: number; chosen: string | null; by: "queue" | "owner"; candidates: SeriesCandidate[] } | null;
  hasAudio: boolean;
  mediaState: WorkMediaState | null;
};

/** What a reason says in the Why line. */
const REASON_WORDS: Record<SeriesCandidateReason, string> = {
  "one-book": "one book, not a set",
  episodic: "episodes",
  compilation: "a set of books",
  torbox: "TorBox has it",
  narrator: "the narrator AudiobookDB names",
  length: "the length AudiobookDB gives",
};

/** The steering a search of one kind offers: which of Search now, Search again and Skip. */
export type SearchSteering = { now: boolean; again: boolean; skip: boolean };

export type SeriesBookModel = {
  title: string;
  /** The audiobook search: its line, the chosen release, the others found, its steering; null without one. */
  audio: {
    line: string | null;
    chosen: { key: string; first: string; second: string; why: string; link: SourceLink | null } | null;
    /** The other releases found, as the Get sheet's choice rows. */
    others: RecordingRow[];
    /** "Other recordings found · 3", or "Recordings found · 3" when none is chosen. */
    caption: string;
    steering: SearchSteering;
  } | null;
  ebook: { line: string | null; steering: SearchSteering } | null;
};

/** A candidate as the Get sheet's rows read a release. */
export function candidateRelease(candidate: SeriesCandidate): AudiobookRelease {
  return {
    id: candidate.key,
    title: candidate.title,
    author: "",
    url: candidate.url ?? "",
    language: candidate.language,
    narrator: candidate.narrator,
    format: candidate.format,
    bitrate: null,
    size: candidate.size,
    posted: null,
    uploader: null,
    description: "",
    source: candidate.source,
    indexer: candidate.indexer,
    seeders: candidate.seeders,
    // Every candidate with an info hash was checked against TorBox when it was found.
    infoHash: candidate.key.includes(":") ? null : candidate.key,
    cached: candidate.cached,
  };
}

/** The Why line of the chosen release: who chose it, and the ranking's reasons when the queue did. */
export function whyLine(candidate: SeriesCandidate, by: "queue" | "owner"): string {
  if (by === "owner") return "Chosen by you";
  const reasons = candidate.reasons.map((reason) => REASON_WORDS[reason]).filter(Boolean);
  return ["Chosen by the queue", ...reasons].join(DOT);
}

/** A search's own line on the sheet: waiting with its place, searching, failed with its reason, skipped, stopped. */
function searchLine(state: SeriesWorkAcquisition | null, search: "audiobook" | "ebook", found: number | null, chosen: boolean, hasFile: boolean): string | null {
  if (!state) return null;
  if (state.status === "skipped") {
    if (state.skipReason === "owner") return SEARCH_SKIPPED_LINE;
    if (state.skipReason === "stopped") return SEARCH_STOPPED_LINE;
    if (state.skipReason === "unreleased") return "Not released yet";
    return search === "ebook" ? "The book had its ebook" : "The book had its audiobook";
  }
  if (state.status === "done" && search === "audiobook" && !hasFile && !chosen) return found ? leftToChooseLine(found) : NOTHING_FOUND_LINE;
  if (state.status === "done" && search === "audiobook") return null;
  return seriesSearchLine({ status: state.status, search, place: state.place, retrying: !!state.retrying, reason: state.error });
}

/**
 * Which steering a search has: Search now for one that waits, was stopped or skipped (it moves to the front); Search
 * again for one that ended (done or failed); Skip for one that has not downloaded anything yet. None while it runs,
 * nor for an account that may not get files.
 */
export function searchSteering(state: SeriesWorkAcquisition | null, downloaded: boolean): SearchSteering {
  const none = { now: false, again: false, skip: false };
  if (!state || state.status === "searching") return none;
  if (state.status === "skipped" && state.skipReason === "no_permission") return none;
  const stoppedOrSkipped = state.status === "skipped" && (state.skipReason === "owner" || state.skipReason === "stopped");
  return {
    now: state.status === "pending" || stoppedOrSkipped,
    again: !stoppedOrSkipped && state.status !== "pending",
    skip: !stoppedOrSkipped && !downloaded && (state.status === "pending" || state.status === "failed" || state.status === "done"),
  };
}

export function seriesBookModel(search: SeriesWorkSearch): SeriesBookModel {
  const choice = search.choice;
  const candidates = choice?.candidates ?? [];
  const chosen = choice?.chosen ? candidates.find((candidate) => candidate.key === choice.chosen) ?? null : null;
  const downloading = search.mediaState?.state === "queued";
  const downloaded = search.hasAudio || downloading || !!chosen;
  const audio = search.audio
    ? {
        line: searchLine(search.audio, "audiobook", choice ? candidates.length : null, !!chosen, search.hasAudio || downloading),
        chosen: chosen
          ? (() => {
              const row = recordingRow(candidateRelease(chosen), search.title, ALL_LANGUAGES, true);
              return { key: chosen.key, first: row.first, second: row.second, why: whyLine(chosen, choice!.by), link: sourceLink(row.release) };
            })()
          : null,
        others: candidates
          .filter((candidate) => candidate !== chosen)
          .map((candidate) => recordingRow(candidateRelease(candidate), search.title, ALL_LANGUAGES, true)),
        caption: `${chosen ? "Other recordings found" : "Recordings found"}${DOT}${candidates.length - (chosen ? 1 : 0)}`,
        steering: searchSteering(search.audio, downloaded),
      }
    : null;
  const ebook = search.ebook
    ? { line: searchLine(search.ebook, "ebook", null, false, false), steering: searchSteering(search.ebook, search.ebook.status === "done") }
    : null;
  return { title: search.title, audio, ebook };
}

/**
 * The line under Choose this one instead: the Get sheet's (it replaces a download on its way; it plays from TorBox
 * at once; it downloads to the server first), and for a book that has its audiobook, that it adds this recording.
 */
export function chooseLine(candidate: SeriesCandidate | null, search: Pick<SeriesWorkSearch, "mediaState" | "hasAudio">): GetLine | null {
  if (!candidate) return null;
  const line = getLine({ chosen: candidateRelease(candidate), mediaState: search.mediaState, torboxConnected: true, health: null });
  if (!line || line.replaceActive || !search.hasAudio) return line;
  return { ...line, text: `Adds this recording to the book. ${line.text}` };
}
