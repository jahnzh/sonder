// Pure judging code for the CTC-versus-Whisper probing gate (#278): the unchanged outlier rule applied to the
// samples each prober scored, the pick per title, and the comparison table. No database, files or network.
import { evaluateOutlierCheck, type OutlierCheckResult } from "../server/ebook-set-outlier.ts";
import type { AnchorFragment, AnchorTrack } from "../server/alignment-anchors.ts";
import type { AnchorSampleScore } from "../server/ebook-set-ctc-probe.ts";

export type PlannedSample = { trackId: string; time: number; duration: number };

export type CandidateOutcome = {
  candidate: string;
  passed: boolean;
  reason: OutlierCheckResult["reason"];
  spoken: number;
  matched: number;
  anchors: number;
  forward: boolean;
  /** Audio-supported coverage as the ebook set shows it: anchors over spoken samples. */
  coverage: number;
  /** Mean match score of the samples the rule counted as found. */
  meanScore: number;
};

export function judgeCandidate(
  candidate: string,
  planned: PlannedSample[],
  scores: AnchorSampleScore[],
  fragments: AnchorFragment[],
  passages: string[],
  tracks: AnchorTrack[],
): CandidateOutcome {
  if (scores.length !== planned.length)
    throw new Error(`${candidate}: ${scores.length} scores for ${planned.length} samples`);
  const samples = planned.map((sample, i) => ({
    ...sample,
    done: true,
    spokenWords: scores[i].spokenWords,
    match: scores[i].match,
  }));
  const result = evaluateOutlierCheck(samples, fragments, tracks, passages);
  const found = result.samples.filter((sample) => sample.score !== null && sample.score >= 0.5);
  return {
    candidate,
    passed: result.passed,
    reason: result.reason,
    spoken: result.spokenSampleCount,
    matched: result.matchedSampleCount,
    anchors: result.anchorCount,
    forward: result.forwardOrder,
    coverage: result.spokenSampleCount ? result.anchorCount / result.spokenSampleCount : 0,
    meanScore: found.length ? found.reduce((sum, sample) => sum + (sample.score ?? 0), 0) / found.length : 0,
  };
}

/**
 * The edition a prober would put in the set as its default: among the accepted candidates, the best audio-supported
 * coverage, then the higher mean match score, then the candidate key (so a tie is deterministic).
 */
export function pickEdition(outcomes: CandidateOutcome[]): CandidateOutcome | null {
  const accepted = outcomes.filter((outcome) => outcome.passed);
  accepted.sort(
    (a, b) => b.coverage - a.coverage || b.meanScore - a.meanScore || a.candidate.localeCompare(b.candidate),
  );
  return accepted[0] ?? null;
}

export type Verdict = "same" | "better" | "worse" | "neither correct";

export function verdict(truth: string, whisper: string | null, ctc: string | null): Verdict {
  if (ctc === whisper) return "same";
  if (ctc === truth) return "better";
  if (whisper === truth) return "worse";
  return "neither correct";
}

export type TitleResult = {
  title: string;
  /** The book the recording is. */
  truth: string;
  /** Candidate key to the book it holds, when several candidates are copies of one book. Default: the key. */
  books?: Record<string, string>;
  whisper: CandidateOutcome[];
  ctc: CandidateOutcome[];
};

/** The book a prober's pick holds: two copies of the right book are the same answer. */
export function pickedBook(entry: TitleResult, outcomes: CandidateOutcome[]) {
  const pick = pickEdition(outcomes);
  return pick ? (entry.books?.[pick.candidate] ?? pick.candidate) : null;
}

const titleVerdict = (entry: TitleResult) => verdict(entry.truth, pickedBook(entry, entry.whisper), pickedBook(entry, entry.ctc));

export const gatePasses = (titles: TitleResult[]) =>
  titles.every((entry) => {
    const outcome = titleVerdict(entry);
    return outcome === "same" || outcome === "better";
  });

const percent = (value: number) => `${Math.round(value * 100)}%`;
const label = (outcome: CandidateOutcome | null) =>
  outcome ? `${outcome.candidate} (${outcome.matched}/${outcome.spoken} found, ${percent(outcome.coverage)} anchored, mean ${outcome.meanScore.toFixed(2)})` : "none accepted";

function accepted(outcomes: CandidateOutcome[]) {
  return outcomes.filter((outcome) => outcome.passed).map((outcome) => outcome.candidate).join(", ") || "none";
}

/** Highest found count among candidates that are not the truth, as "matched/spoken". */
function worstWrong(outcomes: CandidateOutcome[], entry: TitleResult) {
  const wrong = outcomes.filter((outcome) => (entry.books?.[outcome.candidate] ?? outcome.candidate) !== entry.truth);
  const top = wrong.reduce<CandidateOutcome | null>((best, outcome) => (!best || outcome.matched > best.matched ? outcome : best), null);
  return top ? `${top.matched}/${top.spoken} (${top.candidate})` : "-";
}

export function renderTable(titles: TitleResult[]) {
  const lines = [
    "| Title | Right edition | Whisper pick | CTC pick | Whisper: right found, best wrong | CTC: right found, best wrong | Accepted (Whisper) | Accepted (CTC) | Verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of titles) {
    const whisperPick = pickEdition(entry.whisper);
    const ctcPick = pickEdition(entry.ctc);
    // The best-found copy of the right book.
    const right = (outcomes: CandidateOutcome[]) => {
      const rows = outcomes.filter((outcome) => (entry.books?.[outcome.candidate] ?? outcome.candidate) === entry.truth);
      const row = rows.reduce<CandidateOutcome | null>((best, outcome) => (!best || outcome.matched > best.matched ? outcome : best), null);
      return row ? `${row.matched}/${row.spoken}` : "-";
    };
    lines.push(
      `| ${entry.title} | ${entry.truth} | ${label(whisperPick)} | ${label(ctcPick)} | ${right(entry.whisper)}, ${worstWrong(entry.whisper, entry)} | ${right(entry.ctc)}, ${worstWrong(entry.ctc, entry)} | ${accepted(entry.whisper)} | ${accepted(entry.ctc)} | ${titleVerdict(entry)} |`,
    );
  }
  return lines.join("\n");
}
