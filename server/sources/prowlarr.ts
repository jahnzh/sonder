import { createHash } from "node:crypto";
import type { AudiobookRelease } from "../../src/types.ts";
import { torrentToMagnet } from "./torrent.ts";

export const PROWLARR_CATEGORIES = [3030, 7000];
const audioTitle =
  /audio\s*book|audiobook|\bm4b\b|\bmp3\b|\baac\b|\bflac\b|unabridged|narrated|read by|kbps/i;

export type ProwlarrItem = {
  guid?: string;
  indexerId?: number;
  indexer?: string;
  title?: string;
  size?: number;
  seeders?: number | null;
  leechers?: number | null;
  publishDate?: string;
  downloadUrl?: string;
  magnetUrl?: string;
  infoHash?: string;
  infoUrl?: string;
  protocol?: string;
  categories?: { id: number }[];
};
// Download links embed the Prowlarr API key, so they stay on the server, keyed by release id.
export type ProwlarrLink = {
  title: string;
  magnetUrl: string | null;
  downloadUrl: string | null;
  infoHash: string | null;
};

export function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Enter the Prowlarr address, for example http://127.0.0.1:9696.");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function releaseFormat(title: string) {
  return /\bm4b\b/i.test(title)
    ? "M4B"
    : /\bmp3\b/i.test(title)
      ? "MP3"
      : /\bflac\b/i.test(title)
        ? "FLAC"
        : /\b(aac|m4a)\b/i.test(title)
          ? "AAC"
          : /\bopus\b/i.test(title)
            ? "Opus"
            : null;
}

export function parseProwlarrResults(items: unknown): {
  releases: AudiobookRelease[];
  links: Map<string, ProwlarrLink>;
} {
  const links = new Map<string, ProwlarrLink>();
  if (!Array.isArray(items)) return { releases: [], links };
  const releases = (items as ProwlarrItem[]).flatMap((item) => {
    if (!item || typeof item !== "object" || typeof item.title !== "string") return [];
    if (item.protocol && item.protocol !== "torrent") return [];
    const categories = (item.categories || []).map((category) => category.id);
    const audio = categories.some((id) => id === 3030);
    const book = categories.some((id) => id >= 7000 && id < 8000);
    if (!audio && !(book && audioTitle.test(item.title))) return [];
    const infoHash = /^[a-f0-9]{40}$/i.test(item.infoHash || "")
      ? item.infoHash!.toLowerCase()
      : null;
    const magnetUrl =
      typeof item.magnetUrl === "string" && /^(magnet:|https?:)/i.test(item.magnetUrl)
        ? item.magnetUrl
        : null;
    const downloadUrl =
      typeof item.downloadUrl === "string" && /^https?:/i.test(item.downloadUrl)
        ? item.downloadUrl
        : null;
    if (!infoHash && !magnetUrl && !downloadUrl) return [];
    const id =
      "prowlarr-" +
      createHash("sha256")
        .update(`${item.indexerId ?? item.indexer}:${item.guid || item.title}`)
        .digest("hex")
        .slice(0, 32);
    links.set(id, { title: item.title, magnetUrl, downloadUrl, infoHash });
    const size = Number.isFinite(item.size) && item.size! > 0 ? item.size! : null;
    const bitrate = /(\d{2,3})\s*kbps/i.exec(item.title)?.[1];
    const published = item.publishDate ? new Date(item.publishDate) : null;
    const infoUrl =
      typeof item.infoUrl === "string" && /^https?:\/\//i.test(item.infoUrl)
        ? item.infoUrl
        : typeof item.guid === "string" && /^https?:\/\//i.test(item.guid)
          ? item.guid
          : "";
    return [
      {
        id,
        source: "prowlarr" as const,
        indexer: item.indexer || "Prowlarr",
        title: item.title.replace(/\s+/g, " ").trim(),
        author: "",
        url: infoUrl,
        language: null,
        narrator: null,
        format: releaseFormat(item.title),
        bitrate: bitrate ? `${bitrate} Kbps` : null,
        size: size ? formatBytes(size) : null,
        sizeBytes: size,
        posted:
          published && !Number.isNaN(published.getTime())
            ? published.toISOString().slice(0, 10)
            : null,
        uploader: null,
        description: "",
        seeders: Number.isFinite(item.seeders) ? item.seeders! : null,
        leechers: Number.isFinite(item.leechers) ? item.leechers! : null,
        infoHash,
      },
    ];
  });
  return { releases, links };
}

