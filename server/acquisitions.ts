import { isPaused } from "./activity-pause.ts";
import type { BackgroundProcess } from "./background-runner.ts";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { parseFile } from "music-metadata";
import { audioParseOptions, normalizeChapters, type Chapter } from "./chapters.ts";
import { db, sqlite } from "./db.ts";
import { matchedWorkForMedia } from "./same-book.ts";
import { claimWorkAudio } from "./work-library.ts";
import * as s from "./schema.ts";
import { getSecret, torbox } from "./services.ts";
import { ownCover } from "../src/types.ts";
import { addTorrent, getTorrent, removeTorrent, transmission } from "./transmission.ts";
import { getTorrentHealth } from "./torrent-health.ts";
import { audioPattern } from "./preview-file.ts";
import { getWorkMediaState, trackWorkMediaState } from "./work-media-state.ts";
import {
  ACTIVE_ACQUISITION_STATUSES,
  isActiveAcquisitionStatus,
  isFinishedAcquisitionStatus,
  setAcquisitionStatus,
  startAcquisitionRecord,
} from "./acquisition-status.ts";
import {
  ensureMediaStorage,
  resolveTorrentFile,
  torrentDownloadDir,
} from "./storage.ts";
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
export type AcquireRoute = "torbox-cached" | "torbox-uncached" | "local";
export async function chooseBackend(
  hash: string,
  configured: boolean,
  check: (hash: string) => Promise<unknown>,
): Promise<AcquireRoute> {
  if (!configured) return "local";
  try {
    return isHashCached(await check(hash), hash)
      ? "torbox-cached"
      : "torbox-uncached";
  } catch {
    // Cache check failed; still try an uncached TorBox take-job before local.
    return "torbox-uncached";
  }
}
/** The torrent a preview of this release put on the TorBox account (#889, `torbox_previews`), or null. */
function previewedTorrentId(hash: string): number | null {
  const row = sqlite
    .prepare("SELECT torrent_id FROM torbox_previews WHERE hash=? ORDER BY created_at DESC LIMIT 1")
    .get(hash) as { torrent_id: number } | undefined;
  return row?.torrent_id ?? null;
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
    userId?: number;
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
  // A failed or cancelled download of the same torrent starts again; any other is joined.
  if (existing && existing.status !== "error" && existing.status !== "cancelled") {
    db.insert(s.userAcquisitions).values({ userId: metadata.userId ?? 1, acquisitionId: existing.id }).onConflictDoNothing().run();
    if (existing.bookId) {
      db.delete(s.userHiddenLibrary).where(and(eq(s.userHiddenLibrary.userId, metadata.userId ?? 1), eq(s.userHiddenLibrary.bookId, existing.bookId))).run();
      db.insert(s.userLibrary).values({userId: metadata.userId ?? 1, bookId: existing.bookId, status: "unread", addedAt: Date.now()}).onConflictDoNothing().run();
    }
    return existing;
  }
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
    // No cover of its own is "" (#763): never a sample book's.
    cover: metadata.cover?.startsWith("https://") ? metadata.cover : "",
    workId: metadata.workId || null,
    language: metadata.language || null,
    narrator: metadata.narrator || null,
    progress: 0,
    error: null,
    bookId: null,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  startAcquisitionRecord(entry);
  db.insert(s.userAcquisitions).values({userId: metadata.userId ?? 1, acquisitionId: id}).onConflictDoNothing().run();
  try {
    const route = await chooseBackend(hash, !!getSecret("torbox"), (h) =>
      torbox(`torrents/checkcached?hash=${h}&format=list&list_files=false`),
    );
    let backend: "torbox" | "local" = route === "local" ? "local" : "torbox";
    if (backend === "torbox") {
      try {
        const form = new FormData();
        form.set("magnet", magnet);
        // Cache hits stay cache-only; misses ask TorBox to download the torrent.
        form.set(
          "add_only_if_cached",
          route === "torbox-cached" ? "true" : "false",
        );
        form.set("allow_zip", "false");
        const data = (await torbox("torrents/createtorrent", {
          method: "POST",
          body: form,
        })) as { torrent_id?: number };
        if (data.torrent_id === undefined || data.torrent_id === null)
          throw new Error(
            route === "torbox-cached"
              ? "The cached torrent is not ready."
              : "TorBox did not accept this torrent.",
          );
        setAcquisitionStatus(id, "preparing", {
          backend: "torbox",
          remoteId: String(data.torrent_id),
          updatedAt: Date.now(),
        });
      } catch {
        // A preview put this cached release on the account (#889): Get takes that one if TorBox will not add it again.
        const previewed = route === "torbox-cached" ? previewedTorrentId(hash) : null;
        if (previewed === null) backend = "local";
        else
          setAcquisitionStatus(id, "preparing", {
            backend: "torbox",
            remoteId: String(previewed),
            updatedAt: Date.now(),
          });
      }
    }
    if (backend === "local") {
      // Refuse rather than queue a torrent that cannot download, e.g. when the VPN has no DNS.
      const health = await getTorrentHealth(15_000);
      if (health.status !== "ok") {
        console.warn(
          `Local torrent fallback refused for ${hash}: ${health.status} (${health.message})`,
        );
        throw new Error(health.message);
      }
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
      setAcquisitionStatus(id, "downloading", {
        backend: "local",
        remoteId: torrent.hashString,
        updatedAt: Date.now(),
      });
    }
    await refreshAcquisition(id);
    return db
      .select()
      .from(s.acquisitions)
      .where(eq(s.acquisitions.id, id))
      .get()!;
  } catch (error) {
    setAcquisitionStatus(id, "error", {
      error: (error as Error).message,
      updatedAt: Date.now(),
    });
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
    job.workId || matchedWorkForMedia(job.title, job.author) || `work-${id}`;
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
          // An acquisition stored by an older build may hold a sample book's cover: read as none (#763).
          cover: ownCover(job.cover, id),
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
    for (const {userId} of db.select().from(s.userAcquisitions).where(eq(s.userAcquisitions.acquisitionId, job.id)).all()) {
      db.delete(s.userHiddenLibrary).where(and(eq(s.userHiddenLibrary.userId, userId), eq(s.userHiddenLibrary.bookId, id))).run();
      db.insert(s.userLibrary).values({ userId, bookId: id, status: "unread", addedAt: Date.now() }).onConflictDoNothing().run();
    }
    claimWorkAudio(workId, id);
    setAcquisitionStatus(job.id, "ready", {
      progress: 1,
      error: null,
      bookId: id,
      updatedAt: Date.now(),
    });
  })();
}
const processing = new Set<string>();
// Completed files that fail validation won't change on the next refresh, so these end the job.
class InvalidTorrentError extends Error {}
export async function refreshAcquisition(id: string) {
  if (processing.has(id)) return;
  processing.add(id);
  try {
    const job = db
      .select()
      .from(s.acquisitions)
      .where(eq(s.acquisitions.id, id))
      .get();
    if (!job || isFinishedAcquisitionStatus(job.status) || job.status === "checking")
      return;
    if (job.backend === "local") {
      const torrent = await getTorrent(job.hash);
      if (!torrent) {
        setAcquisitionStatus(id, "error", {
          error:
            "This torrent is no longer in the local queue. Retry to add it again.",
          updatedAt: Date.now(),
        });
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
      setAcquisitionStatus(id, torrent.status === 0 ? "paused" : "downloading", {
        progress: torrent.percentDone,
        error: null,
        updatedAt: Date.now(),
      });
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
          meta = await parseFile(path, audioParseOptions);
        } catch {
          throw new InvalidTorrentError(
            "A completed torrent file could not be read as audio.",
          );
        }
        if (!meta.format.codec)
          throw new InvalidTorrentError("This torrent contains an invalid audio file.");
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
        throw new InvalidTorrentError("This torrent contains no supported audio files.");
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
    const fields = { error: (error as Error).message, updatedAt: Date.now() };
    if (error instanceof InvalidTorrentError) setAcquisitionStatus(id, "error", fields);
    else
      db.update(s.acquisitions)
        .set(fields)
        .where(eq(s.acquisitions.id, id))
        .run();
  } finally {
    processing.delete(id);
  }
}
export async function refreshQueue() {
  // Paused: downloads are not checked or imported. The torrents keep running in the client.
  if (isPaused("acquisitions")) return;
  const jobs = db
    .select()
    .from(s.acquisitions)
    .where(
      inArray(s.acquisitions.status, [...ACTIVE_ACQUISITION_STATUSES]),
    )
    .all();
  for (const job of jobs) {
    if (job.status === "checking") {
      if (Date.now() - job.updatedAt < 60000) continue; // A restart may have interrupted source selection. Stable hashes make retrying idempotent.
      try {
        setAcquisitionStatus(job.id, "error");
        const owner = db.select().from(s.userAcquisitions).where(eq(s.userAcquisitions.acquisitionId, job.id)).get();
        if (!owner) continue;
        await acquire(job.magnet, {
          title: job.title,
          author: job.author,
          cover: job.cover,
          workId: job.workId || undefined,
          language: job.language,
          narrator: job.narrator,
          userId: owner.userId,
        });
      } catch {}
    } else await refreshAcquisition(job.id);
  }
}

export type AcquisitionControl = "pause" | "resume" | "retry";

/**
 * Pause, resume or retry an acquisition (the control route without HTTP). Retry marks the
 * acquisition failed and starts it again for `userId`; pause and resume act on the local
 * torrent client and move the status between `paused` and `downloading`.
 */
export async function controlAcquisition(
  id: string,
  action: AcquisitionControl,
  userId: number,
  deps: {
    transmission?: typeof transmission;
    acquire?: typeof acquire;
  } = {},
) {
  const job = db
    .select()
    .from(s.acquisitions)
    .where(eq(s.acquisitions.id, id))
    .get();
  if (!job) throw new Error("This download could not be found.");
  if (action === "retry") {
    setAcquisitionStatus(id, "error");
    return (deps.acquire ?? acquire)(job.magnet, {
      title: job.title,
      author: job.author,
      cover: job.cover,
      workId: job.workId || undefined,
      language: job.language,
      narrator: job.narrator,
      userId,
    });
  }
  if (job.backend !== "local" || job.status === "ready")
    throw new Error("Only active local downloads can be paused or resumed.");
  await (deps.transmission ?? transmission)(
    action === "pause" ? "torrent-stop" : "torrent-start",
    { ids: [job.hash] },
  );
  setAcquisitionStatus(id, action === "pause" ? "paused" : "downloading", {
    error: null,
    updatedAt: Date.now(),
  });
  return { ok: true };
}

/** Statuses a download can be cancelled in (#716): on its way or failed; not while it looks for a source, not once done. */
export const CANCELLABLE_ACQUISITION_STATUSES = ["preparing", "downloading", "paused", "error"] as const;

/**
 * Cancel a download (#716): stop and remove its torrent in the local client with its partial data, then mark it
 * `cancelled`, so the queue neither checks nor imports it again. Nothing else is touched: the work's other recordings,
 * its library rows and every listening position stay. A TorBox download has no local torrent; it is only marked. When
 * the client cannot remove the torrent the download is left as it was and the client's reason is thrown.
 */
export async function cancelAcquisition(
  id: string,
  deps: { removeTorrent?: (hash: string) => Promise<void>; waitMs?: number } = {},
) {
  // A refresh of this download in flight would write its status after ours: wait for it, then hold the next one off.
  const until = Date.now() + (deps.waitMs ?? 5000);
  while (processing.has(id)) {
    if (Date.now() > until) throw Object.assign(new Error("This download is being checked. Try again in a moment."), { statusCode: 409 });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  processing.add(id);
  try {
    const job = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get();
    if (!job) throw Object.assign(new Error("This download could not be found."), { statusCode: 404 });
    if (!(CANCELLABLE_ACQUISITION_STATUSES as readonly string[]).includes(job.status))
      throw Object.assign(
        new Error(job.status === "ready" ? "This download is finished; its recording stays." : job.status === "cancelled" ? "This download is already cancelled." : "This download is still finding a source."),
        { statusCode: 409 },
      );
    const local = job.backend !== "torbox";
    if (local) {
      try {
        await (deps.removeTorrent ?? removeTorrent)(job.hash);
      } catch (error) {
        // The torrent is still in the client: the download stays as it was, and the client's reason is the answer.
        throw Object.assign(new Error((error as Error).message), { statusCode: 502, cause: error });
      }
    }
    setAcquisitionStatus(id, "cancelled", { error: null, updatedAt: Date.now() });
    return { ok: true, removed: local };
  } finally {
    processing.delete(id);
  }
}

/** The download queue loop (ADR 0010): checks the torrents every 10 s and imports the finished ones. */
export const acquisitionsLoop: BackgroundProcess = {
  id: "acquisitions",
  intervalMs: 10_000,
  runAtStart: true,
  pausedBy: "acquisitions",
  tick: refreshQueue,
};

/** The error a replaced download of the user's own is marked with (spec #600, "Replacing the download on its way"). */
export const REPLACED_ERROR = "Replaced by a new recording.";

/**
 * The user's download for the work that is still on its way: the acquisition behind the work's media state while it
 * is queued (ADR 0011), or null. A work with playable audio is never queued, so a second recording replaces nothing.
 */
export function activeWorkAcquisition(userId: number, workId: string) {
  const state = getWorkMediaState(userId, workId);
  if (state?.state !== "queued" || !state.acquisitionId) return null;
  const job = db
    .select()
    .from(s.acquisitions)
    .where(eq(s.acquisitions.id, state.acquisitionId))
    .get();
  if (!job || !isActiveAcquisitionStatus(job.status)) return null;
  return job;
}

export type ReplacePreviousResult =
  | { action: "skipped_same_hash" }
  | { action: "stopped_local" }
  | { action: "detached_shared" }
  | { action: "detached_torbox"; note: string };

/** Detach or stop the caller's previous acquisition after a new one has started. */
export async function replacePreviousAcquisition(
  userId: number,
  previousAcquisitionId: string,
  newMagnet: string,
): Promise<ReplacePreviousResult> {
  const previous = db
    .select()
    .from(s.acquisitions)
    .where(eq(s.acquisitions.id, previousAcquisitionId))
    .get();
  if (!previous) return { action: "skipped_same_hash" };
  const newHash = magnetHash(newMagnet);
  if (previous.hash === newHash) return { action: "skipped_same_hash" };

  const users = db
    .select()
    .from(s.userAcquisitions)
    .where(eq(s.userAcquisitions.acquisitionId, previousAcquisitionId))
    .all();
  const shared =
    users.length !== 1 ||
    users[0].userId !== userId ||
    users.some((row) => row.userId !== userId);

  if (shared) {
    db.delete(s.userAcquisitions)
      .where(
        and(
          eq(s.userAcquisitions.userId, userId),
          eq(s.userAcquisitions.acquisitionId, previousAcquisitionId),
        ),
      )
      .run();
    if (previous.workId) trackWorkMediaState(userId, previous.workId);
    return { action: "detached_shared" };
  }

  if (previous.backend === "torbox") {
    db.delete(s.userAcquisitions)
      .where(
        and(
          eq(s.userAcquisitions.userId, userId),
          eq(s.userAcquisitions.acquisitionId, previousAcquisitionId),
        ),
      )
      .run();
    return {
      action: "detached_torbox",
      note:
        "The previous TorBox download was not cancelled upstream; this account no longer tracks it.",
    };
  }

  db.delete(s.userAcquisitions)
    .where(
      and(
        eq(s.userAcquisitions.userId, userId),
        eq(s.userAcquisitions.acquisitionId, previousAcquisitionId),
      ),
    )
    .run();
  if (!isFinishedAcquisitionStatus(previous.status)) {
    try {
      await transmission("torrent-stop", { ids: [previous.hash] });
    } catch (error) {
      // Best effort: the acquisition is marked replaced whatever the client says; the refresh loop skips it.
      console.warn(`Stopping replaced torrent ${previous.hash} failed: ${(error as Error).message}`);
    }
  }
  setAcquisitionStatus(previousAcquisitionId, "error", {
    error: REPLACED_ERROR,
    updatedAt: Date.now(),
  });
  return { action: "stopped_local" };
}

/**
 * Get a recording for a work and, when asked to (`replaceActive`), replace the user's download for that work that is
 * still on its way: the new acquisition starts first, then the previous one is replaced. Without the flag, without a
 * work or without a download on its way this is `acquire` as it is. The answer gains `replaced` (the action) only when
 * something was replaced; an answer in `error` replaces nothing.
 */
export async function acquireReplacing(
  magnet: string,
  metadata: Parameters<typeof acquire>[1] & { replaceActive?: boolean },
  acquireFn: typeof acquire = acquire,
): Promise<Acquisition & { replaced?: Exclude<ReplacePreviousResult["action"], "skipped_same_hash"> }> {
  const { replaceActive, ...rest } = metadata;
  const userId = rest.userId ?? 1;
  const previous = replaceActive && rest.workId ? activeWorkAcquisition(userId, rest.workId) : null;
  const job = await acquireFn(magnet, rest);
  if (!previous || job.status === "error") return job;
  const result = await replacePreviousAcquisition(userId, previous.id, magnet);
  return result.action === "skipped_same_hash" ? job : { ...job, replaced: result.action };
}
