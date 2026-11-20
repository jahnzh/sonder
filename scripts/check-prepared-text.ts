// Checks prepared reader text against a whole library: for every EPUB edition, each tagged sentence of the prepared
// HTML must be the stored sentence (extractBook), with every id present exactly once and in order.
//
//   npx tsx scripts/check-prepared-text.ts --db <sonder.db> [--out <report.json>] [--timings <n>] [--only <edition id>]
//
// It reads and never writes the library. The database is copied with the online backup (server/db-backup.mjs) and
// the copy is opened, the EPUB files are only read, and the prepared output goes to a temp folder that is removed.
// `--timings <n>` (default 3) also measures the n books with the most text: preparing from nothing, then serving the
// manifest and every part from the cache through the routes. Exit code 1 when a sentence differs or a book fails.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { backupDatabase } from "../server/db-backup.mjs";

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const source = option("db");
if (!source) {
  process.stderr.write("usage: npx tsx scripts/check-prepared-text.ts --db <sonder.db> [--out <report.json>] [--timings <n>] [--only <edition id>]\n");
  process.exit(2);
}
const timed = Number(option("timings") ?? 3);
const only = option("only");
const temp = mkdtempSync(join(tmpdir(), "sonder-prepared-check-"));
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
mkdirSync(join(temp, "db"), { mode: 0o700 });
await backupDatabase(resolve(source), join(temp, "db", "sonder.db"));
// The server's modules read these when they load: the copy is the database, and nothing is written outside `temp`.
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.PREPARED_TEXT_DIR = join(temp, "prepared");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
const { sqlite } = await import("../server/db.ts");
const { extractBook, invalidateParsedBook } = await import("../server/reader.ts");
const { sentencesOfParts } = await import("../server/prepared-text.ts");
const { buildPrepared, registerPreparedText } = await import("../server/prepared-text-cache.ts");
const { normalizeReaderText } = await import("../src/reading-types.ts");
const { default: Fastify } = await import("fastify");

type Manifest = import("../server/prepared-text.ts").PreparedManifest;
type Result = {
  id: string;
  title: string;
  epubBytes: number;
  sentences: number;
  /** Tagged sentences equal to the stored text as the extractor normalises it, and those equal character for character. */
  equal: number;
  identical: number;
  mismatches: string[];
  failed?: string;
  parts: number;
  chars: number;
  preparedBytes: number;
  largestPart: number;
  pictures: number;
  extractMs: number;
  prepareMs: number;
};
const readPrepared = (dir: string) => {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  return { manifest, parts: manifest.parts.map((part) => readFileSync(join(dir, `p${part.index}.html`), "utf8")) };
};

const rows = sqlite
  .prepare("SELECT e.id AS id, e.source AS source, w.title AS title FROM ebook_editions e JOIN works w ON w.id=e.work_id WHERE e.format='epub' AND e.id NOT LIKE 'set-consensus:%' ORDER BY e.id")
  .all() as { id: string; source: string; title: string }[];
