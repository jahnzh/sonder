import { and, eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { acquire as defaultAcquire, magnetHash } from "./acquisitions.ts";
import {
  abbMagnet,
  abbRelease,
  abbReleaseSearch,
  getSecret,
  prowlarrMagnet,
  prowlarrRelease,
  prowlarrReleaseSearch,
} from "./services.ts";
import {
  getWorkMediaState,
  syncWorkMediaState,
  workHasPlayableAudio,
  type WorkMediaState,
} from "./work-media-state.ts";
import {
  assertCanAcquireMedia,
  beginManualSeriesReleaseClaim,
  finalizeManualSeriesReleaseClaim,
  restoreManualSeriesReleaseClaim,
  seriesWorkAcquisitions,
} from "./series-acquisition.ts";
import { transmission } from "./transmission.ts";

export type SeriesReleaseSourceError = {
  source: "abb" | "prowlarr";
  label: string;
  error: string;
};

export type SeriesReleaseSearchDeps = {
  abbReleaseSearch?: typeof abbReleaseSearch;
  prowlarrReleaseSearch?: typeof prowlarrReleaseSearch;
  abbRelease?: typeof abbRelease;
  abbMagnet?: typeof abbMagnet;
  prowlarrRelease?: typeof prowlarrRelease;
  prowlarrMagnet?: typeof prowlarrMagnet;
  acquire?: typeof defaultAcquire;
};

let deps: SeriesReleaseSearchDeps = {};

// Slugs must come from a recent server-side search (same pattern as prowlarrLinks).
const ABB_SEARCH_CACHE_MS = 6 * 3600_000;
const abbSearchSlugs = new Map<string, number>();

function rememberAbbSlugs(results: { id: string }[]) {
  const expires = Date.now() + ABB_SEARCH_CACHE_MS;
  for (const release of results) abbSearchSlugs.set(release.id, expires);
  for (const [slug, expiry] of abbSearchSlugs)
    if (expiry <= Date.now() || abbSearchSlugs.size > 5000) abbSearchSlugs.delete(slug);
}

function requireAbbSlugFromSearch(slug: string) {
  const expires = abbSearchSlugs.get(slug);
  if (!expires || expires <= Date.now())
    throw new Error(
      "This search result has expired. Search again and choose the release.",
    );
}

export function setSeriesReleaseSearchDeps(overrides: SeriesReleaseSearchDeps) {
  deps = { ...deps, ...overrides };
}

export function resetSeriesReleaseSearchDeps() {
  deps = {};
  abbSearchSlugs.clear();
}

export function savedSeriesWork(
  userId: number,
  seriesId: number,
  bookId: number,
) {
  const row = sqlite
    .prepare(
      `SELECT w.work_id AS workId, w.title, c.author
       FROM user_saved_series_works u
       JOIN series_catalogue_works w ON w.series_id=u.series_id AND w.book_id=u.book_id
       JOIN series_catalogue c ON c.id=u.series_id
       WHERE u.user_id=? AND u.series_id=? AND u.book_id=?`,
    )
    .get(userId, seriesId, bookId) as
    | { workId: string; title: string; author: string | null }
    | undefined;
  if (!row) throw new Error("This series work could not be found.");
  return row;
}

export function defaultReleaseSearchQuery(
  title: string,
  author: string | null,
) {
  const parts = [title.trim(), author?.trim()].filter(Boolean);
  return parts.join(" ");
}

const activeDownload = new Set([
  "checking",
  "preparing",
  "downloading",
  "paused",
]);

function activeWorkAcquisition(userId: number, workId: string) {
  const state = getWorkMediaState(userId, workId);
  if (state?.state !== "queued" || !state.acquisitionId) return null;
  const job = db
    .select()
    .from(s.acquisitions)
    .where(eq(s.acquisitions.id, state.acquisitionId))
    .get();
  if (!job || !activeDownload.has(job.status)) return null;
  return job;
}

export type ReplacePreviousResult =
  | { action: "skipped_same_hash" }
  | { action: "stopped_local" }
  | { action: "detached_shared" }
  | { action: "detached_torbox"; note: string };

/** Detach or stop the caller's previous acquisition after a new one has started. */
export async function replacePreviousAcquisition(
  userId: number,
  previousAcquisitionId: string,
  newMagnet: string,
): Promise<ReplacePreviousResult> {
  const previous = db
    .select()
    .from(s.acquisitions)
    .where(eq(s.acquisitions.id, previousAcquisitionId))
    .get();
  if (!previous) return { action: "skipped_same_hash" };
  const newHash = magnetHash(newMagnet);
  if (previous.hash === newHash) return { action: "skipped_same_hash" };

  const users = db
    .select()
    .from(s.userAcquisitions)
    .where(eq(s.userAcquisitions.acquisitionId, previousAcquisitionId))
    .all();
  const shared =
    users.length !== 1 ||
    users[0].userId !== userId ||
    users.some((row) => row.userId !== userId);

  if (shared) {
    db.delete(s.userAcquisitions)
      .where(
        and(
          eq(s.userAcquisitions.userId, userId),
          eq(s.userAcquisitions.acquisitionId, previousAcquisitionId),
        ),
      )
      .run();
    if (previous.workId) syncWorkMediaState(userId, previous.workId);
    return { action: "detached_shared" };
  }

  if (previous.backend === "torbox") {
    db.delete(s.userAcquisitions)
      .where(
        and(
          eq(s.userAcquisitions.userId, userId),
          eq(s.userAcquisitions.acquisitionId, previousAcquisitionId),
        ),
      )
      .run();
    return {
      action: "detached_torbox",
      note:
        "The previous TorBox download was not cancelled upstream; this account no longer tracks it.",
    };
  }

  db.delete(s.userAcquisitions)
    .where(
      and(
        eq(s.userAcquisitions.userId, userId),
        eq(s.userAcquisitions.acquisitionId, previousAcquisitionId),
      ),
    )
    .run();
  if (previous.status !== "ready" && previous.status !== "error") {
    try {
      await transmission("torrent-stop", { ids: [previous.hash] });
    } catch {
      /* best effort */
    }
  }
  db.update(s.acquisitions)
    .set({
      status: "error",
      error: "Replaced by a new release selection.",
      updatedAt: Date.now(),
    })
    .where(eq(s.acquisitions.id, previousAcquisitionId))
    .run();
  return { action: "stopped_local" };
}

export async function searchSeriesWorkReleases(
  userId: number,
  seriesId: number,
  bookId: number,
  query: string,
  page = 1,
) {
  assertCanAcquireMedia(userId);
  savedSeriesWork(userId, seriesId, bookId);
  const q = query.trim();
  if (q.length < 2) throw new Error("Enter at least two characters to search.");
  const abbSearch = deps.abbReleaseSearch ?? abbReleaseSearch;
  const prowlarrSearchFn = deps.prowlarrReleaseSearch ?? prowlarrReleaseSearch;
  const sourceErrors: SeriesReleaseSourceError[] = [];
  let results: Awaited<ReturnType<typeof abbReleaseSearch>>["results"] = [];
  let nextPage: number | null = null;
  try {
    const abb = await abbSearch(q, page);
    results = abb.results.map((release) => ({
      ...release,
      source: "abb" as const,
    }));
    rememberAbbSlugs(abb.results);
    nextPage = abb.nextPage;
  } catch (error) {
    sourceErrors.push({
      source: "abb",
      label: "AudioBookBay",
      error: (error as Error).message,
    });
  }
  if (page === 1 && getSecret("prowlarr")) {
    try {
      const prowlarr = await prowlarrSearchFn(q);
      results = [
        ...results,
        ...prowlarr.results.map((release) => ({
          ...release,
          source: "prowlarr" as const,
        })),
      ];
    } catch (error) {
      sourceErrors.push({
        source: "prowlarr",
        label: "Prowlarr",
        error: (error as Error).message,
      });
    }
  }
  return { results, sourceErrors, nextPage };
}

export async function selectSeriesWorkRelease(
  userId: number,
  seriesId: number,
  bookId: number,
  input: {
    source: "abb" | "prowlarr";
    id: string;
    replaceActive?: boolean;
    confirmExistingAudio?: boolean;
  },
  acquire: typeof defaultAcquire = deps.acquire ?? defaultAcquire,
) {
  assertCanAcquireMedia(userId);
  const work = savedSeriesWork(userId, seriesId, bookId);
  const previous = activeWorkAcquisition(userId, work.workId);
  if (previous && !input.replaceActive)
    throw Object.assign(
      new Error(
        "An active download is in progress for this work. Replace it or cancel your new selection.",
      ),
      { statusCode: 409, code: "active_download" },
    );
  if (workHasPlayableAudio(work.workId) && !input.confirmExistingAudio)
    throw Object.assign(
      new Error(
        "This work already has playable audio. Confirm before downloading another release.",
      ),
      { statusCode: 409, code: "existing_audio" },
    );

  const claim = beginManualSeriesReleaseClaim(userId, work.workId);

  let magnet: string;
  let metadata: {
    title?: string;
    author?: string;
    cover?: string;
    language?: string | null;
    narrator?: string | null;
  };
  try {
    if (input.source === "prowlarr") {
      const link = (deps.prowlarrRelease ?? prowlarrRelease)(input.id);
      magnet = await (deps.prowlarrMagnet ?? prowlarrMagnet)(input.id);
      metadata = {
        title: work.title,
        author: work.author ?? undefined,
      };
      if (!metadata.title) metadata.title = link.title;
    } else {
      requireAbbSlugFromSearch(input.id);
      const release = await (deps.abbRelease ?? abbRelease)(input.id);
      magnet = await (deps.abbMagnet ?? abbMagnet)(input.id);
      metadata = {
        title: release.title,
        author: release.author ?? work.author ?? undefined,
        cover: release.cover,
        language: release.language,
        narrator: release.narrator,
      };
    }

    const job = await acquire(magnet, {
      ...metadata,
      workId: work.workId,
      userId,
    });

    let replaceResult: ReplacePreviousResult | null = null;
    if (previous && input.replaceActive)
      replaceResult = await replacePreviousAcquisition(
        userId,
        previous.id,
        magnet,
      );

    finalizeManualSeriesReleaseClaim(
      userId,
      seriesId,
      bookId,
      work.workId,
    );
    syncWorkMediaState(userId, work.workId);
    return {
      acquisition: job,
      mediaState: getWorkMediaState(userId, work.workId) as WorkMediaState,
      seriesAcquisition: seriesWorkAcquisitions(
        userId,
        seriesId,
        bookId,
        work.workId,
        false,
      ),
      replaceResult,
    };
  } catch (error) {
    if (claim.claimed) restoreManualSeriesReleaseClaim(claim);
    throw error;
  }
}
