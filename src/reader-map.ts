// The reader's narration map (#543, spec #537 "What the reader keeps"): which recording's map the reader loads, and
// the loading itself (restore the cached copy, read the listing and the map through the map lifecycle, poll while
// the job or its rebuild runs). The Reading sync card did this in the background until the page replaced it; the
// rule and the lifecycle calls are the card's, unchanged. It reads no `/alignments/options`.
//
// Pure and DOM-free so tests call it: the hook in src/use-reader-map.ts gives it the player, the saved choice, the
// lifecycle and the timers.
import { alignmentJobNeedsPolling, type createAlignmentMapLifecycle } from "./alignment-map-lifecycle";
import type { AlignmentJob } from "./reading-types";

/** How often the reader reads the listing again while the job (or its rebuild) runs. */
export const READER_MAP_POLL_MS = 4000;

/** The storage key (before the per-user prefix) of the recording saved for this ebook's reading sync. */
export const savedRecordingKey = (ebookId: string) => `reader-recording:${ebookId}`;

type Audio = { recordingId: string; workId: string; tracks: { chapters?: unknown[] | null }[]; faults?: { recording?: unknown } | null };

/**
 * Which recording's map the reader loads, when it is given none: the recording the player plays when it is of this
 * book's work, else the one saved for this ebook, else one with chapter markers, else the first. A recording without
 * tracks, or one marked faulty, is skipped by the last three (as the card did). "" when there is none.
 */
export function readerMapRecording(
  book: { workId: string },
  books: readonly Audio[],
  saved: string | null,
  playing: { workId: string; recordingId: string } | null,
): string {
  if (playing && playing.workId === book.workId && playing.recordingId) return playing.recordingId;
  const candidates = books.filter((audio) => audio.workId === book.workId && audio.tracks.length && !audio.faults?.recording);
  return (
    candidates.find((audio) => audio.recordingId === saved)?.recordingId ||
    candidates.find((audio) => audio.tracks.some((track) => track.chapters?.length))?.recordingId ||
    candidates[0]?.recordingId ||
    ""
  );
}

type Lifecycle = Pick<ReturnType<typeof createAlignmentMapLifecycle>, "restore" | "refresh">;

export type ReaderMapDeps = {
  lifecycle: Lifecycle;
  /** The map to show; `confirmed` when the server confirmed it for the current audio (the lifecycle's `onMap`). */
  onMap: (job: AlignmentJob | null, confirmed: boolean) => void;
  setInterval: (run: () => void, ms: number) => unknown;
  clearInterval: (timer: unknown) => void;
};

/**
 * The loading for one mounted reader. `load` starts over for an ebook and recording (the card's effect on the ebook
 * and the selection): a cached map built from the current EPUB is shown at once, not confirmed; then the listing and
 * the map are read; then the listing is read again every 4 seconds while the job or its rebuild runs. A load, a
 * `forget` or `stop` makes every answer of an earlier load stale, so it never reaches `onMap`.
 */
export function createReaderMapLoader(deps: ReaderMapDeps) {
  let epoch = 0;
  let timer: unknown = null;
  const stopPoll = () => {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
  };
  const refresh = (ebook: { id: string; fingerprint: string }, recordingId: string) => {
    const requestEpoch = epoch;
    return deps.lifecycle.refresh({
      ebook,
      recordingId,
      isCurrent: () => requestEpoch === epoch,
      onJobs: () => {},
      onMap: deps.onMap,
      // Nothing in the reader showed the card's error line; the reader's own line says there is no map.
      onError: () => {},
    });
  };
  const ensurePoll = (ebook: { id: string; fingerprint: string }, recordingId: string, job: AlignmentJob | undefined) => {
    stopPoll();
    if (!alignmentJobNeedsPolling(job)) return;
    timer = deps.setInterval(() => {
      void refresh(ebook, recordingId).then((updated) => {
        if (!alignmentJobNeedsPolling(updated)) stopPoll();
      });
    }, READER_MAP_POLL_MS);
  };
  return {
    async load(ebook: { id: string; fingerprint: string }, recordingId: string) {
      const requestEpoch = ++epoch;
      stopPoll();
      if (recordingId) {
        const cached = await deps.lifecycle.restore(ebook, recordingId);
        if (requestEpoch !== epoch) return;
        // Shown at once, but not confirmed for the current audio until the map endpoint answers.
        if (cached) deps.onMap(cached, false);
      }
      const job = await refresh(ebook, recordingId);
      if (requestEpoch !== epoch) return;
      ensurePoll(ebook, recordingId, job);
    },
    /** The recording changed: the map shown is no longer the one to follow, until the next load shows one. */
    forget() {
      epoch++;
      stopPoll();
      deps.onMap(null, false);
    },
    stop() {
      epoch++;
      stopPoll();
    },
  };
}
