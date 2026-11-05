import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import {
  cancelServerDownload,
  serverDownloadIsActive,
  waitUntilServerDownloadIdle,
} from "./downloads.ts";
import { mediaRoot } from "./storage.ts";
import { transmission } from "./transmission.ts";
import { syncWorkMediaState } from "./work-media-state.ts";
import { userIsAdmin } from "./users.ts";

const activeAcquisition = new Set([
  "checking",
  "preparing",
  "downloading",
  "paused",
]);

export type SeriesRemovalAudioEdition = {
  editionId: string;
  releaseTitle: string | null;
  wouldDelete: boolean;
  retainReason: string | null;
};

export type SeriesRemovalWork = {
  bookId: number;
  title: string;
  workId: string;
  introduced: boolean;
  selectedByDefault: boolean;
  otherSeries: { id: number; name: string }[];
  activeDownloads: { id: string; title: string; status: string }[];
  audioEditions: SeriesRemovalAudioEdition[];
};

export type SeriesRemovalPreview = {
  id: number;
  name: string;
  works: SeriesRemovalWork[];
};

type TorrentCancel = { hash: string };

type RecordingDeletePlan = { recordingId: string; paths: string[] };

type EditionDeletePlan = {
  editionId: string;
  releaseTitle: string | null;
  recordings: RecordingDeletePlan[];
};

function assertSavedSeries(userId: number, seriesId: number) {
  const row = sqlite
    .prepare(
      `SELECT c.id,c.name FROM series_catalogue c
       JOIN user_saved_series u ON u.series_id=c.id
       WHERE u.user_id=? AND c.id=?`,
    )
    .get(userId, seriesId) as { id: number; name: string } | undefined;
  if (!row) throw new Error("This saved series could not be found.");
  return row;
}

function savedWorks(userId: number, seriesId: number) {
  return sqlite
    .prepare(
      `SELECT c.book_id AS bookId,c.title,
        u.work_id AS workId,u.introduced
       FROM series_catalogue_works c
       JOIN user_saved_series_works u
         ON u.series_id=c.series_id AND u.book_id=c.book_id AND u.user_id=?
       WHERE c.series_id=?`,
    )
    .all(userId, seriesId) as {
    bookId: number;
    title: string;
    workId: string;
    introduced: number;
  }[];
}

function otherSavedSeries(
  userId: number,
  workId: string,
  exceptSeriesId: number,
) {
  return sqlite
    .prepare(
      `SELECT c.id,c.name FROM user_saved_series uss
       JOIN series_catalogue c ON c.id=uss.series_id
       JOIN user_saved_series_works w
         ON w.user_id=uss.user_id AND w.series_id=uss.series_id AND w.work_id=?
       WHERE uss.user_id=? AND uss.series_id<>?`,
    )
    .all(workId, userId, exceptSeriesId) as { id: number; name: string }[];
}

function blockReasonForEdition(editionId: string, exceptUserId: number) {
  if (
    sqlite
      .prepare(
        `SELECT 1 FROM user_library WHERE book_id=? AND user_id<>? LIMIT 1`,
      )
      .get(editionId, exceptUserId)
  )
    return "Another listener still has this release in their library.";
  if (
    sqlite
      .prepare(
        `SELECT 1 FROM user_hidden_library WHERE book_id=? AND user_id<>? LIMIT 1`,
      )
      .get(editionId, exceptUserId)
  )
    return "Another listener still keeps this release hidden in their library.";
  if (
    sqlite
      .prepare(
        `SELECT 1 FROM user_progress up
         INNER JOIN recordings r ON r.id=up.recording_id
         WHERE r.edition_id=? AND up.user_id<>? LIMIT 1`,
      )
      .get(editionId, exceptUserId)
  )
    return "Another listener still has listening progress on this release.";
  if (
    sqlite
      .prepare(
        `SELECT 1 FROM user_hardcover_progress uhp
         INNER JOIN recordings r ON r.id=uhp.recording_id
         WHERE r.edition_id=? AND uhp.user_id<>? LIMIT 1`,
      )
      .get(editionId, exceptUserId)
  )
    return "Another listener still has listening progress on this release.";
  if (
    sqlite
      .prepare(
        `SELECT 1 FROM hardcover_progress hp
         INNER JOIN recordings r ON r.id=hp.recording_id
         WHERE r.edition_id=? LIMIT 1`,
      )
      .get(editionId)
  )
    return "Another listener still has listening progress on this release.";
  if (
    sqlite
      .prepare(
        `SELECT 1 FROM progress p
         INNER JOIN recordings r ON r.id=p.recording_id
         WHERE r.edition_id=? LIMIT 1`,
      )
      .get(editionId)
  )
    return "Another listener still has listening progress on this release.";
  // Legacy hidden_library is global (admin / user 1 shelf); treat it like a foreign hold.
  if (sqlite.prepare(`SELECT 1 FROM hidden_library WHERE book_id=? LIMIT 1`).get(editionId))
    return "Another listener still keeps this release hidden in their library.";
  return null;
}

