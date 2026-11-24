// The name check on stored outputs: claims with a capitalised word that is nowhere in the text read up to their
// cutoff (`namesNotIn` in lib.ts). No model is called.
//   node prototypes/recap-local/names.ts <book.json> <recaps.json or states.json>...
import { readFileSync } from "node:fs";
import { namesNotIn, unitsOf, wordsOf, type Book, type States } from "./lib.ts";
import type { Recap } from "./recap.ts";

const [bookPath, ...files] = process.argv.slice(2);
if (!bookPath || !files.length) {
  process.stderr.write("usage: node prototypes/recap-local/names.ts <book.json> <recaps.json or states.json>...\n");
  process.exit(2);
}
const book = JSON.parse(readFileSync(bookPath, "utf8")) as Book;
/** The words read up to a sentence, built once per cutoff. */
const readTo = new Map<number, Set<string>>();
const read = (ord: number) => {
  if (!readTo.has(ord)) readTo.set(ord, new Set(book.sentences.slice(0, ord + 1).flatMap((sentence) => wordsOf(sentence.text))));
  return readTo.get(ord)!;
};
for (const file of files) {
  const stored = JSON.parse(readFileSync(file, "utf8")) as { rows?: Recap[] } & Partial<States>;
  const claims: { text: string; cutoff: number }[] = stored.rows
    ? stored.rows.flatMap((row) => row.claims.filter((claim) => claim.ok).map((claim) => ({ text: claim.text, cutoff: row.cutoffOrd })))
    : (() => {
        const units = unitsOf(book, stored.unitBudget!);
        return Object.values(stored.notes!).map((note) => ({ text: note.text, cutoff: units[note.unit].last }));
      })();
  const counts = new Map<string, number>();
  let flagged = 0;
  for (const claim of claims) {
    const names = namesNotIn(claim.text, read(claim.cutoff));
    if (names.length) flagged++;
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => `${name} ${count}`).join(", ");
  process.stdout.write(`${file}: ${flagged} of ${claims.length} claims have a name that is not in the text read${top ? `: ${top}` : ""}\n`);
}
