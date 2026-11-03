import {
  abbMagnet,
  abbReleaseSearch,
  prowlarrMagnet,
  prowlarrReleaseSearch,
  torboxCachedHashes,
} from "./services.ts";
import {
  markWorkEmptySearch,
  syncWorkMediaState,
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
};

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

export function rankSeriesAudioCandidate(candidate: SeriesAudioCandidate) {
  let score = candidate.kind === "plain" ? 100 : candidate.kind === "episodic" ? 10 : -100;
  if (candidate.cached) score += 50;
  if (/jeff hays/i.test(candidate.narrator || "")) score += 5;
  if (/m4b|mp3/i.test(`${candidate.format || ""} ${candidate.title}`)) score += 2;
  return score;
}

export function pickAutoAcquireCandidate(
  candidates: SeriesAudioCandidate[],
): SeriesAudioCandidate | null {
  const list = candidates
    .filter((candidate) => isAutoAcquireKind(candidate.kind) && candidate.hash)
    .sort(
      (a, b) => rankSeriesAudioCandidate(b) - rankSeriesAudioCandidate(a),
    );
  return list[0] || null;
}

export function btihFromMagnet(magnet: string) {
  return /btih:([a-f0-9]{40}|[A-Z2-7]{32})/i.exec(magnet)?.[1]?.toLowerCase();
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
      log(
        `${label}: ${(error as Error).message} (attempt ${attempt + 1}/${attempts})`,
      );
      if (attempt + 1 < attempts)
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  if (last instanceof Error) log(`${label}: gave up after ${attempts} attempts`);
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
    log(`TorBox cache check: ${(error as Error).message}`);
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
  if (workHasPlayableAudio(input.workId)) return syncWorkMediaState(userId, input.workId);
  const candidates = await searchVolumeAudioCandidates(
    input.volume,
    input.seriesName,
    input.author,
    input.allVolumes,
    deps,
  );
  const chosen = pickAutoAcquireCandidate(candidates);
  if (!chosen?.hash) {
    markWorkEmptySearch(userId, input.workId);
    return syncWorkMediaState(userId, input.workId);
  }
  const magnet = await resolveCandidateMagnet(chosen, deps);
  if (!magnet) {
    markWorkEmptySearch(userId, input.workId);
    return syncWorkMediaState(userId, input.workId);
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
  } catch {
    syncWorkMediaState(userId, input.workId);
  }
  return syncWorkMediaState(userId, input.workId);
}

async function resolveCandidateMagnet(
  candidate: SeriesAudioCandidate,
  deps: SeriesAudioSearchDeps,
) {
  if (candidate.source === "prowlarr" && candidate.hash) {
    try {
      return await deps.prowlarrMagnetLink(candidate.id);
    } catch (error) {
      deps.log?.(`prowlarr magnet: ${(error as Error).message}`);
    }
  }
  try {
    return await deps.abbMagnetLink(candidate.id);
  } catch (error) {
    deps.log?.(`abb magnet: ${(error as Error).message}`);
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
