// A work's catalogue link and a recording's release link (#721), the matcher, the administrator's batch match over
// the library, and the loop that keeps the cache to its licence (refresh a week's details, delete what is gone).
//
// - A work links to an AudiobookDB book, or to an Open Library work when it has no audiobook.
// - A recording may link to an AudiobookDB release: narrator, length, ASIN and chapters are kept on the link.
// - A link fills only what is missing (the work's description, the edition's narrator); title, author and cover stay.
//   The first series and its position are kept on the link for the series part (721b).
// - A sure match is applied: the exact normalised title and author, or the ASIN in the file's name. Anything else is
//   left unmatched with its outcome, for the administrator to pick on the book's match page.
// - A matched work is not searched again: only its match page searches.
import { sqlite } from "./db.ts";
import { placeholderEditionSql } from "./placeholder-edition.ts";
import {
  audiobookDbBook,
  audiobookDbByAsin,
  audiobookDbRelease,
  audiobookDbReleases,
  isEnglish,
  refreshAudiobookDbEntry,
  searchAudiobookDbBooks,
  type CatalogueBook,
  type CatalogueRelease,
} from "./audiobookdb.ts";
import { openLibraryWork, openLibraryWorkUrl, refreshOpenLibraryEntry, searchOpenLibrary } from "./openlibrary.ts";
import { CatalogueError, dropExpiredSearches, expiredDetails, type CatalogueProviderName, type Priority } from "./catalogue-provider.ts";
import type { BackgroundProcess } from "./background-runner.ts";

// ---- The matcher (pure) ----
const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
/** Lower case, no accents or punctuation, single spaces. */
export function normaliseTitle(title: string): string {
  return fold(title);
}
/** The title without its subtitle or a bracketed note ("(Unabridged)", "[Book 1]"). */
function mainTitle(title: string): string {
  return fold(title.replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, " ").split(/\s[:–—-]\s|:\s/)[0]);
}
/** Exact after normalising: the whole titles, or both without a subtitle or bracketed note. */
export function titleMatches(workTitle: string, candidate: string): boolean {
  const a = normaliseTitle(workTitle);
  const b = normaliseTitle(candidate);
  if (!a || !b) return false;
  return a === b || (mainTitle(workTitle) !== "" && mainTitle(workTitle) === mainTitle(candidate));
}
/** An author name as a set of words, so "Corey, James S. A." is "James S. A. Corey". */
const nameKey = (name: string) => fold(name).split(" ").filter(Boolean).sort().join(" ");
/** The work's author (one or several, as stored) and one of the candidate's authors are the same person. */
export function authorMatches(workAuthor: string, candidates: string[]): boolean {
  const whole = nameKey(workAuthor);
  const parts = workAuthor.split(/\s*(?:;|&|\band\b|,(?=\s*[A-Z][^,]*\s[A-Z]))\s*/).map(nameKey).filter(Boolean);
  const keys = new Set([whole, ...parts].filter(Boolean));
  return candidates.some((name) => keys.has(nameKey(name)));
}
/** An Audible ASIN (B0 and eight more) in the file names, the release title or the torrent name. */
export function findAsin(texts: string[]): string | null {
  for (const value of texts) {
    const found = value.toUpperCase().match(/(?:^|[^A-Z0-9])(B0[0-9A-Z]{8})(?![A-Z0-9])/);
    if (found) return found[1];
  }
  return null;
}
export type Decision =
  | { outcome: "matched"; book: CatalogueBook }
  | { outcome: "ambiguous"; candidates: number }
  | { outcome: "missing" };
/** Sure: exactly one result with this exact title and author. Results that are not sure leave the work ambiguous. */
export function decide(work: { title: string; author: string }, results: CatalogueBook[]): Decision {
  const exact = results.filter((book) => titleMatches(work.title, book.title) && authorMatches(work.author, book.authors));
  const ids = [...new Set(exact.map((book) => book.id))];
  if (ids.length === 1) return { outcome: "matched", book: exact[0] };
  if (ids.length > 1) return { outcome: "ambiguous", candidates: ids.length };
  return results.length ? { outcome: "ambiguous", candidates: results.length } : { outcome: "missing" };
}
/** English or unknown: only a release the provider marks as another language is left out. */
export const englishRelease = (release: CatalogueRelease) => !release.language || isEnglish(release.language);
/**
 * The release a recording is surely of: the one with the file's ASIN, else the only English release whose length
 * agrees with the recording's within a minute (and 1 %).
 */
