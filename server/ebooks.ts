import {
  parseSearchPage as parseLibgen,
  parseMirrorPage,
} from "./sources/libgen-parse.ts";
import { getSetting } from "./services.ts";
import { ebookDir, ensureMediaStorage } from "./storage.ts";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { eq } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import dns, { type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";
import {
  createWriteStream,
  existsSync,
  renameSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import { invalidateParsedBook } from "./reader.ts";
import { join, basename, extname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
// Anna’s Archive was removed for now (#8); Library Genesis is the only source.
export type EbookSource = "libgen";
export type EbookResult = {
  md5: string;
  source: EbookSource;
  title: string;
  authors: string[];
  extension: string | null;
  language: string | null;
  size: string | null;
  year: string | null;
  coverUrl: string | null;
  url: string;
};
const userAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
function baseUrl(_source: EbookSource) {
  return getSetting("libgenUrl") || "https://libgen.li";
}
async function page(url: string, source: EbookSource) {
  let response;
  try {
    response = await publicFetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": userAgent,
        Referer: baseUrl(source) + "/",
      },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error(
      "Library Genesis could not be reached. Try another mirror in Settings or open the source website.",
    );
  }
  if (!response.ok)
    throw new Error(
      `Library Genesis returned ${response.status}. This mirror may need browser verification.`,
    );
  const html = await response.text();
  if (/<title>\s*Welcome to nginx!/i.test(html))
    throw new Error(
      "This mirror is unavailable. Try another mirror in Settings or open the source website.",
    );
  return html;
}
export async function searchEbooks(
  source: EbookSource,
  q: string,
  pageNumber = 1,
): Promise<{ files: EbookResult[]; website: string }> {
  const base = baseUrl(source);
  const params = new URLSearchParams([
    ["req", q],
    ["columns[]", "t"],
    ["columns[]", "a"],
    ["columns[]", "i"],
    ["objects[]", "f"],
    ["topics[]", "l"],
    ["topics[]", "f"],
    ["res", "50"],
    ["filesuns", "all"],
    ["page", String(pageNumber)],
  ]);
  const url = `${base}/index.php?${params}`;
  const html = await page(url, source);
  const files = parseLibgen(html).map((f) => ({ ...f, coverUrl: null }));
  if (
    !files.length &&
    /just a moment|checking your browser|captcha|verify you are human|access denied/i.test(
      html,
    )
  )
    throw new Error(
      "This mirror requires browser verification. Open the source website, or use another mirror.",
    );
  return {
    files: files
      .filter((f) => f.extension === "epub" || f.extension === "pdf")
      .slice(0, 50)
      .map((f) => ({ ...f, source, url: `${base}/ads.php?md5=${f.md5}` })),
    website: url,
  };
}
// Separate lists, because BlockList also matches IPv4 addresses against IPv6
// rules as IPv4-mapped addresses, which ::ffff:0:0/96 would always match.
const privateV4 = new BlockList(),
  privateV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  privateV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  privateV6.addSubnet(network, prefix, "ipv6");
export function privateAddress(ip: string) {
  const family = isIP(ip);
  if (!family) return true;
  return family === 6
    ? privateV6.check(ip, "ipv6")
    : privateV4.check(ip, "ipv4");
}
class PrivateAddressError extends Error {
  constructor() {
    super("Downloads from private network addresses are not allowed.");
  }
}
// Every address is checked when the connection is made, so a host can't pass
// the check with one DNS answer and connect with another.
const publicAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true }, (error, found) => {
        const addresses = found as unknown as LookupAddress[];
        if (error) return callback(error, "", 0);
        if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
          return callback(new PrivateAddressError(), "", 0);
        if ((options as { all?: boolean }).all)
          return (callback as unknown as (e: null, a: LookupAddress[]) => void)(
            null,
            addresses,
          );
        callback(null, addresses[0].address, addresses[0].family);
      });
    },
  },
});
// Waiting for a response and waiting between body chunks are limited separately,
// so a large file on a slow mirror isn't cut off while it is still arriving.
export const ebookTimeouts = { response: 60000, idle: 60000 };
export async function publicFetch(input: string, init: RequestInit = {}) {
  let url = new URL(input);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !["", "443"].includes(url.port)
    )
      throw new Error(
        "The source did not provide a secure public download URL.",
      );
    // Literal addresses never reach the agent's lookup.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && privateAddress(host)) throw new PrivateAddressError();
    const waiting = new AbortController();
    const timer = setTimeout(
      () =>
        waiting.abort(new Error("The ebook source did not respond in time.")),
      ebookTimeouts.response,
    );
    let response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: init.signal
          ? AbortSignal.any([init.signal, waiting.signal])
          : waiting.signal,
        dispatcher: publicAgent,
      } as RequestInit);
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      throw cause instanceof PrivateAddressError ? cause : error;
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location)
        throw new Error("The ebook source returned an invalid redirect.");
      url = new URL(location, url);
      continue;
    }
    return response;
  }
  throw new Error("The ebook source redirected too many times.");
}
// Saving an ebook that is already on the server still attaches it to the chosen book.
function linkEbook(id: string, workId: string | undefined) {
  if (!workId) return;
  const row = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, id))
    .get();
  if (!row || row.workId === workId) return;
  if (!db.select().from(s.works).where(eq(s.works.id, workId)).get())
    throw new Error("The selected book could not be found.");
  db.update(s.ebookEditions)
    .set({ workId })
    .where(eq(s.ebookEditions.id, id))
    .run();
  invalidateParsedBook(id);
}
async function resolveDownload(source: EbookSource, md5: string) {
  const base = baseUrl(source);
  const mirror = parseMirrorPage(
    await page(`${base}/ads.php?md5=${md5}`, "libgen"),
  );
  if (!mirror.download)
    throw new Error(
      "Library Genesis did not provide a direct link. Open the source website to download manually.",
    );
  return new URL(mirror.download, base).href.replace(/^http:/i, "https:");
}
async function downloadEbook(input: EbookResult & { workId?: string }) {
  ensureMediaStorage();
  const id = `${input.source}-${input.md5}`;
  const saved = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, id))
    .get();
  if (saved && existsSync(saved.source)) {
    linkEbook(id, input.workId);
    return { id };
  }
  const ext = input.extension?.toLowerCase();
  if (!["epub", "pdf"].includes(ext || ""))
    throw new Error("Choose an EPUB or PDF ebook.");
  const url = await resolveDownload(input.source, input.md5);
  const stalled = new AbortController();
  const response = await publicFetch(url, {
    headers: {
      "User-Agent": userAgent,
      Referer: baseUrl(input.source) + "/",
      "Accept-Encoding": "identity",
    },
    signal: stalled.signal,
  });
  if (!response.ok || !response.body)
    throw new Error(
      "The ebook could not be downloaded. Open the source website to check availability.",
    );
  const max = 150 * 1024 * 1024;
  const expected = Number(response.headers.get("content-length")) || 0;
  if (expected > max) {
    await response.body.cancel();
    throw new Error("This ebook exceeds the 150 MB limit.");
  }
  const path = join(ebookDir, `${id}.${ext}`),
    temp = path + ".part";
  if (existsSync(temp)) unlinkSync(temp);
  const writer = createWriteStream(temp, { flags: "wx", mode: 0o640 });
  let size = 0;
  const hash = createHash("md5");
  let idle: NodeJS.Timeout | undefined;
  const watch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () =>
        stalled.abort(
          new Error("The ebook download stalled. Retry or try another mirror."),
        ),
      ebookTimeouts.idle,
    );
  };
  try {
    watch();
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        watch();
        size += chunk.byteLength;
        if (size > max) {
          callback(new Error("This ebook exceeds the 150 MB limit."));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ),
      counter,
      writer,
      { signal: stalled.signal },
    );
    clearTimeout(idle);
    if (!size || (expected && expected !== size))
      throw new Error("The ebook download was interrupted.");
    const digest = hash.digest("hex");
    if (digest !== input.md5.toLowerCase())
      throw new Error(
        "The ebook checksum did not match. The incomplete download was discarded.",
      );
    const header = Buffer.alloc(5);
    const fd = openSync(temp, "r");
    readSync(fd, header, 0, 5, 0);
    closeSync(fd);
    if (
      (ext === "epub" && header.subarray(0, 2).toString() !== "PK") ||
      (ext === "pdf" && header.toString() !== "%PDF-")
    )
      throw new Error("The source returned an invalid ebook file.");
    renameSync(temp, path);
    sqlite.transaction(() => {
      let workId = input.workId;
      if (
        workId &&
        !db.select().from(s.works).where(eq(s.works.id, workId)).get()
      )
        throw new Error("The selected book could not be found.");
      // A row whose file went missing is repaired in place and keeps its book.
      workId ||= db
        .select()
        .from(s.ebookEditions)
        .where(eq(s.ebookEditions.id, id))
        .get()?.workId;
      if (!workId) {
        workId = `work-${randomUUID()}`;
        db.insert(s.works)
          .values({
            id: workId,
            title: input.title,
            author: input.authors.join(", ") || "Unknown author",
            description: "An ebook from your collection.",
            genre: "Ebook",
            year: Number(input.year) || new Date().getFullYear(),
          })
          .run();
      }
      db.insert(s.ebookEditions)
        .values({ id, workId, format: ext!, source: path })
        .onConflictDoUpdate({
          target: s.ebookEditions.id,
          set: { workId, format: ext!, source: path },
        })
        .run();
    })();
    return { id };
  } catch (error) {
    clearTimeout(idle);
    writer.destroy();
    if (existsSync(temp)) unlinkSync(temp);
    if (
      existsSync(path) &&
      !db.select().from(s.ebookEditions).where(eq(s.ebookEditions.id, id)).get()
    )
      unlinkSync(path);
    throw stalled.signal.aborted ? stalled.signal.reason : error;
  }
}
export function listEbooks() {
  return db
    .select({
      id: s.ebookEditions.id,
      workId: s.ebookEditions.workId,
      title: s.works.title,
      author: s.works.author,
      format: s.ebookEditions.format,
    })
    .from(s.ebookEditions)
    .innerJoin(s.works, eq(s.works.id, s.ebookEditions.workId))
    .all()
    .filter((b) => !b.id.startsWith("set-consensus:"))
    .map((b) => {
      const row = db
        .select()
        .from(s.ebookEditions)
        .where(eq(s.ebookEditions.id, b.id))
        .get()!;
      return {
        ...b,
        size: existsSync(row.source) ? statSync(row.source).size : 0,
        available: existsSync(row.source),
      };
    });
}

