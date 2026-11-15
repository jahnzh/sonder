/**
 * Daily database backups (#361): once a day the server copies `sonder.db` to `<DATA_DIR>/backups/daily-<day>.db`
 * with the backup function `npm run backup` uses (online backup API, then PRAGMA integrity_check), and keeps the
 * newest 14 of them. The rules are in `server/backup-schedule.ts`; each run is a row of `backup_runs`, which the
 * Activity source (`server/backups-activity.ts`) reads.
 *
 * - Whether a backup is due is decided from the recorded successful runs only, never from the names in the folder.
 * - A run first claims its day in the database with one statement, so two servers sharing the database never run
 *   the same day's backup at once, and only the claim's holder records the result. The run renews its claim at each
 *   stage and every minute; only a claim not renewed for 30 minutes (a stopped or hung server) is taken over.
 * - The size and SHA-256 of the verified copy are stored in the claimed row before the copy is published. A later
 *   attempt of the same day that finds that file at the day's name adopts it instead of failing over it; any other
 *   file there is a failure, and is never deleted or overwritten.
 * - Retention deletes a file only when a `done` row names it, it is a regular file directly in the folder, and its
 *   size and SHA-256 are still the ones recorded when the run published it: each file is checked and deleted in one
 *   step (`checkRecordedFile`), one at a time. Only such files fill the 14 kept; a missing, replaced or non-regular
 *   entry is left alone and its row stops counting. The `before-*` copies of deploys and every other file are never
 *   touched, and a run that fails removes nothing.
 * - Every failure is recorded with its reason: a failed run, or a successful run whose retention failed (which then
 *   deleted nothing further). Nothing escapes to the runner.
 *
 * The production root filesystem is read-only: this writes only under the data directory's `backups/` folder.
 */
import type { FastifyBaseLogger } from "fastify";
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, statfsSync, unlinkSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { dataDir, sqlite } from "./db.ts";
import { mediaMountProblem, mediaRoot } from "./storage.ts";
import { BackupError, backupDatabase } from "./db-backup.mjs";
import type { BackgroundProcess } from "./background-runner.ts";
import type { BackupRunStatus } from "./schema.ts";
import {
  BACKUP_CHECK_INTERVAL_MS, CLAIM_RENEW_MS, DAILY_BACKUPS_KEPT, STALE_CLAIM_MS,
  backupPlan, backupRefusal, dailyBackupName, isScheduleFileName, scheduledDay,
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
  /** Tests: the clock the run records and renews its claim with (default: `now` plus the time since the run started). */
  clock?: () => number;
  /** Tests: how often a working run renews its claim (default `CLAIM_RENEW_MS`). */
  renewEveryMs?: number;
  log?: Pick<FastifyBaseLogger, "info" | "warn">;
};

export type BackupRunResult =
  /** Not due, or another run holds the day: nothing was written. */
  | { ran: false; reason: "not-due" | "claimed" }
  /** Made (or adopted) and recorded; `cleanupError` says why retention stopped, when it did. */
  | { ran: true; day: string; status: Extract<BackupRunStatus, "done">; error: null; removed: string[]; cleanupError: string | null }
  | { ran: true; day: string; status: Extract<BackupRunStatus, "failed">; error: string; removed: string[] };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type DoneRow = { day: string; file: string; bytes: number; sha256: string };
type Identity = { bytes: number; sha256: string };

const doneDays = () => (sqlite.prepare("SELECT day FROM backup_runs WHERE status = 'done'").all() as { day: string }[]).map((row) => row.day);

/** Is a backup due at `now`? From the recorded successful runs only (`backupPlan`, the rule Activity shows too). */
export function backupIsDue(now = Date.now()) {
  return backupPlan(doneDays(), now).due;
}

/** Marks every run whose claim was not renewed for the stale limit interrupted: its server stopped or hung mid-run. */
export function failStaleBackups(now = Date.now()) {
  const stale = sqlite.prepare(
    "UPDATE backup_runs SET status = 'failed', error = ?, claim = NULL, finished_at = ?, updated_at = ? WHERE status = 'running' AND updated_at <= ?",
  ).run(INTERRUPTED, now, now, now - STALE_CLAIM_MS);
  return stale.changes;
}

/**
 * Claims `day` for this run with one statement: a new row, or a failed one retried. A `done` row or a live
 * `running` claim (another server's run) is left as it is, and the statement changes nothing. True when claimed.
 * A retried row keeps the size and SHA-256 an earlier attempt stored before it published, so this run can tell
 * that attempt's file at the day's name from anyone else's (`existingDestination`).
 */