export type ProwlarrConfig = { url: string; key: string };
async function request(
  config: ProwlarrConfig,
  path: string,
  timeout: number,
) {
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, {
      headers: { "X-Api-Key": config.key, Accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(
      (error as Error).name === "TimeoutError"
        ? "Prowlarr did not answer in time."
        : "Prowlarr could not be reached. Check its address in Settings.",
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new Error("Prowlarr rejected the API key. Check it in Settings.");
  if (!response.ok) throw new Error(`Prowlarr returned ${response.status}.`);
  return response.json().catch(() => {
    throw new Error("Prowlarr returned an unreadable response.");
  });
}

export async function prowlarrStatus(config: ProwlarrConfig) {
  const status = (await request(config, "/api/v1/system/status", 10000)) as {
    version?: string;
  };
  const indexers = (await request(config, "/api/v1/indexer", 10000)) as {
    enable?: boolean;
    protocol?: string;
  }[];
  return {
    version: status.version || "unknown",
    indexers: Array.isArray(indexers)
      ? indexers.filter((i) => i.enable && i.protocol === "torrent").length
      : 0,
  };
}

export async function prowlarrSearch(config: ProwlarrConfig, query: string) {
  const params = new URLSearchParams({ query, type: "search", limit: "100" });
  for (const category of PROWLARR_CATEGORIES)
    params.append("categories", String(category));
  return parseProwlarrResults(
    // Prowlarr waits for its slowest indexer; searches of 50 s have been seen on this server.
    await request(config, `/api/v1/search?${params}`, 90000),
  );
}

// Only Prowlarr itself is contacted: the stored link's path and query are replayed against the configured address.
export async function resolveProwlarrLink(
  config: ProwlarrConfig,
  link: ProwlarrLink,
) {
  let failure = new Error("Prowlarr did not provide a torrent for this release.");
  for (const candidate of [link.magnetUrl, link.downloadUrl]) {
    if (!candidate) continue;
    if (candidate.startsWith("magnet:")) return candidate;
    try {
      return await fetchProwlarrDownload(config, candidate);
    } catch (error) {
      failure = error as Error;
    }
  }
  // A bare hash still works for TorBox and DHT when the tracker list could not be fetched.
  if (link.infoHash)
    return `magnet:?xt=urn:btih:${link.infoHash}&dn=${encodeURIComponent(link.title)}`;
  throw failure;
}

export function prowlarrRequestUrl(config: ProwlarrConfig, returned: string) {
  const original = new URL(returned);
  const base = new URL(config.url);
  const basePath = base.pathname.replace(/\/+$/, "");
  if (basePath && !original.pathname.startsWith(basePath + "/"))
    throw new Error("This release link does not belong to the configured Prowlarr.");
  if (!/^\/\d+\/download$/.test(original.pathname.slice(basePath.length)))
    throw new Error("This release link does not belong to the configured Prowlarr.");
  return new URL(original.pathname + original.search, base.origin).href;
}

async function fetchProwlarrDownload(config: ProwlarrConfig, returned: string) {
  const url = prowlarrRequestUrl(config, returned);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "X-Api-Key": config.key },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error("Prowlarr could not fetch this torrent. Try another release.");
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") || "";
    if (location.startsWith("magnet:")) return location;
    throw new Error("Prowlarr redirected this release elsewhere. Try another release.");
  }
  if (!response.ok)
    throw new Error(`Prowlarr could not fetch this torrent (${response.status}).`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 10 * 1024 * 1024) throw new Error("This torrent file is too large.");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 10 * 1024 * 1024) throw new Error("This torrent file is too large.");
  const text = body.subarray(0, 2048).toString("utf8").trim();
  if (text.startsWith("magnet:")) return text.split(/\s/)[0];
  return torrentToMagnet(body).magnet;
}

// Release names carry format tags; strip them for a library title when no book was chosen.
export function releaseDisplayTitle(title: string) {
  const cleaned = title
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ")
    .replace(/\b(audio\s*book|audiobook|unabridged|m4b|mp3|aac|flac|\d{2,3}\s*kbps)\b/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+-\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned.slice(0, 300) : title.slice(0, 300);
}
