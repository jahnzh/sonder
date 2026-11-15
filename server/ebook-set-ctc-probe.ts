// Ebook candidate probing with CTC (ADR 0005 amendment, ADR 0006): the ADR 0004 audio samples are scored against
// the recording's cached CTC emissions through the pool worker, instead of being transcribed with Whisper.
// This module talks to one worker and imports nothing from the database, so the gate script can use it directly.
import { join } from "node:path";
import { anchorResult, type AnchorResult } from "./alignment-worker-contract.ts";
import { wordCount } from "./alignment-anchors.ts";
import { CTC_ENGINE } from "./alignment-pool.ts";

/** One located match the outlier rule / selectAnchors can consider (including alternate occurrences). */
export type AnchorMatchScore = {
  fragment: number;
  lastFragment?: number;
  score: number;
  start: number;
};

/** What the outlier rule needs from one sample: how many words were heard and where they match in the book. */
export type AnchorSampleScore = {
  spokenWords: number;
  match: AnchorMatchScore | null;
  /** Alternate locations for repeated passages; same shape as anchored alignment samples. */
  matches?: AnchorMatchScore[];
};

export type ProbeWindow = { trackId: string; audio: string; time: number; duration: number };

export type CtcProbeTarget = {
  /** Worker base URL, without a trailing slash. */
  workerUrl: string;
  token: string;
  /** Directory inside the worker's MEDIA_ROOT/alignment that receives the request's output files. */
  outputDir: string;
  /** Identity of the recording's acoustic cache; the same values a full alignment of it sends. */
  recordingId: string;
  audioFingerprint: string;
  /** Ends a request still running when the caller's deadline passes. */
  signal?: AbortSignal;
  /**
   * Called as each request of `durationSeconds` audio is sent; the returned function is called once its response
   * arrives. A request without a response (aborted, timed out) may still run on the worker.
   */
  trackRequest?: (durationSeconds: number) => () => void;
};

export class ProbeLanguageNotSupported extends Error {
  constructor() {
    super("The CTC engine only supports English.");
  }
}

/** Worker accepts up to 20,000 fragments, so very long books are sent as groups of consecutive paragraphs. */
const MAX_FRAGMENTS = 20000;
const SAMPLE_TIMEOUT_MS = 180_000;

export function groupFragments(texts: string[]) {
  const group = Math.max(1, Math.ceil(texts.length / MAX_FRAGMENTS));
  const blocks: string[] = [];
  for (let i = 0; i < texts.length; i += group) blocks.push(texts.slice(i, i + group).join(" "));
  return { group, blocks };
}

/**
 * Turns a worker answer into the sample the outlier rule reads. As in anchored alignment, a match whose audio
 * position lies outside the sample window is not evidence and counts as not found. Alternate locations
 * (`matches` / `lastFragment`) are kept so selectAnchors can disambiguate repeated passages (LOW-1).
 */
export function sampleFromCtcAnchor(
  result: AnchorResult,
  window: { time: number; duration: number },
  group: number,
  blocks: number,
  paragraphCount = blocks * group,
): AnchorSampleScore {
  if (result.engine !== CTC_ENGINE) throw new Error("The alignment worker did not use the requested CTC engine.");
  if (result.outcome === "language_not_supported") throw new ProbeLanguageNotSupported();
  if (result.outcome === "error") throw new Error("The speech recovery worker failed.");
  const inSample = (index: number, start: number) =>
    index < blocks && start >= window.time && start <= window.time + window.duration;
  const start = result.start ?? window.time;
  const match = result.match && inSample(result.match.index, start) ? result.match : null;
  const lastFragment = (index: number, lastIndex: number | undefined) =>
    lastIndex !== undefined && lastIndex >= index && lastIndex < blocks
      ? Math.min(paragraphCount - 1, (lastIndex + 1) * group - 1)
      : undefined;
  const mapped = (item: { index: number; lastIndex?: number; score: number }, at: number): AnchorMatchScore => ({
    fragment: item.index * group,
    ...(lastFragment(item.index, item.lastIndex) === undefined
      ? {}
      : { lastFragment: lastFragment(item.index, item.lastIndex) }),
    score: item.score,
    start: at,
  });
  return {
    spokenWords: result.text ? wordCount(result.text) : 0,
    match: match ? mapped(match, start) : null,
    ...(result.matches
      ? {
          matches: result.matches
            .filter((item) => inSample(item.index, item.start))
            .map((item) => mapped(item, item.start)),
        }
      : {}),
  };
}

const NETWORK_RETRIES = 2;

async function post(
  target: CtcProbeTarget, path: string, body: { duration: number; [field: string]: unknown }, timeout: number,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    // The worker has finished a request once its response arrives; until then it may still be running it.
    const answered = target.trackRequest?.(body.duration);
    try {
      response = await fetch(`${target.workerUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: target.token, ...body }),
        signal: target.signal ? AbortSignal.any([AbortSignal.timeout(timeout), target.signal]) : AbortSignal.timeout(timeout),
      });
    } catch (error) {
      // A kept-alive connection the worker just closed fails the next request; scoring a sample is idempotent.
      if (error instanceof TypeError && attempt < NETWORK_RETRIES) continue;
      throw error;
    }
    answered?.();
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        response.status === 504
          ? "The alignment worker timed out on this sample."
          : `The alignment worker could not score this sample (HTTP ${response.status}${detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 160)}` : ""}).`,
      );
    }
    return response.json();
  }
}

/**
 * Scores every window against `fragmentTexts` on the worker, in window order, one /anchor request per window.
 * Each request reads the recording's acoustic cache and fills it for the cores it had to encode, so a second
 * candidate for the same recording costs only the audio extraction and the text search. (/anchor-batch decodes
 * the whole track on every request, which costs more than the cached windows it would save.)
 */
export async function scoreCtcSamples(
  target: CtcProbeTarget,
  input: { fragmentTexts: string[]; language: string; windows: ProbeWindow[] },
): Promise<AnchorSampleScore[]> {
  if (input.language !== "eng") throw new ProbeLanguageNotSupported();
  const { group, blocks } = groupFragments(input.fragmentTexts);
  const scores: AnchorSampleScore[] = [];
  for (const [index, window] of input.windows.entries()) {
    const result = anchorResult.parse(
      await post(
        target,
        "/anchor",
        {
          audio: window.audio,
          output: join(target.outputDir, `probe-${index}.json`),
          fragments: blocks,
          language: input.language,
          start: window.time,
          duration: window.duration,
          engine: "ctc",
          recordingId: target.recordingId,
          audioFingerprint: target.audioFingerprint,
          trackId: window.trackId,
        },
        SAMPLE_TIMEOUT_MS,
      ),
    );
    scores.push(sampleFromCtcAnchor(result, window, group, blocks.length, input.fragmentTexts.length));
  }
  return scores;
}
