import { isPaused } from "./activity-pause.ts";
import {
  existsSync,
  statSync,
  unlinkSync,
  renameSync,
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
import { torboxUrl } from "./services.ts";
import { queueHardcoverProgress } from "./hardcover.ts";
import { listUserIds } from "./users.ts";
import { audioFileExtension, audioFileMime, isCompleteMediaResponse } from "./media-response.ts";
const controllers = new Map<string, AbortController>();
let running = false;
// Waits before the 2nd, 3rd and 4th attempt at one file.
const retryDelays = (process.env.SONDER_DOWNLOAD_RETRY_MS || "2000,5000,15000")
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
    status: "queued",
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
function partialPath(track: Track) {
  return join(
    mediaRoot,
    "saved",
    createHash("sha256").update(track.id).digest("hex"),
  );
}
function fileSize(path: string) {
  return existsSync(path) ? statSync(path).size : 0;
}
// Starts or continues one file. A `.part` left by an interrupted attempt,
// a pause or an earlier run is continued with a range request; a source that
// ignores the range sends the whole file and the copy starts over.
async function fetchIntoPart(
  track: Track,
  temp: string,
  refreshLink: boolean,
  signal: AbortSignal,
  onBytes: (size: number, total: number) => void,
) {
  let url = track.source;
  if (track.sourceType === "torbox") {
    const source = JSON.parse(track.source);
    url = await torboxUrl(source.torrentId, source.fileId, refreshLink);
  }
  const have = fileSize(temp);
  const response = await fetch(url, {
    headers: {
      "Accept-Encoding": "identity",
      ...(have ? { Range: `bytes=${have}-` } : {}),
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(24 * 3600000)]),
  });
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get("content-range") || "",
  );
  const resumed =
    have > 0 &&
    response.status === 206 &&
    !!range &&
    Number(range[1]) === have &&
    Number(range[2]) + 1 === Number(range[3]);
  // The part already holds the whole file.
  if (have > 0 && response.status === 416) {
    await response.body?.cancel().catch(() => {});
    const total = Number(
      /\/(\d+)$/.exec(response.headers.get("content-range") || "")?.[1],
    );
    if (total === have) return { size: have, type: null };
    unlinkSync(temp);
    throw new Error("The saved part of this file no longer matches the source.");
  }
  if (!response.body || (!resumed && !isCompleteMediaResponse(response))) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      "The full audio file could not be downloaded. Retry to continue from completed chapters.",
    );
  }
  const total = resumed
    ? Number(range![3])
    : Number(response.headers.get("content-length")) ||
      Number(
        /\/(\d+)$/.exec(response.headers.get("content-range") || "")?.[1],
      ) ||
      0;
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
async function copyTrack(
  track: Track,
  signal: AbortSignal,
  onBytes: (size: number, total: number) => void,
) {
  if (track.sourceType === "local")
    throw new Error("An original audio file is missing from the media drive.");
  const pathPrefix = partialPath(track);
  const temp = pathPrefix + ".part";
  // TorBox's CDN occasionally answers one request with an error or cuts it
  // short; retry with a fresh link, keeping what already arrived.
  let size = 0;
  let type: string | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      ensureMediaStorage();
      ({ size, type } = await fetchIntoPart(
        track,
        temp,
        attempt > 0,
        signal,
        onBytes,
      ));
      break;
    } catch (error) {
      if (signal.aborted || attempt >= retryDelays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      signal.throwIfAborted();
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
  const path = pathPrefix + audioFileExtension(mime);
  renameSync(temp, path);
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
        const share = new Map<string, number>();
        for (const t of tracks) if (hasServerMedia(t)) share.set(t.id, 1);
        let updated = 0;
        const report = (force = false) => {
          if (!force && Date.now() - updated < 1000) return;
          updated = Date.now();
          let sum = 0;
          for (const v of share.values()) sum += v;
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
          for (let t = pending.shift(); t; t = pending.shift()) {
            if (signal.aborted) return;
            const track = t;
            try {
              await copyTrack(track, signal, (size, total) => {
                share.set(track.id, total ? Math.min(0.999, size / total) : 0);
                report();
              });
              share.set(track.id, 1);
              report(true);
            } catch (error) {
              if (!signal.aborted) {
                firstError = error;
                failed.abort();
              }
              return;
            }
            if (!jobIsActive(job.recordingId)) ctrl.abort();
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
          for (const t of db
            .select()
            .from(s.tracks)
            .where(eq(s.tracks.recordingId, job.recordingId))
            .all()) {
            const temp = partialPath(t) + ".part";
            if (existsSync(temp)) unlinkSync(temp);
          }
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
        status: job.status === "queued" ? "preparing" : job.status,
        progress: job.progress,
        error: job.error,
        bookId: job.bookId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    });
}
