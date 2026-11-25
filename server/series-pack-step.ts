// Choosing a series pack (ADR 0027, #899): the series queue's pack step before a book's own search, and the Get
// audiobook sheet's pack rows (which rows are packs, which books they hold, and the owner's choice of a pack's files
// for a book the split was not certain of). The records and the import are `acquisition-packs.ts`.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlite } from "./db.ts";
import type { acquire as acquireFn } from "./acquisitions.ts";
import { choosePackFiles, joinPack, packChoicesForWork, packCovering, type PackBook, type PackRequest } from "./acquisition-packs.ts";
import {
  packCandidateMagnet,
  packCoverage,
  pickSeriesPack,
  searchSeriesPackCandidates,
  seriesAudioLanguage,
  type SeriesAudioSearchDeps,
} from "./series-audio.ts";
import { currentUserId, requireAdmin } from "./users.ts";
import { getWorkMediaState, workHasPlayableAudio } from "./work-media-state.ts";

/** A series' pack search runs once per user in this time, whatever the number of its books in the queue. */
export const PACK_SEARCH_EVERY_MS = 6 * 3600_000;
const packSearchedAt = new Map<string, number>();

/** Forget when each series' packs were last searched (tests). */
export function resetPackSearches() {
  packSearchedAt.clear();
}

type CatalogueVolume = { bookId: string; title: string; position: number; unreleased: number; cover: string | null; language: string | null };

function seriesVolumes(seriesId: string) {
  return sqlite
    .prepare(
      `SELECT book_id AS bookId, title, position, unreleased, cover, language FROM series_catalogue_works
        WHERE series_id = ? AND position IS NOT NULL ORDER BY position`,
    )
    .all(seriesId) as CatalogueVolume[];
}

/**
 * The user's books of the series that wait for audio: their audio search is pending or running, they are out and
 * have no playable audio.
 */
function waitingBooks(userId: number, seriesId: string) {
  const rows = sqlite
    .prepare(
      `SELECT j.id AS jobId, j.work_id AS workId, c.position, c.title, c.cover FROM series_acquisition_jobs j
         JOIN series_catalogue_works c ON c.series_id = j.series_id AND c.book_id = j.book_id
        WHERE j.user_id = ? AND j.series_id = ? AND j.kind = 'audio' AND j.status IN ('pending','searching')
          AND c.position IS NOT NULL AND c.unreleased = 0`,
    )
    .all(userId, seriesId) as { jobId: string; workId: string; position: number; title: string; cover: string | null }[];
  return rows.filter((row) => !workHasPlayableAudio(row.workId));
}

export type SeriesPackStepInput = {
  userId: number;
  seriesId: string;
  seriesName: string;
  author: string;
  /** The queue's job for this book, and the book. */
  jobId: string;
  workId: string;
  position: number;
  title: string;
  cover?: string | null;
};

/**
 * The series queue's pack step (ADR 0027), before a book's own search. A pack of the series that holds the book,
 * on its way or done, takes it: no second download. Otherwise, at most once per series in `PACK_SEARCH_EVERY_MS`
 * and only while two or more books of the series wait for audio, the packs are searched; the one `pickSeriesPack`
 * takes is acquired for every waiting book it covers, and their own searches are marked done. Returns whether this
 * book is now served by a pack (its own search is then not run).
 */
export async function seriesPackStep(
  input: SeriesPackStepInput,
  acquire: typeof acquireFn,
  deps?: SeriesAudioSearchDeps,
  now: () => number = Date.now,
) {
  const book: PackBook = { workId: input.workId, position: input.position, title: input.title, cover: input.cover };
  const shared = packCovering(input.seriesId, input.position);
  if (shared) {
    await joinPack(shared.id, input.userId, book);
    return true;
  }
  const waiting = waitingBooks(input.userId, input.seriesId);
  if (waiting.length < 2) return false;
  const key = `${input.userId}:${input.seriesId}`;
  const last = packSearchedAt.get(key);
  if (last !== undefined && now() - last < PACK_SEARCH_EVERY_MS) return false;
  packSearchedAt.set(key, now());
  const volumes = seriesVolumes(input.seriesId);
  const language = seriesAudioLanguage(input.userId, input.seriesId, volumes.find((volume) => volume.position === input.position)?.language);
  const candidates = await searchSeriesPackCandidates(input.seriesName, input.author, volumes, deps);
  const choice = pickSeriesPack(candidates, volumes, input.seriesName, new Set(waiting.map((row) => row.position)), language);
  if (!choice) return false;
  const magnet = await packCandidateMagnet(choice.candidate, deps);
  if (!magnet) return false;
  const books = waiting.filter((row) => choice.wanted.includes(row.position));
  const primary = books.find((row) => row.workId === input.workId) ?? books[0];
  const pack: PackRequest = {
    seriesId: input.seriesId,
    seriesName: input.seriesName,
    volumes: volumes.filter((volume) => choice.covered.includes(volume.position)).map(({ position, title }) => ({ position, title })),
    works: books.map((row) => ({ workId: row.workId, position: row.position, title: row.title, cover: row.cover })),
  };
  await acquire(magnet, {
    title: choice.candidate.title,
    author: input.author,
    cover: primary.cover ?? undefined,
    workId: primary.workId,
    narrator: choice.candidate.narrator,
    userId: input.userId,
    pack,
  });
  // The other books the pack holds need no search of their own.
  const others = books.filter((row) => row.workId !== input.workId).map((row) => row.jobId);
  if (others.length)
    sqlite
      .prepare(
        `UPDATE series_acquisition_jobs SET status = 'done', error = NULL, updated_at = ?
          WHERE id IN (SELECT value FROM json_each(?)) AND status = 'pending'`,
      )
      .run(Date.now(), JSON.stringify(others));
  return books.some((row) => row.workId === input.workId);
}

