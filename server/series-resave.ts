// The series reset (#721 part b; the coordinator's decision of 19 Nov): each series a user had saved on Hardcover is
// saved again on AudiobookDB by its name, once, after the startup reset in `db.ts` renamed the Hardcover tables.
//
// - The name must be AudiobookDB's series name (normalised); several of that name are told apart by the author.
// - The books the user had added come back added, each with the work it had (by its catalogue link, else its title),
//   with its "introduced through this series" mark and its library origin; nothing new joins the library and no
//   search starts. Every book of the series counts as seen, so the page shows no "New" for the reset.
// - A series AudiobookDB does not have is listed in Activity (the series search's process) with Discard; a failure
//   such as a missing key is tried again by the loop, and Retry asks at once.
import { sqlite } from "./db.ts";
import { searchAudiobookDbSeries } from "./audiobookdb.ts";
import { CatalogueError } from "./catalogue-provider.ts";
import { authorMatches, normaliseTitle, titleMatches } from "./catalogue-links.ts";
import { readCatalogueSeries, saveCatalogueSeries } from "./series-catalogue.ts";
import type { BackgroundProcess } from "./background-runner.ts";

export const RESAVE_NOT_FOUND = "Not found on AudiobookDB. Save it again from Discover.";
export const RESAVE_SEVERAL = "Several series on AudiobookDB have this name. Save the right one from Discover.";
export type ResaveRow = {
  userId: number;
  hardcoverSeriesId: number;
  name: string;
  author: string | null;
  workIds: string;
  status: "pending" | "saved" | "missing" | "failed";
  seriesId: string | null;
  reason: string | null;
  attempts: number;
  updatedAt: number;
};
const rows = (where: string, ...args: unknown[]) =>
  sqlite
    .prepare(
      `SELECT user_id AS userId,hardcover_series_id AS hardcoverSeriesId,name,author,work_ids AS workIds,status,series_id AS seriesId,reason,attempts,updated_at AS updatedAt
       FROM series_resave ${where}`,
    )
    .all(...args) as ResaveRow[];
export const resaveRows = () => rows("ORDER BY rowid");

function setOutcome(row: ResaveRow, status: ResaveRow["status"], reason: string | null, seriesId: string | null = null) {
  sqlite
    .prepare("UPDATE series_resave SET status=?,reason=?,series_id=?,attempts=attempts+1,updated_at=? WHERE user_id=? AND hardcover_series_id=?")
    .run(status, reason, seriesId, Date.now(), row.userId, row.hardcoverSeriesId);
}

/** What the old tables said of each work the user had added with the series: whether the series brought it in. */
function introducedOf(row: ResaveRow): Map<string, boolean> {
  const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hardcover_user_saved_series_works'").get();
  if (!exists) return new Map();
  const found = sqlite
    .prepare("SELECT work_id AS workId,introduced FROM hardcover_user_saved_series_works WHERE user_id=? AND series_id=?")
    .all(row.userId, row.hardcoverSeriesId) as { workId: string; introduced: number }[];
  return new Map(found.map((entry) => [entry.workId, !!entry.introduced]));
}