export function pickRelease(recording: { durationMs: number; asin: string | null }, releases: CatalogueRelease[]): { release: CatalogueRelease; by: "asin" | "length" } | null {
  if (recording.asin) {
    const byAsin = releases.find((release) => release.asin === recording.asin);
    if (byAsin) return { release: byAsin, by: "asin" };
  }
  if (!(recording.durationMs > 0)) return null;
  const tolerance = Math.max(60_000, recording.durationMs * 0.01);
  const close = releases.filter((release) => englishRelease(release) && release.lengthMs !== null && Math.abs(release.lengthMs - recording.durationMs) <= tolerance);
  return close.length === 1 ? { release: close[0], by: "length" } : null;
}

// ---- What the server knows of a work ----
type WorkRow = { id: string; title: string; author: string; description: string };
const workRow = (workId: string) => sqlite.prepare("SELECT id,title,author,description FROM works WHERE id=?").get(workId) as WorkRow | undefined;
export type RecordingFacts = { recordingId: string; editionId: string; label: string; durationMs: number; asin: string | null; narrator: string };
/** The work's real recordings (placeholders have none): their length, an ASIN in their names, their narrator. */
export function workRecordings(workId: string): RecordingFacts[] {
  const rows = sqlite
    .prepare(
      `SELECT r.id AS recordingId,e.id AS editionId,e.narrator,e.release_title AS releaseTitle,e.source_label AS sourceLabel,
              COALESCE((SELECT SUM(t.duration) FROM tracks t WHERE t.recording_id=r.id),0) AS seconds,
              (SELECT group_concat(t.title || ' ' || t.source, char(10)) FROM tracks t WHERE t.recording_id=r.id) AS names,
              (SELECT a.title FROM acquisitions a WHERE a.book_id=e.id LIMIT 1) AS torrent
       FROM recordings r JOIN audio_editions e ON e.id=r.edition_id
       WHERE e.work_id=? AND NOT ${placeholderEditionSql("e.id")} AND EXISTS(SELECT 1 FROM tracks t WHERE t.recording_id=r.id)
       ORDER BY r.id`,
    )
    .all(workId) as { recordingId: string; editionId: string; narrator: string; releaseTitle: string | null; sourceLabel: string; seconds: number; names: string | null; torrent: string | null }[];
  return rows.map((row) => ({
    recordingId: row.recordingId,
    editionId: row.editionId,
    label: row.releaseTitle || row.sourceLabel || row.recordingId,
    durationMs: Math.round(row.seconds * 1000),
    asin: findAsin([row.releaseTitle ?? "", row.torrent ?? "", row.names ?? ""]),
    narrator: row.narrator,
  }));
}
const missingNarrator = (value: string | null | undefined) => !value || !value.trim() || /^unknown( narrator)?$/i.test(value.trim());

// ---- Links ----
export type WorkLink = {
  provider: CatalogueProviderName;
  id: string;
  title: string;
  author: string;
  series: { id: string | null; name: string; position: string | null; sort: number | null } | null;
  matchedBy: "title" | "asin" | "manual";
  url: string;
};
type LinkRow = { provider: CatalogueProviderName; externalId: string; title: string; author: string; seriesId: string | null; seriesName: string | null; seriesPosition: string | null; seriesSort: number | null; matchedBy: WorkLink["matchedBy"] };
export function workLink(workId: string): WorkLink | null {
  const row = sqlite
    .prepare(
      `SELECT provider,external_id AS externalId,title,author,series_id AS seriesId,series_name AS seriesName,series_position AS seriesPosition,series_sort AS seriesSort,matched_by AS matchedBy
       FROM work_catalogue_links WHERE work_id=?`,
    )
    .get(workId) as LinkRow | undefined;
  if (!row) return null;
  return {
    provider: row.provider,
    id: row.externalId,
    title: row.title,
    author: row.author,
    series: row.seriesName ? { id: row.seriesId, name: row.seriesName, position: row.seriesPosition, sort: row.seriesSort } : null,
    matchedBy: row.matchedBy,
    url: row.provider === "openlibrary" ? openLibraryWorkUrl(row.externalId) : "https://audiobookdb.org",
  };
}
export type ReleaseLink = { releaseId: string; bookId: string; narrator: string | null; lengthMs: number | null; asin: string | null; language: string | null; chapters: number; matchedBy: "asin" | "length" | "manual" };
export function releaseLink(recordingId: string): ReleaseLink | null {
  const row = sqlite
    .prepare(
      `SELECT release_id AS releaseId,book_id AS bookId,narrator,length_ms AS lengthMs,asin,language,chapters,matched_by AS matchedBy
       FROM recording_release_links WHERE recording_id=?`,
    )
    .get(recordingId) as (Omit<ReleaseLink, "chapters"> & { chapters: string }) | undefined;
  if (!row) return null;
  const chapters = JSON.parse(row.chapters) as unknown[];
  return { ...row, chapters: Array.isArray(chapters) ? chapters.length : 0 };
}

