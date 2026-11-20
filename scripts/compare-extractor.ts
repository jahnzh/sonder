// Compares the reader's sentences before and after a change to the extractor, over a whole library: for every EPUB
// edition, `extractBook` (server/reader.ts) of a git ref and of this checkout must give the same sentences (id,
// text, block and offsets, in order) and the same chapters, or the first difference is shown.
//
//   npx tsx scripts/compare-extractor.ts --db <sonder.db> [--before <git ref>] [--expect <id,id,…>] [--out <report.json>]
//
// `--before` defaults to origin/main. `--expect` names the editions that are meant to change: exit code 1 when the
// changed editions are not exactly those, or an edition could not be read on one side only. Without it, exit code 1
// when anything changed. It reads and never writes the library: each side works on its own copy of the database
// (server/db-backup.mjs), the EPUB files are only read, and everything it writes is in a temp folder it removes.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Sentence = { id: string; text: string; blockIndex: number; start: number; end: number };
type Dumped = { id: string; title: string; failed?: string; sections?: { index: number; href: string; title: string; blocks?: string; paragraphs: Sentence[] }[]; held?: number; total?: number };
const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const here = fileURLToPath(import.meta.url);

if (option("dump")) {
  // One side: this process loads the extractor of the tree at --dump and writes each edition's sentences.
  const root = resolve(option("dump")!);
  const out = resolve(option("to")!);
  const load = (path: string) => import(pathToFileURL(join(root, path)).href);
  const { sqlite } = await load("server/db.ts");
  const { extractBook, invalidateParsedBook } = await load("server/reader.ts");
  const { normalizeReaderText, readerSkippedSelector } = await load("src/reading-types.ts");
  const { default: JSZip } = await import("jszip");
  const { XMLParser } = await import("fast-xml-parser");
  const { parse } = await import("node-html-parser");
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true, processEntities: false });
  const array = (value: unknown): any[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
  /** The text of the book's chapters, counted as the extractor normalises it. */
  const textOf = async (source: string) => {
    const zip = await JSZip.loadAsync(readFileSync(source));
    const opfPath = array(xml.parse(await zip.file("META-INF/container.xml")!.async("string")).container?.rootfiles?.rootfile)[0]["full-path"];
    const pkg = xml.parse(await zip.file(opfPath)!.async("string")).package;
    const items = new Map<string, any>(array(pkg.manifest.item).map((item) => [item.id, item]));
    let total = 0;
    for (const ref of array(pkg.spine.itemref)) {
      const item = items.get(ref.idref);
      if (!item || !String(item["media-type"]).includes("html")) continue;
      const root = parse(await zip.file(posix.normalize(posix.join(posix.dirname(opfPath), decodeURIComponent(item.href.split("#")[0]))))!.async("string"));
      root.querySelectorAll(readerSkippedSelector).forEach((node) => node.remove());
      total += normalizeReaderText((root.querySelector("body") || root).text).length;
    }
    return total;
  };
  const rows = sqlite
    .prepare("SELECT e.id AS id, e.source AS source, w.title AS title FROM ebook_editions e JOIN works w ON w.id=e.work_id WHERE e.format='epub' AND e.id NOT LIKE 'set-consensus:%' ORDER BY e.id")
    .all() as { id: string; source: string; title: string }[];
  for (const [index, row] of rows.entries()) {
    const dumped: Dumped = { id: row.id, title: row.title };
    try {
      if (!existsSync(row.source)) throw new Error("the EPUB file is not on the media drive");
      const book = await extractBook(row.id);
      dumped.sections = book.sections;
      dumped.held = book.sections.reduce((sum: number, section: { paragraphs: Sentence[] }) => sum + section.paragraphs.reduce((inner, sentence) => inner + sentence.text.length, 0), 0);
      dumped.total = await textOf(row.source);
    } catch (error) {
      dumped.failed = error instanceof Error ? error.message : String(error);
    }
    writeFileSync(join(out, `${index}.json`), JSON.stringify(dumped));
    invalidateParsedBook(row.id);
  }
  writeFileSync(join(out, "count"), String(rows.length));
  sqlite.close();
  process.exit(0);
}

const source = option("db");
if (!source) {
  process.stderr.write("usage: npx tsx scripts/compare-extractor.ts --db <sonder.db> [--before <git ref>] [--expect <id,id,…>] [--out <report.json>]\n");
  process.exit(2);
}
const before = option("before") ?? "origin/main";
const expected = option("expect")?.split(",").map((id) => id.trim()).filter(Boolean);
const repo = resolve(dirname(here), "..");
const temp = mkdtempSync(join(tmpdir(), "sonder-compare-extractor-"));
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
const { backupDatabase } = await import("../server/db-backup.mjs");

