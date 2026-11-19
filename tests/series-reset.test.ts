// The series reset (#721 part b): a database with the Hardcover series tables (integer ids, as production has them)
// opened by this server. Once, at startup, the tables are renamed `hardcover_<name>` and left unused, new tables on
// text ids are made, and each saved series is noted to be saved again on AudiobookDB by its name. The series found
// there are saved again with the books the user had, their marks and origins; the one not found is listed in Activity.
// Works, files, progress and the rest of the library are untouched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-series-reset-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
delete process.env.AUDIOBOOKDB_API_KEY;

// The database as the Hardcover build left it: its series tables, two saved series, a work each series brought in.
mkdirSync(process.env.DATA_DIR, { recursive: true });
{
  const old = new Database(join(process.env.DATA_DIR, "sonder.db"));
  old.exec(`
CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT,role TEXT NOT NULL DEFAULT 'user',created_at INTEGER NOT NULL);
INSERT INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',1);
CREATE TABLE works(id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL,description TEXT NOT NULL,genre TEXT NOT NULL,year INTEGER NOT NULL);
CREATE TABLE audio_editions(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id),cover TEXT NOT NULL,narrator TEXT NOT NULL,rating REAL NOT NULL,source_label TEXT NOT NULL);
CREATE TABLE recordings(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL REFERENCES audio_editions(id));
CREATE TABLE tracks(id TEXT PRIMARY KEY,recording_id TEXT NOT NULL REFERENCES recordings(id),title TEXT NOT NULL,track_index INTEGER NOT NULL,duration REAL NOT NULL DEFAULT 0,chapters TEXT NOT NULL DEFAULT '[]',source TEXT NOT NULL,source_type TEXT NOT NULL);
CREATE TABLE user_library(user_id INTEGER NOT NULL REFERENCES users(id),book_id TEXT NOT NULL REFERENCES audio_editions(id),status TEXT NOT NULL DEFAULT 'unread',added_at INTEGER NOT NULL,PRIMARY KEY(user_id,book_id));
CREATE TABLE user_progress(user_id INTEGER NOT NULL REFERENCES users(id),recording_id TEXT NOT NULL REFERENCES recordings(id),track_id TEXT NOT NULL REFERENCES tracks(id),position REAL NOT NULL,duration REAL NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,recording_id));
CREATE TABLE series_catalogue(id INTEGER PRIMARY KEY,name TEXT NOT NULL,author TEXT,book_count INTEGER);
CREATE TABLE series_catalogue_works(series_id INTEGER NOT NULL REFERENCES series_catalogue(id),book_id INTEGER NOT NULL,work_id TEXT REFERENCES works(id),title TEXT NOT NULL,position REAL,cover TEXT,unreleased INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(series_id,book_id));
CREATE TABLE user_saved_series(user_id INTEGER NOT NULL REFERENCES users(id),series_id INTEGER NOT NULL REFERENCES series_catalogue(id),saved_at INTEGER NOT NULL,refreshed_at INTEGER,PRIMARY KEY(user_id,series_id));
CREATE TABLE user_saved_series_works(user_id INTEGER NOT NULL REFERENCES users(id),series_id INTEGER NOT NULL REFERENCES series_catalogue(id),book_id INTEGER NOT NULL,work_id TEXT NOT NULL REFERENCES works(id),introduced INTEGER NOT NULL,PRIMARY KEY(user_id,series_id,book_id));
CREATE TABLE user_series_seen_works(user_id INTEGER NOT NULL REFERENCES users(id),series_id INTEGER NOT NULL REFERENCES series_catalogue(id),book_id INTEGER NOT NULL,acknowledged_at INTEGER NOT NULL,PRIMARY KEY(user_id,series_id,book_id));
CREATE TABLE series_acquisition_jobs(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),series_id INTEGER NOT NULL REFERENCES series_catalogue(id),book_id INTEGER NOT NULL,work_id TEXT NOT NULL REFERENCES works(id),kind TEXT NOT NULL CHECK(kind IN ('audio','ebook')),status TEXT NOT NULL CHECK(status IN ('pending','searching','done','failed')),error TEXT,updated_at INTEGER NOT NULL,auto_retries INTEGER NOT NULL DEFAULT 0,retry_at INTEGER);
CREATE UNIQUE INDEX series_acquisition_jobs_user_series_book_kind ON series_acquisition_jobs(user_id,series_id,book_id,kind);
CREATE UNIQUE INDEX series_acquisition_jobs_user_work_kind ON series_acquisition_jobs(user_id,work_id,kind);
CREATE TABLE user_work_library_origin(user_id INTEGER NOT NULL REFERENCES users(id),work_id TEXT NOT NULL REFERENCES works(id),source TEXT NOT NULL CHECK(source IN ('unknown','manual','hardcover_sync','series')),series_id INTEGER,added_at INTEGER NOT NULL,PRIMARY KEY(user_id,work_id));
INSERT INTO works VALUES('w-lw','Leviathan Wakes','James S. A. Corey','','Fiction',2011),('w-cw','Caliban''s War','James S. A. Corey','','Fiction',2012),('w-other','Elsewhere','Ada North','','Fiction',2020);
INSERT INTO audio_editions VALUES('ed-lw','w-lw','/covers/lw.jpg','Jefferson Mays',0,'Test'),('hc-501','w-cw','/covers/cw.jpg','Audio not added',0,'Hardcover library'),('ed-other','w-other','/covers/o.jpg','N',0,'Test');
INSERT INTO recordings VALUES('rec-lw','ed-lw'),('recording-hc-501','hc-501'),('rec-other','ed-other');
INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES('tr-lw','rec-lw','Part 1',0,72000,'/media/lw.mp3','local'),('tr-o','rec-other','Part 1',0,100,'/media/o.mp3','local');
INSERT INTO user_library VALUES(1,'ed-lw','listening',1),(1,'hc-501','unread',2),(1,'ed-other','unread',3);
INSERT INTO user_progress VALUES(1,'rec-lw','tr-lw',4321,72000,9);
INSERT INTO series_catalogue VALUES(11,'The Expanse','James S. A. Corey',9),(12,'The Lost Saga','Nobody Known',3);
INSERT INTO series_catalogue_works VALUES(11,501,'w-cw','Caliban''s War',2,NULL,0),(11,500,'w-lw','Leviathan Wakes',1,NULL,0),(12,900,'w-other','Elsewhere',1,NULL,0);
INSERT INTO user_saved_series VALUES(1,11,5,6),(1,12,5,6);
INSERT INTO user_saved_series_works VALUES(1,11,500,'w-lw',0),(1,11,501,'w-cw',1),(1,12,900,'w-other',0);
INSERT INTO user_series_seen_works VALUES(1,11,500,7),(1,11,501,7);
INSERT INTO series_acquisition_jobs VALUES('job-1',1,11,501,'w-cw','ebook','failed','Library Genesis could not be reached.',8,3,NULL);
INSERT INTO user_work_library_origin VALUES(1,'w-cw','series',11,2);
`);
  old.close();
}