/** Links a recording to a release; fills the edition's narrator when it has none. */
export async function linkRecording(recordingId: string, releaseId: string, matchedBy: ReleaseLink["matchedBy"], priority: Priority = "interactive"): Promise<void> {
  const recording = sqlite
    .prepare("SELECT r.id,e.id AS editionId,e.work_id AS workId,e.narrator FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE r.id=?")
    .get(recordingId) as { id: string; editionId: string; workId: string; narrator: string } | undefined;
  if (!recording) throw new Error("This recording is not on the server.");
  const link = workLink(recording.workId);
  if (!link || link.provider !== "audiobookdb") throw new Error("Match the book on AudiobookDB first.");
  const release = await audiobookDbRelease(releaseId, { priority, bookId: link.id });
  if (release.bookId && release.bookId !== link.id) throw new Error("This release belongs to another book.");
  const narrator = release.narrators.join(", ") || null;
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO recording_release_links(recording_id,book_id,release_id,narrator,length_ms,asin,language,chapters,matched_by,linked_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(recording_id) DO UPDATE SET book_id=excluded.book_id,release_id=excluded.release_id,narrator=excluded.narrator,length_ms=excluded.length_ms,
           asin=excluded.asin,language=excluded.language,chapters=excluded.chapters,matched_by=excluded.matched_by,linked_at=excluded.linked_at`,
      )
      .run(recordingId, link.id, release.id, narrator, release.lengthMs, release.asin, release.language, JSON.stringify(release.chapters), matchedBy, Date.now());
    if (narrator && missingNarrator(recording.narrator)) sqlite.prepare("UPDATE audio_editions SET narrator=? WHERE id=?").run(narrator, recording.editionId);
  })();
}
export function unlinkRecording(recordingId: string) {
  sqlite.prepare("DELETE FROM recording_release_links WHERE recording_id=?").run(recordingId);
}

/**
 * Links a work to a provider book (AudiobookDB) or work (Open Library) and fills what is missing. On AudiobookDB
 * each recording without a release picked by hand is linked to the release it surely is.
 */
export async function linkWork(
  workId: string,
  target: { provider: CatalogueProviderName; id: string; author?: string },
  matchedBy: WorkLink["matchedBy"],
  priority: Priority = "interactive",
): Promise<void> {
  const work = workRow(workId);
  if (!work) throw new Error("This book is not on the server.");
  const wantsDescription = !work.description.trim();
  let stored: { title: string; author: string; series: CatalogueBook["series"][number] | null; description: string | null };
  let releases: CatalogueRelease[] = [];
  if (target.provider === "audiobookdb") {
    // A live answer only when the description is to be filled: the cache never holds one.
    const book = await audiobookDbBook(target.id, { priority, fresh: wantsDescription });
    stored = { title: book.title, author: book.authors.join(", "), series: book.series[0] ?? null, description: book.description };
    releases = await audiobookDbReleases(book.id, { priority });
  } else {
    const found = await openLibraryWork(target.id, { priority, fresh: wantsDescription });
    stored = { title: found.title, author: (target.author ?? "").slice(0, 300), series: null, description: found.description };
  }
  const previous = workLink(workId);
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO work_catalogue_links(work_id,provider,external_id,title,author,series_id,series_name,series_position,series_sort,matched_by,linked_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(work_id) DO UPDATE SET provider=excluded.provider,external_id=excluded.external_id,title=excluded.title,author=excluded.author,
           series_id=excluded.series_id,series_name=excluded.series_name,series_position=excluded.series_position,series_sort=excluded.series_sort,
           matched_by=excluded.matched_by,linked_at=excluded.linked_at`,
      )
      .run(workId, target.provider, target.id, stored.title, stored.author, stored.series?.id ?? null, stored.series?.name ?? null, stored.series?.position ?? null, stored.series?.sort ?? null, matchedBy, Date.now());
    if (wantsDescription && stored.description) sqlite.prepare("UPDATE works SET description=? WHERE id=? AND trim(description)=''").run(stored.description, workId);
    sqlite
      .prepare("INSERT INTO work_catalogue_match(work_id,outcome,reason,candidates,checked_at) VALUES(?,?,NULL,1,?) ON CONFLICT(work_id) DO UPDATE SET outcome=excluded.outcome,reason=NULL,candidates=1,checked_at=excluded.checked_at")
      .run(workId, "matched", Date.now());
    // Another book: its release links no longer hold.
    if (!previous || previous.provider !== target.provider || previous.id !== target.id)
      sqlite.prepare("DELETE FROM recording_release_links WHERE recording_id IN (SELECT r.id FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE e.work_id=?)").run(workId);
  })();
  if (target.provider !== "audiobookdb") return;
  for (const recording of workRecordings(workId)) {
    if (releaseLink(recording.recordingId)?.matchedBy === "manual") continue;
    const picked = pickRelease(recording, releases);
    if (picked) await linkRecording(recording.recordingId, picked.release.id, picked.by, priority);
  }
}
export function unlinkWork(workId: string) {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM work_catalogue_links WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM work_catalogue_match WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM recording_release_links WHERE recording_id IN (SELECT r.id FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE e.work_id=?)").run(workId);
  })();
}

