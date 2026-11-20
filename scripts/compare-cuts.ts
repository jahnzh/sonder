// The comparing step of scripts/compare-extractor.ts: two cuts of every edition of a library, edition by edition.
import { createHash } from "node:crypto";

export type Sentence = { id: string; text: string; blockIndex: number; start: number; end: number };
/** One edition as one side read it: its chapters and sentences, or why it could not be read. */
export type Dumped = { id: string; title: string; failed?: string; sections?: { index: number; href: string; title: string; blocks?: string; paragraphs: Sentence[] }[]; held?: number; total?: number };

const share = (dumped: Dumped) => (dumped.total ? Math.round(((dumped.held ?? 0) / dumped.total) * 1000) / 10 : null);
const digest = (dumped: Dumped) => createHash("sha256").update(JSON.stringify(dumped.sections)).digest("hex");
/** The first place two cuts of one edition part ways. */
function firstDifference(a: Dumped, b: Dumped) {
  const [left, right] = [a.sections!, b.sections!];
  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    const [one, two] = [left[at], right[at]];
    if (!one || !two) return `chapter ${at}: before ${one ? `file ${one.index}` : "none"}, after ${two ? `file ${two.index}` : "none"}`;
    if (one.index !== two.index || one.href !== two.href || one.title !== two.title) return `chapter ${at}: before ${one.index} ${one.href} "${one.title}", after ${two.index} ${two.href} "${two.title}"`;
    for (let n = 0; n < Math.max(one.paragraphs.length, two.paragraphs.length); n++) {
      const [x, y] = [one.paragraphs[n], two.paragraphs[n]];
      if (JSON.stringify(x) !== JSON.stringify(y))
        return `file ${one.index}, sentence ${n}: before ${x ? `${x.id} (${x.text.length} characters, block ${x.blockIndex})` : "none"}, after ${y ? `${y.id} (${y.text.length} characters, block ${y.blockIndex})` : "none"}`;
    }
    if (one.blocks !== two.blocks) return `file ${one.index}: block rule before ${one.blocks ?? "standard"}, after ${two.blocks ?? "standard"}`;
  }
  return "the chapters and sentences are equal and something else differs";
}

/**
 * Compares the two sides. An edition is identical only when both sides read it and every chapter and sentence is
 * equal; one that a side could not read is failed, never identical. `ok` is false when an edition failed, when no
 * edition was read, or when the changed editions are not exactly the expected ones (none, without `expected`).
 */
export function compareCuts(was: Dumped[], now: Dumped[], expected?: string[]) {
  const later = new Map(now.map((dumped) => [dumped.id, dumped]));
  const count = (dumped?: Dumped) => dumped?.sections?.reduce((sum, section) => sum + section.paragraphs.length, 0) ?? 0;
  const editions = was.map((a) => {
    const b = later.get(a.id);
    const failed = a.failed || !b || b.failed ? `before: ${a.failed ?? "read"}; after: ${b ? (b.failed ?? "read") : "not in the second run's copy of the database"}` : undefined;
    const identical = !failed && digest(a) === digest(b!);
    return {
      id: a.id,
      title: a.title,
      identical,
      failed,
      difference: failed || identical ? undefined : firstDifference(a, b!),
      sentencesBefore: count(a),
      sentencesAfter: count(b),
      shareBefore: share(a),
      shareAfter: b ? share(b) : null,
    };
  });
  const failed = editions.filter((edition) => edition.failed);
  const changed = editions.filter((edition) => !edition.identical && !edition.failed);
  const identical = editions.filter((edition) => edition.identical);
  const changedButNotExpected = changed.filter((edition) => !expected?.includes(edition.id)).map((edition) => edition.id);
  const expectedButNotChanged = (expected ?? []).filter((id) => !changed.some((edition) => edition.id === id));
  return {
    editions,
    ok: !failed.length && identical.length + changed.length > 0 && !changedButNotExpected.length && !expectedButNotChanged.length,
    summary: {
      editions: editions.length,
      identical: identical.length,
      sentencesInIdenticalEditions: identical.reduce((sum, edition) => sum + edition.sentencesAfter, 0),
      changed: changed.map((edition) => ({ id: edition.id, title: edition.title, sentences: `${edition.sentencesBefore} → ${edition.sentencesAfter}`, shareOfText: `${edition.shareBefore} % → ${edition.shareAfter} %`, firstDifference: edition.difference })),
      failed: failed.map((edition) => ({ id: edition.id, title: edition.title, why: edition.failed })),
      ...(expected ? { expected, changedButNotExpected, expectedButNotChanged } : { changedButNotExpected }),
    },
  };
}