function claimDay(day: string, claim: string, now: number) {
  const claimed = sqlite.prepare(
    `INSERT INTO backup_runs(day, file, status, bytes, error, attempts, started_at, finished_at, updated_at, sha256, claim, disowned_at, cleanup, cleanup_error)
     VALUES(?, ?, 'running', NULL, NULL, 1, ?, NULL, ?, NULL, ?, NULL, NULL, NULL)
     ON CONFLICT(day) DO UPDATE SET status = 'running', file = excluded.file, error = NULL,
       attempts = backup_runs.attempts + 1, started_at = excluded.started_at, finished_at = NULL,
       updated_at = excluded.updated_at, claim = excluded.claim, disowned_at = NULL, cleanup = NULL, cleanup_error = NULL
     WHERE backup_runs.status = 'failed'`,
  ).run(day, dailyBackupName(day), now, now, claim);
  return claimed.changes === 1;
}

/** Renews the claim of the run holding `claim`. False when another run took the day over meanwhile. */
function renewClaim(day: string, claim: string, now: number) {
  return sqlite.prepare("UPDATE backup_runs SET updated_at = ? WHERE day = ? AND claim = ? AND status = 'running'").run(now, day, claim).changes === 1;
}

/** Stores the identity of the verified copy before it is published (and renews the claim). False when the day was taken over. */
function storeIdentity(day: string, claim: string, identity: Identity, now: number) {
  return sqlite.prepare("UPDATE backup_runs SET bytes = ?, sha256 = ?, updated_at = ? WHERE day = ? AND claim = ? AND status = 'running'")
    .run(identity.bytes, identity.sha256, now, day, claim).changes === 1;
}

/**
 * Records the result of the run holding `claim`. False when another run took the day over meanwhile. A failed
 * run keeps the identity it stored before publishing: the next attempt adopts the file if it was published.
 */
function finish(day: string, claim: string, result: ({ status: "done" } & Identity) | { status: "failed"; error: string }, now: number) {
  const changed = result.status === "done"
    ? sqlite.prepare(
      `UPDATE backup_runs SET status = 'done', bytes = ?, sha256 = ?, error = NULL, finished_at = ?, updated_at = ?, claim = NULL
       WHERE day = ? AND claim = ? AND status = 'running'`,
    ).run(result.bytes, result.sha256, now, now, day, claim)
    : sqlite.prepare(
      `UPDATE backup_runs SET status = 'failed', error = ?, finished_at = ?, updated_at = ?, claim = NULL
       WHERE day = ? AND claim = ? AND status = 'running'`,
    ).run(result.error, now, now, day, claim);
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

/** The result of the retention after a successful run, shown with that run on the Activity page. */
function recordCleanup(day: string, cleanup: Cleanup) {
  sqlite.prepare("UPDATE backup_runs SET cleanup = ?, cleanup_error = ? WHERE day = ? AND status = 'done'")
    .run(cleanup.error ? "failed" : "done", cleanup.error, day);
}

/**
 * SHA-256 of the open file, read through the descriptor in 1 MiB chunks. Each chunk is an awaited read, so the
 * event loop runs between chunks; hashing one chunk takes a few milliseconds (a 25 MB backup is 25 chunks).
 */
async function sha256Of(handle: FileHandle) {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(1 << 20);
  for (let position = 0; ;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) return hash.digest("hex");
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
}

/** Opens `path` for reading without following a symlink (and without blocking on a FIFO). */
const openNoFollow = (path: string) => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

/** The size and SHA-256 of the regular file at `path`; a symlink, folder or other entry is `not-regular`. Other errors throw. */
export async function fileIdentity(path: string): Promise<{ kind: "file"; identity: Identity } | { kind: "missing" } | { kind: "not-regular" }> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "not-regular" };
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "not-regular" };
    return { kind: "file", identity: { bytes: stats.size, sha256: await sha256Of(handle) } };
  } finally {
    await handle.close();
  }
}

/**
 * What is at the day's name before this run backs up: nothing (null); the file an earlier attempt of this day
 * published (its regular file has the size and SHA-256 that attempt stored before publishing, and the attempt then
 * failed before it recorded its result), which this run adopts; or `theirs`, which is never deleted or overwritten.
 */
