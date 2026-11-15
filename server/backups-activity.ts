/**
 * Activity source of the daily database backups (`backup_runs`, #361, ADR 0010). The vocabulary is
 * `BACKUP_RUN_STATUSES` in `server/schema.ts`, as `server/backups.ts` writes it. The page shows the latest run as
 * an item (a failed run with its reason), and the schedule on the process row: last run, result, size, next run.
 */
import type { ActivityState } from "../src/types.ts";
import type { BackupRunStatus } from "./schema.ts";
import { defineSource, stateFrom } from "./activity-source.ts";
import { BACKUP_CHECK_INTERVAL_MS, backupPlan, dueAt } from "./backup-schedule.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const BACKUP_RUN_ACTIVITY_STATES: Record<BackupRunStatus, ActivityState> = {
  running: "running",
  done: "done",
  failed: "failed",
};

export type BackupRunRow = {
  day: string;
  file: string;
  status: string;
  bytes: number | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
};

/** The latest run, and the days of every successful run: the schedule decides from those (`backupPlan`). */
export type BackupRows = { latest: BackupRunRow | null; doneDays: string[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The schedule is in UTC, so its times are shown in UTC. */
export function utcTime(ms: number) {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export const backupSize = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

function lastRunText(row: BackupRunRow | null, state: ActivityState | null) {
  if (!row || !state) return "No backup yet";
  if (state === "running") return `Running since ${utcTime(row.started_at)}`;
  const when = utcTime(row.finished_at ?? row.updated_at);
  if (state === "done") return `Last run ${when}: succeeded${row.bytes !== null ? `, ${backupSize(row.bytes)}` : ""}`;
  return `Last run ${when}: failed`;
}

function nextRunText(rows: BackupRows, state: ActivityState | null, held: boolean, now: number) {
  if (held) return "Next run when resumed";
  // A running backup is today's; the next one is due the day after. Otherwise the scheduler's own decision.
  const next = state === "running" && rows.latest ? dueAt(rows.latest.day) + DAY : backupPlan(rows.doneDays, now).nextAt;
  if (next <= now) return `Next run within ${Math.round(BACKUP_CHECK_INTERVAL_MS / MINUTE)} minutes`;
  return `Next run ${utcTime(next)}`;
}

const SELECT = "SELECT day, file, status, bytes, error, started_at, finished_at, updated_at FROM backup_runs";

export const backupSource = defineSource<BackupRows>({
  kind: "backup",
  process: { id: "backups", label: "Database backups" },
  stuckAfterMs: 30 * MINUTE,
  load: (sqlite) => ({
    latest: (sqlite.prepare(`${SELECT} ORDER BY updated_at DESC, day DESC LIMIT 1`).get() as BackupRunRow | undefined) ?? null,
    doneDays: (sqlite.prepare("SELECT day FROM backup_runs WHERE status = 'done'").all() as { day: string }[]).map((row) => row.day),
  }),
  report(rows, _probe, { now, held }) {
    const row = rows.latest;
    const mapped = row ? stateFrom(BACKUP_RUN_ACTIVITY_STATES, row.status) : null;
    const state = mapped?.state ?? null;
    const summary = `${lastRunText(row, state)} · ${nextRunText(rows, state, held, now)}`;
    if (!row || !mapped) return { drafts: [], summary };
    const size = state === "done" && row.bytes !== null ? `, ${backupSize(row.bytes)}` : "";
    return {
      drafts: [{
        id: `backup:${row.day}`, kind: "backup" as const, processId: "backups", title: "Daily database backup",
        detail: `${row.file}${size}`, user: null, state: mapped.state, progress: null, host: null,
        startedAt: row.started_at, updatedAt: row.finished_at ?? row.updated_at,
        error: mapped.unknown ?? (row.error || null),
        // A backup reports no progress: a running one is stuck when it has run for longer than the threshold.
        changedAt: row.updated_at,
      }],
      summary,
    };
  },
});