// Free source downloads can be brought back through the same persistent shelf.
export async function importEbook(
  file: Readable & { truncated?: boolean },
  filename: string,
  targetWorkId?: string,
) {
  ensureMediaStorage();
  const ext = extname(filename).slice(1).toLowerCase();
  if (ext !== "epub" && ext !== "pdf")
    throw new Error("Choose an EPUB or PDF file.");
  if (
    targetWorkId &&
    !db.select().from(s.works).where(eq(s.works.id, targetWorkId)).get()
  )
    throw new Error("The selected book could not be found.");
  const temp = join(ebookDir, `import-${randomUUID()}.part`);
  let path: string | undefined;
  const hash = createHash("md5");
  let size = 0;
  try {
    await pipeline(
      file,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          if (size > 150 * 1024 * 1024)
            return callback(new Error("This ebook exceeds the 150 MB limit."));
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(temp, { flags: "wx", mode: 0o640 }),
    );
    if (!size || file.truncated)
      throw new Error(
        "The ebook upload was interrupted or exceeds the 150 MB limit.",
      );
    const header = Buffer.alloc(5);
    const fd = openSync(temp, "r");
    try {
      readSync(fd, header, 0, 5, 0);
    } finally {
      closeSync(fd);
    }
    if (
      (ext === "epub" &&
        header.subarray(0, 4).toString("hex") !== "504b0304") ||
      (ext === "pdf" && header.toString() !== "%PDF-")
    )
      throw new Error("This file is not a valid EPUB or PDF.");
    const id = `upload-${hash.digest("hex")}`;
    const existing = db
      .select()
      .from(s.ebookEditions)
      .where(eq(s.ebookEditions.id, id))
      .get();
    if (existing && existsSync(existing.source)) {
      linkEbook(id, targetWorkId);
      return { id, alreadySaved: true };
    }
    path = join(ebookDir, `${id}.${ext}`);
    renameSync(temp, path);
    sqlite.transaction(() => {
      const workId = targetWorkId || existing?.workId || `work-${randomUUID()}`;
      if (!targetWorkId && !existing)
        db.insert(s.works)
          .values({
            id: workId,
            title:
              basename(filename)
                .replace(/\.[^.]+$/, "")
                .slice(0, 300) || "Imported ebook",
            author: "Unknown author",
            description: "An ebook from your collection.",
            genre: "Ebook",
            year: new Date().getFullYear(),
          })
          .run();
      db.insert(s.ebookEditions)
        .values({ id, workId, format: ext, source: path! })
        .onConflictDoUpdate({
          target: s.ebookEditions.id,
          set: { source: path!, format: ext, workId },
        })
        .run();
    })();
    return { id, alreadySaved: false };
  } catch (error) {
    if (
      path &&
      existsSync(path) &&
      !db
        .select()
        .from(s.ebookEditions)
        .where(eq(s.ebookEditions.source, path))
        .get()
    )
      unlinkSync(path);
    throw error;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

const ebookDownloads = new Set<string>();
export async function saveEbook(input: EbookResult & { workId?: string }) {
  const key = `${input.source}-${input.md5}`;
  if (ebookDownloads.has(key))
    throw new Error("This ebook is already downloading. Give it a moment.");
  ebookDownloads.add(key);
  try {
    return await downloadEbook(input);
  } finally {
    ebookDownloads.delete(key);
  }
}
