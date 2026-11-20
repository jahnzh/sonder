// Recaps at several positions and gaps for one book and one set of stored notes, with the code checks of each.
//   npx tsx prototypes/recap-local/matrix.ts --book <book.json> --states <states.json> --out <recaps.json> --gaps 7,70 (--fixture | --at 0.1,0.45,0.85) [--assemble]
// --fixture takes the three cutoffs of fixture/traps.ts and tests each recap against the facts that come after its
// cutoff and against the handbill's injection. --at takes cutoffs at those shares of the book's sentences.
import { readFileSync, writeFileSync } from "node:fs";
import { type Book, type States } from "./lib.ts";
import { recap, type Recap } from "./recap.ts";
import { bareMara, injection, positions } from "./fixture/traps.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const bookPath = option("book"),
  statesPath = option("states"),
  out = option("out");
if (!bookPath || !statesPath || !out || (!args.includes("--fixture") && !option("at"))) {
  process.stderr.write("usage: npx tsx prototypes/recap-local/matrix.ts --book <book.json> --states <states.json> --out <recaps.json> --gaps 7,70 (--fixture | --at 0.1,0.45,0.85) [--assemble]\n");
  process.exit(2);
}
const book = JSON.parse(readFileSync(bookPath, "utf8")) as Book;
const states = JSON.parse(readFileSync(statesPath, "utf8")) as States;
const gaps = (option("gaps") ?? "7,70").split(",").map(Number);

type Flag = { name: string; certain: boolean; line: string };
type Row = Recap & { position: string; note?: string; leaks: Flag[]; injection: Flag[]; bareMara: string[] };

const cutoffs = args.includes("--fixture")
  ? positions.map((position) => {
      const sentence = book.sentences.find((candidate) => candidate.text.startsWith(position.at));
      if (!sentence) throw new Error(`The fixture has no sentence starting "${position.at}"`);
      return { name: position.name, id: sentence.id, note: position.note, traps: position.traps };
    })
  : option("at")!
      .split(",")
      .map(Number)
      .map((share) => ({ name: `${Math.round(share * 100)}%`, id: book.sentences[Math.min(book.sentences.length - 1, Math.round(share * (book.sentences.length - 1)))].id, note: undefined, traps: undefined }));

const rows: Row[] = [];
for (const cutoff of cutoffs)
  for (const gap of gaps) {
    const result = await recap(book, states, cutoff.id, gap, args.includes("--assemble") ? "assembled" : "written");
    // Flags are raised on the recap as shown (the kept claims), one claim at a time.
    const lines = result.claims.filter((claim) => claim.ok).map((claim) => claim.text);
    const flags = (traps: { name: string; pattern: RegExp; certain: boolean }[]) => traps.flatMap((trap) => lines.filter((line) => trap.pattern.test(line)).map((line) => ({ name: trap.name, certain: trap.certain, line })));
    const row: Row = { ...result, position: cutoff.name, note: cutoff.note, leaks: cutoff.traps ? flags(cutoff.traps) : [], injection: cutoff.traps ? flags(injection) : [], bareMara: cutoff.traps ? lines.filter((line) => bareMara.test(line)) : [] };
    rows.push(row);
    process.stdout.write(`${cutoff.name} (${cutoff.id}), ${gap} d: ${row.words} words (target ${row.target.join("–")}${row.bandLimitedByText ? ", band limited by the words read" : ""}), kept ${row.kept}/${row.offered}${row.fromStoredNotes ? ` (${row.fromStoredNotes} stored notes)` : ""}, ${row.dropped} dropped, ${row.duplicates} repeats, ${Math.round(row.timing.ms)} ms${cutoff.traps ? `, ${row.leaks.length} leak flags, ${row.injection.length} injection flags` : ""}\n`);
  }
writeFileSync(out, JSON.stringify({ label: states.label, book: book.title, rows }, null, 2));
