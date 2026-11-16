/*
 * What a placeholder audio edition is (#483): an audio edition is a placeholder when none of
 * its recordings has a track. A work without audio is in a library through one, such as the
 * `hc-*` edition the Hardcover import makes; the rule never reads the id, so it holds for
 * whatever id a later placeholder gets.
 *
 * This file opens no database, so the media state derivation (`work-media-derivation.ts`)
 * can use it on any database handle, also when the server cannot start.
 *
 * A writer of a real audio edition must write its tracks in the same synchronous step as the
 * edition row (one transaction, no `await` in between), or a read in between would take the
 * real edition for a placeholder.
 */

type Database = import("better-sqlite3").Database;
type Statement = import("better-sqlite3").Statement<[string], 0 | 1>;

/**
 * The SQL condition that holds when the audio edition whose id is `editionId` (a column
 * such as `e.id`, or `?`) is a placeholder.
 */
export function placeholderEditionSql(editionId: string) {
  return `NOT EXISTS(SELECT 1 FROM recordings placeholder_r JOIN tracks placeholder_t ON placeholder_t.recording_id=placeholder_r.id WHERE placeholder_r.edition_id=${editionId})`;
}

const statements = new WeakMap<Database, Statement>();

/** Whether the audio edition `editionId` is a placeholder (also true for an unknown id). */
export function isPlaceholderEdition(database: Database, editionId: string) {
  let statement = statements.get(database);
  if (!statement) {
    statement = database
      .prepare(`SELECT ${placeholderEditionSql("?")} AS placeholder`)
      .pluck() as Statement;
    statements.set(database, statement);
  }
  return statement.get(editionId) === 1;
}
