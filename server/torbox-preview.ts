// A preview of a recording cached on TorBox, before Get (#889; issue comment "Design discussion, 24 Nov 2026").
//
// Start: the candidate's magnet (resolved as Get resolves it) names a release; it is put on the TorBox account only
// when TorBox has it cached (`add_only_if_cached`), or found there already; one file is chosen (`previewFile`) and a
// record kept in `torbox_previews`. The client gets the record's id and nothing else: the bytes route takes TorBox's
// address on the server from that record, never from the client. A preview makes no library row, recording,
// acquisition, track or listening position, and Activity never lists it.
//
// End (the sheet closing, another candidate previewed, or 30 minutes after it was made, by the loop): the release is
// removed from TorBox only when this preview put it there, no other live preview uses it, and nothing of the library
// (an acquisition, an edition or recording, a track's stored source) names its hash or torrent id. Otherwise only
// the record goes. A removal TorBox refuses leaves the record ended, and the loop tries again.
//
// Get of a previewed release gives the records up (`keepPreviewedRelease`): the release stays on TorBox for Get.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { BackgroundProcess } from "./background-runner.ts";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { getSecret, torbox, torboxUrl } from "./services.ts";
import { magnetHash } from "./acquisitions.ts";
import { previewFile, type ReleaseFile } from "./preview-file.ts";

/** A preview ends by itself this long after it was made: a closed tab reports nothing. */
export const PREVIEW_LIFETIME_MS = 30 * 60_000;

export type PreviewRecord = typeof s.torboxPreviews.$inferSelect;

type TorBoxTorrent = { id?: number; hash?: string; download_present?: boolean; files?: (ReleaseFile & { short_name?: string })[] };

export type PreviewDeps = {
  /** TorBox's API (`torbox` in services.ts); tests answer it with a stubbed fetch. */
  torbox?: typeof torbox;
  now?: () => number;
  /** The wait between reads of a release TorBox has just put on the account. */
  wait?: (ms: number) => Promise<unknown>;
};

const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export function previewRecord(id: string): PreviewRecord | undefined {
  return db.select().from(s.torboxPreviews).where(eq(s.torboxPreviews.id, id)).get();
}

/** The release on the TorBox account with this hash, or null. */
async function onAccount(hash: string, api: typeof torbox): Promise<TorBoxTorrent | null> {
  const list = await api("torrents/mylist");
  const torrents = (Array.isArray(list) ? list : []) as TorBoxTorrent[];
  return torrents.find((torrent) => String(torrent.hash ?? "").toLowerCase() === hash) ?? null;
}

/** The release's files once TorBox has it ready; a release just put on the account may take a moment. */
async function releaseFiles(torrentId: number, api: typeof torbox, wait: NonNullable<PreviewDeps["wait"]>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const torrent = (await api(`torrents/mylist?id=${torrentId}`)) as TorBoxTorrent;
    if (torrent?.download_present && torrent.files?.length) return torrent.files;
    await wait(1000);
  }
  throw fail("TorBox did not make this release ready to play.", 502);
}

/**
 * Start a preview of the release the magnet names, for `userId`. Answers the record's id; refuses (409) when TorBox
 * is not connected, (422) when the release has no audio file, and passes TorBox's own refusal on (a release that is
 * not cached is refused by `add_only_if_cached`).
 */
