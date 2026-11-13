import { isAdmin } from "../lib";
import { userStorageKey } from "../lib";
import { useEffect, useRef, useState } from "react";
import { BookOpen, Headphones, Loader2, Link2 } from "lucide-react";
import { api, clock } from "../lib";
import { alignmentJobNeedsPolling, createAlignmentMapLifecycle } from "../alignment-map-lifecycle";
import { alignmentMapDeps } from "../alignment-map-deps";
import { usePlayer } from "../player";
import { PoolFailureReasons } from "./PoolFailureReasons";
import type { Book } from "../types";
import type {
  AlignmentFlag,
  AlignmentJob,
  ReaderBook,
  TextLocator,
} from "../reading-types";
type Options = {
  sections: { index: number; title: string; paragraphs: number }[];
  clips: { trackId: string; title: string; start: number; duration: number }[];
  pairings: AlignmentJob["pairings"];
  sameWork: boolean;
  languageMatch: boolean;
  anchored?: boolean;
};
function flagText(flag: AlignmentFlag) {
  const range =
    flag.start !== undefined && flag.end !== undefined
      ? `${clock(flag.start)}–${clock(flag.end)}`
      : "";
  const where = flag.title ? ` (${flag.title})` : "";
  return {
    intro: `Introduction or credits not in the ebook: ${range}`,
    outro: `Closing credits or audio not in the ebook: ${range}`,
    "skipped-text": `Ebook text without matching narration near ${range}${where}. Left unsynced.`,
    "extra-audio": `Narration not found in the ebook: ${range}. Left unsynced.`,
    "unaligned": `Could not align ${range}${where}. Left unsynced.`,
    "unmatched-text": `Not found in the narration: ${flag.title || "untitled section"}`,
  }[flag.kind];
}
function progressText(job: AlignmentJob) {
  const plan = job.anchoring;
  if (job.mode !== "anchored" || !plan)
    return `${job.sectionsDone.length} of ${job.pairings.length} sections`;
  if (plan.stage === "sampling")
    return `Locating text: ${plan.samples.filter((sample) => sample.done).length} of ${plan.samples.length} narration samples`;
  return `${plan.anchors.length} anchors · ${plan.segments.filter((segment) => segment.done).length} of ${plan.segments.length} passages aligned`;
}
function savedOrChapteredRelease(book: ReaderBook, books: Book[]) {
  const saved = localStorage.getItem(userStorageKey(`reader-recording:${book.id}`));
  const candidates = books.filter(
    (audio) => audio.workId === book.workId && audio.tracks.length && !audio.faults?.recording,
  );
  return (
    candidates.find((audio) => audio.recordingId === saved)?.recordingId ||
    candidates.find((audio) =>
      audio.tracks.some((track) => track.chapters?.length),
    )?.recordingId ||
    candidates[0]?.recordingId ||
    ""
  );
}
export function ReadingSync({
  book,
  books,
  onMap,
  onLinked,
  locator,
  recordingId,
  loadOptions = false,
}: {
  book: ReaderBook;
  books: Book[];
  onMap: (job: AlignmentJob | null) => void;
  onLinked: () => void;
  locator?: TextLocator | null;
  recordingId?: string;
  /** When false (background-mounted), skip /alignments/options. */
  loadOptions?: boolean;
}) {
  const player = usePlayer();
  const epoch = useRef(0);
  // One lifecycle for the mounted reader: its server-confirmation history spans recording changes.
  const lifecycle = useRef<ReturnType<typeof createAlignmentMapLifecycle> | null>(null);
  lifecycle.current ??= createAlignmentMapLifecycle(alignmentMapDeps());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // While the sync panel is open, keep polling so changes made elsewhere (such
  // as another device pausing the job) show up; in the background only poll
  // jobs that are still processing.
  const visible = useRef(loadOptions);
  visible.current = loadOptions;
  const shouldPoll = (job: AlignmentJob | undefined) =>
    visible.current || alignmentJobNeedsPolling(job);
  const [jobs, setJobs] = useState<AlignmentJob[]>([]),
    [selected, setSelected] = useState(
      (player.book?.workId === book.workId ? player.book.recordingId : null) ||
        savedOrChapteredRelease(book, books),
    ),
    [options, setOptions] = useState<Options | null>(null),
    [pairings, setPairings] = useState<AlignmentJob["pairings"]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [available, setAvailable] = useState(true);
  const [anchorStart, setAnchorStart] = useState(0),
    [anchorEnd, setAnchorEnd] = useState(15);
  const selectedAudio = books.find((audio) => audio.recordingId === selected);
  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  const selectRelease = (recordingId: string) => {
    if (recordingId === selected) return;
    if (recordingId)
      localStorage.setItem(userStorageKey(`reader-recording:${book.id}`), recordingId);
    else localStorage.removeItem(userStorageKey(`reader-recording:${book.id}`));
    epoch.current++;
    setSelected(recordingId);
    setOptions(null);
    setPairings([]);
    onMap(null);
    setError("");
  };
  const refresh = (): Promise<AlignmentJob | undefined> => {
    const requestEpoch = epoch.current;
    return lifecycle.current!.refresh({
      ebook: { id: book.id, fingerprint: book.fingerprint },
      recordingId: selected,
      isCurrent: () => requestEpoch === epoch.current,
      onJobs: (next, isAvailable) => {
        setJobs(next);
        setAvailable(isAvailable);
      },
      onMap,
      onError: setError,
    });
  };
  const ensurePoll = (job: AlignmentJob | undefined) => {
    stopPoll();
    if (!shouldPoll(job)) return;
    pollRef.current = setInterval(() => {
      void refresh().then((updated) => {
        if (!shouldPoll(updated)) stopPoll();
      });
    }, 4000);
  };
  useEffect(() => {
    if (recordingId) selectRelease(recordingId);
  }, [recordingId]);
  useEffect(() => {
    if (!loadOptions) return;
    const requestEpoch = epoch.current;
    void refresh().then((job) => {
      if (requestEpoch === epoch.current) ensurePoll(job);
    });
  }, [loadOptions]);
  useEffect(() => {
    epoch.current++;
    const requestEpoch = epoch.current;
    let live = true;
    stopPoll();
    void (async () => {
      if (selected) {
        const cached = await lifecycle.current!.restore(
          { id: book.id, fingerprint: book.fingerprint },
          selected,
        );
        if (!live || requestEpoch !== epoch.current) return;
        if (cached) onMap(cached);
      }
      const job = await refresh();
      if (!live || requestEpoch !== epoch.current) return;
      ensurePoll(job);
    })();
    return () => {
      live = false;
      epoch.current++;
      stopPoll();
    };
  }, [book.id, selected]);
  useEffect(() => {
    if (!selected) {
      const matching = savedOrChapteredRelease(book, books);
      if (matching) setSelected(matching);
    }
  }, [books, book.workId]);
  useEffect(() => {
    let live = true;
    setOptions(null);
    if (!selected || !loadOptions || !isAdmin()) return;
    void api<Options>(
      "/alignments/options?" +
        new URLSearchParams({ ebookId: book.id, recordingId: selected }),
    )
      .then((value) => {
        if (!live) return;
        setOptions(value);
        setPairings(value.pairings);
      })
      .catch((error) => {
        if (live && navigator.onLine) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, [book.id, selected, book.workId, loadOptions]);
  const job = jobs.find((job) => job.recordingId === selected);
  const action = async (value: string) => {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      await api(`/alignments/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: value }),
      });
      ensurePoll(await refresh());
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const prepare = (forceAnchored = false) => {
    setBusy(true);
    setError("");
    void api("/alignments", {
      method: "POST",
      body: JSON.stringify({
        ebookId: book.id,
        recordingId: selected,
        ...(anchoredMode || forceAnchored === true ? { mode: "anchored" } : { pairings }),
      }),
    })
      .then(async () => ensurePoll(await refresh()))
      .catch((error) => setError(error.message))
      .finally(() => setBusy(false));
  };
  const noChapterMarkers =
    options?.clips.length === 1 &&
    !selectedAudio?.tracks.some((track) => track.chapters?.length);
  const anchoredMode = !!options?.anchored && !pairings.length;
  const blockedReason = !selected
    ? "Choose an audiobook release to prepare reading sync."
    : busy
      ? "Saving your reading-sync request…"
      : !available
        ? "The local alignment worker is not configured on this server."
        : !options
          ? error
            ? "Audio chapter details could not be loaded. Try selecting the release again."
            : "Loading audio chapter details…"
          : !options.sameWork
            ? "Link this EPUB to the selected book before preparing sync."
            : !options.languageMatch
              ? "The ebook and narration languages differ. Choose a release in the ebook’s language."
              : !pairings.length
                ? anchoredMode
                  ? options.clips.every((clip) => clip.duration <= 0)
                    ? "Audio lengths are unknown. Save this release to the server to read its chapter details."
                    : null
                  : noChapterMarkers && options.clips[0].duration > 7200
                  ? "This release is one long audio file without chapter markers. Choose a release with chapters, or open the chapter matcher and set an audio start and length for each ebook section."
                  : options.clips.every((clip) => clip.duration <= 0)
                    ? "Audio lengths are unknown. Save this release to the server to read its chapter details."
                    : "No ebook sections matched automatically. Open the chapter matcher and select at least one audio chapter."
                : null;
  const prepareDisabled = !!blockedReason;
  const chapteredAlternatives = books.filter(
    (audio) =>
      audio.recordingId !== selected &&
      audio.workId === book.workId &&
      audio.tracks.some((track) => track.chapters?.length),
  );
  if (!isAdmin()) return <section className="reading-sync"><h3>Reading sync</h3></section>;
  return (
    <section className="reading-sync">
      <h3>
        <Headphones size={17} /> Reading sync
      </h3>
      <label>
        Audiobook release
        <select
          aria-label="Reading sync audiobook release"
          disabled={busy}
          value={selected}
          onChange={(event) => selectRelease(event.target.value)}
        >
          <option value="">Choose a recording</option>
          {books
            .filter((audio) => audio.tracks.length > 0)
            .map((audio) => (
              <option key={audio.recordingId} value={audio.recordingId}>
                {audio.title} · {audio.language || "Language unknown"} ·{" "}
                {audio.narrator} · {audio.releaseTitle || audio.sourceLabel}
              </option>
            ))}
        </select>
      </label>
      {selectedAudio && (
        <p className="sync-release-info">
          {selectedAudio.narrator} ·{" "}
          {selectedAudio.language || "Language unknown"}
          {options
            ? ` · ${noChapterMarkers ? "No chapter markers" : `${options.clips.length} audio chapters`}`
            : ""}
        </p>
      )}
      {options && !options.sameWork && (
        <button
          className="button subtle"
          disabled={busy}
          onClick={() => {
            const audio = books.find((audio) => audio.recordingId === selected);
            if (audio)
              void api(`/reader/${encodeURIComponent(book.id)}/link`, {
                method: "POST",
                body: JSON.stringify({ workId: audio.workId }),
              })
                .then(onLinked)
                .catch((error) => setError(error.message));
          }}
        >
          <Link2 size={14} /> Link this EPUB to the selected book
        </button>
      )}
      {options && (
        <details>
          <summary>
            <span>Match ebook sections to audio chapters</span>{" "}
            <span className="sync-match-count">{pairings.length} matched</span>
          </summary>
          <p>
            Only matched sections are processed. Confirm the chapter boundaries
            for this edition.
          </p>
          {options.sections.map((section) => {
            const pairing = pairings.find(
              (pair) => pair.section === section.index,
            );
            return (
              <div key={section.index}>
                <label>
                  {section.title}
                  <select
                    aria-label={`Audio for ${section.title}`}
                    value={pairing ? `${pairing.trackId}:${pairing.start}` : ""}
                    onChange={(event) => {
                      const clip = options.clips.find(
                        (clip) =>
                          `${clip.trackId}:${clip.start}` ===
                          event.target.value,
                      );
                      setPairings((current) => [
                        ...current.filter(
                          (pair) => pair.section !== section.index,
                        ),
                        ...(clip
                          ? [
                              {
                                section: section.index,
                                trackId: clip.trackId,
                                start: clip.start,
                                duration: Math.min(7200, clip.duration),
                              },
                            ]
                          : []),
                      ]);
                    }}
                  >
                    <option value="">Leave unsynced</option>
                    {options.clips.map((clip) => (
                      <option
                        key={`${clip.trackId}:${clip.start}`}
                        value={`${clip.trackId}:${clip.start}`}
                        disabled={clip.duration <= 0}
                      >
                        {clip.title} · {clock(clip.duration)}
                      </option>
                    ))}
                  </select>
                </label>
                {pairing && (
                  <div className="chapter-bounds">
                    <label>
                      Start (seconds)
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        aria-label={`Start of ${section.title}`}
                        value={pairing.start}
                        onChange={(event) =>
                          setPairings((values) =>
                            values.map((pair) =>
                              pair.section === section.index
                                ? { ...pair, start: Number(event.target.value) }
                                : pair,
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      Length (seconds)
                      <input
                        type="number"
                        min="1"
                        max="7200"
                        step="0.1"
                        aria-label={`Length of ${section.title}`}
                        value={pairing.duration}
                        onChange={(event) =>
                          setPairings((values) =>
                            values.map((pair) =>
                              pair.section === section.index
                                ? {
                                    ...pair,
                                    duration: Number(event.target.value),
                                  }
                                : pair,
                            ),
                          )
                        }
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </details>
      )}
      {noChapterMarkers &&
        !pairings.length &&
        chapteredAlternatives.length > 0 && (
          <div className="sync-alternatives">
            <p>A release with chapter markers is available for this book.</p>
            {chapteredAlternatives.map((audio) => (
              <button
                key={audio.recordingId}
                className="button subtle"
                disabled={busy}
                onClick={() => selectRelease(audio.recordingId)}
              >
                Use {audio.narrator} · {audio.language || "Language unknown"}
              </button>
            ))}
          </div>
        )}
      {job && (
        <div className="alignment-status" role="status">
          <strong>
            {
              {
                queued: "Queued",
                copying: "Saving audio to your HDD",
                processing: "Preparing reading sync",
                paused: "Paused after current section",
                cancelled: "Cancelled",
                ready: "Ready · Estimated timings",
                partial:
                  job.progress === 1 && job.coverage > 0.95
                    ? "Ready · Estimated timings"
                    : "Partial alignment",
                error: "Needs attention",
              }[job.status]
            }
          </strong>
          <progress max="1" value={job.progress} />
          <p>
            {progressText(job)} · {Math.round(job.coverage * 100)}% of text
            mapped
            {job.elapsedSeconds > 0
              ? ` · ${clock(job.elapsedSeconds)} processing`
              : ""}
          </p>
          <p>
            Engine: {job.engine}{job.outcome ? ` · Outcome: ${job.outcome.replaceAll("_", " ")}` : ""}
            {job.gpuUtilization != null ? ` · GPU: ${Math.round(job.gpuUtilization)}%` : job.gpuUtilization === null ? " · GPU: n/a" : ""}
          </p>
          {job.stageTimings && Object.keys(job.stageTimings).length > 0 && (
            <p>
              {Object.entries(job.stageTimings).filter(([stage]) => stage !== "decodedTrackHit").map(([stage, seconds]) =>
                `${stage.replace(/([A-Z])/g, " $1").toLowerCase()}: ${seconds.toFixed(1)} s`
              ).join(" · ")}
            </p>
          )}
          {job.warning && <p>{job.warning}</p>}
          {!!job.unsyncedPassages?.length && (
            <details>
              <summary>Unsynced passages ({job.unsyncedPassages.length})</summary>
              <ul className="alignment-flags">
                {job.unsyncedPassages.map((passage) => (
                  <li key={passage.firstParagraphId}>
                    {passage.title}: {passage.excerpt} ({passage.sentenceCount} {passage.sentenceCount === 1 ? "sentence" : "sentences"})
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!job.anchoring?.flags.length && (
            <ul className="alignment-flags">
              {job.anchoring.flags.map((flag, index) => (
                <li key={index}>{flagText(flag)}</li>
              ))}
            </ul>
          )}
          {job.error && <p className="inline-error">{job.error}</p>}
          <PoolFailureReasons job={job} />
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="reading-sync-actions">
        {job && ["queued", "copying", "processing"].includes(job.status) ? (
          <>
            <button
              className="button subtle"
              onClick={() => void action("pause")}
              disabled={busy}
            >
              Pause after section
            </button>
            <button
              className="button subtle"
              onClick={() => void action("cancel")}
              disabled={busy}
            >
              Cancel
            </button>
          </>
        ) : job && ["paused", "error", "cancelled"].includes(job.status) ? (
          <>
            <button
              className="button subtle"
              onClick={() => void action("resume")}
              disabled={busy}
            >
              Resume / retry
            </button>
            <button
              className="button primary"
              disabled={prepareDisabled}
              aria-describedby="reading-sync-help"
              onClick={() => prepare()}
            >
              Rebuild reading sync
            </button>
          </>
        ) : (
          <button
            className="button primary"
            disabled={prepareDisabled}
            aria-describedby="reading-sync-help"
            onClick={() => prepare()}
          >
            {busy && <Loader2 size={15} className="spin" />}{" "}
            {job ? "Rebuild reading sync" : "Prepare reading sync"}
          </button>
        )}
        {job && !anchoredMode && !job.anchoring && ["partial", "error"].includes(job.status) && job.coverage < 0.05 && (
          <button
            className="button subtle"
            disabled={prepareDisabled}
            onClick={() => prepare(true)}
          >
            Rebuild without chapter matching
          </button>
        )}
      </div>
      <p id="reading-sync-help" className="sync-preparation-help" role="status">
        {blockedReason ||
          (anchoredMode
            ? "No chapter markers. Reading sync samples the narration to locate the ebook text, then aligns the passages between those points."
            : null) ||
          `${pairings.length} ebook ${pairings.length === 1 ? "section matched" : "sections matched"} to audio. Review the chapter matches, then prepare sentence timings.`}
      </p>
      {job &&
        locator &&
        player.book?.recordingId === selected &&
        player.track &&
        !["queued", "copying", "processing"].includes(job.status) && (
          <details className="manual-anchor">
            <summary>Correct this sentence’s timing</summary>
            <p>{locator.quote || "Current sentence"}</p>
            <div className="chapter-bounds">
              <label>
                Start (seconds)
                <input
                  type="number"
                  min="0"
                  max={player.track.duration}
                  step="0.1"
                  value={anchorStart}
                  onChange={(event) =>
                    setAnchorStart(Number(event.target.value))
                  }
                />
              </label>
              <label>
                End (seconds)
                <input
                  type="number"
                  min="0"
                  max={player.track.duration}
                  step="0.1"
                  value={anchorEnd}
                  onChange={(event) => setAnchorEnd(Number(event.target.value))}
                />
              </label>
            </div>
            <div className="reading-sync-actions">
              <button
                className="button subtle"
                onClick={() =>
                  setAnchorStart(Math.round(player.position * 10) / 10)
                }
              >
                Set start to audio position
              </button>
              <button
                className="button subtle"
                onClick={() =>
                  setAnchorEnd(Math.round(player.position * 10) / 10)
                }
              >
                Set end to audio position
              </button>
              <button
                className="button primary"
                disabled={busy || anchorEnd <= anchorStart}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void api<AlignmentJob>(`/alignments/${job.id}/anchors`, {
                    method: "POST",
                    body: JSON.stringify({
                      paragraphId: locator.paragraphId,
                      trackId: player.track!.id,
                      start: anchorStart,
                      end: anchorEnd,
                    }),
                  })
                    .then(async (value) => {
                      await lifecycle.current!.saveCorrected(book.id, selected, value);
                      onMap(value);
                      ensurePoll(await refresh());
                    })
                    .catch((error) => setError(error.message))
                    .finally(() => setBusy(false));
                }}
              >
                Save sentence timing
              </button>
            </div>
          </details>
        )}
      <p className="reading-local-note">
        Processed locally on your server. Audio and sync files stay on the 4 TB
        HDD. Timings are estimated.
      </p>
    </section>
  );
}