function userActiveDownloads(userId: number, workId: string) {
  return db
    .select({ job: s.acquisitions })
    .from(s.userAcquisitions)
    .innerJoin(
      s.acquisitions,
      eq(s.acquisitions.id, s.userAcquisitions.acquisitionId),
    )
    .where(
      and(
        eq(s.userAcquisitions.userId, userId),
        eq(s.acquisitions.workId, workId),
      ),
    )
    .all()
    .map(({ job }) => job)
    .filter((job) => activeAcquisition.has(job.status))
    .map((job) => ({ id: job.id, title: job.title, status: job.status }));
}

function editionHasAudio(editionId: string) {
  return db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.editionId, editionId))
    .all()
    .some((recording) =>
      db
        .select()
        .from(s.tracks)
        .where(eq(s.tracks.recordingId, recording.id))
        .get(),
    );
}

function audioEditionsForRemoval(userId: number, workId: string) {
  return db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all()
    .filter((edition) => !edition.id.startsWith("hc-") && editionHasAudio(edition.id))
    .map((edition) => {
      const retainReason = blockReasonForEdition(edition.id, userId);
      return {
        editionId: edition.id,
        releaseTitle: edition.releaseTitle,
        wouldDelete: !retainReason,
        retainReason,
      };
    });
}

export function previewSeriesRemoval(
  userId: number,
  seriesId: number,
): SeriesRemovalPreview {
  const series = assertSavedSeries(userId, seriesId);
  const works = savedWorks(userId, seriesId).map((work) => {
    const otherSeries = otherSavedSeries(userId, work.workId, seriesId);
    const introduced = !!work.introduced;
    return {
      bookId: work.bookId,
      title: work.title,
      workId: work.workId,
      introduced,
      selectedByDefault: introduced && otherSeries.length === 0,
      otherSeries,
      activeDownloads: userActiveDownloads(userId, work.workId),
      audioEditions: audioEditionsForRemoval(userId, work.workId),
    };
  });
  return { id: series.id, name: series.name, works };
}

function managedMediaPath(path: string) {
  if (!existsSync(path)) return null;
  try {
    const root = realpathSync(mediaRoot);
    const actual = realpathSync(path);
    const rel = relative(root, actual);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return actual;
  } catch {
    return null;
  }
}

function pathReferencedElsewhere(path: string, exceptTrackIds: Set<string>) {
  const canonical = managedMediaPath(path) ?? path;
  for (const track of db.select().from(s.tracks).all()) {
    if (exceptTrackIds.has(track.id)) continue;
    if (track.sourceType === "local") {
      const source = managedMediaPath(track.source) ?? track.source;
      if (source === canonical) return true;
    }
  }
  for (const copy of db.select().from(s.mediaCopies).all()) {
    if (exceptTrackIds.has(copy.trackId)) continue;
    const copyPath = managedMediaPath(copy.path) ?? copy.path;
    if (copyPath === canonical) return true;
  }
  return false;
}

function collectDeletablePaths(
  tracks: (typeof s.tracks.$inferSelect)[],
  skippedPaths: string[],
) {
  const unlink: string[] = [];
  const trackIds = new Set(tracks.map((track) => track.id));
  for (const track of tracks) {
    const copy = db
      .select()
      .from(s.mediaCopies)
      .where(eq(s.mediaCopies.trackId, track.id))
      .get();
    for (const candidate of [copy?.path, track.sourceType === "local" ? track.source : null]) {
      if (!candidate) continue;
      const managed = managedMediaPath(candidate);
      if (!managed) {
        skippedPaths.push(candidate);
        continue;
      }
      if (pathReferencedElsewhere(managed, trackIds)) {
        skippedPaths.push(managed);
        continue;
      }
      if (!unlink.includes(managed)) unlink.push(managed);
    }
  }
  return unlink;
}

