import { ProxyAgent } from "undici";
import { parse } from "node-html-parser";
import { db } from "./db.ts";
import { settings } from "./schema.ts";
import { eq } from "drizzle-orm";
import { decrypt } from "./security.ts";
import type { AudiobookRelease } from "../src/types.ts";
import { createHash } from "node:crypto";
import { retryDelayFromHeader } from "./media-response.ts";
import {
  prowlarrSearch,
  prowlarrEbookSearchRaw,
  resolveProwlarrLink,
  type ProwlarrLink,
} from "./sources/prowlarr.ts";
export function getSetting(key: string) {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value;
}
export function getSecret(key: string) {
  const value = getSetting(key);
  return value ? decrypt(value) : undefined;
}
export class TorBoxError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public retryAfterMs = 1000,
    public statusCode = retryable ? 503 : 502,
  ) {
    super(message);
  }
}
export async function torbox(path: string, options: RequestInit = {}) {
  const key = getSecret("torbox");
  if (!key) throw new Error("Connect your TorBox account in Settings first.");
  let response: Response;
  try {
    response = await fetch(`https://api.torbox.app/v1/api/${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${key}`, ...options.headers },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new TorBoxError(
      "TorBox could not be reached. The download can retry shortly.",
      true,
    );
  }
  const result = (await response.json().catch(() => ({}))) as {
    success: boolean;
    detail?: string;
    data: unknown;
  };
  if (!response.ok || result.success === false)
    throw new TorBoxError(
      result.detail || "TorBox is temporarily unavailable.",
      [408, 425, 429, 500, 502, 503, 504].includes(response.status),
      retryDelayFromHeader(response.headers.get("retry-after")),
    );
  return result.data;
}
const torrentLinks = new Map<
  string,
  { expires: number; result: Promise<string> }
