import type { AlignmentJob } from "./reading-types";

/** What the Reading sync card reads from `GET /api/alignments/options` to decide how Prepare starts a job. */
export type PrepareOptions = {
  clips: { duration: number }[];
  anchored?: boolean;
  /** The server runs whole-book jobs (#405). Absent from an older server: the card keeps its chapter matching. */
  bookJobs?: boolean;
};

type Pairings = AlignmentJob["pairings"];

/**
 * Whether the card offers chapter matching: the matcher, its count, the review sentence and the rebuild without
 * it. A whole-book job gets the whole ebook and recording and finds the text itself, so pairings change nothing
 * in its map (ADR 0016, #405).
 */
export function offersChapterMatching(options: PrepareOptions | null | undefined) {
  return options?.bookJobs !== true;
}

/** No section paired and the release has no chapter markers: the window runner samples the narration. */
export function anchoredMode(options: PrepareOptions | null | undefined, pairings: Pairings) {
  return !!options?.anchored && !pairings.length;
}

/**
 * The body of `POST /api/alignments`. For a whole-book job the card sends no pairings and no mode: the server
 * plans the pair as it would on its own (its automatic pairings, or anchored when there are none).
 */
export function prepareBody(
  ebookId: string,
  recordingId: string,
  options: PrepareOptions | null | undefined,
  pairings: Pairings,
  forceAnchored = false,
) {
  if (!offersChapterMatching(options)) return { ebookId, recordingId };
  return {
    ebookId,
    recordingId,
    ...(anchoredMode(options, pairings) || forceAnchored ? { mode: "anchored" as const } : { pairings }),
  };
}

const LENGTHS_UNKNOWN = "Audio lengths are unknown. Save this release to the server to read its chapter details.";

/** Why the pairings keep Prepare disabled, or null. Only the window runner needs a matched section. */
export function pairingBlock(options: PrepareOptions, pairings: Pairings, noChapterMarkers: boolean) {
  const lengthsUnknown = options.clips.every((clip) => clip.duration <= 0);
  if (!offersChapterMatching(options)) return lengthsUnknown ? LENGTHS_UNKNOWN : null;
  if (pairings.length) return null;
  if (anchoredMode(options, pairings)) return lengthsUnknown ? LENGTHS_UNKNOWN : null;
  if (noChapterMarkers && (options.clips[0]?.duration ?? 0) > 7200)
    return "This release is one long audio file without chapter markers. Choose a release with chapters, or open the chapter matcher and set an audio start and length for each ebook section.";
  if (lengthsUnknown) return LENGTHS_UNKNOWN;
  return "No ebook sections matched automatically. Open the chapter matcher and select at least one audio chapter.";
}

/** The card's help line when nothing blocks Prepare; empty for a whole-book job, which needs no review first. */
export function prepareHelp(options: PrepareOptions | null | undefined, pairings: Pairings) {
  if (!offersChapterMatching(options)) return "";
  if (anchoredMode(options, pairings))
    return "No chapter markers. Reading sync samples the narration to locate the ebook text, then aligns the passages between those points.";
  return `${pairings.length} ebook ${pairings.length === 1 ? "section matched" : "sections matched"} to audio. Review the chapter matches, then prepare sentence timings.`;
}
