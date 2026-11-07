import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coreIntervals,
  mismatch,
  planSamples,
  planSegments,
  prefixWords,
  refinementSamples,
  selectAnchors,
  speakingRate,
  stitch,
} from "../server/alignment-anchors.ts";
import type { AlignmentAnchoring } from "../src/reading-types.ts";
type Sample = AlignmentAnchoring["samples"][number];
// 1,200 sentences of 15 words in sections of 60, read at 2.5 words per second
// (6 s per sentence). Section 0 is front matter that is never narrated.
const fragments = Array.from({ length: 1200 }, (_, i) => ({
  words: 15,
  section: Math.floor(i / 60),
}));
const words = prefixWords(fragments);
type Piece = { from: number; to: number } | { silence: number };
// 45 s of credits, chapters from section 1, sentences 400–449 skipped by the
// narrator, 300 s of audio not in the ebook after sentence 800, closing credits.
const script: Piece[] = [
  { silence: 45 },
  { from: 60, to: 400 },
  { from: 450, to: 800 },
  { silence: 300 },
  { from: 800, to: 1200 },
  { silence: 40 },
];
function narration() {
  const timeline: { start: number; end: number; fragment: number | null }[] =
    [];
  let at = 0;
  for (const piece of script)
    if ("silence" in piece) {
      timeline.push({ start: at, end: at + piece.silence, fragment: null });
      at += piece.silence;
    } else
      for (let f = piece.from; f < piece.to; f++) {
        timeline.push({ start: at, end: at + 6, fragment: f });
        at += 6;
      }
  return { timeline, duration: at };
}
const { timeline, duration } = narration();
const tracks = [{ id: "single", duration }];
function hear(sample: Sample): Sample {
  const spoken = timeline.find(
    (piece) => piece.end > sample.time + 1 && piece.fragment !== null,
  );
  const usable = spoken && spoken.start < sample.time + sample.duration - 5;
  return {
    ...sample,
    done: true,
    spokenWords: usable ? 60 : 0,
    match: usable
      ? {
          fragment: spoken.fragment!,
          score: 0.9,
          start: Math.max(sample.time, spoken.start),
        }
      : null,
  };
}
test("samples cover both ends densely and never overlap", () => {
  const samples = planSamples(tracks);
  assert.ok(samples.length >= 12);
  assert.equal(samples[0].time, 10);
  assert.ok(samples[samples.length - 1].time >= duration - 32);
  for (let i = 1; i < samples.length; i++)
    assert.ok(samples[i].time - samples[i - 1].time >= 40);
  assert.deepEqual(planSamples([{ id: "short", duration: 20 }]), [
    { trackId: "short", time: 0, duration: 20 },
  ]);
  assert.deepEqual(planSamples([{ id: "unknown", duration: 0 }]), []);
  const edges = planSamples(tracks, undefined, undefined, true);
  assert.equal(edges[0].time, 0);
  assert.equal(edges[edges.length - 1].time + edges[edges.length - 1].duration, duration);
  assert.deepEqual(planSamples([{ id: "short", duration: 45 }], undefined, undefined, true), [
    { trackId: "short", time: 0, duration: 30 },
    { trackId: "short", time: 15, duration: 30 },
  ]);
});
test("a repeated phrase matched elsewhere and a backward match are rejected as outliers", () => {
  const samples = planSamples(tracks).map(hear);
  const genuine = selectAnchors(samples, words, tracks);
  const middle = samples.findIndex(
    (sample) => sample.match && sample.time > duration / 2,
  );
  // Same score, plausible order, wrong place: a recurring system message.
  samples[middle] = {
    ...samples[middle],
    match: { ...samples[middle].match!, fragment: 1150, score: 0.95 },
  };
  // A later sample that matched an early sentence.
  samples[middle + 2] = {
    ...samples[middle + 2],
    match: { ...samples[middle + 2].match!, fragment: 70, score: 0.8 },
  };
  const anchors = selectAnchors(samples, words, tracks);
  assert.ok(!anchors.some((anchor) => anchor.fragment === 1150));
  assert.ok(!anchors.some((anchor) => anchor.fragment === 70 && anchor.time > 600));
  assert.equal(anchors.length, genuine.length - 2);
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i].fragment > anchors[i - 1].fragment);
    assert.ok(anchors[i].time > anchors[i - 1].time);
  }
  assert.ok(Math.abs(speakingRate(anchors, words, tracks) - 2.5) < 0.1);
  const weak = samples.map((sample) =>
    sample.match ? { ...sample, match: { ...sample.match, score: 0.4 } } : sample,
  );
  assert.equal(selectAnchors(weak, words, tracks).length, 0);
});
test("the monotonic chain keeps alternatives without using one sample twice", () => {
  const alternatives: Sample[] = [
    { trackId: "single", time: 0, duration: 30, matches: [
      { fragment: 0, score: 0.9, start: 0 },
      { fragment: 900, score: 0.95, start: 1 },
    ] },
    { trackId: "single", time: 100, duration: 30, matches: [
      { fragment: 30, score: 0.9, start: 100 },
      { fragment: 31, score: 0.9, start: 101 },
    ] },
    { trackId: "single", time: 200, duration: 30, matches: [{ fragment: 60, score: 0.9, start: 200 }] },
  ];
  const chain = selectAnchors(alternatives, words, tracks);
  assert.equal(chain.length, 3);
  assert.equal(chain[0].fragment, 0);
  assert.equal(chain[2].fragment, 60);
});
test("the last window includes the full passage heard at the recording end", () => {
  const fragments = Array.from({ length: 25 }, (_, index) => ({ words: 10, section: index < 18 ? 0 : 1 }));
  const anchors = [{ trackId: "track", time: 970, fragment: 10, lastFragment: 20, score: 0.9 }];
  const planned = planSegments(anchors, fragments, [{ id: "track", duration: 1000 }], 2.5);
  assert.equal(planned.segments[0].coreLast, 20);
  assert.equal(planned.segments[0].start + planned.segments[0].duration, 1000);
});
test("refinement samples halve windows whose spacing disagrees with the text", () => {
  let samples = planSamples(tracks).map(hear);
  for (let round = 0; round < 2; round++) {
    const anchors = selectAnchors(samples, words, tracks);
    const extra = refinementSamples(
      anchors,
      samples,
      words,
      speakingRate(anchors, words, tracks),
    );
    assert.ok(extra.length > 0);
    samples = [...samples, ...extra.map(hear)].sort((a, b) => a.time - b.time);
  }
  assert.equal(mismatch(600, 600), null);
  assert.equal(mismatch(300, 600), "skipped-text");
  assert.equal(mismatch(900, 400), "extra-audio");
  assert.equal(mismatch(70, 40), null, "small differences are pacing");
  assert.equal(mismatch(660, 600), null);
  assert.equal(mismatch(540, 600), null);
});
test("windows partition the text, overlap at their edges and flag credits, skips and extra audio", () => {
  let samples = planSamples(tracks).map(hear);
  for (let round = 0; round < 2; round++) {
    const anchors = selectAnchors(samples, words, tracks);
    samples = [
      ...samples,
      ...refinementSamples(anchors, samples, words, 2.5).map(hear),
    ].sort((a, b) => a.time - b.time);
  }
  const anchors = selectAnchors(samples, words, tracks);
  const { segments, flags } = planSegments(anchors, fragments, tracks, 2.5);
  const kinds = flags.map((flag) => flag.kind);
  const intro = flags.find((flag) => flag.kind === "intro")!;
  assert.ok(Math.abs(intro.end! - 45) < 8, `intro ends at ${intro.end}`);
  const outro = flags.find((flag) => flag.kind === "outro")!;
  assert.ok(Math.abs(outro.start! - (duration - 40)) < 8);
  assert.ok(kinds.includes("skipped-text"));
  const extra = flags.find((flag) => flag.kind === "extra-audio")!;
  const inserted = 45 + (340 + 350) * 6;
  assert.ok(extra.start! <= inserted + 1 && extra.end! >= inserted + 299);
  const skipped = flags.find((flag) => flag.kind === "skipped-text")!;
  assert.ok(skipped.first! <= 400 && skipped.last! >= 449);
  assert.ok(segments.length > 5);
  for (const [i, segment] of segments.entries()) {
    assert.ok(segment.first <= segment.coreFirst);
    assert.ok(segment.last >= segment.coreLast);
    assert.ok(segment.duration > 0 && segment.duration <= 7200);
    if (i) assert.ok(segment.coreFirst > segments[i - 1].coreLast);
  }
  assert.ok(segments[0].coreFirst >= 60, "front matter is not aligned");
  assert.ok(segments[0].coreFirst <= 62);
  assert.ok(segments.some((segment) => segment.first < segment.coreFirst));
  // Each window's audio contains its core sentences' real narration.
  for (const segment of segments)
    for (let f = segment.coreFirst; f <= segment.coreLast; f++) {
      const real = timeline.find((piece) => piece.fragment === f);
      if (!real) continue;
      assert.ok(
        real.start >= segment.start - 1 &&
          real.end <= segment.start + segment.duration + 1,
        `sentence ${f} (${real.start}s) lies outside its window`,
      );
    }
});
test("a mismatched edition yields too few anchors to proceed", () => {
  const samples = planSamples(tracks).map((sample, i) => ({
    ...sample,
    done: true,
    spokenWords: 50,
    match: i % 5 === 0 ? { fragment: 1100 - i, score: 0.62, start: sample.time } : null,
  }));
  const anchors = selectAnchors(samples, words, tracks);
  const spoken = samples.length;
  assert.ok(anchors.length < 3 || anchors.length < spoken * 0.3);
});
test("stitching keeps core sentences in order without overlaps", () => {
  const segment = {
    trackId: "single",
    start: 100,
    duration: 60,
    first: 8,
    last: 20,
    coreFirst: 10,
    coreLast: 18,
  };
  const core = coreIntervals(
    segment,
    Array.from({ length: 13 }, (_, index) => ({
      index,
      start: 100 + index * 4,
      end: 104 + index * 4,
    })),
  );
  assert.deepEqual(
    core.map((interval) => interval.fragment),
    [10, 11, 12, 13, 14, 15, 16, 17, 18],
  );
  const order = new Map(["a", "b", "c", "d"].map((id, i) => [id, i]));
  const interval = (paragraphId: string, start: number, end: number) => ({
    paragraphId,
    section: 1,
    trackId: "single",
    start,
    end,
    confidence: 0.65,
  });
  const stitched = stitch(
    [
      interval("c", 9, 12),
      interval("a", 0, 5),
      interval("b", 4, 10),
      interval("d", 8, 9),
    ],
    order,
    tracks,
  );
  assert.deepEqual(
    stitched.map((value) => [value.paragraphId, value.start, value.end]),
    [
      ["a", 0, 5],
      ["b", 5, 10],
      ["c", 10, 12],
    ],
  );
});
