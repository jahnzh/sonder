/**
 * Activity sources (ADR 0010, #392): each source walks every status its feature can store and shows the intended
 * Activity state; a stored status outside the vocabulary is failed with "Unknown status". The expected tables are
 * typed over each feature's vocabulary, so a status added to the feature without a decision here does not compile.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import type { ActivityItemAction, ActivityKind, ActivityState } from "../src/types.ts";
import type { AlignmentJob } from "../src/reading-types.ts";
import {
  ACQUISITION_STATUSES, BACKUP_RUN_STATUSES, SERVER_COPY_STATUSES, type AcquisitionJobStatus, type BackupRunStatus, type ServerCopyStatus,
} from "../server/schema.ts";
import type { SeriesAcquisitionJobStatus } from "../server/series-acquisition.ts";
import { ChangeTracker, buildActivity, collectActivity, registerActivity, type ActivityDeps } from "../server/activity.ts";
import { UNKNOWN_STATUS, defineSource, type ActivitySource } from "../server/activity-source.ts";
import { ACTIVITY_SOURCES } from "../server/activity-sources.ts";
import { acquisitionSource } from "../server/acquisitions-activity.ts";
import { serverCopySource } from "../server/downloads-activity.ts";
import { seriesAcquisitionSource } from "../server/series-acquisition-activity.ts";
import { alignmentSource } from "../server/alignment-activity.ts";
import { hardcoverSource, hardcoverQueueStatus, type HardcoverQueueStatus } from "../server/hardcover-activity.ts";
import { EBOOK_SET_IDLE_HOLDS, ebookSetSource, type EbookSetCheckStatus } from "../server/ebook-set-activity.ts";
import type { EbookSetHoldReason, EbookSetMemberStatus } from "../server/ebook-set.ts";
import { backupSource, type BackupRunRow } from "../server/backups-activity.ts";
import { PAUSABLE_PROCESSES } from "../server/activity-pause-model.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const none = { value: null, failure: null };

/** The one item a source reports for one row, after Activity marked it. */
const itemFor = (source: ActivitySource<unknown, unknown>, row: unknown, now = NOW) =>
  buildActivity({ now, multiplier: 1, tracker: new ChangeTracker(), snapshots: [{ source, rows: [row], probe: none }] }).items[0];

const acquisitionRow = (status: string) => ({
  id: status, title: `Book ${status}`, author: "Card", backend: "local", status, progress: 0.5, error: null, created_at: NOW - 60 * MIN, updated_at: NOW - MIN,
});
const copyRow = (status: string) => ({
  recording_id: status, title: `Copy ${status}`, status, progress: 0.5, error: null, created_at: NOW - 60 * MIN, updated_at: NOW - MIN,
});
const seriesRow = (status: string, error: string | null = null, updated = NOW - MIN) => ({
  id: status, user: "admin", kind: "audio", title: `Volume ${status}`, status, error, updated_at: updated,
});
const alignmentRow = (status: string) => ({
  id: status, ebook_id: "eb", recording_id: "rec", title: status, data: JSON.stringify({ status, progress: 0.5 }), updated_at: NOW - MIN,
});
const ebookSetRow = (status: string, holdReason: string | null = null, evidence = "{}") => ({
  work_id: "work-1", ebook_id: `ebook-${status}-${holdReason}`, title: "Book", source_title: "Edition", status, hold_reason: holdReason, evidence,
  updated_at: NOW - MIN,
});
const hardcoverRow = (error: string | null) => ({ userId: 1, user: "admin", queue: "status" as const, count: 1, oldest: NOW - MIN, newest: NOW - MIN, error });

test("acquisitions: every status the writers use maps to its Activity state", () => {
  const expected = {
    checking: "running", preparing: "running", downloading: "running", paused: "paused", ready: "done", error: "failed", cancelled: "done",
  } satisfies Record<AcquisitionJobStatus, ActivityState>;
  // Retry when it failed, Resume when it is paused, through the server queue's control in Activity's Now (#515, #516).
  const actions = {
    checking: [], preparing: [], downloading: [], paused: ["resume"], ready: [], error: ["retry", "cancel"], cancelled: [],
  } satisfies Record<AcquisitionJobStatus, ActivityItemAction[]>;
  assert.deepEqual(Object.keys(expected).sort(), [...ACQUISITION_STATUSES].sort(), "the walk covers the whole vocabulary");
  for (const status of ACQUISITION_STATUSES) {
    const item = itemFor(acquisitionSource, acquisitionRow(status));
    assert.equal(item.state, expected[status], status);
    assert.equal(item.error, null, status);
    assert.deepEqual(item.facts, { kind: "acquisition", status, backend: "local" }, `${status}: the status word the writers store, and where it is fetched`);
    assert.deepEqual(item.actions, actions[status], `${status}: the actions it offers`);
  }
  assert.deepEqual(itemFor(acquisitionSource, acquisitionRow("exploded")).actions, [], "a status outside the vocabulary offers nothing");
});

