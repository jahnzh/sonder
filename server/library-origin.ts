import { and, eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";

export type LibraryOriginSource = "unknown" | "manual" | "hardcover_sync" | "series";

export function recordLibraryOrigin(
  userId: number,
  workId: string,
  source: Exclude<LibraryOriginSource, "unknown">,
  options?: { seriesId?: number; addedAt?: number },
) {
  db.insert(s.userWorkLibraryOrigin)
    .values({
      userId,
      workId,
      source,
      seriesId: options?.seriesId ?? null,
      addedAt: options?.addedAt ?? Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

export function libraryOriginFor(userId: number, workId: string) {
  return db
    .select()
    .from(s.userWorkLibraryOrigin)
    .where(
      and(
        eq(s.userWorkLibraryOrigin.userId, userId),
        eq(s.userWorkLibraryOrigin.workId, workId),
      ),
    )
    .get();
}

export function countOtherSavedSeries(
  userId: number,
  workId: string,
  exceptSeriesId: number,
) {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS count FROM user_saved_series uss
       JOIN user_saved_series_works w
         ON w.user_id=uss.user_id AND w.series_id=uss.series_id AND w.work_id=?
       WHERE uss.user_id=? AND uss.series_id<>?`,
    )
    .get(workId, userId, exceptSeriesId) as { count: number };
  return row.count;
}

/** Whether this work was added to the library through this series save flow. */
export function workIntroducedViaSeries(
  userId: number,
  seriesId: number,
  workId: string,
  legacyIntroduced: boolean,
) {
  const origin = libraryOriginFor(userId, workId);
  if (origin) {
    if (origin.source === "series" && origin.seriesId === seriesId) return true;
    if (origin.source === "unknown") return legacyIntroduced;
    return false;
  }
  return legacyIntroduced;
}

export function removalDefaultSelected(
  userId: number,
  seriesId: number,
  work: { added: boolean; workId: string | null },
  legacyIntroduced: boolean,
) {
  if (!work.added || !work.workId) return false;
  const otherSeries = countOtherSavedSeries(userId, work.workId, seriesId);
  return (
    workIntroducedViaSeries(userId, seriesId, work.workId, legacyIntroduced) &&
    otherSeries === 0
  );
}

export function libraryOriginLabel(
  origin: { source: LibraryOriginSource; seriesId: number | null } | undefined,
  seriesId: number,
): string | null {
  if (!origin || origin.source === "unknown") return null;
  if (origin.source === "manual") return "Added manually";
  if (origin.source === "hardcover_sync") return "Added from Hardcover";
  if (origin.source === "series") {
    return origin.seriesId === seriesId
      ? "Added through this series"
      : "Added via another series";
  }
  return null;
}

export function userCanSetWorkCompletion(userId: number, workId: string) {
  if (
    db
      .select()
      .from(s.editions)
      .where(eq(s.editions.workId, workId))
      .all()
      .some((edition) =>
        db
          .select()
          .from(s.userLibrary)
          .where(
            and(
              eq(s.userLibrary.userId, userId),
              eq(s.userLibrary.bookId, edition.id),
            ),
          )
          .get(),
      )
  )
    return true;
  return !!db
    .select()
    .from(s.userSavedSeriesWorks)
    .where(
      and(
        eq(s.userSavedSeriesWorks.userId, userId),
        eq(s.userSavedSeriesWorks.workId, workId),
      ),
    )
    .get();
}

export function setWorkCompletionOverride(
  userId: number,
  workId: string,
  status: "finished" | "unread" | "derived",
) {
  if (!userCanSetWorkCompletion(userId, workId))
    throw Object.assign(new Error("This work could not be found."), { statusCode: 404 });
  if (status === "derived") {
    db.delete(s.userWorkCompletion)
      .where(
        and(
          eq(s.userWorkCompletion.userId, userId),
          eq(s.userWorkCompletion.workId, workId),
        ),
      )
      .run();
    return;
  }
  db.insert(s.userWorkCompletion)
    .values({ userId, workId, status })
    .onConflictDoUpdate({
      target: [s.userWorkCompletion.userId, s.userWorkCompletion.workId],
      set: { status },
    })
    .run();
}

export function deleteLibraryOrigin(userId: number, workId: string) {
  db.delete(s.userWorkLibraryOrigin)
    .where(
      and(
        eq(s.userWorkLibraryOrigin.userId, userId),
        eq(s.userWorkLibraryOrigin.workId, workId),
      ),
    )
    .run();
}
