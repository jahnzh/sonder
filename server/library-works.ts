/*
 * The library by work (#485, spec #480 "The library by work"): `GET /api/library` returns every work
 * in the user's library and `GET /api/works/<workId>` one work, in the library or not, both in the
 * `LibraryWork` shape of `src/types.ts`. `GET /api/books` (one entry per audio edition and
 * recording) stays as it is for older clients.
 *
 * Placeholder audio editions (`placeholder-edition.ts`) never leave this module: a recording is
 * listed only when its audio edition is in the user's library and is not a placeholder, and a
 * placeholder only lends its cover to a work without recordings.
 *
 * Each part is built by the code that builds it for its own route (#487): completion as the series
 * read (`work-completion.ts`), ebook files as `GET /api/ebooks`, reading sync in the summary form of
 * `GET /api/alignments`, media states as `GET /api/books`, the Hardcover block as `GET /api/books`.
 * Every field is the requesting user's, or one every user of the work sees through such a route;
 * what only the administrator sees elsewhere (a copy to the server, an acquisition's status,
 * progress and error) is left out for anyone else.
 */
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { z } from "zod";
import { currentUserId, setUserSetting, userIsAdmin } from "./users.ts";
import { hardcoverForWorks, hiddenHardcoverPlaceholders } from "./hardcover.ts";
import { deliveredTracks } from "./media-library.ts";
import { choiceKey, chosenRecordingId, fallbackCovers, idList, listedRecordings, storedChoices } from "./work-cover.ts";
import { readerPlaces, workCompletions } from "./work-completion.ts";
import { ebookFile } from "./ebooks.ts";
import { listEbookSetMembers } from "./ebook-set.ts";
import { consensusEbookId, defaultEbookIds } from "./ebook-set-consensus.ts";
import { listServedAlignmentSummaries, type slimAlignmentJob } from "./alignment-transitions.ts";
import { getWorkMediaStates } from "./work-media-state.ts";
import type {
  Book,
  LibraryWork,
  MediaFault,
  Progress,
  ReadingSyncSummary,
  WorkEbook,
  WorkMediaState,
  WorkRecording,
  WorkSeries,
} from "../src/types.ts";

type TrackRow = typeof s.tracks.$inferSelect;

/**
 * A file's size on the server (null: not there) is remembered for `ttlMs`, keyed by its path: a
 * local track's source, a `media_copies` row's path, an ebook edition's source. The server writes
 * such a row only once its file is in place (`downloads.ts` renames the copy, then writes its row;
 * an upload or a finished torrent writes its tracks after the files; an ebook is written before
 * its edition row) and removes the file only with its row or after it (`media-library.ts` removes
 * a copy and its row together, `series-removal.ts` deletes the rows first), so a change made
 * through the server never meets a wrong answer here. A file added, removed or resized outside the
 * server shows within `ttlMs`. `now` is replaced by tests.
 */
export const filePresence = { ttlMs: 5_000, now: () => Date.now() };
const sizes = new Map<string, { size: number | null; checkedAt: number }>();
/** One file check behind a response: a path and the size seen (null: not there). */
type FileCheck = { path: string; size: number | null };

/** The file's size, or null when it is not there or cannot be read (as `existsSync`). */
function fileSize(path: string) {
  const now = filePresence.now();
  const known = sizes.get(path);
  if (known && now - known.checkedAt < filePresence.ttlMs) return known.size;
  let size: number | null = null;
  try {
    size = statSync(path, { throwIfNoEntry: false })?.size ?? null;
  } catch (error) {
    // As `existsSync`: a path that cannot be read counts as absent. An unexpected reason gets a line in the log.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES")
      console.warn(`library read: could not check a media file (${code ?? String(error)})`);
    size = null;
  }
  if (sizes.size >= 100_000) sizes.clear();
  sizes.set(path, { size, checkedAt: now });
  return size;
}

/** `fileSize`, with each check added to `files` so a later read can tell whether it still holds. */
function checkedFileSize(files: FileCheck[], path: string) {
  const size = fileSize(path);
  files.push({ path, size });
  return size;
}

