// Series packs (ADR 0027, #899): one acquisition that serves several books. This module records which books a pack
// serves, and at import makes each book its own audio edition, recording and tracks from only its files. The split
// itself is `series-pack.ts`; the queue's and the Get sheet's choice of a pack is `series-pack-step.ts`.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { parseFile } from "music-metadata";
import { audioParseOptions, normalizeChapters, type Chapter } from "./chapters.ts";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { ownCover } from "../src/types.ts";
import { claimWorkAudio } from "./work-library.ts";
import { bareVolumeTitle } from "./series-audio.ts";
import { packUnits, splitPack, type PackFile, type PackUnit, type PackVolume } from "./series-pack.ts";

type Acquisition = typeof s.acquisitions.$inferSelect;
type PackWork = typeof s.acquisitionWorks.$inferSelect;

/** A book a pack is asked to serve. */
export type PackBook = { workId: string; position: number | null; title: string; cover?: string | null };
/** What makes an acquisition a pack: its series, the volumes it covers and the books it serves. */
export type PackRequest = { seriesId: string; seriesName: string; volumes: PackVolume[]; works: PackBook[] };
/** A pack's audio file as stored at import: for a local torrent with its absolute path. */
export type StoredPackFile = PackFile & { path?: string };

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch (error) {
    // A row written by hand that is not JSON reads as empty.
    void (error as Error).message;
    return fallback;
  }
}

export function packOf(acquisitionId: string) {
  return db.select().from(s.acquisitionPacks).where(eq(s.acquisitionPacks.acquisitionId, acquisitionId)).get();
}

export function isPackAcquisition(acquisitionId: string) {
  return !!packOf(acquisitionId);
}

export function packWorks(acquisitionId: string): PackWork[] {
  return db.select().from(s.acquisitionWorks).where(eq(s.acquisitionWorks.acquisitionId, acquisitionId)).all();
}

export function packVolumes(acquisitionId: string): PackVolume[] {
  return parseJson<PackVolume[]>(packOf(acquisitionId)?.volumes, []);
}

export function packFiles(acquisitionId: string): StoredPackFile[] | null {
  const files = packOf(acquisitionId)?.files;
  return files ? parseJson<StoredPackFile[]>(files, []) : null;
}

/** The volume of a pack a book is, by its title, for a book asked for without its position (an older client's add). */
function positionByTitle(volumes: PackVolume[], title: string, seriesName: string) {
  const key = bareVolumeTitle(title, seriesName);
  return volumes.find((volume) => bareVolumeTitle(volume.title, seriesName) === key)?.position ?? null;
}

/**
 * Make the acquisition a pack (if it is not one yet) and add the books it serves; a book it serves already keeps its
 * row. The pack's volumes gain any the request names that it did not have. Returns the books added.
 */
