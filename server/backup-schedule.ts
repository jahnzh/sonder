/**
 * The rules of the daily database backups (#361), without the database or the disk: when a backup is due, what
 * the files are called, which of them retention removes, and when a run is refused. `server/backups.ts` runs them;
 * the Activity source (`server/backups-activity.ts`) uses them to say when the next run is.
 *
 * The day is the UTC day, and a day's backup is due from 03:00 UTC (04:00 or 05:00 in Oslo, when nobody listens).
 * The loop checks every 10 minutes, so a server that was down at 03:00 makes the day's backup within 10 minutes of
 * starting, and one that was down for several days makes one backup, for the latest day, not one per missed day.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A day's backup is due from this hour, UTC. */
export const BACKUP_HOUR_UTC = 3;
/** The loop checks this often whether a backup is due. */
export const BACKUP_CHECK_INTERVAL_MS = 10 * MINUTE;
/** Retention keeps this many daily backups made by the schedule; one is about 25 MB. */
export const DAILY_BACKUPS_KEPT = 14;
/** A run is refused when the backup folder's filesystem has less free space than this (about 40 backups). */
export const MIN_FREE_BYTES = 1024 ** 3;
/**
 * A run's claim on its day is live this long after it started: far longer than a backup of the ~25 MB database
 * takes. An older claim belongs to a server that stopped mid-run; another run may take it over.
 */
export const STALE_CLAIM_MS = 30 * MINUTE;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_NAME = /^daily-(\d{4}-\d{2}-\d{2})\.db$/;

/** The UTC day whose backup is the latest one due at `now`: today from 03:00 UTC, yesterday before that. */
export function scheduledDay(now: number) {
  return new Date(now - BACKUP_HOUR_UTC * HOUR).toISOString().slice(0, 10);
}

/** When a day's backup becomes due. */
export const dueAt = (day: string) => Date.parse(`${day}T${String(BACKUP_HOUR_UTC).padStart(2, "0")}:00:00.000Z`);

/**
 * Is a backup due? `lastSuccessDay` is the day of the newest successful daily backup (null when there is none).
 * One backup a day: due when the latest scheduled day has no backup yet.
 */
export function backupDue(lastSuccessDay: string | null, now: number) {
  if (lastSuccessDay === null || !DAY_PATTERN.test(lastSuccessDay)) return true;
  return lastSuccessDay < scheduledDay(now);
}

/** When the next backup runs: `now` when one is due (the next check makes it), otherwise 03:00 UTC the day after. */
export function nextBackupAt(lastSuccessDay: string | null, now: number) {
  if (backupDue(lastSuccessDay, now)) return now;
  return dueAt(lastSuccessDay!) + DAY;
}

/**
 * The newest day among the successful runs (`done` rows), ignoring a day later than the latest due one: such a
 * row was written while the clock ran ahead, and must not hold back the backups until the clock catches up.
 * Names of files in the backups folder never count; only the runs the schedule recorded do.
 */
export function lastBackupDay(doneDays: readonly string[], now: number) {
  const latestDue = scheduledDay(now);
  let newest: string | null = null;
  for (const day of doneDays) if (DAY_PATTERN.test(day) && day <= latestDue && (newest === null || day > newest)) newest = day;
  return newest;
}

/** The schedule's one decision, from the successful runs: the scheduler runs when `due`, Activity shows `nextAt`. */
export function backupPlan(doneDays: readonly string[], now: number) {
  const lastDay = lastBackupDay(doneDays, now);
  return { lastDay, due: backupDue(lastDay, now), nextAt: nextBackupAt(lastDay, now) };
}

export const dailyBackupName = (day: string) => `daily-${day}.db`;

/**
 * Is `file` the name the schedule gives the backup of `day`? Retention looks at nothing else: a recorded name
 * with a path separator, `..`, or another day's name is never a file of the schedule.
 */
export const isScheduleFileName = (day: string, file: string) => DAY_PATTERN.test(day) && file === dailyBackupName(day);

/** The day of a daily backup's file name, or null for every other name (the `before-*` deploy copies too). */
export function dailyBackupDay(name: string) {
  return DAILY_NAME.exec(name)?.[1] ?? null;
}

/**
 * The files retention removes: daily backups that the schedule recorded as made by itself, beyond the newest
 * `keep`. Every other name, and a daily name the schedule has no record of, is never returned.
 */
export function expiredDailyBackups(names: readonly string[], madeBySchedule: ReadonlySet<string>, keep = DAILY_BACKUPS_KEPT) {
  return names
    .filter((name) => dailyBackupDay(name) !== null && madeBySchedule.has(name))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(Math.max(1, keep));
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** Why a run must not start, or null. The media drive check comes first: without the drive the free space is the system disk's. */
export function backupRefusal(input: { mountProblem: string | null; freeBytes: number; minFreeBytes?: number }) {
  if (input.mountProblem) return `Backup refused: the backup folder is on the media drive, and the drive check failed. ${input.mountProblem}`;
  const minimum = input.minFreeBytes ?? MIN_FREE_BYTES;
  if (input.freeBytes < minimum)
    return `Backup refused: only ${megabytes(input.freeBytes)} free where backups are stored; a backup needs at least ${megabytes(minimum)} free.`;
  return null;
}
