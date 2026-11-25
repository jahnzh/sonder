import {
  abbMagnet,
  abbReleaseSearch,
  prowlarrMagnet,
  prowlarrReleaseSearch,
  torboxCachedHashes,
} from "./services.ts";
import { sqlite } from "./db.ts";
import { MAM_NAME, mam, mamAudiobookRelease, mamConfigured, mamLink, type MamRelease } from "./sources/myanonamouse.ts";
import { audiobookDbBook, audiobookDbByAsin, audiobookDbRelease } from "./audiobookdb.ts";
import { findAsin } from "./catalogue-links.ts";
import { DEFAULT_SERIES_LANGUAGE } from "../src/series-selection.ts";
import { languageCode, namesLanguage, releaseLanguageFits, type LanguageVerdict } from "./release-language.ts";
import {
  getWorkMediaState,
  markWorkEmptySearch,
  trackWorkMediaState,
  workHasPlayableAudio,
} from "./work-media-state.ts";

export type SeriesAudioKind = "plain" | "episodic" | "compilation";

export type SeriesVolumeRef = {
  position: number;
  title: string;
  key: string;
};

export type SeriesAudioCandidate = {
  /** "mam": MyAnonamouse (#911), a private torrent with no hash until its `.torrent` is fetched when it is got. */
  source: "abb" | "prowlarr" | "mam";
  id: string;
  title: string;
  size?: string | null;
  format?: string | null;
  narrator?: string | null;
  hash?: string;
  kind: SeriesAudioKind;
  query: string;
  cached?: boolean;
  /** The release's length where the source names one (milliseconds). */
  lengthMs?: number | null;
  /** The language the source names: AudioBookBay's "Language" field, MyAnonamouse's. Prowlarr's results name none (#897). */
  language?: string | null;
  /** An Audible ASIN in the title, and what AudiobookDB says of it (`resolveCandidateAsins`). */
  asin?: string | null;
  asinCheck?: AsinCheck;
};

/**
 * What AudiobookDB says of the ASIN in a candidate's title (#897): "same" is the wanted book in the series' language,
 * "other_language" a release in another language, "other_book" another book, "unknown" no answer or no language.
 */
export type AsinCheck = "same" | "other_language" | "other_book" | "unknown";

/**
 * What the book's English releases on AudiobookDB say (#721): their narrators and length. A candidate read by one of
 * the narrators, or as long as a release, is more likely the book's audiobook than another.
 */
export type SeriesAudioExpectation = { narrators: string[]; lengthMs: number | null };
const personKey = (name: string) =>
  name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean).sort().join(" ");
/** The candidate's narrator is one of the release's (names compared as sets of words, so "Mays, Jefferson" counts). */
export function narratorMatches(candidate: string | null | undefined, expected: readonly string[]) {
  if (!candidate || !expected.length) return false;
  const wanted = new Set(expected.map(personKey).filter(Boolean));
  return candidate.split(/\s*(?:,|;|&|\band\b)\s*/i).some((name) => wanted.has(personKey(name))) || wanted.has(personKey(candidate));
}

