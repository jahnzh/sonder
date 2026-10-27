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
`);
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
  ["acquisitions", ["work_id", "language", "narrator"]],
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
`);
if (!(sqlite.prepare("PRAGMA table_info(sessions)").all() as {name:string}[]).some(c => c.name === "user_id"))
  sqlite.exec("ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
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
export const db = drizzle(sqlite, { schema });
