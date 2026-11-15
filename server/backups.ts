/**
 * Daily database backups (#361): once a day the server copies `sonder.db` to `<DATA_DIR>/backups/daily-<day>.db`
 * with the backup function `npm run backup` uses (online backup API, then PRAGMA integrity_check), and keeps the
 * newest 14 of them. The rules are in `server/backup-schedule.ts`; each run is a row of `backup_runs`, which the
 * Activity source (`server/backups-activity.ts`) reads.
 *
 * - Whether a backup is due is decided from the recorded successful runs only, never from the names in the folder.
 * - A run first claims its day in the database with one statement, so two servers sharing the database never run
 *   the same day's backup at once, and only the claim's holder records the result.
 * - Retention deletes a file only when a `done` row names it, it is a regular file directly in the folder, and its
 *   size and SHA-256 are still the ones recorded when the run published it. Only such files fill the 14 kept;
 *   a missing, replaced or non-regular entry is left alone and its row stops counting. The `before-*` copies of
 *   deploys and every other file are never touched, and a run that fails removes nothing.
 * - Every failure is recorded as a failed run with its reason; nothing escapes to the runner.
 *
 * The production root filesystem is read-only: this writes only under the data directory's `backups/` folder.
 */
import type { FastifyBaseLogger } from "fastify";
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, statfsSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { dataDir, sqlite } from "./db.ts";
import { mediaMountProblem, mediaRoot } from "./storage.ts";
import { backupDatabase } from "./db-backup.mjs";
import type { BackgroundProcess } from "./background-runner.ts";
import type { BackupRunStatus } from "./schema.ts";
import {
  BACKUP_CHECK_INTERVAL_MS, DAILY_BACKUPS_KEPT, STALE_CLAIM_MS,
  backupPlan, backupRefusal, dailyBackupName, expiredDailyBackups, isScheduleFileName, scheduledDay,
} from "./backup-schedule.ts";

export const backupsDir = join(dataDir, "backups");
const databaseFile = join(dataDir, "sonder.db");

export const INTERRUPTED = "The server stopped before this backup finished.";

