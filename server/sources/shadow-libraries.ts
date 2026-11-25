// The shadow libraries besides the libgen.li family (#901): Anna's Archive with the member key in Settings, Z-Library
// with the account in Settings, and the other Library Genesis family (libgen.is/.rs/.st). Each is asked through its
// own client with Library Genesis's manners (server/sources/libgen-client.ts: one at a time, spaced, a limiting
// answer retried with growing waits, then rested), and a browser check a later try would not pass is said plainly.
//
// What each answered on 2026-11-25 (tests/fixtures):
// - Anna's Archive: a search without a member session is redirected to `?check=1`, a DDoS-Guard browser check (403);
//   `/dyn/api/fast_download.json` answers 401 `{"download_url": null, "error": "Invalid secret key"}` for a bad key.
//   A free key never passed the check (#8); the owner's stored key was not tried from the test host.
// - Z-Library: `/eapi/user/login` answers 400 `{"success":0,"error":"Incorrect email or password"}`,
//   `/eapi/user/profile` 400 `{"success":0,"error":"Please login"}`, and an anonymous `/eapi/book/search` DiamWall's
//   browser check (513). Searching and downloading signed in follow its app API (`/eapi/book/search`,
//   `/eapi/book/<id>/<hash>/file`, `/eapi/user/profile`); they were not tried with an account.
// - libgen.is/.rs/.st did not answer from the test host; their page is the Wayback Machine's copy (libgen-rs-parse.ts).
import { createHash } from "node:crypto";
import { getSecret, getSetting } from "../services.ts";
import { publicFetch } from "../public-fetch.ts";
import { parseSearchPage as parseAnnas } from "./annas-archive-parse.ts";
import { LIBGEN_RS_MIRRORS, parseLibgenRsSearch } from "./libgen-rs-parse.ts";
import { createSourceClient, sourceTiming, SourceVerificationError } from "./libgen-client.ts";

export type ShadowSource = "annas" | "zlib" | "libgenrs";

/** A result in the shape of server/ebooks.ts `EbookResult`. */
export type ShadowResult = {
  md5: string;
  source: ShadowSource;
  title: string;
  authors: string[];
  extension: string | null;
  language: string | null;
  size: string | null;
  year: string | null;
  coverUrl: string | null;
  url: string;
};

const fetchPublic = (url: string, init: RequestInit) => publicFetch(url, init);
const ebookOnly = (extension: string | null | undefined) => extension === "epub" || extension === "pdf";

// ---------------------------------------------------------------------------------------------- Anna's Archive

export const ANNAS_DEFAULT_URL = "https://annas-archive.gl";
export const ANNAS_NAME = "Anna’s Archive";
export const ANNAS_NO_KEY = "Add your Anna’s Archive key in Settings first.";
export const ANNAS_REFUSED = "Anna’s Archive refused the key in Settings.";
export const ANNAS_CHECK = "Anna’s Archive asks for browser verification, which only a member key passes.";

export const annasConfigured = () => !!getSetting("annas");
const annasBase = () => getSetting("annasUrl") || ANNAS_DEFAULT_URL;

export const annas = createSourceClient({
  name: ANNAS_NAME,
  mirrors: [ANNAS_DEFAULT_URL],
  mirror: () => getSetting("annasUrl"),
  fetch: fetchPublic,
  timing: sourceTiming(),
  // Its check is a redirect to `?check=1`, then DDoS-Guard's page.
  verification: (response, body) =>
    /[?&]check=1/.test(response.headers.get("location") ?? "") ||
    /<title[^>]*>\s*(ddos-guard|just a moment|checking your browser)/i.test(body ?? "")
      ? new SourceVerificationError(ANNAS_CHECK)
      : null,
});

let annasSession: { signature: string; cookie: string; expires: number } | null = null;

