import { listeningChapters } from "./chapters";
import type { Progress, Track } from "./types";
// Client only: the server must not import this file.
type Timeline = { tracks: Track[] };
export type SourceMapping = {
  trackId: string;
  /** Seconds into the track. */
  position: number;
  /** Seconds into the whole target recording. */
  bookPosition: number;
  percent: number;
  /** `chapter` matched by index, `title` by normalised title, `fraction` by duration. */
  method: "chapter" | "title" | "fraction";
  confidence: "high" | "low";
  /** The two total durations are more than 10% apart, or one is unknown. */
  durationsDiffer: boolean;
  chapterTitle: string | null;
};
export type SourceSwitchOffer = {
  mapping: SourceMapping;
  /** The target's own older checkpoint, if it has one. */
  saved: Progress | null;
};
const MAX_DURATION_GAP = 0.1;
const finite = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
const totalOf = (tracks: Track[]) =>
  tracks.reduce((sum, track) => sum + finite(track.duration), 0);
/** Seconds from the start of the recording to `position` in `trackId`; null for an unknown track. */
export function bookPosition(
  book: Timeline,
  trackId: string,
  position: number,
) {
  const index = book.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) return null;
  return (
    totalOf(book.tracks.slice(0, index)) +
    Math.min(finite(position), finite(book.tracks[index].duration) || Infinity)
  );
}
const unknownDuration = (book: Timeline) =>
  book.tracks.some((track) => !(track.duration > 0));
/**
 * The timestamp that stands for the player's recording when it is compared with
 * the target's checkpoint. A recording holding a place of at least a second is
 * being listened to now, whether it plays or is paused, so it counts as `now`
 * and not as its last saved time; otherwise the last saved time.
 */
export function activeStamp(
  book: Timeline,
  trackId: string,
  position: number,
  savedAt: number,
  now: number,
) {
  return (bookPosition(book, trackId, position) ?? 0) >= 1 ? now : savedAt;
}
/** Where a position lands on the timeline of the tracks with a known duration; unknown ones are skipped. */
function fractionLanding(tracks: Track[], seconds: number) {
  const known = tracks.filter((track) => track.duration > 0);
  const total = totalOf(known);
  if (!total) return null;
  let remaining = Math.max(0, Math.min(seconds, total));
  for (const [index, track] of known.entries()) {
    if (remaining < track.duration || index === known.length - 1)
      return { track, position: Math.min(remaining, track.duration) };
    remaining -= track.duration;
  }
  return null;
}
const hasChapters = (book: Timeline) =>
  book.tracks.length > 1 || book.tracks.some((track) => track.chapters?.length);
