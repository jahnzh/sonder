/**
 * Daily database backups (#361): a run makes a verified copy in a temporary backups folder, records it, and
 * retention removes only the daily backups the schedule made beyond the newest 14. Everything (database, folders,
 * the `before-*` deploy copies) is built in a temporary directory here.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temp = mkdtempSync(join(tmpdir(), "sonder-backups-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
after(() => rmSync(temp, { recursive: true, force: true }));

const { default: Database } = (await import("better-sqlite3")) as typeof import("better-sqlite3") & { default: typeof import("better-sqlite3") };
const { sqlite } = await import("../server/db.ts");
const backups = await import("../server/backups.ts");
const { DAILY_BACKUPS_KEPT, MIN_FREE_BYTES, dailyBackupName } = await import("../server/backup-schedule.ts");

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
let folders = 0;
const folder = () => {
  const dir = join(temp, `backups-${(folders += 1)}`);
  mkdirSync(dir);
  return dir;
};
const days = (count: number, from = "2026-10-01") =>
  Array.from({ length: count }, (_, index) => new Date(at(`${from}T00:00:00Z`) + index * DAY).toISOString().slice(0, 10));
const plenty = () => 10 * MIN_FREE_BYTES;
const noDrive = () => null;

/** A backups folder as production has it: deploy copies, other files, and daily backups the schedule recorded. */
function populated(dailyDays: string[]) {
  const dir = folder();
  for (let index = 0; index < 120; index += 1) writeFileSync(join(dir, `before-${index.toString(16).padStart(7, "0")}-${1762000000 + index}.db`), `deploy copy ${index}`);
  writeFileSync(join(dir, "notes.txt"), "keep");
  writeFileSync(join(dir, "daily-2026-01-01.db.bak"), "keep");
  writeFileSync(join(dir, "daily-2026-01-01.db-wal"), "keep");
  writeFileSync(join(dir, "daily-2020-01-01.db"), "not recorded by the schedule");
  for (const day of dailyDays) {
    writeFileSync(join(dir, dailyBackupName(day)), `daily ${day}`);
    sqlite.prepare("INSERT INTO backup_runs(day,file,status,bytes,error,attempts,started_at,finished_at,updated_at) VALUES(?,?,'done',10,NULL,1,?,?,?)")
      .run(day, dailyBackupName(day), at(`${day}T03:00:00Z`), at(`${day}T03:01:00Z`), at(`${day}T03:01:00Z`));
  }
  return dir;
}

