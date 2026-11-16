/**
 * Activity page (#357, ADR 0010): every unit of background work in one list. Each feature reports its own items
 * through an activity source (`server/activity-sources.ts`); this module only asks the sources, marks stuck and
 * blocked items, applies the pause switches, sorts, counts and dispatches an action to the source that owns it.
 */
import type { FastifyInstance } from "fastify";
import type { BackgroundProcess } from "./background-runner.ts";
import type { ActivityHealth, ActivityItem, ActivityProcess, ActivityResponse } from "../src/types.ts";
import { PAUSABLE_PROCESSES, PAUSE_EFFECT, isPausable } from "./activity-pause-model.ts";
import {
  ChangeTracker, activityFailure, formatAge,
  type ActivityDeps, type ActivityService, type ActivitySource, type ProbeResult,
} from "./activity-source.ts";
import { ACTIVITY_SOURCES } from "./activity-sources.ts";

export { ChangeTracker, formatAge, type ActivityDeps } from "./activity-source.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Finished items stay visible this long; failed items stay until someone acts on them. */
export const FINISHED_VISIBLE_MS = DAY;
/** A failure older than this stays listed but no longer needs attention (`ActivityItem.attention`). */
export const ATTENTION_FAILURE_MS = 7 * DAY;

/** Work Activity lists although nothing reports it yet (#362). */
const UNTRACKED_PROCESSES = [
  { id: "imports", label: "Imports" },
];

export function stuckMultiplier(raw: string | undefined | null) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0.25 && value <= 10 ? value : 1;
}

/** One source with the rows it read and what its probe returned. */
export type SourceSnapshot = { source: ActivitySource<unknown, unknown>; rows: unknown; probe: ProbeResult<unknown> };

/** The user whose library the covers of the items are read from: the first administrator, as `ADMIN_USER_ID`. */
export const DEFAULT_ACTIVITY_USER_ID = 1;

export type ActivityInput = {
  now: number;
  multiplier: number;
  snapshots: SourceSnapshot[];
  /** The pause switch of each loop and whether an environment flag locks it. */
  pause?: Record<string, { paused: boolean; locked: boolean }>;
  tracker: ChangeTracker;
};

const loopOrder = (snapshot: SourceSnapshot) => PAUSABLE_PROCESSES.indexOf(snapshot.source.process.id);

export function buildActivity(input: ActivityInput): ActivityResponse {
  const { now, multiplier, tracker } = input;
  const held = (id: string) => !!(input.pause?.[id]?.paused || input.pause?.[id]?.locked);
  const reports = input.snapshots.map((snapshot) => ({
    source: snapshot.source,
    ...snapshot.source.report(snapshot.rows, snapshot.probe, { now, tracker, held: held(snapshot.source.process.id) }),
  }));
  const summaries = new Map<string, string>(reports.flatMap((report) => (report.summary ? [[report.source.process.id, report.summary] as const] : [])));
  const services: ActivityService[] = reports.flatMap((report) => report.services ?? []);
  const downService = new Map(services.filter((service) => service.health === "down").map((service) => [service.id, service.label]));

  const drafts = reports.flatMap((report) => report.drafts.map((draft) => ({ draft, source: report.source })));
  tracker.retainOnly(new Set(drafts.map(({ draft }) => draft.id)));

  const items: ActivityItem[] = [];
  for (const { draft, source } of drafts) {
    const { changedAt, permanent, dependsOn, actions, ...item } = draft;
    if (item.state === "done" && now - item.updatedAt > FINISHED_VISIBLE_MS) continue;
    const waiting = item.state === "running" || item.state === "queued";
    const blockedBy = waiting && dependsOn && downService.has(dependsOn) ? dependsOn : null;
    const threshold = source.stuckAfterMs * multiplier;
    let stuck: ActivityItem["stuck"] = null;
    if (blockedBy) stuck = { reason: `Blocked by ${downService.get(blockedBy)}` };
    else if (source.stuck) stuck = source.stuck(draft, now, threshold);
    else if (item.state === "running" && now - changedAt > threshold) stuck = { reason: `No change for ${formatAge(now - changedAt)}` };
    // The one place the rule is decided for server work (#514): failed in the last seven days, stuck or blocked.
    const attention = (item.state === "failed" && now - item.updatedAt <= ATTENTION_FAILURE_MS) || !!stuck || !!blockedBy;
    items.push({ ...item, permanent: !!permanent, actions: actions ?? [], stuck, blockedBy, attention });
  }

  const rank = (item: ActivityItem) =>
    item.state === "failed" || item.stuck ? 0 : item.state === "running" ? 1 : item.state === "queued" ? 2 : item.state === "paused" ? 3 : 4;
  items.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);

  const base: Array<Pick<ActivityProcess, "id" | "label" | "type" | "notTracked" | "host">> = [
    ...[...input.snapshots].sort((a, b) => loopOrder(a) - loopOrder(b))
      .map(({ source }) => ({ id: source.process.id, label: source.process.label, type: "loop" as const, notTracked: false })),
    ...services.map((service) => ({ id: service.id, label: service.label, type: "service" as const, notTracked: false,
      ...(service.host ? { host: service.host } : {}) })),
    ...UNTRACKED_PROCESSES.map((process) => ({ ...process, type: "loop" as const, notTracked: true })),
  ];
  const probes = new Map(services.map((service) => [service.id, { health: service.health, reason: service.reason }]));

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
    const summary = summaries.get(process.id);
    if (summary) reason = reason ? `${reason} · ${summary}` : summary;
    const since = health === "ok" ? null : mine.filter((item) => item.stuck || item.state === "failed").reduce<number | null>(
      (oldest, item) => (oldest === null ? item.updatedAt : Math.min(oldest, item.updatedAt)), null);
    return { ...process, ...pauseFields, health, reason, since, counts };
  });

  const attentionItems = items.filter((item) => item.attention).length;
  const attention = attentionItems + processes.filter((process) => process.health === "down" && !process.notTracked).length;
  return { checkedAt: now, stuckMultiplier: multiplier, processes, items, attention };
}

