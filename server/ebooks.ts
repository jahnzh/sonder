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
import { ebookSetMembersRemoved, removePendingMembersLeftBehind } from "./ebook-set-link.ts";
import { join, basename, extname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createLibgenClient,
  LibgenLimitedError,
  LIBGEN_USER_AGENT,
  sourceTiming,
} from "./sources/libgen-client.ts";
import { annasDownload, searchAnnas, searchLibgenRs, searchZlib, zlibDownload } from "./sources/shadow-libraries.ts";
import {
  gutenbergSearchUrl,
  GUTENBERG,
  parseGutenberg,
  parseStandardEbooks,
  publicDomainDownload,
  STANDARD_EBOOKS,
  standardEbooksSearchUrl,
  type PublicDomainSource,
} from "./sources/public-domain.ts";
// The sources (#901): Library Genesis (the libgen.li family), Anna’s Archive with the member key in Settings,
// Z-Library with the account in Settings, the other Library Genesis family (libgen.rs), Prowlarr's book indexers and
// the public-domain Standard Ebooks and Project Gutenberg.
export type EbookSource = "libgen" | "annas" | "zlib" | "libgenrs" | "prowlarr" | "standardebooks" | "gutenberg";
/** The sources in the order the series search asks them (#901). */
export const EBOOK_SOURCES = [
  "libgen",
  "annas",
  "zlib",
  "libgenrs",
  "prowlarr",
  "standardebooks",
  "gutenberg",
] as const satisfies readonly EbookSource[];
/**
 * The edition id a source's file is kept under (#901). Library Genesis, the libgen.rs family and Anna’s Archive name a
 * file by its own md5 (checked when it is saved), so the same file from any of them is one edition, `libgen-<md5>`; a
 * file the book has from one is "Already added" from the others. Another source's key is its own edition's.
 */
export function ebookEditionId(result: { source: string; md5: string }) {
  const md5 = result.md5.toLowerCase();
  return ["libgen", "libgenrs", "annas"].includes(result.source) ? `libgen-${md5}` : `${result.source}-${result.md5}`;
}
export type EbookResult = {
  /** The file's md5 on Library Genesis; for another source a 32-hex key of the edition there. */
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
  /** A Prowlarr release's indexer and seeders, and whether TorBox has it cached; absent for the other sources. */
  indexer?: string;
  seeders?: number | null;
  cached?: boolean;
};
const userAgent = LIBGEN_USER_AGENT;
// The test suites ask fake mirrors many times in a row: no spacing, no waits, no rest.
/** The one Library Genesis client (#901): the Get sheet and the series queue share its spacing and rests. */
export const libgen = createLibgenClient({
  fetch: (url, init) => publicFetch(url, init),
  mirror: () => getSetting("libgenUrl"),
  timing: sourceTiming(),
});
export { LibgenLimitedError };

