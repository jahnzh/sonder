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
import { and, eq, sql } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { hiddenHardcoverPlaceholders } from "./hardcover.ts";
import { removeUserLibraryRow, setLibraryOrigin } from "./library-origin.ts";
import { ensurePlaceholder, placeholderEditionSql } from "./placeholder-edition.ts";
import { ADMIN_USER_ID, getUserSetting, listUserIds, setUserSetting } from "./users.ts";
import { CONSENSUS_EBOOK_PREFIX } from "./ebook-set-consensus.ts";

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
 * The rule by which a user may see a work that exists (#573): unless every audio edition it has is a
 * placeholder hidden from them (`hiddenHardcoverPlaceholders`, `hidden`) and it has no ebook edition
 * (the consensus text of an ebook set not counted). Ebook editions are listed to every user
 * (`GET /api/ebooks`), so a work with one is no one user's secret.
 */
export function workVisibleByRule(editionIds: string[], hidden: Set<string>, hasEbook: boolean) {
  return hasEbook || !editionIds.length || !editionIds.every((id) => hidden.has(id));
}

/**
 * Whether `userId` may see the work: it exists, and `workVisibleByRule` holds, the rule
 * `GET /api/works/<workId>` answers 404 by and `GET /api/works` leaves works out by. `hidden` is
 * `hiddenHardcoverPlaceholders(userId)`, when the caller has it already.
 */
export function workVisibleTo(userId: number, workId: string, hidden?: Set<string>) {
  if (!db.select({ id: s.works.id }).from(s.works).where(eq(s.works.id, workId)).get()) return false;
  const editions = workEditions(workId);
  if (!editions.length) return true;
  const hasEbook = !!sqlite
    .prepare("SELECT 1 FROM ebook_editions WHERE work_id=? AND substr(id,1,length(?))<>? LIMIT 1")
    .get(workId, CONSENSUS_EBOOK_PREFIX, CONSENSUS_EBOOK_PREFIX);
  return workVisibleByRule(
    editions.map((edition) => edition.id),
    hidden ?? hiddenHardcoverPlaceholders(userId),
    hasEbook,
  );
}

/** Whether `userId` has a hidden entry for the audio edition `editionId`. */
function hidesEdition(userId: number, editionId: string) {
  return !!db
    .select({ bookId: s.userHiddenLibrary.bookId })
    .from(s.userHiddenLibrary)
    .where(and(eq(s.userHiddenLibrary.userId, userId), eq(s.userHiddenLibrary.bookId, editionId)))
    .get();
}

/** Whether the user has a library row of any audio edition of the work, placeholder included. */
export function workInLibrary(userId: number, workId: string) {
  return workEditions(workId).some((edition) => hasLibraryRow(userId, edition.id));
}

/**
 * Adds the work to the user's library. Every audio edition of the work that is not a placeholder
 * gets the user's library row and loses their hidden entry, and a placeholder row of theirs beside
 * one is dropped (as the Hardcover import replaces a placeholder once audio is linked). A work whose
 * only audio editions are placeholders gets its first placeholder's row the same way, and a work
 * with no audio edition at all gets its placeholder made first (`ensurePlaceholder`, #467
 * decision 2), so it joins the library through it.
 *
 * When the work joins the library (the user had no row of it before), its library origin becomes
 * "manual", once for the work. Adding a work that is already in the library keeps its origin and
 * its shelf status, so a repeated request changes nothing.
 */
export function addWorkToLibrary(userId: number, workId: string) {
  sqlite.transaction(() => {
    if (!workEditions(workId).length) ensurePlaceholder(sqlite, workId);
    const editions = workEditions(workId);
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
    if (joins) setLibraryOrigin(userId, workId, "manual", { addedAt });
  })();
}

/**
 * An EPUB or PDF the user imported or got (the ebook edition `ebookId`) puts its work in their
 * library (#467, decision 2), by the rule of Add to library (`addWorkToLibrary`), when it is not
 * there yet. A work already in their library is left as it is: a recording they removed beside it
 * stays removed.
 */
export function joinLibraryWithEbook(userId: number, ebookId: string) {
  sqlite.transaction(() => {
    const workId = db
      .select({ workId: s.ebookEditions.workId })
      .from(s.ebookEditions)
      .where(eq(s.ebookEditions.id, ebookId))
      .get()?.workId;
    if (workId && !workInLibrary(userId, workId)) addWorkToLibrary(userId, workId);
  })();
}

/**
 * Real audio arriving for a work (#467, decision 3), for every work: each user who has a library
 * row of one of the work's placeholders gets the new edition `editionId`'s row with the status of
 * that placeholder row and loses the placeholder rows. A user who hid `editionId` is left alone
 * (their placeholder row stays, so the book stays in their library without the recording they
 * removed). The library origin, places in the ebook and bookmarks are not touched (Hardcover's shelf
 * status and position are no longer applied here: its sync is removed, #721 part d).
 *
 * The acquisition import and the upload call it inside the transaction that wrote the edition.
 */
export function claimWorkAudio(workId: string, editionId: string) {
  sqlite.transaction(() => {
    const placeholders = workEditions(workId).filter((edition) => edition.placeholder && edition.id !== editionId);
    if (placeholders.length)
      for (const userId of listUserIds()) {
        const shelved = placeholders.flatMap((edition) =>
          db
            .select({ status: s.userLibrary.status })
            .from(s.userLibrary)
            .where(and(eq(s.userLibrary.userId, userId), eq(s.userLibrary.bookId, edition.id)))
            .all(),
        );
        if (!shelved.length || hidesEdition(userId, editionId)) continue;
        // A row of the new edition the user has already is, as a rule, the one the acquisition or the
        // upload just wrote for its requester ("unread"): it takes the placeholder's status too. A
        // status of its own (listening, finished) is kept.
        db.insert(s.userLibrary)
          .values({ userId, bookId: editionId, status: shelved[0].status, addedAt: Date.now() })
          .onConflictDoUpdate({
            target: [s.userLibrary.userId, s.userLibrary.bookId],
            set: { status: shelved[0].status },
            setWhere: sql`${s.userLibrary.status}='unread'`,
          })
          .run();
        for (const edition of placeholders) removeUserLibraryRow(userId, edition.id);
      }
  })();
}

/** The marker in the administrator's settings that the shelf ebooks joined his library (#467, decision 6). */
export const SHELF_EBOOKS_JOINED = "shelfEbooksJoined";

/**
 * Once, at server start (#467, decision 6): every work with an ebook edition (an ebook set's
 * consensus text not counted) that is not in the administrator's library joins it through its
 * placeholder (`ensurePlaceholder`), unless he hid that placeholder. Only the placeholder's row is
 * written, so a recording he removed stays hidden, and Hardcover is not told anything. Other users
 * are left alone: the shared ebook shelf records no owner. A marker in his settings keeps a second
 * start from doing anything. Answers the works that joined.
 */
export function joinShelfEbooksOnce(): string[] {
  return sqlite.transaction((): string[] => {
    if (getUserSetting(ADMIN_USER_ID, SHELF_EBOOKS_JOINED)) return [];
    const workIds = sqlite
      .prepare(
        `SELECT DISTINCT work_id FROM ebook_editions WHERE substr(id,1,length(?))<>? ORDER BY rowid`,
      )
      .pluck()
      .all(CONSENSUS_EBOOK_PREFIX, CONSENSUS_EBOOK_PREFIX) as string[];
    const joined: string[] = [];
    for (const workId of workIds) {
      if (workInLibrary(ADMIN_USER_ID, workId)) continue;
      const placeholder = ensurePlaceholder(sqlite, workId);
      if (hidesEdition(ADMIN_USER_ID, placeholder)) continue;
      const addedAt = Date.now();
      db.insert(s.userLibrary)
        .values({ userId: ADMIN_USER_ID, bookId: placeholder, status: "unread", addedAt })
        .onConflictDoNothing()
        .run();
      setLibraryOrigin(ADMIN_USER_ID, workId, "manual", { addedAt });
      joined.push(workId);
    }
    setUserSetting(ADMIN_USER_ID, SHELF_EBOOKS_JOINED, String(Date.now()));
    return joined;
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
