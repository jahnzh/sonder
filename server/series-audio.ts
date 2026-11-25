import {
  abbMagnet,
  abbReleaseSearch,
  prowlarrMagnet,
  prowlarrReleaseSearch,
  torboxCachedHashes,
} from "./services.ts";
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
  source: "abb" | "prowlarr";
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
};

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

export function rankSeriesAudioCandidate(candidate: SeriesAudioCandidate, expected?: SeriesAudioExpectation | null) {
  let score = candidate.kind === "plain" ? 100 : candidate.kind === "episodic" ? 10 : -100;
  if (candidate.cached) score += 50;
  if (expected && narratorMatches(candidate.narrator, expected.narrators)) score += 20;
  if (expected?.lengthMs && candidate.lengthMs && Math.abs(candidate.lengthMs - expected.lengthMs) <= Math.max(120_000, expected.lengthMs * 0.03)) score += 10;
  if (/m4b|mp3/i.test(`${candidate.format || ""} ${candidate.title}`)) score += 2;
  return score;
}

export function pickAutoAcquireCandidate(
  candidates: SeriesAudioCandidate[],
  expected?: SeriesAudioExpectation | null,
): SeriesAudioCandidate | null {
  const list = candidates
    .filter((candidate) => isAutoAcquireKind(candidate.kind) && candidate.hash)
    .sort(
      (a, b) => rankSeriesAudioCandidate(b, expected) - rankSeriesAudioCandidate(a, expected),
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
  log?: (message: string) => void;
};

const defaultDeps = (): SeriesAudioSearchDeps => ({
  abbSearch: abbReleaseSearch,
  prowlarrSearch: prowlarrReleaseSearch,
  abbMagnetLink: abbMagnet,
  prowlarrMagnetLink: prowlarrMagnet,
  cachedHashes: torboxCachedHashes,
});

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
      .filter((candidate) => !candidate.hash)
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
  const chosen = pickAutoAcquireCandidate(candidates, input.expected);
  if (!chosen?.hash) {
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

/**
 * The language rule's hook (#897): whether a candidate is in the series' language. It accepts every candidate until
 * that rule is merged; the pack step calls it on each pack.
 */
export function languageFits(_candidate: Pick<SeriesAudioCandidate, "title" | "format">, _language?: string | null) {
  return true;
}

const PACK_RANGE =
  /(?:\bbooks?|\bbks?|\bvols?|\bvolumes?|\bparts?|#)\s*0*(\d{1,3})\s*(?:-|–|—|to|thru|through|&|and)\s*(?:#|books?\s*)?0*(\d{1,3})\b/i;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The range of books a release's title names: "Books 1-8", "Book 1 to 3", "#1-3", "Vol. 1 & 2", or a bare "1-8"
 * right after the series' name. Null when it names none (a "Complete Series" says nothing a split can rely on).
 */
export function packRange(title: string, seriesName: string): { from: number; to: number } | null {
  const plain = stripApostrophes(title);
  const words = normalizeSeriesAudioTitle(seriesName).split(" ").filter(Boolean);
  const afterSeries = words.length
    ? new RegExp(`${words.map(escapeRegExp).join("\\W+")}\\W*0*(\\d{1,3})\\s*(?:-|–|—|to)\\s*0*(\\d{1,3})\\b`, "i")
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
  for (const query of buildPackSearchQueries(seriesName, author)) {
    await withProviderRetry(`AudioBookBay pack "${query}"`, async () => {
      for (let page = 1, next: number | null = 1; next && page <= 2; page++) {
        const response = await deps.abbSearch(query, page);
        next = response.nextPage;
        for (const result of response.results)
          add({ source: "abb", id: result.id, title: result.title, size: result.size, format: result.format, narrator: result.narrator, kind: "compilation", query });
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
 * The pack the queue takes (ADR 0027): one in the series' language (`languageFits`) that covers at least two of the
 * waiting books; the one covering the most of them, then TorBox's cached copy and the per-book ranking. Null when
 * no pack covers two.
 */
export function pickSeriesPack(
  candidates: readonly SeriesAudioCandidate[],
  volumes: readonly { position: number; title: string }[],
  seriesName: string,
  wanted: ReadonlySet<number>,
  language?: string | null,
): SeriesPackChoice | null {
  const options = candidates.flatMap((candidate) => {
    if (!candidate.hash || !languageFits(candidate, language)) return [];
    const covered = packCoverage(candidate.title, volumes, seriesName);
    if (!covered) return [];
    const hits = covered.filter((position) => wanted.has(position));
    return hits.length >= 2 ? [{ candidate, covered, wanted: hits }] : [];
  });
  options.sort(
    (a, b) =>
      b.wanted.length - a.wanted.length ||
      rankSeriesAudioCandidate({ ...b.candidate, kind: "plain" }) - rankSeriesAudioCandidate({ ...a.candidate, kind: "plain" }),
  );
  return options[0] ?? null;
}

/** A pack candidate's magnet link: the one its source gives, else one made from its hash. */
export async function packCandidateMagnet(candidate: SeriesAudioCandidate, deps: SeriesAudioSearchDeps = defaultDeps()) {
  return resolveCandidateMagnet(candidate, deps);
}