>();
export async function torboxUrl(
  torrentId: number,
  fileId: number,
  refresh = false,
) {
  const key = getSecret("torbox");
  if (!key) throw new Error("Connect TorBox in Settings to stream this book.");
  const id =
    createHash("sha256").update(key).digest("hex") + `:${torrentId}:${fileId}`;
  const cached = torrentLinks.get(id);
  if (!refresh && cached && cached.expires > Date.now()) return cached.result;
  const result = (async () => {
    const data = await torbox(
      `torrents/requestdl?${new URLSearchParams({ token: key, torrent_id: String(torrentId), file_id: String(fileId), zip_link: "false" })}`,
    );
    if (typeof data !== "string" || !data.startsWith("https://"))
      throw new TorBoxError(
        "TorBox did not return a playable link. Retry shortly.",
        true,
      );
    return data;
  })();
  const entry = { expires: Date.now() + 60000, result };
  torrentLinks.set(id, entry);
  for (const [stored, link] of torrentLinks)
    if (link.expires <= Date.now() || torrentLinks.size > 128)
      torrentLinks.delete(stored);
  try {
    return await result;
  } catch (error) {
    if (torrentLinks.get(id) === entry) torrentLinks.delete(id);
    throw error;
  }
}
const ABB_BROWSER_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; Sonder/0.1)" };
let abbProxy: { url: string; agent: ProxyAgent } | undefined;
/** The HTTP proxy AudioBookBay requests go through, when `ABB_PROXY_URL` names one (#755). */
function abbDispatcher() {
  const url = process.env.ABB_PROXY_URL?.trim();
  if (!url) return undefined;
  if (abbProxy?.url !== url) abbProxy = { url, agent: new ProxyAgent(url) };
  return abbProxy.agent;
}
/** A request to the mirror: through the proxy when one is set, and a connection failure says so in words. */
async function abbFetch(url: string | URL, headers?: Record<string, string>) {
  const proxied = !!process.env.ABB_PROXY_URL?.trim();
  try {
    const dispatcher = abbDispatcher();
    return await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20000),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  } catch (cause) {
    // Through a proxy the failure may be the proxy's own, so the sentence names it.
    throw new Error(
      proxied
        ? "The mirror could not be reached through the server's proxy. Retry, or check that the proxy is running."
        : "The mirror could not be reached. Retry, or try another mirror in Settings.",
      { cause },
    );
  }
}
function abbFacts(text: string) {
  const value = text.replace(/\s+/g, " ").trim();
  const field = (pattern: RegExp) => pattern.exec(value)?.[1]?.trim() || null;
  return {
    language: field(
      /Language:\s*(.*?)(?:Keywords:|Written by:|Narrated by:|Category:|$)/i,
    ),
    narrator: field(
      /(?:Narrated by|Read by):?\s+(.{1,300}?)(?:Format:|Bitrate:|Length:|Unabridged|Abridged|$)/i,
    ),
    format: field(/Format:\s*([^/]*?)(?:\/|Bitrate:|File Size:|$)/i),
    bitrate: field(
      /Bitrate:\s*(\d+(?:\s*[/-]\s*\d+)?\s*[Kk]bps|Variable|Mixed|\?)/i,
    ),
    size: field(/(?:File|Total) Size:\s*([\d.,]+\s*[KMGT]B\w*)/i),
    posted: field(/Posted:\s*(.*?)(?:Format:|$)/i),
    uploader: field(/Shared by:\s*(\S+)/i),
  };
}
export function parseAbbListings(
  html: string,
  base: string,
): AudiobookRelease[] {
  const root = parse(html);
  return root
    .querySelectorAll(".post")
    .slice(0, 30)
    .flatMap((post) => {
      const link =
        post.querySelector(".postTitle a") || post.querySelector("h2 a");
      const href = link?.getAttribute("href");
      if (!href || !link) return [];
      const encodedId = /\/abss\/([^/?#]+)/.exec(href)?.[1];
      let id: string | undefined;
      try {
        id = encodedId ? decodeURIComponent(encodedId) : undefined;
      } catch {
        return [];
      }
      if (!id) return [];
      const raw = link.textContent.trim();
      const split = raw.lastIndexOf(" - ");
      const image = post.querySelector("img");
      const cover = image?.getAttribute("src");
      return [
        {
          id,
          title: split > 0 ? raw.slice(0, split) : raw,
          author: split > 0 ? raw.slice(split + 3) : "Unknown author",
          cover:
            cover && cover.startsWith("https://") ? cover : "",
          url: new URL(`/abss/${encodeURIComponent(id)}/`, base).href,
          genre:
            post.querySelector('a[rel="category tag"]')?.textContent ||
            "Audiobook",
          description: (post.querySelector(".postContent")?.textContent || "")
            .replace(/\s+/g, " ")
            .slice(0, 600),
          ...abbFacts(
            (post.querySelector(".postInfo")?.textContent || "") +
              " " +
              (post.querySelector(".postContent")?.textContent || ""),
          ),
          // Language ends before the content metadata, even on keyword-free posts.
          language: abbFacts(post.querySelector(".postInfo")?.textContent || "")
            .language,
        },
      ];
    });
}
export async function abbReleaseSearch(q: string, pageNumber = 1) {
  const base = getSetting("abbUrl") || "https://audiobookbay.lu";
  const url = new URL(pageNumber === 1 ? "/" : `/page/${pageNumber}/`, base);
  // This mirror redirects mixed-case search values to its front page.
  url.searchParams.set("s", q.toLocaleLowerCase());
  const response = await abbFetch(url, ABB_BROWSER_HEADERS);
  if (!response.ok)
    throw new Error(
      `AudioBookBay returned ${response.status}. Try another mirror in Settings.`,
    );
  const html = await response.text();
  const results = parseAbbListings(html, base);
  if (
    !results.length &&
    /just a moment|checking your browser|verify you are human|access denied/i.test(
      html,
    )
  )
    throw new Error(
      "AudioBookBay requires browser verification. Try another mirror in Settings or open the source website.",
    );
  const root = parse(html);
  const hasMore = root
    .querySelectorAll(".wp-pagenavi a, .navigation a")
    .some((link) => {
      const path = new URL(link.getAttribute("href") || "/", base).pathname;
      return Number(/\/page\/(\d+)/.exec(path)?.[1] || 0) > pageNumber;
    });
  return {
    results,
    page: pageNumber,
    nextPage: hasMore ? pageNumber + 1 : null,
    website: url.href,
  };
}
export async function abbSearch(q: string) {
  return (await abbReleaseSearch(q)).results;
}
export function parseAbbRelease(
  html: string,
  base: string,
  slug: string,
): AudiobookRelease {
  const root = parse(html);
  const raw = root
    .querySelector(".postTitle h1, .postTitle h2")
    ?.textContent.trim();
  const content = root.querySelector(".postContent");
  if (!raw || !content)
    throw new Error(
      "This release is unavailable or requires browser verification. Open its source page for details.",
    );
  const split = raw.lastIndexOf(" - ");
  const facts = abbFacts(content.textContent);
  const narrators = content
    .querySelectorAll(".narrator")
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join(", ");
  return {
    id: slug,
    title: split > 0 ? raw.slice(0, split) : raw,
    author:
      content.querySelector(".author")?.textContent.trim() ||
      (split > 0 ? raw.slice(split + 3) : "Unknown author"),
    url: `${base}/abss/${encodeURIComponent(slug)}/`,
    cover: content.querySelector("img")?.getAttribute("src"),
    ...facts,
    language: abbFacts(root.querySelector(".postInfo")?.textContent || "")
      .language,
    narrator: narrators || facts.narrator,
    format:
      content.querySelector(".format")?.textContent.trim() || facts.format,
    bitrate:
      content.querySelector(".bitrate")?.textContent.trim() || facts.bitrate,
    description: (
      content.querySelector(".desc")?.textContent || content.textContent
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000),
  };
}
export async function abbRelease(slug: string) {
  const base = getSetting("abbUrl") || "https://audiobookbay.lu";
  const response = await abbFetch(`${base}/abss/${encodeURIComponent(slug)}/`, ABB_BROWSER_HEADERS);
  if (!response.ok)
    throw new Error("Could not read this release’s source page.");
  return parseAbbRelease(await response.text(), base, slug);
}
export async function abbMagnet(slug: string) {
  const base = getSetting("abbUrl") || "https://audiobookbay.lu";
  const response = await abbFetch(`${base}/abss/${encodeURIComponent(slug)}/`);
  if (!response.ok) throw new Error("Could not read this book’s source page.");
  const html = await response.text();
  const root = parse(html);
  const magnet = root.querySelector('a[href^="magnet:"]')?.getAttribute("href");
  if (magnet) return magnet;
  const hash = /Info Hash:[\s\S]{0,200}?([a-f0-9]{40})/i.exec(html)?.[1];
  if (hash) return `magnet:?xt=urn:btih:${hash}`;
  throw new Error(
    "No torrent hash found on this source page. You can import its magnet link directly.",
  );
}
export function prowlarrConfig() {
  const url = getSetting("prowlarrUrl");
  const key = getSecret("prowlarr");
  return url && key ? { url, key } : null;
}
const prowlarrLinks = new Map<string, { expires: number; link: ProwlarrLink }>();
// Cached hashes only raise a release in the list; acquisition re-checks TorBox before routing.
export async function torboxCachedHashes(hashes: string[]) {
  const cached = new Set<string>();
  if (!hashes.length || !getSecret("torbox")) return cached;
  for (let index = 0; index < hashes.length; index += 50) {
    const data = await torbox(
      `torrents/checkcached?hash=${hashes.slice(index, index + 50).join(",")}&format=list&list_files=false`,
    );
    const items = Array.isArray(data)
      ? data
      : data && typeof data === "object"
        ? Object.values(data)
        : [];
    for (const item of items)
      if (item && typeof item === "object" && "hash" in item)
        cached.add(String(item.hash).toLowerCase());
  }
  return cached;
}
export async function prowlarrReleaseSearch(q: string) {
  const config = prowlarrConfig();
  if (!config) throw new Error("Connect Prowlarr in Settings first.");
  const { releases, links } = await prowlarrSearch(config, q);
  keepProwlarrLinks(links);
  const cached = await torboxCachedHashes(
    releases.flatMap((release) => (release.infoHash ? [release.infoHash] : [])),
  ).catch(() => new Set<string>());
  return {
    results: releases.map((release) => ({
      ...release,
      cached: !!release.infoHash && cached.has(release.infoHash),
    })),
    page: 1,
    nextPage: null,
  };
}
/** Prowlarr's EPUB and PDF torrents for the words (#901); their links are kept as the audio releases' are. */
export async function prowlarrEbookSearch(q: string) {
  const config = prowlarrConfig();
  if (!config) throw new Error("Connect Prowlarr in Settings first.");
  const { files, links } = await prowlarrEbookSearchRaw(config, q);
  keepProwlarrLinks(links);
  const cached = await torboxCachedHashes(files.flatMap((file) => (file.infoHash ? [file.infoHash] : []))).catch(
    () => new Set<string>(),
  );
  return files.map(({ infoHash, ...file }) => ({ ...file, cached: !!infoHash && cached.has(infoHash) }));
}
function keepProwlarrLinks(links: Map<string, ProwlarrLink>) {
  const expires = Date.now() + 6 * 3600_000;
  for (const [id, link] of links) prowlarrLinks.set(id, { expires, link });
  for (const [id, entry] of prowlarrLinks)
    if (entry.expires <= Date.now() || prowlarrLinks.size > 5000)
      prowlarrLinks.delete(id);
}
export function prowlarrRelease(id: string) {
  const entry = prowlarrLinks.get(id);
  if (!entry || entry.expires <= Date.now())
    throw new Error("This search result has expired. Search again and choose the release.");
  return entry.link;
}
export async function prowlarrMagnet(id: string) {
  const config = prowlarrConfig();
  if (!config) throw new Error("Connect Prowlarr in Settings first.");
  return resolveProwlarrLink(config, prowlarrRelease(id));
}
