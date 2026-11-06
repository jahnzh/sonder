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

function alignTwoMemberLists(left: ConsensusRow[], right: MemberSentence[]): ConsensusRow[] {
  const n = left.length, m = right.length;
  if (!n) return right.map(sentence => ({ text: sentence.text, norm: sentence.norm, memberParagraphIds: [sentence.paragraphId] }));
  if (!m) return left.map(row => ({ ...row, memberParagraphIds: [...row.memberParagraphIds, null] }));
  const band = consensusAlignBand(n, m);
  const offsets = new Float64Array(n + 2);
  for (let i = 0; i <= n; i++)
    offsets[i + 1] = offsets[i] + Math.max(0, Math.min(m, i + band) - Math.max(0, i - band) + 1);
  const trace = new Uint8Array(offsets[n + 1]);
  const width = Math.min(m + 1, 2 * band + 1);
  let prev = new Float64Array(width), current = new Float64Array(width);
  prev.fill(-Infinity);
  let prevMin = 0, prevMax = Math.min(m, band);
  for (let j = 0; j <= prevMax; j++) { prev[j] = -j; trace[j] = 2; }
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(0, i - band), hi = Math.min(m, i + band);
    current.fill(-Infinity);
    if (lo === 0) { current[0] = -i; trace[offsets[i]] = 1; }
    for (let j = Math.max(1, lo); j <= hi; j++) {
      const k = j - lo;
      let best = -Infinity, step = 0;
      if (left[i - 1].norm === right[j - 1].norm) {
        const diag = (j - 1 >= prevMin && j - 1 <= prevMax ? prev[j - 1 - prevMin] : -Infinity) + 2;
        if (diag > best) { best = diag; step = 0; }
      }
      const up = (j >= prevMin && j <= prevMax ? prev[j - prevMin] : -Infinity) - 1;
      if (up > best) { best = up; step = 1; }
      const along = (j > lo ? current[k - 1] : -Infinity) - 1;
      if (along > best) { best = along; step = 2; }
      current[k] = best;
      trace[offsets[i] + k] = step;
    }
    [prev, current] = [current, prev];
    prevMin = lo; prevMax = hi;
  }
  const out: ConsensusRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const lo = Math.max(0, i - band), hi = Math.min(m, i + band);
    const step = j >= lo && j <= hi ? trace[offsets[i] + j - lo] : (j > 0 ? 2 : 1);
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

