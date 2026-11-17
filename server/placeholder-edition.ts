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

/** The cover of a placeholder when no Hardcover cover is given (or the one given is not an https address). */
export const PLACEHOLDER_COVER = "/covers/meditations.svg";

/**
 * The id a new placeholder of a work gets (#467, decision 1): `hc-<book id>` for a work matched on
 * Hardcover, as the Hardcover import has always written it, else `placeholder-<workId>`.
 */
export function placeholderIdFor(workId: string, hardcoverBookId: number | null) {
  return hardcoverBookId == null ? `placeholder-${workId}` : `hc-${hardcoverBookId}`;
}

/**
 * The work's placeholder, made when it has none (#467, decision 1), as the id of its audio edition:
 * - the work's placeholder when it has one (the first, by row order);
 * - else `hc-<book id>` for a work matched on Hardcover, else `placeholder-<workId>`, written as an
 *   audio edition "Audio not added" with the recording `recording-<edition id>` and no track, and
 *   `cover` when it is an https address (the Hardcover cover), else `/covers/meditations.svg`.
 *
 * The rows are written with "do nothing on conflict" inside one transaction, so two requests for
 * the same work cannot make two placeholders. When the `hc-<book id>` id is taken by an edition that
 * is not this work's placeholder (another work linked to the same Hardcover book, or real audio),
 * the work gets `placeholder-<workId>` instead, so no other edition is ever answered as its
 * placeholder. Opens no database itself: the handle is the caller's, as for `isPlaceholderEdition`.
 */
export function ensurePlaceholder(database: Database, workId: string, options: { cover?: string | null } = {}): string {
  return database.transaction((): string => {
    const existing = database
      .prepare(`SELECT e.id FROM audio_editions e WHERE e.work_id=? AND ${placeholderEditionSql("e.id")} ORDER BY e.rowid LIMIT 1`)
      .pluck()
      .get(workId) as string | undefined;
    if (existing) return existing;
    const bookId = database.prepare("SELECT book_id FROM hardcover_links WHERE work_id=?").pluck().get(workId) as
      | number
      | undefined;
    let id = placeholderIdFor(workId, bookId ?? null);
    if (database.prepare("SELECT 1 FROM audio_editions WHERE id=?").get(id)) id = placeholderIdFor(workId, null);
    const cover = options.cover?.startsWith("https://") ? options.cover : PLACEHOLDER_COVER;
    database
      .prepare(
        `INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label)
         VALUES(?,?,?,'Audio not added',NULL,NULL,0,?) ON CONFLICT DO NOTHING`,
      )
      .run(id, workId, cover, bookId == null ? "Ebook" : "Hardcover library");
    database.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(`recording-${id}`, id);
    return id;
  })();
}
