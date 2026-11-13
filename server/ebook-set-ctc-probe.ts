// Ebook candidate probing with CTC (ADR 0005 amendment, ADR 0006): the ADR 0004 audio samples are scored against
// the recording's cached CTC emissions through the pool worker, instead of being transcribed with Whisper.
// This module talks to one worker and imports nothing from the database, so the gate script can use it directly.
import { join } from "node:path";
import { z } from "zod";
import { anchorResult, workerMetadata, type AnchorResult } from "./alignment-worker-contract.ts";
import { wordCount } from "./alignment-anchors.ts";
import { CTC_ENGINE } from "./alignment-pool.ts";

/** What the outlier rule needs from one sample: how many words were heard and where they match in the book. */
export type AnchorSampleScore = {
  spokenWords: number;
  match: { fragment: number; score: number; start: number } | null;
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
};

export class ProbeLanguageNotSupported extends Error {
  constructor() {
    super("The CTC engine only supports English.");
  }
}

/** Worker accepts up to 20,000 fragments, so very long books are sent as groups of consecutive paragraphs. */
const MAX_FRAGMENTS = 20000;
/** Windows per /anchor-batch request (the worker accepts 256). */
export const PROBE_BATCH_WINDOWS = 128;
const SINGLE_TIMEOUT_MS = 180_000;
const BATCH_TIMEOUT_MS = 30 * 60 * 1000;

const batchResult = z.object({
  ...workerMetadata.shape,
  results: z.array(anchorResult).max(PROBE_BATCH_WINDOWS),
});

export function groupFragments(texts: string[]) {
  const group = Math.max(1, Math.ceil(texts.length / MAX_FRAGMENTS));
  const blocks: string[] = [];
  for (let i = 0; i < texts.length; i += group) blocks.push(texts.slice(i, i + group).join(" "));
  return { group, blocks };
}

/**
 * Turns a worker answer into the sample the outlier rule reads. As in anchored alignment, a match whose audio
 * position lies outside the sample window is not evidence and counts as not found.
 */
export function sampleFromCtcAnchor(
  result: AnchorResult,
  window: { time: number; duration: number },
  group: number,
  blocks: number,
): AnchorSampleScore {
  if (result.engine !== CTC_ENGINE) throw new Error("The alignment worker did not use the requested CTC engine.");
  if (result.outcome === "language_not_supported") throw new ProbeLanguageNotSupported();
  if (result.outcome === "error") throw new Error("The speech recovery worker failed.");
  const start = result.start ?? window.time;
  const match =
    result.match && result.match.index < blocks && start >= window.time && start <= window.time + window.duration
      ? result.match
      : null;
  return {
    spokenWords: result.text ? wordCount(result.text) : 0,
    match: match ? { fragment: match.index * group, score: match.score, start } : null,
  };
}

/** The Whisper prober's answer (`/anchor` without an engine) in the same shape. */
export function sampleFromWhisperAnchor(
  result: { text?: string; start?: number; match?: { index: number; score: number } | null },
  fallbackStart: number,
): AnchorSampleScore {
  return {
    spokenWords: result.text ? wordCount(result.text) : 0,
    match: result.match
      ? { fragment: result.match.index, score: result.match.score, start: result.start ?? fallbackStart }
      : null,
  };
}

class WorkerStatusError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function post(target: CtcProbeTarget, path: string, body: object, timeout: number): Promise<unknown> {
  const response = await fetch(`${target.workerUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: target.token, ...body }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok)
    throw new WorkerStatusError(
      response.status === 504
        ? "The alignment worker timed out on this sample."
        : `The alignment worker could not score this sample (HTTP ${response.status}).`,
      response.status,
    );
  return response.json();
}

async function supportsBatch(target: CtcProbeTarget) {
  try {
    const response = await fetch(`${target.workerUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const health = (await response.json()) as { ctc?: { anchorBatch?: unknown } };
    return health.ctc?.anchorBatch === true;
  } catch {
    return false;
  }
}

/**
 * Scores every window against `fragmentTexts` on the worker, in window order. Windows of one track go in one
 * /anchor-batch request when the worker has it (one decode, one encoding pass for the uncached cores), and in
 * single /anchor requests otherwise. Both paths read and fill the recording's acoustic cache, so a second
 * candidate for the same recording costs only the text search.
 */
export async function scoreCtcSamples(
  target: CtcProbeTarget,
  input: { fragmentTexts: string[]; language: string; windows: ProbeWindow[] },
): Promise<AnchorSampleScore[]> {
  if (input.language !== "eng") throw new ProbeLanguageNotSupported();
  const { group, blocks } = groupFragments(input.fragmentTexts);
  const identity = { engine: "ctc", recordingId: target.recordingId, audioFingerprint: target.audioFingerprint };
  const scores: AnchorSampleScore[] = new Array(input.windows.length);
  let batch = await supportsBatch(target);
  const byTrack = new Map<string, number[]>();
  input.windows.forEach((window, index) => {
    const list = byTrack.get(window.trackId) ?? [];
    list.push(index);
    byTrack.set(window.trackId, list);
  });
  let requests = 0;
  const output = (name: string) => join(target.outputDir, `${name}-${requests++}.json`);
  for (const [trackId, indexes] of byTrack) {
    const todo = [...indexes];
    while (batch && todo.length) {
      const chunk = todo.slice(0, PROBE_BATCH_WINDOWS);
      let payload: unknown;
      try {
        payload = await post(
          target,
          "/anchor-batch",
          {
            audio: input.windows[chunk[0]].audio,
            output: output("probe-batch"),
            fragments: blocks,
            language: input.language,
            windows: chunk.map((index) => ({ start: input.windows[index].time, duration: input.windows[index].duration })),
            trackId,
            ...identity,
          },
          Math.min(SINGLE_TIMEOUT_MS * chunk.length, BATCH_TIMEOUT_MS),
        );
      } catch (error) {
        // A worker without /anchor-batch answers 404; score the rest of the windows one by one.
        if (error instanceof WorkerStatusError && error.status === 404) {
          batch = false;
          break;
        }
        throw error;
      }
      const parsed = batchResult.parse(payload);
      if (parsed.outcome === "language_not_supported") throw new ProbeLanguageNotSupported();
      if (parsed.results.length !== chunk.length)
        throw new Error("The alignment worker returned the wrong number of sample windows.");
      chunk.forEach((index, offset) => {
        scores[index] = sampleFromCtcAnchor(parsed.results[offset], input.windows[index], group, blocks.length);
      });
      todo.splice(0, chunk.length);
    }
    for (const index of todo) {
      const window = input.windows[index];
      const result = anchorResult.parse(
        await post(
          target,
          "/anchor",
          {
            audio: window.audio,
            output: output("probe"),
            fragments: blocks,
            language: input.language,
            start: window.time,
            duration: window.duration,
            trackId,
            ...identity,
          },
          SINGLE_TIMEOUT_MS,
        ),
      );
      scores[index] = sampleFromCtcAnchor(result, window, group, blocks.length);
    }
  }
  return scores;
}
