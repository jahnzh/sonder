/*
 * Whether a user finished a work (ADR 0002), for many works at once: the series read (`hardcover.ts`,
 * `seriesWorkState`) and the read by work (`library-works.ts`) both take it from here.
 *
 * A work is finished for a user when their override says so; without an override, when one of its
 * audio editions in their library is marked finished, when their place in one of its recordings is
 * at the end (99.9% of a recording whose tracks all have a duration), or when their reading place
 * in one of its ebook editions is at the end (99.9%, saved while reading, not while listening).
 */
import { sqlite } from "./db.ts";
import { consensusEbookId } from "./ebook-set-consensus.ts";

export type CompletionOverride = "finished" | "unread";
export type WorkCompletion = { finished: boolean; completionOverride: CompletionOverride | null };
/** The user's place in an ebook edition, from their reader checkpoint. */
export type ReaderPlace = {
  workId: string;
  progression: number | null;
  /** Saved while reading or while listening; null for a checkpoint from before origins were stored. */
  origin: "reading" | "listening" | null;
  updatedAt: number;
};

const idList = (ids: Iterable<string>) => JSON.stringify([...new Set(ids)]);

/**
 * The user's places in the ebook editions of `workIds`, by edition id. The consensus text of an
 * ebook set is not an edition and has none. A checkpoint that is not JSON counts as no place.
 */
export function readerPlaces(userId: number, workIds: string[]) {
  const rows = sqlite
    .prepare(
      `SELECT b.work_id AS workId,b.id,c.data FROM user_reader_checkpoints c
       JOIN ebook_editions b ON b.id=c.edition_id
       WHERE c.user_id=? AND b.work_id IN (SELECT value FROM json_each(?))`,
    )
    .all(userId, idList(workIds)) as { workId: string; id: string; data: string }[];
  const places = new Map<string, ReaderPlace>();
  for (const row of rows) {
    if (row.id === consensusEbookId(row.workId)) continue;
    const checkpoint = parseCheckpoint(row.data);
    if (!checkpoint) continue;
    const progression = checkpoint.locator?.progression;
    places.set(row.id, {
      workId: row.workId,
      progression: typeof progression === "number" ? progression : null,
      origin: checkpoint.origin === "reading" || checkpoint.origin === "listening" ? checkpoint.origin : null,
      updatedAt: typeof checkpoint.updatedAt === "number" ? checkpoint.updatedAt : 0,
    });
  }
  return places;
}

type StoredCheckpoint = { locator?: { progression?: unknown }; origin?: unknown; updatedAt?: unknown };
function parseCheckpoint(data: string): StoredCheckpoint | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredCheckpoint) : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Works of `workIds` whose recordings hold the user's place at the end. */
function audioFinishedWorks(userId: number, workIds: string[]) {
  const places = sqlite
    .prepare(
      `SELECT e.work_id AS workId,p.recording_id AS recordingId,p.track_id AS trackId,p.position
       FROM user_progress p
       JOIN recordings r ON r.id=p.recording_id
       JOIN audio_editions e ON e.id=r.edition_id
       WHERE p.user_id=? AND e.work_id IN (SELECT value FROM json_each(?))`,
    )
    .all(userId, idList(workIds)) as { workId: string; recordingId: string; trackId: string; position: number }[];
  const finished = new Set<string>();
  if (!places.length) return finished;
  const tracks = new Map<string, { id: string; duration: number }[]>();
  for (const track of sqlite
    .prepare(
      `SELECT recording_id AS recordingId,id,duration FROM tracks
       WHERE recording_id IN (SELECT value FROM json_each(?)) ORDER BY track_index,rowid`,
    )
    .all(idList(places.map((place) => place.recordingId))) as { recordingId: string; id: string; duration: number }[])
    tracks.set(track.recordingId, [...(tracks.get(track.recordingId) ?? []), track]);
  for (const place of places) {
    const list = tracks.get(place.recordingId) ?? [];
    const total = list.reduce((sum, track) => sum + track.duration, 0);
    const index = list.findIndex((track) => track.id === place.trackId);
    if (
      index >= 0 &&
      list.every((track) => track.duration > 0) &&
      total > 0 &&
      (list.slice(0, index).reduce((sum, track) => sum + track.duration, 0) + place.position) / total >= 0.999
    )
      finished.add(place.workId);
  }
  return finished;
}

/** Whether the user finished each of `workIds`, and their override, by work. */
export function workCompletions(userId: number, workIds: string[]) {
  const list = [...new Set(workIds)];
  const overrides = new Map(
    (
      sqlite
        .prepare(
          `SELECT work_id AS workId,status FROM user_work_completion
           WHERE user_id=? AND work_id IN (SELECT value FROM json_each(?))`,
        )
        .all(userId, idList(list)) as { workId: string; status: CompletionOverride }[]
    ).map((row) => [row.workId, row.status]),
  );
  const markedFinished = new Set(
    (
      sqlite
        .prepare(
          `SELECT DISTINCT e.work_id AS workId FROM user_library u JOIN audio_editions e ON e.id=u.book_id
           WHERE u.user_id=? AND u.status='finished' AND e.work_id IN (SELECT value FROM json_each(?))`,
        )
        .all(userId, idList(list)) as { workId: string }[]
    ).map((row) => row.workId),
  );
  const audioFinished = audioFinishedWorks(userId, list);
  const ebookFinished = new Set(
    [...readerPlaces(userId, list).values()]
      .filter((place) => place.origin === "reading" && place.progression !== null && place.progression >= 0.999)
      .map((place) => place.workId),
  );
  const completions = new Map<string, WorkCompletion>();
  for (const workId of list) {
    const override = overrides.get(workId) ?? null;
    const finished =
      override === "finished"
        ? true
        : override === "unread"
          ? false
          : markedFinished.has(workId) || audioFinished.has(workId) || ebookFinished.has(workId);
    completions.set(workId, { finished, completionOverride: override });
  }
  return completions;
}