function markAcquisitionCancelledInDb(acquisitionId: string) {
  db.update(s.acquisitions)
    .set({ status: "error", error: "Removed with series.", updatedAt: Date.now() })
    .where(eq(s.acquisitions.id, acquisitionId))
    .run();
}

function detachUserFromAcquisition(
  userId: number,
  acquisitionId: string,
  torrentCancels: TorrentCancel[],
) {
  db.delete(s.userAcquisitions)
    .where(
      and(
        eq(s.userAcquisitions.userId, userId),
        eq(s.userAcquisitions.acquisitionId, acquisitionId),
      ),
    )
    .run();
  const others = db
    .select()
    .from(s.userAcquisitions)
    .where(eq(s.userAcquisitions.acquisitionId, acquisitionId))
    .all();
  if (others.length) return;
  const job = db
    .select()
    .from(s.acquisitions)
    .where(eq(s.acquisitions.id, acquisitionId))
    .get();
  if (!job || !activeAcquisition.has(job.status)) return;
  if (job.backend === "local" && job.hash) torrentCancels.push({ hash: job.hash });
  markAcquisitionCancelledInDb(acquisitionId);
}

function cancelUserWorkDownloads(
  userId: number,
  workId: string,
  torrentCancels: TorrentCancel[],
) {
  const jobs = db
    .select({ job: s.acquisitions })
    .from(s.userAcquisitions)
    .innerJoin(
      s.acquisitions,
      eq(s.acquisitions.id, s.userAcquisitions.acquisitionId),
    )
    .where(
      and(
        eq(s.userAcquisitions.userId, userId),
        eq(s.acquisitions.workId, workId),
      ),
    )
    .all()
    .map(({ job }) => job);
  for (const job of jobs) detachUserFromAcquisition(userId, job.id, torrentCancels);
  db.delete(s.seriesAcquisitionJobs)
    .where(
      and(
        eq(s.seriesAcquisitionJobs.userId, userId),
        eq(s.seriesAcquisitionJobs.workId, workId),
      ),
    )
    .run();
}

function deleteRecordingRows(recordingId: string) {
  sqlite.prepare("DELETE FROM alignment_jobs WHERE recording_id=?").run(recordingId);
  sqlite
    .prepare("DELETE FROM user_hardcover_recording_editions WHERE recording_id=?")
    .run(recordingId);
  sqlite
    .prepare("DELETE FROM hardcover_recording_editions WHERE recording_id=?")
    .run(recordingId);
  sqlite
    .prepare(
      `DELETE FROM user_hardcover_progress WHERE recording_id=?`,
    )
    .run(recordingId);
  sqlite.prepare("DELETE FROM hardcover_progress WHERE recording_id=?").run(recordingId);
  db.delete(s.userProgress)
    .where(eq(s.userProgress.recordingId, recordingId))
    .run();
  sqlite.prepare("DELETE FROM progress WHERE recording_id=?").run(recordingId);
  sqlite
    .prepare("DELETE FROM media_faults WHERE recording_id=?")
    .run(recordingId);
  sqlite
    .prepare(`UPDATE work_ebook_set SET recording_id=NULL WHERE recording_id=?`)
    .run(recordingId);
  const tracks = db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.recordingId, recordingId))
    .all();
  if (tracks.length) {
    db.delete(s.mediaCopies)
      .where(inArray(s.mediaCopies.trackId, tracks.map((track) => track.id)))
      .run();
  }
  db.delete(s.serverDownloads)
    .where(eq(s.serverDownloads.recordingId, recordingId))
    .run();
  db.delete(s.tracks).where(eq(s.tracks.recordingId, recordingId)).run();
  db.delete(s.recordings).where(eq(s.recordings.id, recordingId)).run();
}

function deleteEditionIfExclusive(
  userId: number,
  editionId: string,
  skippedPaths: string[],
  editionDeletePlans: EditionDeletePlan[],
): SeriesRemovalAudioEdition {
  const retainReason = blockReasonForEdition(editionId, userId);
  if (retainReason) {
    return {
      editionId,
      releaseTitle:
        db.select().from(s.editions).where(eq(s.editions.id, editionId)).get()
          ?.releaseTitle ?? null,
      wouldDelete: false,
      retainReason,
    };
  }
  const edition = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.id, editionId))
    .get();
  const recordings = db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.editionId, editionId))
    .all();
  editionDeletePlans.push({
    editionId,
    releaseTitle: edition?.releaseTitle ?? null,
    recordings: recordings.map((recording) => {
      const tracks = db
        .select()
        .from(s.tracks)
        .where(eq(s.tracks.recordingId, recording.id))
        .all();
      return {
        recordingId: recording.id,
        paths: collectDeletablePaths(tracks, skippedPaths),
      };
    }),
  });
  return {
    editionId,
    releaseTitle: edition?.releaseTitle ?? null,
    wouldDelete: true,
    retainReason: null,
  };
}

