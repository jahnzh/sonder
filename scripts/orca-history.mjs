#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllJsonValues } from "./orca-check.mjs";
import { documentedLastingBucketId } from "./orca-routing.mjs";
import { defaultStateDir as defaultUsageStateDir, UsageStore } from "./orca-usage.mjs";

const SCHEMA = 1;
const UNKNOWN = "unknown";
const MAX_TRANSCRIPT_PAGES = 200;
const PAGE_LIMIT = 50;
const LINK_KINDS = ["fix_of", "review_of", "retry_of"];
const CHECK_RESULTS = ["pass", "pass_with_known_failures", "fail", "aborted", "unknown"];
const SEVERITIES = ["blocking", "high", "medium", "low"];
const AGENT_VERSION_COMMANDS = { claude: ["claude", "--version"], cursor: ["agent", "--version"], antigravity: ["agy", "--version"], codex: ["codex", "--version"] };
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
const SHARED_PREFIX = "use_";

const USAGE = `Usage: node scripts/orca-history.mjs <command> [options]

Keeps a local record of what happened to each worker, so later recommendations rest on evidence.
Records and transcripts live in --dir (default: $ORCA_HISTORY_DIR, else artifacts/orca/history under the main checkout).
The main checkout is the parent of git rev-parse --git-common-dir, so every worktree shares one store; outside a git repo the current checkout is used.
Information that cannot be established is stored as "unknown"; nothing is guessed or linked without evidence.

  capture --dispatch <id> [--recommendation <file>] [--kind <kind>] [--files <n>] [--agent-version <text>] [--no-transcript]
      Reads the dispatch from Orca (worker-show, worker-read) and creates or updates its record and transcript.
      --recommendation is the JSON printed by scripts/orca-recommend.mjs for this task.
  record-check --dispatch <id> --name <name> (--result <${CHECK_RESULTS.join("|")}> | --report <report.json>) [--commit <sha>] [--source <text>]
  record-review --dispatch <id> [--blocking <n>] [--high <n>] [--medium <n>] [--low <n>] [--reviewer-dispatch <id>] [--evidence <text>]
  link --from <id> --to <id> --kind <${LINK_KINDS.join("|")}> --evidence <text>
      --from is the later work: the fix, the review or the retry. Both records must exist.
  record-usage --dispatch <id> --source <meter> --metric <name>=<number>...
      Usage that a per-worker meter attributes to this worker alone. Never derived from a shared change.
  record-shared-usage --provider <agent> --before <observation.json> --after <observation.json> --workers <id,id,...>
      Keeps the change between two usage observations of one allowance, shared by the listed workers and anything else on the account.
  record-bucket-cost --dispatch <id> [--usage-dir <dir>] [--bucket <id>] [--delta <n>] [--before <n>] [--after <n>]
      Keeps the percent delta of the worker's binding bucket over its lifetime. Defaults to querying the usage collector.
  list                    Summaries of every record (no transcripts).
  show --id <id>          One record, or one shared usage change (no transcripts).
  transcript --id <id>    The redacted transcript. For reference only: planning and learning read records, never this.
  delete --id <id>        One record with its transcript, or one shared usage change.
  delete --all --yes      Everything.

Exit codes: 0 done, 1 failed (missing record, Orca error, refused input), 2 bad usage.
Reads ORCA_CLI_COMMAND (default orca). ORCA_HISTORY_NOW replaces the clock (tests).`;

class HistoryError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Redaction

function envSecrets(env) {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.trim().length >= 8)
    .map(([, value]) => value.trim())
    .sort((a, b) => b.length - a.length);
}

/** Credential-looking key names: whole value is redacted (quoted value, or to end of line when unquoted). */
const CREDENTIAL_KEY =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|token|authorization|bearer|cookie|credential)/i;

/**
 * Removes credentials from text: the values of secret-looking environment variables, credential-named
 * key=value / key: value / JSON forms (whole value), and common token shapes.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 */
export function redactText(text, env = process.env) {
  let out = String(text);
  for (const secret of envSecrets(env)) out = out.replaceAll(secret, "[redacted]");
  out = out.replace(
    new RegExp(
      String.raw`(["']?)([A-Za-z0-9_]*${CREDENTIAL_KEY.source}[A-Za-z0-9_]*)\1(\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\r\n]*))`,
      "gi",
    ),
    (_match, quote, key, sep, doubleQuoted, singleQuoted, _unquoted) => {
      if (doubleQuoted !== undefined) return `${quote}${key}${quote}${sep}"[redacted]"`;
      if (singleQuoted !== undefined) return `${quote}${key}${quote}${sep}'[redacted]'`;
      return `${quote}${key}${quote}${sep}[redacted]`;
    },
  );
  return out
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, "Basic [redacted]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\b1\/\/[A-Za-z0-9._-]{20,}/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{16,}/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[redacted]");
}

function redactDeep(value, env) {
  if (typeof value === "string") return redactText(value, env);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, env)]));
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Store

const safeId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);

function requireId(id, what) {
  if (!safeId(id)) throw new HistoryError(`${what} must be an identifier of letters, digits, '.', '_' or '-'`);
  return id;
}