export function recordPack(acquisitionId: string, pack: PackRequest) {
  const now = Date.now();
  return sqlite.transaction(() => {
    const existing = packOf(acquisitionId);
    const volumes = existing ? parseJson<PackVolume[]>(existing.volumes, []) : [];
    for (const volume of pack.volumes)
      if (!volumes.some((known) => known.position === volume.position)) volumes.push(volume);
    volumes.sort((a, b) => a.position - b.position);
    if (existing)
      db.update(s.acquisitionPacks).set({ volumes: JSON.stringify(volumes) }).where(eq(s.acquisitionPacks.acquisitionId, acquisitionId)).run();
    else
      db.insert(s.acquisitionPacks)
        .values({ acquisitionId, seriesId: pack.seriesId, seriesName: pack.seriesName, volumes: JSON.stringify(volumes), createdAt: now })
        .run();
    const seriesName = existing?.seriesName ?? pack.seriesName;
    const added: string[] = [];
    for (const book of pack.works) {
      const inserted = db
        .insert(s.acquisitionWorks)
        .values({
          acquisitionId,
          workId: book.workId,
          position: book.position ?? positionByTitle(volumes, book.title, seriesName),
          title: book.title,
          cover: book.cover ?? null,
          status: "waiting",
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      if (inserted.changes) added.push(book.workId);
    }
    return added;
  })();
}

/** The audio edition a pack makes for a book: the acquisition's own id with the work's short hash. */
export function packEditionId(job: Pick<Acquisition, "backend" | "remoteId" | "hash">, workId: string) {
  const base = job.backend === "torbox" ? `torbox-${job.remoteId}` : `local-${job.hash}`;
  return `${base}-${createHash("sha1").update(workId).digest("hex").slice(0, 10)}`;
}

type PackTrack = { title: string; duration: number; chapters?: Chapter[]; source: string; sourceType: "local" | "torbox" };

/** Thrown when a book's files cannot be read as audio: the book is left for the owner to choose. */
export class PackFilesError extends Error {}

async function tracksOf(job: Acquisition, files: StoredPackFile[]): Promise<PackTrack[]> {
  if (job.backend === "torbox")
    return files.map((file) => ({
      title: file.name.split("/").pop() || "Chapter",
      duration: 0,
      source: JSON.stringify({ torrentId: Number(job.remoteId), fileId: Number(file.key) }),
      sourceType: "torbox" as const,
    }));
  const tracks: PackTrack[] = [];
  for (const file of files) {
    if (!file.path) throw new PackFilesError("A file of this pack has no place on the server.");
    let meta;
    try {
      meta = await parseFile(file.path, audioParseOptions);
    } catch (error) {
      throw new PackFilesError(`A file of this pack could not be read as audio (${(error as Error).message}).`);
    }
    if (!meta.format.codec) throw new PackFilesError("A file of this pack is not valid audio.");
    tracks.push({
      title: meta.common.title || file.name.split("/").pop() || "Chapter",
      duration: meta.format.duration || 0,
      chapters: normalizeChapters(meta.format.chapters, meta.format.duration || 0),
      source: file.path,
      sourceType: "local",
    });
  }
  return tracks;
}

/**
 * Make a book of a pack its own audio edition, recording and tracks from the given files of the pack (never copied),
 * put it in the library of every user of the acquisition, and mark the book's row ready. A book that has its
 * edition already keeps it. Returns the edition's id.
 */
export async function makePackBook(job: Acquisition, workId: string, files: StoredPackFile[]) {
  const row = db
    .select()
    .from(s.acquisitionWorks)
    .where(and(eq(s.acquisitionWorks.acquisitionId, job.id), eq(s.acquisitionWorks.workId, workId)))
    .get();
  if (!row) throw new Error("This book is not in the pack.");
  if (!files.length) throw new PackFilesError("Choose at least one file of the pack.");
  const tracks = await tracksOf(job, files);
  const id = packEditionId(job, workId);
  const recordingId = `recording-${id}`;
  sqlite.transaction(() => {
    if (!db.select().from(s.editions).where(eq(s.editions.id, id)).get()) {
      db.insert(s.editions)
        .values({
          id,
          workId,
          cover: ownCover(row.cover?.startsWith("https://") ? row.cover : "", id),
          narrator: job.narrator || "Unknown narrator",
          language: job.language,
          releaseTitle: job.title,
          rating: 0,
          sourceLabel: job.backend === "local" ? "Your server · HDD" : "TorBox · Cached",
        })
        .run();
      db.insert(s.recordings).values({ id: recordingId, editionId: id }).run();
      tracks.forEach((track, index) =>
        db.insert(s.tracks).values({ ...track, id: `${id}-${index}`, recordingId, index }).run(),
      );
    }
    for (const { userId } of db.select().from(s.userAcquisitions).where(eq(s.userAcquisitions.acquisitionId, job.id)).all()) {
      db.delete(s.userHiddenLibrary).where(and(eq(s.userHiddenLibrary.userId, userId), eq(s.userHiddenLibrary.bookId, id))).run();
      db.insert(s.userLibrary).values({ userId, bookId: id, status: "unread", addedAt: Date.now() }).onConflictDoNothing().run();
    }
    claimWorkAudio(workId, id);
    db.update(s.acquisitionWorks)
      .set({ status: "ready", files: JSON.stringify(files.map((file) => file.key)), bookId: id, updatedAt: Date.now() })
      .where(and(eq(s.acquisitionWorks.acquisitionId, job.id), eq(s.acquisitionWorks.workId, workId)))
      .run();
  })();
  return id;
}

function markChoose(acquisitionId: string, workId: string) {
  db.update(s.acquisitionWorks)
    .set({ status: "choose", updatedAt: Date.now() })
    .where(and(eq(s.acquisitionWorks.acquisitionId, acquisitionId), eq(s.acquisitionWorks.workId, workId)))
    .run();
}

/**
 * Split the pack's stored files (`splitPack`) for every book still waiting and make the recording of each book the
 * split is certain of; a book it is not certain of, or whose files are not audio, waits for the owner's choice.
 */
export async function assignWaitingPackWorks(acquisitionId: string) {
  const job = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, acquisitionId)).get();
  const pack = packOf(acquisitionId);
  const files = packFiles(acquisitionId);
  if (!job || !pack || !files) return;
  const waiting = packWorks(acquisitionId).filter((row) => row.status === "waiting");
  if (!waiting.length) return;
  const split = splitPack(files, parseJson<PackVolume[]>(pack.volumes, []), pack.seriesName);
  const byKey = new Map(files.map((file) => [file.key, file]));
  for (const row of waiting) {
    const keys = row.position === null ? undefined : split.books.get(row.position);
    if (!keys?.length) {
      markChoose(acquisitionId, row.workId);
      continue;
    }
    try {
      await makePackBook(job, row.workId, keys.flatMap((key) => byKey.get(key) ?? []));
    } catch (error) {
      if (!(error instanceof PackFilesError)) throw error;
      markChoose(acquisitionId, row.workId);
    }
  }
}

