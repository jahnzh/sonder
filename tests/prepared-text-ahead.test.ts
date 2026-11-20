// Prepared text made ahead (#827): when a book arrives, by a sweep of the library, and off the server's main thread.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-prepared-ahead-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.PREPARED_TEXT_DIR;
delete process.env.PREPARED_TEXT_CACHE_MB;
delete process.env.PREPARED_TEXT_AHEAD;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { extractBook, readerCheckpoint } = await import("../server/reader.ts");
const { prepareEpub, sentencesOfParts } = await import("../server/prepared-text.ts");
const { preparedDir, ensurePrepared, buildPrepared, preparedCounts, located } = await import("../server/prepared-text-cache.ts");
const { sweepLibrary, preparedStatus, prepareSoon, aheadIdle, forgetFailuresForTests } = await import("../server/prepared-text-ahead.ts");
const { preparedFixture } = await import("./prepared-text-fixture.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
  sqlite.close();
});
mkdirSync(join(temp, "media", "ebooks"), { recursive: true });
db.insert(s.works).values({ id: "work-ahead", title: "Ahead", author: "Test", description: "", genre: "", year: 2026 }).run();
const book = (text: string, paragraphs = 1) => preparedFixture({ chapters: { "one.xhtml": `<h1>One</h1>${`<p>${text}</p>`.repeat(paragraphs)}` } });
const fileOf = (id: string) => join(temp, "media", "ebooks", `${id}.epub`);
async function edition(id: string, epub: Buffer | Promise<Buffer> = book(`The text of ${id}.`)) {
  writeFileSync(fileOf(id), await epub);
  db.insert(s.ebookEditions).values({ id, workId: "work-ahead", format: "epub", source: fileOf(id) }).run();
}
const remove = (id: string) => db.delete(s.ebookEditions).where(eq(s.ebookEditions.id, id)).run();
const prepared = async (id: string) => existsSync(join((await located(id)).dir, "manifest.json"));
const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;
const admin = await login("203.0.113.60", { password: "admin-password" });
await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
const reader = await login("203.0.113.61", { username: "reader", password: "password1" });
const lines: string[] = [];
const log = {
  info: (details: object, message: string) => void lines.push(`info ${message} ${JSON.stringify(details)}`),
  warn: (details: object, message: string) => void lines.push(`warn ${message} ${JSON.stringify(details)}`),
};
/** The longest time the event loop did not come round while `work` ran. */
async function longestBlock<T>(work: () => Promise<T>) {
  let longest = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 2);
  try {
    const result = await work();
    return { result, longest: Math.max(longest, performance.now() - last) };
  } finally {
    clearInterval(timer);
  }
}

