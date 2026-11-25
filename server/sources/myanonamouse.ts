// MyAnonamouse (#911): a private tracker for audiobooks and ebooks, searched through its JSON API with the member's
// session (the `mam_id` cookie a member makes in MAM's preferences for API use; Settings › Sources keeps it encrypted).
//
// MAM's rule 1.7: only the site functions its API Documentation lists (or its admins approve) may be automated, by any
// means; nothing is scraped, and nobody signs in with an email or a password. So every request Sonder makes to MAM goes
// through `mamRequest` below, built only from `MAM_ENDPOINTS`, the one allow-list, checked against the documentation.
// The calls are few and spaced: a search when the owner searches, one search and one `.torrent` per book the series
// queue gets, never a crawl and never a loop.
//
// The answers the parser is built on are real ones, recorded with the owner's session on 2026-11-25 and kept with the
// session, the download token, the passkey and the user id replaced (`tests/fixtures/myanonamouse/`).
import { db } from "../db.ts";
import { settings } from "../schema.ts";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "../security.ts";
import { languageCode, languageDisplayName } from "../release-language.ts";
import { createSourceClient, LibgenAnswerError, type LibgenTiming } from "./libgen-client.ts";
import type { AudiobookRelease, EbookResult } from "../../src/types.ts";

/**
 * Every MAM address Sonder calls, and nothing else: four of the functions MAM's API Documentation (api/list.php) lists,
 * as the owner read them from it on 2026-11-25. The list's other functions (Bonus Points Store, Load User Data, User
 * Bonus History, the IP information endpoint, JSON fast fillout) are not used, the Millionaire's Vault may never be
 * automated, and no HTML page of the site is fetched.
 */
export const MAM_ENDPOINTS = {
  /**
   * "Torrent Search (JSON)": `tor[text]`, `tor[main_cat][]` (13 audiobooks, 14 ebooks), `tor[id]` for one torrent,
   * `dlLink` for each row's download token.
   */
  search: { url: "https://www.myanonamouse.net/tor/js/loadSearchJSONbasic.php", confirmed: true },
  /** "Download Torrent": a torrent's `.torrent` (it carries the member's passkey), by the search answer's `dl`. */
  download: { url: "https://www.myanonamouse.net/tor/download.php/", confirmed: true },
  /**
   * "Dynamic Seedbox IP": the seeding address of the torrent client (the VPN's exit address), set with the VPN's own
   * session from inside the VPN. Not called by the server: `scripts/mam-dynamic-seedbox.sh` calls it on the host in the
   * torrent container's network, at most once an hour and only when the exit address changed.
   */
  dynamicSeedbox: { url: "https://t.myanonamouse.net/json/dynamicSeedbox.php", confirmed: true },
  /** "IP and ASN lookup": the address MAM sees, asked by the same script from inside the VPN to tell a change. */
  ipLookup: { url: "https://t.myanonamouse.net/json/jsonIp.php", confirmed: true },
} as const;
export type MamEndpoint = keyof typeof MAM_ENDPOINTS;

/** MAM's main categories, as its search names them. */
export const MAM_CATEGORY = { audio: 13, ebook: 14 } as const;
export type MamKind = keyof typeof MAM_CATEGORY;

/** A torrent's page on MAM, for the owner to open in his browser (never fetched by Sonder). */
export const mamTorrentPage = (id: number | string) => `https://www.myanonamouse.net/t/${id}`;

export const MAM_NAME = "MyAnonamouse";
export const MAM_REFUSED =
  "MyAnonamouse refused the session. Make a new session in MyAnonamouse’s preferences (Security) and paste its mam_id in Settings.";
export const MAM_UNCONFIGURED = "Enter the MyAnonamouse session in Settings first.";
export const MAM_NO_TORRENT = "MyAnonamouse no longer lists this torrent.";

/** MAM answered that the session is not signed in (403, "Invalid/missing cookie"): not retried, said in Settings. */
export class MamRefusedError extends Error {
  readonly statusCode = 502;
  readonly code = "mam_refused";
  constructor() {
    super(MAM_REFUSED);
  }
}

