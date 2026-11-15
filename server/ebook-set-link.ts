/**
 * A relink and the ebook set (#325 review round 2). An ebook-set member belongs to an ebook in a work: when the
 * ebook is linked to another work, its `pending` member in the work it leaves is removed in the same transaction as
 * the link change, so that work never shows a check that can no longer end. A member with any other status stays,
 * as on main. Only the database and schema are imported here, so `ebooks.ts` can use it without an import cycle.
 */
import { and, eq, ne } from "drizzle-orm";
import { db } from "./db.ts";
import * as s from "./schema.ts";

/**
 * Call inside the transaction that links `ebookId` to `workId`: removes its pending members in every other work.
 * Returns the works it left a pending member in.
 */
export function removePendingMembersLeftBehind(ebookId: string, workId: string) {
  const where = and(
    eq(s.workEbookSetMembers.ebookId, ebookId),
    eq(s.workEbookSetMembers.status, "pending"),
    ne(s.workEbookSetMembers.workId, workId),
  );
  const left = db.select({ workId: s.workEbookSetMembers.workId }).from(s.workEbookSetMembers).where(where).all();
  if (left.length) db.delete(s.workEbookSetMembers).where(where).run();
  return left.map((row) => row.workId);
}

/**
 * After members were removed from these works: brings each set up to date as after any member removal (the
 * consensus is synced). Never rejects: the link has been made, so a failure is logged and the next sync of the
 * work repairs it.
 */
export async function ebookSetMembersRemoved(workIds: string[]) {
  if (!workIds.length) return;
  const { syncEbookSetConsensus } = await import("./ebook-set-consensus.ts");
  for (const workId of workIds) {
    try {
      await syncEbookSetConsensus(workId);
    } catch (error) {
      console.warn(`The ebook set of ${workId} could not be updated after a member left it: ${(error as Error).message}`);
    }
  }
}
