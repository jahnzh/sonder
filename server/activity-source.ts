/**
 * What a feature tells the Activity page about its background work (ADR 0010, #392). A feature exports one
 * activity source next to its own status vocabulary; `server/activity.ts` only aggregates the sources, marks
 * stuck and blocked items, applies the pause switches and dispatches actions. Nothing here knows a feature.
 *
 * Imports only types (and the pure pause model and the cover rule, which take the database handle they are given),
 * so the Activity module stays free of the database at import.
 */
import type { FastifyBaseLogger } from "fastify";
import type {
  ActivityHealth, ActivityHostRestart, ActivityItem, ActivityItemAction, ActivityKind, ActivityState, ActivityWorkerHost,
  TorrentHealth,
} from "../src/types.ts";
import type { AlignmentPoolStatus } from "../src/reading-types.ts";
import type { PausableProcess } from "./activity-pause-model.ts";
import { workCovers } from "./work-cover.ts";

const MINUTE = 60_000;

export type ActivityDeps = {
  sqlite: import("better-sqlite3").Database;
  getSetting: (key: string) => string | undefined;
  torrentHealth: () => Promise<TorrentHealth>;
  poolStatus: () => Promise<AlignmentPoolStatus>;
  requireAdmin: (req: any) => unknown;
  /** The user who made the request; the covers of the items are read from their library (#514). */
  userId?: (req: any) => number;
  /** Run a Hardcover sync for one user now (the "Retry" action on a queued change). */
  syncHardcover: (userId: number) => Promise<unknown>;
  /** Evaluate one ebook-set member again in the background (the "Retry" action on an ebook-set check). */
  retryEbookSetMember: (workId: string, ebookId: string) => Promise<unknown>;
  /**
   * Retry a failed download or resume a paused one, as the Downloads page's control does
   * (`POST /api/acquisitions/<id>/control`, #515). `userId` is the administrator who asked.
   */
  controlAcquisition: (id: string, action: "retry" | "resume", userId: number) => Promise<unknown>;
  /** Resume or retry a reading sync, as the `resume` of `PATCH /api/alignments/<id>` does (#515); answers the job. */
  resumeAlignment: (id: string) => Promise<unknown>;
  /** Pause state per loop: the settings table plus the environment lock. */
  pauseState: () => Record<string, { paused: boolean; locked: boolean }>;
  setPaused: (id: PausableProcess, paused: boolean) => void;
  /** The alignment worker hosts' controls (#357 PR 3); absent where a test does not need them. */
  workerHosts?: WorkerHostControls;
  now?: () => number;
};