/** One search result, as the search answers it (`loadSearchJSONbasic.php`, fields as recorded). */
export type MamRelease = {
  id: number;
  title: string;
  authors: string[];
  narrators: string[];
  series: { name: string; position: string | null }[];
  /** "738.5 MiB", as MAM writes it. */
  size: string | null;
  sizeBytes: number | null;
  /** MAM's `filetype`: "m4b", "mp3", "azw3 epub mobi". */
  format: string | null;
  /** The language's name ("English"), from MAM's three-letter `lang_code`. */
  language: string | null;
  langCode: string | null;
  seeders: number | null;
  leechers: number | null;
  completed: number | null;
  /** 13 audiobooks, 14 ebooks. */
  mainCat: number | null;
  category: string | null;
  files: number | null;
  /** "2024-12-03 06:51:45", MAM's upload time. */
  added: string | null;
  tags: string | null;
  /** Freeleech for everyone (`free`) or for VIPs. */
  freeleech: boolean;
  /** The length its media info names ("13:31:33"), in milliseconds; null when it names none. */
  lengthMs: number | null;
  /** A bitrate the tags name ("128 kbps"). */
  bitrate: string | null;
  url: string;
};

/** MAM's search answer: its rows and how many it found. */
export type MamSearch = { results: MamRelease[]; found: number; total: number };

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null);

/** A field MAM sends as a JSON string: its value, or undefined when it is not JSON. Any other error is a bug and throws. */
function jsonField(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** A field MAM sends as a JSON string of `{ id: name }` (`author_info`, `narrator_info`): the names. */
function names(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = jsonField(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.values(parsed as Record<string, unknown>).flatMap((name) => (text(name) ? [text(name)!] : []));
}

/** `series_info`: `{ id: [name, "1", 1.0] }`. */
function series(value: unknown): MamRelease["series"] {
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = jsonField(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.values(parsed as Record<string, unknown>).flatMap((entry) => {
    if (!Array.isArray(entry) || !text(entry[0])) return [];
    return [{ name: text(entry[0])!, position: text(entry[1]) }];
  });
}

const UNITS: Record<string, number> = { b: 0, k: 1, m: 2, g: 3, t: 4 };
function bytes(size: string | null) {
  const match = /([\d.]+)\s*([kmgt]?)i?b/i.exec(size ?? "");
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1024 ** UNITS[match[2].toLowerCase() || "b"]) : null;
}

/** The length in `mediainfo` (`General.Duration`, "13:31:33"), in milliseconds. */
function lengthOf(mediainfo: unknown): number | null {
  if (typeof mediainfo !== "string" || !mediainfo.includes("Duration")) return null;
  const duration = (jsonField(mediainfo) as { General?: { Duration?: unknown } } | undefined)?.General?.Duration;
  const match = typeof duration === "string" ? /^(\d+):(\d{2}):(\d{2})$/.exec(duration.trim()) : null;
  if (!match) return null;
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000;
}

/** MAM's three-letter code ("ENG", "GER", "POL") as the language's name; a code no table knows stays as it is. */
export function mamLanguage(code: string | null) {
  if (!code) return null;
  const known = languageCode(code);
  return known ? languageDisplayName(known) : code;
}

/** One row of the answer; null for one without an id or a title. */
export function parseMamRow(row: unknown): (MamRelease & { dl: string | null }) | null {
  const value = (row ?? {}) as Record<string, unknown>;
  const id = count(value.id);
  const title = text(value.title);
  if (!id || !title) return null;
  const size = text(value.size);
  const langCode = text(value.lang_code);
  const tags = text(value.tags);
  const kbps = /(\d{2,3})\s*kbps/i.exec(tags ?? "");
  return {
    id,
    title,
    authors: names(value.author_info),
    narrators: names(value.narrator_info),
    series: series(value.series_info),
    size,
    sizeBytes: bytes(size),
    format: text(value.filetype),
    language: mamLanguage(langCode),
    langCode,
    seeders: count(value.seeders),
    leechers: count(value.leechers),
    completed: count(value.times_completed),
    mainCat: count(value.main_cat),
    category: text(value.catname),
    files: count(value.numfiles),
    added: text(value.added),
    tags,
    freeleech: value.free === 1 || value.personal_freeleech === 1,
    lengthMs: lengthOf(value.mediainfo),
    bitrate: kbps ? `${kbps[1]} kbps` : null,
    url: mamTorrentPage(id),
    dl: text(value.dl),
  };
}

/**
 * The search's answer: `{ perpage, start, data, total, found }`, or `{ error: "Nothing returned, out of 0" }` when it
 * found nothing. Any other shape is MAM answering something Sonder does not know: an error, not an empty list.
 */
export function parseMamSearch(body: string): MamSearch & { tokens: Map<number, string> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new LibgenAnswerError(`${MAM_NAME} did not answer with search results.`, { cause: error });
  }
  const value = (parsed ?? {}) as Record<string, unknown>;
  if (typeof value.error === "string" && /^nothing returned/i.test(value.error.trim()))
    return { results: [], found: 0, total: 0, tokens: new Map() };
  if (!Array.isArray(value.data)) throw new LibgenAnswerError(`${MAM_NAME}: ${text(value.error) ?? "the search answered no results."}`);
  const tokens = new Map<number, string>();
  const results: MamRelease[] = [];
  for (const row of value.data) {
    const parsedRow = parseMamRow(row);
    if (!parsedRow) continue;
    const { dl, ...release } = parsedRow;
    if (dl) tokens.set(release.id, dl);
    results.push(release);
  }
  return { results, found: count(value.found) ?? results.length, total: count(value.total) ?? results.length, tokens };
}

/**
 * The `mam_id` a `Set-Cookie` of MAM's answer carries: MAM hands back a renewed session with each answer. Kept as it
 * came (not decoded), as a browser sends a cookie back: decoding "%2B" to "+" would make it another value to PHP.
 */
export function renewedSession(setCookies: readonly string[]): string | null {
  for (const cookie of setCookies) {
    const match = /^\s*mam_id=([^;\s]+)/.exec(cookie);
    if (match && match[1] && match[1] !== "deleted") return match[1];
  }
  return null;
}

/** MAM's own pacing: one request at a time, spaced; one more try after a wait; a rest after a limited request. */
export const MAM_TIMING: LibgenTiming = {
  spacing: { search: 3_000, download: 6_000 },
  waits: [15_000],
  mirrorsPerRequest: 1,
  rests: [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000],
};
const TEST_TIMING: LibgenTiming = { spacing: { search: 0, download: 0 }, waits: [0], mirrorsPerRequest: 1, rests: [0] };

export type MamClientDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The member's session; undefined when none is saved. */
  session: () => string | undefined;
  /** MAM renewed the session (`Set-Cookie: mam_id=…`): keep the new one. */
  saveSession?: (session: string) => void;
  /** MAM refused the session (true) or accepted it (false): Settings says so. */
  noteRefused?: (refused: boolean) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  timing?: LibgenTiming;
};

