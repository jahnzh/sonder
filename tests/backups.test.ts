/**
 * Daily database backups (#361): a run makes a verified copy in a temporary backups folder, records it, and
 * retention removes only the daily backups the schedule made beyond the newest 14. Everything (database, folders,
 * the `before-*` deploy copies) is built in a temporary directory here.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const { backupSource } = await import("../server/backups-activity.ts");
const { ChangeTracker, buildActivity } = await import("../server/activity.ts");

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
const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
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
    const content = `daily ${day}`;
    writeFileSync(join(dir, dailyBackupName(day)), content);
    sqlite.prepare("INSERT INTO backup_runs(day,file,status,bytes,error,attempts,started_at,finished_at,updated_at,sha256) VALUES(?,?,'done',?,NULL,1,?,?,?,?)")
      .run(day, dailyBackupName(day), Buffer.byteLength(content), at(`${day}T03:00:00Z`), at(`${day}T03:01:00Z`), at(`${day}T03:01:00Z`), sha256(content));
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
  { status: string; bytes: number | null; error: string | null; attempts: number; file: string; sha256?: string | null; disowned_at?: number | null } | undefined;
const run = (dir: string, iso: string, extra: Parameters<typeof backups.runDailyBackup>[0] = {}) =>
  backups.runDailyBackup({ now: at(iso), dir, freeBytes: plenty, mountProblem: noDrive, ...extra });

/** The backups process row and the latest run's item, as the Activity page shows them for the real `backup_runs`. */
function activity(now: number) {
  const built = buildActivity({
    now, multiplier: 1, tracker: new ChangeTracker(), pause: {},
    snapshots: [{ source: backupSource, rows: backupSource.load(sqlite), probe: { value: null, failure: null } }],
  });
  return { reason: built.processes.find((entry) => entry.id === "backups")!.reason, item: built.items[0] };
}

/**
 * A copy of the recorded run of `from` for `day`: the same file content under the day's name and the same row.
 * The row is copied column for column, so this builds the same state on every revision of the table.
 */
function cloneRun(dir: string, from: string, day: string) {
  copyFileSync(join(dir, dailyBackupName(from)), join(dir, dailyBackupName(day)));
  sqlite.exec("DROP TABLE IF EXISTS temp.cloned");
  sqlite.prepare("CREATE TEMP TABLE cloned AS SELECT * FROM backup_runs WHERE day = ?").run(from);
  sqlite.prepare("UPDATE temp.cloned SET day = ?, file = ?").run(day, dailyBackupName(day));
  sqlite.exec("INSERT INTO backup_runs SELECT * FROM temp.cloned; DROP TABLE temp.cloned");
}

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
  assert.equal(recorded.sha256, sha256(readFileSync(path)), "the run records the SHA-256 of the file it published");
  assert.equal(backups.backupIsDue(now + 3_600_000), false);

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

