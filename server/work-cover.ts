/*
 * The rule for the chosen recording and the cover of a work (GLOSSARY.md, "Chosen recording"; #456, #485): the
 * library by work and the Activity list (#514) both read it from here, so a work has one cover wherever it is
 * shown. This file opens no database; every function takes the handle, so the Activity sources stay free of the
 * database at import (ADR 0010), as `placeholder-edition.ts` does.
 */
import { placeholderEditionSql } from "./placeholder-edition.ts";
import { ownCover } from "../src/types.ts";

type Database = import("better-sqlite3").Database;

export const idList = (ids: Iterable<string>) => JSON.stringify([...new Set(ids)]);

/** What a step of the rule may use besides the recordings: the user's stored choice for the work, if any. */
type ChoiceContext = { stored: string | null };
/** What the rule reads of a recording: its id and the user's place in it. */
export type ChoiceRecording = { recordingId: string; progress: { updatedAt: number } | null };
/** One step of the rule for the chosen recording: a recording id, or null to leave it to the next step. */
type ChoiceStep = (recordings: ChoiceRecording[], context: ChoiceContext) => string | null;

/** The user's stored choice for a work (#488): one key per work in `user_settings`, holding a recording id. */
export const choiceKey = (workId: string) => `chosenRecording:${workId}`;

/** The rule for the chosen recording, step by step. */
const chosenRecordingSteps: ChoiceStep[] = [
  // The user's stored choice, while it is still one of their recordings of the work.
  (recordings, { stored }) => (recordings.some((recording) => recording.recordingId === stored) ? stored : null),
  // Otherwise the recording with the user's newest saved place.
  (recordings) => {
    let newest: ChoiceRecording | null = null;
    for (const recording of recordings)
      if (recording.progress && (!newest?.progress || recording.progress.updatedAt > newest.progress.updatedAt))
        newest = recording;
    return newest?.recordingId ?? null;
  },
  // Otherwise the one added first: recordings are listed in that order.
  (recordings) => recordings[0]?.recordingId ?? null,
];

export function chosenRecordingId(recordings: ChoiceRecording[], context: ChoiceContext) {
  for (const step of chosenRecordingSteps) {
    const id = step(recordings, context);
    if (id) return id;
  }
  return null;
}

/** The user's stored choices for `workIds`, by work. */
export function storedChoices(database: Database, userId: number, workIds: string[]) {
  const rows = database
    .prepare(
      `SELECT key,value FROM user_settings
       WHERE user_id=? AND key IN (SELECT ? || value FROM json_each(?))`,
    )
    .all(userId, choiceKey(""), idList(workIds)) as { key: string; value: string }[];
  return new Map(rows.map((row) => [row.key.slice(choiceKey("").length), row.value]));
}

export type RecordingRow = {
  workId: string;
  editionId: string;
  recordingId: string;
  narrator: string;
  language: string | null;
  releaseTitle: string | null;
  sourceLabel: string;
  cover: string;
};

/** The user's recordings of `workIds`, the one added first first: audio editions in their library that are not placeholders. */
export function listedRecordings(database: Database, userId: number, workIds: string[]) {
  return database
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
}

/** The audio edition that lends a work without recordings its cover, and whether it is a placeholder. */
export type FallbackCover = { editionId: string; cover: string; placeholder: boolean };

/**
 * The cover of a work without recordings: its placeholder's, preferring one in the user's library;
 * for a work outside the library that has no placeholder, its first audio edition's.
 */
export function fallbackCovers(database: Database, userId: number, workIds: string[], hidden: Set<string>) {
  const rows = database
    .prepare(
      `SELECT e.work_id AS workId,e.id,e.cover,${placeholderEditionSql("e.id")} AS placeholder FROM audio_editions e
       WHERE e.work_id IN (SELECT value FROM json_each(?))
       ORDER BY EXISTS(SELECT 1 FROM user_library u WHERE u.user_id=? AND u.book_id=e.id) DESC,
         ${placeholderEditionSql("e.id")} DESC,e.rowid`,
    )
    .all(idList(workIds), userId) as { workId: string; id: string; cover: string; placeholder: number }[];
  const covers = new Map<string, FallbackCover>();
  for (const row of rows)
    if (!hidden.has(row.id) && !covers.has(row.workId))
      covers.set(row.workId, { editionId: row.id, cover: row.cover, placeholder: row.placeholder === 1 });
  return covers;
}

