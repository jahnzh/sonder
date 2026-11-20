// Prepared reader text on disk, and the routes that serve it.
//
// One folder per prepared book under MEDIA_ROOT/prepared-text, named `<edition>-<key>`: the manifest, the parts
// (`p<n>.html`) and the pictures. The key (preparedKey) is made from the EPUB file's size and time and from the
// versions of everything that makes the output, so a changed file or changed code gives a new folder and new
// addresses, and what was served under an address never changes (it is cached for good).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EXTRACTOR_VERSION, ebookRecord, extractBook } from "./reader.ts";
import { mediaMountProblem, mediaRoot } from "./storage.ts";
import { Worker } from "node:worker_threads";
import { PREPARED_TEXT_VERSION, pictureType, type PreparedBookInput } from "./prepared-text.ts";
import type { PrepareAnswer, PrepareJob, PrepareMessage } from "./prepared-text-worker.ts";

export type Log = { warn: (details: object, message: string) => void; info?: (details: object, message: string) => void };
const HOUR = 3_600_000;
/** Where prepared books are kept. `PREPARED_TEXT_DIR` moves it (the library check prepares into a temp folder). */
export const preparedDir = () => resolve(process.env.PREPARED_TEXT_DIR || join(mediaRoot, "prepared-text"));
/** The cache may hold this much before the entries read longest ago are removed (`PREPARED_TEXT_CACHE_MB`). */
export const maxCacheBytes = () => (Number(process.env.PREPARED_TEXT_CACHE_MB) > 0 ? Number(process.env.PREPARED_TEXT_CACHE_MB) : 2048) * 1024 * 1024;
export const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/**
 * Names one prepared output of an EPUB file. It covers everything the output is made from that can change under a
 * kept folder: the file (its size and time, the stamp extractBook itself goes by), the preparing code
 * (PREPARED_TEXT_VERSION), the extractor's cut (EXTRACTOR_VERSION) and the ICU data `Intl.Segmenter` cuts sentences
 * with, which a new Node can change. It does not see a file replaced by another of the same size and time; the
 * manifest's `fingerprint` is of the file's content and shows that.
 */
export const preparedKey = (
  file: { size: number; mtimeMs: number },
  versions: { prepared?: number; extractor?: number; icu?: string } = {},
) =>
  short(
    [versions.prepared ?? PREPARED_TEXT_VERSION, versions.extractor ?? EXTRACTOR_VERSION, versions.icu ?? process.versions.icu, file.size, file.mtimeMs].join("|"),
  );
/** How often a book was prepared by this process, for the tests. */
export const preparedCounts = { built: 0, running: 0, mostAtOnce: 0 };

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    return null;
  }
}
const notFound = (message: string, code?: string) => Object.assign(new Error(message), { statusCode: 404, ...(code ? { code } : {}) });
/** The edition's row, with the checks of the reader's own routes; the consensus text of an ebook set has no EPUB. */
function preparedRecord(id: string) {
  if (id.startsWith("set-consensus:")) throw notFound("This book has no EPUB file.");
  return ebookRecord(id);
}
/** The edition's row, its key and the folder its prepared text is kept in (whether it is there or not). */
export async function located(id: string) {
  const record = preparedRecord(id);
  const key = preparedKey(await stat(record.source));
  return { record, key, dir: join(preparedDir(), `${short(id)}-${key}`) };
}

/** The book's sentences are sent to the preparing thread this many at a time, with the event loop let round between. */
const SENTENCES_AT_ONCE = 500;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
/**
 * Prepares a book's files into `job.temp` on a thread of its own (server/prepared-text-worker.ts), so the server
 * keeps answering meanwhile. Resolves with the bytes written; rejects with the book's own error.
 */