/**
 * The pack is downloaded: store its audio files and split them into the books it serves. Returns the edition to
 * record as the acquisition's book: the one of the book it was chosen for, else the first made, else null.
 */
export async function importPack(job: Acquisition, files: StoredPackFile[]) {
  db.update(s.acquisitionPacks).set({ files: JSON.stringify(files) }).where(eq(s.acquisitionPacks.acquisitionId, job.id)).run();
  await assignWaitingPackWorks(job.id);
  const rows = packWorks(job.id).filter((row) => row.bookId);
  return rows.find((row) => row.workId === job.workId)?.bookId ?? rows[0]?.bookId ?? null;
}

/** What a book's chooser shows: a pack waiting for the owner to say which of its files are the book. */
export type PackChoice = { acquisitionId: string; title: string; units: (Omit<PackUnit, "files"> & { files: number })[] };

/** The packs of the user's that hold the work but could not tell which of their files it is. */
export function packChoicesForWork(userId: number, workId: string): PackChoice[] {
  const rows = sqlite
    .prepare(
      `SELECT w.acquisition_id AS acquisitionId, a.title FROM acquisition_works w
         JOIN acquisitions a ON a.id = w.acquisition_id
         JOIN user_acquisitions u ON u.acquisition_id = a.id AND u.user_id = ?
        WHERE w.work_id = ? AND w.status = 'choose'
        ORDER BY w.updated_at DESC`,
    )
    .all(userId, workId) as { acquisitionId: string; title: string }[];
  return rows.flatMap((row) => {
    const files = packFiles(row.acquisitionId);
    const pack = packOf(row.acquisitionId);
    if (!files?.length || !pack) return [];
    const split = splitPack(files, parseJson<PackVolume[]>(pack.volumes, []), pack.seriesName);
    return [{ acquisitionId: row.acquisitionId, title: row.title, units: split.units.map((unit) => ({ ...unit, files: unit.files.length })) }];
  });
}

/**
 * The owner chose which units of a pack are the book (`POST /api/works/:id/pack`): its recording is made from their
 * files. Refused when the pack does not wait for this book's choice or a unit is not the pack's.
 */
export async function choosePackFiles(userId: number, workId: string, acquisitionId: string, unitKeys: string[]) {
  const row = db
    .select()
    .from(s.acquisitionWorks)
    .where(and(eq(s.acquisitionWorks.acquisitionId, acquisitionId), eq(s.acquisitionWorks.workId, workId)))
    .get();
  const attached = db
    .select()
    .from(s.userAcquisitions)
    .where(and(eq(s.userAcquisitions.userId, userId), eq(s.userAcquisitions.acquisitionId, acquisitionId)))
    .get();
  if (!row || !attached || row.status !== "choose")
    throw Object.assign(new Error("This pack is not waiting for this book's files."), { statusCode: 409 });
  const job = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, acquisitionId)).get()!;
  const files = packFiles(acquisitionId) ?? [];
  const units = packUnits(files);
  const chosen = [...new Set(unitKeys)];
  if (!chosen.length || chosen.some((key) => !units.some((unit) => unit.key === key)))
    throw Object.assign(new Error("Choose files of this pack."), { statusCode: 400 });
  const keys = new Set(units.filter((unit) => chosen.includes(unit.key)).flatMap((unit) => unit.files));
  try {
    return await makePackBook(job, workId, files.filter((file) => keys.has(file.key)));
  } catch (error) {
    if (error instanceof PackFilesError) throw Object.assign(error, { statusCode: 422 });
    throw error;
  }
}

/** Statuses of a pack another book may still join: on its way or done. */
const JOINABLE = ["checking", "preparing", "downloading", "paused", "ready"] as const;

/**
 * A pack of the series that covers the volume and another book may join (ADR 0027 "Sharing"): on its way or done,
 * a done one first, then the newest.
 */