/** How long a search's download tokens are kept for a Get of one of its rows (not over a restart). */
const TOKEN_MS = 6 * 3600_000;

export function createMamClient(deps: MamClientDeps) {
  const now = deps.now ?? Date.now;
  const source = createSourceClient({
    fetch: deps.fetch,
    mirror: () => null,
    mirrors: ["https://www.myanonamouse.net"],
    name: MAM_NAME,
    now,
    sleep: deps.sleep,
    log: deps.log,
    timing: deps.timing ?? (process.env.NODE_ENV === "test" ? TEST_TIMING : MAM_TIMING),
    unreachable: `${MAM_NAME} could not be reached.`,
    // 403 "Error, you are not signed in <br />Invalid/missing cookie": the session is refused; a retry would not pass.
    verification: (response, body) => (response.status === 403 && /not signed in|invalid\/missing cookie/i.test(body ?? "") ? new MamRefusedError() : null),
  });
  const tokens = new Map<number, { dl: string; expires: number }>();

  /** The one way to MAM: an allow-listed endpoint, the session as the `mam_id` cookie, spaced and backed off. */
  async function mamRequest(endpoint: "search" | "download", suffix: string, read: boolean) {
    const session = deps.session();
    if (!session) throw new Error(MAM_UNCONFIGURED);
    const base = MAM_ENDPOINTS[endpoint].url;
    const url = `${base}${suffix}`;
    if (!url.startsWith(base)) throw new Error("Not an allowed MyAnonamouse address.");
    let answer;
    try {
      answer = await source.request(endpoint === "search" ? "search" : "download", url, {
        read,
        headers: { Cookie: `mam_id=${session}`, "User-Agent": "Sonder", Accept: endpoint === "search" ? "application/json" : "application/x-bittorrent" },
        timeoutMs: 20_000,
      });
    } catch (error) {
      if (error instanceof MamRefusedError) deps.noteRefused?.(true);
      throw error;
    }
    deps.noteRefused?.(false);
    const renewed = renewedSession(answer.response.headers.getSetCookie?.() ?? []);
    if (renewed && renewed !== session) deps.saveSession?.(renewed);
    return answer;
  }

  function remember(found: Map<number, string>) {
    const expires = now() + TOKEN_MS;
    for (const [id, dl] of found) tokens.set(id, { dl, expires });
    for (const [id, entry] of tokens) if (entry.expires <= now() || tokens.size > 5000) tokens.delete(id);
  }

  function searchParams(entries: [string, string][]) {
    const params = new URLSearchParams(entries);
    return `?${params.toString()}`;
  }

  /** A search of one main category for the words, by title and author: its first `perpage` rows. */
  async function search(query: string, kind: MamKind, { perpage = 50, start = 0 } = {}): Promise<MamSearch> {
    const words = query.trim();
    if (words.length < 2) throw new Error("Enter at least two characters to search.");
    const { body } = await mamRequest(
      "search",
      searchParams([
        ["tor[text]", words],
        ["tor[srchIn][title]", "true"],
        ["tor[srchIn][author]", "true"],
        ["tor[searchType]", "all"],
        ["tor[main_cat][]", String(MAM_CATEGORY[kind])],
        ["tor[startNumber]", String(Math.max(0, Math.floor(start)))],
        ["perpage", String(Math.min(100, Math.max(5, Math.floor(perpage))))],
        ["dlLink", "true"],
      ]),
      true,
    );
    const { tokens: found, ...answer } = parseMamSearch(body ?? "");
    remember(found);
    // The other main categories' rows (a search may list a few) are not this kind's.
    return { ...answer, results: answer.results.filter((release) => release.mainCat === null || release.mainCat === MAM_CATEGORY[kind]) };
  }

  /** One torrent by its id (the search's `tor[id]`), with its download token. */
  async function torrent(id: number): Promise<MamRelease | null> {
    const { body } = await mamRequest("search", searchParams([["tor[id]", String(id)], ["dlLink", "true"]]), true);
    const { results, tokens: found } = parseMamSearch(body ?? "");
    remember(found);
    return results.find((release) => release.id === id) ?? null;
  }

  /** A torrent's `.torrent` file: by the token of a recent search, else the torrent is looked up by its id first. */
  async function torrentFile(id: number): Promise<Buffer> {
    let token = tokens.get(id);
    if (!token || token.expires <= now()) {
      await torrent(id);
      token = tokens.get(id);
    }
    if (!token) throw new Error(MAM_NO_TORRENT);
    // The token is a path segment of the download endpoint, as the search answers it ("<token>?tid=<id>"), nothing else.
    if (!/^[A-Za-z0-9_-]{8,400}(\?tid=\d{1,12})?$/.test(token.dl)) throw new Error(`${MAM_NAME} answered an unknown download link.`);
    const { response } = await mamRequest("download", token.dl, false);
    const type = response.headers.get("content-type") ?? "";
    const data = Buffer.from(await response.arrayBuffer());
    // A torrent file is a bencoded dictionary; a page in its place (a refusal, a notice) is not one.
    if (!/bittorrent|octet-stream/i.test(type) && data[0] !== 0x64) throw new Error(`${MAM_NAME} did not give the torrent file.`);
    if (data.length > 10 * 1024 * 1024) throw new Error(`${MAM_NAME}'s torrent file is too large.`);
    return data;
  }

  return { search, torrent, torrentFile, restingUntil: source.restingUntil };
}

