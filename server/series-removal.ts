import { existsSync, unlinkSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { pauseServerDownload } from "./downloads.ts";
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

function otherUsersNeedEdition(editionId: string, userId: number) {
  return !!sqlite
    .prepare(
      `SELECT 1 FROM user_library WHERE book_id=? AND user_id<>?
       UNION SELECT 1 FROM user_hidden_library WHERE book_id=? AND user_id<>?
       LIMIT 1`,
    )
    .get(editionId, userId, editionId, userId);
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

function audioEditionsForRemoval(userId: number, workId: string) {
  return db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all()
    .filter((edition) => !edition.id.startsWith("hc-"))
    .map((edition) => {
      const shared = otherUsersNeedEdition(edition.id, userId);
      return {
        editionId: edition.id,
        releaseTitle: edition.releaseTitle,
        wouldDelete: !shared,
        retainReason: shared
          ? "Another listener still has this release in their library."
          : null,
      };
    })
    .filter((row) => {
      const recording = db
        .select()
        .from(s.recordings)
        .where(eq(s.recordings.editionId, row.editionId))
        .get();
      if (!recording) return false;
      return db
        .select()
        .from(s.tracks)
        .where(eq(s.tracks.recordingId, recording.id))
        .get();
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

function detachUserFromAcquisition(userId: number, acquisitionId: string) {
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
  if (job.backend === "local" && job.hash) {
    transmission("torrent-stop", { ids: [job.hash] }).catch(() => {});
    transmission("torrent-remove", { ids: [job.hash], "delete-local-data": true }).catch(
      () => {},
    );
  }
  db.update(s.acquisitions)
    .set({ status: "error", error: "Removed with series.", updatedAt: Date.now() })
    .where(eq(s.acquisitions.id, acquisitionId))
    .run();
}

function cancelUserWorkDownloads(userId: number, workId: string) {
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
  for (const job of jobs) detachUserFromAcquisition(userId, job.id);
  db.delete(s.seriesAcquisitionJobs)
    .where(
      and(
        eq(s.seriesAcquisitionJobs.userId, userId),
        eq(s.seriesAcquisitionJobs.workId, workId),
      ),
    )
    .run();
}

function deleteTrackFiles(track: typeof s.tracks.$inferSelect) {
  const copy = db
    .select()
    .from(s.mediaCopies)
    .where(eq(s.mediaCopies.trackId, track.id))
    .get();
  if (copy?.path && existsSync(copy.path)) unlinkSync(copy.path);
  if (
    track.sourceType === "local" &&
    track.source &&
    existsSync(track.source)
  )
    unlinkSync(track.source);
}

function deleteEditionIfExclusive(userId: number, editionId: string) {
  if (otherUsersNeedEdition(editionId, userId))
    return { deleted: false as const, retainReason: "Another listener still has this release in their library." };
  const recordings = db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.editionId, editionId))
    .all();
  for (const recording of recordings) {
    pauseServerDownload(recording.id);
    const tracks = db
      .select()
      .from(s.tracks)
      .where(eq(s.tracks.recordingId, recording.id))
      .all();
    for (const track of tracks) deleteTrackFiles(track);
    db.delete(s.mediaCopies)
      .where(inArray(s.mediaCopies.trackId, tracks.map((t) => t.id)))
      .run();
    db.delete(s.serverDownloads)
      .where(eq(s.serverDownloads.recordingId, recording.id))
      .run();
    sqlite.prepare("DELETE FROM media_faults WHERE recording_id=?").run(recording.id);
    db.delete(s.tracks)
      .where(eq(s.tracks.recordingId, recording.id))
      .run();
    db.delete(s.recordings)
      .where(eq(s.recordings.id, recording.id))
      .run();
  }
  db.delete(s.userLibrary).where(eq(s.userLibrary.bookId, editionId)).run();
  db.delete(s.userHiddenLibrary)
    .where(eq(s.userHiddenLibrary.bookId, editionId))
    .run();
  db.delete(s.hiddenLibrary).where(eq(s.hiddenLibrary.bookId, editionId)).run();
  db.delete(s.editions).where(eq(s.editions.id, editionId)).run();
  return { deleted: true as const, retainReason: null };
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

function removeUserWorkAudio(userId: number, workId: string) {
  const results: SeriesRemovalAudioEdition[] = [];
  for (const edition of db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all()
    .filter((row) => !row.id.startsWith("hc-"))) {
    const recording = db
      .select()
      .from(s.recordings)
      .where(eq(s.recordings.editionId, edition.id))
      .get();
    if (!recording) continue;
    const tracks = db
      .select()
      .from(s.tracks)
      .where(eq(s.tracks.recordingId, recording.id))
      .all();
    if (!tracks.length) continue;
    const outcome = deleteEditionIfExclusive(userId, edition.id);
    results.push({
      editionId: edition.id,
      releaseTitle: edition.releaseTitle,
      wouldDelete: outcome.deleted,
      retainReason: outcome.retainReason,
    });
  }
  return results;
}

export function removeSavedHardcoverSeries(
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
  sqlite.transaction(() => {
    if (selected.length) {
      for (const bookId of selected) {
        const work = saved.find((row) => row.bookId === bookId)!;
        cancelUserWorkDownloads(userId, work.workId);
        removeUserWorkFromLibrary(userId, work.workId);
        audioOutcomes.push(...removeUserWorkAudio(userId, work.workId));
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
    db.delete(s.userSavedSeries)
      .where(
        and(
          eq(s.userSavedSeries.userId, userId),
          eq(s.userSavedSeries.seriesId, seriesId),
        ),
      )
      .run();
  })();

  return {
    ok: true as const,
    removedSeriesId: seriesId,
    removedWorkIds: selected,
    audio: audioOutcomes,
  };
}