async function existingDestination(day: string, claim: string, destination: string): Promise<Identity | "theirs" | null> {
  if (!lstatSync(destination, { throwIfNoEntry: false })) return null;
  const stored = sqlite.prepare("SELECT bytes, sha256 FROM backup_runs WHERE day = ? AND claim = ?").get(day, claim) as
    { bytes: number | null; sha256: string | null } | undefined;
  if (stored?.bytes == null || stored.sha256 == null) return "theirs";
  const found = await fileIdentity(destination);
  if (found.kind !== "file" || found.identity.bytes !== stored.bytes || found.identity.sha256 !== stored.sha256) return "theirs";
  return found.identity;
}

type FileCheck =
  | { kind: "kept" }
  | { kind: "removed" }
  /** The entry at the recorded name is gone, is not a regular file, or holds other content: it is left alone. */
  | { kind: "not-ours"; why: string }
  /** It could not be checked or removed (permissions, an I/O error): it is left alone, and retention stops. */
  | { kind: "error"; error: unknown };

/**
 * Is the entry a `done` row names still the file that run published? With `remove`, it is deleted straight after
 * the check: one file at a time, with nothing in between. The entry is opened without following a symlink; the
 * descriptor must be a regular file of the recorded size, and the SHA-256 is computed through that same descriptor.
 * Before deleting, the descriptor's size, modification and change times must be as before the hash (nothing wrote
 * to it meanwhile), and the path must still name the descriptor's device and inode; then the path is unlinked at once.
 *
 * Residual window: `unlink` takes a path, not a descriptor, so between the last check (the `lstat` of the path)
 * and the `unlink` call, another process could replace the name or write into the file, and the unlink would remove
 * what it put there. That needs another process writing into the backups folder at that instant; nothing in Sonder
 * writes to these names but the run that published them.
 */
async function checkRecordedFile(dir: string, row: DoneRow, remove: boolean): Promise<FileCheck> {
  const path = join(dir, row.file);
  let handle: FileHandle;
  try {
    handle = await openNoFollow(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "not-ours", why: "missing" };
    if (code === "ELOOP") return { kind: "not-ours", why: "not a regular file" };
    return { kind: "error", error };
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { kind: "not-ours", why: "not a regular file" };
    if (before.size !== BigInt(row.bytes)) return { kind: "not-ours", why: "other size" };
    if ((await sha256Of(handle)) !== row.sha256) return { kind: "not-ours", why: "other content" };
    if (!remove) return { kind: "kept" };
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
      return { kind: "not-ours", why: "written to while it was checked" };
    const atPath = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!atPath?.isFile() || atPath.dev !== after.dev || atPath.ino !== after.ino) return { kind: "not-ours", why: "replaced while it was checked" };
    unlinkSync(path);
    return { kind: "removed" };
  } catch (error) {
    return { kind: "error", error };
  } finally {
    await handle.close();
  }
}

/** What retention removed, and why it stopped when it failed (null when it did not). */
export type Cleanup = { removed: string[]; error: string | null };

/**
 * Retention: keeps the newest 14 of the schedule's own backups and deletes the older ones. Newest first, each
 * recorded file is checked (`checkRecordedFile`): one that is still the file its run published fills a kept slot,
 * and once 14 are kept each further one is checked and deleted in the same step. A row whose name is not the
 * schedule's for its day, or that was written before identities were recorded, never counts and its file is never
 * read or deleted; when the remaining rows cannot exceed the kept slots, nothing more is read. A row whose file is
 * gone, replaced or changed is marked disowned and its file is left alone. A file that cannot be checked or removed
 * stops retention: its row is disowned, nothing further is deleted, and the reason is returned.
 */
export async function pruneDailyBackups(dir = backupsDir, keep = DAILY_BACKUPS_KEPT, log?: BackupRunOptions["log"], now = Date.now()): Promise<Cleanup> {
  const removed: string[] = [];
  try {
    const rows = (sqlite.prepare(
      "SELECT day, file, bytes, sha256 FROM backup_runs WHERE status = 'done' AND disowned_at IS NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL ORDER BY day DESC",
    ).all() as DoneRow[]).filter((row) => isScheduleFileName(row.day, row.file));
    const slots = Math.max(1, keep);
    const disown = (day: string) =>
      sqlite.prepare("UPDATE backup_runs SET disowned_at = ? WHERE day = ? AND status = 'done' AND disowned_at IS NULL").run(now, day);
    let kept = 0;
    for (const [index, row] of rows.entries()) {
      if (kept + (rows.length - index) <= slots) break;
      const check = await checkRecordedFile(dir, row, kept >= slots);
      if (check.kind === "kept") kept += 1;
      else if (check.kind === "removed") removed.push(row.file);
      else if (check.kind === "not-ours") {
        disown(row.day);
        log?.warn({ file: row.file, why: check.why }, "A daily backup is no longer the file the schedule made; retention leaves it alone");
      } else {
        disown(row.day);
        return { removed, error: `Old backups not removed: ${row.file} could not be checked or removed. ${message(check.error)}` };
      }
    }
    return { removed, error: null };
  } catch (error) {
    return { removed, error: `Old backups not removed: ${message(error)}` };
  }
}