/** One saved series saved again; the outcome is stored on its row. */
export async function resaveSeries(row: ResaveRow): Promise<Exclude<ResaveRow["status"], "pending">> {
  return (await resave(row)).status;
}
async function resave(row: ResaveRow): Promise<{ status: Exclude<ResaveRow["status"], "pending">; stop?: true }> {
  try {
    const wanted = normaliseTitle(row.name);
    const named = (await searchAudiobookDbSeries(row.name, { priority: "background" })).filter((series) => normaliseTitle(series.name) === wanted);
    const byAuthor = row.author && named.length > 1 ? named.filter((series) => series.author && authorMatches(row.author!, [series.author])) : named;
    const ids = [...new Set(byAuthor.map((series) => series.id))];
    if (!ids.length) {
      setOutcome(row, "missing", RESAVE_NOT_FOUND);
      return { status: "missing" };
    }
    if (ids.length > 1) {
      setOutcome(row, "missing", RESAVE_SEVERAL);
      return { status: "missing" };
    }
    const id = ids[0];
    const entry = await readCatalogueSeries(id, { priority: "background" });
    const introduced = introducedOf(row);
    const restore = new Map<string, { workId: string; introduced: boolean }>();
    const unmatched: string[] = [];
    for (const workId of JSON.parse(row.workIds) as string[]) {
      const work = sqlite.prepare("SELECT id,title FROM works WHERE id=?").get(workId) as { id: string; title: string } | undefined;
      if (!work) continue;
      const link = sqlite.prepare("SELECT provider,external_id AS externalId FROM work_catalogue_links WHERE work_id=?").get(workId) as { provider: string; externalId: string } | undefined;
      const member =
        entry.members.find((candidate) => link && (link.provider === "audiobookdb" ? candidate.id === link.externalId : candidate.id === `openlibrary:${link.externalId}`)) ??
        entry.members.find((candidate) => !restore.has(candidate.id) && titleMatches(work.title, candidate.title));
      if (!member) {
        unmatched.push(work.title);
        continue;
      }
      restore.set(member.id, { workId, introduced: introduced.get(workId) ?? false });
    }
    await saveCatalogueSeries(row.userId, id, [...restore.keys()], { restore, priority: "background" });
    // The works the Hardcover series brought into the library name the AudiobookDB series now.
    sqlite
      .prepare("UPDATE user_work_library_origin SET catalogue_series_id=? WHERE user_id=? AND source='series' AND series_id=? AND catalogue_series_id IS NULL")
      .run(id, row.userId, row.hardcoverSeriesId);
    setOutcome(row, "saved", unmatched.length ? `Not in the AudiobookDB series: ${unmatched.join(", ")}.` : null, id);
    return { status: "saved" };
  } catch (error) {
    if (!(error instanceof CatalogueError)) throw error;
    setOutcome(row, "failed", error.message);
    // Without a key, a rejected key or the day's units spent, the others fail the same way: next round.
    return ["missing_key", "rejected", "daily_limit"].includes(error.kind) ? { status: "failed", stop: true } : { status: "failed" };
  }
}

/** Every series still to save again (and those whose last try failed), oldest first. */
export async function resavePending(): Promise<{ saved: number; missing: number; failed: number }> {
  const result = { saved: 0, missing: 0, failed: 0 };
  for (const row of rows("WHERE status IN ('pending','failed') ORDER BY rowid")) {
    const outcome = await resave(row);
    result[outcome.status]++;
    if (outcome.stop) break;
  }
  return result;
}

/** Activity's Retry: that series is tried again now. */
export function retryResave(userId: number, hardcoverSeriesId: number, onError: (error: unknown) => void) {
  const row = rows("WHERE user_id=? AND hardcover_series_id=?", userId, hardcoverSeriesId)[0];
  if (!row) throw Object.assign(new Error("This series is not waiting to be saved again."), { statusCode: 404 });
  void resaveSeries(row).catch(onError);
  return { ok: true };
}
/** Activity's Discard of a series AudiobookDB does not have: the row goes. */
export function discardResave(userId: number, hardcoverSeriesId: number) {
  return sqlite.prepare("DELETE FROM series_resave WHERE user_id=? AND hardcover_series_id=? AND status IN ('missing','saved')").run(userId, hardcoverSeriesId).changes > 0;
}

export function seriesResaveLoop(log: (message: string) => void): BackgroundProcess {
  return {
    id: "series-resave",
    intervalMs: 15 * 60 * 1000,
    runAtStart: true,
    tick: () => {
      if (!sqlite.prepare("SELECT 1 FROM series_resave WHERE status IN ('pending','failed') LIMIT 1").get()) return;
      return resavePending().then(
        (result) => {
          if (result.failed) log(`Series reset: ${result.failed} saved series could not be saved again yet; tried again in 15 min.`);
        },
        (error: Error) => log(`Series reset failed: ${error.message}`),
      );
    },
  };
}