const { createControl, fixtureFetch } = await import("./audiobookdb-fixture.ts");
const control = createControl();
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control) });
ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control) });
const { sqlite, seriesTablesAreHardcover, resetSeriesTablesToCatalogue } = await import("../server/db.ts");
const { createApp } = await import("../server/app.ts");
const resave = await import("../server/series-resave.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
});
const login = async () => {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-password" } });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
};
const admin = await login();
const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: admin }, ...(payload === undefined ? {} : { payload: payload as object }) });
const columnType = (table: string, column: string) =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).find((entry) => entry.name === column)?.type;

test("at startup the Hardcover series tables are renamed and left unused, and new tables on text ids are made", () => {
  assert.equal(seriesTablesAreHardcover(), false);
  for (const table of ["series_catalogue", "series_catalogue_works", "user_saved_series", "user_saved_series_works", "user_series_seen_works", "series_acquisition_jobs"])
    assert.ok(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`hardcover_${table}`), `hardcover_${table}`);
  assert.equal(columnType("series_catalogue", "id"), "TEXT");
  assert.equal(columnType("series_catalogue_works", "book_id"), "TEXT");
  assert.equal(columnType("series_acquisition_jobs", "series_id"), "TEXT");
  // The new tables start empty; the old rows are kept where they were.
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM user_saved_series").pluck().get(), 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM hardcover_user_saved_series").pluck().get(), 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM hardcover_series_acquisition_jobs").pluck().get(), 1);
  // The old table's foreign keys follow it; the new table has its own unique indexes.
  assert.match(sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='hardcover_user_saved_series'").pluck().get() as string, /REFERENCES "?hardcover_series_catalogue"?/);
  const indexes = sqlite.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'series_acquisition_jobs_user_%'").pluck().all();
  assert.deepEqual(indexes, ["series_acquisition_jobs", "series_acquisition_jobs"]);
  // Each saved series waits to be saved again, with the works the user had.
  const rows = resave.resaveRows().map((row) => [row.hardcoverSeriesId, row.name, row.status, JSON.parse(row.workIds).sort()]);
  assert.deepEqual(rows, [
    [11, "The Expanse", "pending", ["w-cw", "w-lw"]],
    [12, "The Lost Saga", "pending", ["w-other"]],
  ]);
  // Once only: a second start does nothing.
  assert.equal(resetSeriesTablesToCatalogue(), false);
  assert.equal(resave.resaveRows().length, 2);
});