/** One check of the schedule: makes the due backup, records the run, then applies retention after a success only. */
export async function runDailyBackup(options: BackupRunOptions = {}): Promise<BackupRunResult> {
  const now = options.now ?? Date.now();
  const startedAt = Date.now();
  const clock = options.clock ?? (() => now + (Date.now() - startedAt));
  const log = options.log;
  const day = scheduledDay(now);

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
    log?.warn({ day, error: reason }, "Daily database backup failed");
    return { ran: true, day, status: "failed", error: reason, removed: [] };
  }

  // The claim stays live while the run works: renewed at each stage and every minute, so a slow run keeps its day.
  const renew = () => {
    try {
      if (!renewClaim(day, claim, clock())) log?.warn({ day }, "Another run took over this day's backup");
    } catch (error) {
      log?.warn({ day, error }, "Could not renew the daily database backup's claim");
    }
  };
  const renewal = setInterval(renew, options.renewEveryMs ?? CLAIM_RENEW_MS);
  renewal.unref();
  try {
    return await runClaimed(day, claim, options, clock, renew);
  } finally {
    clearInterval(renewal);
  }
}

/** The run once it holds the day's claim. */
async function runClaimed(day: string, claim: string, options: BackupRunOptions, clock: () => number, renew: () => void): Promise<BackupRunResult> {
  const dir = options.dir ?? backupsDir;
  const log = options.log;
  const failed = (error: string) => {
    log?.warn({ day, error }, "Daily database backup failed");
    return { ran: true as const, day, status: "failed" as const, error, removed: [] };
  };
  const recordFailure = (error: string) => {
    try {
      if (!finish(day, claim, { status: "failed", error }, clock())) log?.warn({ day }, "Another run took over this day's backup; its result is not recorded");
    } catch (recordError) {
      log?.warn({ day, error: recordError }, "Could not record the daily database backup's result");
    }
  };

  const destination = join(dir, dailyBackupName(day));
  let identity: Identity | undefined;
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
      recordFailure(refusal);
      return failed(refusal);
    }
    renew();

    const existing = await existingDestination(day, claim, destination);
    if (existing === "theirs")
      throw new Error(`destination already exists: ${destination}, and it is not the backup an earlier attempt of this day published; it is left alone`);
    if (existing) identity = existing;
    else {
      await (options.backup ?? backupDatabase)(options.source ?? databaseFile, destination, {
        // Size and SHA-256 come from the verified copy and are stored before it is published: if anything fails
        // after publication, the next attempt finds the file at the day's name and adopts it.
        beforePublish: async (temporary) => {
          const copy = await fileIdentity(temporary);
          if (copy.kind !== "file") throw new BackupError(`the verified copy ${temporary} is not a regular file`);
          if (!storeIdentity(day, claim, copy.identity, clock())) throw new BackupError("another run took over this day's backup before it was published");
          identity = copy.identity;
        },
      });
      if (!identity) throw new Error("the backup was published without its size and SHA-256 recorded first");
    }
  } catch (error) {
    const reason = `Backup failed: ${message(error)}`;
    recordFailure(reason);
    return failed(reason);
  }

  let recorded: boolean;
  try {
    recorded = finish(day, claim, { status: "done", ...identity }, clock());
  } catch (error) {
    // The file is published and its identity is in the row: the next check adopts it.
    const reason = `Backup failed: ${destination} was published, but the result could not be recorded. ${message(error)}`;
    recordFailure(reason);
    return failed(reason);
  }
  if (!recorded) return failed("Backup failed: another run took over this day's backup; this run's result is not recorded");

  const cleanup = await pruneDailyBackups(dir, DAILY_BACKUPS_KEPT, log, clock());
  try {
    recordCleanup(day, cleanup);
  } catch (error) {
    log?.warn({ day, error, cleanup }, "Could not record the retention of the daily backups");
  }
  if (cleanup.error) log?.warn({ day, error: cleanup.error }, "Retention of the daily backups failed; nothing further was removed");
  log?.info({ day, bytes: identity.bytes, removed: cleanup.removed }, "Daily database backup made");
  return { ran: true, day, status: "done", error: null, removed: cleanup.removed, cleanupError: cleanup.error };
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