const results: Result[] = [];
for (const row of rows.filter((candidate) => !only || candidate.id === only)) {
  const result: Result = { id: row.id, title: row.title, epubBytes: 0, sentences: 0, equal: 0, identical: 0, mismatches: [], parts: 0, chars: 0, preparedBytes: 0, largestPart: 0, pictures: 0, extractMs: 0, prepareMs: 0 };
  results.push(result);
  let dir = "";
  try {
    if (!existsSync(row.source)) throw new Error("the EPUB file is not on the media drive");
    result.epubBytes = statSync(row.source).size;
    let start = performance.now();
    const book = await extractBook(row.id);
    result.extractMs = Math.round(performance.now() - start);
    const stored = book.sections.flatMap((section) => section.paragraphs);
    result.sentences = stored.length;
    start = performance.now();
    ({ dir } = await buildPrepared(row.id));
    result.prepareMs = Math.round(performance.now() - start);
    const { manifest, parts } = readPrepared(dir);
    result.parts = parts.length;
    result.chars = manifest.chars;
    result.pictures = manifest.pictures;
    result.preparedBytes = manifest.parts.reduce((sum, part) => sum + part.bytes, 0);
    result.largestPart = Math.max(...manifest.parts.map((part) => part.bytes));
    const note = (message: string) => void (result.mismatches.length < 20 ? result.mismatches.push(message) : result.mismatches.length === 20 && result.mismatches.push("…"));
    // Read back from the HTML alone: what a reader's page will hold.
    const found = sentencesOfParts(parts);
    found.problems.forEach(note);
    const byId = new Map(found.sentences.map((sentence) => [sentence.id, sentence]));
    stored.forEach((sentence, index) => {
      const tagged = byId.get(sentence.id);
      if (!tagged) return note(`${sentence.id}: not tagged`);
      if (found.sentences[index]?.id !== sentence.id) note(`${sentence.id}: out of order (place ${index} holds ${found.sentences[index]?.id})`);
      if (normalizeReaderText(tagged.text) !== sentence.text) return note(`${sentence.id}: tagged ${JSON.stringify(tagged.text.slice(0, 80))}, stored ${JSON.stringify(sentence.text.slice(0, 80))}`);
      result.equal++;
      if (tagged.text === sentence.text) result.identical++;
    });
    if (found.sentences.length !== stored.length) note(`${found.sentences.length} sentences are tagged, ${stored.length} are stored`);
    // The manifest must say what the parts hold.
    let ordinal = 0;
    manifest.parts.forEach((part, index) => {
      const own = found.sentences.filter((sentence) => sentence.part === index);
      if (part.bytes !== Buffer.byteLength(parts[index])) note(`part ${index}: the manifest gives ${part.bytes} bytes, the part has ${Buffer.byteLength(parts[index])}`);
      if (part.sentences !== own.length || part.ordinal !== ordinal || part.first !== (own[0]?.id ?? null) || part.last !== (own.at(-1)?.id ?? null))
        note(`part ${index}: the manifest gives ${part.sentences} sentences ${part.first}–${part.last} from ${part.ordinal}, the part has ${own.length} ${own[0]?.id}–${own.at(-1)?.id} from ${ordinal}`);
      ordinal += own.length;
    });
    for (const problem of manifest.problems) note(`manifest: ${problem}`);
    if (manifest.pictures !== (existsSync(join(dir, "pictures")) ? readdirSync(join(dir, "pictures")).length : 0)) note("the pictures on disk are not those the manifest counts");
  } catch (error) {
    result.failed = error instanceof Error ? error.message : String(error);
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  invalidateParsedBook(row.id);
  process.stderr.write(`${result.failed ? "FAILED" : result.mismatches.length ? "DIFFERS" : "ok"}  ${row.id}  ${result.sentences} sentences, ${result.parts} parts  ${row.title}${result.failed ? `: ${result.failed}` : ""}\n`);
}

// Sizes and timings of the books with the most text.
const timings: object[] = [];
const app = Fastify();
registerPreparedText(app);
for (const result of [...results].filter((candidate) => !candidate.failed).sort((a, b) => b.chars - a.chars).slice(0, timed)) {
  invalidateParsedBook(result.id);
  let start = performance.now();
  const cold = await app.inject(`/api/reader/${encodeURIComponent(result.id)}/prepared`);
  const coldMs = performance.now() - start;
  const manifest = cold.json() as Manifest;
  start = performance.now();
  await app.inject(`/api/reader/${encodeURIComponent(result.id)}/prepared`);
  const manifestMs = performance.now() - start;
  const partMs: number[] = [];
  for (const part of manifest.parts) {
    start = performance.now();
    const response = await app.inject(`/api/reader/${encodeURIComponent(result.id)}/prepared/${manifest.key}/parts/${part.index}`);
    partMs.push(performance.now() - start);
    if (response.statusCode !== 200) throw new Error(`part ${part.index} of ${result.id} answered ${response.statusCode}`);
  }
  const round = (value: number) => Math.round(value * 10) / 10;
  timings.push({
    id: result.id,
    title: result.title,
    epubBytes: result.epubBytes,
    sentences: result.sentences,
    chars: result.chars,
    parts: manifest.parts.length,
    preparedBytes: result.preparedBytes,
    meanPartBytes: Math.round(result.preparedBytes / manifest.parts.length),
    largestPartBytes: result.largestPart,
    manifestBytes: Buffer.byteLength(cold.body),
    pictures: result.pictures,
    prepareColdMs: Math.round(coldMs),
    manifestFromCacheMs: round(manifestMs),
    partFromCacheMeanMs: round(partMs.reduce((sum, value) => sum + value, 0) / partMs.length),
    partFromCacheMaxMs: round(Math.max(...partMs)),
    allPartsFromCacheMs: round(partMs.reduce((sum, value) => sum + value, 0)),
  });
}
await app.close();
sqlite.close();

const failed = results.filter((result) => result.failed);
const differing = results.filter((result) => result.mismatches.length);
const summary = {
  books: results.length,
  prepared: results.length - failed.length,
  sentences: results.reduce((sum, result) => sum + result.sentences, 0),
  equal: results.reduce((sum, result) => sum + result.equal, 0),
  identical: results.reduce((sum, result) => sum + result.identical, 0),
  mismatches: results.reduce((sum, result) => sum + (result.failed ? 0 : result.sentences - result.equal), 0),
  booksWithMismatches: differing.map((result) => ({ id: result.id, title: result.title, mismatches: result.mismatches })),
  booksThatFailed: failed.map((result) => ({ id: result.id, title: result.title, why: result.failed })),
  timings,
};
const out = option("out");
if (out) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), JSON.stringify({ ...summary, results }, null, 2));
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = failed.length || differing.length ? 1 : 0;