const APOSTROPHE = /[''`\u2019\u2018]/g;

export const COMPILATION_TITLE =
  /\bbooks?\s*\d+\s*[-–to]+\s*\d+|collection|complete|box ?set|omnibus|bundle|\ball \d/i;

export const EPISODIC_TITLE =
  /\bepisodes?\b|\bseason\s*\d|\bimmersion\b|dramati[sz]ed|full[- ]cast|graphic audio/i;

export function stripApostrophes(text: string) {
  return text.replace(APOSTROPHE, "");
}

export function normalizeSeriesAudioTitle(text: string) {
  return stripApostrophes(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Drop a leading `"Series Name: …"` prefix when it matches the catalog series name. */
export function volumeTitleWithoutSeriesPrefix(title: string, seriesName?: string) {
  const trimmed = title.trim();
  if (!seriesName) return trimmed;
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx < 0) return trimmed;
  const prefix = normalizeSeriesAudioTitle(trimmed.slice(0, colonIdx));
  const seriesKey = normalizeSeriesAudioTitle(seriesName);
  if (prefix === seriesKey) {
    const rest = trimmed.slice(colonIdx + 1).trim();
    return rest || trimmed;
  }
  return trimmed;
}

export function bareVolumeTitle(title: string, seriesName?: string) {
  return normalizeSeriesAudioTitle(volumeTitleWithoutSeriesPrefix(title, seriesName));
}

export function classifySeriesAudioKind(title: string): SeriesAudioKind {
  if (COMPILATION_TITLE.test(title)) return "compilation";
  if (EPISODIC_TITLE.test(title)) return "episodic";
  return "plain";
}

export function isAutoAcquireKind(kind: SeriesAudioKind) {
  return kind === "plain";
}

export function seriesVolumeRefs(
  volumes: { position: number; title: string }[],
  seriesName?: string,
): SeriesVolumeRef[] {
  return volumes.map((volume) => ({
    position: volume.position,
    title: volume.title,
    key: bareVolumeTitle(volume.title, seriesName),
  }));
}

/** Which volume does a release title refer to? Longest title match wins. */
export function classifyVolumeFromTitle(
  title: string,
  volumes: SeriesVolumeRef[],
  seriesName: string,
): number | null {
  const normalized = normalizeSeriesAudioTitle(title);
  const seriesKey = normalizeSeriesAudioTitle(seriesName);
  const hits = volumes
    .filter(
      (volume) =>
        volume.position > 1 &&
        volume.key !== seriesKey &&
        volume.key.length > 0 &&
        normalized.includes(volume.key),
    )
    .sort((a, b) => b.key.length - a.key.length);
  if (hits.length) return hits[0].position;
  const numbered =
    /\b(?:book|vol|volume)\s*(\d{1,2})\b/.exec(normalized) ||
    /\b0?(\d)\b/.exec(normalized.replace(seriesKey, ""));
  if (numbered) {
    const position = Number(numbered[1]);
    if (volumes.some((volume) => volume.position === position)) return position;
  }
  const first = volumes[0];
  if (!first) return null;
  if (normalized.includes(seriesKey) || normalized.includes(first.key)) return 1;
  return null;
}

export function buildVolumeSearchQueries(input: {
  seriesName: string;
  volumeTitle: string;
  position: number;
  author?: string;
}): string[] {
  const short = volumeTitleWithoutSeriesPrefix(
    input.volumeTitle,
    input.seriesName,
  );
  const shortBare = stripApostrophes(short);
  const authorTail = input.author?.trim().split(/\s+/).pop();
  const base = [
    short,
    shortBare,
    authorTail ? `${short} ${authorTail}` : null,
    authorTail ? `${shortBare} ${authorTail}` : null,
    `${input.seriesName} book ${input.position}`,
    `${input.seriesName} ${input.position}`,
    `${stripApostrophes(input.seriesName)} book ${input.position}`,
  ].filter((value): value is string => !!value && value.trim().length > 0);
  return [...new Set(base.map((query) => query.trim()))];
}

/**
 * The language the automatic pick takes (#897): the one the user chose for the series when saving it, else the
 * language of the book's catalogue release, else English.
 */
export function seriesAudioLanguage(userId: number, seriesId: string, catalogueLanguage: string | null | undefined): string {
  const saved = sqlite.prepare("SELECT language FROM user_saved_series WHERE user_id=? AND series_id=?").pluck().get(userId, seriesId) as string | null | undefined;
  return languageCode(saved) ?? languageCode(catalogueLanguage) ?? DEFAULT_SERIES_LANGUAGE;
}

/**
 * Whether a candidate is in the series' language (#897): its source's language, else the language of the release its
 * ASIN names, else the language its title marks ("[FR]", "Français", "Deutsch"; a language word that is the book's or the
 * series' own title, "The Dutch House", is no mark). "other" is never picked automatically; "unnamed" only with
 * evidence of the wanted edition (`candidateIsWantedEdition`). The one rule, reused by the series packs.
 */
export function candidateLanguageFits(
  candidate: Pick<SeriesAudioCandidate, "title" | "language" | "asinCheck">,
  language: string | null | undefined = DEFAULT_SERIES_LANGUAGE,
  ownTitles: readonly string[] = [],
): LanguageVerdict {
  if (candidate.asinCheck === "other_language") return "other";
  const verdict = releaseLanguageFits(candidate, language, ownTitles);
  return verdict === "unnamed" && candidate.asinCheck === "same" ? "fits" : verdict;
}

/** The evidence that a candidate with no language named is the wanted edition: its narrator, its length or its ASIN. */
export function candidateIsWantedEdition(candidate: SeriesAudioCandidate, expected?: SeriesAudioExpectation | null) {
  if (candidate.asinCheck === "same") return true;
  if (!expected) return false;
  if (narratorMatches(candidate.narrator, expected.narrators)) return true;
  // A release title that says who reads it ("read by Jefferson Mays") counts as the narrator.
  const title = ` ${normalizeSeriesAudioTitle(candidate.title)} `;
  if (expected.narrators.some((name) => { const key = normalizeSeriesAudioTitle(name); return key.length > 4 && title.includes(` ${key} `); })) return true;
  return lengthMatches(candidate.lengthMs, expected.lengthMs);
}
/** A candidate's length is the release's within the tolerance the ranking has always used. */
export function lengthMatches(candidateMs: number | null | undefined, expectedMs: number | null | undefined) {
  return !!candidateMs && !!expectedMs && Math.abs(candidateMs - expectedMs) <= Math.max(120_000, expectedMs * 0.03);
}

/**
 * The owner's order of sources (#911), before any other ranking: a release TorBox has cached (from any source), then a
 * MyAnonamouse one, then every other.
 */
export const sourceTier = (candidate: Pick<SeriesAudioCandidate, "cached" | "source">) => (candidate.cached ? 0 : candidate.source === "mam" ? 1 : 2);

/** A candidate the queue can get: one with an info hash, or a MAM torrent (its hash comes with its `.torrent`). */
export const canBeGot = (candidate: Pick<SeriesAudioCandidate, "hash" | "source" | "id">) => !!candidate.hash || (candidate.source === "mam" && !!candidate.id);

export function rankSeriesAudioCandidate(candidate: SeriesAudioCandidate, expected?: SeriesAudioExpectation | null) {
  let score = candidate.kind === "plain" ? 100 : candidate.kind === "episodic" ? 10 : -100;
  if (candidate.cached) score += 50;
  if (expected && narratorMatches(candidate.narrator, expected.narrators)) score += 20;
  if (lengthMatches(candidate.lengthMs, expected?.lengthMs)) score += 10;
  if (candidate.asinCheck === "same") score += 20;
  if (/m4b|mp3/i.test(`${candidate.format || ""} ${candidate.title}`)) score += 2;
  return score;
}

/**
 * The candidate the queue downloads by itself (#897): a plain release, in the series' language (a source or title that
 * names another is never picked), and one that names no language only with evidence it is the wanted edition. Null
 * leaves the book for the user to choose.
 */
export function pickAutoAcquireCandidate(
  candidates: SeriesAudioCandidate[],
  expected?: SeriesAudioExpectation | null,
  language: string | null | undefined = DEFAULT_SERIES_LANGUAGE,
  ownTitles: readonly string[] = [],
): SeriesAudioCandidate | null {
  const list = candidates
    .filter((candidate) => {
      if (!isAutoAcquireKind(candidate.kind) || !canBeGot(candidate) || candidate.asinCheck === "other_book") return false;
      const verdict = candidateLanguageFits(candidate, language, ownTitles);
      return verdict === "fits" || (verdict === "unnamed" && candidateIsWantedEdition(candidate, expected));
    })
    .sort(
      (a, b) => sourceTier(a) - sourceTier(b) || rankSeriesAudioCandidate(b, expected) - rankSeriesAudioCandidate(a, expected),
    );
  return list[0] || null;
}

export function btihFromMagnet(magnet: string) {
  return /btih:([a-f0-9]{40}|[A-Z2-7]{32})/i.exec(magnet)?.[1]?.toLowerCase();
}

/** The message of any rejected value: an Error's message, otherwise its string form. */
export function caughtMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch (formatError) {
    // e.g. an object without a prototype, which has no toString.
    return `unprintable ${typeof error} (${formatError instanceof Error ? formatError.name : "error"})`;
  }
}

/**
 * Log without letting the logger stop the recovery that follows: a logger that throws is
 * reported to the console and otherwise ignored.
 */
function logSafely(log: ((message: string) => void) | undefined, message: string) {
  if (!log) return;
  try {
    log(message);
  } catch (logError) {
    console.error(`series audio: the logger threw while logging "${message}"`, logError);
  }
}

/** Log a caught error of any kind, safely (see `logSafely`). */
function logCaught(
  log: ((message: string) => void) | undefined,
  label: string,
  error: unknown,
) {
  logSafely(log, `${label}: ${caughtMessage(error)}`);
}

export async function withProviderRetry<T>(
  label: string,
  fn: () => Promise<T>,
  log: (message: string) => void = (message) => console.warn(message),
  attempts = 3,
): Promise<T | null> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      logSafely(log, `${label}: ${caughtMessage(error)} (attempt ${attempt + 1}/${attempts})`);
      if (attempt + 1 < attempts)
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  if (last instanceof Error) logSafely(log, `${label}: gave up after ${attempts} attempts`);
  return null;
}

export type SeriesAudioSearchDeps = {
  abbSearch: (
    q: string,
    pageNumber?: number,
  ) => Promise<{
    results: {
      id: string;
      title: string;
      size?: string | null;
      format?: string | null;
      narrator?: string | null;
      language?: string | null;
    }[];
    page: number;
    nextPage: number | null;
    website?: string;
  }>;
  prowlarrSearch: (q: string) => Promise<{
    results: {
      id: string;
      title: string;
      size?: string | null;
      format?: string | null;
      infoHash?: string | null;
    }[];
    page: number;
    nextPage: number | null;
  }>;
  abbMagnetLink: typeof abbMagnet;
  prowlarrMagnetLink: typeof prowlarrMagnet;
  cachedHashes: typeof torboxCachedHashes;
  /**
   * MyAnonamouse's audiobooks for the words (#911), when a session is saved; absent asks none. One search per book (and
   * one per series for its packs): MAM is asked for few things, spaced (`server/sources/myanonamouse.ts`).
   */
  mamSearch?: (q: string) => Promise<{ results: SeriesMamResult[] }>;
  /** What AudiobookDB says of an Audible ASIN: its book and the language of its release (#897). Absent: the real one. */
  asinRelease?: (asin: string) => Promise<AsinRelease | null>;
  log?: (message: string) => void;
};

export type AsinRelease = { bookId: string | null; language: string | null };

/** A MyAnonamouse audiobook as the series search reads it: the Get sheet's row, with its authors and series. */
export type SeriesMamResult = {
  id: string;
  title: string;
  size?: string | null;
  format?: string | null;
  narrator?: string | null;
  language?: string | null;
  lengthMs?: number | null;
  seeders?: number | null;
  url?: string | null;
  indexer?: string | null;
  authors: string[];
  series: { name: string; position: string | null }[];
};

/** MAM's search, as the series search reads it. */
export async function mamSeriesSearch(q: string): Promise<{ results: SeriesMamResult[] }> {
  return { results: mamSeriesRows((await mam().search(q, "audio")).results) };
}

/** MAM's rows as the series search reads them. */
export function mamSeriesRows(releases: MamRelease[]): SeriesMamResult[] {
  return releases.map((release) => {
    const row = mamAudiobookRelease(release);
    return {
      id: row.id,
      title: row.title,
      size: row.size,
      format: row.format,
      narrator: row.narrator,
      language: row.language,
      lengthMs: row.lengthMs,
      seeders: row.seeders,
      url: row.url,
      indexer: MAM_NAME,
      authors: release.authors,
      series: release.series,
    };
  });
}

/** The torrent id of a MAM row's id (`mam-<id>`). */
const mamTorrentId = (id: string) => /^mam-(\d+)$/.exec(id)?.[1] ?? null;

/**
 * Which volume a MAM row is (#911): MAM names a book's series and its place in it, so a row of this series at a
 * volume's place is that volume; else its title says, as for the other sources. A row by none of the book's authors is
 * not this book (a title alone can be another book's).
 */
export function mamVolume(result: SeriesMamResult, volumes: SeriesVolumeRef[], seriesName: string, author: string): number | null {
  const surname = author.trim().split(/\s+/).pop()?.toLowerCase();
  if (surname && result.authors.length && !result.authors.some((name) => name.toLowerCase().includes(surname))) return null;
  const seriesKey = normalizeSeriesAudioTitle(seriesName);
  for (const entry of result.series) {
    if (normalizeSeriesAudioTitle(entry.name) !== seriesKey || !entry.position || !/^\d+(\.\d+)?$/.test(entry.position)) continue;
    const position = Number(entry.position);
    if (volumes.some((volume) => volume.position === position)) return position;
  }
  return classifyVolumeFromTitle(result.title, volumes, seriesName);
}

/** `GET /audiobooks/external/audible/{ASIN}`, then the release's language (`GET /releases/{id}`); background priority, cached. */
export async function audiobookDbAsinRelease(asin: string): Promise<AsinRelease | null> {
  const hit = await audiobookDbByAsin(asin, { priority: "background" });
  if (!hit) return null;
  if (hit.releaseId) {
    const release = await audiobookDbRelease(hit.releaseId, { priority: "background", bookId: hit.bookId });
    if (release.language) return { bookId: release.bookId ?? hit.bookId, language: release.language };
  }
  const book = await audiobookDbBook(hit.bookId, { priority: "background" });
  return { bookId: hit.bookId, language: book.languages.length === 1 ? book.languages[0] : null };
}

/** The most ASINs one search looks up: each is a provider call, spaced by the provider's own limiter. */
const MAX_ASIN_LOOKUPS = 6;

/**
 * Looks up the ASIN in the title of each candidate that could still be picked (#897). The release's language decides:
 * another language than the series' is never picked, the same one is the evidence of the wanted edition, an ASIN of
 * another book is not this book. A lookup that fails leaves the candidate "unknown" (language not known).
 */
export async function resolveCandidateAsins(
  candidates: SeriesAudioCandidate[],
  options: { language: string | null | undefined; bookId?: string | null; ownTitles?: readonly string[] },
  deps: Pick<SeriesAudioSearchDeps, "asinRelease" | "log">,
) {
  const lookup = deps.asinRelease ?? audiobookDbAsinRelease;
  let lookups = 0;
  for (const candidate of candidates) {
    if (!isAutoAcquireKind(candidate.kind) || !canBeGot(candidate)) continue;
    candidate.asin = findAsin([candidate.title]);
    if (!candidate.asin) continue;
    candidate.asinCheck = "unknown";
    if (candidateLanguageFits(candidate, options.language, options.ownTitles) === "other" || lookups >= MAX_ASIN_LOOKUPS) continue;
    lookups++;
    const found = await withProviderRetry(`AudiobookDB ASIN ${candidate.asin}`, () => lookup(candidate.asin!), deps.log, 2);
    if (!found) continue;
    if (options.bookId && found.bookId && found.bookId !== options.bookId) candidate.asinCheck = "other_book";
    else if (!found.language) candidate.asinCheck = "unknown";
    else if (namesLanguage(found.language, options.language)) candidate.asinCheck = "same";
    else {
      candidate.asinCheck = "other_language";
      candidate.language = found.language;
    }
  }
}

export const defaultDeps = (): SeriesAudioSearchDeps => ({
  abbSearch: abbReleaseSearch,
  prowlarrSearch: prowlarrReleaseSearch,
  abbMagnetLink: abbMagnet,
  prowlarrMagnetLink: prowlarrMagnet,
  cachedHashes: torboxCachedHashes,
  ...(mamConfigured() ? { mamSearch: mamSeriesSearch } : {}),
});

/** A MAM row as a candidate of the series search. */
function mamCandidate(result: SeriesMamResult, kind: SeriesAudioKind, query: string): SeriesAudioCandidate {
  return {
    source: "mam",
    id: mamTorrentId(result.id) ?? result.id,
    title: result.title,
    size: result.size,
    format: result.format,
    narrator: result.narrator,
    language: result.language,
    lengthMs: result.lengthMs ?? null,
    kind,
    query,
    cached: false,
  };
}

export async function searchVolumeAudioCandidates(
  volume: SeriesVolumeRef,
  seriesName: string,
  author: string,
  allVolumes: SeriesVolumeRef[],
  deps: SeriesAudioSearchDeps = defaultDeps(),
): Promise<SeriesAudioCandidate[]> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const queries = buildVolumeSearchQueries({
    seriesName,
    volumeTitle: volume.title,
    position: volume.position,
    author,
  });
  const candidates = new Map<string, SeriesAudioCandidate>();
  const add = (candidate: SeriesAudioCandidate) => {
    const key = candidate.hash || `${candidate.source}:${candidate.id || candidate.title}`;
    if (!candidates.has(key)) candidates.set(key, candidate);
  };

  // MyAnonamouse once per book (#911), with the book's own title: its rows name their series and place in it.
  if (deps.mamSearch && queries[0]) {
    const query = queries[0];
    await withProviderRetry(`MyAnonamouse "${query}"`, async () => {
      const response = await deps.mamSearch!(query);
      for (const result of response.results) {
        if (mamVolume(result, allVolumes, seriesName, author) !== volume.position) continue;
        add(mamCandidate(result, classifySeriesAudioKind(result.title), query));
      }
    }, log, 1);
  }

  for (const query of queries) {
    await withProviderRetry(`AudioBookBay "${query}"`, async () => {
      for (let page = 1, next: number | null = 1; next && page <= 3; page++) {
        const response = await deps.abbSearch(query, page);
        next = response.nextPage;
        for (const result of response.results) {
          if (classifyVolumeFromTitle(result.title, allVolumes, seriesName) !== volume.position)
            continue;
          add({
            source: "abb",
            id: result.id,
            title: result.title,
            size: result.size,
            format: result.format,
            narrator: result.narrator,
            language: result.language,
            kind: classifySeriesAudioKind(result.title),
            query,
          });
        }
      }
    }, log);

    await withProviderRetry(`Prowlarr "${query}"`, async () => {
      const response = await deps.prowlarrSearch(query);
      for (const result of response.results) {
        if (classifyVolumeFromTitle(result.title, allVolumes, seriesName) !== volume.position)
          continue;
        add({
          source: "prowlarr",
          id: result.id,
          title: result.title,
          size: result.size,
          format: result.format,
          hash: result.infoHash || undefined,
          kind: classifySeriesAudioKind(result.title),
          query,
        });
      }
    }, log);
  }

  const list = [...candidates.values()];
  await Promise.all(
    list
      // A MAM torrent's hash comes with its `.torrent`, fetched only for the one got (#911).
      .filter((candidate) => !candidate.hash && candidate.source !== "mam")
      .map(async (candidate) => {
        const magnet = await withProviderRetry(
          `${candidate.source} magnet ${candidate.id}`,
          () =>
            candidate.source === "abb"
              ? deps.abbMagnetLink(candidate.id)
              : deps.prowlarrMagnetLink(candidate.id),
          log,
          2,
        );
        if (magnet) candidate.hash = btihFromMagnet(magnet) || undefined;
      }),
  );

  const hashes = [
    ...new Set(list.flatMap((candidate) => (candidate.hash ? [candidate.hash] : []))),
  ];
  const cached = await deps.cachedHashes(hashes).catch((error) => {
    logCaught(log, "TorBox cache check", error);
    return new Set<string>();
  });
  for (const candidate of list)
    candidate.cached = !!candidate.hash && cached.has(candidate.hash);
  return list;
}

export async function autoAcquireSeriesVolume(
  userId: number,
  input: {
    seriesName: string;
    author: string;
    workId: string;
    volume: SeriesVolumeRef;
    allVolumes: SeriesVolumeRef[];
    title: string;
    cover?: string;
    narrator?: string | null;
    language?: string | null;
    /** The book's English releases on AudiobookDB, for the ranking (#721). */
    expected?: SeriesAudioExpectation | null;
    /** The language of the series (#897): the pick takes only a release in it. English when absent. */
    seriesLanguage?: string | null;
    /** The book's id on the catalogue: an ASIN of another book is not this one. */
    bookId?: string | null;
    /** What the search found and the one picked (null: none), as the series queue keeps them (#898). */
    onCandidates?: (candidates: SeriesAudioCandidate[], chosen: SeriesAudioCandidate | null) => void;
  },
  acquire: (
    magnet: string,
    metadata: {
      title?: string;
      author?: string;
      cover?: string;
      workId?: string;
      language?: string | null;
      narrator?: string | null;
      userId?: number;
    },
  ) => Promise<unknown>,
  deps: SeriesAudioSearchDeps = defaultDeps(),
  mayAcquire?: () => boolean,
) {
  if (workHasPlayableAudio(input.workId)) {
    trackWorkMediaState(userId, input.workId);
    return getWorkMediaState(userId, input.workId);
  }
  const candidates = await searchVolumeAudioCandidates(
    input.volume,
    input.seriesName,
    input.author,
    input.allVolumes,
    deps,
  );
  const ownTitles = [input.title, input.volume.title, input.seriesName];
  const seriesLanguage = input.seriesLanguage || DEFAULT_SERIES_LANGUAGE;
  await resolveCandidateAsins(candidates, { language: seriesLanguage, bookId: input.bookId, ownTitles }, deps);
  const chosen = pickAutoAcquireCandidate(candidates, input.expected, seriesLanguage, ownTitles);
  input.onCandidates?.(candidates, chosen && canBeGot(chosen) ? chosen : null);
  if (!chosen || !canBeGot(chosen)) {
    markWorkEmptySearch(userId, input.workId);
    return getWorkMediaState(userId, input.workId);
  }
  const magnet = await resolveCandidateMagnet(chosen, deps);
  if (!magnet) {
    markWorkEmptySearch(userId, input.workId);
    return getWorkMediaState(userId, input.workId);
  }
  if (mayAcquire && !mayAcquire()) {
    throw new Error("cancelled");
  }
  try {
    await acquire(magnet, {
      title: input.title,
      author: input.author,
      cover: input.cover,
      workId: input.workId,
      language: input.language,
      narrator: input.narrator ?? chosen.narrator,
      userId,
    });
  } catch (error) {
    // An acquire that threw before recording an acquisition still tracks the work.
    logCaught(deps.log, "acquire", error);
    trackWorkMediaState(userId, input.workId);
  }
  return getWorkMediaState(userId, input.workId);
}

async function resolveCandidateMagnet(
  candidate: SeriesAudioCandidate,
  deps: SeriesAudioSearchDeps,
) {
  // A MAM torrent's link: its `.torrent` is fetched when it is added, by the local client only (#911).
  if (candidate.source === "mam") return mamLink(candidate.id);
  if (candidate.source === "prowlarr" && candidate.hash) {
    try {
      return await deps.prowlarrMagnetLink(candidate.id);
    } catch (error) {
      logCaught(deps.log, "prowlarr magnet", error);
    }
  }
  try {
    return await deps.abbMagnetLink(candidate.id);
  } catch (error) {
    logCaught(deps.log, "abb magnet", error);
    if (!candidate.hash) return null;
    return `magnet:?xt=urn:btih:${candidate.hash}&dn=${encodeURIComponent(candidate.title)}`;
  }
}

export async function autoAcquireSeriesVolumes(
  userId: number,
  input: {
    seriesName: string;
    author: string;
    volumes: {
      position: number;
      title: string;
      workId: string;
      unreleased: boolean;
      cover?: string;
      narrator?: string | null;
      language?: string | null;
    }[];
  },
  acquire: (
    magnet: string,
    metadata: {
      title?: string;
      author?: string;
      cover?: string;
      workId?: string;
      language?: string | null;
      narrator?: string | null;
      userId?: number;
    },
  ) => Promise<unknown>,
  deps: SeriesAudioSearchDeps = defaultDeps(),
) {
  const refs = seriesVolumeRefs(
    input.volumes.map((volume) => ({
      position: volume.position,
      title: volume.title,
    })),
    input.seriesName,
  );
  const results = [];
  for (const volume of input.volumes) {
    if (volume.unreleased) {
      results.push({ workId: volume.workId, skipped: "unreleased" as const });
      continue;
    }
    const ref = refs.find((entry) => entry.position === volume.position);
    if (!ref) continue;
    results.push({
      workId: volume.workId,
      mediaState: await autoAcquireSeriesVolume(
        userId,
        {
          seriesName: input.seriesName,
          author: input.author,
          workId: volume.workId,
          volume: ref,
          allVolumes: refs,
          title: volume.title,
          cover: volume.cover,
          narrator: volume.narrator,
          language: volume.language,
        },
        acquire,
        deps,
      ),
    });
  }
  return results;
}

/*
 * Series packs (ADR 0027, #899): one release that holds several books of a series. The queue's pack step
 * (`server/series-pack-step.ts`) searches for them before the per-book searches; the split of a pack's files into
 * its books is `server/series-pack.ts`.
 */

// The second number is no book's when a length or a size follows it ("Book 1 - 3 Hours").
const NOT_A_BOOK = String.raw`(?!\s*(?:hours?|hrs?|h\b|minutes?|mins?|kbps|mb|gb)\b)`;
const PACK_RANGE = new RegExp(
  String.raw`(?:\bbooks?|\bbks?\.?|\bvols?\.?|\bvolumes?|\bparts?|#)\s*0*(\d{1,3})\s*(?:-|–|—|to|thru|through|&|and)\s*(?:#|books?\s*)?0*(\d{1,3})\b` + NOT_A_BOOK,
  "i",
);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The range of books a release's title names: "Books 1-8", "Book 1 to 3", "#1-3", "Vol. 1 & 2", or a bare "1-8"
 * right after the series' name. Null when it names none (a "Complete Series" says nothing a split can rely on).
 */
export function packRange(title: string, seriesName: string): { from: number; to: number } | null {
  const plain = stripApostrophes(title);
  const words = normalizeSeriesAudioTitle(seriesName).split(" ").filter(Boolean);
  const afterSeries = words.length
    ? new RegExp(`${words.map(escapeRegExp).join("\\W+")}\\W*0*(\\d{1,3})\\s*(?:-|–|—|to)\\s*0*(\\d{1,3})\\b${NOT_A_BOOK}`, "i")
    : null;
  const match = PACK_RANGE.exec(plain) ?? afterSeries?.exec(plain);
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (!(to > from) || to - from > 60) return null;
  return { from, to };
}

/**
 * The volumes of the series a release holds, when it is a pack of this series: its title names the series and a
 * range of books, and at least two volumes of the series fall in that range (whole positions only: a novella 1.5
 * is not counted in "Books 1-3"). Null for any other release.
 */
export function packCoverage(
  title: string,
  volumes: readonly { position: number; title: string }[],
  seriesName: string,
): number[] | null {
  const seriesKey = normalizeSeriesAudioTitle(seriesName);
  if (!seriesKey || !normalizeSeriesAudioTitle(title).includes(seriesKey)) return null;
  const range = packRange(title, seriesName);
  if (!range) return null;
  const covered = volumes
    .map((volume) => volume.position)
    .filter((position) => Number.isInteger(position) && position >= range.from && position <= range.to);
  const unique = [...new Set(covered)].sort((a, b) => a - b);
  return unique.length >= 2 ? unique : null;
}

/** The pack search's queries: the series' name, and with the author's surname. */
export function buildPackSearchQueries(seriesName: string, author?: string) {
  const authorTail = author?.trim().split(/\s+/).pop();
  return [...new Set([seriesName, authorTail ? `${seriesName} ${authorTail}` : null].filter((value): value is string => !!value?.trim()).map((query) => query.trim()))];
}

/**
 * The packs of a series the sources have: every release whose title is a pack of the series (`packCoverage`), with
 * its info hash and whether TorBox has it. Two AudioBookBay pages and Prowlarr per query.
 */
export async function searchSeriesPackCandidates(
  seriesName: string,
  author: string,
  volumes: readonly { position: number; title: string }[],
  deps: SeriesAudioSearchDeps = defaultDeps(),
): Promise<SeriesAudioCandidate[]> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const candidates = new Map<string, SeriesAudioCandidate>();
  const add = (candidate: SeriesAudioCandidate) => {
    if (!packCoverage(candidate.title, volumes, seriesName)) return;
    const key = candidate.hash || `${candidate.source}:${candidate.id || candidate.title}`;
    if (!candidates.has(key)) candidates.set(key, candidate);
  };
  const queries = buildPackSearchQueries(seriesName, author);
  // MyAnonamouse once per series (#911), by the series' name.
  if (deps.mamSearch && queries[0]) {
    const query = queries[0];
    await withProviderRetry(`MyAnonamouse pack "${query}"`, async () => {
      const response = await deps.mamSearch!(query);
      for (const result of response.results) add(mamCandidate(result, "compilation", query));
    }, log, 1);
  }
  for (const query of queries) {
    await withProviderRetry(`AudioBookBay pack "${query}"`, async () => {
      for (let page = 1, next: number | null = 1; next && page <= 2; page++) {
        const response = await deps.abbSearch(query, page);
        next = response.nextPage;
        for (const result of response.results)
          add({ source: "abb", id: result.id, title: result.title, size: result.size, format: result.format, narrator: result.narrator, language: result.language, kind: "compilation", query });
      }
    }, log);
    await withProviderRetry(`Prowlarr pack "${query}"`, async () => {
      const response = await deps.prowlarrSearch(query);
      for (const result of response.results)
        add({ source: "prowlarr", id: result.id, title: result.title, size: result.size, format: result.format, hash: result.infoHash || undefined, kind: "compilation", query });
    }, log);
  }
  const list = [...candidates.values()];
  await Promise.all(
    list
      .filter((candidate) => !candidate.hash && candidate.source === "abb")
      .map(async (candidate) => {
        const magnet = await withProviderRetry(`abb magnet ${candidate.id}`, () => deps.abbMagnetLink(candidate.id), log, 2);
        if (magnet) candidate.hash = btihFromMagnet(magnet) || undefined;
      }),
  );
  const hashes = [...new Set(list.flatMap((candidate) => (candidate.hash ? [candidate.hash] : [])))];
  const cached = hashes.length
    ? await deps.cachedHashes(hashes).catch((error) => {
        logCaught(log, "TorBox cache check", error);
        return new Set<string>();
      })
    : new Set<string>();
  for (const candidate of list) candidate.cached = !!candidate.hash && cached.has(candidate.hash);
  return list;
}