const tracker = new ChangeTracker();

/** A probe that is slow or fails must not hold the page: the process then shows why it was not checked. */
async function within<T>(probe: () => Promise<T>, ms: number): Promise<ProbeResult<T>> {
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

export async function collectActivity(
  deps: ActivityDeps,
  options: { probes: boolean; /** Whose library the covers come from; the administrator who asked. */ userId?: number } = { probes: true },
  sources: ReadonlyArray<ActivitySource<unknown, unknown>> = ACTIVITY_SOURCES,
) {
  const rows = sources.map((source) => source.load(deps.sqlite, { userId: options.userId ?? DEFAULT_ACTIVITY_USER_ID }));
  const none: ProbeResult<unknown> = { value: null, failure: null };
  const probes = await Promise.all(sources.map((source) => {
    const probe = source.probe;
    return options.probes && probe ? within(() => probe(deps), 4000) : none;
  }));
  return buildActivity({
    now: (deps.now ?? Date.now)(),
    multiplier: stuckMultiplier(deps.getSetting("activityStuckMultiplier")),
    pause: deps.pauseState(),
    snapshots: sources.map((source, index) => ({ source, rows: rows[index], probe: probes[index] })),
    tracker,
  });
}

export function registerActivity(app: FastifyInstance, deps: ActivityDeps, sources: ReadonlyArray<ActivitySource<unknown, unknown>> = ACTIVITY_SOURCES) {
  app.get("/api/activity", async (req) => {
    deps.requireAdmin(req);
    return collectActivity(deps, { probes: true, userId: deps.userId?.(req) }, sources);
  });
  app.post("/api/activity/processes/:id/pause", async (req) => {
    deps.requireAdmin(req);
    const { id } = req.params as { id: string };
    const { paused } = (req.body ?? {}) as { paused?: unknown };
    if (!isPausable(id)) throw activityFailure(404, "This process cannot be paused.");
    if (typeof paused !== "boolean") throw activityFailure(400, "Say whether to pause or resume.");
    if (deps.pauseState()[id]?.locked) throw activityFailure(409, "An environment setting disables this process, so it cannot be changed here.");
    deps.setPaused(id, paused);
    app.log.info({ action: "activity.pause", process: id, paused }, "Background process pause changed");
    return { ok: true, id, paused };
  });
  // A service's action (a worker host's restart or switch) goes to the source whose prefix starts the service id.
  for (const name of ["restart", "disable"] as const) {
    app.post(`/api/activity/services/:id/${name}`, async (req) => {
      deps.requireAdmin(req);
      const { id } = req.params as { id: string };
      const action = sources.find((source) => source.services && id.startsWith(source.services.prefix))?.services?.[name];
      if (!action) throw activityFailure(404, `This process has no ${name === "restart" ? "restart" : "switch"}.`);
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
      return action(id, body, { deps, log: app.log });
    });
  }
  // An item's action goes to the source whose kind prefixes the item id.
  for (const name of ["retry", "discard"] as const) {
    app.post(`/api/activity/items/${name}`, async (req) => {
      deps.requireAdmin(req);
      const { id } = (req.body ?? {}) as { id?: string };
      const itemId = String(id ?? "");
      const action = sources.find((source) => itemId.startsWith(`${source.kind}:`))?.[name];
      if (!action) throw activityFailure(400, "This item has no retry or discard yet.");
      return action(itemId, { deps, log: app.log });
    });
  }
}

/**
 * The Activity sampler loop (ADR 0010): keeps the change tracker current while nobody has the page open, so
 * "no change for 20 min" is true on first view. It has no pause switch. The app adds it to its runner; this
 * module only imports the runner's type, so it stays free of the database at import.
 */
export const activitySamplerLoop = (
  app: FastifyInstance,
  deps: ActivityDeps,
  sources: ReadonlyArray<ActivitySource<unknown, unknown>> = ACTIVITY_SOURCES,
): BackgroundProcess => ({
  id: "activity-sampler",
  intervalMs: MINUTE,
  tick: () => collectActivity(deps, { probes: false }, sources).catch((error) => app.log.warn({ error }, "Activity sample failed")),
});
