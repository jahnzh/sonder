import { isPaused } from "./activity-pause.ts";
import {
  createWriteStream,
  existsSync,
  statSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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
        for (let i = 0; i < tracks.length; i++) {
          ctrl.signal.throwIfAborted();
          const t = tracks[i];
          if (hasServerMedia(t)) {
            db.update(s.serverDownloads)
              .set({ progress: (i + 1) / tracks.length, updatedAt: Date.now() })
              .where(eq(s.serverDownloads.recordingId, job.recordingId))
              .run();
            continue;
          }
          ensureMediaStorage();
          let url = t.source;
          if (t.sourceType === "torbox") {
            const source = JSON.parse(t.source);
            url = await torboxUrl(source.torrentId, source.fileId);
          }
          if (t.sourceType === "local")
            throw new Error(
              "An original audio file is missing from the media drive.",
            );
          const response = await fetch(url, {
            headers: { "Accept-Encoding": "identity" },
            signal: AbortSignal.any([
              ctrl.signal,
              AbortSignal.timeout(24 * 3600000),
            ]),
          });
          if (!isCompleteMediaResponse(response) || !response.body)
            throw new Error(
              "The full audio file could not be downloaded. Retry to continue from completed chapters.",
            );
          const expected =
            Number(response.headers.get("content-length")) ||
            Number(
              /\/(\d+)$/.exec(response.headers.get("content-range") || "")?.[1],
            ) ||
            0;
          const pathPrefix = join(
            mediaRoot,
            "saved",
            createHash("sha256").update(t.id).digest("hex"),
          );
          const temp = pathPrefix + ".part";
          if (existsSync(temp)) unlinkSync(temp);
          const writer = createWriteStream(temp, { flags: "wx", mode: 0o640 });
          let size = 0;
          let updated = 0;
          try {
            const counter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                size += chunk.byteLength;
                if (Date.now() - updated > 1000) {
                  db.update(s.serverDownloads)
                    .set({
                      progress:
                        (i +
                          (expected ? Math.min(0.999, size / expected) : 0)) /
                        tracks.length,
                      updatedAt: Date.now(),
                    })
                    .where(eq(s.serverDownloads.recordingId, job.recordingId))
                    .run();
                  updated = Date.now();
                }
                callback(null, chunk);
              },
            });
            await pipeline(
              Readable.fromWeb(
                response.body as import("node:stream/web").ReadableStream,
              ),
              counter,
              writer,
              { signal: ctrl.signal },
            );
            ctrl.signal.throwIfAborted();
            if (!size || (expected && size !== expected))
              throw new Error("The audio download was interrupted.");
            const metadata = await parseFile(temp, audioParseOptions);
            ctrl.signal.throwIfAborted();
            if (!metadata.format.codec)
              throw new Error("The source did not return a valid audio file.");
            const mime = audioFileMime(temp) || response.headers.get("content-type") || "application/octet-stream";
            const path = pathPrefix + audioFileExtension(mime);
            if (!jobIsActive(job.recordingId)) ctrl.abort();
            ctrl.signal.throwIfAborted();
            renameSync(temp, path);
            db.update(s.tracks)
              .set({
                duration: metadata.format.duration || t.duration,
                chapters: normalizeChapters(
                  metadata.format.chapters,
                  metadata.format.duration || 0,
                ),
              })
              .where(eq(s.tracks.id, t.id))
              .run();
            db.insert(s.mediaCopies)
              .values({ trackId: t.id, path, size, mime })
              .onConflictDoUpdate({
                target: s.mediaCopies.trackId,
                set: { path, size, mime },
              })
              .run();
          } catch (error) {
            writer.destroy();
            if (existsSync(temp)) unlinkSync(temp);
            throw error;
          }
        }
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
