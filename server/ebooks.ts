import { parseSearchPage as parseAnnas } from "./sources/annas-archive-parse.ts";
import {
  parseSearchPage as parseLibgen,
  parseMirrorPage,
} from "./sources/libgen-parse.ts";
import { getSetting, getSecret } from "./services.ts";
import { ebookDir, ensureMediaStorage } from "./storage.ts";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { eq } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
import { join, basename, extname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
export type EbookSource = "annas" | "libgen";
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
function baseUrl(source: EbookSource) {
  return (
    getSetting(source === "annas" ? "annasUrl" : "libgenUrl") ||
    (source === "annas" ? "https://annas-archive.gl" : "https://libgen.li")
  );
}
let annaSession: { signature: string; cookie: string; expires: number } | null =
  null;
class AnnaBrowserRequired extends Error {
  constructor(public accountAccepted: boolean) {
    super("Anna’s Archive requires browser verification.");
  }
}
async function annaCookie(force = false) {
  const key = getSecret("annas");
  if (!key) return "";
  const base = baseUrl("annas");
  const signature = createHash("sha256")
    .update(base + key)
    .digest("hex");
  if (
    !force &&
    annaSession?.signature === signature &&
    annaSession.expires > Date.now()
  )
    return annaSession.cookie;
  const response = await fetch(`${base}/account/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
      Referer: `${base}/account/`,
    },
    body: new URLSearchParams({ key }),
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 403 || response.status === 429)
    throw new AnnaBrowserRequired(false);
  if (response.status >= 400)
    throw new Error(
      "Anna’s Archive could not sign in. Try again or open your account on the source website.",
    );
  const cookies = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => c.startsWith("aa_"))
    .join("; ");
  if (!cookies)
    throw new Error(
      "Anna’s Archive did not accept this account key. Check your secret key on the source account page.",
    );
  annaSession = {
    signature,
    cookie: cookies,
    expires: Date.now() + 30 * 60000,
  };
  return cookies;
}
async function page(url: string, source: EbookSource) {
  const cached = !!annaSession;
  let cookie = source === "annas" ? await annaCookie() : "";
  let response;
  try {
    const request = () =>
      fetch(url, {
        headers: {
          Accept: "text/html",
          "User-Agent": userAgent,
          Referer: baseUrl(source) + "/",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        redirect: source === "annas" ? "manual" : "follow",
        signal: AbortSignal.timeout(20000),
      });
    response = await request();
    const challenge = () =>
      response!.status === 403 ||
      /[?&]check=1/.test(response!.headers.get("location") || "");
    if (source === "annas" && challenge()) {
      // A paid session may have expired. Renew it once; a free account still
      // requires a real browser and must not be described as an invalid key.
      if (cached && cookie) {
        await response.body?.cancel();
        cookie = await annaCookie(true);
        response = await request();
      }
      if (challenge()) {
        await response.body?.cancel();
        throw new AnnaBrowserRequired(!!cookie);
      }
    }
  } catch (error) {
    if (error instanceof AnnaBrowserRequired) throw error;
    throw new Error(
      `${source === "annas" ? "Anna’s Archive" : "Library Genesis"} could not be reached. Try another mirror in Settings or open the source website.`,
    );
  }
  if (!response.ok)
    throw new Error(
      `${source === "annas" ? "Anna’s Archive" : "Library Genesis"} returned ${response.status}. This mirror may need browser verification.`,
    );
  const html = await response.text();
  if (
    source === "annas" &&
    /<title[^>]*>\s*(?:ddos-guard|just a moment|checking your browser)/i.test(
      html,
    )
  )
    throw new AnnaBrowserRequired(!!cookie);
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
): Promise<{
  files: EbookResult[];
  website: string;
  browserRequired?: boolean;
  accountAccepted?: boolean;
  notice?: string;
}> {
  const base = baseUrl(source);
  let url: string;
  if (source === "annas")
    url = `${base}/search?${new URLSearchParams({ q, ext: "epub", content: "book_any", page: String(pageNumber) })}`;
  else {
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
    url = `${base}/index.php?${params}`;
  }
  let html: string;
  try {
    html = await page(url, source);
  } catch (error) {
    if (!(error instanceof AnnaBrowserRequired)) throw error;
    return {
      files: [],
      website: url,
      browserRequired: true,
      accountAccepted: error.accountAccepted,
      notice: error.accountAccepted
        ? "Your account key was accepted. Anna’s Archive still requires browser verification; a non-member key does not skip this check. Continue your search in the browser, then import an EPUB or PDF here."
        : "Anna’s Archive requires browser verification. Continue your search in the browser, then import an EPUB or PDF here. A free account key does not skip this check.",
    };
  }
  const files =
    source === "annas"
      ? parseAnnas(html, base)
      : parseLibgen(html).map((f) => ({ ...f, coverUrl: null }));
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
      .map((f) => ({
        ...f,
        source,
        url:
          source === "annas"
            ? `${base}/md5/${f.md5}`
            : `${base}/ads.php?md5=${f.md5}`,
      })),
    website: url,
  };
}
function privateAddress(ip: string) {
  const value = ip.toLowerCase();
  if (value.includes(":"))
    return (
      value === "::1" ||
      value === "::" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe80:") ||
      value.startsWith("::ffff:")
    );
  const parts = ip.split(".").map(Number);
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] >= 224 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
  );
}
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
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
    if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
      throw new Error(
        "Downloads from private network addresses are not allowed.",
      );
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
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
async function resolveDownload(source: EbookSource, md5: string) {
  const base = baseUrl(source);
  if (source === "annas") {
    const key = getSecret("annas");
    if (!key)
      throw new Error(
        "Add your Anna’s Archive member key in Settings for direct downloads, or open the source website to download manually.",
      );
    let response;
    try {
      response = await fetch(
        `${base}/dyn/api/fast_download.json?${new URLSearchParams({ md5, key })}`,
        {
          headers: { Accept: "application/json", "User-Agent": userAgent },
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new Error("Anna’s Archive could not be reached.");
    }
    const body = (await response.json().catch(() => ({}))) as {
      download_url?: string;
      error?: string;
    };
    if (!response.ok || !body.download_url)
      throw new Error(
        "Anna’s Archive could not provide a fast download. This API requires an active membership and available quota. Open the source page for free downloads, then import the file here.",
      );
    return body.download_url.replace(/^http:/i, "https:");
  }
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
  if (db.select().from(s.ebookEditions).where(eq(s.ebookEditions.id, id)).get())
    return { id };
  const ext = input.extension?.toLowerCase();
  if (!["epub", "pdf"].includes(ext || ""))
    throw new Error("Choose an EPUB or PDF ebook.");
  const url = await resolveDownload(input.source, input.md5);
  const response = await publicFetch(url, {
    headers: {
      "User-Agent": userAgent,
      Referer: baseUrl(input.source) + "/",
      "Accept-Encoding": "identity",
    },
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
  try {
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
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
    );
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
        .run();
    })();
    return { id };
  } catch (error) {
    writer.destroy();
    if (existsSync(temp)) unlinkSync(temp);
    if (
      existsSync(path) &&
      !db.select().from(s.ebookEditions).where(eq(s.ebookEditions.id, id)).get()
    )
      unlinkSync(path);
    throw error;
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
    if (existing && existsSync(existing.source))
      return { id, alreadySaved: true };
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
          set: { source: path!, format: ext },
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
