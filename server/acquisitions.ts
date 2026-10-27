import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { parseFile } from "music-metadata";
import { normalizeChapters, type Chapter } from "./chapters.ts";
import { db, sqlite } from "./db.ts";
import { hardcoverWorkForMedia, claimHardcoverAudio } from "./hardcover.ts";
import * as s from "./schema.ts";
import { getSecret, torbox } from "./services.ts";
import { addTorrent, getTorrent, transmission } from "./transmission.ts";
import {
  ensureMediaStorage,
  resolveTorrentFile,
  torrentDownloadDir,
} from "./storage.ts";
const audioPattern = /\.(m4b|m4a|mp3|ogg|flac|opus|wav)$/i;
export function magnetHash(magnet: string) {
  const url = new URL(magnet);
  if (url.protocol !== "magnet:") throw new Error("Enter a valid magnet link.");
  const xt = url.searchParams.getAll("xt").find((v) => /^urn:btih:/i.test(v));
  const value = xt?.slice(9) || "";
  if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(value)) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0,
      buffer = 0;
    const bytes: number[] = [];
    for (const char of value.toUpperCase()) {
      buffer = (buffer << 5) | chars.indexOf(char);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 255);
      }
    }
    return Buffer.from(bytes).toString("hex");
  }
  throw new Error("This magnet link needs a valid BitTorrent v1 info hash.");
}
export function isHashCached(data: unknown, hash: string) {
  const values = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? Object.values(data)
      : [];
  return values.some(
    (item) =>
      item &&
      typeof item === "object" &&
      "hash" in item &&
      String(item.hash).toLowerCase() === hash.toLowerCase(),
  );
}
export async function chooseBackend(
  hash: string,
  configured: boolean,
  check: (hash: string) => Promise<unknown>,
): Promise<"torbox" | "local"> {
  if (!configured) return "local";
  try {
    return isHashCached(await check(hash), hash) ? "torbox" : "local";
  } catch {
    return "local";
  }
}
type Acquisition = typeof s.acquisitions.$inferSelect;
export async function acquire(
  magnet: string,
  metadata: {
    title?: string;
    author?: string;
    cover?: string;
    workId?: string;
    language?: string | null;
    narrator?: string | null;
  } = {},
) {
  if (
    metadata.workId &&
    !db.select().from(s.works).where(eq(s.works.id, metadata.workId)).get()
  )
    throw new Error("The selected book could not be found.");
  const hash = magnetHash(magnet);
  const existing = db
    .select()
    .from(s.acquisitions)
    .where(eq(s.acquisitions.hash, hash))
    .get();
  if (existing && existing.status !== "error") return existing;
  ensureMediaStorage();
  const id = existing?.id || randomUUID();
  const title =
    metadata.title ||
    new URL(magnet).searchParams.get("dn") ||
    "A new audiobook";
  const entry = {
    id,
    hash,
    magnet,
    backend: "local",
    remoteId: null,
    title,
    author: metadata.author || "Unknown author",
    cover: metadata.cover?.startsWith("https://")
      ? metadata.cover
      : "/covers/time.svg",
    workId: metadata.workId || null,
    language: metadata.language || null,
    narrator: metadata.narrator || null,
    status: "checking",
    progress: 0,
    error: null,
    bookId: null,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  db.insert(s.acquisitions)
    .values(entry)
    .onConflictDoUpdate({ target: s.acquisitions.hash, set: entry })
    .run();
  try {
    let backend = await chooseBackend(hash, !!getSecret("torbox"), (h) =>
      torbox(`torrents/checkcached?hash=${h}&format=list&list_files=false`),
    );
    if (backend === "torbox") {
      try {
        const form = new FormData();
        form.set("magnet", magnet);
        form.set("add_only_if_cached", "true");
        form.set("allow_zip", "false");
        const data = (await torbox("torrents/createtorrent", {
          method: "POST",
          body: form,
        })) as { torrent_id?: number };
        if (data.torrent_id === undefined || data.torrent_id === null)
          throw new Error("The cached torrent is not ready.");
        db.update(s.acquisitions)
          .set({
            backend: "torbox",
            remoteId: String(data.torrent_id),
            status: "preparing",
            updatedAt: Date.now(),
          })
          .where(eq(s.acquisitions.id, id))
          .run();
      } catch {
        backend = "local";
      }
    }
    if (backend === "local") {
      const session = await transmission<{
        "download-dir": string;
        "incomplete-dir": string;
        "incomplete-dir-enabled": boolean;
      }>("session-get");
      // Refuse an SSD incomplete directory, including when a shared client was configured accidentally.
      const root = torrentDownloadDir.replace(/\/complete\/?$/, "");
      if (
        session["incomplete-dir-enabled"] &&
        !session["incomplete-dir"].startsWith(root + "/")
      )
        throw new Error(
          "The torrent client’s incomplete folder must be on the media drive. Configure the dedicated Sonder queue.",
        );
      const torrent = await addTorrent(magnet, torrentDownloadDir);
      db.update(s.acquisitions)
        .set({
          backend: "local",
          remoteId: torrent.hashString,
          status: "downloading",
          updatedAt: Date.now(),
        })
        .where(eq(s.acquisitions.id, id))
        .run();
    }
    await refreshAcquisition(id);
    return db
      .select()
      .from(s.acquisitions)
      .where(eq(s.acquisitions.id, id))
      .get()!;
  } catch (error) {
    db.update(s.acquisitions)
      .set({
        status: "error",
        error: (error as Error).message,
        updatedAt: Date.now(),
      })
      .where(eq(s.acquisitions.id, id))
      .run();
    throw error;
  }
}
function createBook(
  job: Acquisition,
  files: {
    id: string;
    title: string;
    duration: number;
    chapters?: Chapter[];
    source: string;
    sourceType: "local" | "torbox";
  }[],
) {
  const id =
    job.backend === "torbox" ? `torbox-${job.remoteId}` : `local-${job.hash}`;
  const workId =
    job.workId || hardcoverWorkForMedia(job.title, job.author) || `work-${id}`;
  sqlite.transaction(() => {
    if (!db.select().from(s.editions).where(eq(s.editions.id, id)).get()) {
      db.insert(s.works)
        .values({
          id: workId,
          title: job.title,
          author: job.author,
          description:
            job.backend === "local"
              ? "Downloaded to your home server."
              : "Available from your TorBox cache.",
          genre: "Audiobook",
          year: new Date().getFullYear(),
        })
        .onConflictDoNothing()
        .run();
      db.insert(s.editions)
        .values({
          id,
          workId,
          cover: job.cover,
          narrator: job.narrator || "Unknown narrator",
          language: job.language,
          releaseTitle: job.title,
          rating: 0,
          sourceLabel:
            job.backend === "local" ? "Your server · HDD" : "TorBox · Cached",
        })
        .run();
      db.insert(s.recordings)
        .values({ id: `recording-${id}`, editionId: id })
        .run();
      files.forEach((f, index) =>
        db
          .insert(s.tracks)
          .values({ ...f, recordingId: `recording-${id}`, index })
          .run(),
      );
    }
    db.delete(s.hiddenLibrary).where(eq(s.hiddenLibrary.bookId, id)).run();
    db.insert(s.library)
      .values({ bookId: id, status: "unread", addedAt: Date.now() })
      .onConflictDoNothing()
      .run();
    claimHardcoverAudio(workId, id);
    db.update(s.acquisitions)
      .set({
        status: "ready",
        progress: 1,
        error: null,
        bookId: id,
        updatedAt: Date.now(),
      })
      .where(eq(s.acquisitions.id, job.id))
      .run();
  })();
}
const processing = new Set<string>();
export async function refreshAcquisition(id: string) {
  if (processing.has(id)) return;
  processing.add(id);
  try {
    const job = db
      .select()
      .from(s.acquisitions)
      .where(eq(s.acquisitions.id, id))
      .get();
    if (
      !job ||
      job.status === "ready" ||
      job.status === "error" ||
      job.status === "checking"
    )
      return;
    if (job.backend === "local") {
      const torrent = await getTorrent(job.hash);
      if (!torrent) {
        db.update(s.acquisitions)
          .set({
            status: "error",
            error:
              "This torrent is no longer in the local queue. Retry to add it again.",
            updatedAt: Date.now(),
          })
          .where(eq(s.acquisitions.id, id))
          .run();
        return;
      }
      if (torrent.error) {
        db.update(s.acquisitions)
          .set({
            error:
              torrent.errorString ||
              "The torrent client reported a download error.",
            updatedAt: Date.now(),
          })
          .where(eq(s.acquisitions.id, id))
          .run();
        return;
      }
      db.update(s.acquisitions)
        .set({
          status: torrent.status === 0 ? "paused" : "downloading",
          progress: torrent.percentDone,
          error: null,
          updatedAt: Date.now(),
        })
        .where(eq(s.acquisitions.id, id))
        .run();
      const files = torrent.files
        .map((file, index) => ({
          ...file,
          wanted: torrent.fileStats[index]?.wanted !== false,
        }))
        .filter((f) => audioPattern.test(f.name) && f.wanted)
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        );
      // Transmission preallocates files. Their existence and on-disk length alone never prove completion.
      if (
        !files.length ||
        files.some((f) => f.bytesCompleted < f.length) ||
        torrent.percentDone < 1
      )
        return;
      const ready = [];
      for (const file of files) {
        const path = resolveTorrentFile(torrent.downloadDir, file.name);
        if (!existsSync(path) || statSync(path).size !== file.length) return;
        let meta;
        try {
          meta = await parseFile(path, {
            duration: true,
            includeChapters: true,
            skipCovers: true,
          });
        } catch {
          throw new Error(
            "A completed torrent file could not be read as audio.",
          );
        }
        if (!meta.format.codec)
          throw new Error("This torrent contains an invalid audio file.");
        ready.push({
          id: `local-${job.hash}-${ready.length}`,
          title: meta.common.title || file.name.split("/").pop() || "Chapter",
          duration: meta.format.duration || 0,
          chapters: normalizeChapters(
            meta.format.chapters,
            meta.format.duration || 0,
          ),
          source: path,
          sourceType: "local" as const,
        });
      }
      createBook(job, ready);
    } else {
      const torrent = (await torbox(`torrents/mylist?id=${job.remoteId}`)) as {
        download_present?: boolean;
        files?: { id: number; name: string; short_name?: string }[];
      };
      if (!torrent.download_present) return;
      const files = (torrent.files || [])
        .filter((f) => audioPattern.test(f.name))
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        );
      if (!files.length)
        throw new Error("This torrent contains no supported audio files.");
      createBook(
        job,
        files.map((f) => ({
          id: `torbox-${job.remoteId}-${f.id}`,
          title: f.short_name || f.name.split("/").pop() || "Chapter",
          duration: 0,
          source: JSON.stringify({
            torrentId: Number(job.remoteId),
            fileId: f.id,
          }),
          sourceType: "torbox" as const,
        })),
      );
    }
  } catch (error) {
    db.update(s.acquisitions)
      .set({ error: (error as Error).message, updatedAt: Date.now() })
      .where(eq(s.acquisitions.id, id))
      .run();
  } finally {
    processing.delete(id);
  }
}
export async function refreshQueue() {
  const jobs = db
    .select()
    .from(s.acquisitions)
    .where(
      inArray(s.acquisitions.status, [
        "checking",
        "preparing",
        "downloading",
        "paused",
      ]),
    )
    .all();
  for (const job of jobs) {
    if (job.status === "checking") {
      if (Date.now() - job.updatedAt < 60000) continue; // A restart may have interrupted source selection. Stable hashes make retrying idempotent.
      try {
        db.update(s.acquisitions)
          .set({ status: "error" })
          .where(eq(s.acquisitions.id, job.id))
          .run();
        await acquire(job.magnet, {
          title: job.title,
          author: job.author,
          cover: job.cover,
          workId: job.workId || undefined,
          language: job.language,
          narrator: job.narrator,
        });
      } catch {}
    } else await refreshAcquisition(job.id);
  }
}