/** `faultsFor` (`media-library.ts`) for many recordings in one query. */
function faultsByRecording(recordingIds: string[]) {
  const rows = sqlite
    .prepare(
      `SELECT recording_id AS recordingId,scope,reason,note,updated_at AS updatedAt FROM media_faults
       WHERE recording_id IN (SELECT value FROM json_each(?)) ORDER BY recording_id,scope`,
    )
    .all(idList(recordingIds)) as ({ recordingId: string; scope: "recording" | "server" | "original" } & MediaFault)[];
  const faults = new Map<string, NonNullable<Book["faults"]>>();
  for (const { recordingId, scope, reason, note, updatedAt } of rows)
    faults.set(recordingId, { ...faults.get(recordingId), [scope]: { reason, note, updatedAt } });
  return faults;
}

/**
 * The user's recordings of `workIds` (`listedRecordings`) in the `WorkRecording` shape. Each file
 * check made is added to `files`.
 */
function recordingsByWork(userId: number, workIds: string[], files: FileCheck[]) {
  const rows = listedRecordings(sqlite, userId, workIds);
  const byWork = new Map<string, WorkRecording[]>();
  if (!rows.length) return byWork;
  const recordingIds = rows.map((row) => row.recordingId);
  const tracks = new Map<string, TrackRow[]>();
  for (const track of db.select().from(s.tracks).where(inArray(s.tracks.recordingId, recordingIds)).all())
    tracks.set(track.recordingId, [...(tracks.get(track.recordingId) ?? []), track]);
  const copies = new Map(
    (
      sqlite
        .prepare(
          `SELECT c.track_id AS trackId,c.path,c.size FROM media_copies c JOIN tracks t ON t.id=c.track_id
           WHERE t.recording_id IN (SELECT value FROM json_each(?))`,
        )
        .all(idList(recordingIds)) as { trackId: string; path: string; size: number }[]
    ).map((copy) => [copy.trackId, copy]),
  );
  // `hasServerMedia` (`downloads.ts`) without a query per track: a local track's file is there, or
  // a copy's file is there with the copy's size.
  const onServer = (track: TrackRow) => {
    if (track.sourceType === "local" && checkedFileSize(files, track.source) !== null) return true;
    const copy = copies.get(track.id);
    return !!copy && checkedFileSize(files, copy.path) === copy.size;
  };
  const places = new Map(
    db
      .select()
      .from(s.userProgress)
      .where(and(eq(s.userProgress.userId, userId), inArray(s.userProgress.recordingId, recordingIds)))
      .all()
      .map((place) => [place.recordingId, place]),
  );
  // The copy queue is the administrator's, as `/api/acquisitions` and `/api/activity` are: a copy's
  // status, progress and error (which can name server paths) are not shown to anyone else.
  const serverCopies = userIsAdmin(userId)
    ? new Map(
        db
          .select()
          .from(s.serverDownloads)
          .where(inArray(s.serverDownloads.recordingId, recordingIds))
          .all()
          .map((copy) => [copy.recordingId, copy]),
      )
    : new Map<string, typeof s.serverDownloads.$inferSelect>();
  const faultsOf = faultsByRecording(recordingIds);
  for (const row of rows) {
    const faults = faultsOf.get(row.recordingId) ?? {};
    const delivered = deliveredTracks(tracks.get(row.recordingId) ?? [], faults, onServer);
    const place = places.get(row.recordingId);
    const copy = serverCopies.get(row.recordingId);
    const progress: Progress | null = place
      ? {
          recordingId: place.recordingId,
          trackId: place.trackId,
          position: place.position,
          duration: place.duration,
          updatedAt: place.updatedAt,
        }
      : null;
    const recording: WorkRecording = {
      recordingId: row.recordingId,
      editionId: row.editionId,
      narrator: row.narrator,
      language: row.language,
      releaseTitle: row.releaseTitle,
      sourceLabel: row.sourceLabel,
      cover: row.cover,
      duration: delivered.tracks.reduce((total, track) => total + track.duration, 0),
      tracks: delivered.tracks,
      serverStored: delivered.serverStored,
      faults,
      progress,
      serverCopy:
        copy && copy.status !== "ready"
          ? { status: copy.status, progress: copy.progress, error: copy.error }
          : null,
    };
    byWork.set(row.workId, [...(byWork.get(row.workId) ?? []), recording]);
  }
  return byWork;
}

/**
 * The ebook editions of `workIds` (without the consensus text of an ebook set) with their files,
 * their checks against the narration and the user's places, and the shared default of each work.
 * Each file check made is added to `files`.
 */