/** What the Activity page can do with an alignment worker host (#357 PR 3, ADR 0002). */
export type WorkerHostControls = {
  /** The configured host ids (ADR 0013). */
  ids: () => string[];
  /** Restart the worker service; throws with `statusCode` and `code` when refused or failed. */
  restart: (hostId: string, options: { force: boolean }) => Promise<Record<string, unknown>>;
  setDisabled: (hostId: string, disabled: boolean) => void;
  /** Which hosts are being restarted now, and the last outcome of each. */
  restarts: () => Record<string, { restarting: boolean; last: ActivityHostRestart | null }>;
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

/** An item as a source reports it; Activity adds whether it is stuck, blocked or needs attention. */
export type ActivityDraft = Omit<ActivityItem, "stuck" | "blockedBy" | "permanent" | "actions" | "attention"> & {
  permanent?: boolean;
  /** When the item last changed, for the "no change for" rule. */
  changedAt: number;
  /** The service this item waits on while running or queued; when that service is down the item is blocked. */
  dependsOn?: string | null;
  actions?: ActivityItem["actions"];
};

/** A service a source probes (torrent client, alignment workers), listed as a process of type "service". */
export type ActivityService = {
  id: string; label: string; health: ActivityHealth; reason: string | null;
  /** A worker host's status and controls (#357 PR 3). */
  host?: ActivityWorkerHost;
};

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

/** What a source's `load` is asked for besides the database: whose library the covers are read from (#514). */
export type LoadContext = { userId: number };

/** The book an item concerns, read with its row: the work, its audio edition (never a placeholder's) and cover. */
export type ItemWork = { workId: string; bookId: string | null; cover: string };

/**
 * `rows` with the work each concerns (`workOf` gives its id, or null for a row with none), read by the cover rule of
 * the library by work for `userId`. A work that no longer exists is no work. One query per rule step for all rows.
 */
export function withWorks<Row>(
  sqlite: ActivityDeps["sqlite"], userId: number, rows: Row[], workOf: (row: Row) => string | null,
): Array<Row & { work: ItemWork | null }> {
  const covers = workCovers(sqlite, userId, rows.flatMap((row) => workOf(row) ?? []));
  return rows.map((row) => {
    const workId = workOf(row);
    const found = workId ? covers.get(workId) : undefined;
    return { ...row, work: workId && found ? { workId, ...found } : null };
  });
}

/** The `workId`, `bookId` and `cover` of an item: its work's, or `ownCover` when it has no work, else none. */
export const itemWork = (work: ItemWork | null | undefined, ownCover: string | null = null) =>
  ({ workId: work?.workId ?? null, bookId: work?.bookId ?? null, cover: work ? work.cover : ownCover });

export type ActivityActionContext = {
  deps: ActivityDeps; log: FastifyBaseLogger;
  /** The administrator who asked (#515); the first administrator where the request names none. */
  userId: number;
};
export type ActivityAction = (id: string, context: ActivityActionContext) => Promise<Record<string, unknown>>;
/** An action on a service the source reports (a worker host's restart or switch), with the request body. */
export type ServiceAction = (
  serviceId: string, body: Record<string, unknown>, context: ActivityActionContext,
) => Promise<Record<string, unknown>>;

export type ActivitySource<Rows = unknown, Probe = never> = {
  /** The item kind; every item id of this source starts with `${kind}:`. */
  kind: ActivityKind;
  /** The background loop that runs this work. */
  process: { id: PausableProcess; label: string };
  /** A running item is stuck when nothing about it changed for this long (scaled by the settings multiplier). */
  stuckAfterMs: number;
  /** Read the feature's rows, with the work of each item (`withWorks`). */
  load(sqlite: ActivityDeps["sqlite"], context: LoadContext): Rows;
  /** Ask a service this work depends on; Activity runs it with a time limit and only when probes are wanted. */
  probe?(deps: ActivityDeps): Promise<Probe>;
  /** Turn rows into items, and the probe into services. Pure. */
  report(rows: Rows, probe: ProbeResult<Probe>, context: ReportContext): ActivityReport;
  /** A stuck rule of the source's own, used instead of "running with no change for longer than the threshold". */
  stuck?(item: ActivityDraft, now: number, thresholdMs: number): ActivityItem["stuck"];
  retry?: ActivityAction;
  discard?: ActivityAction;
  /** Resume a paused item (#515). */
  resume?: ActivityAction;
  /** Actions on the services this source reports, whose ids start with `prefix`. */
  services?: { prefix: string; restart?: ServiceAction; disable?: ServiceAction };
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

/**
 * The action `name` of an item whose stored status is `status`, by the source's table of actions per status: refused
 * with `reason` (409) when that status does not offer it, so an Activity page older than the row cannot act on it.
 */
export function assertOffered<Status extends string>(
  table: Record<Status, readonly ActivityItemAction[]>, status: string, name: ActivityItemAction, reason: string,
) {
  if (!offeredActions(table, status).includes(name)) throw activityFailure(409, reason);
}

/** The actions a stored status offers by the source's table; none for a status outside the vocabulary. */
export const offeredActions = <Status extends string>(table: Record<Status, readonly ActivityItemAction[]>, status: string): ActivityItemAction[] =>
  Object.hasOwn(table, status) ? [...table[status as Status]] : [];

export const activityFailure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