function hardcoverBookIdForWork(workId: string) {
  return db
    .select({ bookId: s.hardcoverLinks.bookId })
    .from(s.hardcoverLinks)
    .where(eq(s.hardcoverLinks.workId, workId))
    .get()?.bookId;
}

function ensureHardcoverSyncSuppressed(userId: number, workId: string) {
  const bookId = hardcoverBookIdForWork(workId);
  const editions = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all();
  const audio = editions.filter((edition) => editionHasAudio(edition.id));
  let representativeId =
    audio[0]?.id ??
    editions.find((edition) => edition.id.startsWith("hc-"))?.id ??
    editions[0]?.id ??
    null;
  if (!representativeId && bookId != null) {
    representativeId = `hc-${bookId}`;
    db.insert(s.editions)
      .values({
        id: representativeId,
        workId,
        cover: "/covers/meditations.svg",
        narrator: "Audio not added",
        language: null,
        releaseTitle: null,
        rating: 0,
        sourceLabel: "Hardcover library",
      })
      .onConflictDoNothing()
      .run();
    db.insert(s.recordings)
      .values({
        id: `recording-${representativeId}`,
        editionId: representativeId,
      })
      .onConflictDoNothing()
      .run();
  }
  if (representativeId) {
    db.insert(s.userHiddenLibrary)
      .values({ userId, bookId: representativeId })
      .onConflictDoNothing()
      .run();
  }
}

function commitEditionDeletes(plan: EditionDeletePlan) {
  for (const recording of plan.recordings) deleteRecordingRows(recording.recordingId);
  db.delete(s.userLibrary).where(eq(s.userLibrary.bookId, plan.editionId)).run();
  db.delete(s.userHiddenLibrary)
    .where(eq(s.userHiddenLibrary.bookId, plan.editionId))
    .run();
  db.delete(s.hiddenLibrary).where(eq(s.hiddenLibrary.bookId, plan.editionId)).run();
  db.delete(s.editions).where(eq(s.editions.id, plan.editionId)).run();
}

function removeUserWorkFromLibrary(userId: number, workId: string) {
  const editions = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all();
  for (const edition of editions) {
    db.delete(s.userLibrary)
      .where(
        and(
          eq(s.userLibrary.userId, userId),
          eq(s.userLibrary.bookId, edition.id),
        ),
      )
      .run();
    db.insert(s.userHiddenLibrary)
      .values({ userId, bookId: edition.id })
      .onConflictDoNothing()
      .run();
  }
  db.delete(s.userWorkCompletion)
    .where(
      and(
        eq(s.userWorkCompletion.userId, userId),
        eq(s.userWorkCompletion.workId, workId),
      ),
    )
    .run();
  db.delete(s.workMediaStates)
    .where(
      and(
        eq(s.workMediaStates.userId, userId),
        eq(s.workMediaStates.workId, workId),
      ),
    )
    .run();
  db.delete(s.userSavedSeriesWorks)
    .where(
      and(
        eq(s.userSavedSeriesWorks.userId, userId),
        eq(s.userSavedSeriesWorks.workId, workId),
      ),
    )
    .run();
  const recordings = editions.flatMap((edition) =>
    db
      .select()
      .from(s.recordings)
      .where(eq(s.recordings.editionId, edition.id))
      .all(),
  );
  for (const recording of recordings) {
    db.delete(s.userProgress)
      .where(
        and(
          eq(s.userProgress.userId, userId),
          eq(s.userProgress.recordingId, recording.id),
        ),
      )
      .run();
  }
}

function removeUserWorkAudio(
  userId: number,
  workId: string,
  skippedPaths: string[],
  editionDeletePlans: EditionDeletePlan[],
) {
  const results: SeriesRemovalAudioEdition[] = [];
  for (const edition of db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all()
    .filter((row) => !row.id.startsWith("hc-") && editionHasAudio(row.id))) {
    results.push(
      deleteEditionIfExclusive(
        userId,
        edition.id,
        skippedPaths,
        editionDeletePlans,
      ),
    );
  }
  ensureHardcoverSyncSuppressed(userId, workId);
  return results;
}

