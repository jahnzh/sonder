import type { AudiobookRelease } from "./types";

const units: Record<string, number> = { b: 0, k: 1, m: 2, g: 3, t: 4 };
export function sizeBytes(release: Pick<AudiobookRelease, "size" | "sizeBytes">) {
  if (release.sizeBytes) return release.sizeBytes;
  const match = /([\d.,]+)\s*([kmgt]?)i?b/i.exec(release.size || "");
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) && value > 0
    ? value * 1024 ** units[match[2].toLowerCase() || "b"]
    : null;
}
const noise =
  /\b(audio\s*book|audiobook|unabridged|abridged|m4b|mp3|aac|flac|opus|\d{2,3}\s*kbps)\b/g;
export function normalizeTitle(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(noise, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function titleKeys(release: AudiobookRelease) {
  const keys = [normalizeTitle(release.title)];
  if (release.author)
    keys.push(
      normalizeTitle(`${release.author} ${release.title}`),
      normalizeTitle(`${release.title} ${release.author}`),
    );
  return keys.filter(Boolean);
}
export function sameRelease(a: AudiobookRelease, b: AudiobookRelease) {
  // A MyAnonamouse torrent is a private tracker's own (#911): it is got another way (its .torrent, the local client
  // only), so it stays its own row even when another source lists the same files.
  if (a.source === "mam" || b.source === "mam") return a.source === b.source && a.id === b.id;
  if (a.infoHash && b.infoHash) return a.infoHash.toLowerCase() === b.infoHash.toLowerCase();
  // Within one source every listing is its own upload, so only match across sources.
  const indexers = new Set(releaseIndexers(a));
  if (releaseIndexers(b).some((indexer) => indexers.has(indexer))) return false;
  if (a.language && b.language && a.language.toLowerCase() !== b.language.toLowerCase())
    return false;
  const first = sizeBytes(a),
    second = sizeBytes(b);
  // Listing sizes are rounded, so allow 1% before treating two uploads as different.
  if (!first || !second || Math.abs(first - second) > Math.max(first, second) * 0.01)
    return false;
  const keys = new Set(titleKeys(a));
  return titleKeys(b).some((key) => keys.has(key));
}
export function releaseIndexers(release: AudiobookRelease) {
  return release.indexers?.length
    ? release.indexers
    : [release.source === "prowlarr" ? release.indexer || "Prowlarr" : release.source === "mam" ? "MyAnonamouse" : "AudioBookBay"];
}
// AudioBookBay entries keep priority because their detail pages carry language and narrator.
function combine(a: AudiobookRelease, b: AudiobookRelease): AudiobookRelease {
  const rank = (r: AudiobookRelease) =>
    r.source === "prowlarr" ? (r.seeders ?? 0) : Number.MAX_SAFE_INTEGER;
  const [primary, other] = rank(b) > rank(a) ? [b, a] : [a, b];
  const seeders = [a.seeders, b.seeders].filter(
    (value): value is number => typeof value === "number",
  );
  return {
    ...primary,
    indexers: [...new Set([...releaseIndexers(a), ...releaseIndexers(b)])].sort(
      (x, y) =>
        Number(y === "AudioBookBay") - Number(x === "AudioBookBay") ||
        x.localeCompare(y),
    ),
    seeders: seeders.length ? Math.max(...seeders) : primary.seeders,
    infoHash: primary.infoHash || other.infoHash,
    sizeBytes: primary.sizeBytes || other.sizeBytes,
    cached: !!(a.cached || b.cached),
  };
}
export function mergeReleases(...lists: AudiobookRelease[][]) {
  const merged: AudiobookRelease[] = [];
  const ids = new Map<string, number>();
  for (const release of lists.flat()) {
    const known = ids.get(release.id);
    const index = known ?? merged.findIndex((existing) => sameRelease(existing, release));
    if (index < 0) {
      ids.set(release.id, merged.length);
      merged.push(release);
    } else {
      ids.set(release.id, index);
      merged[index] =
        known !== undefined && merged[index].id === release.id
          ? { ...merged[index], ...release, indexers: merged[index].indexers }
          : combine(merged[index], release);
    }
  }
  return merged;
}
export function sortReleases(releases: AudiobookRelease[], title: string) {
  const wanted = normalizeTitle(title);
  const relevant = (release: AudiobookRelease) =>
    Number(!!wanted && normalizeTitle(release.title) === wanted) * 2 +
    Number(!!wanted && normalizeTitle(release.title).includes(wanted));
  // Seeder counts are unknown on AudioBookBay; rank them above dead torrents but below seeded ones.
  const seeders = (release: AudiobookRelease) => release.seeders ?? 1;
  // The owner's order of sources (#911): TorBox's cached copies, then MyAnonamouse's, then the others; each after the
  // rows that are the book (the title searched), so another book's copy never comes before the book's own.
  const tier = (release: AudiobookRelease) => (release.cached ? 0 : release.source === "mam" ? 1 : 2);
  return releases
    .map((release, index) => ({ release, index }))
    .sort(
      (a, b) =>
        relevant(b.release) - relevant(a.release) ||
        tier(a.release) - tier(b.release) ||
        seeders(b.release) - seeders(a.release) ||
        a.index - b.index,
    )
    .map(({ release }) => release);
}
export function matchesLanguage(release: AudiobookRelease, language: string) {
  if (language === "all") return true;
  // Indexers do not report language, so these releases stay visible under every filter.
  if (release.source === "prowlarr" && !release.language) return true;
  return (release.language || "Unknown").toLowerCase() === language.toLowerCase();
}
