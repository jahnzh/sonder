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
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { currentUserId } from "./users.ts";
import { hiddenHardcoverPlaceholders } from "./hardcover.ts";
import { deliveredTracks, faultsFor } from "./media-library.ts";
import { placeholderEditionSql } from "./placeholder-edition.ts";
import type { LibraryWork, Progress, WorkRecording } from "../src/types.ts";

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

/** The user's recordings of `workIds`: audio editions in their library that are not placeholders. */
function recordingsByWork(userId: number, workIds: string[]) {
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
  const recordingIds = rows.map((row) => row.recordingId);
  const tracks = recordingIds.length
    ? db.select().from(s.tracks).where(inArray(s.tracks.recordingId, recordingIds)).all()
    : [];
  const places = recordingIds.length
    ? db
        .select()
        .from(s.userProgress)
        .where(and(eq(s.userProgress.userId, userId), inArray(s.userProgress.recordingId, recordingIds)))
        .all()
    : [];
  const copies = recordingIds.length
    ? db.select().from(s.serverDownloads).where(inArray(s.serverDownloads.recordingId, recordingIds)).all()
    : [];
  const byWork = new Map<string, WorkRecording[]>();
  for (const row of rows) {
    const faults = faultsFor(row.recordingId);
    const delivered = deliveredTracks(
      tracks.filter((track) => track.recordingId === row.recordingId),
      faults,
    );
    const place = places.find((p) => p.recordingId === row.recordingId);
    const copy = copies.find((c) => c.recordingId === row.recordingId);
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

/** `workIds` in the `LibraryWork` shape for `userId`, in the order given; unknown ids are left out. */
function buildWorks(userId: number, workIds: string[], hidden: Set<string>): LibraryWork[] {
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
  const recordings = recordingsByWork(userId, workIds);
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
export function libraryWorks(userId: number): LibraryWork[] {
  return buildWorks(userId, [...libraryRows(userId).keys()], hiddenHardcoverPlaceholders(userId));
}

/**
 * One work for `userId`, in the library or not; null when it does not exist or when every audio
 * edition it has is a placeholder the user may not see (`hiddenHardcoverPlaceholders`).
 */
export function libraryWork(userId: number, workId: string): LibraryWork | null {
  const hidden = hiddenHardcoverPlaceholders(userId);
  const editions = db
    .select({ id: s.editions.id })
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all();
  if (editions.length && editions.every((edition) => hidden.has(edition.id))) return null;
  return buildWorks(userId, [workId], hidden)[0] ?? null;
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
    const userId = currentUserId(req);
    const body = JSON.stringify(libraryWorks(userId));
    const tag = entityTag(userId, body);
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
