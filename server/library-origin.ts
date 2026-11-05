import { and, eq } from "drizzle-orm";
import { db } from "./db.ts";
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

export function removalDefaultSelected(
  userId: number,
  seriesId: number,
  work: { added: boolean; workId: string | null },
) {
  if (!work.added || !work.workId) return false;
  const origin = libraryOriginFor(userId, work.workId);
  return origin?.source === "series" && origin.seriesId === seriesId;
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
