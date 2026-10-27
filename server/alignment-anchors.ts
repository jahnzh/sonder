// Anchored alignment for recordings without chapter markers. Short narration
// samples are located in the ebook, outliers are rejected, and known-text
// alignment then runs on bounded windows between the surviving anchors.
import type {
  AlignmentAnchoring,
  AlignmentFlag,
  AlignmentInterval,
} from "../src/reading-types.ts";
type Sample = AlignmentAnchoring["samples"][number];
type Anchor = AlignmentAnchoring["anchors"][number];
type Segment = AlignmentAnchoring["segments"][number];
export type AnchorTrack = { id: string; duration: number };
export type AnchorFragment = { words: number; section: number };
export const EXCERPT_SECONDS = 30;
export const MIN_ANCHOR_SCORE = 0.6;
const HEAD = [10, 60, 150, 300];
const SLACK = 45;
export const wordCount = (text: string) =>
  text.split(/\s+/).filter(Boolean).length;
export function prefixWords(fragments: AnchorFragment[]) {
  const starts = [0];
  for (const fragment of fragments)
    starts.push(starts[starts.length - 1] + fragment.words);
  return starts;
}
// Samples are dense near both ends of each file so credits and the start of
// the narration are located closely, and evenly spaced elsewhere.
export function planSamples(
  tracks: AnchorTrack[],
  interval = 600,
  excerpt = EXCERPT_SECONDS,
): Sample[] {
  const samples: Sample[] = [];
  for (const track of tracks) {
    const duration = track.duration;
    if (!(duration > 0)) continue;
    if (duration <= excerpt + 1) {
      samples.push({ trackId: track.id, time: 0, duration });
      continue;
    }
    const last = duration - excerpt - 1,
      spacing = Math.min(interval, Math.max(60, duration / 12));
    const times = [...HEAD, ...HEAD.map((value) => last - value + 10)];
    for (let time = HEAD[HEAD.length - 1] + spacing; time < last; time += spacing)
      times.push(time);
    let previous = -Infinity;
    for (const time of times
      .map((value) => Math.min(last, Math.max(0, value)))
      .sort((a, b) => a - b)) {
      if (time - previous < excerpt + 10) continue;
      samples.push({ trackId: track.id, time, duration: excerpt });
      previous = time;
    }
  }
  return samples;
}
function trackOffsets(tracks: AnchorTrack[]) {
  const offsets: Record<string, number> = {};
  let total = 0;
  for (const track of tracks) {
    offsets[track.id] = total;
    total += Math.max(0, track.duration);
  }
  return offsets;
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : 0;
};
function pairRate(
  a: Anchor,
  b: Anchor,
  words: number[],
  offsets: Record<string, number>,
) {
  return (
    (words[b.fragment] - words[a.fragment]) /
    Math.max(1, offsets[b.trackId] + b.time - offsets[a.trackId] - a.time)
  );
}
// Words per second between consecutive anchors. Pairs closer than a minute are
// left out because the fragment granularity dominates their estimate.
export function speakingRate(
  anchors: Anchor[],
  words: number[],
  tracks: AnchorTrack[],
) {
  const offsets = trackOffsets(tracks);
  const rates = anchors
    .slice(1)
    .map((anchor, i) => ({
      gap:
        offsets[anchor.trackId] +
        anchor.time -
        offsets[anchors[i].trackId] -
        anchors[i].time,
      rate: pairRate(anchors[i], anchor, words, offsets),
    }))
    .filter((pair) => pair.gap >= 60)
    .map((pair) => pair.rate);
  return median(rates) || 2.5;
}
// Keeps the highest-scoring chain that moves forward in both audio and text,
// then drops anchors whose neighbours disagree in opposite directions: a
// repeated phrase matched elsewhere in the book, rather than a skipped passage
// (which only slows or speeds up one side).
export function selectAnchors(
  samples: Sample[],
  words: number[],
  tracks: AnchorTrack[],
  minScore = MIN_ANCHOR_SCORE,
) {
  const offsets = trackOffsets(tracks);
  const candidates: (Anchor & { at: number })[] = samples
    .filter(
      (sample) =>
        sample.match &&
        sample.match.score >= minScore &&
        offsets[sample.trackId] !== undefined,
    )
    .map((sample) => ({
      trackId: sample.trackId,
      time: sample.match!.start,
      fragment: sample.match!.fragment,
      score: sample.match!.score,
      at: offsets[sample.trackId] + sample.match!.start,
    }))
    .sort((a, b) => a.at - b.at);
  const best = candidates.map((candidate) => candidate.score),
    previous = candidates.map(() => -1);
  for (let i = 0; i < candidates.length; i++)
    for (let j = 0; j < i; j++)
      if (
        candidates[j].fragment < candidates[i].fragment &&
        candidates[j].at < candidates[i].at &&
        best[j] + candidates[i].score > best[i]
      ) {
        best[i] = best[j] + candidates[i].score;
        previous[i] = j;
      }
  let end = best.indexOf(Math.max(...best));
  const chain: Anchor[] = [];
  while (end >= 0) {
    const { at: _at, ...anchor } = candidates[end];
    chain.unshift(anchor);
    end = previous[end];
  }
  const factor = 2.5;
  while (chain.length >= 4) {
    const rate = speakingRate(chain, words, tracks);
    const rates = chain
      .slice(1)
      .map((anchor, i) => pairRate(chain[i], anchor, words, offsets) / rate);
    let worst = -1,
      deviation = 0;
    for (let i = 0; i < chain.length; i++) {
      const before = rates[i - 1],
        after = rates[i];
      const displaced =
        before === undefined
          ? after > 4 || after < 1 / 4
          : after === undefined
            ? before > 4 || before < 1 / 4
            : (before > factor && after < 1 / factor) ||
              (before < 1 / factor && after > factor);
      if (!displaced) continue;
      const amount = Math.max(
        ...[before, after]
          .filter((value) => value !== undefined)
          .map((value) => Math.abs(Math.log(Math.max(value, 1e-6)))),
      );
      if (amount > deviation) {
        deviation = amount;
        worst = i;
      }
    }
    if (worst < 0) break;
    chain.splice(worst, 1);
  }
  return chain;
}
// Narration much shorter (skipped text) or longer (extra audio) than the text
// between two anchors, beyond normal pacing differences.
export function mismatch(seconds: number, expected: number) {
  if (seconds / expected < 0.75 && expected - seconds > SLACK)
    return "skipped-text" as const;
  if (seconds / expected > 1.3 && seconds - expected > SLACK)
    return "extra-audio" as const;
  return null;
}
// Extra samples halfway between anchors whose spacing looks wrong, to narrow
// down where narration and text disagree before giving up on that window.
export function refinementSamples(
  anchors: Anchor[],
  samples: Sample[],
  words: number[],
  rate: number,
  excerpt = EXCERPT_SECONDS,
): Sample[] {
  const added: Sample[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1],
      b = anchors[i];
    if (a.trackId !== b.trackId || b.time - a.time < 240) continue;
    const expected = (words[b.fragment] - words[a.fragment]) / rate;
    if (!mismatch(b.time - a.time, expected)) continue;
    const time = (a.time + b.time) / 2 - excerpt / 2;
    if (
      samples.some(
        (sample) =>
          sample.trackId === a.trackId && Math.abs(sample.time - time) < 60,
      )
    )
      continue;
    added.push({ trackId: a.trackId, time, duration: excerpt });
  }
  return added;
}
// Splits the text into consecutive core ranges, one per window between
// anchors, and pads each window with overlapping text and audio so the
// aligner's uncertain edges fall outside the part that is kept.
export function planSegments(
  anchors: Anchor[],
  fragments: AnchorFragment[],
  tracks: AnchorTrack[],
  rate: number,
  overlap = 20,
) {
  const words = prefixWords(fragments),
    segments: Segment[] = [],
    flags: AlignmentFlag[] = [];
  const seconds = (first: number, last: number) =>
    last < first ? 0 : (words[last + 1] - words[first]) / rate;
  const sectionStart = (index: number) => {
    while (index > 0 && fragments[index - 1].section === fragments[index].section)
      index--;
    return index;
  };
  const sectionEnd = (index: number) => {
    while (
      index < fragments.length - 1 &&
      fragments[index + 1].section === fragments[index].section
    )
      index++;
    return index;
  };
  // Where the anchor's sentence begins: the matched words are on average half
  // way through it.
  const begins = (anchor: Anchor) =>
    Math.max(0, anchor.time - seconds(anchor.fragment, anchor.fragment) / 2);
  let lower = 0;
  const used = tracks.filter((track) =>
    anchors.some((anchor) => anchor.trackId === track.id),
  );
  for (const [trackIndex, track] of used.entries()) {
    const own = anchors.filter((anchor) => anchor.trackId === track.id),
      first = own[0],
      last = own[own.length - 1];
    const next = anchors.find(
      (anchor) => anchor.trackId === used[trackIndex + 1]?.id,
    );
    // Text read before the first anchor of this file: the rest of its section,
    // limited to what fits in the audio before it.
    let headStart = first.fragment;
    for (
      let budget = begins(first) * rate * 1.15;
      headStart > Math.max(lower, sectionStart(first.fragment)) &&
      words[first.fragment] - words[headStart - 1] <= budget;
    )
      headStart--;
    let tailEnd = last.fragment;
    for (
      let budget = (track.duration - begins(last)) * rate * 1.15,
        limit = Math.min(
          sectionEnd(last.fragment),
          (next?.fragment ?? fragments.length) - 1,
        );
      tailEnd < limit &&
      words[tailEnd + 2] - words[last.fragment] <= budget;
    )
      tailEnd++;
    lower = tailEnd + 1;
    const narrationStart = Math.max(
        0,
        begins(first) - seconds(headStart, first.fragment - 1),
      ),
      narrationEnd = Math.min(
        track.duration,
        begins(last) + seconds(last.fragment, tailEnd),
      );
    const isFirst = trackIndex === 0,
      isLast = trackIndex === used.length - 1;
    if (narrationStart > 20)
      flags.push({
        kind: isFirst ? "intro" : "extra-audio",
        trackId: track.id,
        start: 0,
        end: narrationStart,
      });
    if (track.duration - narrationEnd > 20)
      flags.push({
        kind: isLast ? "outro" : "extra-audio",
        trackId: track.id,
        start: narrationEnd,
        end: track.duration,
      });
    const bounds = own.length > 1 ? own : [first];
    const windows = Math.max(1, bounds.length - 1);
    for (let k = 0; k < windows; k++) {
      const a = bounds[k],
        b = bounds[k + 1];
      const coreFirst = k === 0 ? headStart : a.fragment,
        coreLast = b && k < windows - 1 ? b.fragment - 1 : tailEnd;
      if (coreLast < coreFirst) continue;
      if (b) {
        const kind = mismatch(
          b.time - a.time,
          seconds(a.fragment, b.fragment - 1),
        );
        if (kind) {
          flags.push({
            kind,
            trackId: track.id,
            start: a.time,
            end: b.time,
            section: fragments[a.fragment].section,
            first: coreFirst,
            last: coreLast,
          });
          continue;
        }
      }
      let start = k === 0 ? Math.max(0, narrationStart - 5) : begins(a),
        end = !b || k === windows - 1 ? Math.min(track.duration, narrationEnd + 5) : begins(b);
      let windowFirst = coreFirst,
        windowLast = coreLast;
      if (k > 0) {
        while (
          windowFirst > bounds[k - 1].fragment &&
          words[coreFirst] - words[windowFirst] < overlap * rate
        )
          windowFirst--;
        start = Math.max(begins(bounds[k - 1]), start - seconds(windowFirst, coreFirst - 1));
      }
      if (b && k < windows - 1) {
        while (
          windowLast < bounds[k + 2].fragment - 1 &&
          words[windowLast + 1] - words[coreLast + 1] < overlap * rate
        )
          windowLast++;
        end = Math.min(begins(bounds[k + 2]), end + seconds(coreLast + 1, windowLast));
      }
      start = Math.max(0, start);
      end = Math.min(track.duration, end);
      if (end - start > 7200 || end <= start) {
        flags.push({
          kind: "unaligned",
          trackId: track.id,
          start,
          end,
          first: coreFirst,
          last: coreLast,
        });
        continue;
      }
      segments.push({
        trackId: track.id,
        start,
        duration: end - start,
        first: windowFirst,
        last: windowLast,
        coreFirst,
        coreLast,
      });
    }
  }
  return { segments, flags };
}
// Keeps only a window's core sentences and those inside its audio.
export function coreIntervals(
  segment: Segment,
  intervals: { index: number; start: number; end: number }[],
) {
  return intervals
    .map((interval) => ({ ...interval, fragment: segment.first + interval.index }))
    .filter(
      (interval) =>
        interval.fragment >= segment.coreFirst &&
        interval.fragment <= segment.coreLast &&
        interval.end > interval.start &&
        interval.start >= segment.start - 0.5 &&
        interval.end <= segment.start + segment.duration + 1,
    );
}
// Joins window results into one ordered map with no overlapping or
// backward-moving sentences.
export function stitch(
  intervals: AlignmentInterval[],
  order: Map<string, number>,
  tracks: AnchorTrack[],
) {
  const offsets = trackOffsets(tracks);
  const sorted = [...intervals].sort(
    (a, b) => (order.get(a.paragraphId) ?? 0) - (order.get(b.paragraphId) ?? 0),
  );
  const result: AlignmentInterval[] = [];
  for (const interval of sorted) {
    const previous = result[result.length - 1];
    if (previous?.paragraphId === interval.paragraphId) continue;
    let start = interval.start;
    if (previous) {
      const before = offsets[previous.trackId] + previous.end,
        at = offsets[interval.trackId] + interval.start;
      if (offsets[interval.trackId] + interval.end <= before) continue;
      if (at < before) start += before - at;
    }
    if (interval.end - start < 0.05) continue;
    result.push({ ...interval, start });
  }
  return result;
}
