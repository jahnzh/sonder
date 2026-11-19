/*
 * Whether a work has the file a series search looks for, by any route (#717), read from a database handle. This file
 * opens no database itself, so Activity's series source can use it on the handle it is given. The series feature
 * uses the same rule (`workHasAppropriateEbook`, `workHasPlayableAudio` in `server/series-acquisition.ts`).
 */
import { existsSync } from "node:fs";
import { playableWorks } from "./work-media-derivation.ts";

type Database = import("better-sqlite3").Database;

const ids = (workIds: Iterable<string>) => JSON.stringify([...new Set(workIds)]);

/**
 * Works with an ebook on the server: an accepted member of the work's ebook set, or an ebook edition whose file is
 * there (a set's consensus text is no file of its own).
 */
export function worksWithEbook(database: Database, workIds: Iterable<string>) {
  const list = ids(workIds);
  const accepted = database
    .prepare(
      `SELECT DISTINCT work_id AS workId FROM work_ebook_set_members
       WHERE status='accepted' AND work_id IN (SELECT value FROM json_each(?))`,
    )
    .all(list) as { workId: string }[];
  const found = new Set(accepted.map((row) => row.workId));
  const editions = database
    .prepare(
      `SELECT id, work_id AS workId, source FROM ebook_editions
       WHERE work_id IN (SELECT value FROM json_each(?)) AND id NOT LIKE 'set-consensus:%'`,
    )
    .all(list) as { id: string; workId: string; source: string }[];
  for (const edition of editions) if (!found.has(edition.workId) && existsSync(edition.source)) found.add(edition.workId);
  return found;
}

/** Works that have the file a search of `kind` looks for: playable audio for `audio`, an ebook for `ebook`. */
export function worksWithFile(database: Database, kind: "audio" | "ebook", workIds: Iterable<string>) {
  return kind === "audio" ? playableWorks(database, workIds) : worksWithEbook(database, workIds);
}
