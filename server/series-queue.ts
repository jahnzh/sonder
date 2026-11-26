// The series queue as the Series page shows and steers it (#898): what it does now for the series, how many of the
// series' searches wait and when the next starts; each book's place in line and what its audio search found and chose;
// and the owner's Stop searching, Resume, Search now, Search again, Skip and Choose this one instead.
import { sqlite } from "./db.ts";
import {
  SERIES_ACQUISITION_SKIPPED_ERROR,
  SERIES_ACQUISITION_STOPPED_ERROR,
  assertCanAcquireMedia,
  seriesAcquisitionTickerEnabled,
  seriesQueueTiming,
  seriesWorkAcquisitions,
  setJobState,
  tickSeriesAcquisition,
  type SeriesAcquisitionKind,
} from "./series-acquisition.ts";
import { seriesQueueOrder } from "./series-queue-order.ts";
import { markOwnerChoice, parseSeriesChoice, type StoredSeriesChoice } from "./series-queue-store.ts";
import { rememberAbbSlugs, savedSeriesWork, selectSeriesWorkRelease } from "./series-release-search.ts";
import { prowlarrRelease, prowlarrReleaseSearch } from "./services.ts";
import { clearWorkMediaHold, getWorkMediaState, workHasActiveQueuedAcquisition, workHasPlayableAudio } from "./work-media-state.ts";

const KINDS: readonly SeriesAcquisitionKind[] = ["audio", "ebook"];

type JobRow = {
  id: string;
  userId: number;
  seriesId: string;
  bookId: string;
  workId: string;
  kind: SeriesAcquisitionKind;
  status: string;
  error: string | null;
  retryAt: number | null;
  candidates: string | null;
};

const JOB_COLUMNS = `id, user_id AS userId, series_id AS seriesId, book_id AS bookId, work_id AS workId, kind, status, error,
  retry_at AS retryAt, candidates`;