/** The member session's cookies, signed in with the key in Settings (kept 30 minutes). */
async function annasCookie(force = false) {
  const key = getSecret("annas");
  if (!key) throw new Error(ANNAS_NO_KEY);
  const signature = createHash("sha256").update(annasBase() + key).digest("hex");
  if (!force && annasSession?.signature === signature && annasSession.expires > Date.now()) return annasSession.cookie;
  const { response } = await annas.request("search", "account/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body: new URLSearchParams({ key }),
    redirect: "manual",
    accept: (status) => status < 400,
    timeoutMs: 20000,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .filter((value) => value.startsWith("aa_"))
    .join("; ");
  if (!cookie) throw new Error(ANNAS_REFUSED);
  annasSession = { signature, cookie, expires: Date.now() + 30 * 60_000 };
  return cookie;
}

export async function searchAnnas(q: string): Promise<{ files: ShadowResult[]; website: string }> {
  const path = `search?${new URLSearchParams([["q", q], ["content", "book_any"], ["ext", "epub"], ["ext", "pdf"]])}`;
  const cached = !!annasSession;
  const ask = (cookie: string) =>
    annas.request("search", path, {
      headers: { Cookie: cookie, Accept: "text/html" },
      redirect: "manual",
      timeoutMs: 20000,
    });
  let answer: Awaited<ReturnType<typeof ask>>;
  try {
    answer = await ask(await annasCookie());
  } catch (error) {
    // A member session may have expired: it is signed in again once.
    if (!(error instanceof SourceVerificationError) || !cached) throw error;
    answer = await ask(await annasCookie(true));
  }
  // The links name the mirror that answered.
  const base = answer.mirror;
  const html = answer.body ?? "";
  return {
    files: parseAnnas(html, base)
      .filter((file) => ebookOnly(file.extension))
      .slice(0, 50)
      .map((file) => ({
        md5: file.md5,
        source: "annas" as const,
        title: file.title,
        authors: file.authors,
        extension: file.extension,
        language: file.language,
        size: file.size,
        year: file.year,
        coverUrl: file.coverUrl,
        url: `${base}/md5/${file.md5}`,
      })),
    website: `${base}/${path}`,
  };
}

/** The file's fast-download address, from the member API; a refusal says why (a bad key, no membership, no quota). */
export async function annasDownload(md5: string) {
  const key = getSecret("annas");
  if (!key) throw new Error(ANNAS_NO_KEY);
  const { response, body } = await annas.request("download", `dyn/api/fast_download.json?${new URLSearchParams({ md5, key })}`, {
    headers: { Accept: "application/json" },
    accept: (status) => status >= 400 && status < 500,
    timeoutMs: 20000,
  });
  let answer: { download_url?: string | null; error?: string };
  try {
    answer = JSON.parse(body ?? "") as typeof answer;
  } catch (error) {
    throw new Error(`${ANNAS_NAME} answered something other than its download API.`, { cause: error });
  }
  if (answer.error === "Invalid secret key") throw new Error(ANNAS_REFUSED);
  if (!response.ok || !answer.download_url)
    throw new Error(
      `${ANNAS_NAME} gave no fast download${answer.error ? ` (${answer.error})` : ""}. Fast downloads need a membership with downloads left.`,
    );
  return answer.download_url.replace(/^http:/i, "https:");
}

/** Settings' check of the key: signed in and searched once; the answer says what Anna's Archive said. */
export async function testAnnas() {
  annasSession = null;
  await searchAnnas("the");
  return { ok: true as const };
}

// ---------------------------------------------------------------------------------------------------- Z-Library

export const ZLIB_DEFAULT_URL = "https://z-library.sk";
export const ZLIB_NAME = "Z-Library";
export const ZLIB_NO_ACCOUNT = "Add your Z-Library account in Settings first.";
export const ZLIB_REFUSED = "Z-Library refused the login in Settings.";
export const ZLIB_CHECK = "Z-Library asks for browser verification.";

const zlibBase = () => getSetting("zlibUrl") || ZLIB_DEFAULT_URL;

/** A remember-me token as the site's cookies give it (`remix_userid=1; remix_userkey=abc`) or as `1:abc`. */
export function parseZlibToken(token: string | null | undefined) {
  const text = token?.trim() ?? "";
  const id = /remix_userid=([0-9]+)/.exec(text)?.[1] ?? /^([0-9]+):/.exec(text)?.[1];
  const key = /remix_userkey=([0-9a-f]+)/i.exec(text)?.[1] ?? /^[0-9]+:([0-9a-f]+)$/i.exec(text)?.[1];
  return id && key ? { userId: id, userKey: key } : null;
}

export const zlibConfigured = () =>
  !!parseZlibToken(getSecret("zlibToken")) || (!!getSetting("zlibEmail") && !!getSetting("zlibPassword"));

export const zlib = createSourceClient({
  name: ZLIB_NAME,
  mirrors: [ZLIB_DEFAULT_URL],
  mirror: () => getSetting("zlibUrl"),
  fetch: fetchPublic,
  timing: sourceTiming(),
  // DiamWall: a 513 "Verifying your browser" page (or its redirect to set its cookie).
  verification: (response, body) =>
    response.status === 513 || /<title>[^<]*DiamWall/i.test(body ?? "") ? new SourceVerificationError(ZLIB_CHECK) : null,
});

let zlibSession: { signature: string; cookie: string } | null = null;

type ZlibAnswer = { success?: number; error?: string; [key: string]: unknown };

async function zlibJson(kind: "search" | "download", path: string, init: { method?: string; body?: URLSearchParams; cookie?: string } = {}) {
  const { response, body } = await zlib.request(kind, path, {
    method: init.method,
    body: init.body,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(init.cookie ? { Cookie: init.cookie } : {}),
    },
    // Its refusals are 400s with a reason.
    accept: (status) => status === 400 || status === 401 || status === 403,
    timeoutMs: 20000,
  });
  try {
    return { status: response.status, answer: JSON.parse(body ?? "") as ZlibAnswer };
  } catch (error) {
    throw new Error(`${ZLIB_NAME} answered something other than its app API.`, { cause: error });
  }
}

