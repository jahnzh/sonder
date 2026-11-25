// A preview of a recording cached on TorBox, before Get (#889; issue comment "Design discussion, 24 Nov 2026").
//
// Start: the candidate's magnet (resolved as Get resolves it) names a release; it is put on the TorBox account only
// when TorBox has it cached (`add_only_if_cached`), or found there already; one file is chosen (`previewFile`) and a
// record kept in `torbox_previews`. The client gets the record's id and nothing else: the bytes route takes TorBox's
// address on the server from that record, never from the client. A preview makes no library row, recording,
// acquisition, track or listening position, and Activity never lists it.
//
// End (the sheet closing, another candidate previewed, or 30 minutes after it was made, by the loop): the record is
// ended and its bytes are no longer served. Nothing is removed from TorBox: a previewed release stays on the account.
//
// Removal is not built (it is a later ticket). Why it went from this branch, for that ticket:
// - "Was it on the account before" is read from `torrents/mylist`, which TorBox documents as refreshed only every
//   600 seconds unless `bypass_cache` is sent, with a limit of 1000; `createtorrent`'s answer cannot tell "added now"
//   from "was there". So a release the owner added by hand minutes earlier is recorded as added by the preview and
//   would be deleted, and a preview ended within a minute finds nothing to delete.
// - The guard, two network calls and then the delete ran with no lock shared with Get and no re-check: Preview A,
//   Preview B (A's end unawaited), choose A, and Get could receive A's torrent just before the delete landed.
// - `added` was inherited by hash with the id taken from the list; and a refused removal was retried every 60 s for
//   ever with no backoff.
// The table keeps `added` as the best-known fact for that ticket; it is not reliable yet and nothing acts on it.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
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

/** The release on the TorBox account with this hash, or null (TorBox's list may be up to 600 s old). */
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
  // Found on the account: its torrent is played and nothing is added. Else added, only if cached.
  const found = await onAccount(hash, api);
  let torrentId: number;
  let added: boolean;
  if (found && typeof found.id === "number") {
    torrentId = found.id;
    added = false;
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
  db.insert(s.torboxPreviews).values({ id, userId, hash, torrentId, fileId: null, fileName: null, added, createdAt: now(), endedAt: null }).run();
  try {
    const file = previewFile(await releaseFiles(torrentId, api, deps.wait ?? sleep));
    if (!file) throw fail("This recording has no audio file to preview.", 422);
    db.update(s.torboxPreviews).set({ fileId: file.id, fileName: file.name }).where(eq(s.torboxPreviews.id, id)).run();
  } catch (error) {
    endPreview(id, deps);
    throw error;
  }
  return { id };
}

/** End a preview: its bytes are no longer served. Nothing is removed from TorBox. An unknown id is fine. */
export function endPreview(id: string, deps: Pick<PreviewDeps, "now"> = {}) {
  sqlite.prepare("UPDATE torbox_previews SET ended_at=? WHERE id=? AND ended_at IS NULL").run((deps.now ?? Date.now)(), id);
}

/** The loop's round: previews made 30 minutes ago or more end. */
export function expirePreviews(deps: Pick<PreviewDeps, "now"> = {}) {
  const now = (deps.now ?? Date.now)();
  return sqlite.prepare("UPDATE torbox_previews SET ended_at=? WHERE ended_at IS NULL AND created_at<=?").run(now, now - PREVIEW_LIFETIME_MS).changes;
}

/** Ends previews at the server's start and every minute (checked at start: a restart forgets nothing). */
export function torboxPreviewLoop(log: Pick<FastifyBaseLogger, "warn">): BackgroundProcess {
  return {
    id: "torbox-previews",
    intervalMs: 60_000,
    runAtStart: true,
    tick: () => {
      try {
        expirePreviews();
      } catch (error) {
        log.warn({ error }, "Ending expired TorBox previews failed");
      }
    },
  };
}

const passedHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

const previewParams = z.object({ id: z.string().uuid() });

/** The preview's file, its bytes and ranges proxied from TorBox's address, fetched here from the stored record. */
async function serveBytes(req: FastifyRequest, reply: FastifyReply) {
  const { id } = previewParams.parse(req.params);
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
  } catch (error) {
    req.log.warn({ error }, "TorBox preview bytes could not be fetched");
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

/**
 * The preview's routes (the administrator's, by `/api/discover/` in the app's check): start one for an AudioBookBay
 * release (`abb/preview`, `{ slug }`) or a Prowlarr result (`prowlarr/preview`, `{ id }`); its bytes; its end.
 * The bodies are checked as the add routes check theirs.
 */
export function registerPreviewRoutes(
  app: FastifyInstance,
  {
    abbSlug,
    magnetOf,
    userOf,
  }: {
    abbSlug: z.ZodType<string>;
    magnetOf: (candidate: { source: "abb" | "prowlarr"; key: string }) => Promise<string>;
    userOf: (req: FastifyRequest) => number;
  },
) {
  const abbBody = z.object({ slug: abbSlug });
  const prowlarrBody = z.object({ id: z.string().regex(/^prowlarr-[a-f0-9]{32}$/) });
  app.post("/api/discover/abb/preview", async (req) => {
    const { slug } = abbBody.parse(req.body);
    return startPreview(await magnetOf({ source: "abb", key: slug }), userOf(req));
  });
  app.post("/api/discover/prowlarr/preview", async (req) => {
    const { id } = prowlarrBody.parse(req.body);
    return startPreview(await magnetOf({ source: "prowlarr", key: id }), userOf(req));
  });
  app.route({ method: ["GET", "HEAD"], url: "/api/discover/previews/:id/audio", handler: serveBytes });
  app.delete("/api/discover/previews/:id", async (req) => {
    endPreview(previewParams.parse(req.params).id);
    return { ok: true };
  });
}