test("copies to the server: every status the writers use maps to its Activity state", () => {
  const expected = {
    queued: "queued", downloading: "running", paused: "paused", ready: "done", error: "failed",
  } satisfies Record<ServerCopyStatus, ActivityState>;
  assert.deepEqual(Object.keys(expected).sort(), [...SERVER_COPY_STATUSES].sort(), "the walk covers the whole vocabulary");
  for (const status of SERVER_COPY_STATUSES) {
    const item = itemFor(serverCopySource, copyRow(status));
    assert.equal(item.state, expected[status], status);
    assert.equal(item.error, null, status);
    assert.deepEqual(item.facts, { kind: "server-copy", status }, `${status}: the status word the writers store`);
    assert.deepEqual(item.actions, [], `${status}: a copy offers no action on Activity`);
  }
});

test("alignment: every status of the job record maps to its Activity state", () => {
  const expected = {
    queued: "queued", copying: "running", processing: "running", paused: "paused",
    cancelled: "done", ready: "done", partial: "done", error: "failed",
  } satisfies Record<AlignmentJob["status"], ActivityState>;
  // Retry when it stopped, Resume when it is paused, through the reading sync route's resume (#515). A cancelled
  // one is finished.
  const actions = {
    queued: [], copying: [], processing: [], paused: ["resume"], cancelled: [], ready: [], partial: [], error: ["retry"],
  } satisfies Record<AlignmentJob["status"], ActivityItemAction[]>;
  for (const status of Object.keys(expected) as Array<AlignmentJob["status"]>) {
    const item = itemFor(alignmentSource, alignmentRow(status));
    assert.equal(item.state, expected[status], status);
    assert.equal(item.facts.kind, "alignment", status);
    assert.equal(item.facts.status, status, `${status}: the status word of the job record`);
    assert.deepEqual(item.actions, actions[status], `${status}: the actions it offers`);
  }
  const missing = itemFor(alignmentSource, { ...alignmentRow("x"), data: JSON.stringify({ progress: 0.5 }) });
  assert.equal(missing.state, "queued", "a record without a status has not started");
  assert.equal(missing.facts.status, "queued", "a record without a status reports the word it is read as");
  assert.deepEqual(missing.actions, []);
  const job = (data: Record<string, unknown> | string) =>
    itemFor(alignmentSource, { ...alignmentRow("x"), data: typeof data === "string" ? data : JSON.stringify(data) });
  assert.deepEqual(job({ status: "error", outcome: "rejected" }).actions, ["retry"], "a rejected rebuild is retried");
  assert.deepEqual(job({ status: "error", origin: "projected" }).actions, [], "a projected ebook-set map is rebuilt with its set, not alone");
  assert.deepEqual(job({ status: "paused", origin: "projected" }).actions, []);
  assert.deepEqual(job({ status: "error", outcome: "language_not_supported" }).actions, [], "a retry would fail the same way");
  assert.deepEqual(job("{not json").actions, [], "a record that cannot be read has no job to resume");
  assert.deepEqual(job({ status: "exploded" }).actions, [], "a status outside the vocabulary offers nothing");
});

test("Hardcover queues: waiting is queued and failing is failed", () => {
  const expected = { waiting: "queued", failing: "failed" } satisfies Record<HardcoverQueueStatus, ActivityState>;
  assert.equal(hardcoverQueueStatus(null), "waiting");
  assert.equal(hardcoverQueueStatus("socket hang up"), "failing");
  assert.equal(itemFor(hardcoverSource, hardcoverRow(null)).state, expected.waiting);
  assert.equal(itemFor(hardcoverSource, hardcoverRow("socket hang up")).state, expected.failing);
  assert.deepEqual(itemFor(hardcoverSource, hardcoverRow(null)).facts, { kind: "hardcover", status: "waiting", queue: "status" });
  assert.deepEqual(itemFor(hardcoverSource, hardcoverRow("socket hang up")).facts, { kind: "hardcover", status: "failing", queue: "status" });
  assert.deepEqual(itemFor(hardcoverSource, hardcoverRow(null)).actions, ["retry"], "waiting: Sync now");
  assert.deepEqual(itemFor(hardcoverSource, hardcoverRow("socket hang up")).actions, ["retry"], "failing: Retry");
  assert.deepEqual(itemFor(hardcoverSource, hardcoverRow("We weren't able to find that book. Was it deleted?")).actions, ["discard"],
    "failing for good: Discard");
});

