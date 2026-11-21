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
export const preparedCounts = { built: 0, running: 0, mostAtOnce: 0, started: 0, stopped: 0 };

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
const setting = (name: string, standard: number) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : standard);
/**
 * The ceilings of one preparing thread. A thread without them has the whole server's heap ceiling (4.3 GB here, on a
 * host with less than that free) and no end: a book the preparing step loops or grows on would take the machine or
 * hold the sweep for good.
 * - `PREPARED_TEXT_THREAD_MB` (512): its heap. The library's largest book (71,225 sentences) uses 171 MB when held
 *   to 256 and runs at full speed there, so 512 leaves room for a book three times that size.
 * - `PREPARED_TEXT_THREAD_SECONDS` (300): the time it may take before it is stopped. The slowest real book took 13 s
 *   under the tightest heap that worked.
 * - `PREPARED_TEXT_THREADS` (2): how many run at once, the sweep's and the readers' together. Each adds 160 to 530 MB
 *   to the process while it runs, so two are at most about 1 GB beside a server of 1 GB on a host with 3.5 GB free.
 *   Books prepared ahead (the sweep, an import) never take the last one: a reader's open always finds a thread free
 *   or waits only for another reader's book, never behind the sweep.
 */
export const threadLimits = () => ({
  memoryMb: setting("PREPARED_TEXT_THREAD_MB", 512),
  seconds: setting("PREPARED_TEXT_THREAD_SECONDS", 300),
  atOnce: Math.max(1, Math.floor(setting("PREPARED_TEXT_THREADS", 2))),
});
/** What a reader is told when the preparing of a book was stopped or broke off; the cause goes to the log. */
export const NOT_PREPARED = "This EPUB could not be opened.";
/** Tests: another file to start as the thread, by the EPUB it is given (a thread that hangs, exits or throws). */
export const threadForTests = { entry: null as ((source: string) => URL | null) | null };

// Threads at once. `waiting` holds those that could not start, a reader's ahead of the sweep's and an import's.
type Waiting = { ahead: boolean; start: () => void };
const slots = { running: 0, ahead: 0, waiting: [] as Waiting[] };
function nextThread() {
  const { atOnce } = threadLimits();
  for (;;) {
    if (slots.running >= atOnce) return;
    // A book prepared ahead leaves one thread free for a reader whenever there is more than one.
    const aheadMay = slots.ahead < Math.max(1, atOnce - 1);
    const at = slots.waiting.findIndex((entry) => !entry.ahead || aheadMay);
    if (at < 0) return;
    const [entry] = slots.waiting.splice(at, 1);
    slots.running++;
    if (entry.ahead) slots.ahead++;
    entry.start();
  }
}
const afterReaders = () => {
  let at = 0;
  while (at < slots.waiting.length && !slots.waiting[at].ahead) at++;
  return at;
};
/**
 * A place in the line for a thread. `granted` resolves when the book may start; `free` gives the thread back, or
 * leaves the line when it was never reached; `sooner` moves a book that waits to be prepared ahead to a reader's place.
 */
function threadSlot(ahead: boolean) {
  let state: "waiting" | "running" | "freed" = "waiting";
  const entry: Waiting = { ahead, start: () => {} };
  const granted = new Promise<void>((resolve) => {
    entry.start = () => {
      state = "running";
      resolve();
    };
  });
  // Readers before books prepared ahead; among each, first come first.
  slots.waiting.splice(ahead ? slots.waiting.length : afterReaders(), 0, entry);
  nextThread();
  return {
    granted,
    free() {
      if (state === "waiting") slots.waiting.splice(slots.waiting.indexOf(entry), 1);
      else if (state === "running") {
        slots.running--;
        if (entry.ahead) slots.ahead--;
      }
      state = "freed";
      nextThread();
    },
    sooner() {
      if (state !== "waiting" || !entry.ahead) return;
      slots.waiting.splice(slots.waiting.indexOf(entry), 1);
      entry.ahead = false;
      slots.waiting.splice(afterReaders(), 0, entry);
      nextThread();
    },
  };
}
/** Tests: how many threads run and wait now. */
export const threadLine = () => ({ running: slots.running, ahead: slots.ahead, waiting: slots.waiting.length });

/**
 * Prepares a book's files into `job.temp` on a thread of its own (server/prepared-text-worker.ts), so the server
 * keeps answering meanwhile. Resolves with the bytes written. Rejects with the book's own error when the preparing
 * step refuses the book, and with NOT_PREPARED (its `cause` says why) when the thread ran out of its memory or its
 * time, or ended without an answer. The thread is always stopped before this returns.
 */
