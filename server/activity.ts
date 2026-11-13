/**
 * Activity page (#357, ADR 0002 context): every unit of background work in one list, read through
 * from the existing tables. Pure functions turn rows into items; `registerActivity` loads the rows.
 */
import type { FastifyInstance } from "fastify";
import type {
  ActivityHealth,
  ActivityItem,
  ActivityKind,
  ActivityProcess,
  ActivityResponse,
  ActivityState,
  TorrentHealth,
} from "../src/types.ts";
import type { AlignmentPoolStatus } from "../src/reading-types.ts";
import { PAUSE_EFFECT, isPausable, type PausableProcess } from "./activity-pause-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A running item is stuck when nothing about it changed for this long (scaled by the settings multiplier). */
export const STUCK_AFTER_MS: Record<ActivityKind, number> = {
  "server-copy": 5 * MINUTE,
  acquisition: 15 * MINUTE,
  "series-acquisition": 10 * MINUTE,
  alignment: 20 * MINUTE,
  hardcover: 30 * MINUTE,
};
/** Finished items stay visible this long; failed items stay until someone acts on them. */
export const FINISHED_VISIBLE_MS = DAY;
/** Until Retry and Discard exist, a failure older than this stays listed but stops lighting the Settings indicator. */
export const ATTENTION_FAILURE_MS = 7 * DAY;

export function stuckMultiplier(raw: string | undefined | null) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0.25 && value <= 10 ? value : 1;
}

export function formatAge(ms: number) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Hardcover answers that will never succeed on retry. */
export function isPermanentHardcoverError(message: string | null | undefined) {
  return !!message && /weren't able to find that book|was it deleted|not found|no longer exists/i.test(message);
}

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

export type AcquisitionRow = {
  id: string;
  title: string;
  author: string | null;
  backend: string | null;
  status: string;
  progress: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};
export type CopyRow = {
  recording_id: string;
  title: string | null;
  status: string;
  progress: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};
export type SeriesJobRow = {
  id: string | number;
  user: string | null;
  kind: string;
  title: string | null;
  status: string;
  error: string | null;
  updated_at: number;
};
export type AlignmentRow = {
  id: string;
  ebook_id: string;
  recording_id: string;
  title: string | null;
  data: string;
  updated_at: number;
};
export type HardcoverQueueName = "status" | "listening" | "reading";
export const HARDCOVER_QUEUE_TITLES: Record<HardcoverQueueName, string> = {
  status: "Hardcover shelf changes",
  listening: "Hardcover listening progress",
  reading: "Hardcover reading progress",
};
export type HardcoverQueueRow = {
  userId: number;
  user: string;
  queue: HardcoverQueueName;
  count: number;
  oldest: number;
  newest: number;
  error: string | null;
};

export type ActivityInput = {
  now: number;
  multiplier: number;
  acquisitions: AcquisitionRow[];
  copies: CopyRow[];
  seriesJobs: SeriesJobRow[];
  alignments: AlignmentRow[];
  hardcoverQueues: HardcoverQueueRow[];
  torrent: TorrentHealth | null;
  pool: AlignmentPoolStatus | null;
  /** The pause switch of each loop and whether an environment flag locks it. */
  pause?: Record<string, { paused: boolean; locked: boolean }>;
  /** Why a probe returned nothing (it threw or timed out), shown as the process reason. */
  torrentFailure?: string | null;
  poolFailure?: string | null;
  tracker: ChangeTracker;
};

type Draft = Omit<ActivityItem, "stuck" | "blockedBy" | "permanent" | "actions"> & { permanent?: boolean; changedAt: number };

const clamp01 = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;

function acquisitionState(status: string): ActivityState {
  if (status === "error") return "failed";
  if (status === "ready" || status === "complete" || status === "completed" || status === "done") return "done";
  if (status === "paused") return "paused";
  if (status === "queued") return "queued";
  return "running";
}

function copyState(status: string): ActivityState {
  if (status === "error") return "failed";
  if (status === "ready" || status === "done") return "done";
  if (status === "paused") return "paused";
  if (status === "queued") return "queued";
  return "running";
}

function seriesState(status: string): ActivityState {
  if (status === "error") return "failed";
  if (status === "done") return "done";
  if (status === "paused") return "paused";
  if (status === "queued" || status === "pending") return "queued";
  return "running";
}

