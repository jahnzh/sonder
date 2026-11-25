import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import * as schema from "./schema.ts";
export const dataDir = resolve(process.env.DATA_DIR || "data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export const sqlite = new Database(resolve(dataDir, "sonder.db"));
chmodSync(resolve(dataDir, "sonder.db"), 0o600);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
// #721 (part b): the series tables move from Hardcover's integer ids to AudiobookDB's text ids. A non-additive change
// the owner allowed: once, at the first start that finds the Hardcover tables, they are renamed to `hardcover_<name>`
// and left unused (dropped with the rest of Hardcover later), and new empty tables are made under the old names below.
// Each user's saved series are noted in `series_resave` to be saved again by their names on AudiobookDB
// (`server/series-resave.ts`); what cannot be found is listed in Activity. Works, files and progress are untouched.
export const HARDCOVER_SERIES_TABLES = [
  "series_catalogue",
  "series_catalogue_works",
  "user_saved_series",
  "user_saved_series_works",
  "user_series_seen_works",
  "series_acquisition_jobs",
] as const;
const SERIES_RESAVE_TABLE =
  "CREATE TABLE IF NOT EXISTS series_resave(user_id INTEGER NOT NULL,hardcover_series_id INTEGER NOT NULL,name TEXT NOT NULL,author TEXT,work_ids TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL CHECK(status IN ('pending','saved','missing','failed')),series_id TEXT,reason TEXT,attempts INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,hardcover_series_id))";
/** True while `series_catalogue` is the Hardcover table (an integer id): the reset has not run on this database. */
export function seriesTablesAreHardcover(): boolean {
  const id = (sqlite.prepare("PRAGMA table_info(series_catalogue)").all() as { name: string; type: string }[]).find((column) => column.name === "id");
  return !!id && /INT/i.test(id.type);
}
export function resetSeriesTablesToCatalogue(now = Date.now()): boolean {
  if (!seriesTablesAreHardcover()) return false;
  sqlite.transaction(() => {
    const exists = (name: string) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    // The old unique indexes keep their names on the renamed table; the new table makes its own under those names.
    sqlite.exec("DROP INDEX IF EXISTS series_acquisition_jobs_user_series_book_kind; DROP INDEX IF EXISTS series_acquisition_jobs_user_work_kind;");
    for (const table of HARDCOVER_SERIES_TABLES)
      if (exists(table) && !exists(`hardcover_${table}`)) sqlite.exec(`ALTER TABLE ${table} RENAME TO hardcover_${table}`);
    sqlite.exec(SERIES_RESAVE_TABLE);
    if (exists("hardcover_user_saved_series"))
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO series_resave(user_id,hardcover_series_id,name,author,work_ids,status,updated_at)
           SELECT u.user_id,u.series_id,c.name,c.author,
             COALESCE((SELECT json_group_array(w.work_id) FROM hardcover_user_saved_series_works w WHERE w.user_id=u.user_id AND w.series_id=u.series_id),'[]'),
             'pending',?
           FROM hardcover_user_saved_series u JOIN hardcover_series_catalogue c ON c.id=u.series_id`,
        )
        .run(now);
  })();
  return true;
}
resetSeriesTablesToCatalogue();
sqlite.exec(`
CREATE TABLE IF NOT EXISTS acquisitions(id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,magnet TEXT NOT NULL,backend TEXT NOT NULL,remote_id TEXT,title TEXT NOT NULL,author TEXT NOT NULL,cover TEXT NOT NULL,status TEXT NOT NULL,progress REAL NOT NULL DEFAULT 0,error TEXT,book_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS works(id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL,description TEXT NOT NULL,genre TEXT NOT NULL,year INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audio_editions(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id),cover TEXT NOT NULL,narrator TEXT NOT NULL,rating REAL NOT NULL,source_label TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL REFERENCES audio_editions(id));
CREATE TABLE IF NOT EXISTS tracks(id TEXT PRIMARY KEY,recording_id TEXT NOT NULL REFERENCES recordings(id),title TEXT NOT NULL,track_index INTEGER NOT NULL,duration REAL NOT NULL DEFAULT 0,chapters TEXT NOT NULL DEFAULT '[]',source TEXT NOT NULL,source_type TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS library(book_id TEXT PRIMARY KEY REFERENCES audio_editions(id),status TEXT NOT NULL DEFAULT 'unread',added_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hidden_library(book_id TEXT PRIMARY KEY REFERENCES audio_editions(id));
CREATE TABLE IF NOT EXISTS progress(recording_id TEXT PRIMARY KEY REFERENCES recordings(id),track_id TEXT NOT NULL REFERENCES tracks(id),position REAL NOT NULL,duration REAL NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media_copies(track_id TEXT PRIMARY KEY REFERENCES tracks(id),path TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS server_downloads(recording_id TEXT PRIMARY KEY REFERENCES recordings(id),book_id TEXT NOT NULL,status TEXT NOT NULL,progress REAL NOT NULL,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
-- One row per scheduled day of the daily database backups (#361); a retry of the same day updates its row.
CREATE TABLE IF NOT EXISTS backup_runs(day TEXT PRIMARY KEY,file TEXT NOT NULL,status TEXT NOT NULL,bytes INTEGER,error TEXT,attempts INTEGER NOT NULL DEFAULT 1,started_at INTEGER NOT NULL,finished_at INTEGER,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ebook_editions(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id),format TEXT NOT NULL,source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hardcover_progress(book_id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL,recording_id TEXT NOT NULL REFERENCES recordings(id),position REAL NOT NULL,duration REAL NOT NULL,updated_at INTEGER NOT NULL,error TEXT);
CREATE TABLE IF NOT EXISTS hardcover_reads(book_id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL,snapshot TEXT NOT NULL,fraction REAL,synced_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hardcover_recording_editions(recording_id TEXT PRIMARY KEY REFERENCES recordings(id),edition_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hardcover_links(work_id TEXT PRIMARY KEY REFERENCES works(id),book_id INTEGER NOT NULL,slug TEXT,series TEXT NOT NULL DEFAULT '[]',user_book_id INTEGER,status_id INTEGER,remote_updated_at INTEGER NOT NULL DEFAULT 0,synced_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS hardcover_links_book ON hardcover_links(book_id);
CREATE TABLE IF NOT EXISTS hardcover_outbox(book_id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL,status_id INTEGER NOT NULL,intent TEXT NOT NULL DEFAULT 'status',updated_at INTEGER NOT NULL,error TEXT);
CREATE TABLE IF NOT EXISTS hardcover_lists(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL,name TEXT NOT NULL,slug TEXT,members TEXT NOT NULL DEFAULT '[]',synced_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ebook_progress(edition_id TEXT PRIMARY KEY REFERENCES ebook_editions(id),cfi TEXT NOT NULL,chapter INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reader_checkpoints(edition_id TEXT PRIMARY KEY REFERENCES ebook_editions(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reader_events(event_id TEXT PRIMARY KEY,edition_id TEXT NOT NULL REFERENCES ebook_editions(id));
CREATE TABLE IF NOT EXISTS reader_bookmarks(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL REFERENCES ebook_editions(id),label TEXT NOT NULL,locator TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS alignment_jobs(id TEXT PRIMARY KEY,ebook_id TEXT NOT NULL REFERENCES ebook_editions(id),recording_id TEXT NOT NULL REFERENCES recordings(id),data TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS alignment_pair ON alignment_jobs(ebook_id,recording_id);
CREATE TABLE IF NOT EXISTS hardcover_reading_outbox(book_id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL,work_id TEXT NOT NULL REFERENCES works(id),fraction REAL NOT NULL,updated_at INTEGER NOT NULL,error TEXT);
CREATE TABLE IF NOT EXISTS media_faults(recording_id TEXT NOT NULL REFERENCES recordings(id),scope TEXT NOT NULL,reason TEXT NOT NULL,note TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(recording_id,scope));
-- Staged pool audio (#421). A retired folder name is never staged into again; it is written before its removal is sent.
CREATE TABLE IF NOT EXISTS alignment_pool_retired(name TEXT PRIMARY KEY,job_id TEXT NOT NULL,recording_id TEXT NOT NULL,retired_at INTEGER NOT NULL);
-- Where a deleted alignment job had staged its tracks: its row is gone, the record stays until the folder is removed.
CREATE TABLE IF NOT EXISTS alignment_pool_orphans(host_id TEXT NOT NULL,folder TEXT NOT NULL,job_id TEXT NOT NULL,recording_id TEXT NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(host_id,folder));
`);
// Existing alignment maps were all produced by the current aeneas worker.
const alignmentColumns = new Set(
  (sqlite.prepare("PRAGMA table_info(alignment_jobs)").all() as { name: string }[])
    .map((column) => column.name),
);
for (const [column, definition] of [
  ["engine", "TEXT NOT NULL DEFAULT 'aeneas-1.7.3'"],
  ["outcome", "TEXT"],
  ["stage_timings", "TEXT"],
  // Durable scheduler claim (#276): which server instance runs which generation.
  ["claim_owner", "TEXT"],
  ["claim_generation", "TEXT"],
  ["claimed_at", "INTEGER"],
  // Automatic rebuild (#277): the usable map that stays served until its rebuild publishes.
  ["published_map", "TEXT"],
  // ADR 0012: the consensus job a member's projected map was projected from.
  ["projected_from", "TEXT"],
] as const)
  if (!alignmentColumns.has(column))
    sqlite.exec(`ALTER TABLE alignment_jobs ADD COLUMN ${column} ${definition}`);
if (
  !(
    sqlite.prepare("PRAGMA table_info(acquisitions)").all() as {
      name: string;
    }[]
  ).some((c) => c.name === "magnet")
)
  sqlite.exec(
    "ALTER TABLE acquisitions ADD COLUMN magnet TEXT NOT NULL DEFAULT ''",
  );
if (
  !(
    sqlite.prepare("PRAGMA table_info(tracks)").all() as { name: string }[]
  ).some((c) => c.name === "chapters")
)
  sqlite.exec(
    "ALTER TABLE tracks ADD COLUMN chapters TEXT NOT NULL DEFAULT '[]'",
  );
for (const [table, columns] of [
  ["audio_editions", ["language", "release_title"]],
  // `kind` (#901): "ebook" for a torrent fetched for its EPUB or PDF; null for an audiobook, as every older row.
  ["acquisitions", ["work_id", "language", "narrator", "kind"]],
] as const) {
  const existing = new Set(
    (
      sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((column) => column.name),
  );
  for (const column of columns)
    if (!existing.has(column))
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
}
// Indexes for the batched media-state read (ADR 0011): a work's editions, an edition's
// recordings and a recording's tracks. Its acquisition query uses the primary keys.
sqlite.exec(`
CREATE INDEX IF NOT EXISTS audio_editions_work ON audio_editions(work_id);
CREATE INDEX IF NOT EXISTS recordings_edition ON recordings(edition_id);
CREATE INDEX IF NOT EXISTS tracks_recording ON tracks(recording_id);
`);
sqlite.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT,role TEXT NOT NULL CHECK(role IN ('admin','user')),created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS user_acquisitions(user_id INTEGER NOT NULL REFERENCES users(id),acquisition_id TEXT NOT NULL REFERENCES acquisitions(id),PRIMARY KEY(user_id,acquisition_id));
CREATE TABLE IF NOT EXISTS user_settings(user_id INTEGER NOT NULL REFERENCES users(id),key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(user_id,key));
CREATE TABLE IF NOT EXISTS user_library(user_id INTEGER NOT NULL REFERENCES users(id),book_id TEXT NOT NULL REFERENCES audio_editions(id),status TEXT NOT NULL DEFAULT 'unread',added_at INTEGER NOT NULL,PRIMARY KEY(user_id,book_id));
CREATE TABLE IF NOT EXISTS user_hidden_library(user_id INTEGER NOT NULL REFERENCES users(id),book_id TEXT NOT NULL REFERENCES audio_editions(id),PRIMARY KEY(user_id,book_id));
CREATE TABLE IF NOT EXISTS user_progress(user_id INTEGER NOT NULL REFERENCES users(id),recording_id TEXT NOT NULL REFERENCES recordings(id),track_id TEXT NOT NULL REFERENCES tracks(id),position REAL NOT NULL,duration REAL NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,recording_id));
CREATE TABLE IF NOT EXISTS user_ebook_progress(user_id INTEGER NOT NULL REFERENCES users(id),edition_id TEXT NOT NULL REFERENCES ebook_editions(id),cfi TEXT NOT NULL,chapter INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,edition_id));
CREATE TABLE IF NOT EXISTS user_reader_checkpoints(user_id INTEGER NOT NULL REFERENCES users(id),edition_id TEXT NOT NULL REFERENCES ebook_editions(id),data TEXT NOT NULL,PRIMARY KEY(user_id,edition_id));
CREATE TABLE IF NOT EXISTS user_reader_bookmarks(user_id INTEGER NOT NULL REFERENCES users(id),id TEXT NOT NULL,edition_id TEXT NOT NULL REFERENCES ebook_editions(id),label TEXT NOT NULL,locator TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,id));
CREATE TABLE IF NOT EXISTS user_reader_events(user_id INTEGER NOT NULL REFERENCES users(id),event_id TEXT NOT NULL,edition_id TEXT NOT NULL REFERENCES ebook_editions(id),PRIMARY KEY(user_id,event_id));
CREATE TABLE IF NOT EXISTS series_catalogue(id TEXT PRIMARY KEY,name TEXT NOT NULL,author TEXT,book_count INTEGER);
CREATE TABLE IF NOT EXISTS series_catalogue_works(series_id TEXT NOT NULL REFERENCES series_catalogue(id),book_id TEXT NOT NULL,work_id TEXT REFERENCES works(id),title TEXT NOT NULL,position REAL,cover TEXT,unreleased INTEGER NOT NULL DEFAULT 0,position_label TEXT,author TEXT,provider TEXT NOT NULL DEFAULT 'audiobookdb' CHECK(provider IN ('audiobookdb','openlibrary')),language TEXT,narrators TEXT NOT NULL DEFAULT '[]',length_ms INTEGER,release_date TEXT,PRIMARY KEY(series_id,book_id));
CREATE TABLE IF NOT EXISTS user_saved_series(user_id INTEGER NOT NULL REFERENCES users(id),series_id TEXT NOT NULL REFERENCES series_catalogue(id),saved_at INTEGER NOT NULL,refreshed_at INTEGER,PRIMARY KEY(user_id,series_id));
CREATE TABLE IF NOT EXISTS user_saved_series_works(user_id INTEGER NOT NULL REFERENCES users(id),series_id TEXT NOT NULL REFERENCES series_catalogue(id),book_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES works(id),introduced INTEGER NOT NULL,PRIMARY KEY(user_id,series_id,book_id));
CREATE TABLE IF NOT EXISTS user_series_seen_works(user_id INTEGER NOT NULL REFERENCES users(id),series_id TEXT NOT NULL REFERENCES series_catalogue(id),book_id TEXT NOT NULL,acknowledged_at INTEGER NOT NULL,PRIMARY KEY(user_id,series_id,book_id));
CREATE TABLE IF NOT EXISTS user_work_completion(user_id INTEGER NOT NULL REFERENCES users(id),work_id TEXT NOT NULL REFERENCES works(id),status TEXT NOT NULL CHECK(status IN ('finished','unread')),PRIMARY KEY(user_id,work_id));
CREATE TABLE IF NOT EXISTS user_work_library_origin(user_id INTEGER NOT NULL REFERENCES users(id),work_id TEXT NOT NULL REFERENCES works(id),source TEXT NOT NULL CHECK(source IN ('unknown','manual','hardcover_sync','series')),series_id INTEGER,added_at INTEGER NOT NULL,PRIMARY KEY(user_id,work_id));
CREATE TABLE IF NOT EXISTS user_want_to_read(user_id INTEGER NOT NULL REFERENCES users(id),work_id TEXT NOT NULL REFERENCES works(id),source TEXT NOT NULL CHECK(source IN ('manual','hardcover')),added_at INTEGER NOT NULL,PRIMARY KEY(user_id,work_id));
CREATE TABLE IF NOT EXISTS account_requests(id INTEGER PRIMARY KEY,email TEXT NOT NULL,username TEXT NOT NULL,note TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,reviewed_at INTEGER,invite_id INTEGER);
CREATE TABLE IF NOT EXISTS account_invites(id INTEGER PRIMARY KEY,token TEXT NOT NULL UNIQUE,email TEXT NOT NULL,username TEXT NOT NULL,account_request_id INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,claimed_at INTEGER);
`);
if (!(sqlite.prepare("PRAGMA table_info(sessions)").all() as {name:string}[]).some(c => c.name === "user_id"))
  sqlite.exec("ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
if (!(sqlite.prepare("PRAGMA table_info(user_saved_series)").all() as {name:string}[]).some(c => c.name === "refreshed_at"))
  sqlite.exec("ALTER TABLE user_saved_series ADD COLUMN refreshed_at INTEGER");
// Daily backups (#361): the identity of the file a run published (size is `bytes`), which retention checks before
// it deletes anything; the run's claim on its day; when the file at the recorded name stopped being that file; and
// the result of the retention that followed a successful run, with its reason when it failed.
{
  const backupColumns = new Set((sqlite.prepare("PRAGMA table_info(backup_runs)").all() as { name: string }[]).map((c) => c.name));
  for (const [column, type] of [["sha256", "TEXT"], ["claim", "TEXT"], ["disowned_at", "INTEGER"], ["cleanup", "TEXT"], ["cleanup_error", "TEXT"]] as const)
    if (!backupColumns.has(column)) sqlite.exec(`ALTER TABLE backup_runs ADD COLUMN ${column} ${type}`);
}
sqlite.transaction(() => {
  sqlite.prepare("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)").run(Date.now());
  if (!sqlite.prepare("SELECT 1 FROM settings WHERE key='migration:multi-user'").get()) {
    sqlite.exec("INSERT INTO user_acquisitions(user_id,acquisition_id) SELECT 1,id FROM acquisitions");
    for (const table of ["library", "hidden_library", "progress", "ebook_progress", "reader_checkpoints", "reader_bookmarks", "reader_events"])
      sqlite.exec(`INSERT INTO user_${table} SELECT 1, * FROM ${table}`);
    sqlite.exec("INSERT INTO user_settings(user_id,key,value) SELECT 1,key,value FROM settings WHERE key='appearance'");
    sqlite.exec("INSERT INTO settings(key,value) VALUES('migration:multi-user','1')");
  }
})();
sqlite.exec(`
CREATE TABLE IF NOT EXISTS user_hardcover_links(user_id INTEGER NOT NULL REFERENCES users(id),book_id INTEGER NOT NULL,user_book_id INTEGER,status_id INTEGER,remote_updated_at INTEGER NOT NULL DEFAULT 0,synced_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,book_id));
CREATE TABLE IF NOT EXISTS user_hardcover_outbox(user_id INTEGER NOT NULL REFERENCES users(id),book_id INTEGER NOT NULL,account_id INTEGER NOT NULL,status_id INTEGER NOT NULL,intent TEXT NOT NULL DEFAULT 'status',updated_at INTEGER NOT NULL,error TEXT,PRIMARY KEY(user_id,book_id));
CREATE TABLE IF NOT EXISTS user_hardcover_reading_outbox(user_id INTEGER NOT NULL REFERENCES users(id),book_id INTEGER NOT NULL,account_id INTEGER NOT NULL,work_id TEXT NOT NULL REFERENCES works(id),fraction REAL NOT NULL,updated_at INTEGER NOT NULL,error TEXT,PRIMARY KEY(user_id,book_id));
CREATE TABLE IF NOT EXISTS user_hardcover_progress(user_id INTEGER NOT NULL REFERENCES users(id),book_id INTEGER NOT NULL,account_id INTEGER NOT NULL,recording_id TEXT NOT NULL REFERENCES recordings(id),position REAL NOT NULL,duration REAL NOT NULL,updated_at INTEGER NOT NULL,error TEXT,PRIMARY KEY(user_id,book_id));
CREATE TABLE IF NOT EXISTS user_hardcover_lists(user_id INTEGER NOT NULL REFERENCES users(id),id INTEGER NOT NULL,account_id INTEGER NOT NULL,name TEXT NOT NULL,slug TEXT,members TEXT NOT NULL DEFAULT '[]',synced_at INTEGER NOT NULL,PRIMARY KEY(user_id,id));
CREATE TABLE IF NOT EXISTS user_hardcover_reads(user_id INTEGER NOT NULL REFERENCES users(id),book_id INTEGER NOT NULL,account_id INTEGER NOT NULL,snapshot TEXT NOT NULL,fraction REAL,synced_at INTEGER NOT NULL,PRIMARY KEY(user_id,book_id));
CREATE TABLE IF NOT EXISTS user_hardcover_recording_editions(user_id INTEGER NOT NULL REFERENCES users(id),recording_id TEXT NOT NULL REFERENCES recordings(id),edition_id INTEGER NOT NULL,PRIMARY KEY(user_id,recording_id));
CREATE TABLE IF NOT EXISTS work_media_states(user_id INTEGER NOT NULL REFERENCES users(id),work_id TEXT NOT NULL REFERENCES works(id),state TEXT NOT NULL DEFAULT 'missing',hold_reason TEXT,acquisition_id TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,work_id));
CREATE TABLE IF NOT EXISTS work_ebook_set(work_id TEXT PRIMARY KEY REFERENCES works(id),consensus_fingerprint TEXT,consensus_sentences TEXT NOT NULL DEFAULT '[]',projections TEXT NOT NULL DEFAULT '{}',recording_id TEXT,consensus_job_id TEXT,default_ebook_id TEXT,default_ebook_override TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS work_ebook_set_members(work_id TEXT NOT NULL REFERENCES works(id),ebook_id TEXT NOT NULL REFERENCES ebook_editions(id),status TEXT NOT NULL,hold_reason TEXT,source_title TEXT,source_author TEXT,language TEXT,byte_size INTEGER,evidence TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL,PRIMARY KEY(work_id,ebook_id));
CREATE TABLE IF NOT EXISTS series_acquisition_jobs(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),series_id TEXT NOT NULL REFERENCES series_catalogue(id),book_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES works(id),kind TEXT NOT NULL CHECK(kind IN ('audio','ebook')),status TEXT NOT NULL CHECK(status IN ('pending','searching','done','failed')),error TEXT,updated_at INTEGER NOT NULL,auto_retries INTEGER NOT NULL DEFAULT 0,retry_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS series_acquisition_jobs_user_series_book_kind ON series_acquisition_jobs(user_id,series_id,book_id,kind);
CREATE UNIQUE INDEX IF NOT EXISTS series_acquisition_jobs_user_work_kind ON series_acquisition_jobs(user_id,work_id,kind);
`);
// The catalogue (#721): AudiobookDB and Open Library answers cached with their expiry (searches a day, details a
// week; covers and descriptions are never stored), the daily units spent per provider, a work's link to a provider
// book or work, a recording's link to an AudiobookDB release, and the last outcome of the matcher for a work.
// No foreign keys: a work or recording removed elsewhere leaves a row nothing reads, and its removal is not refused.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS catalogue_cache(provider TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,fetched_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(provider,kind,key));
CREATE TABLE IF NOT EXISTS catalogue_usage(provider TEXT NOT NULL,day TEXT NOT NULL,units INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(provider,day));
CREATE TABLE IF NOT EXISTS work_catalogue_links(work_id TEXT PRIMARY KEY,provider TEXT NOT NULL CHECK(provider IN ('audiobookdb','openlibrary')),external_id TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,series_id TEXT,series_name TEXT,series_position TEXT,series_sort REAL,matched_by TEXT NOT NULL CHECK(matched_by IN ('title','asin','manual')),linked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recording_release_links(recording_id TEXT PRIMARY KEY,book_id TEXT NOT NULL,release_id TEXT NOT NULL,narrator TEXT,length_ms INTEGER,asin TEXT,language TEXT,chapters TEXT NOT NULL DEFAULT '[]',matched_by TEXT NOT NULL CHECK(matched_by IN ('asin','length','manual')),linked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS work_catalogue_match(work_id TEXT PRIMARY KEY,outcome TEXT NOT NULL CHECK(outcome IN ('matched','ambiguous','missing','failed')),reason TEXT,candidates INTEGER NOT NULL DEFAULT 0,checked_at INTEGER NOT NULL);
-- Part e: a work's links to Google Books and iTunes, beside its main link (one per provider), picked on the match page.
CREATE TABLE IF NOT EXISTS work_provider_links(work_id TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider IN ('googlebooks','itunes')),external_id TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,matched_by TEXT NOT NULL DEFAULT 'manual' CHECK(matched_by IN ('manual')),linked_at INTEGER NOT NULL,PRIMARY KEY(work_id,provider));
-- #754: the other AudiobookDB entries of the same work as the main link (duplicates, not rivals); their releases are the work's too.
CREATE TABLE IF NOT EXISTS work_catalogue_duplicates(work_id TEXT NOT NULL,provider TEXT NOT NULL DEFAULT 'audiobookdb' CHECK(provider IN ('audiobookdb')),external_id TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,releases INTEGER NOT NULL DEFAULT 0,linked_at INTEGER NOT NULL,PRIMARY KEY(work_id,provider,external_id));
`);
// The book's Edit page (#719 part a): a field the administrator edited by hand, per work or per recording, as JSON. It
// wins over the stored value and over the catalogue's, whatever a refresh writes; deleting the row (Revert) gives the
// source's value back. A local series (made by hand, not from a provider) has its name here; a work's series list is
// its `series` field. No foreign keys, as the catalogue tables: a removed work leaves rows nothing reads.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS work_metadata_overrides(work_id TEXT NOT NULL,field TEXT NOT NULL,value TEXT NOT NULL,edited_at INTEGER NOT NULL,PRIMARY KEY(work_id,field));
CREATE TABLE IF NOT EXISTS recording_metadata_overrides(recording_id TEXT NOT NULL,field TEXT NOT NULL,value TEXT NOT NULL,edited_at INTEGER NOT NULL,PRIMARY KEY(recording_id,field));
CREATE TABLE IF NOT EXISTS local_series(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL);
`);
// #719 part b: the provider a field was taken from by a match (`audiobookdb`, `openlibrary`, `googlebooks`, `itunes`);
// null for a field edited by hand. And the series batch of 'Match automatically', one row per work, shown in Activity.
for (const table of ["work_metadata_overrides", "recording_metadata_overrides"])
  if (!(sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "source"))
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN source TEXT`);
sqlite.exec(`
CREATE TABLE IF NOT EXISTS metadata_match_jobs(work_id TEXT PRIMARY KEY,series_id TEXT NOT NULL,user_id INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','running','done','unsure','failed')),provider TEXT,fields TEXT NOT NULL DEFAULT '[]',reason TEXT,updated_at INTEGER NOT NULL);
`);
// A preview of a release cached on TorBox (#889): which release and file it plays, and when it ended. `added` is the
// best-known fact whether this preview put the release on the TorBox account; it is NOT reliable yet (TorBox's list
// is cached for up to 600 s), so nothing acts on it. Removal from TorBox is a later ticket (server/torbox-preview.ts).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS torbox_previews(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,hash TEXT NOT NULL,torrent_id INTEGER NOT NULL,file_id INTEGER,file_name TEXT,added INTEGER NOT NULL CHECK(added IN (0,1)),created_at INTEGER NOT NULL,ended_at INTEGER);
CREATE INDEX IF NOT EXISTS torbox_previews_hash ON torbox_previews(hash);
`);
sqlite.exec(SERIES_RESAVE_TABLE);
// A work a series brought into the library names that series by its AudiobookDB id (#721); `series_id` keeps the
// Hardcover id of older rows, unused.
if (!(sqlite.prepare("PRAGMA table_info(user_work_library_origin)").all() as { name: string }[]).some((c) => c.name === "catalogue_series_id"))
  sqlite.exec("ALTER TABLE user_work_library_origin ADD COLUMN catalogue_series_id TEXT");
// A series search that could not reach its source is tried again by itself (#717): how often it was, and not before when.
{
  const seriesJobColumns = new Set((sqlite.prepare("PRAGMA table_info(series_acquisition_jobs)").all() as { name: string }[]).map((c) => c.name));
  for (const [column, type] of [["auto_retries", "INTEGER NOT NULL DEFAULT 0"], ["retry_at", "INTEGER"]] as const)
    if (!seriesJobColumns.has(column)) sqlite.exec(`ALTER TABLE series_acquisition_jobs ADD COLUMN ${column} ${type}`);
}
// One-time copy of the single-account Hardcover key, state and queues to the admin (#15). The old rows stay for rollback.
export function migrateHardcoverToUsers(): void {
  sqlite.transaction(() => {
    if (sqlite.prepare("SELECT 1 FROM settings WHERE key='migration:multi-user-hardcover'").get()) return;
    sqlite.exec(`
INSERT OR IGNORE INTO user_settings(user_id,key,value) SELECT 1,key,value FROM settings WHERE key IN ('hardcover','hardcoverState');
INSERT OR IGNORE INTO user_hardcover_links(user_id,book_id,user_book_id,status_id,remote_updated_at,synced_at) SELECT 1,book_id,user_book_id,status_id,remote_updated_at,MAX(synced_at) FROM hardcover_links WHERE user_book_id IS NOT NULL OR status_id IS NOT NULL OR synced_at>0 GROUP BY book_id;
INSERT OR IGNORE INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,intent,updated_at,error) SELECT 1,book_id,account_id,status_id,intent,updated_at,error FROM hardcover_outbox;
INSERT OR IGNORE INTO user_hardcover_reading_outbox(user_id,book_id,account_id,work_id,fraction,updated_at,error) SELECT 1,book_id,account_id,work_id,fraction,updated_at,error FROM hardcover_reading_outbox;
INSERT OR IGNORE INTO user_hardcover_progress(user_id,book_id,account_id,recording_id,position,duration,updated_at,error) SELECT 1,book_id,account_id,recording_id,position,duration,updated_at,error FROM hardcover_progress;
INSERT OR IGNORE INTO user_hardcover_lists(user_id,id,account_id,name,slug,members,synced_at) SELECT 1,id,account_id,name,slug,members,synced_at FROM hardcover_lists;
INSERT OR IGNORE INTO user_hardcover_reads(user_id,book_id,account_id,snapshot,fraction,synced_at) SELECT 1,book_id,account_id,snapshot,fraction,synced_at FROM hardcover_reads;
INSERT OR IGNORE INTO user_hardcover_recording_editions(user_id,recording_id,edition_id) SELECT 1,recording_id,edition_id FROM hardcover_recording_editions;
INSERT INTO settings(key,value) VALUES('migration:multi-user-hardcover','1');
`);
  })();
}
migrateHardcoverToUsers();
export const db = drizzle(sqlite, { schema });