test("preparing a large book does not block the server's event loop", async () => {
  // One chapter of 4.5 MB (the largest a chapter may be is 5 MB): about 45,000 sentences in one file, which the
  // preparing step parses, places and writes in one go. On the main thread that is seconds without an answer.
  const sentence = "The lantern by the harbour wall was lit before the ferry came in that evening. ";
  await edition("ahead-large", book(sentence.repeat(6), 9500));
  assert.ok(statSync(fileOf("ahead-large")).size < 200_000);
  const extracted = await extractBook("ahead-large");
  assert.ok(extracted.sections[0].paragraphs.length > 40_000);
  // For scale: the same work on this thread, with the loop held throughout.
  const epub = readFileSync(fileOf("ahead-large"));
  const inline = await longestBlock(() => prepareEpub({ epub, book: extracted, base: "/x", key: "k", writePicture: async () => {} }));
  const ahead = await longestBlock(() => buildPrepared("ahead-large"));
  const manifest = JSON.parse(readFileSync(join(ahead.result.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.sentences, extracted.sections[0].paragraphs.length);
  assert.deepEqual(manifest.problems, []);
  // The aim is under 100 ms on the production host (measured: see the pull request). The bound here leaves room
  // for a loaded check host, and is still far below what the work costs when it runs on this thread.
  assert.ok(inline.longest > 1000, `on the main thread the loop is held ${Math.round(inline.longest)} ms`);
  assert.ok(ahead.longest < 400, `the loop was held ${Math.round(ahead.longest)} ms while preparing`);
  // What was prepared off the thread is what the thread itself would have made.
  const parts = manifest.parts.map((part: { index: number }) => readFileSync(join(ahead.result.dir, `p${part.index}.html`), "utf8"));
  assert.equal(parts.length, inline.result.parts.length);
  assert.equal(sentencesOfParts(parts).sentences.length, extracted.sections[0].paragraphs.length);
  remove("ahead-large");
});

test("a failure while preparing reaches the opener with its own sentence, and leaves nothing behind", async () => {
  await edition("ahead-broken");
  const whole = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  utimesSync(fileOf("ahead-broken"), whole, whole);
  await extractBook("ahead-broken");
  // The file changes under the extracted book without its size or time changing: the preparing step meets a file
  // that is no EPUB.
  writeFileSync(fileOf("ahead-broken"), Buffer.alloc(statSync(fileOf("ahead-broken")).size, 7));
  utimesSync(fileOf("ahead-broken"), whole, whole);
  await assert.rejects(buildPrepared("ahead-broken"), (error: Error) => !/worker|thread/i.test(error.message) && error.message.length > 10);
  const response = await app.inject({ method: "GET", url: "/api/reader/ahead-broken/prepared", cookies: { sonder_session: reader } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(readdirSync(preparedDir()).filter((name) => name.includes(".tmp-")), []);
  remove("ahead-broken");
});

test("an imported EPUB is prepared without anyone opening it, and the import does not wait for it", async () => {
  process.env.PREPARED_TEXT_AHEAD = "1";
  try {
    const before = preparedCounts.built;
    const imported = await app.inject({
      method: "POST",
      url: "/api/ebooks/import",
      cookies: { sonder_session: admin },
      ...multipart("Arrived.epub", await book("A book that arrives. It has two sentences.", 4000)),
    });
    assert.equal(imported.statusCode, 200, imported.body);
    const id = imported.json().id as string;
    assert.equal(preparedCounts.built, before, "the import answered before the book was prepared");
    assert.equal(await prepared(id), false);
    await aheadIdle();
    assert.equal(preparedCounts.built, before + 1);
    assert.equal(await prepared(id), true);
    assert.equal(readerCheckpoint(id), null, "nobody opened it");
    // Opening it now prepares nothing.
    const manifest = await app.inject({ method: "GET", url: `/api/reader/${encodeURIComponent(id)}/prepared`, cookies: { sonder_session: reader } });
    assert.equal(manifest.statusCode, 200);
    assert.equal(preparedCounts.built, before + 1);
    remove(id);
  } finally {
    delete process.env.PREPARED_TEXT_AHEAD;
  }
});
function multipart(name: string, data: Buffer) {
  const boundary = "----sonder-prepared-ahead";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/epub+zip\r\n\r\n`);
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

test("without the switch, tests and a server that turned it off prepare only on demand", async () => {
  await edition("ahead-off");
  const before = preparedCounts.built;
  prepareSoon("ahead-off", log);
  await aheadIdle();
  assert.equal(preparedCounts.built, before);
  remove("ahead-off");
});

test("the sweep prepares every edition without a current output, one at a time, the books being read first", async () => {
  await sweepLibrary({ log, pauseMs: 0 });
  await edition("sweep-big", book("A long book takes longer to prepare than a short one.", 3000));
  await edition("sweep-small");
  await edition("sweep-read", book("Someone is reading this one.", 800));
  await edition("sweep-kept");
  await edition("sweep-pdf");
  db.update(s.ebookEditions).set({ format: "pdf" }).where(eq(s.ebookEditions.id, "sweep-pdf")).run();
  db.insert(s.ebookEditions).values({ id: "sweep-gone", workId: "work-ahead", format: "epub", source: fileOf("sweep-nowhere") }).run();
  sqlite.prepare("INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(1,?,?)").run("sweep-read", JSON.stringify({ updatedAt: Date.now() }));
  const kept = await ensurePrepared("sweep-kept");
  // A folder of an edition that is no longer in the library, and work a stopped server left behind long ago.
  await edition("sweep-removed");
  const removed = await ensurePrepared("sweep-removed");
  remove("sweep-removed");
  const before = preparedCounts.built;
  lines.length = 0;
  const summary = await sweepLibrary({ log, pauseMs: 0 });
  assert.deepEqual(summary.prepared, ["sweep-read", "sweep-small", "sweep-big"], "the book someone reads, then the smallest first");
  assert.equal(preparedCounts.built - before, 3);
  assert.equal(preparedCounts.mostAtOnce, 1, "never two books at once");
  assert.deepEqual([summary.editions, summary.current, summary.missing, summary.failed.length, summary.waiting], [5, 4, 1, 0, 0]);
  for (const id of ["sweep-big", "sweep-small", "sweep-read", "sweep-kept"]) assert.equal(await prepared(id), true, id);
  assert.ok(existsSync(kept.dir));
  assert.ok(!existsSync(removed.dir), "the folder of an edition that left the library goes");
  // Progress is in the server's log: what is to do, each book, and the end.
  assert.ok(lines.some((line) => /^info prepared text: 3 of 5 editions to prepare/.test(line)), lines.join("\n"));
  assert.equal(lines.filter((line) => /^info prepared text: prepared /.test(line)).length, 3);
  assert.ok(lines.some((line) => /^info prepared text: the library is prepared/.test(line)));
  // Run twice: nothing is left to do, and nothing is said.
  lines.length = 0;
  const again = await sweepLibrary({ log, pauseMs: 0 });
  assert.deepEqual([again.prepared, again.current, preparedCounts.built - before], [[], 4, 3]);
  assert.deepEqual(lines, []);
});

test("a changed EPUB is prepared again by the next sweep, and its old output goes", async () => {
  const old = await located("sweep-small");
  writeFileSync(fileOf("sweep-small"), await book("The file was replaced by a longer one."));
  utimesSync(fileOf("sweep-small"), new Date(), new Date(Date.now() + 7000));
  const summary = await sweepLibrary({ log, pauseMs: 0 });
  assert.deepEqual(summary.prepared, ["sweep-small"]);
  assert.ok(!existsSync(old.dir));
  assert.ok(readFileSync(join((await located("sweep-small")).dir, "p0.html"), "utf8").includes("replaced by a longer one"));
});

test("a book that cannot be prepared is reported once and does not hold up the others", async () => {
  writeFileSync(fileOf("sweep-bad"), "this is no EPUB");
  db.insert(s.ebookEditions).values({ id: "sweep-bad", workId: "work-ahead", format: "epub", source: fileOf("sweep-bad") }).run();
  await edition("sweep-after", book("This one comes after the broken one.", 50));
  lines.length = 0;
  const summary = await sweepLibrary({ log, pauseMs: 0 });
  assert.deepEqual(summary.prepared, ["sweep-after"]);
  assert.deepEqual(summary.failed.map((failure) => failure.id), ["sweep-bad"]);
  assert.equal(lines.filter((line) => line.startsWith("warn prepared text: could not prepare")).length, 1);
  // The next sweep does not try it again, and says nothing more about it.
  const before = preparedCounts.built;
  lines.length = 0;
  const again = await sweepLibrary({ log, pauseMs: 0 });
  assert.deepEqual([again.prepared, again.failed.map((failure) => failure.id), preparedCounts.built - before, lines], [[], ["sweep-bad"], 0, []]);
  // The administrator sees it; nobody else may ask.
  const status = await app.inject({ method: "GET", url: "/api/prepared-text", cookies: { sonder_session: admin } });
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual([status.json().editions, status.json().current, status.json().failed.map((failure: { id: string }) => failure.id), status.json().running], [7, 5, ["sweep-bad"], false]);
  assert.equal((await app.inject({ method: "GET", url: "/api/prepared-text", cookies: { sonder_session: reader } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/prepared-text" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/prepared-text/backfill", cookies: { sonder_session: reader }, payload: {} })).statusCode, 403);
  // A replaced file is a new book to try.
  writeFileSync(fileOf("sweep-bad"), await book("Now it is a book."));
  utimesSync(fileOf("sweep-bad"), new Date(), new Date(Date.now() + 9000));
  const started = await app.inject({ method: "POST", url: "/api/prepared-text/backfill", cookies: { sonder_session: admin }, payload: {} });
  assert.equal(started.statusCode, 200, started.body);
  await aheadIdle();
  assert.deepEqual([(await preparedStatus()).failed, await prepared("sweep-bad")], [[], true]);
});

test("the cache's size limit and the sweep do not fight: nothing current is pruned, and a full cache is left to on-demand", async () => {
  forgetFailuresForTests();
  const sizes = readdirSync(preparedDir()).map((name) => JSON.parse(readFileSync(join(preparedDir(), name, "entry.json"), "utf8")).bytes as number);
  const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
  const folders = readdirSync(preparedDir()).sort();
  // The whole library is prepared and fits: a sweep under a limit just above it removes nothing.
  await sweepLibrary({ log, pauseMs: 0, maxBytes: total + 1 });
  assert.deepEqual(readdirSync(preparedDir()).sort(), folders);
  // Two more books arrive, and the cache is already as full as it may be.
  await edition("full-one", book("One more book.", 200));
  await edition("full-two", book("And another one.", 200));
  lines.length = 0;
  const before = preparedCounts.built;
  const full = await sweepLibrary({ log, pauseMs: 0, maxBytes: total });
  assert.deepEqual([full.prepared, full.waiting, preparedCounts.built - before], [[], 2, 0]);
  assert.deepEqual(readdirSync(preparedDir()).sort(), folders, "the sweep removes nothing that is current to make room");
  assert.equal(lines.filter((line) => /^warn prepared text: the cache is full/.test(line)).length, 1);
  assert.equal((await preparedStatus()).full, true);
  // The next sweep says it again only when something changed.
  lines.length = 0;
  await sweepLibrary({ log, pauseMs: 0, maxBytes: total });
  assert.deepEqual(lines, []);
  // A reader who opens one of them still gets it, prepared then.
  const opened = await app.inject({ method: "GET", url: "/api/reader/full-one/prepared", cookies: { sonder_session: reader } });
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(await prepared("full-one"), true);
  // With room again, the sweep prepares what waited.
  const roomy = await sweepLibrary({ log, pauseMs: 0 });
  assert.deepEqual([roomy.prepared, roomy.waiting, (await preparedStatus()).full], [["full-two"], 0, false]);
});

test("a reader's open does not wait behind the sweep's books, and shares a preparing that is already running", async () => {
  await edition("lane-slow", book("The sweep is busy with this long book for a while.", 6000));
  await edition("lane-next", book("The sweep would come to this one afterwards.", 6000));
  await edition("lane-opened", book("A reader opens this short one meanwhile."));
  // The sweep takes the two long books first: someone is reading them.
  for (const [index, id] of ["lane-next", "lane-slow"].entries())
    sqlite.prepare("INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(1,?,?)").run(id, JSON.stringify({ updatedAt: Date.now() + index }));
  const before = preparedCounts.built;
  const sweep = sweepLibrary({ log, pauseMs: 0 });
  const opened = await app.inject({ method: "GET", url: "/api/reader/lane-opened/prepared", cookies: { sonder_session: reader } });
  assert.equal(opened.statusCode, 200);
  assert.equal(await prepared("lane-next"), false, "the open was answered before the sweep was through");
  // Opening the book the sweep will prepare or is preparing makes no second preparing of it.
  const same = await Promise.all([ensurePrepared("lane-next"), ensurePrepared("lane-next"), ensurePrepared("lane-slow")]);
  assert.equal(same[0].dir, same[1].dir);
  const summary = await sweep;
  assert.equal(preparedCounts.built - before, 3);
  assert.deepEqual([...summary.prepared, ...summary.failed], summary.prepared);
  for (const id of ["lane-slow", "lane-next", "lane-opened"]) assert.equal(await prepared(id), true, id);
});