async function libgenPage(kind: "search" | "download", path: string) {
  const { body, mirror } = await libgen.request(kind, path, {
    headers: { Accept: "text/html" },
    timeoutMs: 20000,
  });
  return { html: body ?? "", mirror };
}
async function searchLibgen(q: string, pageNumber: number) {
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
  const path = `index.php?${params}`;
  const { html, mirror } = await libgenPage("search", path);
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
      .map((f) => ({ ...f, source: "libgen" as const, url: `${mirror}/ads.php?md5=${f.md5}` })),
    website: `${mirror}/${path}`,
  };
}
const publicDomainSites: Record<PublicDomainSource, { name: string; search: (q: string) => string; website: (q: string) => string; parse: typeof parseGutenberg }> = {
  standardebooks: {
    name: "Standard Ebooks",
    search: standardEbooksSearchUrl,
    website: (q) => `${STANDARD_EBOOKS}/ebooks?${new URLSearchParams({ query: q })}`,
    parse: parseStandardEbooks,
  },
  gutenberg: {
    name: "Project Gutenberg",
    search: gutenbergSearchUrl,
    website: (q) => `${GUTENBERG}/ebooks/search/?${new URLSearchParams({ query: q })}`,
    parse: parseGutenberg,
  },
};
async function searchPublicDomain(source: PublicDomainSource, q: string) {
  const site = publicDomainSites[source];
  let response;
  try {
    response = await publicFetch(site.search(q), {
      headers: { Accept: "application/atom+xml, application/xml;q=0.9", "User-Agent": "Sonder" },
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(`${site.name} could not be reached.`, { cause: error });
  }
  // Project Gutenberg answers 503 with a maintenance page while it is down.
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${site.name} is unavailable (${response.status}).`);
  }
  const files = site.parse(await response.text());
  return { files: files.slice(0, 30), website: site.website(q) };
}
export async function searchEbooks(
  source: EbookSource,
  q: string,
  pageNumber = 1,
): Promise<{ files: EbookResult[]; website: string }> {
  if (source === "libgen") return searchLibgen(q, pageNumber);
  if (source === "annas") return searchAnnas(q);
  if (source === "zlib") return searchZlib(q);
  if (source === "libgenrs") return searchLibgenRs(q);
  if (source === "prowlarr") {
    const { prowlarrEbookSearch } = await import("./services.ts");
    return { files: await prowlarrEbookSearch(q), website: "" };
  }
  return searchPublicDomain(source, q);
}
export { ebookTimeouts, privateAddress, publicFetch } from "./public-fetch.ts";
import { ebookTimeouts, publicFetch } from "./public-fetch.ts";

// Saving an ebook that is already on the server still attaches it to the chosen book.
async function linkEbook(id: string, workId: string | undefined) {
  if (!workId) return;
  const row = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, id))
    .get();
  if (!row || row.workId === workId) return;
  if (!db.select().from(s.works).where(eq(s.works.id, workId)).get())
    throw new Error("The selected book could not be found.");
  // Its pending ebook-set member in the work it leaves goes with the link change (#325).
  const left = sqlite.transaction(() => {
    db.update(s.ebookEditions)
      .set({ workId })
      .where(eq(s.ebookEditions.id, id))
      .run();
    return removePendingMembersLeftBehind(id, workId);
  })();
  invalidateParsedBook(id);
  await ebookSetMembersRemoved(left);
}
/** The file's address on a mirror: its download page (`ads.php`) names the keyed link (`get.php`). */
async function resolveLibgenDownload(md5: string) {
  const { html, mirror } = await libgenPage("download", `ads.php?md5=${md5}`);
  const page = parseMirrorPage(html);
  if (!page.download)
    throw new Error(
      "Library Genesis did not provide a direct link. Open the source website to download manually.",
    );
  return { url: new URL(page.download, mirror).href.replace(/^http:/i, "https:"), mirror };
}
/** The file's response: through the Library Genesis client for its keyed link, straight from a public-domain source. */
async function fetchEbookFile(input: EbookResult, signal: AbortSignal) {
  const headers = { "User-Agent": userAgent, "Accept-Encoding": "identity" };
  if (input.source === "libgen") {
    const { url, mirror } = await resolveLibgenDownload(input.md5);
    const { response } = await libgen.request("download", url, {
      headers: { ...headers, Referer: `${mirror}/` },
      read: false,
      signal,
    });
    return response;
  }
  if (input.source === "standardebooks" || input.source === "gutenberg")
    return publicFetch(publicDomainDownload(input.source, input.url), { headers, signal });
  if (input.source === "annas") return publicFetch(await annasDownload(input.md5.toLowerCase()), { headers, signal });
  // The page names the book; the address fetched is the one Z-Library's API gives for it, never the client's.
  if (input.source === "zlib") return publicFetch(await zlibDownload(input.url), { headers, signal });
  throw new Error("This source's editions are fetched as a download.");
}
/**
 * A new or replaced EPUB has its text prepared in the background (#827), so its first reader does not wait for it.
 * It starts after the edition is saved and is not waited for. (Loaded here because the reader's modules load this one.)
 */
function prepareAhead(id: string, format: string | undefined) {
  if (format !== "epub") return;
  void import("./prepared-text-ahead.ts").then(
    ({ prepareSoon }) => prepareSoon(id),
    // The book is saved either way; the sweep or its first reader prepares it.
    (error) => console.warn(`prepared text: could not start preparing ${id} ahead: ${error instanceof Error ? error.message : String(error)}`),
  );
}
async function downloadEbook(input: EbookResult & { workId?: string }) {
  ensureMediaStorage();
  const id = ebookEditionId(input);
  const saved = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, id))
    .get();
  if (saved && existsSync(saved.source)) {
    await linkEbook(id, input.workId);
    return { id };
  }
  const ext = input.extension?.toLowerCase();
  if (!["epub", "pdf"].includes(ext || ""))
    throw new Error("Choose an EPUB or PDF ebook.");
  const stalled = new AbortController();
  const response = await fetchEbookFile(input, stalled.signal);
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
    // Only Library Genesis names a file by its md5; another source's key is its edition's.
    if ((input.source === "libgen" || input.source === "annas") && digest !== input.md5.toLowerCase())
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
    const left = sqlite.transaction(() => {
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
      return removePendingMembersLeftBehind(id, workId);
    })();
    await ebookSetMembersRemoved(left);
    prepareAhead(id, ext);
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
      return { ...b, ...ebookFile(row.source) };
    });
}
/** A file's size, or null when it is not there. */
const sizeOnDisk = (path: string) => (existsSync(path) ? statSync(path).size : null);
/**
 * An ebook edition's file as `GET /api/ebooks` gives it: its size (0 when it is not there) and
 * whether it is there. `sizeOf` replaces the look at the disk (the read by work remembers it).
 */
export function ebookFile(source: string, sizeOf: (path: string) => number | null = sizeOnDisk) {
  const size = sizeOf(source);
  return { size: size ?? 0, available: size !== null };
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
      await linkEbook(id, targetWorkId);
      return { id, alreadySaved: true };
    }
    path = join(ebookDir, `${id}.${ext}`);
    renameSync(temp, path);
    const left = sqlite.transaction(() => {
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
      return removePendingMembersLeftBehind(id, workId);
    })();
    await ebookSetMembersRemoved(left);
    prepareAhead(id, ext);
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
export async function saveEbook(given: EbookResult & { workId?: string }) {
  // The libgen.rs family's file is the libgen.li family's, by its md5: fetched and kept as that one.
  const input = given.source === "libgenrs" ? { ...given, source: "libgen" as const } : given;
  const key = ebookEditionId(input);
  if (ebookDownloads.has(key))
    throw new Error("This ebook is already downloading. Give it a moment.");
  ebookDownloads.add(key);
  try {
    return await downloadEbook(input);
  } finally {
    ebookDownloads.delete(key);
  }
}