function alignmentState(status: string): ActivityState {
  if (status === "error") return "failed";
  if (status === "queued") return "queued";
  if (status === "paused") return "paused";
  if (status === "copying" || status === "processing") return "running";
  return "done";
}

type ParsedAlignment = {
  status: string;
  progress: number | null;
  error: string | null;
  createdAt: number | null;
  hostId: string | null;
  outcome: string | null;
  /** Queued automatically to replace a map of an older engine (#277). */
  rebuild: boolean;
};
function parseAlignment(data: string): ParsedAlignment {
  try {
    const job = JSON.parse(data) as Record<string, any>;
    return {
      status: typeof job.status === "string" ? job.status : "queued",
      progress: clamp01(job.progress),
      error: typeof job.error === "string" && job.error ? job.error : null,
      createdAt: typeof job.createdAt === "number" ? job.createdAt : null,
      hostId: typeof job.pool?.hostId === "string" ? job.pool.hostId : null,
      outcome: typeof job.outcome === "string" ? job.outcome : null,
      rebuild: !!job.rebuildOf,
    };
  } catch (error) {
    return {
      status: "error", progress: null, createdAt: null, hostId: null, outcome: null, rebuild: false,
      error: `The job record could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function draftsFrom(input: ActivityInput): Draft[] {
  const { now, tracker } = input;
  const drafts: Draft[] = [];
  for (const row of input.acquisitions) {
    const state = acquisitionState(row.status);
    const id = `acquisition:${row.id}`;
    drafts.push({
      id, kind: "acquisition", processId: "acquisitions", title: row.title, detail: row.author || null, user: null,
      state, progress: clamp01(row.progress), host: row.backend || null, startedAt: row.created_at, updatedAt: row.updated_at,
      error: row.error || null,
      changedAt: state === "running" ? tracker.observe(id, `${row.status}|${row.progress}`, now) : row.updated_at,
    });
  }
  for (const row of input.copies) {
    const state = copyState(row.status);
    const id = `server-copy:${row.recording_id}`;
    drafts.push({
      id, kind: "server-copy", processId: "server-copies", title: row.title || row.recording_id, detail: "Copy to the server", user: null,
      state, progress: clamp01(row.progress), host: null, startedAt: row.created_at, updatedAt: row.updated_at,
      error: row.error || null,
      changedAt: state === "running" ? tracker.observe(id, `${row.status}|${row.progress}`, now) : row.updated_at,
    });
  }
  for (const row of input.seriesJobs) {
    const state = seriesState(row.status);
    drafts.push({
      id: `series-acquisition:${row.id}`, kind: "series-acquisition", processId: "series-acquisition",
      title: row.title || `Series ${row.kind}`, detail: `Series ${row.kind}`, user: row.user, state, progress: null, host: null,
      startedAt: null, updatedAt: row.updated_at, error: row.error || null, changedAt: row.updated_at,
    });
  }
  for (const row of input.alignments) {
    const job = parseAlignment(row.data);
    const state = alignmentState(job.status);
    const consensus = row.ebook_id.startsWith("set-consensus:");
    drafts.push({
      id: `alignment:${row.id}`, kind: "alignment", processId: "alignment", title: row.title || row.recording_id,
      detail: consensus ? "Ebook set check" : job.rebuild ? "Alignment map rebuild" : "Alignment map", user: null, state,
      progress: state === "done" ? 1 : job.progress, host: job.hostId, startedAt: job.createdAt, updatedAt: row.updated_at,
      error: job.error, changedAt: row.updated_at,
    });
  }
  for (const row of input.hardcoverQueues) {
    const permanent = isPermanentHardcoverError(row.error);
    drafts.push({
      id: `hardcover:${row.queue}:${row.userId}`, kind: "hardcover", processId: "hardcover-sync",
      title: HARDCOVER_QUEUE_TITLES[row.queue], detail: `${row.count} waiting to be sent`, user: row.user,
      state: row.error ? "failed" : "queued", progress: null, host: null, startedAt: row.oldest, updatedAt: row.newest,
      error: row.error, permanent, changedAt: row.newest,
    });
  }
  return drafts;
}

export function torrentProcessHealth(health: TorrentHealth | null, failure?: string | null): { health: ActivityHealth; reason: string | null } {
  if (!health) return { health: "unknown", reason: failure ? `The check failed: ${failure}` : "Not checked yet." };
  if (health.status === "unconfigured") return { health: "unknown", reason: "No torrent client is configured." };
  if (health.status === "ok") {
    if (health.network === "ok" || health.network === "unknown") return { health: "ok", reason: null };
    return { health: "degraded", reason: health.message };
  }
  return { health: "down", reason: health.message };
}

function hostProcesses(pool: AlignmentPoolStatus | null) {
  if (!pool?.enabled) return [];
  return pool.hosts.map((host) => {
    const health: ActivityHealth = !host.reachable ? "down" : host.stuck ? "degraded" : "ok";
    const reason = !host.reachable ? host.lastError || "The worker cannot be reached." : host.stuck ? host.lastError || "The worker is stuck." : null;
    return { id: `alignment-host:${host.id}`, label: `Alignment worker (${host.id})`, health, reason };
  });
}

/** TorBox downloads run remotely; only the local backend depends on the local torrent client. */
const usesLocalTorrentClient = (backend: string | null) => backend !== "torbox";

export function buildActivity(input: ActivityInput): ActivityResponse {
  const { now, multiplier } = input;
  const torrent = torrentProcessHealth(input.torrent, input.torrentFailure);
  const hosts = hostProcesses(input.pool);
  const downProcess = new Map<string, string>();
  if (torrent.health === "down") downProcess.set("torrent-client", "Torrent client");
  for (const host of hosts) if (host.health === "down") downProcess.set(host.id, host.label);

  const drafts = draftsFrom(input);
  input.tracker.retainOnly(new Set(drafts.map((draft) => draft.id)));

  const items: ActivityItem[] = [];
  for (const draft of drafts) {
    const { changedAt, permanent, ...item } = draft;
    const finished = item.state === "done";
    if (finished && now - item.updatedAt > FINISHED_VISIBLE_MS) continue;
    const waiting = item.state === "running" || item.state === "queued";
    let blockedBy: string | null = null;
    if (waiting && item.kind === "acquisition" && usesLocalTorrentClient(item.host) && downProcess.has("torrent-client"))
      blockedBy = "torrent-client";
    if (waiting && item.kind === "alignment" && item.host && downProcess.has(`alignment-host:${item.host}`))
      blockedBy = `alignment-host:${item.host}`;
    const threshold = STUCK_AFTER_MS[item.kind] * multiplier;
    let stuck: ActivityItem["stuck"] = null;
    if (blockedBy) stuck = { reason: `Blocked by ${downProcess.get(blockedBy)}` };
    else if (item.kind === "hardcover" && item.state !== "done") {
      if (permanent) stuck = { reason: "This change cannot succeed" };
      else if (now - (item.startedAt ?? item.updatedAt) > threshold) stuck = { reason: `Unsent for ${formatAge(now - (item.startedAt ?? item.updatedAt))}` };
    } else if (item.state === "running" && now - changedAt > threshold) {
      stuck = { reason: `No change for ${formatAge(now - changedAt)}` };
    }
    // Hardcover changes are the only kind with actions so far: Discard for one that cannot succeed, Retry for the rest.
    const actions: ActivityItem["actions"] =
      item.kind === "hardcover" && item.state !== "done" ? (permanent ? ["discard"] : ["retry"]) : [];
    items.push({ ...item, permanent: !!permanent, actions, stuck, blockedBy });
  }

  const rank = (item: ActivityItem) =>
    item.state === "failed" || item.stuck ? 0 : item.state === "running" ? 1 : item.state === "queued" ? 2 : item.state === "paused" ? 3 : 4;
  items.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);

  const base: Array<Pick<ActivityProcess, "id" | "label" | "type" | "notTracked">> = [
    { id: "acquisitions", label: "Download queue", type: "loop", notTracked: false },
    { id: "server-copies", label: "Copies to server", type: "loop", notTracked: false },
    { id: "series-acquisition", label: "Series acquisition", type: "loop", notTracked: false },
    { id: "hardcover-sync", label: "Hardcover sync", type: "loop", notTracked: false },
    { id: "alignment", label: "Alignment processor", type: "loop", notTracked: false },
    { id: "torrent-client", label: "Torrent client", type: "service", notTracked: false },
    ...hosts.map((host) => ({ id: host.id, label: host.label, type: "service" as const, notTracked: false })),
    ...(input.poolFailure ? [{ id: "alignment-pool", label: "Alignment workers", type: "service" as const, notTracked: false }] : []),
    { id: "imports", label: "Imports", type: "loop", notTracked: true },
    { id: "backups", label: "Database backups", type: "loop", notTracked: true },
  ];
  const probes = new Map<string, { health: ActivityHealth; reason: string | null }>([["torrent-client", torrent]]);
  for (const host of hosts) probes.set(host.id, { health: host.health, reason: host.reason });
  if (input.poolFailure) probes.set("alignment-pool", { health: "unknown", reason: `The check failed: ${input.poolFailure}` });

  const processes: ActivityProcess[] = base.map((process) => {
    const mine = items.filter((item) => item.processId === process.id);
    const counts = {
      running: mine.filter((item) => item.state === "running").length,
      queued: mine.filter((item) => item.state === "queued").length,
      failed: mine.filter((item) => item.state === "failed").length,
      stuck: mine.filter((item) => item.stuck).length,
    };
    const pausable = isPausable(process.id);
    const control = pausable ? input.pause?.[process.id] : undefined;
    const pauseFields = {
      pausable,
      paused: !!control?.paused,
      lockedBy: control?.locked ? ("environment" as const) : null,
      pauseEffect: pausable ? PAUSE_EFFECT[process.id as keyof typeof PAUSE_EFFECT] : null,
    };
    if (process.notTracked) return { ...process, ...pauseFields, health: "unknown", reason: "Not tracked yet.", since: null, counts };
    const probe = probes.get(process.id);
    let health: ActivityHealth = probe?.health ?? "ok";
    let reason = probe?.reason ?? null;
    if (health === "ok" && (counts.failed || counts.stuck)) {
      health = "degraded";
      reason = [counts.failed ? `${counts.failed} failed` : "", counts.stuck ? `${counts.stuck} stuck` : ""].filter(Boolean).join(", ");
    }
    const since = health === "ok" ? null : mine.filter((item) => item.stuck || item.state === "failed").reduce<number | null>(
      (oldest, item) => (oldest === null ? item.updatedAt : Math.min(oldest, item.updatedAt)), null);
    return { ...process, ...pauseFields, health, reason, since, counts };
  });

  const attentionItems = items.filter(
    (item) => (item.state === "failed" && now - item.updatedAt <= ATTENTION_FAILURE_MS) || item.stuck || item.blockedBy,
  ).length;
  const attention = attentionItems + processes.filter((process) => process.health === "down" && !process.notTracked).length;
  return { checkedAt: now, stuckMultiplier: multiplier, processes, items, attention };
}

const tracker = new ChangeTracker();

function loadRows(sqlite: import("better-sqlite3").Database) {
  const all = <T>(sql: string) => sqlite.prepare(sql).all() as T[];
  const queue = (table: string, name: HardcoverQueueName) =>
    all<HardcoverQueueRow>(
      `SELECT o.user_id AS userId, COALESCE(u.username, 'user ' || o.user_id) AS user, '${name}' AS queue, COUNT(*) AS count,
              MIN(o.updated_at) AS oldest, MAX(o.updated_at) AS newest,
              (SELECT e.error FROM ${table} e WHERE e.user_id = o.user_id AND e.error IS NOT NULL ORDER BY e.updated_at DESC LIMIT 1) AS error
         FROM ${table} o LEFT JOIN users u ON u.id = o.user_id GROUP BY o.user_id`,
    );
  return {
    acquisitions: all<AcquisitionRow>(
      "SELECT id, title, author, backend, status, progress, error, created_at, updated_at FROM acquisitions",
    ),
    copies: all<CopyRow>(
      `SELECT d.recording_id, w.title, d.status, d.progress, d.error, d.created_at, d.updated_at
         FROM server_downloads d LEFT JOIN audio_editions e ON e.id = d.book_id LEFT JOIN works w ON w.id = e.work_id`,
    ),
    seriesJobs: all<SeriesJobRow>(
      `SELECT j.id, u.username AS user, j.kind, w.title, j.status, j.error, j.updated_at
         FROM series_acquisition_jobs j LEFT JOIN users u ON u.id = j.user_id LEFT JOIN works w ON w.id = j.work_id`,
    ),
    alignments: all<AlignmentRow>(
      `SELECT a.id, a.ebook_id, a.recording_id, w.title, a.data, a.updated_at
         FROM alignment_jobs a LEFT JOIN recordings r ON r.id = a.recording_id
         LEFT JOIN audio_editions e ON e.id = r.edition_id LEFT JOIN works w ON w.id = e.work_id`,
    ),
    hardcoverQueues: [
      ...queue("user_hardcover_outbox", "status"),
      ...queue("user_hardcover_progress", "listening"),
      ...queue("user_hardcover_reading_outbox", "reading"),
    ],
  };
}

/** A probe that is slow or fails must not hold the page: the process then shows why it was not checked. */
async function within<T>(probe: () => Promise<T>, ms: number): Promise<{ value: T | null; failure: string | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      // A probe that throws before it returns a promise must not break the page either.
      Promise.resolve().then(probe).then(
        (value) => ({ value, failure: null }),
        (error: unknown) => ({ value: null, failure: error instanceof Error ? error.message : String(error) }),
      ),
      new Promise<{ value: null; failure: string }>((resolve) => {
        timer = setTimeout(() => resolve({ value: null, failure: "it took too long" }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

export async function collectActivity(deps: ActivityDeps, options: { probes: boolean } = { probes: true }) {
  const rows = loadRows(deps.sqlite);
  const none = { value: null, failure: null };
  const [torrent, pool] = options.probes
    ? await Promise.all([within(deps.torrentHealth, 4000), within(deps.poolStatus, 4000)])
    : [none, none];
  return buildActivity({
    now: (deps.now ?? Date.now)(),
    multiplier: stuckMultiplier(deps.getSetting("activityStuckMultiplier")),
    pause: deps.pauseState(),
    ...rows, torrent: torrent.value, torrentFailure: torrent.failure, pool: pool.value, poolFailure: pool.failure, tracker,
  });
}

const HARDCOVER_QUEUE_TABLES: Record<HardcoverQueueName, string> = {
  status: "user_hardcover_outbox",
  listening: "user_hardcover_progress",
  reading: "user_hardcover_reading_outbox",
};
const failure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
function parseHardcoverItem(id: string) {
  const match = /^hardcover:(status|listening|reading):(\d+)$/.exec(id);
  if (!match) throw failure(400, "This item has no retry or discard yet.");
  return { queue: match[1] as HardcoverQueueName, userId: Number(match[2]) };
}

export function registerActivity(app: FastifyInstance, deps: ActivityDeps) {
  app.get("/api/activity", async (req) => {
    deps.requireAdmin(req);
    return collectActivity(deps);
  });
  app.post("/api/activity/processes/:id/pause", async (req) => {
    deps.requireAdmin(req);
    const { id } = req.params as { id: string };
    const { paused } = (req.body ?? {}) as { paused?: unknown };
    if (!isPausable(id)) throw failure(404, "This process cannot be paused.");
    if (typeof paused !== "boolean") throw failure(400, "Say whether to pause or resume.");
    if (deps.pauseState()[id]?.locked) throw failure(409, "An environment setting disables this process, so it cannot be changed here.");
    deps.setPaused(id, paused);
    app.log.info({ action: "activity.pause", process: id, paused }, "Background process pause changed");
    return { ok: true, id, paused };
  });
  app.post("/api/activity/items/retry", async (req) => {
    deps.requireAdmin(req);
    const { id } = (req.body ?? {}) as { id?: string };
    const { queue, userId } = parseHardcoverItem(String(id ?? ""));
    app.log.info({ action: "activity.retry", queue, userId }, "Hardcover changes sent again");
    return { ok: true, result: await deps.syncHardcover(userId) };
  });
  app.post("/api/activity/items/discard", async (req) => {
    deps.requireAdmin(req);
    const { id } = (req.body ?? {}) as { id?: string };
    const { queue, userId } = parseHardcoverItem(String(id ?? ""));
    const table = HARDCOVER_QUEUE_TABLES[queue];
    const failed = deps.sqlite.prepare(`SELECT error FROM ${table} WHERE user_id = ? AND error IS NOT NULL`).all(userId) as Array<{ error: string }>;
    if (!failed.length) throw failure(404, "There is nothing to discard here.");
    if (failed.some((row) => !isPermanentHardcoverError(row.error)))
      throw failure(409, "This change might still go through. Use Retry instead.");
    const removed = deps.sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ? AND error IS NOT NULL`).run(userId).changes;
    app.log.info({ action: "activity.discard", queue, userId, removed }, "Hardcover changes discarded");
    return { ok: true, discarded: removed };
  });
  // Keep the change tracker current while nobody has the page open, so "no change for 20 min" is true on first view.
  const sampler = setInterval(
    () => void collectActivity(deps, { probes: false }).catch((error) => app.log.warn({ error }, "Activity sample failed")),
    MINUTE,
  );
  sampler.unref();
  app.addHook("onClose", async () => clearInterval(sampler));
}
