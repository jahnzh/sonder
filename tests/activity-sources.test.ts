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
import type { ActivityKind, ActivityState } from "../src/types.ts";
import type { AlignmentJob } from "../src/reading-types.ts";
import { ACQUISITION_STATUSES, SERVER_COPY_STATUSES, type AcquisitionJobStatus, type ServerCopyStatus } from "../server/schema.ts";
import type { SeriesAcquisitionJobStatus } from "../server/series-acquisition.ts";
import { ChangeTracker, buildActivity, collectActivity, registerActivity, type ActivityDeps } from "../server/activity.ts";
import { UNKNOWN_STATUS, defineSource, type ActivitySource } from "../server/activity-source.ts";
import { ACTIVITY_SOURCES } from "../server/activity-sources.ts";
import { acquisitionSource } from "../server/acquisitions-activity.ts";
import { serverCopySource } from "../server/downloads-activity.ts";
import { seriesAcquisitionSource } from "../server/series-acquisition-activity.ts";
import { alignmentSource } from "../server/alignment-activity.ts";
import { hardcoverSource, hardcoverQueueStatus, type HardcoverQueueStatus } from "../server/hardcover-activity.ts";
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
const hardcoverRow = (error: string | null) => ({ userId: 1, user: "admin", queue: "status" as const, count: 1, oldest: NOW - MIN, newest: NOW - MIN, error });

test("acquisitions: every status the writers use maps to its Activity state", () => {
  const expected = {
    checking: "running", preparing: "running", downloading: "running", paused: "paused", ready: "done", error: "failed",
  } satisfies Record<AcquisitionJobStatus, ActivityState>;
  assert.deepEqual(Object.keys(expected).sort(), [...ACQUISITION_STATUSES].sort(), "the walk covers the whole vocabulary");
  for (const status of ACQUISITION_STATUSES) {
    const item = itemFor(acquisitionSource, acquisitionRow(status));
    assert.equal(item.state, expected[status], status);
    assert.equal(item.error, null, status);
  }
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
  }
});

test("alignment: every status of the job record maps to its Activity state", () => {
  const expected = {
    queued: "queued", copying: "running", processing: "running", paused: "paused",
    cancelled: "done", ready: "done", partial: "done", error: "failed",
  } satisfies Record<AlignmentJob["status"], ActivityState>;
  for (const status of Object.keys(expected) as Array<AlignmentJob["status"]>) {
    const item = itemFor(alignmentSource, alignmentRow(status));
    assert.equal(item.state, expected[status], status);
  }
  const missing = itemFor(alignmentSource, { ...alignmentRow("x"), data: JSON.stringify({ progress: 0.5 }) });
  assert.equal(missing.state, "queued", "a record without a status has not started");
});

test("Hardcover queues: waiting is queued and failing is failed", () => {
  const expected = { waiting: "queued", failing: "failed" } satisfies Record<HardcoverQueueStatus, ActivityState>;
  assert.equal(hardcoverQueueStatus(null), "waiting");
  assert.equal(hardcoverQueueStatus("socket hang up"), "failing");
  assert.equal(itemFor(hardcoverSource, hardcoverRow(null)).state, expected.waiting);
  assert.equal(itemFor(hardcoverSource, hardcoverRow("socket hang up")).state, expected.failing);
});

test("a stored status outside a source's vocabulary is failed with Unknown status, never running", () => {
  const cases: Array<[ActivitySource<unknown, unknown>, unknown]> = [
    [acquisitionSource, acquisitionRow("exploded")],
    [acquisitionSource, acquisitionRow("complete")],
    [serverCopySource, copyRow("exploded")],
    [seriesAcquisitionSource, seriesRow("error")],
    [alignmentSource, alignmentRow("exploded")],
  ];
  for (const [source, row] of cases) {
    const item = itemFor(source, row, NOW + 24 * 60 * MIN);
    assert.equal(item.state, "failed", item.id);
    assert.equal(item.error, `${UNKNOWN_STATUS} "${(row as { status?: string }).status ?? "exploded"}"`, item.id);
    assert.equal(item.stuck, null, `${item.id}: a failed item is not reported as stuck`);
  }
});

test("every loop has exactly one source and every kind is reported", () => {
  const kinds: Record<ActivityKind, true> = { acquisition: true, "server-copy": true, "series-acquisition": true, alignment: true, hardcover: true };
  assert.deepEqual(ACTIVITY_SOURCES.map((source) => source.kind).sort(), Object.keys(kinds).sort());
  assert.deepEqual(ACTIVITY_SOURCES.map((source) => source.process.id).sort(), [...PAUSABLE_PROCESSES].sort());
});

test("Retry and Discard go to the source whose kind prefixes the item id", async () => {
  const calls: string[] = [];
  const fake = (kind: ActivityKind, withActions: boolean) => defineSource<never[]>({
    kind, process: { id: "alignment", label: kind }, stuckAfterMs: MIN, load: () => [], report: () => ({ drafts: [] }),
    ...(withActions ? {
      retry: async (id) => { calls.push(`${kind} retry ${id}`); return { ok: true }; },
      discard: async (id) => { calls.push(`${kind} discard ${id}`); return { ok: true, discarded: 0 }; },
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
  assert.deepEqual(calls, ["alignment retry alignment:job-1", "alignment discard alignment:job-2"]);
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
    "series-acquisition-activity.ts", "alignment-activity.ts", "hardcover-activity.ts"]) {
    const imports = runtimeImports(source(file));
    assert.ok(imports.every((path) => path === "./activity-source.ts" || path === "./activity-pause-model.ts" || path === "./activity-sources.ts"
      || /^\.\/[a-z-]+-activity\.ts$/.test(path) || path === "fastify"), `${file} imports ${imports.join(", ")}`);
  }
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
  for (const status of allowed) assert.equal(byStatus[status].state, expected[status as SeriesAcquisitionJobStatus], status);
  assert.equal(byStatus.failed.error, "No release found", "the job's error text is shown");
  assert.equal(byStatus.failed.stuck, null, "an hour after it failed, a failed job is not stuck");
  assert.equal(byStatus.searching.stuck?.reason, "No change for 60 min", "a search that stopped changing still is");
  const loop = activity.processes.find((process) => process.id === "series-acquisition")!;
  assert.equal(loop.counts.failed, 1);
  assert.equal(loop.reason, "1 failed, 1 stuck");
});
