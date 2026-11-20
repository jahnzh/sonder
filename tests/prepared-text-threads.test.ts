// The preparing thread's ceilings and the sweep's care with what it removes (#827, review of #829): a thread that
// hangs, runs out of memory, exits or throws is one failed book; at most two threads run at once and a reader never
// waits behind the sweep; the sweep removes only the folders of editions that left the library; its first run waits.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-prepared-threads-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
for (const name of ["PREPARED_TEXT_DIR", "PREPARED_TEXT_CACHE_MB", "PREPARED_TEXT_AHEAD", "PREPARED_TEXT_THREAD_MB", "PREPARED_TEXT_THREAD_SECONDS", "PREPARED_TEXT_THREADS", "PREPARED_TEXT_FIRST_SWEEP_MINUTES"])
  delete process.env[name];
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { preparedDir, ensurePrepared, buildPrepared, preparedCounts, located, threadForTests, threadLimits, threadLine, NOT_PREPARED } = await import("../server/prepared-text-cache.ts");
const { sweepLibrary, preparedStatus, prepareSoon, aheadIdle, preparedTextLoop, forgetFailuresForTests } = await import("../server/prepared-text-ahead.ts");
const { preparedFixture } = await import("./prepared-text-fixture.ts");
// The app's own log, as the server writes it: a book prepared at its import is logged there.
const appLog: { msg: string; id?: string; cause?: string }[] = [];
const stream = new Writable({
  write(chunk, _encoding, done) {
    for (const line of String(chunk).split("\n")) if (line.trim()) appLog.push(JSON.parse(line));
    done();
  },
});
const app = await createApp({ background: { manual: true }, logger: { level: "info", stream } });
after(async () => {
  await app.close();
  sqlite.close();
});
mkdirSync(join(temp, "media", "ebooks"), { recursive: true });
db.insert(s.works).values({ id: "work-threads", title: "Threads", author: "Test", description: "", genre: "", year: 2026 }).run();
const book = (text: string, paragraphs = 1) => preparedFixture({ chapters: { "one.xhtml": `<h1>One</h1>${`<p>${text}</p>`.repeat(paragraphs)}` } });
const fileOf = (id: string) => join(temp, "media", "ebooks", `${id}.epub`);
async function edition(id: string, epub: Buffer | Promise<Buffer> = book(`The text of ${id}.`)) {
  writeFileSync(fileOf(id), await epub);
  db.insert(s.ebookEditions).values({ id, workId: "work-threads", format: "epub", source: fileOf(id) }).run();
}
const remove = (id: string) => db.delete(s.ebookEditions).where(eq(s.ebookEditions.id, id)).run();
const prepared = async (id: string) => existsSync(join((await located(id)).dir, "manifest.json"));
const prefixes = new Map<string, string>();
const prefixOf = async (id: string) => {
  const name = basename((await located(id)).dir);
  prefixes.set(id, name.slice(0, name.indexOf("-") + 1));
  return prefixes.get(id)!;
};
const lines: string[] = [];
const log = {
  info: (details: object, message: string) => void lines.push(`info ${message} ${JSON.stringify(details)}`),
  warn: (details: object, message: string) => void lines.push(`warn ${message} ${JSON.stringify(details)}`),
};
// Threads that go wrong, started in place of the real one for the books named here.
const fault = (name: string, code: string) => {
  const file = join(temp, `${name}.mjs`);
  writeFileSync(file, code);
  return pathToFileURL(file);
};
const faults = new Map<string, URL>();
const HANG = fault("hang", "setInterval(() => {}, 1000);\n");
const EXIT = fault("exit", "process.exit(3);\n");
const THROW = fault("throw", 'throw new Error("boom outside the preparing");\n');
threadForTests.entry = (source) => faults.get(basename(source, ".epub")) ?? null;
const settled = () => assert.deepEqual([preparedCounts.running, preparedCounts.started - preparedCounts.stopped, threadLine()], [0, 0, { running: 0, ahead: 0, waiting: 0 }], "every thread was stopped and its place given back");
const noWorkLeft = () => assert.deepEqual(existsSync(preparedDir()) ? readdirSync(preparedDir()).filter((name) => name.includes(".tmp-")) : [], []);
const get = (url: string) => app.inject({ method: "GET", url });

test("the settings of the preparing thread have their standard values", () => {
  assert.deepEqual(threadLimits(), { memoryMb: 512, seconds: 300, atOnce: 2 });
  process.env.PREPARED_TEXT_THREAD_MB = "256";
  process.env.PREPARED_TEXT_THREAD_SECONDS = "60";
  process.env.PREPARED_TEXT_THREADS = "3";
  assert.deepEqual(threadLimits(), { memoryMb: 256, seconds: 60, atOnce: 3 });
  for (const name of ["PREPARED_TEXT_THREAD_MB", "PREPARED_TEXT_THREAD_SECONDS", "PREPARED_TEXT_THREADS"]) delete process.env[name];
});

