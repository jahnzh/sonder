/** Information needed to choose one default candidate at each series position. */
export type SeriesCandidate = {
  id: number;
  position: number | null;
  workId?: string | null;
  owned?: boolean;
  unreleased: boolean;
  needsAdmin?: boolean;
  language?: string | null;
  editionLanguages?: string[];
  popularity?: number | null;
  releaseDate?: string | null;
};

export function normalizeSeriesLanguage(language: string) {
  return language.trim().toLowerCase().split(/[-_]/)[0];
}

function matchesLanguage(work: SeriesCandidate, preferredLanguage: string) {
  const preferred = normalizeSeriesLanguage(preferredLanguage);
  const languages = work.language ? [work.language] : work.editionLanguages || [];
  return !!preferred && languages.some((language) => normalizeSeriesLanguage(language) === preferred);
}

/** Rank linked/owned works first, then language, popularity, release and id. */
export function selectSeriesDefaults(works: readonly SeriesCandidate[], preferredLanguage: string) {
  const best = new Map<number, SeriesCandidate>();
  const compare = (a: SeriesCandidate, b: SeriesCandidate) =>
    Number(!!b.workId || !!b.owned) - Number(!!a.workId || !!a.owned) ||
    Number(matchesLanguage(b, preferredLanguage)) - Number(matchesLanguage(a, preferredLanguage)) ||
    (b.popularity ?? 0) - (a.popularity ?? 0) ||
    (a.releaseDate || "9999").localeCompare(b.releaseDate || "9999") ||
    a.id - b.id;
  for (const work of works) {
    if (work.position === null || work.unreleased || work.needsAdmin) continue;
    const current = best.get(work.position);
    if (!current || compare(work, current) < 0) best.set(work.position, work);
  }
  return new Set([...best.values()].map((work) => work.id));
}
