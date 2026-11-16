/*
 * Adding and removing a book by work (#527; spec #526, "What the server answers and accepts"; #456).
 * The Book page shows works, so Add to library and Remove from library change every audio edition
 * of the work at once for the requesting user. The routes by edition (`POST`, `PATCH` and
 * `DELETE /api/library/<id>`, `app.ts`) stay as they are for older clients and the Discover cards.
 *
 * Only the user's own rows change: their library rows, their hidden entries, their library origin
 * and their Hardcover queue. Files, places, bookmarks and the stored chosen recording are not
 * touched, so a book removed and added again comes back as it was.
 */
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { hiddenHardcoverPlaceholders, queueHardcoverStatus } from "./hardcover.ts";
import { removeUserLibraryRow, setLibraryOrigin } from "./library-origin.ts";
import { placeholderEditionSql } from "./placeholder-edition.ts";

/** The work's audio editions, the oldest first, each with whether it is a placeholder. */
function workEditions(workId: string) {
  return (
    sqlite
      .prepare(`SELECT e.id,${placeholderEditionSql("e.id")} AS placeholder FROM audio_editions e WHERE e.work_id=? ORDER BY e.rowid`)
      .all(workId) as { id: string; placeholder: 0 | 1 }[]
  ).map((edition) => ({ id: edition.id, placeholder: edition.placeholder === 1 }));
}

function hasLibraryRow(userId: number, editionId: string) {
  return !!db
    .select({ bookId: s.userLibrary.bookId })
    .from(s.userLibrary)
    .where(and(eq(s.userLibrary.userId, userId), eq(s.userLibrary.bookId, editionId)))
    .get();
}

/**
 * Whether `userId` may see the work: it exists, and not every audio edition it has is a placeholder
 * hidden from them (`hiddenHardcoverPlaceholders`), the rule `GET /api/works/<workId>` answers 404 by.
 */
export function workVisibleTo(userId: number, workId: string) {
  if (!db.select({ id: s.works.id }).from(s.works).where(eq(s.works.id, workId)).get()) return false;
  const editions = workEditions(workId);
  if (!editions.length) return true;
  const hidden = hiddenHardcoverPlaceholders(userId);
  return !editions.every((edition) => hidden.has(edition.id));
}

export type AddWorkResult = "added" | "no-audio";

/**
 * Adds the work to the user's library. Every audio edition of the work that is not a placeholder
 * gets the user's library row and loses their hidden entry, and a placeholder row of theirs beside
 * one is dropped (as the Hardcover import replaces a placeholder once audio is linked). A work whose
 * only audio editions are placeholders gets its first placeholder's row the same way. A work with
 * no audio edition at all is refused (`"no-audio"`): when a placeholder is made for one is #467's.
 *
 * When the work joins the library (the user had no row of it before), its library origin becomes
 * "manual" and Hardcover is told "add", once for the work. Adding a work that is already in the
 * library keeps its origin and its shelf status, so a repeated request changes nothing.
 */
export function addWorkToLibrary(userId: number, workId: string): AddWorkResult {
  return sqlite.transaction((): AddWorkResult => {
    const editions = workEditions(workId);
    if (!editions.length) return "no-audio";
    const real = editions.filter((edition) => !edition.placeholder);
    const targets = real.length ? real : editions.slice(0, 1);
    const joins = !editions.some((edition) => hasLibraryRow(userId, edition.id));
    const addedAt = Date.now();
    for (const edition of targets) {
      db.delete(s.userHiddenLibrary)
        .where(and(eq(s.userHiddenLibrary.userId, userId), eq(s.userHiddenLibrary.bookId, edition.id)))
        .run();
      db.insert(s.userLibrary)
        .values({ userId, bookId: edition.id, status: "unread", addedAt })
        .onConflictDoNothing()
        .run();
    }
    if (real.length)
      for (const edition of editions)
        if (edition.placeholder && hasLibraryRow(userId, edition.id)) removeUserLibraryRow(userId, edition.id);
    if (joins) {
      setLibraryOrigin(userId, workId, "manual", { addedAt });
      queueHardcoverStatus(userId, workId, "unread", "add");
    }
    return "added";
  })();
}

/**
 * Removes the work from the user's library: every audio edition of the work, placeholder included,
 * gets the user's hidden entry and loses their library row, as `DELETE /api/library/<id>` does per
 * edition, so a Hardcover sync does not add it back. Files, places and bookmarks stay.
 */
export function removeWorkFromLibrary(userId: number, workId: string) {
  sqlite.transaction(() => {
    for (const edition of workEditions(workId)) {
      db.insert(s.userHiddenLibrary).values({ userId, bookId: edition.id }).onConflictDoNothing().run();
      removeUserLibraryRow(userId, edition.id);
    }
  })();
}