/** Name and content hash of every file that is not a daily backup made by the schedule. */
function others(dir: string, dailyDays: string[]) {
  const daily = new Set(dailyDays.map(dailyBackupName));
  return Object.fromEntries(readdirSync(dir).filter((name) => !daily.has(name)).sort()
    .map((name) => [name, statSync(join(dir, name)).isFile() ? createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") : "dir"]));
}

const row = (day: string) => sqlite.prepare("SELECT * FROM backup_runs WHERE day = ?").get(day) as
  { status: string; bytes: number | null; error: string | null; attempts: number; file: string } | undefined;

beforeEach(() => sqlite.exec("DELETE FROM backup_runs"));

test("a due run makes a verified daily backup, records it, and is not due again the same day", async () => {
  sqlite.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('backup-marker', 'present in the copy')").run();
  const dir = folder();
  const now = at("2026-11-16T03:05:00Z");
  const result = await backups.runDailyBackup({ now, dir, freeBytes: plenty, mountProblem: noDrive });
  assert.deepEqual(result, { ran: true, day: "2026-11-16", status: "done", error: null, removed: [] });
  const path = join(dir, "daily-2026-11-16.db");
  assert.deepEqual(readdirSync(dir), ["daily-2026-11-16.db"], "no temporary file is left");
  const copy = new Database(path, { readonly: true });
  try {
    assert.deepEqual(copy.pragma("integrity_check"), [{ integrity_check: "ok" }], "the backup passes PRAGMA integrity_check");
    assert.equal((copy.prepare("SELECT value FROM settings WHERE key = 'backup-marker'").get() as { value: string }).value, "present in the copy");
  } finally {
    copy.close();
  }
  const recorded = row("2026-11-16")!;
  assert.equal(recorded.status, "done");
  assert.equal(recorded.bytes, statSync(path).size);
  assert.equal(recorded.file, "daily-2026-11-16.db");
  assert.equal(backups.lastSuccessDay(dir), "2026-11-16");

  assert.deepEqual(await backups.runDailyBackup({ now: now + 20 * 3_600_000, dir, freeBytes: plenty, mountProblem: noDrive }), { ran: false, reason: "not-due" });
  const tomorrow = await backups.runDailyBackup({ now: now + DAY, dir, freeBytes: plenty, mountProblem: noDrive });
  assert.equal(tomorrow.ran && tomorrow.day, "2026-11-17", "the next day's backup is due at 03:00 the next day");
});

test("retention removes only the schedule's daily backups beyond the newest 14 and leaves 120 deploy copies untouched", async () => {
  const old = days(20);
  const dir = populated(old);
  const before = others(dir, old);
  assert.equal(Object.keys(before).filter((name) => name.startsWith("before-")).length, 120);
  mkdirSync(join(dir, "daily-2026-09-01.db"));
  symlinkSync(join(dir, "notes.txt"), join(dir, "daily-2026-09-02.db"));
  for (const day of ["2026-09-01", "2026-09-02"])
    sqlite.prepare("INSERT INTO backup_runs(day,file,status,attempts,started_at,updated_at) VALUES(?,?,'done',1,0,0)").run(day, dailyBackupName(day));
  const withOddOnes = others(dir, old);

  const result = await backups.runDailyBackup({ now: at("2026-11-16T03:05:00Z"), dir, freeBytes: plenty, mountProblem: noDrive });
  assert.equal(result.ran && result.status, "done");
  const kept = [...old.slice(-13), "2026-11-16"].map(dailyBackupName);
  assert.equal(kept.length, DAILY_BACKUPS_KEPT);
  assert.deepEqual(result.ran && [...result.removed].sort(), old.slice(0, 7).map(dailyBackupName), "the seven oldest of 21 go");
  for (const name of kept) assert.ok(existsSync(join(dir, name)), `${name} kept`);
  for (const name of old.slice(0, 7).map(dailyBackupName)) assert.ok(!existsSync(join(dir, name)), `${name} removed`);
  assert.deepEqual(others(dir, [...old, "2026-11-16"]), withOddOnes, "every other file is unchanged: deploy copies, other names, unrecorded daily names, a folder and a link");
  assert.ok(Object.keys(before).every((name) => name in withOddOnes));
});

test("a failed backup is recorded with its reason and removes nothing", async () => {
  const old = days(20);
  const dir = populated(old);
  const before = readdirSync(dir).sort();
  const result = await backups.runDailyBackup({
    now: at("2026-11-16T03:05:00Z"), dir, freeBytes: plenty, mountProblem: noDrive,
    backup: async () => { throw new Error("database disk image is malformed"); },
  });
  assert.deepEqual(result, { ran: true, day: "2026-11-16", status: "failed", error: "Backup failed: database disk image is malformed", removed: [] });
  assert.deepEqual(readdirSync(dir).sort(), before, "nothing removed, nothing added");
  const recorded = row("2026-11-16")!;
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "Backup failed: database disk image is malformed");

  // The real backup function failing (the source is not a database) is reported the same way.
  writeFileSync(join(temp, "junk.db"), "not a database");
  const junk = await backups.runDailyBackup({ now: at("2026-11-16T03:15:00Z"), dir, source: join(temp, "junk.db"), freeBytes: plenty, mountProblem: noDrive });
  assert.equal(junk.ran && junk.status, "failed");
  assert.match(junk.ran ? junk.error ?? "" : "", /^Backup failed: source is not a SQLite database/);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.equal(row("2026-11-16")!.attempts, 2, "a retry of the same day updates its row");
});

test("a run is refused, recorded as failed with the reason, when free space is below the limit", async () => {
  const old = days(20);
  const dir = populated(old);
  const before = readdirSync(dir).sort();
  const result = await backups.runDailyBackup({ now: at("2026-11-16T03:05:00Z"), dir, freeBytes: () => 300e6, mountProblem: noDrive });
  assert.equal(result.ran && result.status, "failed");
  assert.equal(result.ran && result.error, "Backup refused: only 300 MB free where backups are stored; a backup needs at least 1074 MB free.");
  assert.deepEqual(readdirSync(dir).sort(), before, "nothing removed, nothing added");
  assert.equal(row("2026-11-16")!.error, result.ran && result.error);
});

test("a run is refused when the backup folder is on the media drive and the drive check fails; no folder is created", async () => {
  const dir = join(temp, "missing-drive", "backups");
  const result = await backups.runDailyBackup({
    now: at("2026-11-16T03:05:00Z"), dir, freeBytes: plenty,
    mountProblem: () => "The media drive is not mounted at /mnt/usb. Refusing to store media on the system disk.",
  });
  assert.equal(result.ran && result.error,
    "Backup refused: the backup folder is on the media drive, and the drive check failed. The media drive is not mounted at /mnt/usb. Refusing to store media on the system disk.");
  assert.equal(existsSync(join(temp, "missing-drive")), false);
  assert.equal(row("2026-11-16")!.status, "failed");
});

test("REQUIRE_MEDIA_MOUNT applies to the backups only when they are inside the media root", () => {
  const root = join(temp, "media-root");
  mkdirSync(join(root, "data"), { recursive: true });
  const problem = () => "drive missing";
  assert.equal(backups.backupMountProblem(join(root, "data", "backups"), root, problem), "drive missing");
  assert.equal(backups.backupMountProblem(root, root, problem), "drive missing");
  assert.equal(backups.backupMountProblem(join(temp, "db", "backups"), root, problem), null, "the data folder on the system disk");
  assert.equal(backups.backupMountProblem(join(temp, "media-root-sibling", "backups"), root, problem), null, "a sibling with the same prefix");
  symlinkSync(join(root, "data"), join(temp, "linked-data"));
  assert.equal(backups.backupMountProblem(join(temp, "linked-data", "backups"), root, problem), "drive missing", "a symlink into the media root");
  assert.equal(backups.insideMediaRoot(join(temp, "db", "backups")), false, "the default media root of this test");
});

test("a backup that was running when the server stopped is failed at start, and the day is tried again", async () => {
  const dir = folder();
  sqlite.prepare("INSERT INTO backup_runs(day,file,status,attempts,started_at,updated_at) VALUES('2026-11-16','daily-2026-11-16.db','running',1,1,1)").run();
  backups.failInterruptedBackups(at("2026-11-16T04:00:00Z"));
  assert.equal(row("2026-11-16")!.status, "failed");
  assert.equal(row("2026-11-16")!.error, backups.INTERRUPTED);
  const retried = await backups.runDailyBackup({ now: at("2026-11-16T04:05:00Z"), dir, freeBytes: plenty, mountProblem: noDrive });
  assert.equal(retried.ran && retried.status, "done");
  assert.equal(row("2026-11-16")!.attempts, 2);
});

test("a daily file without a recorded run still counts as that day's backup", async () => {
  const dir = folder();
  writeFileSync(join(dir, "daily-2026-11-16.db"), "made before the database was restored");
  assert.equal(backups.lastSuccessDay(dir), "2026-11-16");
  assert.deepEqual(await backups.runDailyBackup({ now: at("2026-11-16T09:00:00Z"), dir, freeBytes: plenty, mountProblem: noDrive }), { ran: false, reason: "not-due" });
});

test("a source that fails PRAGMA integrity_check gives no daily backup: the run fails with the reason and removes nothing", async () => {
  // An index whose root page points at its table's page: readable, but integrity_check reports it.
  const source = join(temp, "corrupt.db");
  const db = new Database(source);
  db.exec("CREATE TABLE t(a INTEGER); CREATE INDEX t_a ON t(a);");
  const insert = db.prepare("INSERT INTO t(a) VALUES (?)");
  for (let index = 0; index < 50; index += 1) insert.run(index);
  const table = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 't'").get() as { rootpage: number }).rootpage;
  db.unsafeMode(true);
  db.pragma("writable_schema = ON");
  db.prepare("UPDATE sqlite_master SET rootpage = ? WHERE name = 't_a'").run(table);
  db.close();

  const old = days(20);
  const dir = populated(old);
  const before = readdirSync(dir).sort();
  const result = await backups.runDailyBackup({ now: at("2026-11-16T03:05:00Z"), dir, source, freeBytes: plenty, mountProblem: noDrive });
  assert.equal(result.ran && result.status, "failed");
  // verifyBackup reports either the rows integrity_check returned or the error the pragma raised.
  assert.match(result.ran ? result.error ?? "" : "", /^Backup failed: (backup failed PRAGMA integrity_check|cannot verify backup): /);
  assert.deepEqual(readdirSync(dir).sort(), before, "no daily backup appears and nothing is removed");
  assert.equal(row("2026-11-16")!.status, "failed");
});