/** The account's cookies: the remember-me token as it is, else a sign-in with the email and password. */
async function zlibCookie(force = false) {
  const token = parseZlibToken(getSecret("zlibToken"));
  if (token) return `remix_userid=${token.userId}; remix_userkey=${token.userKey}`;
  const email = getSecret("zlibEmail");
  const password = getSecret("zlibPassword");
  if (!email || !password) throw new Error(ZLIB_NO_ACCOUNT);
  const signature = createHash("sha256").update(`${zlibBase()}\n${email}\n${password}`).digest("hex");
  if (!force && zlibSession?.signature === signature) return zlibSession.cookie;
  const { answer } = await zlibJson("search", "eapi/user/login", { method: "POST", body: new URLSearchParams({ email, password }) });
  const user = answer.user as { id?: number | string; remix_userkey?: string } | undefined;
  if (answer.success !== 1 || !user?.id || !user.remix_userkey) throw new Error(ZLIB_REFUSED);
  const cookie = `remix_userid=${user.id}; remix_userkey=${user.remix_userkey}`;
  zlibSession = { signature, cookie };
  return cookie;
}

/** The book's page on Z-Library, which names it by id and hash: what a download is asked for by. */
export function zlibBook(page: string) {
  if (!URL.canParse(page)) return null;
  const url = new URL(page);
  const match = /^\/book\/([0-9]+)\/([0-9a-z]+)(?:\/|$)/i.exec(url.pathname);
  if (!match || url.origin !== new URL(zlibBase()).origin) return null;
  return { id: match[1], hash: match[2] };
}

export async function searchZlib(q: string): Promise<{ files: ShadowResult[]; website: string }> {
  const base = zlibBase();
  const body = new URLSearchParams([["message", q], ["limit", "30"], ["extensions[]", "epub"], ["extensions[]", "pdf"]]);
  let { answer } = await zlibJson("search", "eapi/book/search", { method: "POST", body, cookie: await zlibCookie() });
  // A session that is no longer signed in signs in again once.
  if (answer.success !== 1 && /login/i.test(answer.error ?? "")) ({ answer } = await zlibJson("search", "eapi/book/search", { method: "POST", body, cookie: await zlibCookie(true) }));
  if (answer.success !== 1) throw new Error(/login/i.test(answer.error ?? "") ? ZLIB_REFUSED : `${ZLIB_NAME}: ${answer.error ?? "no answer"}.`);
  const books = Array.isArray(answer.books) ? (answer.books as Record<string, unknown>[]) : [];
  const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value).trim() || null : null);
  return {
    files: books.flatMap((book) => {
      const id = text(book.id);
      const hash = text(book.hash);
      const extension = text(book.extension)?.toLowerCase() ?? null;
      const title = text(book.title);
      if (!id || !/^[0-9]+$/.test(id) || !hash || !/^[0-9a-z]+$/i.test(hash) || !title || !ebookOnly(extension)) return [];
      const page = `${base}/book/${id}/${hash}`;
      const cover = text(book.cover);
      return [
        {
          md5: createHash("md5").update(`zlib:${id}:${hash}`).digest("hex"),
          source: "zlib" as const,
          title,
          authors: (text(book.author) ?? "").split(/[,;]/).flatMap((name) => name.trim() || []),
          extension,
          language: text(book.language),
          size: text(book.filesizeString),
          year: text(book.year)?.match(/\b(?:1[5-9]|20)\d\d\b/)?.[0] ?? null,
          coverUrl: cover?.startsWith("https://") ? cover : null,
          url: page,
        },
      ];
    }),
    website: `${base}/s/${encodeURIComponent(q)}`,
  };
}