/** A path with its existing part resolved through symlinks, so a symlinked data folder still counts as where it lives. */
function realLocation(path: string) {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing) && existing !== dirname(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

/** True when `dir` is the media root or inside it. */
export function insideMediaRoot(dir: string, root = mediaRoot) {
  const rel = relative(realLocation(root), realLocation(dir));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** `REQUIRE_MEDIA_MOUNT` applies to the backups only when they are on the media drive. */
export function backupMountProblem(dir: string, root = mediaRoot, check: () => string | null = mediaMountProblem) {
  return insideMediaRoot(dir, root) ? check() : null;
}

const freeBytesAt = (dir: string) => {
  const stats = statfsSync(dir);
  return stats.bavail * stats.bsize;
};

export type BackupRunOptions = {
  now?: number;
  dir?: string;
  source?: string;
  /** Tests: replace the free space of the backup folder's filesystem. */
  freeBytes?: (dir: string) => number;
  /** Tests: replace the media drive check. */
  mountProblem?: (dir: string) => string | null;
  /** Tests: replace the backup function. */
  backup?: typeof backupDatabase;
  log?: Pick<FastifyBaseLogger, "info" | "warn">;
};

export type BackupRunResult =
  /** Not due, or another run holds the day: nothing was written. */
  | { ran: false; reason: "not-due" | "claimed" }
  | { ran: true; day: string; status: Extract<BackupRunStatus, "done" | "failed">; error: string | null; removed: string[] };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type DoneRow = { day: string; file: string; bytes: number | null; sha256: string | null };

const doneDays = () => (sqlite.prepare("SELECT day FROM backup_runs WHERE status = 'done'").all() as { day: string }[]).map((row) => row.day);

/** Is a backup due at `now`? From the recorded successful runs only (`backupPlan`, the rule Activity shows too). */
export function backupIsDue(now = Date.now()) {
  return backupPlan(doneDays(), now).due;
}

/** Marks every run whose claim is older than the stale limit interrupted: its server stopped mid-run. */
export function failStaleBackups(now = Date.now()) {
  const stale = sqlite.prepare(
    "UPDATE backup_runs SET status = 'failed', error = ?, claim = NULL, finished_at = ?, updated_at = ? WHERE status = 'running' AND started_at <= ?",
  ).run(INTERRUPTED, now, now, now - STALE_CLAIM_MS);
  return stale.changes;
}

/**
 * Claims `day` for this run with one statement: a new row, or a failed one retried. A `done` row or a live
 * `running` claim (another server's run) is left as it is, and the statement changes nothing. True when claimed.
 */
function claimDay(day: string, claim: string, now: number) {
  const claimed = sqlite.prepare(
    `INSERT INTO backup_runs(day, file, status, bytes, error, attempts, started_at, finished_at, updated_at, sha256, claim, disowned_at)
     VALUES(?, ?, 'running', NULL, NULL, 1, ?, NULL, ?, NULL, ?, NULL)
     ON CONFLICT(day) DO UPDATE SET status = 'running', file = excluded.file, bytes = NULL, error = NULL,
       attempts = backup_runs.attempts + 1, started_at = excluded.started_at, finished_at = NULL,
       updated_at = excluded.updated_at, sha256 = NULL, claim = excluded.claim, disowned_at = NULL
     WHERE backup_runs.status = 'failed'`,
  ).run(day, dailyBackupName(day), now, now, claim);
  return claimed.changes === 1;
}

/** Records the result of the run holding `claim`. False when another run took the day over meanwhile. */
function finish(day: string, claim: string, result: { status: "done"; bytes: number; sha256: string } | { status: "failed"; error: string }, now: number) {
  const done = result.status === "done";
  const changed = sqlite.prepare(
    `UPDATE backup_runs SET status = ?, bytes = ?, sha256 = ?, error = ?, finished_at = ?, updated_at = ?, claim = NULL
     WHERE day = ? AND claim = ? AND status = 'running'`,
  ).run(result.status, done ? result.bytes : null, done ? result.sha256 : null, done ? null : result.error, now, now, day, claim);
  return changed.changes === 1;
}

/** A failure before the day was claimed: recorded the same way, but never over a `done` row or a live claim. */
function recordUnclaimedFailure(day: string, error: string, now: number) {
  sqlite.prepare(
    `INSERT INTO backup_runs(day, file, status, bytes, error, attempts, started_at, finished_at, updated_at)
     VALUES(?, ?, 'failed', NULL, ?, 1, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET error = excluded.error, attempts = backup_runs.attempts + 1,
       started_at = excluded.started_at, finished_at = excluded.finished_at, updated_at = excluded.updated_at
     WHERE backup_runs.status = 'failed'`,
  ).run(day, dailyBackupName(day), error, now, now, now);
}

type FileCheck =
  | { kind: "ours"; dev: number; ino: number }
  /** The entry at the recorded name is gone, is not a regular file, or holds other content. */
  | { kind: "not-ours"; why: string }
  /** It could not be read (permissions, an I/O error): neither deleted nor counted, and checked again next time. */
  | { kind: "unreadable"; error: unknown };

type Identity = { kind: "file"; bytes: number; sha256: string; dev: number; ino: number } | { kind: "missing" } | { kind: "not-regular" };

/**
 * Size, SHA-256 and inode of the regular file at `path`, without following a symlink (and without blocking on a
 * FIFO). With `expectedBytes`, a file of another size is reported without reading it.
 */
async function identify(path: string, expectedBytes?: number): Promise<Identity> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "not-regular" };
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "not-regular" };
    const known = { dev: stats.dev, ino: stats.ino, bytes: stats.size };
    if (expectedBytes !== undefined && stats.size !== expectedBytes) return { kind: "file", ...known, sha256: "" };
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1 << 20);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    return { kind: "file", ...known, bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/** Is the entry a `done` row names still the file that run published? */
async function checkRecordedFile(dir: string, row: DoneRow): Promise<FileCheck> {
  try {
    const found = await identify(join(dir, row.file), row.bytes!);
    if (found.kind === "missing") return { kind: "not-ours", why: "missing" };
    if (found.kind === "not-regular") return { kind: "not-ours", why: "not a regular file" };
    if (found.bytes !== row.bytes || found.sha256 !== row.sha256) return { kind: "not-ours", why: "other content" };
    return { kind: "ours", dev: found.dev, ino: found.ino };
  } catch (error) {
    return { kind: "unreadable", error };
  }
}

/**
 * Retention: keeps the newest 14 of the schedule's own backups and deletes the older ones. A row counts only
 * when its name is the schedule's name for its day and the file there still has the recorded size and SHA-256;
 * a row written before identities were recorded never counts and its file is never deleted. A row whose file is
 * gone or replaced is marked disowned, and its file (if any) is left alone.
 */
export async function pruneDailyBackups(dir = backupsDir, keep = DAILY_BACKUPS_KEPT, log?: BackupRunOptions["log"], now = Date.now()) {
  const rows = sqlite.prepare(
    "SELECT day, file, bytes, sha256 FROM backup_runs WHERE status = 'done' AND disowned_at IS NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL",
  ).all() as DoneRow[];
  const ours = new Map<string, { dev: number; ino: number }>();
  for (const row of rows) {
    if (!isScheduleFileName(row.day, row.file)) continue;
    const check = await checkRecordedFile(dir, row);
    if (check.kind === "ours") ours.set(row.file, check);
    else if (check.kind === "not-ours") {
      sqlite.prepare("UPDATE backup_runs SET disowned_at = ? WHERE day = ? AND status = 'done' AND disowned_at IS NULL").run(now, row.day);
      log?.warn({ file: row.file, why: check.why }, "A daily backup is no longer the file the schedule made; retention leaves it alone");
    } else log?.warn({ error: check.error, file: row.file }, "Could not check a daily backup; retention leaves it alone");
  }
  const names = [...ours.keys()];
  const removed: string[] = [];
  for (const name of expiredDailyBackups(names, new Set(names), keep)) {
    const path = join(dir, name);
    try {
      // Still the inode that was checked: not swapped since.
      const stats = lstatSync(path);
      const checked = ours.get(name)!;
      if (!stats.isFile() || stats.dev !== checked.dev || stats.ino !== checked.ino) {
        log?.warn({ file: name }, "A daily backup changed while retention checked it; it is left alone");
        continue;
      }
      unlinkSync(path);
      removed.push(name);
    } catch (error) {
      log?.warn({ error, file: name }, "Could not remove an old daily backup");
    }
  }
  return removed;
}

/** One check of the schedule: makes the due backup, records the run, then applies retention after a success only. */
export async function runDailyBackup(options: BackupRunOptions = {}): Promise<BackupRunResult> {
  const now = options.now ?? Date.now();
  const dir = options.dir ?? backupsDir;
  const log = options.log;
  const day = scheduledDay(now);
  const failed = (error: string) => {
    log?.warn({ day, error }, "Daily database backup failed");
    return { ran: true as const, day, status: "failed" as const, error, removed: [] };
  };

  // Deciding and claiming read and write the database; a failure there is recorded too, where it can be.
  const claim = randomUUID();
  try {
    failStaleBackups(now);
    if (!backupIsDue(now)) return { ran: false, reason: "not-due" };
    if (!claimDay(day, claim, now)) return { ran: false, reason: "claimed" };
  } catch (error) {
    const reason = `Backup failed: ${message(error)}`;
    try {
      recordUnclaimedFailure(day, reason, now);
    } catch (recordError) {
      log?.warn({ day, error: recordError }, "Could not record a failed daily database backup");
    }
    return failed(reason);
  }

  const record = (result: Parameters<typeof finish>[2]) => {
    try {
      const recorded = finish(day, claim, result, Date.now());
      if (!recorded) log?.warn({ day }, "Another run took over this day's backup; its result is not recorded");
      return recorded;
    } catch (error) {
      log?.warn({ day, error }, "Could not record the daily database backup's result");
      return false;
    }
  };

  let bytes: number;
  let sha256: string;
  try {
    // The drive check comes before anything is written: a missing media drive must not get a folder on the system disk.
    let refusal: string | null;
    try {
      const mountProblem = (options.mountProblem ?? ((target: string) => backupMountProblem(target)))(dir);
      if (!mountProblem) mkdirSync(dir, { recursive: true, mode: 0o700 });
      refusal = backupRefusal({ mountProblem, freeBytes: mountProblem ? 0 : (options.freeBytes ?? freeBytesAt)(dir) });
    } catch (error) {
      refusal = `Backup refused: the backup folder ${dir} cannot be used. ${message(error)}`;
    }
    if (refusal) {
      record({ status: "failed", error: refusal });
      return failed(refusal);
    }

    const destination = join(dir, dailyBackupName(day));
    ({ bytes } = await (options.backup ?? backupDatabase)(options.source ?? databaseFile, destination));
    // What retention later checks before it deletes this file: its size and content as published.
    const published = await identify(destination);
    if (published.kind !== "file" || published.bytes !== bytes)
      throw new Error(`the published backup ${destination} could not be read back`);
    sha256 = published.sha256;
  } catch (error) {
    const reason = `Backup failed: ${message(error)}`;
    record({ status: "failed", error: reason });
    return failed(reason);
  }
  if (!record({ status: "done", bytes, sha256 })) return { ran: true, day, status: "done", error: null, removed: [] };

  let removed: string[] = [];
  try {
    removed = await pruneDailyBackups(dir, DAILY_BACKUPS_KEPT, log, now);
  } catch (error) {
    // The backup itself is made and recorded; retention tries again after the next one and removes nothing now.
    log?.warn({ day, error }, "Retention of the daily backups failed; nothing was removed");
  }
  log?.info({ day, bytes, removed }, "Daily database backup made");
  return { ran: true, day, status: "done", error: null, removed };
}

/** The daily backup loop (ADR 0010): checks every 10 minutes whether today's backup is due. */
export const databaseBackupLoop = (log?: BackupRunOptions["log"]): BackgroundProcess => ({
  id: "backups",
  intervalMs: BACKUP_CHECK_INTERVAL_MS,
  pausedBy: "backups",
  // Only a claim past the stale limit is a run whose server stopped; a younger one may be another server's live run.
  start: () => void failStaleBackups(),
  tick: () => runDailyBackup({ log }),
});