export async function startPreview(magnet: string, userId: number, deps: PreviewDeps = {}): Promise<{ id: string }> {
  const api = deps.torbox ?? torbox;
  const now = deps.now ?? Date.now;
  if (!getSecret("torbox")) throw fail("Connect TorBox in Settings to preview a recording.", 409);
  const hash = magnetHash(magnet);
  // A preview of this release before (Stop, then Preview again; a removal TorBox refused) put it there: so did this one.
  const ours = !!sqlite.prepare("SELECT 1 FROM torbox_previews WHERE hash=? AND added=1").get(hash);
  const found = await onAccount(hash, api);
  let torrentId: number;
  let added: boolean;
  if (found && typeof found.id === "number") {
    torrentId = found.id;
    added = ours;
  } else {
    const form = new FormData();
    form.set("magnet", magnet);
    form.set("add_only_if_cached", "true");
    form.set("allow_zip", "false");
    const data = (await api("torrents/createtorrent", { method: "POST", body: form })) as { torrent_id?: number } | null;
    if (typeof data?.torrent_id !== "number") throw fail("TorBox does not have this recording cached.", 502);
    torrentId = data.torrent_id;
    added = true;
  }
  const id = randomUUID();
  // Recorded before the files are read: whatever happens next, the end below or the loop finds what was added.
  db.insert(s.torboxPreviews).values({ id, userId, hash, torrentId, fileId: null, fileName: null, added, createdAt: now(), endedAt: null, removalError: null }).run();
  try {
    const file = previewFile(await releaseFiles(torrentId, api, deps.wait ?? sleep));
    if (!file) throw fail("This recording has no audio file to preview.", 422);
    db.update(s.torboxPreviews).set({ fileId: file.id, fileName: file.name }).where(eq(s.torboxPreviews.id, id)).run();
  } catch (error) {
    await endPreview(id, deps);
    throw error;
  }
  return { id };
}

/** What of the library names this release: an acquisition, an edition or recording, a track's stored source. */
export function libraryUses(hash: string, torrentId: number): boolean {
  const edition = `torbox-${torrentId}`;
  return !!sqlite
    .prepare(
      `SELECT 1 WHERE
         EXISTS(SELECT 1 FROM acquisitions WHERE hash=? OR (backend='torbox' AND remote_id=?))
         OR EXISTS(SELECT 1 FROM audio_editions WHERE id IN (?,?))
         OR EXISTS(SELECT 1 FROM recordings WHERE id IN (?,?))
         OR EXISTS(SELECT 1 FROM tracks WHERE source_type='torbox' AND json_valid(source) AND json_extract(source,'$.torrentId')=?)`,
    )
    .get(hash, String(torrentId), edition, `local-${hash}`, `recording-${edition}`, `recording-local-${hash}`, torrentId);
}

/** Another preview, not ended, plays this release. */
function otherPreviewUses(record: PreviewRecord): boolean {
  return !!sqlite
    .prepare("SELECT 1 FROM torbox_previews WHERE id<>? AND ended_at IS NULL AND (hash=? OR torrent_id=?)")
    .get(record.id, record.hash, record.torrentId);
}

const removing = new Set<string>();

/** The removal of an ended preview's release, under the guard; the record goes unless TorBox refuses the removal. */
async function settle(record: PreviewRecord, api: typeof torbox) {
  const forget = () => db.delete(s.torboxPreviews).where(eq(s.torboxPreviews.id, record.id)).run();
  if (!record.added || otherPreviewUses(record) || libraryUses(record.hash, record.torrentId)) return void forget();
  if (removing.has(record.hash)) return;
  removing.add(record.hash);
  try {
    // Already gone from the account (removed by hand, or by an earlier record of this release): nothing to remove.
    const found = await onAccount(record.hash, api);
    if (found)
      await api("torrents/controltorrent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ torrent_id: record.torrentId, operation: "delete" }),
      });
    // Every ended record of the release is settled with it.
    sqlite.prepare("DELETE FROM torbox_previews WHERE (hash=? OR id=?) AND ended_at IS NOT NULL").run(record.hash, record.id);
  } catch (error) {
    // Not reported to the reader: the loop tries again.
    db.update(s.torboxPreviews).set({ removalError: (error as Error).message || "TorBox refused the removal." }).where(eq(s.torboxPreviews.id, record.id)).run();
  } finally {
    removing.delete(record.hash);
  }
}

/** End a preview: its bytes are no longer served, and its release is removed under the guard. An unknown id is fine. */
export async function endPreview(id: string, deps: PreviewDeps = {}) {
  const now = deps.now ?? Date.now;
  const record = previewRecord(id);
  if (!record) return;
  const ended = record.endedAt ?? now();
  if (record.endedAt === null) db.update(s.torboxPreviews).set({ endedAt: ended }).where(eq(s.torboxPreviews.id, id)).run();
  await settle({ ...record, endedAt: ended }, deps.torbox ?? torbox);
}