test("a thread that never answers is stopped after its time, and the reader gets the usual sentence", async () => {
  await edition("t-hang");
  faults.set("t-hang", HANG);
  process.env.PREPARED_TEXT_THREAD_SECONDS = "0.4";
  try {
    const started = performance.now();
    await assert.rejects(buildPrepared("t-hang", log), (error: Error & { cause?: string }) => error.message === NOT_PREPARED && /stopped after 0\.4 s \(PREPARED_TEXT_THREAD_SECONDS\)/.test(String(error.cause)));
    assert.ok(performance.now() - started < 10_000);
    assert.equal(lines.filter((line) => /^warn prepared text: the preparing of a book was stopped .*"id":"t-hang".*stopped after/.test(line)).length, 1, "why it was stopped is in the log");
    // The reader's open of that book answers, with the sentence for a book that cannot be opened.
    const opened = await get("/api/reader/t-hang/prepared");
    assert.equal(opened.statusCode, 400);
    assert.equal(opened.json().error, "This EPUB could not be opened.");
    assert.equal(opened.headers["cache-control"], "no-store");
    assert.equal(await prepared("t-hang"), false);
    settled();
    noWorkLeft();
  } finally {
    delete process.env.PREPARED_TEXT_THREAD_SECONDS;
  }
});

test("a thread that exits or throws without an answer is one failed book", async () => {
  await edition("t-exit");
  await edition("t-throw");
  faults.set("t-exit", EXIT);
  faults.set("t-throw", THROW);
  await assert.rejects(buildPrepared("t-exit"), (error: Error & { cause?: string }) => error.message === NOT_PREPARED && /ended without an answer \(exit 3\)/.test(String(error.cause)));
  await assert.rejects(buildPrepared("t-throw"), (error: Error & { cause?: string }) => error.message === NOT_PREPARED && /boom outside the preparing/.test(String(error.cause)));
  settled();
  noWorkLeft();
});

test("a book that needs more memory than the thread may have is one failed book, and the server is unharmed", async () => {
  // A chapter of 4.5 MB needs far more than the heap allowed here; the small book beside it fits.
  await edition("t-large", book("The lantern by the harbour wall was lit before the ferry came in that evening. ".repeat(6), 9500));
  await edition("t-fits");
  process.env.PREPARED_TEXT_THREAD_MB = "40";
  try {
    await assert.rejects(buildPrepared("t-large"), (error: Error & { cause?: string }) => error.message === NOT_PREPARED && /ERR_WORKER_OUT_OF_MEMORY/.test(String(error.cause)));
    assert.equal(await prepared("t-large"), false);
    await buildPrepared("t-fits");
    assert.equal(await prepared("t-fits"), true);
    settled();
    noWorkLeft();
  } finally {
    delete process.env.PREPARED_TEXT_THREAD_MB;
  }
  // With the standard limit the same book is prepared.
  await buildPrepared("t-large");
  assert.equal(await prepared("t-large"), true);
  for (const id of ["t-large", "t-fits"]) remove(id);
});

