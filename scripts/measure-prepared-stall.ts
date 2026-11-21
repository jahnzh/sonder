// Measures what preparing a book's text costs the server's own thread (#827): for each edition, how long the event
// loop was held at most ("longest block") and the total time, for extractBook (the cut of the sentences, which runs
// first and on the server's thread), for preparing on a thread of its own (what the server does), and for the same
// preparing run on the server's thread (what it did before #827).
//
//   npx tsx scripts/measure-prepared-stall.ts --db <sonder.db> <edition id>...
//
// Like scripts/check-prepared-text.ts it works on a backup copy of the database, only reads the EPUB files and
// prepares into a temp folder that it removes.
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { backupDatabase } from "../server/db-backup.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--db");
const source = at >= 0 ? args[at + 1] : undefined;
const ids = args.filter((_value, index) => at < 0 || (index !== at && index !== at + 1));
if (!source || !ids.length) {
  process.stderr.write("usage: npx tsx scripts/measure-prepared-stall.ts --db <sonder.db> <edition id>...\n");
  process.exit(2);
}
const temp = mkdtempSync(join(tmpdir(), "sonder-prepared-stall-"));
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
mkdirSync(join(temp, "db"), { mode: 0o700 });
await backupDatabase(resolve(source), join(temp, "db", "sonder.db"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.PREPARED_TEXT_DIR = join(temp, "prepared");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
const { sqlite } = await import("../server/db.ts");
const { ebookRecord, extractBook, invalidateParsedBook } = await import("../server/reader.ts");
const { prepareEpub } = await import("../server/prepared-text.ts");
const { buildPrepared } = await import("../server/prepared-text-cache.ts");

/** Runs `work` and reports its time and the longest the event loop did not come round meanwhile. */
async function measured<T>(work: () => Promise<T>) {
  let longest = 0;
  let last = performance.now();
  const started = last;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);
  try {
    const result = await work();
    return { result, totalMs: Math.round(performance.now() - started), longestBlockMs: Math.round(Math.max(longest, performance.now() - last)) };
  } finally {
    clearInterval(timer);
  }
}
const rows = [];
for (const id of ids) {
  invalidateParsedBook(id);
  const extract = await measured(() => extractBook(id));
  const book = extract.result;
  const offThread = await measured(() => buildPrepared(id));
  rmSync(offThread.result.dir, { recursive: true, force: true });
  const onThread = await measured(async () =>
    prepareEpub({ epub: readFileSync(ebookRecord(id).source), book, base: "/x", key: "k", writePicture: async () => {} }),
  );
  rows.push({
    id,
    title: book.title,
    sentences: book.sections.reduce((sum, section) => sum + section.paragraphs.length, 0),
    extractBook: { totalMs: extract.totalMs, longestBlockMs: extract.longestBlockMs },
    preparingOffThread: { totalMs: offThread.totalMs, longestBlockMs: offThread.longestBlockMs },
    preparingOnThread: { totalMs: onThread.totalMs, longestBlockMs: onThread.longestBlockMs },
  });
  invalidateParsedBook(id);
}
sqlite.close();
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