// ---- Matching one work, and the batch ----
export type MatchOutcome = { outcome: "matched" | "ambiguous" | "missing" | "failed"; reason: string | null; candidates: number };
function recordOutcome(workId: string, outcome: MatchOutcome) {
  sqlite
    .prepare(
      `INSERT INTO work_catalogue_match(work_id,outcome,reason,candidates,checked_at) VALUES(?,?,?,?,?)
       ON CONFLICT(work_id) DO UPDATE SET outcome=excluded.outcome,reason=excluded.reason,candidates=excluded.candidates,checked_at=excluded.checked_at`,
    )
    .run(workId, outcome.outcome, outcome.reason, outcome.candidates, Date.now());
}
export function matchOutcome(workId: string): (MatchOutcome & { checkedAt: number }) | null {
  return (sqlite.prepare("SELECT outcome,reason,candidates,checked_at AS checkedAt FROM work_catalogue_match WHERE work_id=?").get(workId) as (MatchOutcome & { checkedAt: number }) | undefined) ?? null;
}

/** One work: by the file's ASIN, else by exact title and author on AudiobookDB, else (no audio) on Open Library. */
export async function matchWork(workId: string, priority: Priority = "background"): Promise<MatchOutcome> {
  const work = workRow(workId);
  if (!work) throw new Error("This book is not on the server.");
  const recordings = workRecordings(workId);
  const asin = recordings.find((recording) => recording.asin)?.asin ?? null;
  if (asin) {
    const hit = await audiobookDbByAsin(asin, { priority });
    if (hit) {
      await linkWork(workId, { provider: "audiobookdb", id: hit.bookId }, "asin", priority);
      return { outcome: "matched", reason: null, candidates: 1 };
    }
  }
  let decision = decide(work, await searchAudiobookDbBooks(`${work.title} ${work.author}`, { priority }));
  if (decision.outcome !== "matched") {
    const byTitle = decide(work, await searchAudiobookDbBooks(work.title, { priority }));
    if (byTitle.outcome === "matched" || decision.outcome === "missing") decision = byTitle;
  }
  if (decision.outcome === "matched") {
    const releases = await audiobookDbReleases(decision.book.id, { priority });
    if (releases.length && !releases.some(englishRelease)) {
      const outcome: MatchOutcome = { outcome: "missing", reason: "No English release on AudiobookDB.", candidates: 0 };
      recordOutcome(workId, outcome);
      return outcome;
    }
    await linkWork(workId, { provider: "audiobookdb", id: decision.book.id }, "title", priority);
    return { outcome: "matched", reason: null, candidates: 1 };
  }
  // A book without an audiobook is not on AudiobookDB: Open Library gives it its link.
  if (!recordings.length) {
    const open = decide(work, await searchOpenLibrary(`${work.title} ${work.author}`, { priority }));
    if (open.outcome === "matched") {
      await linkWork(workId, { provider: "openlibrary", id: open.book.id, author: open.book.authors.join(", ") }, "title", priority);
      return { outcome: "matched", reason: null, candidates: 1 };
    }
  }
  const outcome: MatchOutcome =
    decision.outcome === "ambiguous"
      ? { outcome: "ambiguous", reason: null, candidates: decision.candidates }
      : { outcome: "missing", reason: null, candidates: 0 };
  recordOutcome(workId, outcome);
  return outcome;
}