test("ebook-set checks: every member status and every hold the loop works on maps to its Activity state (#325)", () => {
  const expected = {
    pending: "running", awaiting_worker: "queued", evaluation_failed: "failed", accepted: "done", rejected: "done",
  } satisfies Record<EbookSetCheckStatus, ActivityState>;
  const statuses = { pending: true, held: true, accepted: true, rejected: true } satisfies Record<EbookSetMemberStatus, true>;
  const holds = { awaiting_audio: true, awaiting_worker: true, language_not_supported: true, evaluation_failed: true } satisfies Record<EbookSetHoldReason, true>;
  const walked = [
    ...Object.keys(statuses).filter((status) => status !== "held"),
    ...Object.keys(holds).filter((hold) => !(EBOOK_SET_IDLE_HOLDS as readonly string[]).includes(hold)),
  ];
  assert.deepEqual(walked.sort(), Object.keys(expected).sort(), "the walk covers the whole vocabulary");
  for (const status of Object.keys(statuses).filter((status) => status !== "held")) {
    const item = itemFor(ebookSetSource, ebookSetRow(status));
    assert.equal(item.state, expected[status as EbookSetCheckStatus], status);
    assert.deepEqual(item.facts, { kind: "ebook-set", status, holdReason: null }, `${status}: the member's status word`);
    assert.deepEqual(item.actions, [], `${status}: nothing to retry`);
  }
  for (const hold of ["awaiting_worker", "evaluation_failed"] as const) {
    const item = itemFor(ebookSetSource, ebookSetRow("held", hold));
    assert.equal(item.state, expected[hold], hold);
    assert.deepEqual(item.facts, { kind: "ebook-set", status: "held", holdReason: hold }, `${hold}: held, with its reason`);
  }
  const failed = itemFor(ebookSetSource, ebookSetRow("held", "evaluation_failed", JSON.stringify({ error: "broken EPUB" })));
  assert.equal(failed.error, "broken EPUB");
  assert.deepEqual(failed.actions, ["retry"]);
  assert.deepEqual(itemFor(ebookSetSource, ebookSetRow("held", "awaiting_worker")).actions, ["retry"]);
  assert.deepEqual(itemFor(ebookSetSource, ebookSetRow("pending")).actions, []);
  const unknownHold = itemFor(ebookSetSource, ebookSetRow("held", "exploded"));
  assert.equal(unknownHold.state, "failed");
  assert.equal(unknownHold.error, `${UNKNOWN_STATUS} "exploded"`);
  assert.deepEqual(unknownHold.actions, [], "nothing to retry for a status outside the vocabulary");
});

const backupRow = (status: string, over: Partial<BackupRunRow> = {}): BackupRunRow => ({
  day: "2026-11-14", file: "daily-2026-11-14.db", status, bytes: status === "done" ? 25_300_000 : null, error: status === "failed" ? "Backup failed: disk I/O error" : null,
  started_at: NOW - 2 * MIN, finished_at: status === "running" ? null : NOW - MIN, updated_at: status === "running" ? NOW - 2 * MIN : NOW - MIN, ...over,
});
const backupActivity = (rows: { latest: BackupRunRow | null; doneDays: string[] }, now = NOW, pause: Record<string, { paused: boolean; locked: boolean }> = {}) =>
  buildActivity({ now, multiplier: 1, tracker: new ChangeTracker(), pause, snapshots: [{ source: backupSource, rows, probe: none }] });

