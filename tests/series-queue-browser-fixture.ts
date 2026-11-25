// Test-only answers for the series queue's audio searches of The Lantern Keeper (704, tests/series-browser-fixture.ts),
// for the spec of the series queue on the Series page (#898). Every other search goes where it went before. Never
// bundled into the production server.
//
// AudioBookBay finds three releases of each book: the English single book TorBox has (the queue chooses it), a French
// one and a box set. Choosing one adds nothing: the "download" is noted, so no torrent client is needed.
// `POST /api/__fixture/series-queue` `{ hold: true }` makes the searches wait until `{ hold: false }` (or 60 s), so a
// spec sees the queue with a search running and others waiting.
import type { FastifyInstance } from "fastify";
import { acquire as realAcquire } from "../server/acquisitions.ts";
import { defaultDeps, type SeriesAudioSearchDeps } from "../server/series-audio.ts";
import { setSeriesAcquisitionDeps } from "../server/series-acquisition.ts";
import { setSeriesReleaseSearchDeps } from "../server/series-release-search.ts";
import { abbMagnet, abbRelease } from "../server/services.ts";

const BOOKS = ["The Lantern Keeper", "Keeper of Tides", "The Last Light"];
const ours = (text: string) => /lantern|keeper|last light/i.test(text);
const slug = (title: string, kind: string) => `lantern-${title.toLowerCase().replace(/\W+/g, "-")}-${kind}`;
const hashOf = (id: string) => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(5);
};
/** The book a query is for (the longest title in it). */
const bookOf = (query: string) => BOOKS.filter((title) => query.toLowerCase().includes(title.toLowerCase())).sort((a, b) => b.length - a.length)[0];
function releases(title: string) {
  return [
    { id: slug(title, "en"), title, format: "M4B", narrator: "Kara Shallenberg", size: "420 MB", language: "English", url: `https://audiobookbay.test/abss/${slug(title, "en")}/` },
    { id: slug(title, "fr"), title: `${title} (version française)`, format: "MP3", narrator: "Claire Dubois", size: "390 MB", language: "French", url: `https://audiobookbay.test/abss/${slug(title, "fr")}/` },
    { id: slug(title, "set"), title: "The Lantern Keeper Books 1-3 Collection", format: "MP3", narrator: "Kara Shallenberg", size: "1.2 GB", language: "English", url: `https://audiobookbay.test/abss/${slug(title, "set")}/` },
  ];
}

let hold: { opened: Promise<void>; open: () => void } | null = null;
function setHold(on: boolean) {
  if (!on) {
    hold?.open();
    hold = null;
    return;
  }
  if (hold) return;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  hold = { opened, open };
  // A spec that fails while holding never keeps the queue waiting for the specs after it.
  setTimeout(() => setHold(false), 60_000).unref();
}

/** The "downloads" the fixture's books were given: none reaches a torrent client. */
export const lanternDownloads: { magnet: string; title?: string }[] = [];

export function installSeriesQueueFixture(app: FastifyInstance) {
  const base = (): SeriesAudioSearchDeps => defaultDeps();
  setSeriesAcquisitionDeps({
    seriesAudioDeps: {
      abbSearch: async (query, page) => {
        if (!ours(query)) return base().abbSearch(query, page);
        if (hold) await hold.opened;
        const title = bookOf(query);
        return { results: title && (page ?? 1) === 1 ? releases(title) : [], page: page ?? 1, nextPage: null };
      },
      prowlarrSearch: async (query) => (ours(query) ? { results: [], page: 1, nextPage: null } : base().prowlarrSearch(query)),
      abbMagnetLink: async (id) => (id.startsWith("lantern-") ? `magnet:?xt=urn:btih:${hashOf(id)}&dn=${id}` : base().abbMagnetLink(id)),
      prowlarrMagnetLink: (id) => base().prowlarrMagnetLink(id),
      // TorBox has each book's English single release.
      cachedHashes: async (hashes) => {
        const ourHashes = new Set(BOOKS.map((title) => hashOf(slug(title, "en"))));
        const theirs = hashes.filter((hash) => !ourHashes.has(hash) && !BOOKS.some((title) => ["fr", "set"].some((kind) => hashOf(slug(title, kind)) === hash)));
        const cached = theirs.length ? await base().cachedHashes(theirs).catch(() => new Set<string>()) : new Set<string>();
        for (const hash of hashes) if (ourHashes.has(hash)) cached.add(hash);
        return cached;
      },
      log: () => {},
    },
    acquire: (async (magnet: string, metadata: Parameters<typeof realAcquire>[1]) => {
      if (!ours(metadata?.title ?? "")) return realAcquire(magnet, metadata);
      lanternDownloads.push({ magnet, title: metadata?.title });
      return { id: `lantern-${lanternDownloads.length}` };
    }) as typeof realAcquire,
  });
  setSeriesReleaseSearchDeps({
    abbRelease: (async (id: string) =>
      id.startsWith("lantern-")
        ? { ...releases(BOOKS.find((title) => id.startsWith(slug(title, "")))!).find((release) => release.id === id)!, author: "Iris Vale", cover: "", description: "" }
        : abbRelease(id)) as typeof abbRelease,
    abbMagnet: async (id: string) => (id.startsWith("lantern-") ? `magnet:?xt=urn:btih:${hashOf(id)}&dn=${id}` : abbMagnet(id)),
    acquire: (async (magnet: string, metadata: Parameters<typeof realAcquire>[1]) => {
      if (!ours(metadata?.title ?? "")) return realAcquire(magnet, metadata);
      lanternDownloads.push({ magnet, title: metadata?.title });
      return { id: `lantern-${lanternDownloads.length}` };
    }) as typeof realAcquire,
  });
  app.post("/api/__fixture/series-queue", async (request) => {
    setHold(!!(request.body as { hold?: boolean } | null)?.hold);
    return { held: !!hold, downloads: lanternDownloads.length };
  });
}