/**
 * The work's cover (#763): the first own cover among its audio editions the user may see (the work's placeholders,
 * which keep the catalogue link's cover, and the user's own editions; never one only another account added), the
 * placeholder's first, then in the order they were added. A sample book's cover stored for another edition is no
 * cover. A work with none has no entry.
 */
export function editionCovers(database: Database, userId: number, workIds: string[], hidden: Set<string>) {
  const rows = database
    .prepare(
      `SELECT e.work_id AS workId,e.id,e.cover FROM audio_editions e
       WHERE e.work_id IN (SELECT value FROM json_each(?)) AND e.cover<>''
         AND (${placeholderEditionSql("e.id")} OR EXISTS(SELECT 1 FROM user_library u WHERE u.user_id=? AND u.book_id=e.id))
       ORDER BY ${placeholderEditionSql("e.id")} DESC,e.rowid`,
    )
    .all(idList(workIds), userId) as { workId: string; id: string; cover: string }[];
  const covers = new Map<string, string>();
  for (const row of rows) {
    const cover = ownCover(row.cover, row.id);
    if (cover && !hidden.has(row.id) && !covers.has(row.workId)) covers.set(row.workId, cover);
  }
  return covers;
}

/**
 * The one cover choice (#763): the edition's own cover; otherwise the work's (`editionCovers`); otherwise "" (the
 * client draws the generated cover). Never another book's art.
 */
export function chosenCover(edition: { editionId: string; cover: string } | undefined, workCover: string | undefined) {
  return (edition ? ownCover(edition.cover, edition.editionId) : "") || workCover || "";
}

/** What an item of the Activity list says of the book it concerns. */
export type WorkCover = {
  /** The audio edition of the chosen recording; null when the work has none, and never a placeholder's. */
  bookId: string | null;
  cover: string;
};

/**
 * The cover and audio edition of each of `workIds` for `userId` by the rule of the library by work: the chosen
 * recording's, otherwise the one of the fallback edition (a placeholder's by preference); an edition without its
 * own cover shows the work's (`chosenCover`, #763), otherwise none (an empty cover). A work that does not exist has no entry. The administrator sees every placeholder, so by default none is hidden: only the administrator
 * reads the Activity list. `GET /api/works` (#573) passes the placeholders hidden from the user (`hiddenHardcoverPlaceholders`).
 */
export function workCovers(database: Database, userId: number, workIds: Iterable<string>, hidden = new Set<string>()) {
  const ids = [...new Set(workIds)];
  const covers = new Map<string, WorkCover>();
  if (!ids.length) return covers;
  const listed = listedRecordings(database, userId, ids);
  const places = new Map(
    (
      database
        .prepare(
          `SELECT recording_id AS recordingId,updated_at AS updatedAt FROM user_progress
           WHERE user_id=? AND recording_id IN (SELECT value FROM json_each(?))`,
        )
        .all(userId, idList(listed.map((row) => row.recordingId))) as { recordingId: string; updatedAt: number }[]
    ).map((place) => [place.recordingId, place]),
  );
  const byWork = new Map<string, Array<RecordingRow & ChoiceRecording>>();
  for (const row of listed)
    byWork.set(row.workId, [...(byWork.get(row.workId) ?? []), { ...row, progress: places.get(row.recordingId) ?? null }]);
  const choices = storedChoices(database, userId, ids);
  const fallbacks = fallbackCovers(database, userId, ids, hidden);
  const own = editionCovers(database, userId, ids, hidden);
  const existing = new Set(
    (database.prepare("SELECT id FROM works WHERE id IN (SELECT value FROM json_each(?))").all(idList(ids)) as { id: string }[]).map((row) => row.id),
  );
  for (const workId of ids) {
    if (!existing.has(workId)) continue;
    const recordings = byWork.get(workId) ?? [];
    const chosen = recordings.find((recording) => recording.recordingId === chosenRecordingId(recordings, { stored: choices.get(workId) ?? null }));
    const fallback = fallbacks.get(workId);
    if (chosen) covers.set(workId, { bookId: chosen.editionId, cover: chosenCover(chosen, own.get(workId)) });
    else if (fallback)
      covers.set(workId, {
        bookId: fallback.placeholder ? null : fallback.editionId,
        cover: chosenCover({ editionId: fallback.editionId, cover: fallback.cover }, own.get(workId)),
      });
    else covers.set(workId, { bookId: null, cover: own.get(workId) ?? "" });
  }
  return covers;
}