test("daily backups: every status the backup runs store maps to its Activity state (#361)", () => {
  const expected = { running: "running", done: "done", failed: "failed" } satisfies Record<BackupRunStatus, ActivityState>;
  assert.deepEqual(Object.keys(expected).sort(), [...BACKUP_RUN_STATUSES].sort(), "the walk covers the whole vocabulary");
  for (const status of BACKUP_RUN_STATUSES) {
    const row = backupRow(status);
    const item = backupActivity({ latest: row, doneDays: status === "done" ? [row.day] : [] }).items[0];
    assert.equal(item.id, "backup:2026-11-14", status);
    assert.equal(item.processId, "backups", status);
    assert.equal(item.state, expected[status], status);
    assert.deepEqual(item.facts, { kind: "backup", status }, `${status}: the status word of the run`);
    assert.deepEqual(item.actions, [], `${status}: a backup offers no action on Activity`);
  }
  const unknown = backupActivity({ latest: backupRow("exploded"), doneDays: [] }).items[0];
  assert.equal(unknown.state, "failed");
  assert.equal(unknown.error, `${UNKNOWN_STATUS} "exploded"`);
});

test("daily backups: the process row shows the last run, its result and size, and the next run (#361)", () => {
  const process = (activity: ReturnType<typeof backupActivity>) => activity.processes.find((entry) => entry.id === "backups")!;
  const done = backupRow("done");
  const ok = backupActivity({ latest: done, doneDays: [done.day] });
  assert.equal(process(ok).notTracked, false);
  assert.equal(process(ok).pausable, true);
  assert.equal(process(ok).health, "ok");
  assert.equal(process(ok).reason, "Last run 14 Nov 11:59 UTC: succeeded, 25.3 MB · Next run 15 Nov 03:00 UTC");
  assert.equal(ok.items[0].detail, "daily-2026-11-14.db, 25.3 MB");
  assert.equal(ok.attention, 0);

  const at = Date.UTC(2026, 10, 15, 3, 10);
  const failedRow = backupRow("failed", { day: "2026-11-15", file: "daily-2026-11-15.db", started_at: at, finished_at: at, updated_at: at });
  const failed = backupActivity({ latest: failedRow, doneDays: [done.day] }, Date.UTC(2026, 10, 15, 4));
  assert.equal(process(failed).health, "degraded");
  assert.equal(process(failed).reason, "1 failed · Last run 15 Nov 03:10 UTC: failed · Next run within 10 minutes", "a failed day is retried at the next check");
  assert.equal(failed.items[0].state, "failed");
  assert.equal(failed.items[0].error, "Backup failed: disk I/O error", "the reason is shown on the failed run");
  assert.equal(failed.attention, 1, "a failed backup lights the Settings indicator");

  const none = backupActivity({ latest: null, doneDays: [] });
  assert.equal(process(none).reason, "No backup yet · Next run within 10 minutes");
  assert.deepEqual(none.items, []);

  const paused = backupActivity({ latest: done, doneDays: [done.day] }, NOW, { backups: { paused: true, locked: false } });
  assert.equal(process(paused).paused, true);
  assert.equal(process(paused).reason, "Last run 14 Nov 11:59 UTC: succeeded, 25.3 MB · Next run when resumed");

  const running = backupActivity({ latest: backupRow("running"), doneDays: [] });
  assert.equal(process(running).reason, "Running since 14 Nov 11:58 UTC · Next run 15 Nov 03:00 UTC");
  const stuck = backupActivity({ latest: backupRow("running"), doneDays: [] }, NOW + 40 * MIN);
  assert.equal(stuck.items[0].stuck?.reason, "No change for 42 min", "a backup running for over 30 minutes is stuck");
});

test("a stored status outside a source's vocabulary is failed with Unknown status, never running", () => {
  const cases: Array<[ActivitySource<unknown, unknown>, unknown]> = [
    [acquisitionSource, acquisitionRow("exploded")],
    [acquisitionSource, acquisitionRow("complete")],
    [serverCopySource, copyRow("exploded")],
    [seriesAcquisitionSource, seriesRow("error")],
    [alignmentSource, alignmentRow("exploded")],
    [ebookSetSource, ebookSetRow("exploded")],
  ];
  for (const [source, row] of cases) {
    const item = itemFor(source, row, NOW + 24 * 60 * MIN);
    assert.equal(item.state, "failed", item.id);
    assert.equal(item.error, `${UNKNOWN_STATUS} "${(row as { status?: string }).status ?? "exploded"}"`, item.id);
    assert.equal(item.stuck, null, `${item.id}: a failed item is not reported as stuck`);
  }
});

test("every loop has exactly one source and every kind is reported", () => {
  const kinds: Record<ActivityKind, true> = {
    acquisition: true, "server-copy": true, "series-acquisition": true, alignment: true, hardcover: true, "ebook-set": true, backup: true,
  };
  assert.deepEqual(ACTIVITY_SOURCES.map((source) => source.kind).sort(), Object.keys(kinds).sort());
  assert.deepEqual(ACTIVITY_SOURCES.map((source) => source.process.id).sort(), [...PAUSABLE_PROCESSES].sort());
});

