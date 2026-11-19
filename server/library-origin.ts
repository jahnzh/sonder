import { and, eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";

export type LibraryOriginSource = "unknown" | "manual" | "hardcover_sync" | "series";

export function setLibraryOrigin(
  userId: number,
  workId: string,
  source: Exclude<LibraryOriginSource, "unknown">,
  options?: { seriesId?: string; addedAt?: number },
) {
  const addedAt = options?.addedAt ?? Date.now();
  // The series is named by its AudiobookDB id (#721); the Hardcover `series_id` is no longer written.
  const catalogueSeriesId = options?.seriesId ?? null;
  db.insert(s.userWorkLibraryOrigin)
    .values({
      userId,
      workId,
      source,
      seriesId: null,
      catalogueSeriesId,
      addedAt,
    })
    .onConflictDoUpdate({
      target: [s.userWorkLibraryOrigin.userId, s.userWorkLibraryOrigin.workId],
      set: { source, seriesId: null, catalogueSeriesId, addedAt },
    })
    .run();
}

/** @deprecated use setLibraryOrigin on a newly inserted library row only */
export function recordLibraryOrigin(
  userId: number,
  workId: string,
  source: Exclude<LibraryOriginSource, "unknown">,
  options?: { seriesId?: string; addedAt?: number },
) {
  setLibraryOrigin(userId, workId, source, options);
}

/** The work's origin for the user; `seriesId` is the AudiobookDB series that brought it (#721). */
export function libraryOriginFor(userId: number, workId: string) {
  const row = db
    .select()
    .from(s.userWorkLibraryOrigin)
    .where(
      and(
        eq(s.userWorkLibraryOrigin.userId, userId),
        eq(s.userWorkLibraryOrigin.workId, workId),
      ),
    )
    .get();
  return row ? { userId: row.userId, workId: row.workId, source: row.source, seriesId: row.catalogueSeriesId, addedAt: row.addedAt } : undefined;
}

export function countOtherSavedSeries(
  userId: number,
  workId: string,
  exceptSeriesId: string,
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

export function userStillHasWorkInLibrary(userId: number, workId: string) {
  return db
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
    );
}

export function removeUserLibraryRow(userId: number, bookId: string) {
  const edition = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.id, bookId))
    .get();
  db.delete(s.userLibrary)
    .where(
      and(eq(s.userLibrary.userId, userId), eq(s.userLibrary.bookId, bookId)),
    )
    .run();
  if (edition && !userStillHasWorkInLibrary(userId, edition.workId)) {
    deleteLibraryOrigin(userId, edition.workId);
    // Want to read is a shelf of the library (#721 part c1): a work that leaves the library leaves it too.
    sqlite.prepare("DELETE FROM user_want_to_read WHERE user_id=? AND work_id=?").run(userId, edition.workId);
  }
}

/** Whether this work counts as introduced through this series for removal defaults. */
export function workIntroducedViaSeries(
  userId: number,
  seriesId: string,
  workId: string,
  legacyIntroduced: boolean,
) {
  if (!legacyIntroduced) return false;
  const origin = libraryOriginFor(userId, workId);
  if (!origin || origin.source === "unknown") return true;
  return origin.source === "series" && origin.seriesId === seriesId;
}

export function seriesRemovalWorkSelectedByDefault(
  userId: number,
  seriesId: string,
  workId: string,
  legacyIntroduced: boolean,
  otherSeriesCount: number,
) {
  if (otherSeriesCount > 0) return false;
  return workIntroducedViaSeries(userId, seriesId, workId, legacyIntroduced);
}

export function removalDefaultSelected(
  userId: number,
  seriesId: string,
  work: { added: boolean; workId: string | null },
  legacyIntroduced: boolean,
) {
  if (!work.added || !work.workId) return false;
  return seriesRemovalWorkSelectedByDefault(
    userId,
    seriesId,
    work.workId,
    legacyIntroduced,
    countOtherSavedSeries(userId, work.workId, seriesId),
  );
}

export function libraryOriginLabel(
  origin: { source: LibraryOriginSource; seriesId: string | null } | undefined,
  seriesId: string,
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
