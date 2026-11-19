/**
 * The editions of a work that are read (#718, ADR 0024): the only ones a whole-book reading sync is queued for by
 * itself, and the ones Activity's reading sync rows do not call "another edition".
 *
 * An edition is read when it is the work's shared default (ADR 0004, `work_ebook_set.default_ebook_id`), when any
 * account has a place in it (a reader checkpoint or a saved position), or, without a shared default, when it is the
 * work's first EPUB: the edition the client's `chosenEbook` (`src/ebook-choice.ts`) falls back to. Every other EPUB
 * of the work is a spare edition: it was fetched to find the one that matches the narration, and its check against
 * the narration needs only the probe (`evaluateEbookSetMember`), never a whole-book alignment.
 *
 * Takes the database handle, so the Activity source reads it from the handle it was given. Raw SQL only: the module
 * is shared by the alignment queue and Activity, and reads no file.
 */
import type { Database } from "better-sqlite3";

const CONSENSUS_PREFIX = "set-consensus:";

/** The read editions of each of `workIds` (a work without an EPUB is absent). */
export function readEbookIdsByWork(sqlite: Database, workIds: readonly string[]): Map<string, Set<string>> {
  const ids = JSON.stringify([...new Set(workIds)]);
  const read = new Map<string, Set<string>>();
  const add = (workId: string, ebookId: string) => {
    if (ebookId.startsWith(CONSENSUS_PREFIX)) return;
    const set = read.get(workId) ?? new Set<string>();
    set.add(ebookId);
    read.set(workId, set);
  };
  const defaults = sqlite
    .prepare(
      `SELECT s.work_id AS workId, s.default_ebook_id AS ebookId FROM work_ebook_set s
         JOIN ebook_editions b ON b.id = s.default_ebook_id AND b.work_id = s.work_id
        WHERE s.work_id IN (SELECT value FROM json_each(?))`,
    )
    .all(ids) as { workId: string; ebookId: string }[];
  for (const row of defaults) add(row.workId, row.ebookId);
  const withDefault = new Set(defaults.map((row) => row.workId));
  // Without a shared default, the first EPUB added is the one Read opens.
  const firsts = sqlite
    .prepare(
      `SELECT work_id AS workId, id AS ebookId, MIN(rowid) FROM ebook_editions
        WHERE format = 'epub' AND id NOT LIKE '${CONSENSUS_PREFIX}%' AND work_id IN (SELECT value FROM json_each(?))
        GROUP BY work_id`,
    )
    .all(ids) as { workId: string; ebookId: string }[];
  for (const row of firsts) if (!withDefault.has(row.workId)) add(row.workId, row.ebookId);
  // A place in an edition, of any account: someone reads it, whatever the shared default says.
  const placed = sqlite
    .prepare(
      `SELECT b.work_id AS workId, b.id AS ebookId FROM ebook_editions b
        WHERE b.work_id IN (SELECT value FROM json_each(?))
          AND (EXISTS (SELECT 1 FROM user_reader_checkpoints c WHERE c.edition_id = b.id)
            OR EXISTS (SELECT 1 FROM user_ebook_progress p WHERE p.edition_id = b.id)
            OR EXISTS (SELECT 1 FROM ebook_progress p WHERE p.edition_id = b.id))`,
    )
    .all(ids) as { workId: string; ebookId: string }[];
  for (const row of placed) add(row.workId, row.ebookId);
  return read;
}

/** Whether `ebookId` is a spare edition: an EPUB of its work that nobody reads. */
export function isSpareEdition(sqlite: Database, ebookId: string): boolean {
  if (ebookId.startsWith(CONSENSUS_PREFIX)) return false;
  const row = sqlite.prepare("SELECT work_id AS workId, format FROM ebook_editions WHERE id = ?").get(ebookId) as
    | { workId: string; format: string }
    | undefined;
  if (!row || row.format !== "epub") return false;
  return !(readEbookIdsByWork(sqlite, [row.workId]).get(row.workId)?.has(ebookId) ?? false);
}