export async function prepareOffThread(job: PrepareJob, sections: PreparedBookInput["sections"]) {
  const worker = new Worker(new URL("./prepared-text-worker.ts", import.meta.url), { workerData: job });
  preparedCounts.running++;
  preparedCounts.mostAtOnce = Math.max(preparedCounts.mostAtOnce, preparedCounts.running);
  try {
    const answer = new Promise<PrepareAnswer>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`The preparing step stopped before it was done (exit ${code}).`)));
    });
    // A rejection must have its handler before the first wait below.
    answer.catch(() => {});
    for (const { paragraphs, ...section } of sections)
      for (let from = 0; from < paragraphs.length; from += SENTENCES_AT_ONCE) {
        worker.postMessage({ type: "sentences", section, paragraphs: paragraphs.slice(from, from + SENTENCES_AT_ONCE) } satisfies PrepareMessage);
        await nextTurn();
      }
    worker.postMessage({ type: "run" } satisfies PrepareMessage);
    const result = await answer;
    if (!result.ok) throw new Error(result.message);
    return result.bytes;
  } finally {
    preparedCounts.running--;
    await worker.terminate();
  }
}

/**
 * Prepares the edition into its folder and returns it. The folder appears whole or not at all: the work is done in
 * a folder of its own and renamed into place, and when another server got there first, its folder is the one kept.
 * `evict: false` (a book prepared ahead) removes the edition's older outputs but nothing else to make room.
 */