function fail(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

/** The job of one kind of a saved book: by its work first, as the Series page reads it (`seriesWorkAcquisitions`). */
function bookJob(userId: number, seriesId: string, bookId: string, workId: string, kind: SeriesAcquisitionKind) {
  return (sqlite.prepare(`SELECT ${JOB_COLUMNS} FROM series_acquisition_jobs WHERE user_id=? AND work_id=? AND kind=?`).get(userId, workId, kind) ??
    sqlite
      .prepare(`SELECT ${JOB_COLUMNS} FROM series_acquisition_jobs WHERE user_id=? AND series_id=? AND book_id=? AND kind=?`)
      .get(userId, seriesId, bookId, kind)) as JobRow | undefined;
}

/**
 * Every place in the queue: the search running now is 1st, the waiting jobs that may run follow in the queue's order
 * (as Activity counts them); a job waiting to try its source again has none until its time.
 */
function queuePlaces(now: number) {
  const rows = sqlite
    .prepare(`SELECT id, status, retry_at AS retryAt FROM series_acquisition_jobs WHERE status IN ('pending','searching') ORDER BY ${seriesQueueOrder()}`)
    .all() as { id: string; status: string; retryAt: number | null }[];
  let place = rows.filter((row) => row.status === "searching").length;
  const places = new Map<string, number>();
  for (const row of rows) if (row.status === "pending" && !(row.retryAt && row.retryAt > now)) places.set(row.id, ++place);
  return places;
}

/** The run of the series' searches, for the line above its books. */
export type SeriesQueueOverview = {
  /** The series' search running now; null when none of the series' runs. */
  searching: { bookId: string; kind: SeriesAcquisitionKind } | null;
  /** A search of another series runs now: the series' searches wait behind it. */
  otherSearching: boolean;
  /** The series' searches that wait, those waiting to try a source again among them. */
  waiting: number;
  retrying: number;
  /** The series' searches the owner stopped, which Resume puts back. */
  stopped: number;
  /** When the queue starts its next search (server time); null while one runs or when it is not known. */
  nextAt: number | null;
  /** The series queue is switched off on Activity's Server page. */
  paused: boolean;
  /** The server's time of the answer, so a device whose clock differs counts the seconds right. */
  now: number;
};

export function seriesQueueOverview(userId: number, seriesId: string, now = Date.now()): SeriesQueueOverview {
  const jobs = sqlite
    .prepare(`SELECT ${JOB_COLUMNS} FROM series_acquisition_jobs WHERE user_id=? AND series_id=? ORDER BY ${seriesQueueOrder()}`)
    .all(userId, seriesId) as JobRow[];
  const searching = jobs.find((job) => job.status === "searching");
  const anySearching = !!sqlite.prepare("SELECT 1 FROM series_acquisition_jobs WHERE status='searching' LIMIT 1").get();
  const pending = jobs.filter((job) => job.status === "pending");
  const timing = seriesQueueTiming();
  const paused = !seriesAcquisitionTickerEnabled();
  // The queue waits out its 30 s between searches only while a run goes; with none running the loop's next tick starts
  // it. The time is the series' own only when its search is the next the queue starts (1st in line).
  const places = queuePlaces(now);
  const seriesNext = pending.some((job) => places.get(job.id) === 1);
  const nextAt = !paused && !anySearching && seriesNext && timing.running ? Math.max(now, timing.nextAt) : null;
  return {
    searching: searching ? { bookId: searching.bookId, kind: searching.kind } : null,
    otherSearching: anySearching && !searching,
    waiting: pending.length,
    retrying: pending.filter((job) => job.retryAt && job.retryAt > now).length,
    stopped: jobs.filter((job) => job.status === "failed" && job.error === SERIES_ACQUISITION_STOPPED_ERROR).length,
    nextAt,
    paused,
    now,
  };
}

/** What a book's search state adds on the Series page (#898): its place in line, and how many releases were found. */
export type SeriesQueueFacts = {
  place: number | null;
  retrying: boolean;
  /** Releases the audio search found; null before a search kept any. */
  found: number | null;
  /** The audio search picked one and asked for its download. */
  chosen: boolean;
};

function queueFacts(job: JobRow | undefined, places: Map<string, number>, now: number): SeriesQueueFacts | null {
  if (!job) return null;
  const choice = parseSeriesChoice(job.candidates);
  return {
    place: places.get(job.id) ?? null,
    retrying: job.status === "pending" && !!job.retryAt && job.retryAt > now,
    found: choice ? choice.candidates.length : null,
    chosen: !!choice?.chosen,
  };
}

type AnswerWork = { id: string; workId?: string | null; acquisition?: Record<string, unknown> | null };

/** The saved series' answer with the queue's run and each book's place and finds laid over its search states. */
export function withSeriesQueue<T>(userId: number, seriesId: string, answer: T, now = Date.now()): T {
  const value = answer as unknown as { works?: AnswerWork[] };
  if (!value || !Array.isArray(value.works)) return answer;
  const places = queuePlaces(now);
  const works = value.works.map((work) => {
    if (!work.acquisition || !work.workId) return work;
    const acquisition = { ...work.acquisition };
    for (const kind of KINDS) {
      const state = acquisition[kind];
      if (!state) continue;
      const facts = queueFacts(bookJob(userId, seriesId, work.id, work.workId, kind), places, now);
      acquisition[kind] = { ...(state as object), ...(facts ?? {}) };
    }
    return { ...work, acquisition };
  });
  return { ...(answer as object), works, queue: seriesQueueOverview(userId, seriesId, now) } as T;
}

function unreleasedBook(seriesId: string, bookId: string) {
  const row = sqlite.prepare("SELECT unreleased FROM series_catalogue_works WHERE series_id=? AND book_id=?").get(seriesId, bookId) as
    | { unreleased: number }
    | undefined;
  return !!row?.unreleased;
}

/** A book's searches as its sheet shows them: each kind's state and place, and what the audio search found and chose. */
export function seriesWorkSearch(userId: number, seriesId: string, bookId: string, now = Date.now()) {
  assertCanAcquireMedia(userId);
  const work = savedSeriesWork(userId, seriesId, bookId);
  const states = seriesWorkAcquisitions(userId, seriesId, bookId, work.workId, unreleasedBook(seriesId, bookId));
  const places = queuePlaces(now);
  const kind = (name: SeriesAcquisitionKind) => {
    const job = bookJob(userId, seriesId, bookId, work.workId, name);
    const state = states[name];
    return state ? { ...state, ...(queueFacts(job, places, now) ?? {}) } : null;
  };
  const audioJob = bookJob(userId, seriesId, bookId, work.workId, "audio");
  const choice: StoredSeriesChoice | null = parseSeriesChoice(audioJob?.candidates);
  return {
    bookId,
    workId: work.workId,
    title: work.title,
    audio: kind("audio"),
    ebook: kind("ebook"),
    choice,
    /** The book has playable audio: a choice adds another recording to it. */
    hasAudio: workHasPlayableAudio(work.workId),
    mediaState: getWorkMediaState(userId, work.workId),
  };
}

/** Starts the queue at once, unless it is switched off on Activity's Server page (or by its environment flag). */
const kick = () => {
  if (seriesAcquisitionTickerEnabled()) void tickSeriesAcquisition().catch(() => {});
};

/** Stop searching for this series: its waiting searches are stopped; a search running now is not cut off. */
export function stopSeriesSearches(userId: number, seriesId: string, now = Date.now()) {
  assertCanAcquireMedia(userId);
  const stopped = sqlite
    .prepare(
      `UPDATE series_acquisition_jobs SET status='failed', error=?, front_at=NULL, retry_at=NULL, updated_at=?
       WHERE user_id=? AND series_id=? AND status='pending'`,
    )
    .run(SERIES_ACQUISITION_STOPPED_ERROR, now, userId, seriesId).changes;
  return { stopped, queue: seriesQueueOverview(userId, seriesId, now) };
}

/** Resume: the searches Stop stopped wait in the queue again, in its own order. */
export function resumeSeriesSearches(userId: number, seriesId: string, now = Date.now()) {
  assertCanAcquireMedia(userId);
  const resumed = sqlite
    .prepare(
      `UPDATE series_acquisition_jobs SET status='pending', error=NULL, auto_retries=0, retry_at=NULL, updated_at=?
       WHERE user_id=? AND series_id=? AND status='failed' AND error=?`,
    )
    .run(now, userId, seriesId, SERIES_ACQUISITION_STOPPED_ERROR).changes;
  if (resumed) kick();
  return { resumed, queue: seriesQueueOverview(userId, seriesId, now) };
}

function kindsOf(kind: SeriesAcquisitionKind | undefined) {
  return kind ? [kind] : KINDS;
}

/**
 * Skip: no search or download of this kind for the book (both kinds without one). A search running now finishes its
 * search but downloads nothing; a download already on its way is not cancelled (Activity cancels it).
 */
export function skipSeriesWork(userId: number, seriesId: string, bookId: string, kind?: SeriesAcquisitionKind, now = Date.now()) {
  assertCanAcquireMedia(userId);
  const work = savedSeriesWork(userId, seriesId, bookId);
  let skipped = 0;
  for (const name of kindsOf(kind)) {
    const job = bookJob(userId, seriesId, bookId, work.workId, name);
    if (!job) continue;
    // An ebook search downloads as it searches: once it runs it cannot be skipped. A running audio search downloads
    // only after it has searched, and asks first whether it still may.
    if (name === "ebook" && job.status === "searching") {
      if (kind) throw fail(409, "This ebook search is running now. Skip it once it has ended.");
      continue;
    }
    skipped += sqlite
      .prepare("UPDATE series_acquisition_jobs SET status='failed', error=?, front_at=NULL, retry_at=NULL, search_only=0, updated_at=? WHERE id=?")
      .run(SERIES_ACQUISITION_SKIPPED_ERROR, now, job.id).changes;
  }
  return { skipped, ...seriesWorkSearch(userId, seriesId, bookId, now) };
}

/** A job of the book waits at the front of the queue: the next search the queue starts (the latest asked first). */
function toFront(job: JobRow, now: number, searchOnly: boolean) {
  sqlite
    .prepare(
      `UPDATE series_acquisition_jobs SET status='pending', error=NULL, auto_retries=0, retry_at=NULL, front_at=?, search_only=?, updated_at=?
       WHERE id=? AND status<>'searching'`,
    )
    .run(now, searchOnly ? 1 : 0, now, job.id);
}

/** A search for a book that has its audiobook, or one on its way, finds releases and downloads nothing. */
function audioSearchOnly(userId: number, workId: string) {
  return workHasPlayableAudio(workId) || workHasActiveQueuedAcquisition(userId, workId);
}

/**
 * Search now: the book's waiting (or stopped, skipped, failed) searches move to the front of the queue. A search
 * running now or one that is done is left as it is; Search again runs a done one again.
 */
export function searchSeriesWorkNow(userId: number, seriesId: string, bookId: string, kind?: SeriesAcquisitionKind, now = Date.now()) {
  assertCanAcquireMedia(userId);
  const work = savedSeriesWork(userId, seriesId, bookId);
  let moved = 0;
  for (const name of kindsOf(kind)) {
    const job = bookJob(userId, seriesId, bookId, work.workId, name);
    if (!job || job.status === "searching" || job.status === "done" || job.error === "no_permission") continue;
    const searchOnly = name === "audio" && audioSearchOnly(userId, work.workId);
    if (name === "audio" && !searchOnly) clearWorkMediaHold(userId, work.workId);
    toFront(job, now, searchOnly);
    moved++;
  }
  if (moved) kick();
  return { moved, ...seriesWorkSearch(userId, seriesId, bookId, now) };
}

/**
 * Search again: the book's search of this kind runs again, first in the queue. For a book that has its audiobook (or
 * one on its way) the audio search finds the releases again and downloads nothing; the owner chooses from them.
 */
export function searchSeriesWorkAgain(userId: number, seriesId: string, bookId: string, kind: SeriesAcquisitionKind, now = Date.now()) {
  assertCanAcquireMedia(userId);
  const work = savedSeriesWork(userId, seriesId, bookId);
  let job = bookJob(userId, seriesId, bookId, work.workId, kind);
  if (job?.status === "searching") throw fail(409, "This book is being searched now.");
  if (!job) {
    setJobState(userId, seriesId, bookId, work.workId, kind, "pending");
    job = bookJob(userId, seriesId, bookId, work.workId, kind)!;
  }
  const searchOnly = kind === "audio" && audioSearchOnly(userId, work.workId);
  if (kind === "audio" && !searchOnly) clearWorkMediaHold(userId, work.workId);
  toFront(job, now, searchOnly);
  kick();
  return seriesWorkSearch(userId, seriesId, bookId, now);
}

/**
 * Choose this one instead: a release the book's audio search found is downloaded for it, through the manual select
 * (`selectSeriesWorkRelease`), replacing the download on its way. It is the book's chosen release from then on.
 */
export async function chooseSeriesCandidate(
  userId: number,
  seriesId: string,
  bookId: string,
  wanted: { key?: string; source?: "abb" | "prowlarr" | "mam"; id?: string },
) {
  assertCanAcquireMedia(userId);
  const work = savedSeriesWork(userId, seriesId, bookId);
  const job = bookJob(userId, seriesId, bookId, work.workId, "audio");
  const choice = parseSeriesChoice(job?.candidates);
  const candidate = choice?.candidates.find((entry) =>
    wanted.key ? entry.key === wanted.key : entry.source === wanted.source && entry.id === wanted.id,
  );
  if (!job || !candidate) throw fail(404, "This release is not among what the search found. Search again.");
  // A release the queue's search found may be chosen as one from the Get sheet's search is.
  if (candidate.source === "abb") rememberAbbSlugs([{ id: candidate.id }]);
  // A MAM torrent is got by its id alone (#911).
  else if (candidate.source === "prowlarr") await refreshProwlarrLink(candidate);
  const result = await selectSeriesWorkRelease(userId, seriesId, bookId, {
    source: candidate.source,
    id: candidate.id,
    replaceActive: true,
    confirmExistingAudio: true,
  });
  markOwnerChoice(job.id, candidate);
  return { ...result, search: seriesWorkSearch(userId, seriesId, bookId) };
}

/**
 * A Prowlarr result's download link is kept for 6 hours after its search (and not over a restart). A release found
 * longer ago is looked for again by its title: Prowlarr's ids are the same for the same result.
 */
async function refreshProwlarrLink(candidate: { id: string; title: string }) {
  try {
    prowlarrRelease(candidate.id);
    return;
  } catch (error) {
    void (error as Error).message;
  }
  await prowlarrReleaseSearch(candidate.title).catch((error: Error) => {
    throw fail(409, `${error.message} Search again, then choose.`);
  });
  try {
    prowlarrRelease(candidate.id);
  } catch (error) {
    void (error as Error).message;
    throw fail(409, "Prowlarr no longer lists this release. Search again, then choose.");
  }
}

/** The Get sheet's select for a series book (`selectSeriesWorkRelease`): the release is the book's chosen one too. */
export function noteOwnerSelect(userId: number, seriesId: string, bookId: string, release: { source: "abb" | "prowlarr" | "mam"; id: string; title?: string | null }) {
  try {
    const work = savedSeriesWork(userId, seriesId, bookId);
    const job = bookJob(userId, seriesId, bookId, work.workId, "audio");
    if (job) markOwnerChoice(job.id, release);
  } catch (error) {
    // Only shown on the Series page: the select itself went through.
    console.warn(`series queue: could not note the chosen release: ${(error as Error).message}`);
  }
}