/** The account's downloads today and its daily limit, as its profile says. */
export async function zlibLimits() {
  const { answer } = await zlibJson("search", "eapi/user/profile", { cookie: await zlibCookie() });
  if (answer.success !== 1) throw new Error(/login/i.test(answer.error ?? "") ? ZLIB_REFUSED : `${ZLIB_NAME}: ${answer.error ?? "no answer"}.`);
  const user = (answer.user ?? {}) as { downloads_today?: unknown; downloads_limit?: unknown };
  const used = Number(user.downloads_today);
  const limit = Number(user.downloads_limit);
  return { used: Number.isFinite(used) ? used : null, limit: Number.isFinite(limit) ? limit : null };
}

/** The sentence Settings shows for the account's limit. */
export const zlibLimitLine = ({ used, limit }: { used: number | null; limit: number | null }) =>
  used !== null && limit !== null ? `${used} of ${limit} downloads today.` : "Signed in.";

/** The file's address for a book page, through the account; a reached daily limit is said with its numbers. */
export async function zlibDownload(page: string) {
  const book = zlibBook(page);
  if (!book) throw new Error("This Z-Library link is not a book page of the address in Settings.");
  const limits = await zlibLimits();
  if (limits.used !== null && limits.limit !== null && limits.used >= limits.limit)
    throw new Error(`${ZLIB_NAME}'s daily download limit is reached (${limits.used} of ${limits.limit}).`);
  const { answer } = await zlibJson("download", `eapi/book/${book.id}/${book.hash}/file`, { cookie: await zlibCookie() });
  const file = answer.file as { downloadLink?: string } | undefined;
  if (answer.success !== 1 || !file?.downloadLink) throw new Error(`${ZLIB_NAME} gave no download${answer.error ? ` (${answer.error})` : ""}.`);
  return file.downloadLink.replace(/^http:/i, "https:");
}

/** Settings' check of the account: signed in again and its limit read. */
export async function testZlib() {
  zlibSession = null;
  const limits = await zlibLimits();
  return { ok: true as const, ...limits, line: zlibLimitLine(limits) };
}

// ------------------------------------------------------------------------------- The other Library Genesis family

export const LIBGEN_RS_NAME = "Library Genesis (libgen.rs)";

export const libgenRs = createSourceClient({
  name: LIBGEN_RS_NAME,
  mirrors: LIBGEN_RS_MIRRORS,
  mirror: () => null,
  fetch: fetchPublic,
  timing: sourceTiming(),
});

/** Its search; its files are fetched by md5 through the libgen.li family's download pages, as its own mirror links do. */
export async function searchLibgenRs(q: string): Promise<{ files: ShadowResult[]; website: string }> {
  const path = `search.php?${new URLSearchParams({ req: q, column: "def", res: "50" })}`;
  const { body, mirror } = await libgenRs.request("search", path, { headers: { Accept: "text/html" }, timeoutMs: 20000 });
  return {
    files: parseLibgenRsSearch(body ?? "")
      .filter((file) => ebookOnly(file.extension))
      .map((file) => ({
        md5: file.md5,
        source: "libgenrs" as const,
        title: file.title,
        authors: file.authors,
        extension: file.extension,
        language: file.language,
        size: file.size,
        year: file.year,
        coverUrl: null,
        url: `${mirror}/book/index.php?md5=${file.md5}`,
      })),
    website: `${mirror}/${path}`,
  };
}
