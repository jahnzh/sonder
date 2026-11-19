/*
 * Sonder's own Want to read (#721 part c1): a shelf of the user's library, per user, kept in
 * `user_want_to_read`. A work is put on it from its Book page or from a Discover row; a work that is
 * not in the library joins it first by the rule of Add to library (`addWorkToLibrary`), so a book
 * without media joins through its placeholder (`ensurePlaceholder`, #555). Taking a work off Want to
 * read leaves it in the library; a work that leaves the library leaves Want to read too
 * (`removeUserLibraryRow`). Reading and Finished are not stored here: they come from the user's own
 * progress (`workProgress`, `src/work-progress.ts`).
 *
 * The one-time copy of Hardcover's Want to read shelf (`copyHardcoverWantToRead`) reads only the
 * shelf rows Sonder already stores for the user (`user_hardcover_links`, with a status still in
 * `user_hardcover_outbox` taking its place, as the Hardcover block does) and never calls Hardcover.
 * It runs once per user (a marker in their settings holds its result); part d's switch calls it.
 */
import { sqlite } from "./db.ts";
import { addWorkToLibrary, workInLibrary, workVisibleTo } from "./work-library.ts";
import { getUserSetting, setUserSetting } from "./users.ts";

/** Hardcover's status id of its "Want to read" shelf (`hardcoverState().shelves`). */
export const HARDCOVER_WANT_TO_READ = 1;
/** The user setting that holds the one-time copy's result; set, the copy does not run again. */
export const HARDCOVER_COPY_SETTING = "wantToReadHardcoverCopy";

export type WantToReadSource = "manual" | "hardcover";

/** The works of `workIds` (all when omitted) on the user's Want to read that are in their library. */
export function wantToReadWorks(userId: number, workIds?: readonly string[]): Set<string> {
  const rows = sqlite
    .prepare(
      `SELECT t.work_id FROM user_want_to_read t WHERE t.user_id=?
         AND EXISTS(SELECT 1 FROM audio_editions e JOIN user_library u ON u.book_id=e.id
           WHERE e.work_id=t.work_id AND u.user_id=t.user_id)`,
    )
    .pluck()
    .all(userId) as string[];
  if (!workIds) return new Set(rows);
  const wanted = new Set(workIds);
  return new Set(rows.filter((workId) => wanted.has(workId)));
}

/**
 * Puts the work on the user's Want to read, after adding it to their library when it is not there
 * (`addWorkToLibrary`). A work already on it keeps its first mark.
 */
export function addToWantToRead(
  userId: number,
  workId: string,
  options: { source?: WantToReadSource } = {},
) {
  sqlite.transaction(() => {
    if (!workInLibrary(userId, workId)) addWorkToLibrary(userId, workId);
    sqlite
      .prepare("INSERT INTO user_want_to_read(user_id,work_id,source,added_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
      .run(userId, workId, options.source ?? "manual", Date.now());
  })();
}

/** Takes the work off the user's Want to read; it stays in their library. */
export function removeFromWantToRead(userId: number, workId: string) {
  sqlite.prepare("DELETE FROM user_want_to_read WHERE user_id=? AND work_id=?").run(userId, workId);
}

/** What the copy did: the works it added, the ones already on Want to read, and the Hardcover books it found no work for. */
export type HardcoverCopy = {
  copiedAt: number;
  added: string[];
  already: string[];
  unmatched: { bookId: number }[];
};

/** The Hardcover books on the user's stored Want to read shelf, a status they queued taking the place of the stored one. */
export function storedHardcoverWantToRead(userId: number): number[] {
  return sqlite
    .prepare(
      `SELECT book_id FROM (
         SELECT l.book_id,COALESCE(o.status_id,l.status_id) AS status FROM user_hardcover_links l
           LEFT JOIN user_hardcover_outbox o ON o.user_id=l.user_id AND o.book_id=l.book_id WHERE l.user_id=@userId
         UNION ALL
         SELECT o.book_id,o.status_id FROM user_hardcover_outbox o WHERE o.user_id=@userId
           AND NOT EXISTS(SELECT 1 FROM user_hardcover_links l WHERE l.user_id=o.user_id AND l.book_id=o.book_id)
       ) WHERE status=@shelf ORDER BY book_id`,
    )
    .pluck()
    .all({ userId, shelf: HARDCOVER_WANT_TO_READ }) as number[];
}

/**
 * The work on the server a Hardcover book names for the user: a work matched to it
 * (`hardcover_links`) that they may see, one in their library first, then the oldest; null for none.
 */
function workOfHardcoverBook(userId: number, bookId: number): string | null {
  const candidates = sqlite
    .prepare(
      `SELECT l.work_id FROM hardcover_links l JOIN works w ON w.id=l.work_id WHERE l.book_id=?
       ORDER BY EXISTS(SELECT 1 FROM audio_editions e JOIN user_library u ON u.book_id=e.id
         WHERE e.work_id=l.work_id AND u.user_id=?) DESC,w.rowid`,
    )
    .pluck()
    .all(bookId, userId) as string[];
  return candidates.find((workId) => workVisibleTo(userId, workId)) ?? null;
}

/** The copy's stored result for the user, null before it ran. */
export function hardcoverCopyResult(userId: number): HardcoverCopy | null {
  const stored = getUserSetting(userId, HARDCOVER_COPY_SETTING);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as HardcoverCopy;
  } catch (error) {
    // A marker that is not JSON still says the copy ran: it is answered as one that copied nothing.
    console.warn(`The Want to read copy's marker of user ${userId} is not readable:`, error);
    return { copiedAt: 0, added: [], already: [], unmatched: [] };
  }
}

/**
 * Once per user: every Hardcover book on their stored Want to read shelf whose work is on the server
 * goes on Sonder's Want to read (`addToWantToRead`, source "hardcover"); the
 * books with no work are listed as unmatched. Hardcover lists are not copied. A second call answers
 * the first one's result with `ran: false`.
 */
export function copyHardcoverWantToRead(userId: number): HardcoverCopy & { ran: boolean } {
  return sqlite.transaction(() => {
    const earlier = hardcoverCopyResult(userId);
    if (earlier) return { ...earlier, ran: false };
    const result: HardcoverCopy = { copiedAt: Date.now(), added: [], already: [], unmatched: [] };
    const on = wantToReadWorks(userId);
    for (const bookId of storedHardcoverWantToRead(userId)) {
      const workId = workOfHardcoverBook(userId, bookId);
      if (!workId) {
        result.unmatched.push({ bookId });
        continue;
      }
      if (on.has(workId)) {
        if (!result.already.includes(workId) && !result.added.includes(workId)) result.already.push(workId);
        continue;
      }
      addToWantToRead(userId, workId, { source: "hardcover" });
      on.add(workId);
      result.added.push(workId);
    }
    setUserSetting(userId, HARDCOVER_COPY_SETTING, JSON.stringify(result));
    return { ...result, ran: true };
  })();
}