test("Retry, Discard and Resume go to the source whose kind prefixes the item id", async () => {
  const calls: string[] = [];
  const fake = (kind: ActivityKind, withActions: boolean) => defineSource<never[]>({
    kind, process: { id: "alignment", label: kind }, stuckAfterMs: MIN, load: () => [], report: () => ({ drafts: [] }),
    ...(withActions ? {
      retry: async (id) => { calls.push(`${kind} retry ${id}`); return { ok: true }; },
      discard: async (id) => { calls.push(`${kind} discard ${id}`); return { ok: true, discarded: 0 }; },
      resume: async (id, context) => { calls.push(`${kind} resume ${id} by ${context.userId}`); return { ok: true }; },
    } : {}),
  });
  const app = Fastify();
  registerActivity(app, { requireAdmin: () => {} } as unknown as ActivityDeps, [fake("acquisition", false), fake("alignment", true)]);
  const post = (url: string, id: string) => app.inject({ method: "POST", url, payload: { id } });
  assert.equal((await post("/api/activity/items/retry", "alignment:job-1")).statusCode, 200);
  assert.equal((await post("/api/activity/items/discard", "alignment:job-2")).statusCode, 200);
  const refused = await post("/api/activity/items/retry", "acquisition:a");
  assert.equal(refused.statusCode, 400, "a source without the action refuses it");
  assert.equal(refused.json().message, "This item has no retry or discard yet.");
  assert.equal((await post("/api/activity/items/retry", "hardcover:status:1")).statusCode, 400, "no source of that kind");
  const resumeRefused = await post("/api/activity/items/resume", "acquisition:a");
  assert.equal(resumeRefused.statusCode, 400, "a source without Resume refuses it (#515)");
  assert.equal(resumeRefused.json().message, "This item cannot be resumed.");
  assert.equal((await post("/api/activity/items/resume", "alignment:job-3")).statusCode, 200);
  assert.deepEqual(calls, ["alignment retry alignment:job-1", "alignment discard alignment:job-2", "alignment resume alignment:job-3 by 1"],
    "without a user on the request, the action is the first administrator's");
  await app.close();
});

const source = (path: string) => readFileSync(new URL(`../server/${path}`, import.meta.url), "utf8");
const runtimeImports = (text: string) =>
  [...text.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^;]*?from\s+)?"([^"]+)"/gms)].map((match) => match[1]);

