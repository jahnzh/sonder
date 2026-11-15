#!/usr/bin/env node
// Read-only alignment status: where is this job and why.
// Usage: node scripts/alignment-status.mjs [jobId|recordingId|workId] [--db <path>] [--health-url <url>] [--json]
// Opens SQLite with readonly:true and never executes INSERT/UPDATE/DELETE.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const HEALTH_TIMEOUT_MS = 3000;

export function defaultDbPath(env = process.env) {
  return path.resolve(env.DATA_DIR || "data", "sonder.db");
}

export function openReadOnly(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function parseData(row) {
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

/** Summarise one alignment_jobs row (with its parsed JSON data). */
export function summarizeJob(row) {
  const d = parseData(row);
  const anchors = d.anchoring?.anchors;
  const passages = Array.isArray(d.unsyncedPassages) ? d.unsyncedPassages : null;
  return {
    id: row.id,
    ebookId: row.ebook_id,
    recordingId: row.recording_id,
    status: d.status ?? "unknown",
    outcome: row.outcome ?? d.outcome ?? null,
    engine: row.engine ?? d.engine ?? null,
    progress: d.progress ?? null,
    error: d.error ?? null,
    warning: d.warning ?? null,
    origin: d.origin ?? null,
    mode: d.mode ?? null,
    poolHost: d.pool?.hostId ?? null,
    poolWorkerUrl: d.pool?.workerUrl ?? null,
    poolAttempt: d.pool?.attempt ?? null,
    triedHosts: d.pool?.triedHosts ?? [],
    poolErrors: d.poolErrors ?? {},
    device: d.ctcDevice ?? null,
    precision: d.ctcPrecision ?? null,
    gpuUtilization: typeof d.gpuUtilization === "number" ? d.gpuUtilization : null,
    anchors: Array.isArray(anchors) ? anchors.length : null,
    anchorStage: d.anchoring?.stage ?? null,
    coverage: typeof d.coverage === "number" ? d.coverage : null,
    intervals: Array.isArray(d.intervals) ? d.intervals.length : null,
    unsyncedPassages: passages ? passages.length : null,
    unsyncedSentences: passages ? passages.reduce((n, p) => n + (p.sentenceCount || 0), 0) : null,
    updatedAt: row.updated_at,
  };
}

/** Resolve an id to jobs: job id, recording id, or work id (in that order). */
export function resolveJobs(db, id) {
  if (!hasTable(db, "alignment_jobs")) return { kind: "none", workId: null, jobs: [] };
  const cols = "id,ebook_id,recording_id,data,updated_at,engine,outcome";
  const job = db.prepare(`SELECT ${cols} FROM alignment_jobs WHERE id=?`).get(id);
  if (job) {
    return { kind: "job", workId: workIdForEbook(db, job.ebook_id), jobs: [job] };
  }
  const byRecording = db.prepare(`SELECT ${cols} FROM alignment_jobs WHERE recording_id=? ORDER BY updated_at DESC`).all(id);
  if (byRecording.length) {
    return { kind: "recording", workId: workIdForEbook(db, byRecording[0].ebook_id), jobs: byRecording };
  }
  const byWork = db
    .prepare(
      `SELECT ${cols.split(",").map((c) => "j." + c).join(",")} FROM alignment_jobs j
       JOIN ebook_editions e ON e.id=j.ebook_id WHERE e.work_id=? ORDER BY j.updated_at DESC`,
    )
    .all(id);
  if (byWork.length) return { kind: "work", workId: id, jobs: byWork };
  if (hasTable(db, "works") && db.prepare("SELECT 1 FROM works WHERE id=?").get(id)) {
    return { kind: "work", workId: id, jobs: [] };
  }
  return { kind: "none", workId: null, jobs: [] };
}

function workIdForEbook(db, ebookId) {
  if (!hasTable(db, "ebook_editions")) return null;
  return db.prepare("SELECT work_id FROM ebook_editions WHERE id=?").get(ebookId)?.work_id ?? null;
}

export function listRecentJobs(db, limit = 10) {
  if (!hasTable(db, "alignment_jobs")) return [];
  return db
    .prepare("SELECT id,ebook_id,recording_id,data,updated_at,engine,outcome FROM alignment_jobs ORDER BY updated_at DESC LIMIT ?")
    .all(limit);
}

/** Ebook-set members for a work (empty when the tables or work are absent). */
export function ebookSetMembers(db, workId) {
  if (!workId || !hasTable(db, "work_ebook_set_members")) return { set: null, members: [] };
  const set = hasTable(db, "work_ebook_set")
    ? db
        .prepare("SELECT recording_id,consensus_job_id,default_ebook_id,default_ebook_override FROM work_ebook_set WHERE work_id=?")
        .get(workId) ?? null
    : null;
  const members = db
    .prepare(
      "SELECT ebook_id,status,hold_reason,source_title,language,byte_size FROM work_ebook_set_members WHERE work_id=? ORDER BY ebook_id",
    )
    .all(workId);
  return { set, members };
}

/** GET <url>/health with a timeout; never throws. */
export async function checkHealth(url, { timeoutMs = HEALTH_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!url) return { url: null, state: "unconfigured", detail: "no worker URL (set ALIGNMENT_POOL_WSL_WORKER_URL or --health-url)" };
  const target = `${url.replace(/\/$/, "")}/health`;
  try {
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { url: target, state: res.ok ? "ok" : "http_error", httpStatus: res.status, body };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { url: target, state: timedOut ? "timeout" : "unreachable", detail: String(error?.message ?? error) };
  }
}

export async function buildReport(db, id, { healthUrl, fetchImpl, timeoutMs } = {}) {
  const report = { query: id ?? null, kind: "recent", workId: null, jobs: [], ebookSet: { set: null, members: [] }, health: null };
  if (id) {
    const resolved = resolveJobs(db, id);
    report.kind = resolved.kind;
    report.workId = resolved.workId;
    report.jobs = resolved.jobs.map(summarizeJob);
    report.ebookSet = ebookSetMembers(db, resolved.workId);
  } else {
    report.jobs = listRecentJobs(db).map(summarizeJob);
  }
  report.health = await checkHealth(healthUrl, { fetchImpl, timeoutMs });
  return report;
}

const pct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const val = (v) => (v == null || v === "" ? "-" : String(v));

export function formatReport(report) {
  const out = [];
  if (report.query && report.kind === "none") out.push(`No job, recording or work found for "${report.query}".`);
  else if (report.query) out.push(`Query "${report.query}" matched a ${report.kind}${report.workId ? ` (work ${report.workId})` : ""}.`);
  else out.push("No id given; showing the most recent jobs.");
  for (const j of report.jobs) {
    out.push(
      "",
      `Job ${j.id}  status=${j.status} outcome=${val(j.outcome)} progress=${val(j.progress)}`,
      `  ebook=${j.ebookId} recording=${j.recordingId} engine=${val(j.engine)} origin=${val(j.origin)} mode=${val(j.mode)}`,
      `  pool host=${val(j.poolHost)} device=${val(j.device)} precision=${val(j.precision)} attempt=${val(j.poolAttempt)} tried=${j.triedHosts.join(",") || "-"}`,
      `  gpuUtilization=${j.gpuUtilization == null ? "n/a" : `${Math.round(j.gpuUtilization)}%`}`,
      `  anchors=${val(j.anchors)} (stage ${val(j.anchorStage)}) coverage=${pct(j.coverage)} intervals=${val(j.intervals)} unsynced=${val(j.unsyncedSentences)} sentences in ${val(j.unsyncedPassages)} passages`,
      `  updated=${j.updatedAt ? new Date(j.updatedAt).toISOString() : "-"}`,
    );
    if (j.error) out.push(`  error: ${j.error}`);
    if (j.warning) out.push(`  warning: ${j.warning}`);
    for (const [host, msg] of Object.entries(j.poolErrors)) out.push(`  pool error ${host}: ${msg}`);
  }
  if (report.query && report.kind !== "none" && !report.jobs.length) out.push("", "No alignment jobs for this work.");
  if (report.workId) {
    out.push("", `Ebook set for work ${report.workId}:`);
    const { set, members } = report.ebookSet;
    if (set) out.push(`  recording=${val(set.recording_id)} consensusJob=${val(set.consensus_job_id)} default=${val(set.default_ebook_override ?? set.default_ebook_id)}`);
    if (!members.length) out.push("  (no members)");
    for (const m of members) {
      out.push(`  ${m.ebook_id}  ${m.status}${m.hold_reason ? ` (${m.hold_reason})` : ""}  ${val(m.source_title)} [${val(m.language)}]`);
    }
  }
  const h = report.health;
  out.push("", `Worker health: ${h.state}${h.url ? ` ${h.url}` : ""}${h.httpStatus ? ` HTTP ${h.httpStatus}` : ""}${h.detail ? ` - ${h.detail}` : ""}`);
  if (h.body) out.push(`  ${JSON.stringify(h.body)}`);
  return out.join("\n");
}

export function parseArgs(argv) {
  const opts = { id: undefined, db: undefined, healthUrl: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--db") opts.db = argv[++i];
    else if (a === "--health-url") opts.healthUrl = argv[++i];
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else opts.id = a;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  const db = openReadOnly(opts.db ?? defaultDbPath(env));
  try {
    // Production runs no alignment worker (#279): default to the WSL pool worker, the server's first host.
    const healthUrl = opts.healthUrl ?? env.ALIGNMENT_POOL_WSL_WORKER_URL ?? "http://192.168.1.119:3012";
    const report = await buildReport(db, opts.id, { healthUrl });
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.query && report.kind === "none" ? 1 : 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
}