export async function buildPrepared(id: string, log?: Log, options: { evict?: boolean } = {}) {
  const { record, key, dir } = await located(id);
  const problem = process.env.PREPARED_TEXT_DIR ? null : mediaMountProblem();
  if (problem) throw Object.assign(new Error(problem), { statusCode: 503 });
  // The sentences are cut here, on the server's thread, where extractBook keeps them for the reader's routes.
  const { sections, ...book } = await extractBook(id);
  const temp = `${dir}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await prepareOffThread(
      { source: record.source, temp, key, base: `/api/reader/${encodeURIComponent(id)}/prepared/${key}`, book: { id: book.id, fingerprint: book.fingerprint, language: book.language } },
      sections,
    );
    try {
      await rename(temp, dir);
    } catch (error) {
      // The folder is already there: another request for the same book finished first, and its output is the same.
      if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      await rm(temp, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  preparedCounts.built++;
  // A cache that cannot be tidied still serves the book.
  await prunePrepared({ keep: dir, replaces: `${short(id)}-`, evict: options.evict }).catch((error) => log?.warn({ err: error }, "prepared text: pruning failed"));
  return { dir, key };
}

const building = new Map<string, Promise<{ dir: string; key: string }>>();
/** The edition's prepared folder: the one on disk, or a new one. Requests that arrive together share one preparing. */
export async function ensurePrepared(id: string, log?: Log, options: { evict?: boolean } = {}) {
  const { key, dir } = await located(id);
  const kept = await statOrNull(join(dir, "manifest.json"));
  if (kept) {
    // The folder's time says when it was last read, at most an hour late: pruning removes the oldest first.
    const info = await statOrNull(dir);
    if (info && Date.now() - info.mtimeMs > HOUR) await utimes(dir, new Date(), new Date());
    return { dir, key };
  }
  let running = building.get(dir);
  if (!running) {
    running = buildPrepared(id, log, options).finally(() => building.delete(dir));
    building.set(dir, running);
  }
  return running;
}

/**
 * Removes what the cache no longer needs: work a stopped server left behind, other outputs of the edition just
 * prepared (`replaces`, its folder-name prefix), and, while the cache is over `maxBytes`, the entries read longest ago.
 */
export async function prunePrepared(options: { maxBytes?: number; keep?: string; replaces?: string; evict?: boolean } = {}) {
  const root = preparedDir();
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (!missing(error)) throw error;
    return;
  }
  const entries: { dir: string; bytes: number; readAt: number }[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const info = await statOrNull(dir);
    if (!info?.isDirectory() || dir === options.keep) continue;
    let remove = false;
    if (name.includes(".tmp-")) remove = Date.now() - info.mtimeMs > HOUR;
    else if (options.replaces && name.startsWith(options.replaces)) remove = true;
    else {
      const entry = await readFile(join(dir, "entry.json"), "utf8").then(
        (text) => JSON.parse(text) as { bytes?: number },
        (error) => {
          if (!missing(error)) throw error;
          return null;
        },
      );
      // A folder without its entry file was not written by buildPrepared to the end.
      if (!entry) remove = true;
      else entries.push({ dir, bytes: Number(entry.bytes) || 0, readAt: info.mtimeMs });
    }
    if (remove) await rm(dir, { recursive: true, force: true });
  }
  const keptBytes = options.keep ? Number(JSON.parse(await readFile(join(options.keep, "entry.json"), "utf8")).bytes) || 0 : 0;
  let total = keptBytes + entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const max = options.maxBytes ?? maxCacheBytes();
  for (const entry of entries.sort((a, b) => a.readAt - b.readAt)) {
    if (total <= max || options.evict === false) break;
    await rm(entry.dir, { recursive: true, force: true });
    total -= entry.bytes;
  }
}

/** A file of a prepared folder, cached for good: its address holds the key, and a key's content never changes. */
async function sendKept(reply: FastifyReply, id: string, key: string, file: string | null, type: string) {
  const record = preparedRecord(id);
  if (!/^[0-9a-f]{16}$/.test(key) || !file) throw notFound("This part of the book could not be found.");
  const dir = join(preparedDir(), `${short(record.id)}-${key}`);
  // The file is opened before anything is said about caching: an answer that fails is never one to keep.
  let handle;
  try {
    handle = await open(join(dir, file), "r");
  } catch (error) {
    if (!missing(error)) throw error;
    if (await statOrNull(dir)) throw notFound("This part of the book could not be found.");
    throw notFound("This prepared text is no longer kept. Load the book again.", "prepared_stale");
  }
  let info;
  try {
    info = await handle.stat();
    if (!info.isFile()) throw notFound("This part of the book could not be found.");
  } catch (error) {
    await handle.close();
    throw error;
  }
  return reply
    .header("Content-Type", type)
    .header("Content-Length", info.size)
    .header("Cache-Control", "private, max-age=31536000, immutable")
    .header("X-Content-Type-Options", "nosniff")
    // Opened by its address, a part or a picture (an SVG may hold script) runs nothing and loads nothing.
    .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    .send(handle.createReadStream());
}

export function registerPreparedText(app: FastifyInstance) {
  // Only a part or picture that was served is kept for good. Any refusal or failure of these routes (not signed in,
  // not found, a file that cannot be read) says so itself, whatever was set before it failed: a browser that kept
  // an error under an address that never changes would show it for a year. The hook is on these routes only.
  const onSend = (_req: FastifyRequest, reply: FastifyReply, payload: unknown, done: (error: Error | null, payload?: unknown) => void) => {
    if (reply.statusCode >= 400) reply.header("Cache-Control", "no-store");
    done(null, payload);
  };
  app.get("/api/reader/:id/prepared", { onSend }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { dir, key } = await ensurePrepared(id, req.log);
    // The key names the manifest's content, so it is its validator: an unchanged book answers 304 without a body.
    const tag = `"${short(id)}-${key}"`;
    reply.header("ETag", tag).header("Cache-Control", "private, no-cache");
    const asked = String(req.headers["if-none-match"] || "");
    if (asked.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
    return reply.header("Content-Type", "application/json; charset=utf-8").send(await readFile(join(dir, "manifest.json")));
  });
  app.get("/api/reader/:id/prepared/:key/parts/:part", { onSend }, async (req, reply) => {
    const { id, key, part } = req.params as { id: string; key: string; part: string };
    return sendKept(reply, id, key, /^\d{1,5}$/.test(part) ? `p${Number(part)}.html` : null, "text/html; charset=utf-8");
  });
  app.get("/api/reader/:id/prepared/:key/pictures/:name", { onSend }, async (req, reply) => {
    const { id, key, name } = req.params as { id: string; key: string; name: string };
    const type = pictureType(name);
    return sendKept(reply, id, key, type ? join("pictures", name) : null, type || "");
  });
}