export function packCovering(seriesId: string, position: number) {
  const rows = sqlite
    .prepare(
      `SELECT a.id, a.status, p.volumes FROM acquisition_packs p JOIN acquisitions a ON a.id = p.acquisition_id
        WHERE p.series_id = ? AND a.status IN (SELECT value FROM json_each(?))
        ORDER BY a.status = 'ready' DESC, a.updated_at DESC`,
    )
    .all(seriesId, JSON.stringify(JOINABLE)) as { id: string; status: string; volumes: string }[];
  return rows.find((row) => parseJson<PackVolume[]>(row.volumes, []).some((volume) => volume.position === position)) ?? null;
}

/**
 * A book joins a pack that holds it: no second download. The user is attached to the acquisition; a pack that is
 * done makes the book's recording at once from its stored files.
 */
export async function joinPack(acquisitionId: string, userId: number, book: PackBook) {
  const pack = packOf(acquisitionId);
  if (!pack) throw new Error("This download is not a pack.");
  recordPack(acquisitionId, { seriesId: pack.seriesId, seriesName: pack.seriesName, volumes: [], works: [book] });
  db.insert(s.userAcquisitions).values({ userId, acquisitionId }).onConflictDoNothing().run();
  return settleJoinedBooks(acquisitionId, userId, [book.workId]);
}

/**
 * After books joined a pack: a done pack makes the recordings of the books still waiting, and a book whose recording
 * the pack made already is put (back) in the user's library, out of its hidden list, as a plain download's is.
 */
export async function settleJoinedBooks(acquisitionId: string, userId: number, workIds: string[]) {
  const job = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, acquisitionId)).get();
  if (job?.status === "ready") await assignWaitingPackWorks(acquisitionId);
  for (const row of packWorks(acquisitionId)) {
    if (!row.bookId || !workIds.includes(row.workId)) continue;
    db.delete(s.userHiddenLibrary).where(and(eq(s.userHiddenLibrary.userId, userId), eq(s.userHiddenLibrary.bookId, row.bookId))).run();
    db.insert(s.userLibrary).values({ userId, bookId: row.bookId, status: "unread", addedAt: Date.now() }).onConflictDoNothing().run();
  }
  return job;
}

/**
 * A book leaves one pack: its row goes. A pack that still serves another book takes another of its books as
 * `work_id` when it was this one; a pack with no book left is a plain acquisition again (its pack row goes), and the
 * local paths of all its audio files are returned as `leftovers`, which no book uses any more.
 */
export function leavePack(acquisitionId: string, workId: string) {
  db.delete(s.acquisitionWorks).where(and(eq(s.acquisitionWorks.acquisitionId, acquisitionId), eq(s.acquisitionWorks.workId, workId))).run();
  const rest = packWorks(acquisitionId);
  if (!rest.length) {
    const leftovers = (packFiles(acquisitionId) ?? []).flatMap((file) => (file.path ? [file.path] : []));
    db.delete(s.acquisitionPacks).where(eq(s.acquisitionPacks.acquisitionId, acquisitionId)).run();
    return { remaining: 0, leftovers };
  }
  const job = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, acquisitionId)).get();
  if (job?.workId === workId) db.update(s.acquisitions).set({ workId: rest[0].workId }).where(eq(s.acquisitions.id, acquisitionId)).run();
  return { remaining: rest.length, leftovers: [] as string[] };
}

/**
 * The work is removed from the user's library (`series-removal.ts`): it leaves every pack that served it
 * (`leavePack`). Returns the local paths of the audio files of the packs it was the last book of.
 */
export function leavePacks(workId: string) {
  const ids = db
    .select({ id: s.acquisitionWorks.acquisitionId })
    .from(s.acquisitionWorks)
    .where(eq(s.acquisitionWorks.workId, workId))
    .all()
    .map((row) => row.id);
  return { leftovers: ids.flatMap((id) => leavePack(id, workId).leftovers) };
}

/** Whether a local path (as given, or its real path) is a file of a pack a book still uses: has its recording from, or waits for. */
export function pathOfUsedPack(path: string) {
  const packs = db.select().from(s.acquisitionPacks).all();
  for (const pack of packs) {
    const same = (file: StoredPackFile) => !!file.path && (file.path === path || (existsSync(file.path) && realpathSync(file.path) === path));
    if (!pack.files || !parseJson<StoredPackFile[]>(pack.files, []).some(same)) continue;
    const rows = packWorks(pack.acquisitionId);
    if (rows.some((row) => row.status !== "ready" || (row.bookId && db.select().from(s.editions).where(eq(s.editions.id, row.bookId)).get())))
      return true;
  }
  return false;
}
