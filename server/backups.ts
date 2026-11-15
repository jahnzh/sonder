/**
 * Daily database backups (#361): once a day the server copies `sonder.db` to `<DATA_DIR>/backups/daily-<day>.db`
 * with the backup function `npm run backup` uses (online backup API, then PRAGMA integrity_check), and keeps the
 * newest 14 of them. The rules are in `server/backup-schedule.ts`; each run is a row of `backup_runs`, which the
 * Activity source (`server/backups-activity.ts`) reads.
 *
 * Retention removes only `daily-<day>.db` files that this schedule recorded as made by itself. The `before-*`
 * copies of deploys and every other file in the folder are never touched, and a run that fails removes nothing.
 * The production root filesystem is read-only: this writes only under the data directory's `backups/` folder.
 */
import type { FastifyBaseLogger } from "fastify";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statfsSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { dataDir, sqlite } from "./db.ts";
import { mediaMountProblem, mediaRoot } from "./storage.ts";
import { backupDatabase } from "./db-backup.mjs";
import type { BackgroundProcess } from "./background-runner.ts";
import type { BackupRunStatus } from "./schema.ts";
import {
  BACKUP_CHECK_INTERVAL_MS, DAILY_BACKUPS_KEPT,
  backupDue, backupRefusal, dailyBackupDay, dailyBackupName, expiredDailyBackups, scheduledDay,
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
  | { ran: false; reason: "not-due" }
  | { ran: true; day: string; status: Extract<BackupRunStatus, "done" | "failed">; error: string | null; removed: string[] };

type RunRow = { day: string; file: string; status: string };

const doneRows = () => sqlite.prepare("SELECT day, file, status FROM backup_runs WHERE status = 'done'").all() as RunRow[];

function listFolder(dir: string) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * The day of the newest successful daily backup: the newest recorded run, or the newest daily file in the folder
 * (a file is published only after its integrity check, so one whose run row is missing still counts).
 */
export function lastSuccessDay(dir = backupsDir) {
  const days = [
    ...doneRows().map((row) => row.day),
    ...listFolder(dir).map(dailyBackupDay).filter((day): day is string => day !== null),
  ];
  return days.length ? days.reduce((newest, day) => (day > newest ? day : newest)) : null;
}

function begin(day: string, status: BackupRunStatus, error: string | null, now: number) {
  sqlite.prepare(
    `INSERT INTO backup_runs(day, file, status, bytes, error, attempts, started_at, finished_at, updated_at)
     VALUES(?, ?, ?, NULL, ?, 1, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET status = excluded.status, bytes = NULL, error = excluded.error,
       attempts = backup_runs.attempts + 1, started_at = excluded.started_at, finished_at = excluded.finished_at,
       updated_at = excluded.updated_at`,
  ).run(day, dailyBackupName(day), status, error, now, status === "running" ? null : now, now);
}

function finish(day: string, status: Extract<BackupRunStatus, "done" | "failed">, bytes: number | null, error: string | null, now: number) {
  sqlite.prepare("UPDATE backup_runs SET status = ?, bytes = ?, error = ?, finished_at = ?, updated_at = ? WHERE day = ?")
    .run(status, bytes, error, now, now, day);
}

/** Retention: removes the expired daily backups the schedule made, beyond the newest 14. Only regular files. */
export function pruneDailyBackups(dir = backupsDir, keep = DAILY_BACKUPS_KEPT, log?: BackupRunOptions["log"]) {
  const made = new Set(doneRows().map((row) => row.file));
  const removed: string[] = [];
  for (const name of expiredDailyBackups(listFolder(dir), made, keep)) {
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isFile()) continue;
      unlinkSync(path);
      removed.push(name);
    } catch (error) {
      log?.warn({ error, file: name }, "Could not remove an old daily backup");
    }
  }
  return removed;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One check of the schedule: makes the due backup, records the run, then applies retention after a success only. */
export async function runDailyBackup(options: BackupRunOptions = {}): Promise<BackupRunResult> {
  const now = options.now ?? Date.now();
  const dir = options.dir ?? backupsDir;
  const log = options.log;
  if (!backupDue(lastSuccessDay(dir), now)) return { ran: false, reason: "not-due" };
  const day = scheduledDay(now);
  const fail = (error: string) => {
    log?.warn({ day, error }, "Daily database backup failed");
    return { ran: true as const, day, status: "failed" as const, error, removed: [] };
  };

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
    begin(day, "failed", refusal, now);
    return fail(refusal);
  }

  begin(day, "running", null, now);
  let bytes: number;
  try {
    ({ bytes } = await (options.backup ?? backupDatabase)(options.source ?? databaseFile, join(dir, dailyBackupName(day))));
  } catch (error) {
    const reason = `Backup failed: ${message(error)}`;
    finish(day, "failed", null, reason, Date.now());
    return fail(reason);
  }
  finish(day, "done", bytes, null, Date.now());
  const removed = pruneDailyBackups(dir, DAILY_BACKUPS_KEPT, log);
  log?.info({ day, bytes, removed }, "Daily database backup made");
  return { ran: true, day, status: "done", error: null, removed };
}

/** A run that was going when the server stopped did not finish: it is failed, and nothing was removed for it. */
export function failInterruptedBackups(now = Date.now()) {
  sqlite.prepare("UPDATE backup_runs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE status = 'running'")
    .run(INTERRUPTED, now, now);
}

/** The daily backup loop (ADR 0010): checks every 10 minutes whether today's backup is due. */
export const databaseBackupLoop = (log?: BackupRunOptions["log"]): BackgroundProcess => ({
  id: "backups",
  intervalMs: BACKUP_CHECK_INTERVAL_MS,
  pausedBy: "backups",
  start: () => failInterruptedBackups(),
  tick: () => runDailyBackup({ log }),
});