async function finalizeEditionDeletes(
  editionDeletePlans: EditionDeletePlan[],
  torrentCancels: TorrentCancel[],
  skippedPaths: string[],
) {
  const fileErrors: string[] = [];
  const pathsToUnlink: string[] = [];
  for (const plan of editionDeletePlans) {
    let blocked = false;
    for (const recording of plan.recordings) {
      try {
        if (serverDownloadIsActive(recording.recordingId)) {
          await waitUntilServerDownloadIdle(recording.recordingId);
        }
      } catch (error) {
        fileErrors.push(
          `${plan.editionId}: ${(error as Error).message}`,
        );
        for (const path of recording.paths) skippedPaths.push(path);
        blocked = true;
        break;
      }
      cancelServerDownload(recording.recordingId);
    }
    if (blocked) continue;
    sqlite.transaction(() => commitEditionDeletes(plan))();
    for (const recording of plan.recordings) {
      for (const path of recording.paths) {
        if (!pathsToUnlink.includes(path)) pathsToUnlink.push(path);
      }
    }
  }
  for (const { hash } of torrentCancels) {
    transmission("torrent-stop", { ids: [hash] }).catch(() => {});
    transmission("torrent-remove", {
      ids: [hash],
      "delete-local-data": true,
    }).catch(() => {});
  }
  for (const path of pathsToUnlink) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (error) {
      fileErrors.push(`${path}: ${(error as Error).message}`);
    }
  }
  return fileErrors;
}

export async function removeSavedHardcoverSeries(
  userId: number,
  seriesId: number,
  bookIds?: number[],
) {
  assertSavedSeries(userId, seriesId);
  const saved = savedWorks(userId, seriesId);
  const allowed = new Set(saved.map((work) => work.bookId));
  const selected =
    bookIds?.filter((bookId, index, all) => all.indexOf(bookId) === index) ??
    [];
  if (selected.some((bookId) => !allowed.has(bookId)))
    throw new Error("Choose works from this saved series.");
  if (selected.length && !userIsAdmin(userId))
    throw Object.assign(
      new Error("Only an administrator can remove works and their audio."),
      { statusCode: 403 },
    );

  const audioOutcomes: SeriesRemovalAudioEdition[] = [];
  const torrentCancels: TorrentCancel[] = [];
  const skippedPaths: string[] = [];
  const editionDeletePlans: EditionDeletePlan[] = [];

  sqlite.transaction(() => {
    if (selected.length) {
      for (const bookId of selected) {
        const work = saved.find((row) => row.bookId === bookId)!;
        cancelUserWorkDownloads(userId, work.workId, torrentCancels);
        removeUserWorkFromLibrary(userId, work.workId);
        audioOutcomes.push(
          ...removeUserWorkAudio(
            userId,
            work.workId,
            skippedPaths,
            editionDeletePlans,
          ),
        );
        syncWorkMediaState(userId, work.workId);
      }
    }
    db.delete(s.seriesAcquisitionJobs)
      .where(
        and(
          eq(s.seriesAcquisitionJobs.userId, userId),
          eq(s.seriesAcquisitionJobs.seriesId, seriesId),
        ),
      )
      .run();
    db.delete(s.userSavedSeriesWorks)
      .where(
        and(
          eq(s.userSavedSeriesWorks.userId, userId),
          eq(s.userSavedSeriesWorks.seriesId, seriesId),
        ),
      )
      .run();
    db.delete(s.userSeriesSeenWorks)
      .where(
        and(
          eq(s.userSeriesSeenWorks.userId, userId),
          eq(s.userSeriesSeenWorks.seriesId, seriesId),
        ),
      )
      .run();
    db.delete(s.userSavedSeries)
      .where(
        and(
          eq(s.userSavedSeries.userId, userId),
          eq(s.userSavedSeries.seriesId, seriesId),
        ),
      )
      .run();
  })();

  const fileErrors = await finalizeEditionDeletes(
    editionDeletePlans,
    torrentCancels,
    skippedPaths,
  );

  return {
    ok: true as const,
    removedSeriesId: seriesId,
    removedWorkIds: selected,
    audio: audioOutcomes,
    skippedPaths,
    fileErrors,
  };
}
