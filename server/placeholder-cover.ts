/*
 * A catalogue cover for the placeholder of a linked work (#900). A placeholder (an audio edition without a track) is
 * made with the catalogue's cover when it is made; one made while the cover was not read (AudiobookDB's `images`
 * array was ignored) has none, or the old generic one. It takes the catalogue's cover when its series or book is read
 * again, and once for the rows that exist (`backfillPlaceholderCovers`). A cover the user or an edition set stays.
 */
import { sqlite } from "./db.ts";
import { ownCover } from "../src/types.ts";
import { placeholderEditionSql } from "./placeholder-edition.ts";
import { audiobookDbBook, audiobookDbSeries } from "./audiobookdb.ts";
import { CatalogueError } from "./catalogue-provider.ts";

/**
 * Gives the work's placeholders that have no cover of their own (none, or a sample book's) `cover`, when it is an https
 * address. Any other cover is left as it is. Returns the editions changed.
 */
export function fillPlaceholderCover(workId: string, cover: string | null | undefined): number {
  if (!cover?.startsWith("https://")) return 0;
  const rows = sqlite
    .prepare(`SELECT e.id,e.cover FROM audio_editions e WHERE e.work_id=? AND ${placeholderEditionSql("e.id")}`)
    .all(workId) as { id: string; cover: string | null }[];
  const update = sqlite.prepare("UPDATE audio_editions SET cover=? WHERE id=? AND cover=?");
  let changed = 0;
  for (const row of rows) if (!ownCover(row.cover, row.id)) changed += update.run(cover, row.id, row.cover ?? "").changes;
  return changed;
}

/** The works linked to the AudiobookDB book `bookId`, or that a series row of it names. */
function worksOfBook(bookId: string): string[] {
  return sqlite
    .prepare(
      `SELECT work_id FROM work_catalogue_links WHERE provider='audiobookdb' AND external_id=?
       UNION SELECT work_id FROM series_catalogue_works WHERE provider='audiobookdb' AND book_id=? AND work_id IS NOT NULL`,
    )
    .pluck()
    .all(bookId, bookId) as string[];
}

/** A series' books read again: each one's cover goes to the placeholders of the works linked to it. */
export function fillSeriesCovers(seriesId: string, members: { id: string; cover: string | null; provider?: string }[]): void {
  const fill = sqlite.transaction(() => {
    for (const member of members) {
      if (!member.cover || (member.provider && member.provider !== "audiobookdb")) continue;
      // The series page's row has the cover too, unless it has one already.
      sqlite.prepare("UPDATE series_catalogue_works SET cover=? WHERE series_id=? AND book_id=? AND COALESCE(cover,'')=''").run(member.cover, seriesId, member.id);
      for (const workId of worksOfBook(member.id)) fillPlaceholderCover(workId, member.cover);
    }
  });
  fill();
}

/** A book read again: its cover goes to the placeholders of the works linked to it. */
export function fillBookCover(bookId: string, cover: string | null): void {
  if (cover) for (const workId of worksOfBook(bookId)) fillPlaceholderCover(workId, cover);
}

/**
 * Once at startup: the placeholders of AudiobookDB-linked works without a cover, and the series rows without one, get
 * the covers of the cached answers (a series answer, else the book's); a cached answer past its week is fetched again.
 * Nothing is left to do once every cover is filled, so a later start reads nothing. A provider out of key or units
 * stops the round (the next start tries again).
 */
/**
 * Covers stored before AudiobookDB's image folders were read as files (an address that answers 404, `audiobookDbImage`):
 * the placeholders' and the series rows' become the folder's `medium.webp`. Returns the rows changed.
 */
export function repairAudiobookDbCoverAddresses(): number {
  const folder = "cover LIKE 'https://cdn.audiobookdb.org/%' AND cover NOT LIKE 'https://cdn.audiobookdb.org/%/%'";
  let changed = 0;
  for (const table of ["audio_editions", "series_catalogue_works"])
    changed += sqlite.prepare(`UPDATE ${table} SET cover=cover||'/medium.webp' WHERE ${folder}`).run().changes;
  return changed;
}

export async function backfillPlaceholderCovers(log: (message: string) => void = () => {}): Promise<number> {
  const repaired = repairAudiobookDbCoverAddresses();
  if (repaired) log(`AudiobookDB covers: ${repaired} stored address(es) now name the medium image`);
  const bare = (sql: string) =>
    (sqlite.prepare(sql).all() as { workId: string; cover: string | null; id: string; bookId: string; seriesId: string | null }[]).filter((row) => !ownCover(row.cover, row.id));
  const placeholders = bare(
    `SELECT l.work_id AS workId,e.id,e.cover,l.external_id AS bookId,l.series_id AS seriesId
     FROM work_catalogue_links l JOIN audio_editions e ON e.work_id=l.work_id
     WHERE l.provider='audiobookdb' AND ${placeholderEditionSql("e.id")}`,
  );
  const seriesIds = new Set(placeholders.map((row) => row.seriesId).filter((id): id is string => !!id));
  for (const id of sqlite.prepare("SELECT DISTINCT series_id FROM series_catalogue_works WHERE provider='audiobookdb' AND COALESCE(cover,'')=''").pluck().all() as string[]) seriesIds.add(id);
  let filled = 0;
  const count = () => (sqlite.prepare("SELECT COUNT(*) FROM audio_editions WHERE cover<>''").pluck().get() as number) + (sqlite.prepare("SELECT COUNT(*) FROM series_catalogue_works WHERE COALESCE(cover,'')<>''").pluck().get() as number);
  const before = count();
  const stop = (error: unknown) => {
    if (!(error instanceof CatalogueError)) throw error;
    return ["missing_key", "rejected", "daily_limit", "rate_limited", "unreachable"].includes(error.kind);
  };
  try {
    for (const id of seriesIds) {
      try {
        const series = await audiobookDbSeries(id, { priority: "background" });
        fillSeriesCovers(id, series.members.map((member) => ({ id: member.book.id, cover: member.book.cover })));
      } catch (error) {
        if (stop(error)) break;
      }
    }
    const done = new Set<string>();
    for (const row of placeholders) {
      if (row.seriesId && seriesIds.has(row.seriesId)) continue;
      if (done.has(row.bookId)) continue;
      done.add(row.bookId);
      try {
        fillBookCover(row.bookId, (await audiobookDbBook(row.bookId, { priority: "background" })).cover);
      } catch (error) {
        if (stop(error)) break;
      }
    }
  } finally {
    filled = count() - before;
    if (filled > 0) log(`Catalogue covers: ${filled} covers filled from AudiobookDB.`);
  }
  return filled;
}
