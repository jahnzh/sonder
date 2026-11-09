/**
 * Name the next sections of a CTC job so the worker can extract their audio in parallel while the
 * current section encodes (#346). Workers without prefetch ignore the extra field.
 */
export type PrefetchWindow = { audio: string; start: number; duration: number };

export function prefetchSectionCount(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.ALIGNMENT_PREFETCH_SECTIONS);
  return Number.isInteger(value) && value >= 0 && value <= 16 ? value : 6;
}

export function upcomingPrefetchWindows<Pair extends { start: number; duration: number }>(
  pairings: Pair[],
  index: number,
  count: number,
  skip: (pair: Pair) => boolean,
  audioOf: (pair: Pair) => string | null,
): PrefetchWindow[] {
  const windows: PrefetchWindow[] = [];
  for (let next = index + 1; next < pairings.length && windows.length < count; next++) {
    const pair = pairings[next];
    if (skip(pair)) continue;
    const audio = audioOf(pair);
    if (audio) windows.push({ audio, start: pair.start, duration: pair.duration });
  }
  return windows;
}