// The tree of the ref: the server and the shared modules it imports, with this checkout's dependencies.
const old = join(temp, "before");
mkdirSync(old);
const archive = execFileSync("git", ["-C", repo, "archive", before, "server", "src", "package.json", "tsconfig.json"], { maxBuffer: 1 << 30 });
execFileSync("tar", ["-x", "-C", old], { input: archive });
symlinkSync(join(repo, "node_modules"), join(old, "node_modules"));
const commit = execFileSync("git", ["-C", repo, "rev-parse", "--short", before], { encoding: "utf8" }).trim();

async function side(name: string, root: string) {
  const dir = join(temp, name);
  mkdirSync(join(dir, "db"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "out"));
  await backupDatabase(resolve(source!), join(dir, "db", "sonder.db"));
  const run = spawnSync(process.execPath, ["--import", "tsx", here, "--dump", root, "--to", join(dir, "out")], {
    cwd: repo,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, DATA_DIR: join(dir, "db"), MEDIA_ROOT: join(dir, "media"), REQUIRE_MEDIA_MOUNT: "false", NODE_ENV: "test", APP_PASSWORD: "" },
  });
  if (run.status !== 0) throw new Error(`the ${name} side failed (exit ${run.status})`);
  const count = Number(readFileSync(join(dir, "out", "count"), "utf8"));
  return Array.from({ length: count }, (_item, index) => JSON.parse(readFileSync(join(dir, "out", `${index}.json`), "utf8")) as Dumped);
}
const was = await side("old", old);
const now = await side("new", repo);

const share = (dumped: Dumped) => (dumped.total ? Math.round(((dumped.held ?? 0) / dumped.total) * 1000) / 10 : null);
const digest = (dumped: Dumped) => createHash("sha256").update(JSON.stringify(dumped.sections ?? dumped.failed)).digest("hex");
/** The first place two cuts of one edition part ways. */
function firstDifference(a: Dumped, b: Dumped) {
  if (a.failed || b.failed) return `before: ${a.failed ?? "read"}; after: ${b.failed ?? "read"}`;
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
const later = new Map(now.map((dumped) => [dumped.id, dumped]));
const editions = was.map((a) => {
  const b = later.get(a.id);
  const count = (dumped?: Dumped) => dumped?.sections?.reduce((sum, section) => sum + section.paragraphs.length, 0) ?? 0;
  const identical = !!b && digest(a) === digest(b);
  return {
    id: a.id,
    title: a.title,
    identical,
    ...(identical ? {} : { difference: b ? firstDifference(a, b) : "not in the database copy of the second run" }),
    sentencesBefore: count(a),
    sentencesAfter: count(b),
    shareBefore: share(a),
    shareAfter: b ? share(b) : null,
    ...(a.failed ? { failedBefore: a.failed } : {}),
    ...(b?.failed ? { failedAfter: b.failed } : {}),
  };
});
const changed = editions.filter((edition) => !edition.identical);
const unexpected = expected ? changed.filter((edition) => !expected.includes(edition.id)).map((edition) => edition.id) : changed.map((edition) => edition.id);
const unchanged = expected ? expected.filter((id) => !changed.some((edition) => edition.id === id)) : [];
const oneSided = editions.filter((edition) => !!edition.failedBefore !== !!edition.failedAfter).map((edition) => edition.id);
const summary = {
  before: `${before} (${commit})`,
  editions: editions.length,
  identical: editions.length - changed.length,
  changed: changed.map((edition) => ({ id: edition.id, title: edition.title, sentences: `${edition.sentencesBefore} → ${edition.sentencesAfter}`, shareOfText: `${edition.shareBefore} % → ${edition.shareAfter} %`, firstDifference: edition.difference })),
  sentencesInIdenticalEditions: editions.filter((edition) => edition.identical).reduce((sum, edition) => sum + edition.sentencesAfter, 0),
  failedOnBothSides: editions.filter((edition) => edition.failedBefore && edition.failedAfter).map((edition) => ({ id: edition.id, why: edition.failedAfter })),
  ...(expected ? { expected, changedButNotExpected: unexpected, expectedButIdentical: unchanged } : {}),
  readOnOneSideOnly: oneSided,
};
const out = option("out");
if (out) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), JSON.stringify({ ...summary, results: editions }, null, 2));
}
for (const edition of editions) process.stderr.write(`${edition.identical ? "identical" : "CHANGED  "}  ${edition.id}  ${edition.sentencesAfter} sentences, ${edition.shareAfter} % of the text  ${edition.title}${edition.identical ? "" : `\n           ${edition.difference}`}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = unexpected.length || unchanged.length || oneSided.length ? 1 : 0;