test("a claim older than 30 minutes is a stopped run: it is marked interrupted and the day is tried again; a younger one is left alone", async () => {
  const dir = folder();
  const insertRunning = (startedAt: number) => sqlite.prepare(
    "INSERT INTO backup_runs(day,file,status,attempts,started_at,updated_at,claim) VALUES('2026-11-16','daily-2026-11-16.db','running',1,?,?,'other-server')",
  ).run(startedAt, startedAt);

  insertRunning(at("2026-11-16T03:50:00Z"));
  backups.failStaleBackups(at("2026-11-16T04:00:00Z"));
  assert.equal(row("2026-11-16")!.status, "running", "a ten-minute-old claim may be another server's live run");
  assert.deepEqual(await run(dir, "2026-11-16T04:05:00Z"), { ran: false, reason: "claimed" });
  assert.deepEqual(readdirSync(dir), [], "the live claim's day is not backed up twice");

  sqlite.exec("DELETE FROM backup_runs");
  insertRunning(at("2026-11-16T03:00:00Z"));
  backups.failStaleBackups(at("2026-11-16T03:31:00Z"));
  assert.equal(row("2026-11-16")!.status, "failed");
  assert.equal(row("2026-11-16")!.error, backups.INTERRUPTED);
  const retried = await run(dir, "2026-11-16T03:35:00Z");
  assert.equal(retried.ran && retried.status, "done");
  assert.equal(row("2026-11-16")!.attempts, 2);

  // A stale claim found by a check (no restart) is taken over the same way.
  sqlite.exec("DELETE FROM backup_runs");
  rmSync(join(dir, "daily-2026-11-16.db"));
  insertRunning(at("2026-11-16T03:00:00Z"));
  const takeover = await run(dir, "2026-11-16T03:40:00Z");
  assert.equal(takeover.ran && takeover.status, "done");
  assert.equal(row("2026-11-16")!.attempts, 2, "the interrupted attempt and the one that took over");
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

// Review round 1 of #361: each test below fails on 253e1de.

test("retention never deletes a file put at a recorded name, even of the same size, and it does not fill a kept slot", async () => {
  const dir = folder();
  const fourteen = days(14, "2026-10-01");
  for (const day of fourteen) assert.equal((await run(dir, `${day}T03:05:00Z`)).ran, true);
  assert.equal(readdirSync(dir).length, 14);
  // The person removes the oldest backup and puts a file of their own, of the same size, at its name.
  const first = join(dir, dailyBackupName(fourteen[0]));
  const theirs = Buffer.alloc(statSync(first).size, 0x41);
  unlinkSync(first);
  writeFileSync(first, theirs);

  const fifteenth = await run(dir, "2026-10-15T03:05:00Z");
  assert.equal(fifteenth.ran && fifteenth.status, "done");
  assert.deepEqual(fifteenth.ran && fifteenth.removed, [], "fourteen of the schedule's own backups remain: nothing goes");
  assert.deepEqual(readFileSync(first), theirs, "the replacement file is untouched");
  assert.ok(row(fourteen[0])!.disowned_at, "its row no longer counts as the schedule's");

  const sixteenth = await run(dir, "2026-10-16T03:05:00Z");
  assert.deepEqual(sixteenth.ran && sixteenth.removed, [dailyBackupName(fourteen[1])], "the oldest real backup goes, not the replacement");
  assert.deepEqual(readFileSync(first), theirs);
  assert.equal(readdirSync(dir).filter((name) => name !== dailyBackupName(fourteen[0])).length, 14);
});

test("a stray daily-2099-01-01.db folder or file does not stop the backups; it is left alone", async () => {
  const dir = folder();
  mkdirSync(join(dir, "daily-2099-01-01.db"));
  writeFileSync(join(dir, "daily-2098-01-01.db"), "not a backup");
  const result = await run(dir, "2026-11-16T03:05:00Z");
  assert.equal(result.ran && result.status, "done", "only recorded runs decide whether a backup is due");
  assert.ok(existsSync(join(dir, "daily-2026-11-16.db")));
  assert.ok(statSync(join(dir, "daily-2099-01-01.db")).isDirectory());
  assert.equal(readFileSync(join(dir, "daily-2098-01-01.db"), "utf8"), "not a backup");
});

test("a done row from a clock that ran ahead does not hold back today's backup, and Activity says the same", async () => {
  const dir = folder();
  const ahead = await run(dir, "2099-01-01T04:00:00Z");
  assert.equal(ahead.ran && ahead.status, "done");
  const now = at("2026-11-16T09:00:00Z");
  assert.match(activity(now).reason ?? "", /Next run within 10 minutes$/, "Activity: today's backup is due");
  const today = await run(dir, "2026-11-16T09:00:00Z");
  assert.equal(today.ran && today.status, "done", "the scheduler: today's backup is made");
  assert.match(activity(now + 60_000).reason ?? "", /Next run 17 Nov 03:00 UTC$/);
  assert.deepEqual(await run(dir, "2026-11-16T09:10:00Z"), { ran: false, reason: "not-due" });
});

test("after a restore that lost today's run, Activity and the scheduler agree: the run is due, and fails visibly over the old file", async () => {
  const dir = folder();
  writeFileSync(join(dir, "daily-2026-11-16.db"), "published before the database was restored");
  const now = at("2026-11-16T09:00:00Z");
  assert.match(activity(now).reason ?? "", /^No backup yet · Next run within 10 minutes$/);
  const result = await run(dir, "2026-11-16T09:00:00Z");
  assert.equal(result.ran && result.status, "failed", "due, as Activity said");
  assert.match(result.ran ? result.error ?? "" : "", /^Backup failed: destination already exists: /);
  assert.equal(readFileSync(join(dir, "daily-2026-11-16.db"), "utf8"), "published before the database was restored", "the old file is not replaced");
  assert.equal(activity(now + 60_000).item.state, "failed");
  assert.match(activity(now + 60_000).item.error ?? "", /destination already exists/);
});

test("two runs started together back up the day once; the second does nothing and writes nothing", async () => {
  const dir = folder();
  const results = await Promise.all([run(dir, "2026-11-16T03:05:00Z"), run(dir, "2026-11-16T03:05:00Z")]);
  assert.deepEqual(results.map((result) => (result.ran ? result.status : result.reason)).sort(), ["claimed", "done"]);
  assert.equal(row("2026-11-16")!.status, "done");
  assert.equal(row("2026-11-16")!.attempts, 1);
  assert.deepEqual(readdirSync(dir), ["daily-2026-11-16.db"]);
});

test("a second server process neither runs nor interrupts the first one's backup, and never overwrites its done row", { timeout: 30_000 }, async () => {
  const dir = folder();
  const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const script = `
    const backups = await import(${JSON.stringify(join(repo, "server", "backups.ts"))});
    const { backupDatabase } = await import(${JSON.stringify(join(repo, "server", "db-backup.mjs"))});
    const result = await backups.runDailyBackup({
      now: ${at("2026-11-16T03:05:00Z")}, dir: ${JSON.stringify(dir)}, freeBytes: () => ${10 * MIN_FREE_BYTES}, mountProblem: () => null,
      backup: async (source, destination) => { await new Promise((done) => setTimeout(done, 1500)); return backupDatabase(source, destination); },
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: repo, env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((done) => child.on("close", done));
  const deadline = Date.now() + 20_000;
  while (row("2026-11-16")?.status !== "running") {
    assert.ok(Date.now() < deadline, `the other server never started its run: ${stderr}`);
    await new Promise((done) => setTimeout(done, 25));
  }

  backups.databaseBackupLoop().start?.();
  assert.equal(row("2026-11-16")!.status, "running", "starting this server leaves the other server's live run alone");
  assert.deepEqual(await run(dir, "2026-11-16T03:06:00Z"), { ran: false, reason: "claimed" });
  assert.equal(row("2026-11-16")!.status, "running");

  assert.equal(await exited, 0, stderr);
  assert.equal(JSON.parse(stdout).status, "done", stdout);
  assert.equal(row("2026-11-16")!.status, "done");
  assert.equal(row("2026-11-16")!.attempts, 1);
  assert.deepEqual(readdirSync(dir), ["daily-2026-11-16.db"]);
});

test("a backups path that is a file or an unreadable folder is a failed run with its reason on Activity, not an escaped error", async () => {
  const file = join(temp, "backups-is-a-file");
  writeFileSync(file, "a file where the folder should be");
  const result = await run(file, "2026-11-16T03:05:00Z");
  assert.equal(result.ran && result.status, "failed");
  assert.ok((result.ran ? result.error ?? "" : "").startsWith(`Backup refused: the backup folder ${file} cannot be used. `), result.ran ? result.error ?? "" : "");
  assert.equal(row("2026-11-16")!.status, "failed");
  const shown = activity(at("2026-11-16T03:06:00Z"));
  assert.equal(shown.item.state, "failed");
  assert.equal(shown.item.error, result.ran && result.error);
  assert.equal(readFileSync(file, "utf8"), "a file where the folder should be");

  if (process.getuid?.() === 0) return; // root reads any folder
  const locked = folder();
  chmodSync(locked, 0o000);
  try {
    const denied = await run(locked, "2026-11-16T03:15:00Z");
    assert.equal(denied.ran && denied.status, "failed");
    assert.match(denied.ran ? denied.error ?? "" : "", /^Backup failed: .*(EACCES|permission denied)/i);
    assert.equal(row("2026-11-16")!.error, denied.ran && denied.error);
    assert.equal(row("2026-11-16")!.attempts, 2);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("recorded names replaced by symlinks or folders do not fill the 14 kept: no older real backup is deleted", async () => {
  const dir = folder();
  assert.equal((await run(dir, "2026-09-01T03:05:00Z")).ran, true);
  const later = days(19, "2026-10-01");
  for (const day of later) cloneRun(dir, "2026-09-01", day);
  // The newest recorded names stop being regular files: fourteen links to a real backup (same content), and folders.
  const replaced = later.slice(2);
  for (const [index, day] of replaced.entries()) {
    const path = join(dir, dailyBackupName(day));
    rmSync(path);
    if (index < 14) symlinkSync(join(dir, dailyBackupName(later[0])), path);
    else mkdirSync(path);
  }
  const removed = await backups.pruneDailyBackups(dir);
  assert.deepEqual(removed, [], "three real backups remain, fewer than 14: none goes");
  for (const day of ["2026-09-01", later[0], later[1]]) assert.ok(statSync(join(dir, dailyBackupName(day))).isFile(), `${day} kept`);
  for (const day of replaced) assert.ok(existsSync(join(dir, dailyBackupName(day))), `${day}: the link or folder is left alone`);
});

test("a run whose stale claim was taken over records nothing afterwards: the new holder's done row stays", async () => {
  const dir = folder();
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  let started!: () => void;
  const inBackup = new Promise<void>((done) => (started = done));
  const slow = run(dir, "2026-11-16T03:05:00Z", {
    backup: async (source, destination) => {
      started();
      await held;
      const { backupDatabase } = await import("../server/db-backup.mjs");
      return backupDatabase(source, destination);
    },
  });
  await inBackup;
  const takeover = await run(dir, "2026-11-16T03:40:00Z");
  assert.equal(takeover.ran && takeover.status, "done", "35 minutes later the claim is stale and taken over");
  release();
  const late = await slow;
  assert.equal(late.ran && late.status, "failed", "the old run finds the day's file published");
  assert.equal(row("2026-11-16")!.status, "done", "and does not overwrite the new holder's result");
  assert.equal(row("2026-11-16")!.error, null);
  assert.equal(row("2026-11-16")!.attempts, 2);
});
