// Snapshot of the pre-compact implementation, for output comparison.
export type MemberSentence = {
  norm: string;
  text: string;
  paragraphId: string;
  section: number;
};

export type ConsensusRow = {
  text: string;
  norm: string;
  memberParagraphIds: (string | null)[];
};

/** Max |i−j| in banded sentence alignment (full novels stay near the diagonal). */
export const CONSENSUS_ALIGN_BAND = 1500;

function consensusAlignBand(n: number, m: number) {
  const slack = Math.abs(n - m);
  const scaled = Math.ceil(Math.max(n, m) * 0.03);
  return Math.min(m, Math.max(slack, 64, Math.min(CONSENSUS_ALIGN_BAND, scaled)));
}

function alignTwoMemberLists(
  left: ConsensusRow[],
  right: MemberSentence[],
): ConsensusRow[] {
  const n = left.length;
  const m = right.length;
  if (!n) {
    return right.map((sentence) => ({
      text: sentence.text,
      norm: sentence.norm,
      memberParagraphIds: [sentence.paragraphId],
    }));
  }
  if (!m) {
    return left.map((row) => ({
      ...row,
      memberParagraphIds: [...row.memberParagraphIds, null],
    }));
  }
  const band = consensusAlignBand(n, m);
  const key = (i: number, j: number) => i * (m + 1) + j;
  const inBand = (i: number, j: number) =>
    i >= 0 && j >= 0 && i <= n && j <= m && Math.abs(i - j) <= band;
  const score = new Map<number, number>();
  const dir = new Map<number, 0 | 1 | 2>();
  const get = (i: number, j: number) =>
    score.get(key(i, j)) ?? Number.NEGATIVE_INFINITY;
  score.set(key(0, 0), 0);
  for (let j = 1; j <= m; j++) {
    if (!inBand(0, j)) continue;
    score.set(key(0, j), get(0, j - 1) - 1);
    dir.set(key(0, j), 2);
  }
  for (let i = 1; i <= n; i++) {
    if (inBand(i, 0)) {
      score.set(key(i, 0), get(i - 1, 0) - 1);
      dir.set(key(i, 0), 1);
    }
    const jMin = Math.max(1, i - band);
    const jMax = Math.min(m, i + band);
    for (let j = jMin; j <= jMax; j++) {
      let best = Number.NEGATIVE_INFINITY;
      let step: 0 | 1 | 2 = 0;
      if (left[i - 1].norm === right[j - 1].norm) {
        const diag = get(i - 1, j - 1) + 2;
        if (diag > best) {
          best = diag;
          step = 0;
        }
      }
      const up = get(i - 1, j) - 1;
      if (up > best) {
        best = up;
        step = 1;
      }
      const leftStep = get(i, j - 1) - 1;
      if (leftStep > best) {
        best = leftStep;
        step = 2;
      }
      score.set(key(i, j), best);
      dir.set(key(i, j), step);
    }
  }
  const out: ConsensusRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = dir.get(key(i, j)) ?? (j > 0 ? 2 : 1);
    if (step === 0 && i > 0 && j > 0) {
      const row = left[i - 1];
      out.push({
        text: row.text,
        norm: row.norm,
        memberParagraphIds: [...row.memberParagraphIds, right[j - 1].paragraphId],
      });
      i--;
      j--;
    } else if (step === 2 && j > 0) {
      const sentence = right[j - 1];
      out.push({
        text: sentence.text,
        norm: sentence.norm,
        memberParagraphIds: [
          ...Array.from({ length: left[0]?.memberParagraphIds.length ?? 0 }, () => null),
          sentence.paragraphId,
        ],
      });
      j--;
    } else if (i > 0) {
      const row = left[i - 1];
      out.push({
        ...row,
        memberParagraphIds: [...row.memberParagraphIds, null],
      });
      i--;
    } else {
      j--;
    }
  }
  out.reverse();
  return out;
}

export function buildConsensusRows(memberLists: MemberSentence[][]) {
  if (!memberLists.length) return [] as ConsensusRow[];
  let rows: ConsensusRow[] = memberLists[0].map((sentence) => ({
    text: sentence.text,
    norm: sentence.norm,
    memberParagraphIds: [sentence.paragraphId],
  }));
  for (let index = 1; index < memberLists.length; index++)
    rows = alignTwoMemberLists(rows, memberLists[index]);
  return rows;
}