/** The loop's round: previews made 30 minutes ago or more end, and ended ones whose removal was refused are tried again. */
export async function expirePreviews(deps: PreviewDeps = {}) {
  const now = (deps.now ?? Date.now)();
  sqlite.prepare("UPDATE torbox_previews SET ended_at=? WHERE ended_at IS NULL AND created_at<=?").run(now, now - PREVIEW_LIFETIME_MS);
  const ended = db.select().from(s.torboxPreviews).all().filter((record) => record.endedAt !== null);
  for (const record of ended) if (previewRecord(record.id)) await settle(record, deps.torbox ?? torbox);
}

/** Get of a release: its preview records are given up, and the release stays on TorBox for the recording. */
export function keepPreviewedRelease(magnet: string) {
  try {
    sqlite.prepare("DELETE FROM torbox_previews WHERE hash=?").run(magnetHash(magnet));
  } catch {
    // Not a magnet Get could use either; nothing to give up.
  }
}

/** Ends previews at the server's start and every minute (checked at start: a restart forgets nothing). */
export const torboxPreviewLoop: BackgroundProcess = {
  id: "torbox-previews",
  intervalMs: 60_000,
  runAtStart: true,
  tick: () => expirePreviews().catch(() => {}),
};

const passedHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

/** The preview's file, its bytes and ranges proxied from TorBox's address, fetched here from the stored record. */
async function serveBytes(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const record = previewRecord(id);
  if (!record || record.endedAt !== null || record.fileId === null)
    return reply.code(404).send({ error: "This preview has ended." });
  const fileId = record.fileId;
  const aborter = new AbortController();
  req.raw.once("aborted", () => aborter.abort());
  reply.raw.once("close", () => aborter.abort());
  const headersTimeout = setTimeout(() => aborter.abort(), 30000);
  const ask = async (refresh: boolean) =>
    fetch(await torboxUrl(record.torrentId, fileId, refresh), {
      method: req.method,
      headers: { "Accept-Encoding": "identity", ...(req.headers.range ? { Range: req.headers.range } : {}) },
      signal: aborter.signal,
    });
  let response: Response;
  try {
    response = await ask(false);
    if ([401, 403, 410].includes(response.status)) {
      await response.body?.cancel();
      response = await ask(true);
    }
  } catch {
    return reply.code(503).send({ error: "TorBox could not be reached for this preview." });
  } finally {
    clearTimeout(headersTimeout);
  }
  if (!response.ok && response.status !== 416) {
    await response.body?.cancel();
    return reply.code(502).send({ error: "TorBox could not play this preview." });
  }
  reply.code(response.status);
  for (const key of passedHeaders) {
    const value = response.headers.get(key);
    if (value) reply.header(key, value);
  }
  reply.header("Cache-Control", "private, no-store");
  if (!response.body || req.method === "HEAD") return reply.send();
  return reply.send(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream));
}

const previewId = /^[0-9a-f-]{36}$/;

/**
 * The preview's routes (the administrator's, by `/api/discover/` in the app's check): start one for an AudioBookBay
 * release (`abb/preview`, `{ slug }`) or a Prowlarr result (`prowlarr/preview`, `{ id }`); its bytes; its end.
 */
export function registerPreviewRoutes(
  app: FastifyInstance,
  { magnetOf, userOf }: { magnetOf: (candidate: { source: "abb" | "prowlarr"; key: string }) => Promise<string>; userOf: (req: FastifyRequest) => number },
) {
  const start = (source: "abb" | "prowlarr", key: string, req: FastifyRequest) =>
    magnetOf({ source, key }).then((magnet) => startPreview(magnet, userOf(req)));
  app.post("/api/discover/abb/preview", async (req) => {
    const slug = (req.body as { slug?: unknown } | null)?.slug;
    if (typeof slug !== "string" || !slug) throw fail("Name the release to preview.", 400);
    return start("abb", slug, req);
  });
  app.post("/api/discover/prowlarr/preview", async (req) => {
    const id = (req.body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !/^prowlarr-[a-f0-9]{32}$/.test(id)) throw fail("Name the release to preview.", 400);
    return start("prowlarr", id, req);
  });
  app.route({ method: ["GET", "HEAD"], url: "/api/discover/previews/:id/audio", handler: serveBytes });
  app.delete("/api/discover/previews/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (previewId.test(id)) await endPreview(id);
    return { ok: true };
  });
}