export function normalizeTitle(title: string) {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
type Chapters = ReturnType<typeof listeningChapters>;
/** The chapter of the same title; the nth repeat of a title matches the nth repeat. */
function titleMatch(from: Chapters, index: number, to: Chapters) {
  const title = normalizeTitle(from[index].title);
  if (!title) return -1;
  const occurrence = from
    .slice(0, index)
    .filter((chapter) => normalizeTitle(chapter.title) === title).length;
  const matches = to.flatMap((chapter, i) =>
    normalizeTitle(chapter.title) === title ? [i] : [],
  );
  return matches[occurrence] ?? -1;
}
export const hms = (seconds: number) => {
  const total = Math.floor(finite(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
};
/**
 * Where `position` in one recording lands in another recording of the same work.
 * Chapters first (by index when both have the same count, otherwise by title,
 * keeping the offset into the chapter), then the fraction of the whole book.
 */
export function mapSourcePosition(
  from: Timeline,
  at: { trackId: string; position: number },
  to: Timeline,
): SourceMapping | null {
  const position = finite(at.position);
  const fromTotal = totalOf(from.tracks);
  const toTotal = totalOf(to.tracks);
  const durationsDiffer =
    !fromTotal ||
    !toTotal ||
    unknownDuration(from) ||
    unknownDuration(to) ||
    Math.abs(fromTotal - toTotal) / Math.max(fromTotal, toTotal) >
      MAX_DURATION_GAP;
  if (!from.tracks.some((track) => track.id === at.trackId) || !to.tracks.length)
    return null;
  const result = (
    trackId: string,
    trackPosition: number,
    method: SourceMapping["method"],
    chapterTitle: string | null,
  ): SourceMapping => {
    const absolute = bookPosition(to, trackId, trackPosition) ?? 0;
    return {
      trackId,
      position: trackPosition,
      bookPosition: absolute,
      percent: toTotal ? Math.round(Math.min(1, absolute / toTotal) * 100) : 0,
      method,
      confidence: method === "fraction" || durationsDiffer ? "low" : "high",
      durationsDiffer,
      chapterTitle,
    };
  };
  if (hasChapters(from) && hasChapters(to)) {
    const source = listeningChapters(from);
    const target = listeningChapters(to);
    let index = -1;
    source.forEach((chapter, i) => {
      if (chapter.track.id === at.trackId && chapter.start <= position)
        index = i;
    });
    if (index >= 0) {
      const equal = source.length === target.length;
      const match = equal ? index : titleMatch(source, index, target);
      if (match >= 0) {
        const sourceLength = Math.max(0, source[index].end - source[index].start);
        const targetLength = Math.max(0, target[match].end - target[match].start);
        const offset = Math.min(position - source[index].start, sourceLength);
        return result(
          target[match].track.id,
          target[match].start + Math.min(offset, targetLength),
          equal ? "chapter" : "title",
          target[match].title,
        );
      }
    }
  }
  const absolute = bookPosition(from, at.trackId, position);
  if (!fromTotal || !toTotal || absolute === null) return null;
  // A track of unknown length counts as empty on both sides, so the share is of the known part.
  const landing = fractionLanding(
    to.tracks,
    (Math.min(absolute, fromTotal) / fromTotal) * toTotal,
  );
  return landing
    ? result(landing.track.id, landing.position, "fraction", null)
    : null;
}
/**
 * What to ask when the player switches from the active recording to `target`:
 * only when the target has no checkpoint or an older one. A newer checkpoint
 * is kept and nothing is asked.
 */
export function sourceSwitchOffer(input: {
  active: {
    recordingId: string;
    book: Timeline;
    trackId: string;
    position: number;
    updatedAt: number;
  } | null;
  target: { recordingId: string; book: Timeline; progress?: Progress | null };
}): SourceSwitchOffer | null {
  const { active, target } = input;
  if (!active || active.recordingId === target.recordingId) return null;
  if (target.progress && target.progress.updatedAt >= active.updatedAt)
    return null;
  if (!((bookPosition(active.book, active.trackId, active.position) ?? 0) >= 1))
    return null;
  const mapping = mapSourcePosition(
    active.book,
    { trackId: active.trackId, position: active.position },
    target.book,
  );
  return mapping ? { mapping, saved: target.progress || null } : null;
}
export const resumeLabel = (mapping: SourceMapping) =>
  `Resume at ${mapping.chapterTitle ?? `${mapping.percent}%`} (${hms(mapping.bookPosition)})`;
export const savedLabel = (book: Timeline, saved: Progress) =>
  `Resume saved position (${hms(bookPosition(book, saved.trackId, saved.position) ?? saved.position)})`;
export const START_LABEL = "Start from beginning";
/** Starting over replaces the target's own checkpoint; say which one. */
export const replaceNotice = (book: Timeline, saved: Progress) =>
  `${START_LABEL} replaces your saved position at ${hms(bookPosition(book, saved.trackId, saved.position) ?? saved.position)}`;
export function lowConfidenceWarning(mapping: SourceMapping) {
  if (mapping.confidence !== "low") return null;
  return mapping.durationsDiffer
    ? "Durations differ; the position may be off"
    : "Position estimated from the book length; it may be off";
}
