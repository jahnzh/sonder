/**
 * What a feature tells the Activity page about its background work (ADR 0010, #392). A feature exports one
 * activity source next to its own status vocabulary; `server/activity.ts` only aggregates the sources, marks
 * stuck and blocked items, applies the pause switches and dispatches actions. Nothing here knows a feature.
 *
 * Imports only types (and the pure pause model), so the Activity module stays free of the database at import.
 */
import type { FastifyBaseLogger } from "fastify";
import type { ActivityHealth, ActivityItem, ActivityKind, ActivityState, TorrentHealth } from "../src/types.ts";
import type { AlignmentPoolStatus } from "../src/reading-types.ts";
import type { PausableProcess } from "./activity-pause-model.ts";

const MINUTE = 60_000;

export type ActivityDeps = {
  sqlite: import("better-sqlite3").Database;
  getSetting: (key: string) => string | undefined;
  torrentHealth: () => Promise<TorrentHealth>;
  poolStatus: () => Promise<AlignmentPoolStatus>;
  requireAdmin: (req: any) => unknown;
  /** Run a Hardcover sync for one user now (the "Retry" action on a queued change). */
  syncHardcover: (userId: number) => Promise<unknown>;
  /** Pause state per loop: the settings table plus the environment lock. */
  pauseState: () => Record<string, { paused: boolean; locked: boolean }>;
  setPaused: (id: PausableProcess, paused: boolean) => void;
  now?: () => number;
};

/**
 * When did an item last change? Some rows are rewritten on every poll (a failing torrent client rewrites its
 * error each tick), so their `updated_at` says nothing. The tracker remembers when a signature last differed.
 */
export class ChangeTracker {
  private seen = new Map<string, { signature: string; changedAt: number }>();
  observe(id: string, signature: string, now: number) {
    const previous = this.seen.get(id);
    if (previous && previous.signature === signature) return previous.changedAt;
    this.seen.set(id, { signature, changedAt: now });
    return now;
  }
  retainOnly(ids: Set<string>) {
    for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id);
  }
}

/** An item as a source reports it; Activity adds whether it is stuck or blocked. */
export type ActivityDraft = Omit<ActivityItem, "stuck" | "blockedBy" | "permanent" | "actions"> & {
  permanent?: boolean;
  /** When the item last changed, for the "no change for" rule. */
  changedAt: number;
  /** The service this item waits on while running or queued; when that service is down the item is blocked. */
  dependsOn?: string | null;
  actions?: ActivityItem["actions"];
};

/** A service a source probes (torrent client, alignment workers), listed as a process of type "service". */
export type ActivityService = { id: string; label: string; health: ActivityHealth; reason: string | null };

/** What a probe returned, or why it returned nothing (it threw or took too long). */
export type ProbeResult<Probe> = { value: Probe | null; failure: string | null };

export type ActivityReport = {
  drafts: ActivityDraft[];
  services?: ActivityService[];
  /** One line about the process itself (a schedule's last and next run), shown on its row after any health reason. */
  summary?: string;
};

export type ReportContext = {
  now: number;
  tracker: ChangeTracker;
  /** The process's pause switch is on or an environment flag disables it: it starts no new work. */
  held: boolean;
};

export type ActivityActionContext = { deps: ActivityDeps; log: FastifyBaseLogger };
export type ActivityAction = (id: string, context: ActivityActionContext) => Promise<Record<string, unknown>>;

export type ActivitySource<Rows = unknown, Probe = never> = {
  /** The item kind; every item id of this source starts with `${kind}:`. */
  kind: ActivityKind;
  /** The background loop that runs this work. */
  process: { id: PausableProcess; label: string };
  /** A running item is stuck when nothing about it changed for this long (scaled by the settings multiplier). */
  stuckAfterMs: number;
  /** Read the feature's rows. */
  load(sqlite: ActivityDeps["sqlite"]): Rows;
  /** Ask a service this work depends on; Activity runs it with a time limit and only when probes are wanted. */
  probe?(deps: ActivityDeps): Promise<Probe>;
  /** Turn rows into items, and the probe into services. Pure. */
  report(rows: Rows, probe: ProbeResult<Probe>, context: ReportContext): ActivityReport;
  /** A stuck rule of the source's own, used instead of "running with no change for longer than the threshold". */
  stuck?(item: ActivityDraft, now: number, thresholdMs: number): ActivityItem["stuck"];
  retry?: ActivityAction;
  discard?: ActivityAction;
};

/** Keeps a source's row and probe types checked where it is written, then lets the list hold any source. */
export const defineSource = <Rows, Probe = never>(source: ActivitySource<Rows, Probe>) =>
  source as unknown as ActivitySource<unknown, unknown>;

export const UNKNOWN_STATUS = "Unknown status";

/**
 * Map a stored status through a feature's status table. The table is typed over the feature's vocabulary, so a
 * status without a mapping does not compile; a value read from the database outside it is failed, never running.
 */
export function stateFrom<Status extends string>(
  table: Record<Status, ActivityState>,
  status: string,
): { state: ActivityState; unknown: string | null } {
  if (Object.hasOwn(table, status)) return { state: table[status as Status], unknown: null };
  return { state: "failed", unknown: `${UNKNOWN_STATUS} "${status}"` };
}

export const clamp01 = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;

export function formatAge(ms: number) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export const activityFailure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