test("without the AudiobookDB key nothing is saved yet: Activity says why and offers Retry", async () => {
  const outcome = await resave.resavePending();
  assert.deepEqual(outcome, { saved: 0, missing: 0, failed: 1 });
  const activity = (await call("GET", "/api/activity")).json() as { items: { id: string; title: string; state: string; error: string | null; actions: string[]; facts: { saveAgain?: true } }[] };
  const item = activity.items.find((entry) => entry.id === "series-acquisition:resave:1:11")!;
  assert.deepEqual([item.title, item.state, item.error, item.actions, item.facts.saveAgain], ["The Expanse", "failed", "Add the AudiobookDB API key first.", ["retry"], true]);
});

test("with the key, the series found by name is saved again with its books; the one not found is listed in Activity", async () => {
  process.env.AUDIOBOOKDB_API_KEY = "env-key";
  const outcome = await resave.resavePending();
  assert.deepEqual(outcome, { saved: 1, missing: 1, failed: 0 });
  const saved = (await call("GET", "/api/series/sr-expanse")).json() as { works: { id: string; workId: string | null; added: boolean; introduced: boolean; new: boolean; libraryOriginLabel?: string }[] };
  const added = saved.works.filter((work) => work.added).map((work) => [work.id, work.workId, work.introduced, work.libraryOriginLabel]);
  assert.deepEqual(added, [
    ["bk-leviathan", "w-lw", false, null],
    ["bk-calibans-war", "w-cw", true, "Added through this series"],
  ]);
  // No "New" for the reset, and no search was started.
  assert.deepEqual(saved.works.filter((work) => work.new), []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM series_acquisition_jobs").pluck().get(), 0);
  // The works keep their editions, placeholder id and progress; no work was made for a book the user had.
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM works").pluck().get(), 3);
  assert.deepEqual(sqlite.prepare("SELECT book_id FROM user_library WHERE user_id=1 ORDER BY book_id").pluck().all(), ["ed-lw", "ed-other", "hc-501"]);
  assert.equal(sqlite.prepare("SELECT position FROM user_progress WHERE recording_id='rec-lw'").pluck().get(), 4321);
  assert.deepEqual(sqlite.prepare("SELECT provider,external_id AS id FROM work_catalogue_links WHERE work_id='w-cw'").get(), { provider: "audiobookdb", id: "bk-calibans-war" });
  // The series AudiobookDB does not have: failed, with the reason and Discard.
  const activity = (await call("GET", "/api/activity")).json() as { items: { id: string; title: string; state: string; error: string | null; actions: string[]; permanent: boolean }[] };
  const missing = activity.items.find((entry) => entry.id === "series-acquisition:resave:1:12")!;
  assert.deepEqual([missing.title, missing.state, missing.error, missing.actions, missing.permanent], ["The Lost Saga", "failed", resave.RESAVE_NOT_FOUND, ["discard"], true]);
  assert.equal(activity.items.some((entry) => entry.id === "series-acquisition:resave:1:11"), false);
  // Discard: gone from Activity; the loop has nothing left to do.
  const discard = await call("POST", "/api/activity/items/discard", { id: "series-acquisition:resave:1:12" });
  assert.equal(discard.statusCode, 200, discard.body);
  assert.equal(resave.resaveRows().length, 1);
  assert.deepEqual(await resave.resavePending(), { saved: 0, missing: 0, failed: 0 });
});
