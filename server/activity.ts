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
export type HardcoverQueueRow = {
  user: string;
  queue: "listening" | "reading";
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
  tracker: ChangeTracker;
};

type Draft = Omit<ActivityItem, "stuck" | "blockedBy" | "permanent"> & { permanent?: boolean; changedAt: number };

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
    };
  } catch {
    return { status: "error", progress: null, error: "The job record could not be read.", createdAt: null, hostId: null, outcome: null };
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
      detail: consensus ? "Ebook set check" : "Alignment map", user: null, state,
      progress: state === "done" ? 1 : job.progress, host: job.hostId, startedAt: job.createdAt, updatedAt: row.updated_at,
      error: job.error, changedAt: row.updated_at,
    });
  }
  for (const row of input.hardcoverQueues) {
    const permanent = isPermanentHardcoverError(row.error);
    drafts.push({
      id: `hardcover:${row.queue}:${row.user}`, kind: "hardcover", processId: "hardcover-sync",
      title: `Hardcover ${row.queue} changes`, detail: `${row.count} waiting to be sent`, user: row.user,
      state: row.error ? "failed" : "queued", progress: null, host: null, startedAt: row.oldest, updatedAt: row.newest,
      error: row.error, permanent, changedAt: row.newest,
    });
  }
  return drafts;
}

export function torrentProcessHealth(health: TorrentHealth | null): { health: ActivityHealth; reason: string | null } {
  if (!health) return { health: "unknown", reason: "Not checked yet." };
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
  const torrent = torrentProcessHealth(input.torrent);
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
    items.push({ ...item, permanent: !!permanent, stuck, blockedBy });
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
    { id: "imports", label: "Imports", type: "loop", notTracked: true },
    { id: "backups", label: "Database backups", type: "loop", notTracked: true },
  ];
  const probes = new Map<string, { health: ActivityHealth; reason: string | null }>([["torrent-client", torrent]]);
  for (const host of hosts) probes.set(host.id, { health: host.health, reason: host.reason });

  const processes: ActivityProcess[] = base.map((process) => {
    const mine = items.filter((item) => item.processId === process.id);
    const counts = {
      running: mine.filter((item) => item.state === "running").length,
      queued: mine.filter((item) => item.state === "queued").length,
      failed: mine.filter((item) => item.state === "failed").length,
      stuck: mine.filter((item) => item.stuck).length,
    };
    if (process.notTracked) return { ...process, health: "unknown", reason: "Not tracked yet.", since: null, counts };
    const probe = probes.get(process.id);
    let health: ActivityHealth = probe?.health ?? "ok";
    let reason = probe?.reason ?? null;
    if (health === "ok" && (counts.failed || counts.stuck)) {
      health = "degraded";
      reason = [counts.failed ? `${counts.failed} failed` : "", counts.stuck ? `${counts.stuck} stuck` : ""].filter(Boolean).join(", ");
    }
    const since = health === "ok" ? null : mine.filter((item) => item.stuck || item.state === "failed").reduce<number | null>(
      (oldest, item) => (oldest === null ? item.updatedAt : Math.min(oldest, item.updatedAt)), null);
    return { ...process, health, reason, since, counts };
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
  const queue = (table: string, name: "listening" | "reading") =>
    all<HardcoverQueueRow>(
      `SELECT COALESCE(u.username, 'user ' || o.user_id) AS user, '${name}' AS queue, COUNT(*) AS count,
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
      ...queue("user_hardcover_outbox", "listening"),
      ...queue("user_hardcover_reading_outbox", "reading"),
    ],
  };
}

/** A probe that is slow or fails must not hold the page: the process then shows as not checked. */
async function within<T>(probe: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      // A probe that throws before it returns a promise must not break the page either.
      Promise.resolve().then(probe).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
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
  now?: () => number;
};

export async function collectActivity(deps: ActivityDeps, options: { probes: boolean } = { probes: true }) {
  const rows = loadRows(deps.sqlite);
  const [torrent, pool] = options.probes
    ? await Promise.all([within(deps.torrentHealth, 4000), within(deps.poolStatus, 4000)])
    : [null, null];
  return buildActivity({
    now: (deps.now ?? Date.now)(),
    multiplier: stuckMultiplier(deps.getSetting("activityStuckMultiplier")),
    ...rows, torrent, pool, tracker,
  });
}

export function registerActivity(app: FastifyInstance, deps: ActivityDeps) {
  app.get("/api/activity", async (req) => {
    deps.requireAdmin(req);
    return collectActivity(deps);
  });
  // Keep the change tracker current while nobody has the page open, so "no change for 20 min" is true on first view.
  const sampler = setInterval(() => void collectActivity(deps, { probes: false }).catch(() => {}), MINUTE);
  sampler.unref();
  app.addHook("onClose", async () => clearInterval(sampler));
}