export type BatchStatus = { running: boolean; startedAt: number | null; finishedAt: number | null; done: number; total: number; matched: number; error: string | null };
let batch: BatchStatus = { running: false, startedAt: null, finishedAt: null, done: 0, total: 0, matched: 0, error: null };
let batchRun: Promise<void> | null = null;
export const batchStatus = (): BatchStatus => ({ ...batch });
/** Tests: wait for the batch that is running. */
export const batchFinished = () => batchRun ?? Promise.resolve();

/** Starts the batch over every work without a link, unless one is running. */
export function startBatchMatch(): BatchStatus {
  if (batch.running) return batchStatus();
  const works = sqlite.prepare("SELECT id FROM works WHERE id NOT IN (SELECT work_id FROM work_catalogue_links) ORDER BY title").pluck().all() as string[];
  batch = { running: true, startedAt: Date.now(), finishedAt: null, done: 0, total: works.length, matched: 0, error: null };
  batchRun = (async () => {
    for (const workId of works) {
      try {
        const outcome = await matchWork(workId, "background");
        if (outcome.outcome === "matched") batch.matched++;
      } catch (error) {
        const reason = (error as Error).message;
        recordOutcome(workId, { outcome: "failed", reason, candidates: 0 });
        // No key, a rejected key or the day's units spent: every next work would fail the same way.
        if (error instanceof CatalogueError && ["missing_key", "rejected", "daily_limit"].includes(error.kind)) {
          batch.error = reason;
          break;
        }
      } finally {
        batch.done++;
      }
    }
    batch.running = false;
    batch.finishedAt = Date.now();
  })();
  return batchStatus();
}

/** The works the batch could not match surely, for the administrator to pick by hand. */
export function unmatchedWorks(): { workId: string; title: string; author: string; outcome: MatchOutcome["outcome"]; reason: string | null; candidates: number }[] {
  return sqlite
    .prepare(
      `SELECT w.id AS workId,w.title,w.author,m.outcome,m.reason,m.candidates FROM work_catalogue_match m JOIN works w ON w.id=m.work_id
       WHERE m.outcome<>'matched' AND m.work_id NOT IN (SELECT work_id FROM work_catalogue_links) ORDER BY w.title`,
    )
    .all() as ReturnType<typeof unmatchedWorks>;
}

// ---- The cache's refresh and deletion obligations ----
/** One round: expired searches go; up to `limit` expired details are fetched again (a 404 deletes them). */
export async function refreshCatalogue(now = Date.now(), limit = 20): Promise<{ dropped: number; refreshed: number; failed: number }> {
  const dropped = dropExpiredSearches(now);
  let refreshed = 0;
  let failed = 0;
  for (const entry of expiredDetails(now, limit)) {
    try {
      if (entry.provider === "audiobookdb") await refreshAudiobookDbEntry(entry.kind, entry.key);
      else await refreshOpenLibraryEntry(entry.kind, entry.key);
      refreshed++;
    } catch (error) {
      if (error instanceof CatalogueError && error.kind === "not_found") {
        refreshed++;
        continue;
      }
      failed++;
      // No key or no units left: the rest waits for the next round; the stale entry keeps serving.
      if (error instanceof CatalogueError && ["missing_key", "rejected", "daily_limit"].includes(error.kind)) break;
    }
  }
  return { dropped, refreshed, failed };
}
export function catalogueRefreshLoop(log: (message: string) => void): BackgroundProcess {
  return {
    id: "catalogue-refresh",
    intervalMs: 60 * 60 * 1000,
    runAtStart: false,
    tick: () =>
      refreshCatalogue().then(
        (result) => {
          if (result.failed) log(`Catalogue refresh: ${result.failed} cached entries could not be fetched again; they are tried next hour.`);
        },
        (error: Error) => log(`Catalogue refresh failed: ${error.message}`),
      ),
  };
}

/** What a work's own catalogue is called in a search on its match page. */
export const matchQuery = (work: { title: string; author: string }) => `${work.title} ${work.author}`.trim().slice(0, 150);
export { audiobookDbBook };
