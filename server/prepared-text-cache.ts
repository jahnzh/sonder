// Prepared reader text on disk, and the routes that serve it.
//
// One folder per prepared book under MEDIA_ROOT/prepared-text, named `<edition>-<key>`: the manifest, the parts
// (`p<n>.html`) and the pictures. The key is made from the EPUB file's size and time and from
// PREPARED_TEXT_VERSION, so a changed file or changed preparing code gives a new folder and new addresses, and what
// was served under an address never changes (it is cached for good).
import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ebookRecord, extractBook } from "./reader.ts";
import { mediaMountProblem, mediaRoot } from "./storage.ts";
import { PREPARED_TEXT_VERSION, pictureType, prepareEpub } from "./prepared-text.ts";

type Log = { warn: (details: object, message: string) => void };
const HOUR = 3_600_000;
/** Where prepared books are kept. `PREPARED_TEXT_DIR` moves it (the library check prepares into a temp folder). */
export const preparedDir = () => resolve(process.env.PREPARED_TEXT_DIR || join(mediaRoot, "prepared-text"));
/** The cache may hold this much before the entries read longest ago are removed (`PREPARED_TEXT_CACHE_MB`). */
const maxCacheBytes = () => (Number(process.env.PREPARED_TEXT_CACHE_MB) > 0 ? Number(process.env.PREPARED_TEXT_CACHE_MB) : 2048) * 1024 * 1024;
const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** Names one prepared output of an EPUB file: another file, or another PREPARED_TEXT_VERSION, has another key. */
export const preparedKey = (file: { size: number; mtimeMs: number }, version = PREPARED_TEXT_VERSION) => short(`${version}|${file.size}|${file.mtimeMs}`);
/** How often a book was prepared by this process, for the tests. */
export const preparedCounts = { built: 0 };

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
async function located(id: string) {
  const record = preparedRecord(id);
  const key = preparedKey(await stat(record.source));
  return { record, key, dir: join(preparedDir(), `${short(id)}-${key}`) };
}

/**
 * Prepares the edition into its folder and returns it. The folder appears whole or not at all: the work is done in
 * a folder of its own and renamed into place, and when another server got there first, its folder is the one kept.
 */
export async function buildPrepared(id: string, log?: Log) {
  const { record, key, dir } = await located(id);
  const problem = process.env.PREPARED_TEXT_DIR ? null : mediaMountProblem();
  if (problem) throw Object.assign(new Error(problem), { statusCode: 503 });
  const book = await extractBook(id);
  const epub = await readFile(record.source);
  const temp = `${dir}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await mkdir(join(temp, "pictures"), { recursive: true, mode: 0o750 });
  try {
    let bytes = 0;
    const { manifest, parts } = await prepareEpub({
      epub,
      book,
      key,
      base: `/api/reader/${encodeURIComponent(id)}/prepared/${key}`,
      writePicture: async (name, data) => {
        bytes += data.length;
        await writeFile(join(temp, "pictures", name), data);
      },
    });
    for (const [index, html] of parts.entries()) {
      bytes += Buffer.byteLength(html);
      await writeFile(join(temp, `p${index}.html`), html);
    }
    const text = JSON.stringify(manifest);
    await writeFile(join(temp, "manifest.json"), text);
    await writeFile(join(temp, "entry.json"), JSON.stringify({ id, key, version: PREPARED_TEXT_VERSION, bytes: bytes + Buffer.byteLength(text), preparedAt: Date.now() }));
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
  await prunePrepared({ keep: dir, replaces: `${short(id)}-` }).catch((error) => log?.warn({ err: error }, "prepared text: pruning failed"));
  return { dir, key };
}

const building = new Map<string, Promise<{ dir: string; key: string }>>();
/** The edition's prepared folder: the one on disk, or a new one. Requests that arrive together share one preparing. */
export async function ensurePrepared(id: string, log?: Log) {
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
    running = buildPrepared(id, log).finally(() => building.delete(dir));
    building.set(dir, running);
  }
  return running;
}

/**
 * Removes what the cache no longer needs: work a stopped server left behind, other outputs of the edition just
 * prepared (`replaces`, its folder-name prefix), and, while the cache is over `maxBytes`, the entries read longest ago.
 */
export async function prunePrepared(options: { maxBytes?: number; keep?: string; replaces?: string } = {}) {
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
    if (total <= max) break;
    await rm(entry.dir, { recursive: true, force: true });
    total -= entry.bytes;
  }
}

/** A file of a prepared folder, cached for good: its address holds the key, and a key's content never changes. */
async function sendKept(reply: FastifyReply, id: string, key: string, file: string | null, type: string) {
  const record = preparedRecord(id);
  if (!/^[0-9a-f]{16}$/.test(key) || !file) throw notFound("This part of the book could not be found.");
  const dir = join(preparedDir(), `${short(record.id)}-${key}`);
  const info = await statOrNull(join(dir, file));
  if (!info?.isFile()) {
    if (await statOrNull(dir)) throw notFound("This part of the book could not be found.");
    throw notFound("This prepared text is no longer kept. Load the book again.", "prepared_stale");
  }
  return reply
    .header("Content-Type", type)
    .header("Content-Length", info.size)
    .header("Cache-Control", "private, max-age=31536000, immutable")
    .header("X-Content-Type-Options", "nosniff")
    // Opened by its address, a part or a picture (an SVG may hold script) runs nothing and loads nothing.
    .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    .send(createReadStream(join(dir, file)));
}

export function registerPreparedText(app: FastifyInstance) {
  app.get("/api/reader/:id/prepared", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { dir } = await ensurePrepared(id, req.log);
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "private, no-cache")
      .send(await readFile(join(dir, "manifest.json")));
  });
  app.get("/api/reader/:id/prepared/:key/parts/:part", async (req, reply) => {
    const { id, key, part } = req.params as { id: string; key: string; part: string };
    return sendKept(reply, id, key, /^\d{1,5}$/.test(part) ? `p${Number(part)}.html` : null, "text/html; charset=utf-8");
  });
  app.get("/api/reader/:id/prepared/:key/pictures/:name", async (req, reply) => {
    const { id, key, name } = req.params as { id: string; key: string; name: string };
    const type = pictureType(name);
    return sendKept(reply, id, key, type ? join("pictures", name) : null, type || "");
  });
}
