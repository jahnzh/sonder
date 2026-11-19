// What is left of Hardcover (#721 part d): its tables stay, unused, for one release (they are dropped after). Two
// reads of them remain: the `hardcover` block of `GET /api/books` and of a library work (pinned for older builds),
// and the rule that a placeholder made from one user's Hardcover shelf or list is hidden from the others. Nothing
// here calls Hardcover or writes to its tables; the removed routes answer 410 (`hardcover-routes.ts`) and the one-time
// switch is `hardcover-switch.ts`.
import { and, eq, inArray } from "drizzle-orm";
import { ADMIN_USER_ID } from "./users.ts";
import { db, sqlite } from "./db.ts";
import { placeholderEditionSql } from "./placeholder-edition.ts";
import * as s from "./schema.ts";

const T = {
  links: s.userHardcoverLinks,
  outbox: s.userHardcoverOutbox,
  progress: s.userHardcoverProgress,
  lists: s.userHardcoverLists,
  reads: s.userHardcoverReads,
};
function isAdminUser(userId: number) {
  const role = (
    sqlite.prepare("SELECT role FROM users WHERE id=?").get(userId) as
      | { role: string }
      | undefined
  )?.role;
  return userId === ADMIN_USER_ID || role === "admin";
}
export function hardcoverForWork(userId: number, workId: string) {
  return hardcoverForWorks(userId, [workId]).get(workId);
}
/** The Hardcover block of `GET /api/books` (`hardcoverForWork`) for many works, one query per table. */
export function hardcoverForWorks(userId: number, workIds: string[]) {
  return hardcoverBlocks(userId, db.select().from(s.hardcoverLinks).where(inArray(s.hardcoverLinks.workId, workIds)).all());
}
/**
 * The Hardcover block for links of works to Hardcover books, by work id: the stored links of
 * `hardcoverForWorks`, or the link a book not on the server will get (ADR 0022).
 */
export function hardcoverBlocks(
  userId: number,
  links: { workId: string; bookId: number; slug: string | null; series: HardcoverBlock["series"] }[],
) {
  const blocks = new Map<string, HardcoverBlock>();
  if (!links.length) return blocks;
  const bookIds = [...new Set(links.map((link) => link.bookId))];
  const byBook = <Row extends { bookId: number }>(rows: Row[]) => {
    const found = new Map<number, Row>();
    for (const row of rows) if (!found.has(row.bookId)) found.set(row.bookId, row);
    return found;
  };
  const pending = byBook(db.select().from(T.outbox).where(and(eq(T.outbox.userId, userId), inArray(T.outbox.bookId, bookIds))).all());
  const queued = byBook(db.select().from(T.progress).where(and(eq(T.progress.userId, userId), inArray(T.progress.bookId, bookIds))).all());
  const shelves = byBook(db.select().from(T.links).where(and(eq(T.links.userId, userId), inArray(T.links.bookId, bookIds))).all());
  const reads = byBook(
    db.select({ bookId: T.reads.bookId, fraction: T.reads.fraction }).from(T.reads)
      .where(and(eq(T.reads.userId, userId), inArray(T.reads.bookId, bookIds))).all(),
  );
  const lists = db.select().from(T.lists).where(eq(T.lists.userId, userId)).all();
  for (const link of links) {
    const job = pending.get(link.bookId);
    const progress = queued.get(link.bookId);
    blocks.set(link.workId, {
      id: link.bookId,
      slug: link.slug,
      series: link.series,
      statusId: job?.statusId ?? shelves.get(link.bookId)?.statusId ?? null,
      pending: !!job,
      progressFraction: progress
        ? progress.position / progress.duration
        : (reads.get(link.bookId)?.fraction ?? null),
      progressPending: !!progress,
      syncError: job?.error || progress?.error || null,
      listIds: lists.filter((l) => l.members.some((m) => m.bookId === link.bookId)).map((l) => l.id),
    });
  }
  return blocks;
}
type HardcoverBlock = {
  id: number;
  slug: string | null;
  series: { id?: number; name: string; position: number | null }[];
  statusId: number | null;
  pending: boolean;
  progressFraction: number | null;
  progressPending: boolean;
  syncError: string | null;
  listIds: number[];
};
// Metadata-only placeholders come from one user's Hardcover shelves and lists, so
// they're only listed for users who have that book themselves, and for admins (r6#1).
// Returns the placeholder edition ids `userId` must not see in the catalogue.
export function hiddenHardcoverPlaceholders(userId: number): Set<string> {
  if (isAdminUser(userId)) return new Set();
  const placeholders = sqlite
    .prepare(
      `SELECT e.id, l.book_id AS bookId FROM audio_editions e
       LEFT JOIN hardcover_links l ON l.work_id=e.work_id
       WHERE ${placeholderEditionSql("e.id")}`,
    )
    .all() as { id: string; bookId: number | null }[];
  if (!placeholders.length) return new Set();
  const library = new Set(
    db
      .select()
      .from(s.userLibrary)
      .where(eq(s.userLibrary.userId, userId))
      .all()
      .map((row) => row.bookId),
  );
  const books = new Set<number>([
    ...db
      .select()
      .from(T.links)
      .where(eq(T.links.userId, userId))
      .all()
      .map((row) => row.bookId),
    ...db
      .select()
      .from(T.lists)
      .where(eq(T.lists.userId, userId))
      .all()
      .flatMap((list) => list.members.map((m) => m.bookId)),
  ]);
  return new Set(
    placeholders
      .filter(
        (p) => !library.has(p.id) && (p.bookId === null || !books.has(p.bookId)),
      )
      .map((p) => p.id),
  );
}