/** A directory of JSON records, one transcript per record, and shared usage changes. Every write is atomic. */
export function openStore(dir) {
  const records = path.join(dir, "records");
  const transcripts = path.join(dir, "transcripts");
  const shared = path.join(dir, "shared-usage");
  const ensure = () => {
    for (const d of [dir, records, transcripts, shared]) mkdirSync(d, { recursive: true, mode: 0o700 });
  };
  const write = (file, text) => {
    ensure();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  };
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new HistoryError(`cannot read ${path.basename(file)}: ${error.message}`);
    }
  };
  const ids = (d) => (existsSync(d) ? readdirSync(d).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort() : []);
  return {
    dir,
    recordIds: () => ids(records),
    sharedIds: () => ids(shared),
    getRecord: (id) => readJson(path.join(records, `${requireId(id, "id")}.json`)),
    putRecord: (record) => write(path.join(records, `${requireId(record.id, "id")}.json`), `${JSON.stringify(record, null, 2)}\n`),
    getShared: (id) => readJson(path.join(shared, `${requireId(id, "id")}.json`)),
    putShared: (entry) => write(path.join(shared, `${requireId(entry.id, "id")}.json`), `${JSON.stringify(entry, null, 2)}\n`),
    transcriptPath: (id) => path.join(transcripts, `${requireId(id, "id")}.jsonl`),
    readTranscript: (id) => {
      try {
        return readFileSync(path.join(transcripts, `${requireId(id, "id")}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new HistoryError(`cannot read the transcript of ${id}: ${error.message}`);
      }
    },
    putTranscript: (id, entries) => write(path.join(transcripts, `${requireId(id, "id")}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "")),
    deleteRecord: (id) => {
      requireId(id, "id");
      const had = existsSync(path.join(records, `${id}.json`));
      rmSync(path.join(records, `${id}.json`), { force: true });
      rmSync(path.join(transcripts, `${id}.jsonl`), { force: true });
      return had;
    },
    deleteShared: (id) => {
      requireId(id, "id");
      const had = existsSync(path.join(shared, `${id}.json`));
      rmSync(path.join(shared, `${id}.json`), { force: true });
      return had;
    },
    deleteAll: () => {
      const counts = { records: ids(records).length, sharedUsage: ids(shared).length };
      for (const d of [records, transcripts, shared]) rmSync(d, { recursive: true, force: true });
      return counts;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Orca

/** The `result` of an Orca receipt, which may follow keepalive lines. */
export function parseOrcaReceipt(text) {
  for (const value of parseAllJsonValues(text)) {
    if (!value || typeof value !== "object" || value._keepalive === true || value._heartbeat === true) continue;
    if (value.ok === true && value.result && typeof value.result === "object") return value.result;
    if (value.ok === false) throw new HistoryError(`Orca refused: ${value.error?.message ?? value.error?.code ?? "no reason given"}`);
  }
  throw new HistoryError("Orca printed no JSON receipt");
}

function orca(args, env) {
  const command = env.ORCA_CLI_COMMAND || "orca";
  const run = spawnSync(command, ["orchestration", ...args, "--json"], { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024, env });
  if (run.error) throw new HistoryError(`cannot run ${command}: ${run.error.message}`);
  return parseOrcaReceipt(`${run.stdout}\n${run.stderr}`);
}

function installedVersion(agent, env) {
  const argv = AGENT_VERSION_COMMANDS[agent];
  if (!argv) return null;
  const run = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 10000, env });
  const text = run.status === 0 ? run.stdout.trim().split("\n")[0] : "";
  return text ? text.slice(0, 120) : null;
}

/** True only when the dispatch's host is this machine, so a local `agent --version` is the worker's. */
export function isLocalWorkerHost(host) {
  if (!host || host === UNKNOWN) return false;
  if (typeof host === "string") return host === "local";
  if (typeof host === "object") {
    const kind = host.kind ?? host.hostKind;
    const id = host.id ?? host.hostId;
    return kind === "local" || id === "local";
  }
  return false;
}

/** Orca stamps dispatches as UTC "YYYY-MM-DD HH:MM:SS". */
function orcaTime(text) {
  if (typeof text !== "string" || !text) return null;
  const ms = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const known = (value) => (value === undefined || value === null || value === "" ? UNKNOWN : value);
const isKnown = (value) => value !== undefined && value !== null && value !== "" && value !== UNKNOWN;

/** The fields of a worker-show receipt that belong in a record. Terminal previews, titles, paths and the spec are not kept. */
export function observeDispatch(show) {
  const dispatch = show.dispatch ?? {};
  const worker = show.worker ?? {};
  const launch = worker.startOptions?.launch ?? {};
  const projection = show.projection ?? {};
  const branch = typeof show.terminal?.branch === "string" ? show.terminal.branch.replace(/^refs\/heads\//, "") : null;
  return {
    dispatchId: dispatch.id ?? projection.dispatchId ?? null,
    taskId: dispatch.taskId ?? projection.taskId ?? null,
    runId: dispatch.runId ?? projection.runId ?? null,
    agent: {
      name: known(worker.startOptions?.agent ?? projection.provider?.id),
      requestedModel: known(launch.requested?.model),
      effectiveModel: known(launch.effective?.model),
      requestedEffort: known(launch.requested?.effort),
      effectiveEffort: known(launch.effective?.effort),
    },
    host: projection.host ?? dispatch.hostScope ?? null,
    branch,
    baseBranch: worker.startOptions?.baseBranch ?? null,
    state: {
      dispatchStatus: known(dispatch.status),
      workerState: known(worker.state),
      outcome: known(projection.outcome),
    },
    dispatchedAt: orcaTime(dispatch.dispatchedAt),
    completedAt: orcaTime(dispatch.completedAt),
    failureCount: Number.isInteger(dispatch.failureCount) ? dispatch.failureCount : null,
    retryOf: dispatch.retryOfDispatchId ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Records

function newRecord(id, now) {
  return {
    schema: SCHEMA,
    id,
    dispatchId: id,
    taskId: UNKNOWN,
    runId: UNKNOWN,
    capturedAt: now,
    updatedAt: now,
    task: { type: UNKNOWN, typeSource: UNKNOWN, files: UNKNOWN, difficulty: UNKNOWN, difficultySource: UNKNOWN, jevVersion: UNKNOWN, jevUncertainty: null },
    agent: { name: UNKNOWN, requestedModel: UNKNOWN, effectiveModel: UNKNOWN, requestedEffort: UNKNOWN, effectiveEffort: UNKNOWN },
    versions: { agent: UNKNOWN, model: UNKNOWN, jev: UNKNOWN },
    host: UNKNOWN,
    branch: UNKNOWN,
    baseBranch: UNKNOWN,
    selection: { status: UNKNOWN },
    lifecycle: { dispatchStatus: UNKNOWN, workerState: UNKNOWN, outcome: UNKNOWN, dispatchedAt: UNKNOWN, completedAt: UNKNOWN, events: [] },
    retries: { failureCount: UNKNOWN, retryOf: null },
    signals: { checks: [], reviews: [] },
    links: [],
    usage: { attributable: [], shared: [], bucketCost: null },
    transcript: { status: UNKNOWN },
  };
}

/** Replaces a field only when the new value is known, so a later capture never erases earlier evidence. */
const prefer = (current, next) => (isKnown(next) ? next : current);

function selectionFrom(recommendation, observed) {
  const decision = recommendation.decision;
  if (!decision || typeof decision !== "object") return { status: UNKNOWN, reason: "the recommendation file names no decision" };
  const launched = observed.agent;
  const effortMatches = !isKnown(decision.effort) || !isKnown(launched.effectiveEffort) || decision.effort === launched.effectiveEffort;
  const launchMatchesDecision = isKnown(launched.effectiveModel) ? launched.name === decision.agent && launched.effectiveModel === decision.model && effortMatches : UNKNOWN;
  const recommended = recommendation.recommendation
    ? { agent: recommendation.recommendation.agent, model: recommendation.recommendation.model, effort: known(recommendation.recommendation.effort) }
    : null;
  return {
    status: "recorded",
    kind: decision.kind === "override" ? "override" : "recommendation",
    recommended,
    chosen: { agent: decision.agent, model: decision.model, effort: known(decision.effort) },
    reason: known(decision.reason),
    warning: decision.warning ?? null,
    fallback: recommendation.fallback ? { because: known(recommendation.fallback.because), requirement: known(recommendation.fallback.requirement) } : null,
    launchMatchesDecision,
    // An override says only that the coordinator chose differently; it does not say which choice was right.
    note: "an override is a choice, not a label of the recommendation being wrong",
  };
}

function applyRecommendation(record, recommendation, observed) {
  const assessment = recommendation.assessment ?? {};
  const requirement = ["mechanical", "standard", "reasoning-heavy"].includes(assessment.requirement) ? assessment.requirement : null;
  if (requirement) {
    record.task.difficulty = requirement;
    record.task.difficultySource = assessment.source === "jev" ? "jev" : assessment.source === "coordinator" ? "coordinator" : UNKNOWN;
  }
  if (assessment.jev?.version) record.versions.jev = assessment.jev.version;
  record.task.jevVersion = record.versions.jev;
  if (assessment.jev?.uncertainty) record.task.jevUncertainty = assessment.jev.uncertainty;
  if (recommendation.request?.kind) {
    record.task.type = recommendation.request.kind;
    record.task.typeSource = "recommendation";
  }
  if (Number.isInteger(recommendation.request?.files)) record.task.files = recommendation.request.files;
  record.selection = selectionFrom(recommendation, observed);
}

/** Merges what Orca reports now into the record. Lifecycle events are appended only when the state changed. */
export function mergeObservation(record, observed, now) {
  record.taskId = prefer(record.taskId, observed.taskId);
  record.runId = prefer(record.runId, observed.runId);
  for (const key of Object.keys(record.agent)) record.agent[key] = prefer(record.agent[key], observed.agent[key]);
  record.versions.model = record.agent.effectiveModel;
  record.host = prefer(record.host, observed.host);
  record.branch = prefer(record.branch, observed.branch);
  record.baseBranch = prefer(record.baseBranch, observed.baseBranch);
  const lifecycle = record.lifecycle;
  lifecycle.dispatchedAt = prefer(lifecycle.dispatchedAt, observed.dispatchedAt);
  lifecycle.completedAt = prefer(lifecycle.completedAt, observed.completedAt);
  const last = lifecycle.events.at(-1);
  const state = observed.state;
  if (!last || last.dispatchStatus !== state.dispatchStatus || last.workerState !== state.workerState || last.outcome !== state.outcome) {
    lifecycle.events.push({ at: now, ...state });
  }
  Object.assign(lifecycle, state);
  if (observed.failureCount !== null) record.retries.failureCount = observed.failureCount;
  if (observed.retryOf) {
    record.retries.retryOf = observed.retryOf;
    if (!record.links.some((link) => link.kind === "retry_of" && link.target === observed.retryOf)) {
      record.links.push({ kind: "retry_of", target: observed.retryOf, evidence: "Orca dispatch.retryOfDispatchId", at: now });
    }
  }
  record.updatedAt = now;
}

function elapsedOf(lifecycle) {
  if (!isKnown(lifecycle.dispatchedAt) || !isKnown(lifecycle.completedAt)) return { status: UNKNOWN, reason: "the dispatch has not completed or its times were not reported" };
  return { status: "known", ms: Math.max(0, Date.parse(lifecycle.completedAt) - Date.parse(lifecycle.dispatchedAt)), from: lifecycle.dispatchedAt, to: lifecycle.completedAt };
}

/**
 * The inspectable form of a record. Quality signals stay separate (completion, checks, reviews, follow-up fixes,
 * retries and elapsed time) and there is deliberately no combined score. Transcript text is never included.
 */
export function viewRecord(store, record) {
  const incoming = store.recordIds().flatMap((id) => {
    if (id === record.id) return [];
    const other = store.getRecord(id);
    return (other?.links ?? []).filter((link) => link.target === record.id).map((link) => ({ id: other.id, kind: link.kind, evidence: link.evidence, at: link.at }));
  });
  const followUps = incoming.filter((link) => link.kind === "fix_of");
  const retriedBy = incoming.filter((link) => link.kind === "retry_of");
  const reviewedBy = incoming.filter((link) => link.kind === "review_of");
  const sharedUsage = record.usage.shared.flatMap((id) => {
    const entry = store.getShared(id);
    return entry ? [{ id: entry.id, provider: entry.provider, account: entry.account, from: entry.from, to: entry.to, windows: entry.windows, attribution: entry.attribution, perWorkerCost: entry.perWorkerCost, workers: entry.workers }] : [];
  });
  const { checks, reviews } = record.signals;
  return {
    id: record.id,
    taskId: record.taskId,
    runId: record.runId,
    capturedAt: record.capturedAt,
    updatedAt: record.updatedAt,
    task: record.task,
    agent: record.agent,
    versions: record.versions,
    host: record.host,
    branch: record.branch,
    baseBranch: record.baseBranch,
    selection: record.selection,
    lifecycle: record.lifecycle,
    signals: {
      completion: { status: record.lifecycle.outcome, note: "the worker's reported outcome, not a judgment of quality" },
      checks: checks.length ? { status: "recorded", entries: checks } : { status: UNKNOWN },
      reviews: reviews.length ? { status: "recorded", entries: reviews, reviewedBy } : reviewedBy.length ? { status: "recorded", entries: [], reviewedBy } : { status: UNKNOWN },
      followUpFixes: followUps.length ? { status: "linked", entries: followUps } : { status: UNKNOWN, reason: "no fix has been linked; that does not mean none was needed" },
      retries: { failureCount: record.retries.failureCount, retryOf: record.retries.retryOf, retriedBy },
      elapsed: elapsedOf(record.lifecycle),
    },
    usage: {
      attributable: record.usage.attributable?.length ? { status: "recorded", entries: record.usage.attributable } : { status: UNKNOWN, reason: "no per-worker meter has been recorded" },
      shared: sharedUsage,
      bucketCost: record.usage?.bucketCost ?? { status: UNKNOWN, reason: "no bucket cost delta recorded" },
    },
    links: record.links.map((link) => ({ ...link, targetState: store.getRecord(link.target) ? "recorded" : "not recorded" })),
    transcript: record.transcript,
  };
}

function summarize(view) {
  return {
    id: view.id,
    agent: `${view.agent.name}/${view.agent.effectiveModel}${isKnown(view.agent.effectiveEffort) ? `/${view.agent.effectiveEffort}` : ""}`,
    difficulty: view.task.difficulty,
    type: view.task.type,
    outcome: view.lifecycle.outcome,
    checks: view.signals.checks.status,
    reviews: view.signals.reviews.status,
    followUpFixes: view.signals.followUpFixes.status,
    bucketCost: view.usage.bucketCost?.valid
      ? `${view.usage.bucketCost.deltaPercent}% (${view.usage.bucketCost.bucketId})`
      : (view.usage.bucketCost?.status ?? UNKNOWN),
    elapsedMs: view.signals.elapsed.ms ?? UNKNOWN,
    transcript: view.transcript.status,
    updatedAt: view.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Transcripts

function readTranscriptPages(dispatch, env) {
  const messages = [];
  let cursor = null;
  let complete = true;
  const clipping = new Set();
  let source = UNKNOWN;
  for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page += 1) {
    const result = orca(["worker-read", "--dispatch", dispatch, "--limit", String(PAGE_LIMIT), ...(cursor ? ["--cursor", cursor] : [])], env);
    source = result.source ?? source;
    if (result.contentComplete === false) complete = false;
    for (const item of result.clipping ?? []) clipping.add(item);
    if (Array.isArray(result.transcript?.messages)) {
      for (const message of result.transcript.messages) messages.push({ kind: "message", ...message });
      cursor = result.transcript.limited ? result.transcript.nextCursor : null;
    } else if (Array.isArray(result.terminal?.tail)) {
      // Terminal output has no message ids, so a later capture replaces rather than extends it.
      for (const [index, line] of result.terminal.tail.entries()) messages.push({ kind: "terminal", id: `terminal-${index}`, text: line });
      cursor = null;
    } else {
      throw new HistoryError(`worker-read returned a shape this reader does not know (source ${source})`);
    }
    if (!cursor) return { messages, complete, clipping: [...clipping], source };
  }
  return { messages, complete: false, clipping: [...clipping, "page_limit"], source };
}

function captureTranscript(store, record, env, now) {
  try {
    const read = readTranscriptPages(record.id, env);
    const previous = store.readTranscript(record.id) ?? [];
    const merged = read.source === "terminal" ? read.messages : [...previous, ...read.messages.filter((m) => !previous.some((p) => p.id === m.id))];
    const entries = redactDeep(merged, env).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    store.putTranscript(record.id, entries);
    record.transcript = {
      status: "stored",
      source: read.source,
      messageCount: entries.length,
      complete: read.complete,
      clipping: read.clipping,
      capturedAt: now,
      note: "kept locally for reference; not read by recommendation or learning, and never sent to Jev",
    };
  } catch (error) {
    const kept = store.readTranscript(record.id);
    record.transcript = kept
      ? { ...record.transcript, lastAttempt: { at: now, status: "unavailable", reason: redactText(error.message, env).slice(0, 200) } }
      : { status: "unavailable", reason: redactText(error.message, env).slice(0, 200), attemptedAt: now };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

function need(record, id) {
  if (!record) throw new HistoryError(`no record for ${id}; capture it first`);
  return record;
}

/** Mutate a record, stamp updatedAt, redact and save. */
function mutate(store, record, env, now, fn) {
  fn(record);
  record.updatedAt = now;
  store.putRecord(redactDeep(record, env));
  return record;
}

function capture(store, options, env, now) {
  const id = requireId(options.dispatch, "--dispatch");
  const observed = observeDispatch(orca(["worker-show", "--dispatch", id], env));
  if (observed.dispatchId !== id) throw new HistoryError(`Orca answered for ${observed.dispatchId ?? "no dispatch"}, not ${id}`);
  const record = store.getRecord(id) ?? newRecord(id, now);
  mergeObservation(record, observed, now);
  if (options.recommendation) {
    let recommendation;
    try {
      recommendation = JSON.parse(readFileSync(options.recommendation, "utf8"));
    } catch (error) {
      throw new HistoryError(`cannot read the recommendation file: ${error.message}`);
    }
    applyRecommendation(record, recommendation, observed);
  }
  if (options.kind) {
    record.task.type = options.kind;
    record.task.typeSource = "coordinator";
  }
  if (options.files !== undefined) record.task.files = options.files;
  if (options.agentVersion) {
    record.versions.agent = { value: options.agentVersion, basis: "coordinator", observedAt: now };
  } else if (!isKnown(record.versions.agent) && isKnown(record.agent.name) && isLocalWorkerHost(record.host)) {
    const value = installedVersion(record.agent.name, env);
    if (value) record.versions.agent = { value, basis: "installed on this host when first captured", observedAt: now };
  }
  if (options.transcript !== false) captureTranscript(store, record, env, now);
  if (
    (!record.usage.bucketCost || record.usage.bucketCost.status === "unavailable" || options.refreshBucketCost) &&
    (record.lifecycle.outcome !== "in_progress" || isKnown(record.lifecycle.completedAt)) &&
    isKnown(record.lifecycle.dispatchedAt) &&
    isKnown(record.lifecycle.completedAt)
  ) {
    const usageDir = options.usageDir ?? defaultUsageStateDir(env);
    if (existsSync(path.join(usageDir, "usage.sqlite"))) {
      let usageStore = null;
      try {
        usageStore = new UsageStore(usageDir);
        const model = isKnown(record.agent.effectiveModel) ? record.agent.effectiveModel : record.agent.requestedModel;
        const cost = computeLifetimeBucketCost({
          agent: record.agent.name,
          model,
          dispatchedAt: record.lifecycle.dispatchedAt,
          completedAt: record.lifecycle.completedAt,
          usageStore,
        });
        if (cost && cost.status !== "unavailable") {
          record.usage.bucketCost = cost;
        }
      } catch {
        // Non-blocking in capture
      } finally {
        if (usageStore) usageStore.close();
      }
    }
  }
  store.putRecord(redactDeep(record, env));
  return viewRecord(store, store.getRecord(id));
}

function recordCheck(store, options, env, now) {
  const record = need(store.getRecord(options.dispatch), options.dispatch);
  let { result, commit, source } = options;
  let detail = null;
  if (options.report) {
    let report;
    try {
      report = JSON.parse(readFileSync(options.report, "utf8"));
    } catch (error) {
      throw new HistoryError(`cannot read the check report: ${error.message}`);
    }
    const mapped = { passed: "pass", passed_with_known_failures: "pass_with_known_failures", failed: "fail", aborted: "aborted" }[report.result] ?? UNKNOWN;
    result = result ?? mapped;
    commit = commit ?? report.sha ?? undefined;
    detail = { reportResult: known(report.result), failedStage: report.failedStage ?? null, knownFailures: report.knownFailures?.summary ?? null };
    source = source ?? "npm run check report";
  }
  mutate(store, record, env, now, (r) => {
    r.signals.checks.push({ name: options.name, result, commit: known(commit), source: known(source), detail, at: now });
  });
  return viewRecord(store, store.getRecord(record.id)).signals.checks;
}

function recordReview(store, options, env, now) {
  const record = need(store.getRecord(options.dispatch), options.dispatch);
  const findings = Object.fromEntries(SEVERITIES.map((severity) => [severity, options[severity] ?? UNKNOWN]));
  if (options.reviewerDispatch) {
    const reviewer = need(store.getRecord(options.reviewerDispatch), options.reviewerDispatch);
    mutate(store, reviewer, env, now, (r) => {
      r.links.push({ kind: "review_of", target: record.id, evidence: options.evidence ?? "the reviewer dispatch was named when the review was recorded", at: now });
    });
  }
  mutate(store, record, env, now, (r) => {
    r.signals.reviews.push({ findings, reviewerDispatch: options.reviewerDispatch ?? UNKNOWN, evidence: known(options.evidence), at: now });
  });
  return viewRecord(store, store.getRecord(record.id)).signals.reviews;
}

function link(store, options, env, now) {
  if (options.from === options.to) throw new HistoryError("a record cannot be linked to itself");
  const from = need(store.getRecord(options.from), options.from);
  need(store.getRecord(options.to), options.to);
  mutate(store, from, env, now, (r) => {
    r.links = r.links.filter((existing) => !(existing.kind === options.kind && existing.target === options.to));
    r.links.push({ kind: options.kind, target: options.to, evidence: options.evidence, at: now });
  });
  return viewRecord(store, store.getRecord(from.id)).links;
}

function recordUsage(store, options, env, now) {
  const record = need(store.getRecord(options.dispatch), options.dispatch);
  mutate(store, record, env, now, (r) => {
    r.usage.attributable.push({ source: options.source, metrics: options.metrics, at: now });
  });
  return viewRecord(store, store.getRecord(record.id)).usage.attributable;
}

function readObservation(file, label) {
  let observation;
  try {
    observation = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new HistoryError(`cannot read the ${label} observation: ${error.message}`);
  }
  if (!Array.isArray(observation.windows) || !observation.windows.length || typeof observation.observedAt !== "string" || !observation.provider) {
    throw new HistoryError(`the ${label} observation has no usage windows (status ${observation.status ?? "missing"})`);
  }
  return observation;
}

function recordSharedUsage(store, options, env, now) {
  const before = readObservation(options.before, "before");
  const after = readObservation(options.after, "after");
  for (const [label, observation] of [["before", before], ["after", after]]) {
    if (observation.provider !== options.provider) throw new HistoryError(`the ${label} observation is for ${observation.provider}, not ${options.provider}`);
  }
  const account = before.scope?.account ?? UNKNOWN;
  if (account === UNKNOWN || account !== after.scope?.account) throw new HistoryError("the observations do not name one and the same account");
  if (Date.parse(after.observedAt) <= Date.parse(before.observedAt)) throw new HistoryError("the after observation is not later than the before observation");
  const workers = [...new Set(options.workers)];
  const missing = workers.filter((id) => !store.getRecord(id));
  if (missing.length) throw new HistoryError(`no record for ${missing.join(", ")}; capture them first`);
  const elsewhere = workers.filter((id) => store.getRecord(id).agent.name !== options.provider);
  if (elsewhere.length) throw new HistoryError(`${elsewhere.join(", ")} did not run on ${options.provider}, so they do not share its allowance`);

  const windows = after.windows.flatMap((later) => {
    const earlier = before.windows.find((w) => w.id === later.id);
    if (!earlier) return [];
    const base = { id: later.id, kind: later.kind ?? UNKNOWN, group: later.group ?? UNKNOWN, usedPercentBefore: earlier.usedPercent, usedPercentAfter: later.usedPercent };
    if (earlier.resetsAt !== later.resetsAt) return [{ ...base, deltaPercent: null, note: "the window reset between the readings, so the change is not meaningful" }];
    return [{ ...base, deltaPercent: Math.round((later.usedPercent - earlier.usedPercent) * 100) / 100, note: null }];
  });
  const digest = createHash("sha256").update(JSON.stringify([options.provider, account, before.observedAt, after.observedAt])).digest("hex").slice(0, 12);
  const entry = {
    schema: SCHEMA,
    id: `${SHARED_PREFIX}${digest}`,
    provider: options.provider,
    account,
    host: after.scope?.host ?? UNKNOWN,
    from: before.observedAt,
    to: after.observedAt,
    workers,
    windows,
    attribution: "shared",
    perWorkerCost: UNKNOWN,
    uncertainty: "the allowance is shared with every other session on the account and with each listed worker; the change is not any one worker's consumption",
    recordedAt: now,
  };
  store.putShared(redactDeep(entry, env));
  for (const id of workers) {
    const record = store.getRecord(id);
    if (!record.usage.shared.includes(entry.id)) record.usage.shared.push(entry.id);
    record.updatedAt = now;
    store.putRecord(record);
  }
  return entry;
}

/**
 * Computes the lifetime bucket cost delta for a worker from UsageStore observations.
 */
export function computeLifetimeBucketCost({
  agent,
  model,
  dispatchedAt,
  completedAt,
  usageStore,
}) {
  if (!agent || agent === UNKNOWN) {
    return { status: "unknown", reason: "agent is unknown" };
  }
  if (!dispatchedAt || dispatchedAt === UNKNOWN || !completedAt || completedAt === UNKNOWN) {
    return { status: "unknown", reason: "dispatchedAt or completedAt unknown" };
  }
  if (agent === "opencode") {
    return {
      status: "recorded",
      bucketId: "unlimited",
      usedPercentBefore: null,
      usedPercentAfter: null,
      deltaPercent: 0,
      observedBeforeAt: null,
      observedAfterAt: null,
      valid: true,
      note: "opencode has no quota limit",
    };
  }
  if (!usageStore) {
    return { status: "unavailable", reason: "no usage store available" };
  }
  const readingBefore = usageStore.readingPreceding(agent, dispatchedAt);
  const readingAfter = usageStore.readingFollowing(agent, completedAt);
  if (!readingBefore || !readingAfter) {
    const missing = !readingBefore && !readingAfter ? "before and after readings" : !readingBefore ? "before reading" : "after reading";
    return {
      status: "unavailable",
      reason: `no usable ${missing} for ${agent} near worker lifetime`,
    };
  }

  let bucketId = documentedLastingBucketId(agent, model);
  if (!bucketId) {
    const obs = readingBefore.observation ?? {};
    if (Array.isArray(obs.groups)) {
      const group = obs.groups.find((g) => (g.modelIds ?? []).includes(model) || (g.models ?? []).includes(model));
      if (group && Array.isArray(group.windowIds)) {
        bucketId = group.windowIds.find((id) => !id.includes("5h") && !id.includes("session")) ?? group.windowIds[0];
      }
    }
    if (!bucketId && Array.isArray(obs.windows) && obs.windows.length === 1) {
      bucketId = obs.windows[0].id;
    }
  }

  if (!bucketId) {
    return {
      status: "unmatched",
      reason: `could not match model ${model ?? "unknown"} to a quota bucket on ${agent}`,
    };
  }

  const windowBefore = (readingBefore.observation?.windows ?? []).find((w) => w.id === bucketId);
  const windowAfter = (readingAfter.observation?.windows ?? []).find((w) => w.id === bucketId);

  if (!windowBefore || !windowAfter) {
    return {
      status: "missing_window",
      bucketId,
      reason: `bucket ${bucketId} not present in ${!windowBefore ? "before" : "after"} reading`,
    };
  }

  if (
    windowBefore.resetsAt &&
    windowAfter.resetsAt &&
    windowBefore.resetsAt !== windowAfter.resetsAt
  ) {
    return {
      status: "reset",
      bucketId,
      usedPercentBefore: windowBefore.usedPercent,
      usedPercentAfter: windowAfter.usedPercent,
      deltaPercent: null,
      observedBeforeAt: readingBefore.observedAt,
      observedAfterAt: readingAfter.observedAt,
      valid: false,
      note: "the quota bucket reset between the readings, so the change is not meaningful",
    };
  }

  const rawDelta = windowAfter.usedPercent - windowBefore.usedPercent;
  const deltaPercent = Math.round(Math.max(0, rawDelta) * 100) / 100;
  return {
    status: "recorded",
    bucketId,
    usedPercentBefore: windowBefore.usedPercent,
    usedPercentAfter: windowAfter.usedPercent,
    deltaPercent,
    observedBeforeAt: readingBefore.observedAt,
    observedAfterAt: readingAfter.observedAt,
    valid: true,
    note: null,
  };
}

function recordBucketCost(store, options, env, now) {
  const record = need(store.getRecord(options.dispatch), options.dispatch);
  let cost = null;
  if (options.delta !== undefined) {
    const delta = Number(options.delta);
    if (!Number.isFinite(delta)) throw new HistoryError("--delta must be a number");
    const bucketId = options.bucket ?? documentedLastingBucketId(record.agent.name, record.agent.effectiveModel) ?? UNKNOWN;
    const before = options.before !== undefined ? Number(options.before) : null;
    const after = options.after !== undefined ? Number(options.after) : null;
    cost = {
      status: "recorded",
      bucketId,
      usedPercentBefore: before,
      usedPercentAfter: after,
      deltaPercent: delta,
      observedBeforeAt: record.lifecycle.dispatchedAt ?? now,
      observedAfterAt: record.lifecycle.completedAt ?? now,
      valid: true,
      note: options.evidence ?? null,
    };
  } else {
    const usageDir = options.usageDir ?? defaultUsageStateDir(env);
    let usageStore = null;
    try {
      usageStore = new UsageStore(usageDir);
      const model = isKnown(record.agent.effectiveModel) ? record.agent.effectiveModel : record.agent.requestedModel;
      cost = computeLifetimeBucketCost({
        agent: record.agent.name,
        model,
        dispatchedAt: record.lifecycle.dispatchedAt,
        completedAt: record.lifecycle.completedAt,
        usageStore,
      });
    } finally {
      if (usageStore) usageStore.close();
    }
  }
  mutate(store, record, env, now, (r) => {
    r.usage.bucketCost = cost;
  });
  return viewRecord(store, store.getRecord(record.id)).usage.bucketCost;
}

function showEntry(store, id) {
  requireId(id, "--id");
  const record = store.getRecord(id);
  if (record) return viewRecord(store, record);
  const entry = store.getShared(id);
  if (entry) return entry;
  throw new HistoryError(`no record or shared usage change ${id}`);
}

function deleteOne(store, id) {
  requireId(id, "--id");
  if (store.deleteRecord(id)) {
    // A shared change keeps no reference to a worker that was deleted.
    for (const sharedId of store.sharedIds()) {
      const entry = store.getShared(sharedId);
      if (entry?.workers?.includes(id)) store.putShared({ ...entry, workers: entry.workers.filter((w) => w !== id), removedWorkers: (entry.removedWorkers ?? 0) + 1 });
    }
    // Links to the deleted record stay on the other records and show "not recorded".
    return { deleted: "record", id };
  }
  if (store.deleteShared(id)) {
    for (const recordId of store.recordIds()) {
      const record = store.getRecord(recordId);
      if (record?.usage.shared.includes(id)) store.putRecord({ ...record, usage: { ...record.usage, shared: record.usage.shared.filter((s) => s !== id) } });
    }
    return { deleted: "shared-usage", id };
  }
  throw new HistoryError(`no record or shared usage change ${id}`);
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const VALUE_FLAGS = {
  "--dir": "dir", "--dispatch": "dispatch", "--recommendation": "recommendation", "--kind": "kind", "--files": "files",
  "--agent-version": "agentVersion", "--name": "name", "--result": "result", "--report": "report", "--commit": "commit",
  "--source": "source", "--evidence": "evidence", "--reviewer-dispatch": "reviewerDispatch", "--from": "from", "--to": "to",
  "--metric": "metric", "--provider": "provider", "--before": "before", "--after": "after", "--workers": "workers", "--id": "id",
  "--blocking": "blocking", "--high": "high", "--medium": "medium", "--low": "low",
  "--usage-dir": "usageDir", "--bucket": "bucket", "--delta": "delta",
};
const BOOLEAN_FLAGS = { "--no-transcript": "noTranscript", "--all": "all", "--yes": "yes", "--refresh-bucket-cost": "refreshBucketCost" };
const COMMANDS = ["capture", "record-check", "record-review", "link", "record-usage", "record-shared-usage", "record-bucket-cost", "list", "show", "transcript", "delete"];

/** @param {string[]} argv */
export function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) return { help: true };
  if (!COMMANDS.includes(command)) return { error: `unknown command: ${command}` };
  const options = { metrics: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (BOOLEAN_FLAGS[flag]) {
      options[BOOLEAN_FLAGS[flag]] = true;
      continue;
    }
    if (!VALUE_FLAGS[flag]) return { error: `unknown option: ${flag}` };
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
    i += 1;
    if (flag === "--metric") {
      const match = /^([A-Za-z][A-Za-z0-9_.-]*)=(\d+(?:\.\d+)?)$/.exec(value);
      if (!match) return { error: `--metric must be <name>=<number>, got: ${value}` };
      options.metrics[match[1]] = Number(match[2]);
    } else {
      options[VALUE_FLAGS[flag]] = value;
    }
  }
  const required = (...names) => {
    const missing = names.find((name) => options[name] === undefined || !String(options[name]).trim());
    return missing ? { error: `${command} needs --${missing.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}` } : null;
  };
  let problem = null;
  if (command === "capture") problem = required("dispatch");
  if (command === "record-check") {
    problem = required("dispatch", "name");
    if (!problem && !options.result && !options.report) problem = { error: "record-check needs --result or --report" };
    if (!problem && options.result !== undefined && !CHECK_RESULTS.includes(options.result)) problem = { error: `--result must be one of ${CHECK_RESULTS.join(", ")}` };
  }
  if (command === "record-review") {
    problem = required("dispatch");
    for (const severity of SEVERITIES) {
      if (options[severity] === undefined) continue;
      if (!/^\d+$/.test(options[severity])) problem ??= { error: `--${severity} must be a whole number` };
      else options[severity] = Number(options[severity]);
    }
    if (!problem && !SEVERITIES.some((severity) => options[severity] !== undefined)) problem = { error: "record-review needs at least one of --blocking, --high, --medium, --low" };
  }
  if (command === "link") {
    problem = required("from", "to", "kind", "evidence");
    if (!problem && !LINK_KINDS.includes(options.kind)) problem = { error: `--kind must be one of ${LINK_KINDS.join(", ")}` };
  }
  if (command === "record-usage") {
    problem = required("dispatch", "source");
    if (!problem && !Object.keys(options.metrics).length) problem = { error: "record-usage needs at least one --metric <name>=<number>" };
  }
  if (command === "record-shared-usage") {
    problem = required("provider", "before", "after", "workers");
    if (!problem) options.workers = options.workers.split(",").map((id) => id.trim()).filter(Boolean);
    if (!problem && !options.workers.length) problem = { error: "--workers must name at least one dispatch" };
  }
  if (command === "record-bucket-cost") {
    problem = required("dispatch");
  }
  if (command === "show" || command === "transcript") problem = required("id");
  if (command === "delete") {
    if (options.all) problem = options.id ? { error: "use --id or --all, not both" } : !options.yes ? { error: "delete --all removes every record and transcript; add --yes" } : null;
    else problem = required("id");
  }
  if (!problem && options.files !== undefined) {
    if (!/^\d+$/.test(options.files)) problem = { error: "--files must be a whole number" };
    else options.files = Number(options.files);
  }
  if (!problem && options.noTranscript) options.transcript = false;
  return problem ? problem : { command, options };
}

/**
 * Root of the main working tree for this repository, shared by every linked worktree.
 * Parent of `git rev-parse --git-common-dir` when inside a git repo; otherwise `fromDir`.
 * @param {string} [fromDir]
 */
export function mainCheckoutRoot(fromDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const start = path.resolve(fromDir);
  const run = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: start,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.status === 0) {
    const common = run.stdout.trim();
    if (common) return path.dirname(common);
  }
  return start;
}

export function defaultDir(env = process.env) {
  if (env.ORCA_HISTORY_DIR?.trim()) return env.ORCA_HISTORY_DIR;
  return path.join(mainCheckoutRoot(), "artifacts", "orca", "history");
}

/** Runs one command and returns what the CLI prints. */
export function run(command, options, { env = process.env, now = new Date().toISOString() } = {}) {
  const store = openStore(options.dir ?? defaultDir(env));
  switch (command) {
    case "capture": return capture(store, options, env, now);
    case "record-check": return recordCheck(store, options, env, now);
    case "record-review": return recordReview(store, options, env, now);
    case "link": return link(store, options, env, now);
    case "record-usage": return recordUsage(store, options, env, now);
    case "record-shared-usage": return recordSharedUsage(store, options, env, now);
    case "record-bucket-cost": return recordBucketCost(store, options, env, now);
    case "list": {
      const records = store.recordIds().map((id) => summarize(viewRecord(store, store.getRecord(id))));
      return { records, sharedUsage: store.sharedIds() };
    }
    case "show": return showEntry(store, options.id);
    case "transcript": {
      const record = need(store.getRecord(options.id), options.id);
      const entries = store.readTranscript(record.id);
      if (!entries) throw new HistoryError(`no transcript stored for ${record.id} (${record.transcript.status})`);
      return { id: record.id, transcript: record.transcript, entries };
    }
    case "delete": return options.all ? { deleted: "all", ...store.deleteAll() } : deleteOne(store, options.id);
    default: throw new HistoryError(`unknown command: ${command}`);
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseCliArgs(argv);
  if ("help" in parsed) {
    console.log(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    console.error(USAGE);
    console.error(parsed.error);
    return 2;
  }
  try {
    const result = run(parsed.command, parsed.options, { env, now: env.ORCA_HISTORY_NOW || new Date().toISOString() });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (!(error instanceof HistoryError)) throw error;
    console.error(redactText(error.message, env));
    return 1;
  }
}

const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) process.exitCode = main();
