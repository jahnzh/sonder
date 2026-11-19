/**
 * Spare EPUB editions (#718, ADR 0024): the editions of a work that nobody reads. The read-editions rule, the
 * Activity facts of their reading syncs (`spare`, `background`), and what another account sees of them.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-spare-editions-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.TRANSMISSION_RPC_URL;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const { readEbookIdsByWork, isSpareEdition } = await import("../server/ebook-chosen.ts");
const app = await createApp();
after(async () => {
  await app.close();
});

const run = (sql: string, ...args: unknown[]) => {
  try {
    return sqlite.prepare(sql).run(...args);
  } catch (error) {
    throw new Error(`${sql}: ${(error as Error).message}`);
  }
};
const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;

function work(id: string, ebooks: string[]) {
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,'','',1987)", id, `Book ${id}`, "Banks");
  run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES(?,?,'','',0,'')", `ed-${id}`, id);
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${id}`, `ed-${id}`);
  for (const ebook of ebooks) run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,'epub','x')", ebook, id);
}
const read = (workId: string) => [...(readEbookIdsByWork(sqlite, [workId]).get(workId) ?? [])].sort();

test("the read editions: the shared default, else the first EPUB, and every edition someone has a place in", () => {
  work("w-rule", ["r-1", "r-2", "r-3"]);
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('r-pdf','w-rule','pdf','x')");
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('set-consensus:w-rule','w-rule','epub','x')");
  assert.deepEqual(read("w-rule"), ["r-1"], "without a shared default, the first EPUB added");
  assert.equal(isSpareEdition(sqlite, "r-2"), true);
  assert.equal(isSpareEdition(sqlite, "r-1"), false);
  assert.equal(isSpareEdition(sqlite, "r-pdf"), false, "a PDF is never synced, so it is no spare edition");
  assert.equal(isSpareEdition(sqlite, "set-consensus:w-rule"), false, "the set's consensus text is no edition");
  assert.equal(isSpareEdition(sqlite, "missing"), false);
  run("INSERT INTO work_ebook_set(work_id,default_ebook_id,updated_at) VALUES('w-rule','r-2',0)");
  assert.deepEqual(read("w-rule"), ["r-2"], "the shared default replaces the first EPUB");
  run("INSERT INTO ebook_progress(edition_id,cfi,chapter,updated_at) VALUES('r-3','epubcfi(/6/2)',0,0)");
  assert.deepEqual(read("w-rule"), ["r-2", "r-3"], "an edition with a place is read");
  run("DELETE FROM ebook_progress");
  run("INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(1,'r-1','{}')");
  assert.deepEqual(read("w-rule"), ["r-1", "r-2"], "a reader checkpoint of any account counts as well");
  // A default that names an edition of another work.
  work("w-other", ["o-1"]);
  run("INSERT INTO work_ebook_set(work_id,default_ebook_id,updated_at) VALUES('w-other','r-1',0)");
  assert.deepEqual(read("w-other"), ["o-1"], "a default naming another work's edition is ignored: the first EPUB is read");
});

test("Activity marks a sync of a spare edition and whether it was queued by itself; another account sees none of it", async () => {
  const admin = await login("203.0.113.190", { password: "admin-password" });
  const created = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
  assert.equal(created.statusCode, 200, created.body);
  const user = await login("203.0.113.191", { username: "reader", password: "password1" });

  work("w-hs", ["hs-read", "hs-spare-1", "hs-spare-2"]);
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('set-consensus:w-hs','w-hs','epub','x')");
  const now = Date.now();
  // A second recording of the book, for the projected map of a spare edition (one row per ebook and recording).
  run("INSERT INTO recordings(id,edition_id) VALUES('rec-hs-b','ed-w-hs')");
  const job = (id: string, ebookId: string, data: Record<string, unknown>, recordingId = "rec-w-hs") =>
    run("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,?,?,?,?)", id, ebookId, recordingId,
      JSON.stringify({ id, ebookId, recordingId, progress: 0, createdAt: now, ...data }), now);
  job("j-read", "hs-read", { status: "ready", origin: "backfill", coverage: 1 });
  job("j-spare-1", "hs-spare-1", { status: "processing", origin: "backfill", mode: "anchored" });
  job("j-spare-2", "hs-spare-2", { status: "queued" });
  job("j-consensus", "set-consensus:w-hs", { status: "queued", origin: "backfill" });
  job("j-projected", "hs-spare-2", { status: "ready", origin: "projected" }, "rec-hs-b");

  const facts = async () => {
    const response = await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: admin } });
    assert.equal(response.statusCode, 200, response.body);
    const items = response.json().items as { id: string; facts: { spare?: boolean; background?: boolean } }[];
    return Object.fromEntries(items.filter((item) => item.id.startsWith("alignment:j-"))
      .map((item) => [item.id.slice("alignment:".length), [item.facts.spare, item.facts.background]]));
  };
  assert.deepEqual(await facts(), {
    "j-read": [false, true],
    "j-spare-1": [true, true],
    // Prepared by the administrator: a spare edition, but not queued by itself.
    "j-spare-2": [true, false],
    "j-consensus": [false, true],
    // A projected map is the set's consensus read through the edition: no sync of the edition of its own.
    "j-projected": [false, false],
  });
  // Someone starts reading a spare edition: it is read from then on.
  run("INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(1,'hs-spare-1','{}')");
  assert.deepEqual((await facts())["j-spare-1"], [false, true]);

  // The second account: no Activity at all, and its library answer carries no word of the syncs.
  assert.equal((await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: user } })).statusCode, 403);
  const books = await app.inject({ method: "GET", url: "/api/books", cookies: { sonder_session: user } });
  assert.equal(books.statusCode, 200, books.body);
  assert.doesNotMatch(books.body, /spare|hs-spare|j-spare/);
});
