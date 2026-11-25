// After a download (#897): when the files of a series book carry an Audible ASIN of a release in another language than
// the series', the book is marked "Another language" and left for the user to choose, instead of shown as done. The
// ASIN is read as `catalogue-links.ts` reads it to link the release (`workRecordings`), the language is that release's.
import { sqlite } from "./db.ts";
import { workRecordings } from "./catalogue-links.ts";
import { languageCode, languagesNamed } from "./release-language.ts";
import { audiobookDbAsinRelease, seriesAudioLanguage, type AsinRelease } from "./series-audio.ts";
import { setWorkMediaHold } from "./work-media-state.ts";

type Row = { workId: string; editionId: string | null; userId: number };

/** The users the acquisition is for, with the work it gave and the edition it imported. */
function acquisitionWorks(acquisitionId: string): Row[] {
  return sqlite
    .prepare(
      `SELECT COALESCE(a.work_id,e.work_id) AS workId, a.book_id AS editionId, u.user_id AS userId
       FROM acquisitions a JOIN user_acquisitions u ON u.acquisition_id=a.id
       LEFT JOIN audio_editions e ON e.id=a.book_id
       WHERE a.id=? AND COALESCE(a.work_id,e.work_id) IS NOT NULL`,
    )
    .all(acquisitionId) as Row[];
}

/**
 * Marks each series book the finished acquisition gave, whose recording's ASIN names a release in another language
 * than the user's series, as "another_language". A book with no ASIN, an ASIN AudiobookDB does not know or a lookup that
 * fails stays as it is. Returns the works it marked.
 */
export async function checkDownloadedLanguage(
  acquisitionId: string,
  lookup: (asin: string) => Promise<AsinRelease | null> = audiobookDbAsinRelease,
): Promise<string[]> {
  const marked: string[] = [];
  for (const row of acquisitionWorks(acquisitionId)) {
    const series = sqlite
      .prepare(
        `SELECT w.series_id AS seriesId, c.language FROM user_saved_series_works w
         JOIN series_catalogue_works c ON c.series_id=w.series_id AND c.book_id=w.book_id
         WHERE w.user_id=? AND w.work_id=? ORDER BY w.rowid LIMIT 1`,
      )
      .get(row.userId, row.workId) as { seriesId: string; language: string | null } | undefined;
    if (!series) continue;
    const asin = workRecordings(row.workId).find((recording) => recording.asin && (!row.editionId || recording.editionId === row.editionId))?.asin;
    if (!asin) continue;
    const wanted = languageCode(seriesAudioLanguage(row.userId, series.seriesId, series.language))!;
    try {
      const found = await lookup(asin);
      if (!found?.language) continue;
      if (languagesNamed(found.language).includes(wanted)) continue;
      setWorkMediaHold(row.userId, row.workId, "another_language");
      marked.push(row.workId);
    } catch (error) {
      // No key, a limit or a provider down: the book stays as downloaded.
      console.warn(`series language check ${asin}: ${(error as Error).message}`);
    }
  }
  return marked;
}
