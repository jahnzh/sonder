import type { IChapter, IOptions } from "music-metadata";
// music-metadata caps each MP4 table at 100k entries by default, which long
// single-file M4B audiobooks exceed in their chunk and sample tables.
export const audioParseOptions: IOptions = {
  duration: true,
  includeChapters: true,
  skipCovers: true,
  maxMetadataEntries: 10_000_000,
};
export type Chapter = { title: string; start: number; end?: number };
export function normalizeChapters(
  chapters: readonly IChapter[] | undefined,
  duration: number,
): Chapter[] {
  const items = (chapters || [])
    .flatMap((c, index) => {
      const scale = c.timeScale || 1,
        start = c.start / scale,
        end = c.end === undefined ? undefined : c.end / scale;
      if (
        !Number.isFinite(start) ||
        start < 0 ||
        (duration > 0 && start >= duration)
      )
        return [];
      return [
        {
          title: c.title.trim() || `Chapter ${index + 1}`,
          start,
          ...(end !== undefined && Number.isFinite(end) && end > start
            ? { end: Math.min(end, duration || end) }
            : {}),
        },
      ];
    })
    .sort((a, b) => a.start - b.start)
    .filter((c, i, all) => i === 0 || c.start > all[i - 1].start);
  return items.map((c, i) => ({
    ...c,
    end: c.end ?? items[i + 1]?.start ?? (duration || undefined),
  }));
}