/** A book of a pack as the Get sheet names it. */
export type PackBookView = { position: number; title: string; workId: string | null; hasAudio: boolean; gets: boolean };
export type PackView = { seriesId: string; seriesName: string; from: number; to: number; books: PackBookView[] };

/** The user's saved series the work is in, with their volumes and the user's works of them. */
function workSeries(userId: number, workId: string) {
  const series = sqlite
    .prepare(
      `SELECT DISTINCT u.series_id AS id, c.name FROM user_saved_series_works u JOIN series_catalogue c ON c.id = u.series_id
        WHERE u.user_id = ? AND u.work_id = ?`,
    )
    .all(userId, workId) as { id: string; name: string }[];
  return series.map((entry) => ({
    ...entry,
    volumes: sqlite
      .prepare(
        `SELECT c.title, c.position, c.unreleased, c.cover, u.work_id AS workId FROM series_catalogue_works c
           LEFT JOIN user_saved_series_works u ON u.user_id = ? AND u.series_id = c.series_id AND u.book_id = c.book_id
          WHERE c.series_id = ? AND c.position IS NOT NULL ORDER BY c.position`,
      )
      .all(userId, entry.id) as { title: string; position: number; unreleased: number; cover: string | null; workId: string | null }[],
  }));
}

/**
 * Whether a release is a pack of a series the work is in that holds the work (ADR 0027): the books it holds, and
 * which of them it gets (the work itself, and the user's other books of the series in it without audio that are
 * out). Null for any other release.
 */
export function describePack(userId: number, workId: string, title: string) {
  for (const series of workSeries(userId, workId)) {
    const covered = packCoverage(title, series.volumes, series.name);
    const own = series.volumes.find((volume) => volume.workId === workId);
    if (!covered || !own || !covered.includes(own.position)) continue;
    const books = series.volumes
      .filter((volume) => covered.includes(volume.position))
      .map((volume) => {
        const hasAudio = !!volume.workId && workHasPlayableAudio(volume.workId);
        return {
          view: {
            position: volume.position,
            title: volume.title,
            workId: volume.workId,
            hasAudio,
            gets: volume.workId === workId || (!!volume.workId && !hasAudio && !volume.unreleased),
          } satisfies PackBookView,
          cover: volume.cover,
        };
      });
    const view: PackView = { seriesId: series.id, seriesName: series.name, from: covered[0], to: covered[covered.length - 1], books: books.map((entry) => entry.view) };
    const request: PackRequest = {
      seriesId: series.id,
      seriesName: series.name,
      volumes: books.map(({ view }) => ({ position: view.position, title: view.title })),
      works: books
        .filter(({ view }) => view.gets && view.workId)
        .map(({ view, cover }) => ({ workId: view.workId!, position: view.position, title: view.title, cover })),
    };
    return { view, request };
  }
  return null;
}

/** The pack request for the add routes' `pack: true`, or undefined when the release is not a pack of the work's series. */
export function packRequestFor(userId: number, workId: string | undefined, title: string) {
  return workId ? describePack(userId, workId, title)?.request : undefined;
}

const workParams = z.object({ id: z.string().min(1).max(100) });

export function registerPackRoutes(app: FastifyInstance) {
  // Which of the Get sheet's rows are packs of the book's series (ADR 0027), keyed by the release's title.
  app.post("/api/works/:id/packs/describe", async (req) => {
    requireAdmin(req);
    const { id } = workParams.parse(req.params);
    const { titles } = z.object({ titles: z.array(z.string().max(500)).max(200).default([]) }).parse(req.body ?? {});
    const userId = currentUserId(req);
    const packs: Record<string, PackView> = {};
    for (const title of new Set(titles)) {
      const described = describePack(userId, id, title);
      if (described) packs[title] = described.view;
    }
    return { packs };
  });
  // The packs that hold the book but could not tell which of their files it is.
  app.get("/api/works/:id/pack", async (req) => {
    const { id } = workParams.parse(req.params);
    return { choices: packChoicesForWork(currentUserId(req), id) };
  });
  // The owner's choice of a pack's files for the book.
  app.post("/api/works/:id/pack", async (req) => {
    requireAdmin(req);
    const { id } = workParams.parse(req.params);
    const body = z.object({ acquisitionId: z.string().min(1).max(100), units: z.array(z.string().min(1).max(2000)).min(1).max(500) }).parse(req.body ?? {});
    const userId = currentUserId(req);
    const bookId = await choosePackFiles(userId, id, body.acquisitionId, body.units);
    return { bookId, mediaState: getWorkMediaState(userId, id) };
  });
}