function ebooksByWork(userId: number, workIds: string[], files: FileCheck[]) {
  const rows = (
    sqlite
      .prepare(
        `SELECT work_id AS workId,id,format,source FROM ebook_editions
         WHERE work_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
      )
      .all(idList(workIds)) as { workId: string; id: string; format: string; source: string }[]
  ).filter((row) => row.id !== consensusEbookId(row.workId));
  const byWork = new Map<string, WorkEbook[]>();
  const chosen = new Map<string, string>();
  if (!rows.length) return { byWork, chosen };
  const places = readerPlaces(userId, workIds);
  const checks = new Map<string, WorkEbook["check"]>();
  for (const workId of new Set(rows.map((row) => row.workId)))
    for (const member of listEbookSetMembers(workId))
      checks.set(member.ebookId, { status: member.status, holdReason: member.holdReason });
  for (const row of rows) {
    const place = places.get(row.id);
    const ebook: WorkEbook = {
      id: row.id,
      format: row.format,
      ...ebookFile(row.source, (path) => checkedFileSize(files, path)),
      check: checks.get(row.id) ?? null,
      place: place ? { progression: place.progression, origin: place.origin, updatedAt: place.updatedAt } : null,
    };
    byWork.set(row.workId, [...(byWork.get(row.workId) ?? []), ebook]);
  }
  for (const [workId, ebookId] of defaultEbookIds([...byWork.keys()]))
    if (byWork.get(workId)?.some((ebook) => ebook.id === ebookId)) chosen.set(workId, ebookId);
  return { byWork, chosen };
}

/** The alignment list's summary form without steps, workers and stage times: those stay on the alignment routes. */
function readingSyncSummary(job: ReturnType<typeof slimAlignmentJob>): ReadingSyncSummary {
  const {
    anchoring: _anchoring,
    pairings: _pairings,
    sectionsDone: _sectionsDone,
    pool: _pool,
    poolErrors: _poolErrors,
    bookJob: _bookJob,
    runConfig: _runConfig,
    ctcDevice: _ctcDevice,
    ctcPrecision: _ctcPrecision,
    gpuUtilization: _gpuUtilization,
    gpuUtilizationSamples: _gpuUtilizationSamples,
    stageTimings: _stageTimings,
    elapsedSeconds: _elapsedSeconds,
    ...summary
  } = job;
  if (!summary.rebuild) return summary;
  // The new job's steps, run and workers (#538) are for the Reading sync page: the work lists its state only.
  const {
    generation: _generation,
    bookJob: _rebuildBookJob,
    poolErrors: _rebuildPoolErrors,
    coverage: _coverage,
    elapsedSeconds: _rebuildElapsedSeconds,
    createdAt: _createdAt,
    ...rebuild
  } = summary.rebuild;
  return { ...summary, rebuild };
}

/**
 * For each work, one reading sync entry per pair of one of its listed recordings and one of its
 * listed ebook editions that has a job (`alignment_jobs` holds one per pair), ordered by recording,
 * then edition.
 */
function readingSyncByWork(recordings: Map<string, WorkRecording[]>, ebooks: Map<string, WorkEbook[]>) {
  const byWork = new Map<string, ReadingSyncSummary[]>();
  const recordingIds = [...recordings.entries()].flatMap(([workId, list]) =>
    ebooks.has(workId) ? list.map((recording) => recording.recordingId) : [],
  );
  if (!recordingIds.length) return byWork;
  const jobs = new Map(listServedAlignmentSummaries(recordingIds).map((job) => [`${job.recordingId}\n${job.ebookId}`, job]));
  for (const [workId, list] of recordings)
    for (const recording of list)
      for (const ebook of ebooks.get(workId) ?? []) {
        const job = jobs.get(`${recording.recordingId}\n${ebook.id}`);
        if (job) byWork.set(workId, [...(byWork.get(workId) ?? []), readingSyncSummary(job)]);
      }
  return byWork;
}

/** The Hardcover series of a work, the ones in `saved` (the user's saved series) first, then in Hardcover's order. */
function workSeries(hardcover: LibraryWork["hardcover"], saved: Set<number>): WorkSeries[] {
  const series = (hardcover?.series ?? []).map((entry) => ({
    id: entry.id ?? null,
    name: entry.name,
    position: entry.position ?? null,
    saved: entry.id !== undefined && saved.has(entry.id),
  }));
  return [...series.filter((entry) => entry.saved), ...series.filter((entry) => !entry.saved)];
}

/**
 * The media states of `workIds` for the user (ADR 0011, `getWorkMediaStates`) with their
 * acquisitions. An acquisition's status, progress and error are the administrator's, as
 * `/api/acquisitions` and `/api/activity` are: anyone else gets its id only.
 */
function mediaStates(userId: number, workIds: string[]) {
  const states = getWorkMediaStates(userId, workIds);
  const acquisitionIds = [...states.values()].flatMap((state) => (state.acquisitionId ? [state.acquisitionId] : []));
  const acquisitions = new Map(
    acquisitionIds.length && userIsAdmin(userId)
      ? (
          sqlite
            .prepare(
              `SELECT id,status,progress,error FROM acquisitions WHERE id IN (SELECT value FROM json_each(?))`,
            )
            .all(idList(acquisitionIds)) as { id: string; status: string; progress: number; error: string | null }[]
        ).map((row) => [row.id, row])
      : [],
  );
  const byWork = new Map<string, WorkMediaState>();
  for (const [workId, state] of states) {
    const job = state.acquisitionId ? acquisitions.get(state.acquisitionId) : undefined;
    byWork.set(workId, {
      state: state.state,
      holdReason: state.holdReason,
      acquisition: state.acquisitionId
        ? { id: state.acquisitionId, status: job?.status ?? null, progress: job?.progress ?? null, error: job?.error ?? null }
        : null,
    });
  }
  return byWork;
}

const savedSeries = (userId: number) =>
  new Set(
    (sqlite.prepare("SELECT series_id AS id FROM user_saved_series WHERE user_id=?").all(userId) as { id: number }[]).map(
      (row) => row.id,
    ),
  );

/** The user's earliest library row per work, for the works in their library. */
function libraryRows(userId: number, workIds?: string[]) {
  const rows = sqlite
    .prepare(
      `SELECT e.work_id AS workId,MIN(u.added_at) AS addedAt
       FROM user_library u JOIN audio_editions e ON e.id=u.book_id
       WHERE u.user_id=? ${workIds ? "AND e.work_id IN (SELECT value FROM json_each(?))" : ""}
       GROUP BY e.work_id
       ORDER BY addedAt,e.work_id`,
    )
    .all(...(workIds ? [userId, idList(workIds)] : [userId])) as { workId: string; addedAt: number }[];
  return new Map(rows.map((row) => [row.workId, row.addedAt]));
}

/**
 * `workIds` in the `LibraryWork` shape for `userId`, in the order given; unknown ids are left out.
 * Each file check made is added to `files`.
 */
function buildWorks(userId: number, workIds: string[], hidden: Set<string>, files: FileCheck[] = []): LibraryWork[] {
  if (!workIds.length) return [];
  const works = new Map(
    db
      .select()
      .from(s.works)
      .where(inArray(s.works.id, workIds))
      .all()
      .map((work) => [work.id, work]),
  );
  const added = libraryRows(userId, workIds);
  const recordings = recordingsByWork(userId, workIds, files);
  const choices = storedChoices(sqlite, userId, workIds);
  const covers = fallbackCovers(sqlite, userId, workIds, hidden);
  const completions = workCompletions(userId, workIds);
  const ebooks = ebooksByWork(userId, workIds, files);
  const readingSync = readingSyncByWork(recordings, ebooks.byWork);
  const states = mediaStates(userId, workIds);
  const saved = savedSeries(userId);
  const hardcoverBlocks = hardcoverForWorks(userId, workIds);
  return workIds.flatMap((workId) => {
    const work = works.get(workId);
    if (!work) return [];
    const listed = recordings.get(workId) ?? [];
    const chosen = chosenRecordingId(listed, { stored: choices.get(workId) ?? null });
    const hardcover = hardcoverBlocks.get(workId) ?? null;
    const completion = completions.get(workId);
    return [
      {
        workId,
        title: work.title,
        author: work.author,
        description: work.description,
        genre: work.genre,
        year: work.year,
        cover: listed.find((recording) => recording.recordingId === chosen)?.cover ?? covers.get(workId)?.cover ?? "",
        inLibrary: added.has(workId),
        addedAt: added.get(workId) ?? null,
        finished: completion?.finished ?? false,
        completionOverride: completion?.completionOverride ?? null,
        chosenRecordingId: chosen,
        recordings: listed,
        chosenEbookId: ebooks.chosen.get(workId) ?? null,
        ebooks: ebooks.byWork.get(workId) ?? [],
        readingSync: readingSync.get(workId) ?? [],
        series: workSeries(hardcover, saved),
        mediaState: states.get(workId) ?? null,
        hardcover,
      },
    ];
  });
}

/** Every work in the user's library, the earliest added first. */
function libraryWorks(userId: number, files: FileCheck[]): LibraryWork[] {
  return buildWorks(userId, [...libraryRows(userId).keys()], hiddenHardcoverPlaceholders(userId), files);
}

/**
 * One work for `userId`, in the library or not; null when it does not exist or when every audio
 * edition it has is a placeholder the user may not see (`hiddenHardcoverPlaceholders`).
 */
function libraryWork(userId: number, workId: string): LibraryWork | null {
  const hidden = hiddenHardcoverPlaceholders(userId);
  const editions = db
    .select({ id: s.editions.id })
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all();
  if (editions.length && editions.every((edition) => hidden.has(edition.id))) return null;
  return buildWorks(userId, [workId], hidden)[0] ?? null;
}

let totalChanges: import("better-sqlite3").Statement<[], number> | null = null;
/**
 * Changes whenever a row of the database changes: through the server's connection
 * (`total_changes()`, which never goes down) or through another one (`data_version`).
 */
function databaseVersion() {
  totalChanges ??= sqlite.prepare("SELECT total_changes()").pluck() as import("better-sqlite3").Statement<[], number>;
  return `${sqlite.pragma("data_version", { simple: true })}:${totalChanges.get()}`;
}

/** The last library read per user: its body and tag hold while neither the database nor a file it checked changed. */
type LibraryRead = { database: string; files: FileCheck[]; body: string; tag: string };
const libraryReads = new Map<number, LibraryRead>();

/**
 * The user's library as a response body and entity tag. A poll of an unchanged library costs a
 * look at the database's change counters and the remembered file checks (`filePresence`); any
 * change rebuilds the body, and the tag is the body's, so it changes exactly when the body does.
 */
function libraryRead(userId: number): LibraryRead {
  const database = databaseVersion();
  const last = libraryReads.get(userId);
  if (last && last.database === database && last.files.every((file) => fileSize(file.path) === file.size))
    return last;
  const files: FileCheck[] = [];
  const body = JSON.stringify(libraryWorks(userId, files));
  const read = { database, files, body, tag: entityTag(userId, body) };
  libraryReads.set(userId, read);
  return read;
}

/** Per user: two users with the same library get different tags. */
function entityTag(userId: number, body: string) {
  return `"${createHash("sha256").update(`${userId}\n${body}`).digest("hex").slice(0, 32)}"`;
}

/**
 * Whether `If-None-Match` names `tag`. Compared weakly (RFC 9110), and a tag the reverse proxy's
 * compression marked with its encoding (`"<tag>-gzip"`) still counts.
 */
function matchesTag(header: string | string[] | undefined, tag: string) {
  if (!header) return false;
  const bare = tag.slice(1, -1);
  const names = [bare, `${bare}-gzip`, `${bare}-zstd`, `${bare}-br`];
  return String(header)
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === "*" || names.includes(part.replace(/^W\//, "").replace(/^"|"$/g, "")));
}

export function registerLibraryWorks(app: FastifyInstance) {
  app.get("/api/library", async (req, reply) => {
    const { body, tag } = libraryRead(currentUserId(req));
    reply.header("ETag", tag).header("Cache-Control", "private, no-cache");
    if (matchesTag(req.headers["if-none-match"], tag)) return reply.code(304).send();
    return reply.type("application/json; charset=utf-8").send(body);
  });
  app.get("/api/works/:workId", async (req, reply) => {
    const { workId } = req.params as { workId: string };
    const work = libraryWork(currentUserId(req), workId);
    if (!work) return reply.code(404).send({ error: "This book could not be found." });
    return work;
  });
  /**
   * The user's chosen recording of a work (#488), the same on all their devices. Only one of the
   * user's recordings of that work (`listedRecordings`) can be chosen. Answers the work as the
   * one-work read does.
   */
  app.put("/api/works/:workId/recording", async (req, reply) => {
    const userId = currentUserId(req);
    const { workId } = req.params as { workId: string };
    const { recordingId } = z.object({ recordingId: z.string().min(1).max(300) }).parse(req.body ?? {});
    if (!db.select({ id: s.works.id }).from(s.works).where(eq(s.works.id, workId)).get())
      return reply.code(404).send({ error: "This book could not be found." });
    if (!listedRecordings(sqlite, userId, [workId]).some((row) => row.recordingId === recordingId))
      return reply.code(400).send({ error: "Choose one of the recordings of this book in your library." });
    setUserSetting(userId, choiceKey(workId), recordingId);
    return libraryWork(userId, workId);
  });
}