const SESSION_KEY = "mam";
const REFUSED_KEY = "mamRefusedAt";

function writeSetting(key: string, value: string) {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}
function readSetting(key: string) {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

/** Whether a MAM session is saved in Settings. */
export const mamConfigured = () => !!readSetting(SESSION_KEY);
/** A session is saved and MAM has not refused it: the series queue asks MAM only then. */
export const mamUsable = () => mamConfigured() && mamRefusedAt() === null;
/** When MAM last refused the saved session; null when it has not since the session was saved or last accepted. */
export function mamRefusedAt(): number | null {
  const value = Number(readSetting(REFUSED_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}
/** A new session saved in Settings: MAM has not refused it yet. */
export function clearMamRefused() {
  db.delete(settings).where(eq(settings.key, REFUSED_KEY)).run();
}

let client: ReturnType<typeof createMamClient> | null = null;
/** The server's one MAM client: the session saved in Settings, its renewals kept there encrypted. */
export function mam() {
  client ??= createMamClient({
    fetch: (url, init) => fetch(url, init),
    session: () => {
      const value = readSetting(SESSION_KEY);
      return value ? decrypt(value) : undefined;
    },
    saveSession: (session) => writeSetting(SESSION_KEY, encrypt(session)),
    noteRefused: (refused) => {
      if (refused) writeSetting(REFUSED_KEY, String(Date.now()));
      else if (readSetting(REFUSED_KEY)) clearMamRefused();
    },
  });
  return client;
}

/** A test's own client in place of the server's (null restores it). */
export function setMamClient(next: ReturnType<typeof createMamClient> | null) {
  client = next;
}

/**
 * A MyAnonamouse torrent's link inside Sonder: `mam:<torrent id>`, passed where other sources pass a magnet. It is no
 * magnet: its `.torrent` (MAM's own, with the member's passkey) is fetched when it is added, by the local client only.
 */
export const mamLink = (id: number | string) => `mam:${id}`;
export function mamLinkId(link: string): string | null {
  return /^mam:(\d{1,12})$/.exec(link.trim())?.[1] ?? null;
}

/** A MAM row's id in the Get audiobook sheet and its add route: `mam-<torrent id>`. */
export const mamReleaseId = (id: number) => `mam-${id}`;
export function mamIdOf(releaseId: string): number | null {
  const match = /^mam-(\d{1,12})$/.exec(releaseId.trim());
  return match ? Number(match[1]) : null;
}

/** A MAM audiobook as the Get audiobook sheet's row (the shape of AudioBookBay's and Prowlarr's). */
export function mamAudiobookRelease(release: MamRelease): AudiobookRelease & { lengthMs: number | null } {
  return {
    id: mamReleaseId(release.id),
    title: release.title,
    author: release.authors.join(", "),
    url: release.url,
    language: release.language,
    narrator: release.narrators.join(", ") || null,
    format: release.format ? release.format.toUpperCase() : null,
    bitrate: release.bitrate,
    size: release.size,
    posted: release.added,
    uploader: null,
    description: "",
    source: "mam",
    indexer: MAM_NAME,
    seeders: release.seeders,
    leechers: release.leechers,
    sizeBytes: release.sizeBytes,
    infoHash: null,
    // A private torrent is never sent to TorBox, so it is never "Plays now".
    cached: false,
    lengthMs: release.lengthMs,
  };
}

/** A MAM ebook's key in the Get ebook sheet (`EbookResult.md5`, 32 hex): its torrent id, in hex, padded. */
export const mamEbookKey = (id: number) => id.toString(16).padStart(32, "0");
export function mamIdOfEbookKey(key: string): number | null {
  if (!/^[0-9a-f]{32}$/i.test(key)) return null;
  const id = Number.parseInt(key, 16);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A MAM ebook as the Get ebook sheet's row: an EPUB, else a PDF; a torrent of neither (only MOBI, CBZ) is no row. */
export function mamEbookResult(release: MamRelease): EbookResult | null {
  const formats = (release.format ?? "").toLowerCase().split(/[\s,]+/);
  const extension = formats.includes("epub") ? "epub" : formats.includes("pdf") ? "pdf" : null;
  if (!extension) return null;
  return {
    md5: mamEbookKey(release.id),
    source: "mam",
    indexer: MAM_NAME,
    seeders: release.seeders,
    cached: false,
    title: release.title,
    authors: release.authors,
    extension,
    language: release.language,
    size: release.size,
    year: null,
    coverUrl: null,
    url: release.url,
  };
}
