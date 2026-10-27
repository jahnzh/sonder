import type { IChapter } from "music-metadata";
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
