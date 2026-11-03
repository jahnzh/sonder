import type { AlignmentAnchoring } from "../src/reading-types.ts";
import {
  type AnchorFragment,
  type AnchorTrack,
  prefixWords,
  selectAnchors,
} from "./alignment-anchors.ts";

export const OUTLIER_MIN_SCORE = 0.5;
export const MIN_SPOKEN_WORDS = 10;

type Sample = AlignmentAnchoring["samples"][number];

export type OutlierSampleEvidence = {
  time: number;
  score: number | null;
  fragment: number | null;
  passage: string | null;
  spokenWords: number;
};

export type OutlierCheckResult = {
  passed: boolean;
  reason: "ok" | "no_spoken_samples" | "insufficient_matches" | "not_forward";
  spokenSampleCount: number;
  matchedSampleCount: number;
  anchorCount: number;
  forwardOrder: boolean;
  samples: OutlierSampleEvidence[];
};

function forwardAnchors(anchors: { fragment: number; time: number }[]) {
  for (let i = 1; i < anchors.length; i++)
    if (
      anchors[i].fragment <= anchors[i - 1].fragment ||
      anchors[i].time <= anchors[i - 1].time
    )
      return false;
  return true;
}

export function evaluateOutlierCheck(
  samples: Sample[],
  fragments: AnchorFragment[],
  tracks: AnchorTrack[],
  passages: string[],
  minScore = OUTLIER_MIN_SCORE,
): OutlierCheckResult {
  const words = prefixWords(fragments);
  const spoken = samples.filter(
    (sample) => sample.done && (sample.spokenWords ?? 0) >= MIN_SPOKEN_WORDS,
  );
  const matched = spoken.filter(
    (sample) => sample.match && sample.match.score >= minScore,
  );
  const evidence = samples
    .filter((sample) => sample.done)
    .map((sample) => ({
      time: sample.time,
      score: sample.match?.score ?? null,
      fragment: sample.match?.fragment ?? null,
      passage:
        sample.match && sample.match.fragment < passages.length
          ? passages[sample.match.fragment]?.slice(0, 240) ?? null
          : null,
      spokenWords: sample.spokenWords ?? 0,
    }));
  if (!spoken.length)
    return {
      passed: false,
      reason: "no_spoken_samples",
      spokenSampleCount: 0,
      matchedSampleCount: 0,
      anchorCount: 0,
      forwardOrder: true,
      samples: evidence,
    };
  if (matched.length < spoken.length / 2)
    return {
      passed: false,
      reason: "insufficient_matches",
      spokenSampleCount: spoken.length,
      matchedSampleCount: matched.length,
      anchorCount: 0,
      forwardOrder: true,
      samples: evidence,
    };
  const anchors = selectAnchors(samples, words, tracks, minScore);
  const forwardOrder = forwardAnchors(anchors);
  const passed =
    forwardOrder && anchors.length >= Math.ceil(spoken.length / 2);
  return {
    passed,
    reason: passed ? "ok" : "not_forward",
    spokenSampleCount: spoken.length,
    matchedSampleCount: matched.length,
    anchorCount: anchors.length,
    forwardOrder,
    samples: evidence,
  };
}
