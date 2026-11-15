import type { Book, Track } from "./types";
import { formatSpeed, timeAtSpeed } from "./playback-speed";
export type ListeningChapter = {
  track: Track;
  title: string;
  start: number;
  end: number;
};
export function listeningChapters(book: Pick<Book, "tracks">): ListeningChapter[] {
  return book.tracks.flatMap((track) =>
    track.chapters?.length
      ? track.chapters.map((c, index) => ({
          track,
          title: c.title,
          start: c.start,
          end: c.end ?? track.chapters?.[index + 1]?.start ?? track.duration,
        }))
      : [{ track, title: track.title, start: 0, end: track.duration }],
  );
}
export function currentChapter(book: Book, trackId: string, position: number) {
  const all = listeningChapters(book);
  const matching = all.filter(
    (c) => c.track.id === trackId && c.start <= position,
  );
  return (
    matching[matching.length - 1] || all.find((c) => c.track.id === trackId)
  );
}
/** Listening time to the chapter's end at `speed`; the whole chapter unless `position` is inside it. */
export function chapterTimeLeft(
  chapter: Pick<ListeningChapter, "start" | "end">,
  position: number | null,
  speed: number,
) {
  const from =
    position === null
      ? chapter.start
      : Math.min(chapter.end, Math.max(chapter.start, position));
  return timeAtSpeed(chapter.end - from, speed);
}
/**
 * What a chapter row shows: other chapters keep their real length, and only the
 * current chapter's time left is at the speed the book plays at.
 */
export function chapterRowTime(
  chapter: Pick<ListeningChapter, "start" | "end">,
  position: number | null,
  speed: number,
) {
  if (position === null)
    return {
      seconds: Math.max(0, chapter.end - chapter.start),
      left: false,
      title: "Chapter length",
    };
  return {
    seconds: chapterTimeLeft(chapter, position, speed),
    left: true,
    title: `Left in chapter${speed !== 1 ? ` at ${formatSpeed(speed)}×` : ""}`,
  };
}
export function absoluteSeekTarget(
  tracks: Pick<Track, "id" | "duration">[],
  seconds: number,
) {
  if (!tracks.length || tracks.some((track) => !(track.duration > 0)))
    return null;
  let remaining = Math.max(
    0,
    Math.min(
      seconds,
      tracks.reduce((total, track) => total + track.duration, 0),
    ),
  );
  for (const [index, track] of tracks.entries()) {
    if (remaining < track.duration || index === tracks.length - 1)
      return { track, position: Math.min(remaining, track.duration) };
    remaining -= track.duration;
  }
  return null;
}
export function playbackTimeline(
  book: Book,
  trackId: string,
  position: number,
  currentDuration: number,
  scope: "book" | "chapter",
) {
  const tracks = book.tracks.map((track) =>
    track.id === trackId && currentDuration > 0
      ? { ...track, duration: currentDuration }
      : track,
  );
  const index = tracks.findIndex((track) => track.id === trackId);
  if (index < 0) return null;
  const track = tracks[index];
  if (scope === "book" && tracks.every((track) => track.duration > 0))
    return {
      scope: "book" as const,
      title: "Whole audiobook",
      trackId,
      start: 0,
      duration: tracks.reduce((total, track) => total + track.duration, 0),
      position:
        tracks
          .slice(0, index)
          .reduce((total, track) => total + track.duration, 0) + position,
    };
  if (scope === "chapter" && track.chapters?.length) {
    const chapters = listeningChapters({ ...book, tracks }).filter(
      (chapter) => chapter.track.id === trackId,
    );
    const chapter =
      chapters.find(
        (chapter) => position >= chapter.start && position < chapter.end,
      ) || (position >= track.duration ? chapters.at(-1) : undefined);
    if (chapter)
      return {
        scope: "chapter" as const,
        title: chapter.title,
        trackId,
        start: chapter.start,
        duration: Math.max(0, chapter.end - chapter.start),
        position: Math.max(0, position - chapter.start),
      };
    const start = Math.max(
      0,
      ...chapters
        .filter((chapter) => chapter.end <= position)
        .map((chapter) => chapter.end),
    );
    const end =
      chapters.find((chapter) => chapter.start > position)?.start ||
      track.duration;
    return {
      scope: "chapter" as const,
      title: start ? "Between chapters" : "Introduction",
      trackId,
      start,
      duration: Math.max(0, end - start),
      position: Math.max(0, position - start),
    };
  }
  return {
    scope: scope === "chapter" ? ("chapter" as const) : ("track" as const),
    title: track.title,
    trackId,
    start: 0,
    duration: track.duration,
    position,
  };
}
export function relativeSeekTarget(
  tracks: Pick<Track, "id" | "duration">[],
  trackId: string,
  position: number,
  delta: number,
  currentDuration?: number,
) {
  let index = tracks.findIndex((track) => track.id === trackId);
  if (index < 0) return null;
  const originalIndex = index;
  const duration = (i: number) =>
    i === originalIndex && currentDuration && Number.isFinite(currentDuration)
      ? currentDuration
      : tracks[i].duration;
  let target = Math.max(0, position) + delta;
  while (target < 0 && index > 0) {
    const previousDuration = duration(index - 1);
    if (!(previousDuration > 0)) return { track: tracks[index], position: 0 };
    target += previousDuration;
    index--;
  }
  while (
    duration(index) > 0 &&
    target >= duration(index) &&
    index < tracks.length - 1
  ) {
    target -= duration(index);
    index++;
  }
  return {
    track: tracks[index],
    position: Math.max(
      0,
      duration(index) > 0 ? Math.min(target, duration(index)) : target,
    ),
  };
}
