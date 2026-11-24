// Step (a): an EPUB as ordered chapters of sentences with the reader's own sentence ids.
//   npx tsx prototypes/recap-local/extract.ts <book.epub> <book.json> [--title "Title"] [--author "Name"]
// It uses the server's `cutEpub` (server/reader.ts), so ids are the ones reading places and alignment maps use.
// Importing that module opens the server's database module; it is pointed at a temp folder, which is removed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Book } from "./lib.ts";

const [source, out, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};
if (!source || !out) {
  process.stderr.write('usage: npx tsx prototypes/recap-local/extract.ts <book.epub> <book.json> [--title "Title"] [--author "Name"]\n');
  process.exit(2);
}

const temp = mkdtempSync(join(tmpdir(), "recap-extract-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
try {
  const { cutEpub } = await import("../../server/reader.ts");
  const { sqlite } = await import("../../server/db.ts");
  const cut = await cutEpub(readFileSync(source));
  sqlite.close();
  const book: Book = { title: option("title") ?? "", author: option("author") ?? "", fingerprint: cut.fingerprint, chapters: [], sentences: [] };
  for (const section of cut.sections) {
    const first = book.sentences.length;
    for (const sentence of section.paragraphs) book.sentences.push({ id: sentence.id, text: sentence.text, ord: book.sentences.length, section: section.index, block: sentence.blockIndex });
    book.chapters.push({ section: section.index, title: section.title, first, last: book.sentences.length - 1 });
  }
  writeFileSync(out, JSON.stringify(book));
  const total = book.sentences.reduce((sum, sentence) => sum + sentence.text.split(/\s+/).length, 0);
  process.stdout.write(`${out}: ${book.chapters.length} chapters, ${book.sentences.length} sentences, ${total} words\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