export async function prepareOffThread(job: PrepareJob, sections: PreparedBookInput["sections"], limits: { memoryMb?: number; seconds?: number } = {}) {
  const { memoryMb, seconds } = { ...threadLimits(), ...limits };
  const worker = new Worker(threadForTests.entry?.(job.source) ?? new URL("./prepared-text-worker.ts", import.meta.url), {
    workerData: job,
    resourceLimits: { maxOldGenerationSizeMb: memoryMb },
  });
  preparedCounts.running++;
  preparedCounts.started++;
  worker.once("exit", () => preparedCounts.stopped++);
  preparedCounts.mostAtOnce = Math.max(preparedCounts.mostAtOnce, preparedCounts.running);
  const stopped = (why: string) => Object.assign(new Error(NOT_PREPARED), { cause: why });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = new Promise<PrepareAnswer>((resolve, reject) => {
      worker.once("message", resolve);
      // Out of its memory, or an error outside the preparing itself.
      worker.once("error", (error) => reject(stopped(error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? error.name}: ${error.message}` : String(error))));
      worker.once("exit", (code) => reject(stopped(`the preparing thread ended without an answer (exit ${code})`)));
      timer = setTimeout(() => reject(stopped(`the preparing thread was stopped after ${seconds} s (PREPARED_TEXT_THREAD_SECONDS)`)), seconds * 1000);
    });
    // A rejection must have its handler before the first wait below.
    answer.catch(() => {});
    let ended = false;
    void answer.then(
      () => (ended = true),
      () => (ended = true),
    );
    for (const { paragraphs, ...section } of sections)
      for (let from = 0; from < paragraphs.length && !ended; from += SENTENCES_AT_ONCE) {
        worker.postMessage({ type: "sentences", section, paragraphs: paragraphs.slice(from, from + SENTENCES_AT_ONCE) } satisfies PrepareMessage);
        await nextTurn();
      }
    worker.postMessage({ type: "run" } satisfies PrepareMessage);
    const result = await answer;
    if (!result.ok) throw new Error(result.message);
    return result.bytes;
  } finally {
    clearTimeout(timer);
    preparedCounts.running--;
    await worker.terminate();
  }
}

/**
 * Prepares the edition into its folder and returns it. The folder appears whole or not at all: the work is done in
 * a folder of its own and renamed into place, and when another server got there first, its folder is the one kept.
 * The edition's older outputs are removed only now, when the new one is in place. `ahead` (the sweep, an import)
 * waits for a thread behind readers and removes nothing else to make room.
 */
export async function buildPrepared(id: string, log?: Log, options: { ahead?: boolean; slot?: ReturnType<typeof threadSlot> } = {}) {
  const slot = options.slot ?? threadSlot(!!options.ahead);
  try {
    return await buildInSlot(id, log, !!options.ahead, slot);
  } finally {
    slot.free();
  }
}
async function buildInSlot(id: string, log: Log | undefined, ahead: boolean, slot: ReturnType<typeof threadSlot>) {
  const { record, key, dir } = await located(id);
  const problem = process.env.PREPARED_TEXT_DIR ? null : mediaMountProblem();
  if (problem) throw Object.assign(new Error(problem), { statusCode: 503 });
  await slot.granted;
  const temp = `${dir}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    // The sentences are cut here, on the server's thread, where extractBook keeps them for the reader's routes.
    const { sections, ...book } = await extractBook(id);
    try {
      await prepareOffThread(
        { source: record.source, temp, key, base: `/api/reader/${encodeURIComponent(id)}/prepared/${key}`, book: { id: book.id, fingerprint: book.fingerprint, language: book.language } },
        sections,
      );
    } catch (error) {
      // Why a thread was stopped is for the log, said where the book is named; the reader gets the plain sentence.
      const cause = (error as { cause?: unknown }).cause;
      if (cause) log?.warn({ id, cause }, "prepared text: the preparing of a book was stopped");
      throw error;
    }
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
  await prunePrepared({ keep: dir, replaces: `${short(id)}-`, evict: !ahead }).catch((error) => log?.warn({ err: error }, "prepared text: pruning failed"));
  return { dir, key };
}

const building = new Map<string, { done: Promise<{ dir: string; key: string }>; slot: ReturnType<typeof threadSlot> }>();
/**
 * The edition's prepared folder: the one on disk, or a new one. Requests that arrive together share one preparing;
 * a reader who asks for a book that waits to be prepared ahead moves it to the readers' place in the line.
 */
export async function ensurePrepared(id: string, log?: Log, options: { ahead?: boolean } = {}) {
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
    const slot = threadSlot(!!options.ahead);
    running = { slot, done: buildPrepared(id, log, { ...options, slot }).finally(() => building.delete(dir)) };
    building.set(dir, running);
  } else if (!options.ahead) running.slot.sooner();
  return running.done;
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
