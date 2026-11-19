/*
 * A recording for a new book (#576; spec #572 "What the server answers and accepts", decided in #470): Discover's
 * "Search for a recording" opens the Get sheet without a book, and the recording the administrator chooses makes the
 * book at once. `POST /api/discover/abb/add` and `POST /api/discover/prowlarr/add` with `makeWork: true` and no
 * `workId` come here: a work from the release's title, author and cover, its placeholder (`ensurePlaceholder`, #555),
 * a row in the requester's library (`addWorkToLibrary`), then the acquisition with that `workId`, which the answer
 * carries. The import of the finished download replaces the placeholder (`claimWorkAudio` in `createBook`).
 *
 * Two cases do not make a work:
 * - The torrent is already on its way or in (an acquisition with its hash that did not fail): its own book is the
 *   one, as `acquire` answers that acquisition. The work it is for (or the work of the edition it made) joins the
 *   requester's library and the answer carries it. One on its way for no work gets the new work.
 * - The acquisition is refused (`acquire` throws): the work made for it is removed again, so a refused recording
 *   leaves no empty book behind and a second try makes only one.
 */
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { acquire, magnetHash } from "./acquisitions.ts";
import { ensurePlaceholder, placeholderEditionSql } from "./placeholder-edition.ts";
import { addWorkToLibrary, workInLibrary } from "./work-library.ts";

export type NewBookRelease = { title: string; author?: string | null; cover?: string | null };

type Acquisition = typeof s.acquisitions.$inferSelect;

const UNKNOWN_AUTHOR = "Unknown author";

/** Makes the work for a release, with its placeholder (the release's cover when it is an https address). */
export function makeWorkFromRelease(release: NewBookRelease): string {
  const workId = `work-${randomUUID()}`;
  sqlite.transaction(() => {
    db.insert(s.works)
      .values({
        id: workId,
        title: release.title.trim() || "A new audiobook",
        author: release.author?.trim() || UNKNOWN_AUTHOR,
        description: "",
        genre: "Audiobook",
        year: new Date().getFullYear(),
      })
      .run();
    ensurePlaceholder(sqlite, workId, { cover: release.cover });
  })();
  return workId;
}

/**
 * Removes a work `makeWorkFromRelease` made, when nothing but its placeholder hangs off it: no real audio, no ebook.
 * Every row it wrote goes (the library rows, the hidden entries and library origins of every user, the media
 * states), and an acquisition for it no longer names it.
 */
export function removeMadeWork(workId: string) {
  sqlite.transaction(() => {
    const editions = sqlite.prepare("SELECT id FROM audio_editions WHERE work_id=?").pluck().all(workId) as string[];
    const real = sqlite
      .prepare(`SELECT 1 FROM audio_editions e WHERE e.work_id=? AND NOT ${placeholderEditionSql("e.id")} LIMIT 1`)
      .get(workId);
    const ebook = sqlite.prepare("SELECT 1 FROM ebook_editions WHERE work_id=? LIMIT 1").get(workId);
    if (real || ebook) return;
    for (const id of editions) {
      sqlite.prepare("DELETE FROM user_library WHERE book_id=?").run(id);
      sqlite.prepare("DELETE FROM user_hidden_library WHERE book_id=?").run(id);
      sqlite.prepare("DELETE FROM recordings WHERE edition_id=?").run(id);
      sqlite.prepare("DELETE FROM audio_editions WHERE id=?").run(id);
    }
    sqlite.prepare("DELETE FROM user_work_library_origin WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM user_want_to_read WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM work_media_states WHERE work_id=?").run(workId);
    sqlite.prepare("UPDATE acquisitions SET work_id=NULL WHERE work_id=?").run(workId);
    // Its catalogue link and match outcome (#721) go with it.
    sqlite.prepare("DELETE FROM work_catalogue_links WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM work_catalogue_duplicates WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM work_catalogue_match WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM works WHERE id=?").run(workId);
  })();
}

/** The work of a torrent already on its way or in: the one it is for, else the work of the edition it made. */
function workOfAcquisition(job: Acquisition): string | null {
  if (job.workId && db.select({ id: s.works.id }).from(s.works).where(eq(s.works.id, job.workId)).get()) return job.workId;
  if (job.bookId)
    return db.select({ workId: s.editions.workId }).from(s.editions).where(eq(s.editions.id, job.bookId)).get()?.workId ?? null;
  return null;
}

/**
 * Gets the recording `magnet` for a new book made from `release`, for `userId` (the administrator: the routes are
 * his). Answers the acquisition with the `workId` of its book.
 */
export async function acquireForNewBook(
  magnet: string,
  release: NewBookRelease & { language?: string | null; narrator?: string | null },
  userId: number,
  acquireFn: typeof acquire = acquire,
): Promise<Acquisition & { workId: string }> {
  const hash = magnetHash(magnet);
  const existing = db
    .select()
    .from(s.acquisitions)
    .where(and(eq(s.acquisitions.hash, hash), ne(s.acquisitions.status, "error")))
    .get();
  const known = existing ? workOfAcquisition(existing) : null;
  if (existing && known) {
    if (!workInLibrary(userId, known)) addWorkToLibrary(userId, known);
    // `acquire` answers the acquisition there is and links it to the requester.
    const job = await acquireFn(magnet, { title: release.title, userId });
    return { ...job, workId: known };
  }
  const workId = makeWorkFromRelease(release);
  addWorkToLibrary(userId, workId);
  // A torrent on its way for no book: the new book is the one it is for.
  if (existing) db.update(s.acquisitions).set({ workId }).where(eq(s.acquisitions.id, existing.id)).run();
  let job: Acquisition;
  try {
    job = await acquireFn(magnet, {
      title: release.title,
      author: release.author ?? undefined,
      cover: release.cover ?? undefined,
      language: release.language,
      narrator: release.narrator,
      workId,
      userId,
    });
  } catch (error) {
    removeMadeWork(workId);
    throw error;
  }
  // Left in `error` without a throw (its first refresh failed): the client refuses it, so no book stays either.
  if (job.status === "error") removeMadeWork(workId);
  return { ...job, workId };
}