export type SeriesPackChoice = {
  candidate: SeriesAudioCandidate;
  /** Every volume position the pack covers. */
  covered: number[];
  /** The waiting books it covers. */
  wanted: number[];
};

/**
 * The pack the queue takes (ADR 0027): one not in another language (`candidateLanguageFits`) that covers at least two of the
 * waiting books; the one covering the most of them, then TorBox's cached copy, MyAnonamouse's (#911) and the per-book ranking. Null when
 * no pack covers two.
 */
export function pickSeriesPack(
  candidates: readonly SeriesAudioCandidate[],
  volumes: readonly { position: number; title: string }[],
  seriesName: string,
  wanted: ReadonlySet<number>,
  language: string | null | undefined = DEFAULT_SERIES_LANGUAGE,
): SeriesPackChoice | null {
  const ownTitles = [seriesName, ...volumes.map((volume) => volume.title)];
  const options = candidates.flatMap((candidate) => {
    // A pack whose source or title names another language is never taken; one that names none is (#897's rule).
    if (!canBeGot(candidate) || candidateLanguageFits(candidate, language, ownTitles) === "other") return [];
    const covered = packCoverage(candidate.title, volumes, seriesName);
    if (!covered) return [];
    const hits = covered.filter((position) => wanted.has(position));
    return hits.length >= 2 ? [{ candidate, covered, wanted: hits }] : [];
  });
  options.sort(
    (a, b) =>
      b.wanted.length - a.wanted.length ||
      // The owner's order of sources (#911): TorBox's cached copy, then MyAnonamouse, then the others.
      sourceTier(a.candidate) - sourceTier(b.candidate) ||
      rankSeriesAudioCandidate({ ...b.candidate, kind: "plain" }) - rankSeriesAudioCandidate({ ...a.candidate, kind: "plain" }),
  );
  return options[0] ?? null;
}

/** A pack candidate's magnet link: the one its source gives, else one made from its hash. */
export async function packCandidateMagnet(candidate: SeriesAudioCandidate, deps: SeriesAudioSearchDeps = defaultDeps()) {
  return resolveCandidateMagnet(candidate, deps);
}
