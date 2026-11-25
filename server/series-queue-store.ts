// What the series queue's audio search found and chose for a book (#898), kept with its job in
// `series_acquisition_jobs.candidates` as JSON. No import of the queue itself: `series-acquisition.ts` imports this file.
import { sqlite } from "./db.ts";
import { narratorMatches, type SeriesAudioCandidate, type SeriesAudioExpectation } from "./series-audio.ts";


/** Why a candidate ranks where it does, as the queue's ranking reads it (`rankSeriesAudioCandidate`). */
export type SeriesCandidateReason = "one-book" | "episodic" | "compilation" | "torbox" | "narrator" | "length";

/** One release the search found, with what its source said of it. */
export type StoredSeriesCandidate = {
  /** The info hash when known, else `<source>:<id>`: what the chosen one is named by. */
  key: string;
  source: "abb" | "prowlarr";
  id: string;
  title: string;
  size: string | null;
  format: string | null;
  narrator: string | null;
  language: string | null;
  /** The release's own page (AudioBookBay's post, the tracker's page for a Prowlarr result). */
  url: string | null;
  indexer: string | null;
  seeders: number | null;
  cached: boolean;
  kind: SeriesAudioCandidate["kind"];
  reasons: SeriesCandidateReason[];
};

export type StoredSeriesChoice = {
  /** When the search ended. */
  at: number;
  /** The key of the release downloaded for the book; null when none was (nothing found, or only sets of books). */
  chosen: string | null;
  /** Who chose it: the queue's own pick, or the owner's Choose this one instead (or the Get sheet's). */
  by: "queue" | "owner";
  candidates: StoredSeriesCandidate[];
};

/** What a search result's source says beyond the candidate's own fields: its page, language, seeders and indexer. */
export type SeriesCandidateFacts = Pick<StoredSeriesCandidate, "url" | "language" | "indexer" | "seeders">;

export const candidateKey = (candidate: Pick<SeriesAudioCandidate, "hash" | "source" | "id">) =>
  candidate.hash || `${candidate.source}:${candidate.id}`;

/** The source's facts of a raw search result (AudioBookBay's listing, Prowlarr's release), as far as it gives them. */
export function resultFacts(result: unknown): SeriesCandidateFacts {
  const value = (result ?? {}) as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" && field.trim() ? field.trim() : null);
  return {
    url: text(value.url),
    language: text(value.language),
    indexer: text(value.indexer),
    seeders: typeof value.seeders === "number" && Number.isFinite(value.seeders) ? value.seeders : null,
  };
}

/** The ranking's reasons that hold for a candidate (`rankSeriesAudioCandidate` in `series-audio.ts`). */
export function candidateReasons(candidate: SeriesAudioCandidate, expected?: SeriesAudioExpectation | null): SeriesCandidateReason[] {
  const reasons: SeriesCandidateReason[] = [candidate.kind === "plain" ? "one-book" : candidate.kind];
  if (candidate.cached) reasons.push("torbox");
  if (expected && narratorMatches(candidate.narrator, expected.narrators)) reasons.push("narrator");
  if (expected?.lengthMs && candidate.lengthMs && Math.abs(candidate.lengthMs - expected.lengthMs) <= Math.max(120_000, expected.lengthMs * 0.03))
    reasons.push("length");
  return reasons;
}

export function storedCandidate(
  candidate: SeriesAudioCandidate,
  facts: SeriesCandidateFacts | undefined,
  expected?: SeriesAudioExpectation | null,
): StoredSeriesCandidate {
  return {
    key: candidateKey(candidate),
    source: candidate.source,
    id: candidate.id,
    title: candidate.title,
    size: candidate.size ?? null,
    format: candidate.format ?? null,
    narrator: candidate.narrator ?? null,
    language: facts?.language ?? null,
    url: facts?.url ?? null,
    indexer: facts?.indexer ?? null,
    seeders: facts?.seeders ?? null,
    cached: !!candidate.cached,
    kind: candidate.kind,
    reasons: candidateReasons(candidate, expected),
  };
}

/** A job's stored choice; null for none, or for a value written by hand that is not one. */
export function parseSeriesChoice(value: string | null | undefined): StoredSeriesChoice | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as StoredSeriesChoice;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.candidates)) return null;
    return { at: Number(parsed.at) || 0, chosen: typeof parsed.chosen === "string" ? parsed.chosen : null, by: parsed.by === "owner" ? "owner" : "queue", candidates: parsed.candidates };
  } catch (error) {
    void (error as Error).message;
    return null;
  }
}

export function readSeriesChoice(jobId: string): StoredSeriesChoice | null {
  const row = sqlite.prepare("SELECT candidates FROM series_acquisition_jobs WHERE id=?").get(jobId) as { candidates: string | null } | undefined;
  return parseSeriesChoice(row?.candidates);
}

export function writeSeriesChoice(jobId: string, choice: StoredSeriesChoice) {
  sqlite.prepare("UPDATE series_acquisition_jobs SET candidates=? WHERE id=?").run(JSON.stringify(choice), jobId);
}

/**
 * The owner chose a release for the book (Choose this one instead, or the Get sheet's select): it is the chosen one,
 * added to the list when the search did not find it.
 */
export function markOwnerChoice(jobId: string, release: { source: "abb" | "prowlarr"; id: string; title?: string | null }, now = Date.now()) {
  const choice = readSeriesChoice(jobId) ?? { at: now, chosen: null, by: "owner" as const, candidates: [] };
  let found = choice.candidates.find((candidate) => candidate.source === release.source && candidate.id === release.id);
  if (!found) {
    found = {
      key: `${release.source}:${release.id}`, source: release.source, id: release.id, title: release.title?.trim() || release.id,
      size: null, format: null, narrator: null, language: null, url: null, indexer: null, seeders: null, cached: false, kind: "plain", reasons: [],
    };
    choice.candidates = [found, ...choice.candidates];
  }
  writeSeriesChoice(jobId, { ...choice, chosen: found.key, by: "owner" });
}
