import { isPaused } from "./activity-pause.ts";
import {
  existsSync,
  statSync,
  unlinkSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { parseFile } from "music-metadata";
import { audioParseOptions, normalizeChapters } from "./chapters.ts";
import { eq, inArray } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { mediaRoot, ensureMediaStorage } from "./storage.ts";
import { TorBoxError, torboxUrl } from "./services.ts";
import { queueHardcoverProgress } from "./hardcover.ts";
import { listUserIds } from "./users.ts";
import { audioFileExtension, audioFileMime, isCompleteMediaResponse } from "./media-response.ts";
const controllers = new Map<string, AbortController>();
let running = false;
// Waits before the 2nd, 3rd and 4th attempt at one file.
const retryDelays = () =>
  (process.env.SONDER_DOWNLOAD_RETRY_MS || "2000,5000,15000")
    .split(",")
    .map(Number);
function jobIsActive(recordingId: string) {
  const job = db
    .select({ status: s.serverDownloads.status })
    .from(s.serverDownloads)
    .where(eq(s.serverDownloads.recordingId, recordingId))
    .get();
  return job?.status === "queued" || job?.status === "downloading";
}
export function serverDownloadIsActive(recordingId: string) {
  return jobIsActive(recordingId);
}
export function hasServerMedia(track: typeof s.tracks.$inferSelect) {
  if (track.sourceType === "local" && existsSync(track.source)) return true;
  const copy = db
    .select()
    .from(s.mediaCopies)
    .where(eq(s.mediaCopies.trackId, track.id))
    .get();
  return (
    !!copy && existsSync(copy.path) && statSync(copy.path).size === copy.size
  );
}
export function requestServerDownload(bookId: string) {
  const book = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.id, bookId))
    .get();
  if (!book) throw new Error("This book could not be found.");
  const recording = db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.editionId, bookId))
    .get();
  if (!recording) throw new Error("This book has no recording.");
  if (
    !db
      .select()
      .from(s.tracks)
      .where(eq(s.tracks.recordingId, recording.id))
      .get()
  )
    throw new Error(
      "This book has no audio yet. Find an audiobook release before saving it to your server.",
    );
  ensureMediaStorage();
  const existing = db
    .select()
    .from(s.serverDownloads)
    .where(eq(s.serverDownloads.recordingId, recording.id))
    .get();
  const values = {
    recordingId: recording.id,
    bookId,
    status: "queued" as const,
    progress: existing?.progress || 0,
    error: null,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  db.insert(s.serverDownloads)
    .values(values)
    .onConflictDoUpdate({ target: s.serverDownloads.recordingId, set: values })
    .run();
  void processServerDownloads();
  return { ok: true };
}
export function pauseServerDownload(recordingId: string) {
  controllers.get(recordingId)?.abort();
  db.update(s.serverDownloads)
    .set({ status: "paused", updatedAt: Date.now() })
    .where(eq(s.serverDownloads.recordingId, recordingId))
    .run();
}
export function cancelServerDownload(recordingId: string) {
  controllers.get(recordingId)?.abort();
  db.delete(s.serverDownloads)
    .where(eq(s.serverDownloads.recordingId, recordingId))
    .run();
  // A paused, queued or failed copy has no running loop to clean up after it.
  removeRecordingParts(recordingId);
}
export async function waitUntilServerDownloadIdle(
  recordingId: string,
  timeoutMs = Number(process.env.SONDER_DOWNLOAD_IDLE_MS || 5000),
) {
  const start = Date.now();
  while (jobIsActive(recordingId)) {
    if (Date.now() - start > timeoutMs)
      throw new Error("A server download is still running.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
// Files of one book copied at the same time.
const concurrency = Math.max(
  1,
  Number(process.env.SONDER_DOWNLOAD_CONCURRENCY) || 3,
);
type Track = typeof s.tracks.$inferSelect;
// What the copy loop gives one file: abort, progress, and a last check that
// the book is still wanted before the file is committed.
type CopyHooks = {
  signal: AbortSignal;
  onBytes: (size: number, total: number) => void;
  beforeCommit: () => void;
};
// A failure a retry cannot fix, such as TorBox not being connected.
class PermanentCopyError extends Error {}
const savedDir = () => join(mediaRoot, "saved");
function savedPrefix(track: Track) {
  return join(savedDir(), createHash("sha256").update(track.id).digest("hex"));
}
// The part is named after the source too, so bytes from an older source
// (a re-linked torrent) are never continued with a different file.
function partPath(track: Track) {
  const source = createHash("sha256").update(track.source).digest("hex");
  return `${savedPrefix(track)}-${source.slice(0, 12)}.part`;
}
// Parts of this track other than `keep`, including the older naming.
function removeParts(track: Track, keep?: string) {
  const prefix = savedPrefix(track);
  const name = prefix.slice(savedDir().length + 1);
  if (!existsSync(savedDir())) return;
  for (const file of readdirSync(savedDir())) {
    const path = join(savedDir(), file);
    if (
      path !== keep &&
      file.startsWith(name) &&
      file.endsWith(".part")
    )
      unlinkSync(path);
  }
}
function fileSize(path: string) {
  return existsSync(path) ? statSync(path).size : 0;
}
function contentRange(response: Response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get("content-range") || "",
  );
  return match
    ? { first: Number(match[1]), last: Number(match[2]), total: Number(match[3]) }
    : null;
}
function contentRangeTotal(response: Response) {
  return Number(
    /\/(\d+)$/.exec(response.headers.get("content-range") || "")?.[1],
  ) || 0;
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
async function sourceUrl(track: Track, refreshLink: boolean) {
  if (track.sourceType !== "torbox") return track.source;
  const source = JSON.parse(track.source);
  try {
    return await torboxUrl(source.torrentId, source.fileId, refreshLink);
  } catch (error) {
    if (error instanceof TorBoxError ? error.retryable : error instanceof TypeError)
      throw error;
    throw new PermanentCopyError((error as Error).message);
  }
}
// Starts or continues one file. A part left by an interrupted attempt, a
// pause or an earlier run is continued with a range request; a source that
// ignores the range sends the whole file and the copy starts over.
async function fetchIntoPart(
  track: Track,
  temp: string,
  refreshLink: boolean,
  { signal, onBytes }: CopyHooks,
) {
  const url = await sourceUrl(track, refreshLink);
  const have = fileSize(temp);
  const response = await fetch(url, {
    headers: {
      "Accept-Encoding": "identity",
      ...(have ? { Range: `bytes=${have}-` } : {}),
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(24 * 3600000)]),
  });
  const range = contentRange(response);
  const resumed =
    have > 0 &&
    response.status === 206 &&
    range?.first === have &&
    range.last + 1 === range.total;
  // The part already holds the whole file.
  if (have > 0 && response.status === 416) {
    await response.body?.cancel().catch(() => {});
    if (contentRangeTotal(response) === have) return { size: have, type: null };
    unlinkSync(temp);
    throw new Error("The saved part of this file no longer matches the source.");
  }
  if (!response.body || (!resumed && !isCompleteMediaResponse(response))) {
    await response.body?.cancel().catch(() => {});
    // A range answer that does not run to the end cannot be continued:
    // start the file over on the next attempt.
    if (have > 0 && response.status === 206) unlinkSync(temp);
    throw new Error(
      "The full audio file could not be downloaded. Retry to continue from completed chapters.",
    );
  }
  const total = resumed
    ? range!.total
    : Number(response.headers.get("content-length")) ||
      contentRangeTotal(response);
  let size = resumed ? have : 0;
  // Written chunk by chunk, so whatever arrived before a cut-off is on disk
  // for the next attempt to continue from.
  const file = await open(temp, resumed ? "a" : "w", 0o640);
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      await file.write(chunk);
      size += chunk.byteLength;
      onBytes(size, total);
    }
  } finally {
    await file.close();
  }
  if (!size || (total && size !== total))
    throw new Error("The audio download was interrupted.");
  return { size, type: response.headers.get("content-type") };
}
async function copyTrack(track: Track, hooks: CopyHooks) {
  const { signal } = hooks;
  if (track.sourceType === "local")
    throw new Error("An original audio file is missing from the media drive.");
  ensureMediaStorage();
  const temp = partPath(track);
  // TorBox's CDN occasionally answers one request with an error or cuts it
  // short; retry with a fresh link, keeping what already arrived.
  let size = 0;
  let type: string | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      ({ size, type } = await fetchIntoPart(track, temp, attempt > 0, hooks));
      break;
    } catch (error) {
      if (
        signal.aborted ||
        error instanceof PermanentCopyError ||
        attempt >= retryDelays().length
      )
        throw error;
      await wait(retryDelays()[attempt], signal);
      ensureMediaStorage();
    }
  }
  const metadata = await parseFile(temp, audioParseOptions).catch(() => null);
  signal.throwIfAborted();
  if (!metadata?.format.codec) {
    // A corrupt part must not be continued on the next retry.
    if (existsSync(temp)) unlinkSync(temp);
    throw new Error("The source did not return a valid audio file.");
  }
  const mime = audioFileMime(temp) || type || "application/octet-stream";
  const path = savedPrefix(track) + audioFileExtension(mime);
  hooks.beforeCommit();
  renameSync(temp, path);
  removeParts(track);
  db.update(s.tracks)
    .set({
      duration: metadata.format.duration || track.duration,
      chapters: normalizeChapters(
        metadata.format.chapters,
        metadata.format.duration || 0,
      ),
    })
    .where(eq(s.tracks.id, track.id))
    .run();
  db.insert(s.mediaCopies)
    .values({ trackId: track.id, path, size, mime })
    .onConflictDoUpdate({
      target: s.mediaCopies.trackId,
      set: { path, size, mime },
    })
    .run();
}
function removeRecordingParts(recordingId: string) {
  for (const track of db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.recordingId, recordingId))
    .all())
    removeParts(track);
}
export async function processServerDownloads() {
  if (running) return;
  running = true;
  try {
    const jobs = db
      .select()
      .from(s.serverDownloads)
      .where(inArray(s.serverDownloads.status, ["queued", "downloading"]))
      .all();
    for (const job of jobs) {
      // The batch is a snapshot: skip jobs paused or removed since it was read.
      if (!jobIsActive(job.recordingId)) continue;
      // Paused: start no new copy. One already running finishes; the rest wait.
      if (isPaused("server-copies")) break;
      const ctrl = new AbortController();
      controllers.set(job.recordingId, ctrl);
      // Stops the other files of this book when one fails for good.
      const failed = new AbortController();
      const signal = AbortSignal.any([ctrl.signal, failed.signal]);
      try {
        ensureMediaStorage();
        const tracks = db
          .select()
          .from(s.tracks)
          .where(eq(s.tracks.recordingId, job.recordingId))
          .all()
          .sort((a, b) => a.index - b.index);
        if (!tracks.length) throw new Error("This book has no audio to save.");
        db.update(s.serverDownloads)
          .set({ status: "downloading", error: null, updatedAt: Date.now() })
          .where(eq(s.serverDownloads.recordingId, job.recordingId))
          .run();
        const fileProgress = new Map<string, number>();
        for (const t of tracks) if (hasServerMedia(t)) fileProgress.set(t.id, 1);
        let updated = 0;
        const report = (force = false) => {
          if (!force && Date.now() - updated < 1000) return;
          updated = Date.now();
          let sum = 0;
          for (const value of fileProgress.values()) sum += value;
          db.update(s.serverDownloads)
            .set({ progress: sum / tracks.length, updatedAt: Date.now() })
            .where(eq(s.serverDownloads.recordingId, job.recordingId))
            .run();
        };
        report(true);
        // Files are taken in chapter order, so the first chapters arrive first.
        const pending = tracks.filter((t) => !hasServerMedia(t));
        let firstError: unknown = null;
        const worker = async () => {
          for (let track = pending.shift(); track; track = pending.shift()) {
            if (signal.aborted) return;
            const id = track.id;
            try {
              await copyTrack(track, {
                signal,
                onBytes: (size, total) => {
                  fileProgress.set(id, total ? Math.min(0.999, size / total) : 0);
                  report();
                },
                // A book removed or paused since this file started is not
                // given another file.
                beforeCommit: () => {
                  if (!jobIsActive(job.recordingId)) ctrl.abort();
                  ctrl.signal.throwIfAborted();
                },
              });
              fileProgress.set(id, 1);
              report(true);
            } catch (error) {
              if (!signal.aborted) {
                firstError = error;
                failed.abort();
              }
              return;
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(concurrency, pending.length) }, worker),
        );
        if (firstError) throw firstError;
        ctrl.signal.throwIfAborted();
        if (!jobIsActive(job.recordingId)) continue;
        db.update(s.serverDownloads)
          .set({
            status: "ready",
            progress: 1,
            error: null,
            updatedAt: Date.now(),
          })
          .where(eq(s.serverDownloads.recordingId, job.recordingId))
          .run();
        for (const userId of listUserIds())
          queueHardcoverProgress(userId, job.recordingId);
      } catch (error) {
        // Cancelled: drop the partial files; a pause keeps them to continue.
        if (
          ctrl.signal.aborted &&
          !db
            .select()
            .from(s.serverDownloads)
            .where(eq(s.serverDownloads.recordingId, job.recordingId))
            .get()
        )
          removeRecordingParts(job.recordingId);
        if (!ctrl.signal.aborted)
          db.update(s.serverDownloads)
            .set({
              status: "error",
              error: (error as Error).message,
              updatedAt: Date.now(),
            })
            .where(eq(s.serverDownloads.recordingId, job.recordingId))
            .run();
      } finally {
        controllers.delete(job.recordingId);
      }
    }
  } finally {
    running = false;
  }
}
export function stopServerDownloads() {
  for (const ctrl of controllers.values()) ctrl.abort();
}
/**
 * Server copies keep their own status words (`queued`, `downloading`, `paused`, `ready`,
 * `error`); the download list shows them next to acquisitions, so a queued copy reads
 * as `preparing` there. This is the only translation between the two vocabularies.
 */
export function copyStatusInDownloadList(status: string) {
  return status === "queued" ? "preparing" : status;
}
export function listServerDownloads() {
  return db
    .select()
    .from(s.serverDownloads)
    .all()
    .map((job) => {
      const edition = db
        .select()
        .from(s.editions)
        .where(eq(s.editions.id, job.bookId))
        .get()!;
      const work = db
        .select()
        .from(s.works)
        .where(eq(s.works.id, edition.workId))
        .get()!;
      return {
        id: `copy-${job.recordingId}`,
        hash: job.recordingId,
        backend: "copy" as const,
        title: work.title,
        author: work.author,
        cover: edition.cover,
        status: copyStatusInDownloadList(job.status),
        progress: job.progress,
        error: job.error,
        bookId: job.bookId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    });
}
