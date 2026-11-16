/*
 * The library by work (#485, spec #480 "The library by work"): `GET /api/library` returns every work
 * in the user's library and `GET /api/works/<workId>` one work, in the library or not, both in the
 * `LibraryWork` shape of `src/types.ts`. `GET /api/books` (one entry per audio edition and
 * recording) stays as it is for older clients.
 *
 * Placeholder audio editions (`placeholder-edition.ts`) never leave this module: a recording is
 * listed only when its audio edition is in the user's library and is not a placeholder, and a
 * placeholder only lends its cover to a work without recordings.
 */
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { currentUserId, userIsAdmin } from "./users.ts";
import { hiddenHardcoverPlaceholders } from "./hardcover.ts";
import { deliveredTracks } from "./media-library.ts";
import { placeholderEditionSql } from "./placeholder-edition.ts";
import type { Book, LibraryWork, MediaFault, Progress, WorkRecording } from "../src/types.ts";

type ChoiceContext = { userId: number; workId: string };
/** One step of the rule for the chosen recording: a recording id, or null to leave it to the next step. */
type ChoiceStep = (recordings: WorkRecording[], context: ChoiceContext) => string | null;

/**
 * The rule for the chosen recording (GLOSSARY.md, "Chosen recording"), step by step. The user's
 * stored choice (#488) goes in front of these.
 */
const chosenRecordingSteps: ChoiceStep[] = [
  // The recording with the user's newest saved place.
  (recordings) => {
    let newest: WorkRecording | null = null;
    for (const recording of recordings)
      if (recording.progress && (!newest?.progress || recording.progress.updatedAt > newest.progress.updatedAt))
        newest = recording;
    return newest?.recordingId ?? null;
  },
  // Otherwise the one added first: recordings are listed in that order.
  (recordings) => recordings[0]?.recordingId ?? null,
];

function chosenRecordingId(recordings: WorkRecording[], context: ChoiceContext) {
  for (const step of chosenRecordingSteps) {
    const id = step(recordings, context);
    if (id) return id;
  }
  return null;
}

const idList = (ids: Iterable<string>) => JSON.stringify([...new Set(ids)]);

type RecordingRow = {
  workId: string;
  editionId: string;
  recordingId: string;
  narrator: string;
  language: string | null;
  releaseTitle: string | null;
  sourceLabel: string;
  cover: string;
};
type TrackRow = typeof s.tracks.$inferSelect;

/**
 * Whether a file is on the server is remembered for `ttlMs`, keyed by the path and size in the row
 * that names it (a local track's source, a `media_copies` row). The server writes such a row only
 * once its file is in place (`downloads.ts` renames the copy, then writes its row; an upload or a
 * finished torrent writes its tracks after the files) and removes the file only with its row or
 * after it (`media-library.ts` removes a copy and its row together, `series-removal.ts` deletes the
 * rows first), so a change made through the server never meets a wrong answer here. A file added or
 * removed outside the server shows within `ttlMs`. `now` is replaced by tests.
 */
export const filePresence = { ttlMs: 5_000, now: () => Date.now() };
const presence = new Map<string, { present: boolean; checkedAt: number }>();
/** One file check behind a response: a path, the size it must have (null: any), and the answer. */
type FileCheck = { path: string; size: number | null; present: boolean };

/** The checks of `hasServerMedia` (`downloads.ts`): the file exists, with `size` when given. */
function fileOnServer(path: string, size: number | null) {
  const key = `${size ?? ""}\n${path}`;
  const now = filePresence.now();
  const known = presence.get(key);
  if (known && now - known.checkedAt < filePresence.ttlMs) return known.present;
  let present = false;
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    present = !!stat && (size === null || stat.size === size);
  } catch {
    present = false;
  }
  if (presence.size >= 100_000) presence.clear();
  presence.set(key, { present, checkedAt: now });
  return present;
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
 * The user's recordings of `workIds`: audio editions in their library that are not placeholders.
 * Each file check made is added to `files`.
 */
function recordingsByWork(userId: number, workIds: string[], files: FileCheck[]) {
  const rows = sqlite
    .prepare(
      `SELECT e.work_id AS workId,e.id AS editionId,r.id AS recordingId,e.narrator,e.language,
         e.release_title AS releaseTitle,e.source_label AS sourceLabel,e.cover
       FROM user_library u
       JOIN audio_editions e ON e.id=u.book_id
       JOIN recordings r ON r.edition_id=e.id
       WHERE u.user_id=? AND e.work_id IN (SELECT value FROM json_each(?))
         AND NOT ${placeholderEditionSql("e.id")}
       ORDER BY u.added_at,e.rowid,r.rowid`,
    )
    .all(userId, idList(workIds)) as RecordingRow[];
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
  const check = (path: string, size: number | null) => {
    const present = fileOnServer(path, size);
    files.push({ path, size, present });
    return present;
  };
  // `hasServerMedia` without a query per track.
  const onServer = (track: TrackRow) => {
    if (track.sourceType === "local" && check(track.source, null)) return true;
    const copy = copies.get(track.id);
    return !!copy && check(copy.path, copy.size);
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
 * The cover of a work without recordings: its placeholder's, preferring one in the user's library;
 * for a work outside the library that has no placeholder, its first audio edition's.
 */
function fallbackCovers(userId: number, workIds: string[], hidden: Set<string>) {
  const rows = sqlite
    .prepare(
      `SELECT e.work_id AS workId,e.id,e.cover FROM audio_editions e
       WHERE e.work_id IN (SELECT value FROM json_each(?))
       ORDER BY EXISTS(SELECT 1 FROM user_library u WHERE u.user_id=? AND u.book_id=e.id) DESC,
         ${placeholderEditionSql("e.id")} DESC,e.rowid`,
    )
    .all(idList(workIds), userId) as { workId: string; id: string; cover: string }[];
  const covers = new Map<string, string>();
  for (const row of rows)
    if (!hidden.has(row.id) && !covers.has(row.workId)) covers.set(row.workId, row.cover);
  return covers;
}

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
  const covers = fallbackCovers(userId, workIds, hidden);
  return workIds.flatMap((workId) => {
    const work = works.get(workId);
    if (!work) return [];
    const listed = recordings.get(workId) ?? [];
    const chosen = chosenRecordingId(listed, { userId, workId });
    return [
      {
        workId,
        title: work.title,
        author: work.author,
        description: work.description,
        genre: work.genre,
        year: work.year,
        cover: listed.find((recording) => recording.recordingId === chosen)?.cover ?? covers.get(workId) ?? "",
        inLibrary: added.has(workId),
        addedAt: added.get(workId) ?? null,
        chosenRecordingId: chosen,
        recordings: listed,
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
  if (last && last.database === database && last.files.every((file) => fileOnServer(file.path, file.size) === file.present))
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
}