test("the sweep names a stuck book once, goes on to the next, and a second sweep joins the running one", async () => {
  for (const id of ["t-exit", "t-throw"]) remove(id);
  await edition("s-first");
  await edition("s-last", book("The book after the stuck one.", 3));
  // Long enough for a real book on a loaded host; the stuck one takes all of it, each time it is tried.
  process.env.PREPARED_TEXT_THREAD_SECONDS = "5";
  try {
    lines.length = 0;
    const running = sweepLibrary({ log, pauseMs: 0 });
    assert.equal(sweepLibrary({ log, pauseMs: 0 }), running, "the same sweep, not a second one");
    assert.equal((await preparedStatus()).running, true);
    const summary = await running;
    assert.deepEqual([...summary.prepared].sort(), ["s-first", "s-last"]);
    assert.deepEqual(summary.failed.map((failure) => failure.id), ["t-hang"]);
    assert.match(summary.failed[0].error, /^This EPUB could not be opened\. \(the preparing thread was stopped after/);
    assert.equal(lines.filter((line) => /^warn prepared text: could not prepare a book;.*t-hang/.test(line)).length, 1);
    assert.equal((await preparedStatus()).running, false);
    // The next sweeps leave it alone, and after a day of them it is tried once more.
    const started = preparedCounts.started;
    for (let sweeps = 0; sweeps < 24; sweeps++) await sweepLibrary({ log, pauseMs: 0 });
    assert.equal(preparedCounts.started, started, "not tried again by the next 24 sweeps");
    lines.length = 0;
    const later = await sweepLibrary({ log, pauseMs: 0 });
    assert.equal(preparedCounts.started, started + 1, "tried again by the 25th");
    assert.deepEqual(later.failed.map((failure) => failure.id), ["t-hang"]);
    assert.equal(lines.filter((line) => /^warn prepared text: could not prepare a book;/.test(line)).length, 1);
    settled();
  } finally {
    delete process.env.PREPARED_TEXT_THREAD_SECONDS;
  }
  remove("t-hang");
  forgetFailuresForTests();
});

test("a failure of the file system is not remembered: the next sweep tries the book again", async () => {
  await edition("s-drive");
  process.env.REQUIRE_MEDIA_MOUNT = "true";
  process.env.MEDIA_VOLUME_ID = "a-volume-that-is-not-mounted";
  lines.length = 0;
  let summary;
  try {
    summary = await sweepLibrary({ log, pauseMs: 0 });
  } finally {
    process.env.REQUIRE_MEDIA_MOUNT = "false";
    delete process.env.MEDIA_VOLUME_ID;
  }
  assert.deepEqual([summary.prepared, summary.failed], [[], []]);
  assert.equal(lines.filter((line) => /^warn prepared text: could not prepare a book now; the next sweep tries it again .*s-drive/.test(line)).length, 1);
  assert.deepEqual((await sweepLibrary({ log, pauseMs: 0 })).prepared, ["s-drive"]);
});

test("the sweep removes only the folders of editions that left the library", async () => {
  const ids = ["s-first", "s-last", "s-drive"];
  for (const id of ids) await prefixOf(id);
  const folders = () => readdirSync(preparedDir()).sort();
  const before = folders();
  assert.equal(before.length, 3);

  // An edition whose file is away keeps its folder: the drive may be coming back.
  renameSync(fileOf("s-last"), `${fileOf("s-last")}.away`);
  const away = await sweepLibrary({ log, pauseMs: 0 });
  assert.deepEqual([away.missing, away.prepared, folders()], [1, [], before]);
  renameSync(`${fileOf("s-last")}.away`, fileOf("s-last"));
  const built = preparedCounts.built;
  assert.deepEqual([(await sweepLibrary({ log, pauseMs: 0 })).prepared, preparedCounts.built, folders()], [[], built, before], "and is not prepared again when it is back");

  // A database without editions (another one on this media folder) removes nothing.
  sqlite.prepare("UPDATE ebook_editions SET format='held' WHERE format='epub'").run();
  try {
    const empty = await sweepLibrary({ log, pauseMs: 0 });
    assert.deepEqual([empty.editions, folders()], [0, before]);
  } finally {
    sqlite.prepare("UPDATE ebook_editions SET format='epub' WHERE format='held'").run();
  }

  // Every key changes at once (as after a deploy with new preparing code): each edition keeps its old output
  // until its new one is in place, so at no point of the sweep is a book without prepared text.
  for (const [index, id] of ids.entries()) utimesSync(fileOf(id), new Date(), new Date(Date.now() + 60_000 + index * 1000));
  const without: string[] = [];
  const watching = {
    warn: log.warn,
    info: (details: object, message: string) => {
      const all = readdirSync(preparedDir());
      for (const id of ids) if (!all.some((name) => name.startsWith(prefixes.get(id)!) && !name.includes(".tmp-") && existsSync(join(preparedDir(), name, "manifest.json")))) without.push(`${id} at "${message}"`);
      log.info(details, message);
    },
  };
  lines.length = 0;
  const changed = await sweepLibrary({ log: watching, pauseMs: 0 });
  assert.equal(changed.prepared.length, 3);
  assert.equal(lines.filter((line) => line.startsWith("info prepared text:")).length, 5, "to prepare, three books, done");
  assert.deepEqual(without, []);
  const afterwards = folders();
  assert.equal(afterwards.length, 3, "and the old outputs are gone once the new ones are there");
  assert.ok(afterwards.every((name) => !before.includes(name)));
  for (const id of ids) assert.equal(await prepared(id), true);

  // An edition that left the library loses its folder.
  remove("s-drive");
  await sweepLibrary({ log, pauseMs: 0 });
  assert.deepEqual(folders(), afterwards.filter((name) => !name.startsWith(prefixes.get("s-drive")!)));
});

test("at most two threads at once, one of them kept for readers; a reader's book is taken ahead of the waiting ones", async () => {
  const long = (words: string) => book(`${words} It goes on for a while, sentence after sentence, to keep a thread busy.`, 7000);
  for (const id of ["q-ahead-1", "q-ahead-2", "q-ahead-3"]) await edition(id, long(`Prepared ahead: ${id}.`));
  for (const id of ["q-read-1", "q-read-2", "q-read-3"]) await edition(id, long(`A reader opens ${id}.`));
  preparedCounts.mostAtOnce = 0;
  let mostAhead = 0;
  let mostRunning = 0;
  const watch = setInterval(() => {
    mostAhead = Math.max(mostAhead, threadLine().ahead);
    mostRunning = Math.max(mostRunning, threadLine().running);
  }, 1);
  const order: string[] = [];
  const done = (id: string) => () => void order.push(id);
  process.env.PREPARED_TEXT_AHEAD = "1";
  try {
    // Three books are handed over to be prepared ahead (as an ebook search that saves three editions does).
    const ahead = ["q-ahead-1", "q-ahead-2", "q-ahead-3"].map((id) => ensurePrepared(id, log, { ahead: true }).then(done(id)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(threadLine(), { running: 1, ahead: 1, waiting: 2 }, "one thread works ahead, the other is kept for a reader");
    // Three readers open three other books; then one opens the last of the waiting books.
    const readers = ["q-read-1", "q-read-2", "q-read-3"].map((id) => ensurePrepared(id, log).then(done(id)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(threadLine(), { running: 2, ahead: 1, waiting: 4 });
    const jumped = ensurePrepared("q-ahead-3", log).then(done("q-ahead-3 for its reader"));
    await Promise.all([...ahead, ...readers, jumped]);
  } finally {
    clearInterval(watch);
    delete process.env.PREPARED_TEXT_AHEAD;
  }
  assert.equal(mostRunning, 2);
  assert.equal(preparedCounts.mostAtOnce, 2);
  assert.equal(mostAhead, 1);
  // The readers' books and the book a reader asked for are all done before the second book prepared ahead.
  const at = (id: string) => order.indexOf(id);
  for (const id of ["q-read-1", "q-read-2", "q-read-3", "q-ahead-3"]) assert.ok(at(id) < at("q-ahead-2"), `${id} before q-ahead-2: ${order.join(", ")}`);
  settled();
  for (const id of ["q-ahead-1", "q-ahead-2", "q-ahead-3", "q-read-1", "q-read-2", "q-read-3"]) remove(id);
});

test("the server's own first sweep waits fifteen minutes after a start, then runs hourly, and only while the switch is on", async () => {
  await sweepLibrary({ log, pauseMs: 0 });
  const minute = 60_000;
  let clock = 1_000_000;
  const swept = async () => {
    await aheadIdle();
    return (await preparedStatus()).lastSweepAt;
  };
  const tick = async (loop: ReturnType<typeof preparedTextLoop>, at: number) => {
    clock = at;
    const before = await swept();
    await new Promise((resolve) => setTimeout(resolve, 5));
    loop.tick();
    return (await swept()) !== before;
  };
  process.env.PREPARED_TEXT_AHEAD = "1";
  try {
    const loop = preparedTextLoop(log, () => clock);
    assert.deepEqual([loop.id, loop.intervalMs], ["prepared-text", minute]);
    const start = clock;
    assert.equal(await tick(loop, start + minute), false, "a minute after the start: the deploy is settling");
    assert.equal(await tick(loop, start + 14 * minute), false);
    assert.equal(await tick(loop, start + 15 * minute), true, "the first sweep");
    assert.equal(await tick(loop, start + 16 * minute), false, "not every minute");
    assert.equal(await tick(loop, start + 74 * minute), false);
    assert.equal(await tick(loop, start + 75 * minute), true, "an hour after the first");
    // The wait is a setting.
    process.env.PREPARED_TEXT_FIRST_SWEEP_MINUTES = "2";
    const sooner = preparedTextLoop(log, () => clock);
    const again = clock;
    assert.equal(await tick(sooner, again + minute), false);
    assert.equal(await tick(sooner, again + 2 * minute), true);
    delete process.env.PREPARED_TEXT_FIRST_SWEEP_MINUTES;
    // Switched off, the loop never sweeps.
    process.env.PREPARED_TEXT_AHEAD = "0";
    const off = preparedTextLoop(log, () => clock);
    const then = clock;
    assert.equal(await tick(off, then + 500 * minute), false);
  } finally {
    delete process.env.PREPARED_TEXT_AHEAD;
    delete process.env.PREPARED_TEXT_FIRST_SWEEP_MINUTES;
  }
});

test("a book that cannot be prepared at its import is said in the server's log", async () => {
  await edition("i-arrives");
  faults.set("i-arrives", EXIT);
  process.env.PREPARED_TEXT_AHEAD = "1";
  appLog.length = 0;
  try {
    // What the import does once the edition is saved: no log is handed over, the app's own is used.
    prepareSoon("i-arrives");
    await aheadIdle();
  } finally {
    delete process.env.PREPARED_TEXT_AHEAD;
  }
  assert.equal(appLog.filter((line) => line.msg === "prepared text: could not prepare a new book ahead" && line.id === "i-arrives").length, 1);
  assert.equal(appLog.filter((line) => line.msg === "prepared text: the preparing of a book was stopped" && /exit 3/.test(String(line.cause))).length, 1);
  settled();
});