test("the Activity module holds no SQL against feature tables and no feature status words", () => {
  const activity = source("activity.ts");
  assert.doesNotMatch(activity, /\.prepare\(|\bSELECT\b|\bDELETE\b|\bFROM\s+\w+/);
  for (const table of ["acquisitions", "server_downloads", "series_acquisition_jobs", "alignment_jobs", "user_hardcover_"])
    assert.ok(!activity.includes(table), table);
  const words = [...ACQUISITION_STATUSES, ...SERVER_COPY_STATUSES, "pending", "searching", "copying", "processing", "cancelled", "ready", "partial", "error", "waiting", "failing"]
    .filter((word) => !["queued", "paused", "failed", "done"].includes(word)); // the Activity states themselves
  for (const word of new Set(words)) assert.ok(!activity.includes(`"${word}"`), `status word "${word}" in activity.ts`);
});

test("the pause switches import no feature, and the Activity modules do not open the database on import", () => {
  assert.deepEqual(runtimeImports(source("activity-pause.ts")).sort(), ["./activity-pause-model.ts", "./activity-pause-model.ts", "./db.ts"]);
  assert.deepEqual(runtimeImports(source("activity-pause-model.ts")), []);
  for (const file of ["activity.ts", "activity-source.ts", "activity-sources.ts", "acquisitions-activity.ts", "downloads-activity.ts",
    "series-acquisition-activity.ts", "alignment-activity.ts", "hardcover-activity.ts", "ebook-set-activity.ts", "backups-activity.ts"]) {
    const imports = runtimeImports(source(file));
    assert.ok(imports.every((path) => path === "./activity-source.ts" || path === "./activity-pause-model.ts" || path === "./activity-sources.ts"
      || /^\.\/[a-z-]+-activity\.ts$/.test(path) || path === "fastify" || path === "./backup-schedule.ts" || path === "./work-cover.ts" || path === "../src/reading-types.ts"),
      `${file} imports ${imports.join(", ")}`);
  }
  assert.deepEqual(runtimeImports(source("backup-schedule.ts")), [], "the backup rules are pure");
  // The cover rule takes the database it is given (#514): it opens none, so the sources stay free of the database.
  assert.deepEqual(runtimeImports(source("work-cover.ts")), ["./placeholder-edition.ts"]);
  assert.deepEqual(runtimeImports(source("placeholder-edition.ts")), []);
});

// Series acquisition reads its vocabulary from the CHECK constraint of a real database built here.
const temp = mkdtempSync(join(tmpdir(), "sonder-activity-sources-"));
after(() => rmSync(temp, { recursive: true, force: true }));

test("series acquisition: every status the CHECK constraint allows maps to its Activity state; failed shows its error (#397)", async () => {
  process.env.DATA_DIR = join(temp, "db");
  process.env.MEDIA_ROOT = join(temp, "media");
  process.env.REQUIRE_MEDIA_MOUNT = "false";
  const { sqlite } = await import("../server/db.ts");
  const table = (sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'series_acquisition_jobs'").get() as { sql: string }).sql;
  const check = /status TEXT NOT NULL CHECK\(status IN \(([^)]*)\)\)/.exec(table);
  assert.ok(check, table);
  const allowed = check[1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
  const expected = { pending: "queued", searching: "running", done: "done", failed: "failed" } satisfies Record<SeriesAcquisitionJobStatus, ActivityState>;
  assert.deepEqual([...allowed].sort(), Object.keys(expected).sort(), "the walk covers what the table allows");

  sqlite.prepare("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(7,'Ender','Card',4)").run();
  allowed.forEach((status, index) => {
    sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'Card','','',2000)").run(`w-${status}`, `Volume ${index + 1}`);
    sqlite.prepare("INSERT INTO series_acquisition_jobs(id,user_id,series_id,book_id,work_id,kind,status,error,updated_at) VALUES(?,1,7,?,?,'audio',?,?,?)")
      .run(`job-${status}`, index, `w-${status}`, status, status === "failed" ? "No release found" : null, NOW - 60 * MIN);
  });
  const deps = { sqlite, getSetting: () => undefined, pauseState: () => ({}), now: () => NOW } as unknown as ActivityDeps;
  const activity = await collectActivity(deps, { probes: false }, [seriesAcquisitionSource]);
  const byStatus = Object.fromEntries(activity.items.map((item) => [item.id.replace("series-acquisition:job-", ""), item]));
  for (const status of allowed) {
    assert.equal(byStatus[status].state, expected[status as SeriesAcquisitionJobStatus], status);
    assert.deepEqual(byStatus[status].facts, { kind: "series-acquisition", status, search: "audiobook" }, `${status}: the job's status word and kind`);
    assert.deepEqual(byStatus[status].actions, [], `${status}: a series search offers no action on Activity`);
  }
  assert.equal(byStatus.failed.error, "No release found", "the job's error text is shown");
  assert.equal(byStatus.failed.stuck, null, "an hour after it failed, a failed job is not stuck");
  assert.equal(byStatus.searching.stuck?.reason, "No change for 60 min", "a search that stopped changing still is");
  const loop = activity.processes.find((process) => process.id === "series-acquisition")!;
  assert.equal(loop.counts.failed, 1);
  assert.equal(loop.reason, "1 failed, 1 stuck");
});

test("series acquisition: a skip for missing permission and a manual takeover are done, not failed", async () => {
  const { SERIES_ACQUISITION_CANCELLED_ERROR } = await import("../server/series-acquisition.ts");
  const { SERIES_EXPECTED_OUTCOMES } = await import("../server/series-acquisition-activity.ts");
  assert.ok(SERIES_EXPECTED_OUTCOMES[SERIES_ACQUISITION_CANCELLED_ERROR], "the cancel code the feature writes is covered");
  assert.ok(SERIES_EXPECTED_OUTCOMES.no_permission);
  const { drafts } = seriesAcquisitionSource.report([
    seriesRow("failed", "no_permission"), seriesRow("failed", SERIES_ACQUISITION_CANCELLED_ERROR), seriesRow("failed", "No release found"),
  ] as never, undefined as never, undefined as never);
  assert.deepEqual(drafts.map((draft) => [draft.state, draft.error]), [["done", null], ["done", null], ["failed", "No release found"]]);
  assert.match(drafts[0].detail ?? "", /skipped, no permission/);
  assert.match(drafts[1].detail ?? "", /manual choice/);
});
