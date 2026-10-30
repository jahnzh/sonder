import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactText } from "../scripts/orca-history.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "orca-history.mjs");
const recommendScript = join(repoRoot, "scripts", "orca-recommend.mjs");
const fixtures = join(repoRoot, "tests", "fixtures", "orca-history");
const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

// Receipts copied from a live `orca orchestration worker-show|worker-read --json` of a running worker on 2026-10-30
// (tests/fixtures/orca-history). Only ids, times and message text are changed per test.
const SHOW = fixture("worker-show.json");
const READ_TRANSCRIPT = fixture("worker-read-transcript.json");
const READ_TERMINAL = fixture("worker-read-terminal.json");
// A reader observation printed by scripts/antigravity-usage.mjs, with the home path removed.
const AGY = fixture("antigravity-observation.json");
const CHECK_REPORT = join(repoRoot, "tests", "fixtures", "check-report.json");
const ENV_SECRET = "hunter2-Z9x8c7v6b5n4m3";

const stubSource = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const verb = args[1];
const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const dispatch = option("--dispatch");
const cursor = option("--cursor");
const source = option("--source");
const file = path.join(process.env.ORCA_STUB_DIR, [verb, dispatch, source, cursor].filter(Boolean).join("-") + ".json");
fs.appendFileSync(path.join(process.env.ORCA_STUB_DIR, "calls.log"), args.join(" ") + "\\n");
if (!fs.existsSync(file)) {
  console.log(JSON.stringify({ id: "x", ok: false, error: { code: "dispatch_not_found", message: "Worker Dispatch " + dispatch + " was not found." } }));
  process.exit(1);
}
process.stdout.write(fs.readFileSync(file, "utf8"));
`;

/** Env keys the history CLI and its stubs need; do not spread the whole process environment. */
const SANDBOX_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_OPTIONS", "npm_config_cache", "ORCA_CLI_COMMAND", "ORCA_STUB_DIR", "ORCA_HISTORY_DIR",
  "ORCA_HISTORY_NOW", "TYPESAFE_API_KEY", "SONDER_TEST_SECRET_TOKEN", "ORCA_RECOMMEND_JEV_URL",
];

function sandboxEnv(overrides = {}) {
  const env = {};
  for (const key of SANDBOX_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "orca-history-"));
  const stub = join(root, "stub");
  const bin = join(root, "bin");
  const history = join(root, "history");
  for (const dir of [stub, bin]) mkdirSync(dir);
  const orca = join(bin, "orca");
  writeFileSync(orca, stubSource.replace("#!/usr/bin/env node", `#!${process.execPath}`));
  chmodSync(orca, 0o755);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
  const box = {
    root,
    stub,
    history,
    bin,
    env: sandboxEnv({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ORCA_CLI_COMMAND: orca,
      ORCA_STUB_DIR: stub,
      ORCA_HISTORY_DIR: history,
      ORCA_HISTORY_NOW: "2026-10-30T12:00:00.000Z",
      TYPESAFE_API_KEY: "",
      SONDER_TEST_SECRET_TOKEN: ENV_SECRET,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    /** One CLI invocation is one process, so repeating it is a restart. */
    cli(args, env = {}) {
      const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...box.env, ...env } });
      return { status: run.status, out: run.stdout, err: run.stderr, json: run.status === 0 ? JSON.parse(run.stdout) : null };
    },
    /** Stages the receipts Orca would print for a dispatch. */
    stage(id, changes = {}) {
      const show = structuredClone(SHOW);
      const { dispatch, worker, projection, terminal } = show.result;
      dispatch.id = projection.id = projection.dispatchId = worker.dispatchId = id;
      dispatch.taskId = projection.taskId = changes.taskId ?? `task_${id}`;
      const launch = worker.startOptions.launch;
      const agent = changes.agent ?? "claude";
      worker.startOptions.agent = agent;
      launch.requested = { agent, model: changes.model ?? "claude-sonnet-5-5", effort: changes.effort ?? "high" };
      launch.effective = { ...launch.requested, ...(changes.effective ?? {}) };
      if (changes.noEffort) delete launch.effective.effort;
      terminal.branch = `refs/heads/jahnzh/${id}`;
      terminal.title = "token=" + ENV_SECRET + " private title";
      terminal.preview = "password=correct-horse-battery private preview";
      worker.startOptions.spec = "SPEC-BODY-MUST-NOT-BE-KEPT";
      if (changes.host) {
        dispatch.hostScope = changes.host;
        projection.host = changes.host;
      }
      if (changes.completed) {
        dispatch.status = "completed";
        dispatch.completedAt = changes.completed;
        worker.state = "succeeded";
        projection.outcome = changes.outcome ?? "succeeded";
        if (changes.outcome === "failed") worker.state = "failed";
      }
      if (changes.dispatchedAt) dispatch.dispatchedAt = changes.dispatchedAt;
      if (changes.retryOf) dispatch.retryOfDispatchId = changes.retryOf;
      if (changes.failureCount !== undefined) dispatch.failureCount = changes.failureCount;
      writeFileSync(join(stub, `worker-show-${id}.json`), JSON.stringify(show));
      const pages = changes.pages ?? [[{ ...READ_TRANSCRIPT.result.transcript.messages[0], id: `${id}-m1`, timestamp: 1000 }, { ...READ_TRANSCRIPT.result.transcript.messages[1], id: `${id}-m2`, timestamp: 2000 }]];
      pages.forEach((messages, index) => {
        const read = structuredClone(READ_TRANSCRIPT);
        read.result.dispatchId = id;
        read.result.transcript.messages = messages;
        const last = index === pages.length - 1;
        read.result.transcript.limited = !last;
        read.result.transcript.nextCursor = last ? null : `cursor${index + 2}`;
        if (!last) read.result.contentComplete = false;
        writeFileSync(join(stub, `worker-read-${id}${index === 0 ? "" : `-cursor${index + 1}`}.json`), JSON.stringify(read));
      });
    },
  };
  return box;
}

const message = (id, text, timestamp, role = "assistant") => ({ id, role, blocks: [{ type: "text", text }], timestamp, source: "transcript" });
const jevBody = { model: "jev-1.14.0", answers: { enough_information: { type: "noul", noul: 0.41 }, reasoning: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: { "0": 0, "1": 1, "2": 0 } }, wide_change: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 451, output_tokens: 54 } };

async function withFakeJev(fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      requests.push(text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jevBody));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1/systemone`, requests);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

const BASELINE = `# Verified Subagent Models

| Agent  | Model ID            | Supported effort values | Capability      | Suits                |
| ------ | ------------------- | ----------------------- | --------------- | -------------------- |
| claude | \`claude-opus-5-5\`   | \`high\`                  | reasoning-heavy | Reasoning-heavy work |
| claude | \`claude-sonnet-5-5\` | \`medium\`, \`high\`        | standard        | Analysis and scripts |
`;

/** Runs a script without blocking the event loop, so a fake Jev in this process can answer it. */
function runAsync(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (status) => done({ status, out, err }));
  });
}

/** Runs the real recommender (with a fake Jev, or the coordinator's judgment) and writes what it printed to a file. */
async function recommendation(box, extra = [], env = {}) {
  const models = join(box.root, "models.md");
  writeFileSync(models, BASELINE);
  const run = await runAsync([recommendScript, "--task", "111", "--summary", "Scripted change with a clear spec", "--kind", "feature", "--files", "3", "--models", models, ...extra], { ...box.env, ...env });
  assert.equal(run.status, 0, run.err);
  const file = join(box.root, `recommendation-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, run.out);
  return { file, result: JSON.parse(run.out) };
}

test("capture records what Orca reports for a running worker and marks the rest unknown", () => {
  const box = sandbox();
  try {
    box.stage("ctx_run1");
    const { json: view } = box.cli(["capture", "--dispatch", "ctx_run1"]);
    assert.equal(view.id, "ctx_run1");
    assert.deepEqual(view.agent, { name: "claude", requestedModel: "claude-sonnet-5-5", effectiveModel: "claude-sonnet-5-5", requestedEffort: "high", effectiveEffort: "high" });
    assert.equal(view.branch, "jahnzh/ctx_run1");
    assert.equal(view.versions.agent.value, "9.9.9 (Claude Code)");
    assert.equal(view.versions.model, "claude-sonnet-5-5");
    assert.equal(view.lifecycle.outcome, "in_progress");
    assert.equal(view.lifecycle.dispatchedAt, "2026-10-30T11:34:55.000Z");
    for (const missing of ["checks", "reviews", "followUpFixes", "elapsed"]) assert.equal(view.signals[missing].status, "unknown", missing);
    assert.equal(view.signals.completion.status, "in_progress");
    assert.equal(view.task.difficulty, "unknown");
    assert.equal(view.task.type, "unknown");
    assert.equal(view.selection.status, "unknown");
    assert.equal(view.usage.attributable.status, "unknown");
    assert.deepEqual(view.usage.shared, []);
  } finally {
    box.cleanup();
  }
});

test("capture of a finished worker keeps elapsed time, lifecycle events and retry facts, appending events only on change", () => {
  const box = sandbox();
  try {
    box.stage("ctx_a");
    box.cli(["capture", "--dispatch", "ctx_a"]);
    const again = box.cli(["capture", "--dispatch", "ctx_a"], { ORCA_HISTORY_NOW: "2026-10-30T12:05:00.000Z" }).json;
    assert.equal(again.lifecycle.events.length, 1, "an unchanged state adds no event");
    box.stage("ctx_a", { completed: "2026-10-30 12:34:56" });
    const done = box.cli(["capture", "--dispatch", "ctx_a"], { ORCA_HISTORY_NOW: "2026-10-30T12:40:00.000Z" }).json;
    assert.deepEqual(done.lifecycle.events.map((e) => [e.at, e.dispatchStatus, e.outcome]), [
      ["2026-10-30T12:00:00.000Z", "dispatched", "in_progress"],
      ["2026-10-30T12:40:00.000Z", "completed", "succeeded"],
    ]);
    assert.deepEqual(done.signals.elapsed, { status: "known", ms: 3601000, from: "2026-10-30T11:34:55.000Z", to: "2026-10-30T12:34:56.000Z" });
    assert.equal(done.capturedAt, "2026-10-30T12:00:00.000Z");
    assert.equal(done.signals.retries.failureCount, 0);
  } finally {
    box.cleanup();
  }
});

test("a later capture never replaces known evidence with unknown", () => {
  const box = sandbox();
  try {
    box.stage("ctx_a", { completed: "2026-10-30 12:34:56" });
    box.cli(["capture", "--dispatch", "ctx_a", "--kind", "fix", "--agent-version", "claude 2.1.0"]);
    // Orca now reports no completion time and no effort.
    box.stage("ctx_a", { noEffort: true });
    const view = box.cli(["capture", "--dispatch", "ctx_a"]).json;
    assert.equal(view.lifecycle.completedAt, "2026-10-30T12:34:56.000Z");
    assert.equal(view.agent.effectiveEffort, "high");
    assert.equal(view.task.type, "fix");
    assert.equal(view.versions.agent.value, "claude 2.1.0");
  } finally {
    box.cleanup();
  }
});

test("difficulty, assessor version and selection come from the recommendation, and an accepted recommendation is not an override", async () => {
  const box = sandbox();
  try {
    await withFakeJev(async (url) => {
      const { file } = await recommendation(box, [], { TYPESAFE_API_KEY: "k-test-key", ORCA_RECOMMEND_JEV_URL: url });
      box.stage("ctx_a", { model: "claude-sonnet-5-5", effort: "medium" });
      const view = box.cli(["capture", "--dispatch", "ctx_a", "--recommendation", file]).json;
      assert.equal(view.task.difficulty, "standard");
      assert.equal(view.task.difficultySource, "jev");
      assert.equal(view.versions.jev, "jev-1.14.0");
      assert.equal(view.task.jevUncertainty.reasoningConfidence, 1);
      assert.equal(view.task.type, "feature");
      assert.equal(view.task.files, 3);
      assert.equal(view.selection.kind, "recommendation");
      assert.equal(view.selection.launchMatchesDecision, true);
      assert.deepEqual(view.selection.chosen, { agent: "claude", model: "claude-sonnet-5-5", effort: "medium" });
    });
  } finally {
    box.cleanup();
  }
});

test("an override keeps both the recommendation and the choice with its reason, and labels neither as wrong", async () => {
  const box = sandbox();
  try {
    const { file, result } = await recommendation(box, ["--judgment", "standard", "--judgment-reason", "small and well specified", "--override", "claude/claude-opus-5-5/high", "--override-reason", "needs more care, key sk-abcdefghijklmnop1234"]);
    assert.equal(result.status, "overridden");
    box.stage("ctx_a", { model: "claude-opus-5-5", effort: "high" });
    const view = box.cli(["capture", "--dispatch", "ctx_a", "--recommendation", file]).json;
    assert.equal(view.task.difficulty, "standard");
    assert.equal(view.task.difficultySource, "coordinator");
    assert.equal(view.selection.kind, "override");
    assert.equal(view.selection.chosen.model, "claude-opus-5-5");
    assert.equal(view.selection.recommended.model, "claude-sonnet-5-5");
    assert.match(view.selection.reason, /needs more care/);
    assert.doesNotMatch(JSON.stringify(view), /sk-abcdefghijklmnop1234/, "a credential in the reason is redacted");
    assert.match(view.selection.note, /not a label/);
    assert.equal(view.selection.fallback.because, "unavailable");
    assert.doesNotMatch(Object.keys(view.signals).join(","), /score|quality|label|correct/);
  } finally {
    box.cleanup();
  }
});

test("a launch that differs from the recorded decision is flagged rather than assumed", async () => {
  const box = sandbox();
  try {
    const { file } = await recommendation(box, ["--judgment", "standard", "--judgment-reason", "clear spec"]);
    box.stage("ctx_a", { model: "claude-opus-5-5", effort: "high" });
    const view = box.cli(["capture", "--dispatch", "ctx_a", "--recommendation", file]).json;
    assert.equal(view.selection.kind, "recommendation");
    assert.equal(view.selection.launchMatchesDecision, false);
  } finally {
    box.cleanup();
  }
});

test("a requested model that Orca replaced is recorded as both requested and effective", () => {
  const box = sandbox();
  try {
    box.stage("ctx_a", { model: "claude-sonnet-5-5", effective: { model: "claude-sonnet-5-4" } });
    const view = box.cli(["capture", "--dispatch", "ctx_a"]).json;
    assert.equal(view.agent.requestedModel, "claude-sonnet-5-5");
    assert.equal(view.agent.effectiveModel, "claude-sonnet-5-4");
    assert.equal(view.versions.model, "claude-sonnet-5-4");
  } finally {
    box.cleanup();
  }
});

test("checks stay separate from completion and from reviews, and a check that passed with known failures is not a plain pass", () => {
  const box = sandbox();
  try {
    box.stage("ctx_a", { completed: "2026-10-30 12:34:56" });
    box.cli(["capture", "--dispatch", "ctx_a"]);
    const checks = box.cli(["record-check", "--dispatch", "ctx_a", "--name", "npm run check", "--report", CHECK_REPORT]).json;
    assert.equal(checks.entries[0].result, "pass_with_known_failures");
    assert.equal(checks.entries[0].commit, "f6fe50ff82ff2d125c186370c4e9e47ba5ffeefa");
    assert.match(checks.entries[0].detail.knownFailures, /4 known failures/);
    box.cli(["record-check", "--dispatch", "ctx_a", "--name", "unit", "--result", "fail", "--commit", "abc123"]);
    const view = box.cli(["show", "--id", "ctx_a"]).json;
    assert.equal(view.signals.checks.entries.length, 2);
    assert.equal(view.signals.completion.status, "succeeded", "a failing check does not rewrite the worker's reported outcome");
    assert.equal(view.signals.reviews.status, "unknown", "a check is not a review");
    assert.equal(view.signals.followUpFixes.status, "unknown");
  } finally {
    box.cleanup();
  }
});

test("reviews keep severities apart, leave unreported ones unknown, and need a recorded worker", () => {
  const box = sandbox();
  try {
    box.stage("ctx_a", { completed: "2026-10-30 12:34:56" });
    box.stage("ctx_rev", { agent: "cursor", model: "auto", effort: undefined, completed: "2026-10-30 12:50:00" });
    box.cli(["capture", "--dispatch", "ctx_a"]);
    box.cli(["capture", "--dispatch", "ctx_rev"]);
    const reviews = box.cli(["record-review", "--dispatch", "ctx_a", "--blocking", "0", "--high", "2", "--reviewer-dispatch", "ctx_rev", "--evidence", "review dispatch report"]).json;
    assert.deepEqual(reviews.entries[0].findings, { blocking: 0, high: 2, medium: "unknown", low: "unknown" });
    assert.equal(reviews.entries[0].reviewerDispatch, "ctx_rev");
    const reviewer = box.cli(["show", "--id", "ctx_rev"]).json;
    assert.deepEqual(reviewer.links.map((l) => [l.kind, l.target, l.targetState]), [["review_of", "ctx_a", "recorded"]]);
    assert.deepEqual(box.cli(["show", "--id", "ctx_a"]).json.signals.reviews.reviewedBy.map((r) => r.id), ["ctx_rev"]);
    const missing = box.cli(["record-review", "--dispatch", "ctx_none", "--high", "1"]);
    assert.equal(missing.status, 1);
    assert.match(missing.err, /no record for ctx_none/);
  } finally {
    box.cleanup();
  }
});

test("a follow-up fix is linked only on explicit evidence between recorded workers", () => {
  const box = sandbox();
  try {
    box.stage("ctx_a", { completed: "2026-10-30 12:34:56" });
    box.stage("ctx_fix", { completed: "2026-10-30 13:10:00" });
    box.cli(["capture", "--dispatch", "ctx_a"]);
    assert.equal(box.cli(["show", "--id", "ctx_a"]).json.signals.followUpFixes.status, "unknown");
    const noEvidence = box.cli(["link", "--from", "ctx_fix", "--to", "ctx_a", "--kind", "fix_of"]);
    assert.equal(noEvidence.status, 2);
    const notRecorded = box.cli(["link", "--from", "ctx_fix", "--to", "ctx_a", "--kind", "fix_of", "--evidence", "fixes review finding 1"]);
    assert.equal(notRecorded.status, 1, "the fix has no record yet");
    assert.equal(box.cli(["show", "--id", "ctx_a"]).json.signals.followUpFixes.status, "unknown", "a refused link leaves nothing behind");
    box.cli(["capture", "--dispatch", "ctx_fix"]);
    const links = box.cli(["link", "--from", "ctx_fix", "--to", "ctx_a", "--kind", "fix_of", "--evidence", "fixes review finding 1"]).json;
    assert.equal(links[0].evidence, "fixes review finding 1");
    const original = box.cli(["show", "--id", "ctx_a"]).json;
    assert.deepEqual(original.signals.followUpFixes.entries.map((e) => [e.id, e.kind]), [["ctx_fix", "fix_of"]]);
    assert.equal(box.cli(["link", "--from", "ctx_a", "--to", "ctx_a", "--kind", "fix_of", "--evidence", "x"]).status, 1);
  } finally {
    box.cleanup();
  }
});

test("a retry is linked from Orca's own retry field, even before the original is recorded", () => {
  const box = sandbox();
  try {
    box.stage("ctx_retry", { retryOf: "ctx_first", failureCount: 1 });
    const retry = box.cli(["capture", "--dispatch", "ctx_retry"]).json;
    assert.equal(retry.signals.retries.retryOf, "ctx_first");
    assert.equal(retry.signals.retries.failureCount, 1);
    assert.deepEqual(retry.links.map((l) => [l.kind, l.target, l.targetState, l.evidence]), [["retry_of", "ctx_first", "not recorded", "Orca dispatch.retryOfDispatchId"]]);
    box.stage("ctx_first", { completed: "2026-10-30 12:00:00", outcome: "failed", failureCount: 1 });
    box.cli(["capture", "--dispatch", "ctx_first"]);
    const first = box.cli(["show", "--id", "ctx_first"]).json;
    assert.deepEqual(first.signals.retries.retriedBy.map((r) => r.id), ["ctx_retry"]);
    assert.equal(first.signals.completion.status, "failed");
  } finally {
    box.cleanup();
  }
});

function observation(usedWeekly, usedFive, { account = AGY.scope.account, observedAt, resetsAtFive } = {}) {
  const copy = structuredClone(AGY);
  copy.scope.account = account;
  copy.observedAt = observedAt;
  for (const w of copy.windows) {
    if (w.id === "gemini-weekly") w.usedPercent = usedWeekly;
    if (w.id === "gemini-5h") {
      w.usedPercent = usedFive;
      if (resetsAtFive) w.resetsAt = resetsAtFive;
    }
  }
  return copy;
}

test("shared provider usage is kept as a shared change and never becomes a per-worker cost", () => {
  const box = sandbox();
  try {
    for (const id of ["ctx_w1", "ctx_w2"]) {
      box.stage(id, { agent: "antigravity", model: "gemini-4-argon-high", effort: undefined, noEffort: true });
      box.cli(["capture", "--dispatch", id]);
    }
    const before = join(box.root, "before.json");
    const after = join(box.root, "after.json");
    writeFileSync(before, JSON.stringify(observation(6.61, 8.1, { observedAt: "2026-10-30T11:00:00.000Z" })));
    writeFileSync(after, JSON.stringify(observation(7.31, 9.5, { observedAt: "2026-10-30T11:30:00.000Z" })));
    const shared = box.cli(["record-shared-usage", "--provider", "antigravity", "--before", before, "--after", after, "--workers", "ctx_w1,ctx_w2"]).json;
    assert.equal(shared.attribution, "shared");
    assert.equal(shared.perWorkerCost, "unknown");
    assert.match(shared.uncertainty, /not any one worker's consumption/);
    assert.deepEqual(shared.windows.filter((w) => ["gemini-weekly", "gemini-5h"].includes(w.id)).map((w) => [w.id, w.deltaPercent]), [["gemini-weekly", 0.7], ["gemini-5h", 1.4]]);
    assert.match(shared.account, /^sha256:[0-9a-f]{16}$/);
    for (const id of ["ctx_w1", "ctx_w2"]) {
      const view = box.cli(["show", "--id", id]).json;
      assert.equal(view.usage.attributable.status, "unknown", "no worker is charged the shared change");
      assert.deepEqual(view.usage.shared.map((s) => [s.id, s.workers, s.perWorkerCost]), [[shared.id, ["ctx_w1", "ctx_w2"], "unknown"]]);
    }
    // Recording the same pair of readings again is the same entry, not a second charge.
    const again = box.cli(["record-shared-usage", "--provider", "antigravity", "--before", before, "--after", after, "--workers", "ctx_w1,ctx_w2"]).json;
    assert.equal(again.id, shared.id);
    assert.equal(box.cli(["list"]).json.sharedUsage.length, 1);
  } finally {
    box.cleanup();
  }
});

test("a window that reset between readings has no change, and mismatched readings are refused", () => {
  const box = sandbox();
  try {
    box.stage("ctx_w1", { agent: "antigravity", model: "gemini-4-argon-high", noEffort: true });
    box.stage("ctx_claude", { completed: "2026-10-30 12:34:56" });
    box.cli(["capture", "--dispatch", "ctx_w1"]);
    box.cli(["capture", "--dispatch", "ctx_claude"]);
    const file = (name, obs) => {
      const path = join(box.root, name);
      writeFileSync(path, JSON.stringify(obs));
      return path;
    };
    const before = file("b.json", observation(6.61, 90, { observedAt: "2026-10-30T11:00:00.000Z" }));
    const reset = file("a.json", observation(7.0, 2, { observedAt: "2026-10-30T11:30:00.000Z", resetsAtFive: "2026-10-30T16:16:22.000Z" }));
    const shared = box.cli(["record-shared-usage", "--provider", "antigravity", "--before", before, "--after", reset, "--workers", "ctx_w1"]).json;
    const five = shared.windows.find((w) => w.id === "gemini-5h");
    assert.equal(five.deltaPercent, null);
    assert.match(five.note, /reset/);

    const otherAccount = file("c.json", observation(7.0, 9, { observedAt: "2026-10-30T11:30:00.000Z", account: "sha256:0000000000000000" }));
    const mismatched = box.cli(["record-shared-usage", "--provider", "antigravity", "--before", before, "--after", otherAccount, "--workers", "ctx_w1"]);
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.err, /one and the same account/);

    const claude = box.cli(["record-shared-usage", "--provider", "antigravity", "--before", before, "--after", reset, "--workers", "ctx_claude"]);
    assert.equal(claude.status, 1);
    assert.match(claude.err, /did not run on antigravity/);

    const unknownWorker = box.cli(["record-shared-usage", "--provider", "antigravity", "--before", before, "--after", reset, "--workers", "ctx_w1,ctx_ghost"]);
    assert.equal(unknownWorker.status, 1);
    assert.match(unknownWorker.err, /no record for ctx_ghost/);

    const unusable = file("d.json", { provider: "antigravity", status: "unavailable", windows: [], observedAt: "2026-10-30T11:30:00.000Z" });
    assert.equal(box.cli(["record-shared-usage", "--provider", "antigravity", "--before", before, "--after", unusable, "--workers", "ctx_w1"]).status, 1);
    assert.equal(box.cli(["list"]).json.sharedUsage.length, 1, "refused readings leave nothing behind");
  } finally {
    box.cleanup();
  }
});

test("usage that a per-worker meter attributes is kept apart from shared changes", () => {
  const box = sandbox();
  try {
    box.stage("ctx_a");
    box.cli(["capture", "--dispatch", "ctx_a"]);
    const usage = box.cli(["record-usage", "--dispatch", "ctx_a", "--source", "provider per-session meter", "--metric", "input_tokens=1200", "--metric", "output_tokens=300"]).json;
    assert.deepEqual(usage.entries[0].metrics, { input_tokens: 1200, output_tokens: 300 });
    const view = box.cli(["show", "--id", "ctx_a"]).json;
    assert.equal(view.usage.attributable.entries[0].source, "provider per-session meter");
    assert.deepEqual(view.usage.shared, []);
    assert.equal(box.cli(["record-usage", "--dispatch", "ctx_a", "--source", "x"]).status, 2, "a meter needs a metric");
  } finally {
    box.cleanup();
  }
});

test("records and transcripts survive restarts, and files are readable only by the owner", () => {
  const box = sandbox();
  try {
    box.stage("ctx_a", { completed: "2026-10-30 12:34:56" });
    box.cli(["capture", "--dispatch", "ctx_a", "--kind", "docs"]);
    box.cli(["record-check", "--dispatch", "ctx_a", "--name", "unit", "--result", "pass"]);
    // Every cli() call is a fresh process; Orca is gone entirely.
    rmSync(box.stub, { recursive: true });
    const view = box.cli(["show", "--id", "ctx_a"]).json;
    assert.equal(view.task.type, "docs");
    assert.equal(view.signals.checks.entries[0].result, "pass");
    assert.equal(box.cli(["transcript", "--id", "ctx_a"]).json.entries.length, 2);
    assert.deepEqual(box.cli(["list"]).json.records.map((r) => r.id), ["ctx_a"]);
    for (const file of [join(box.history, "records", "ctx_a.json"), join(box.history, "transcripts", "ctx_a.jsonl")]) {
      assert.equal(statSync(file).mode & 0o077, 0, `${file} is private`);
    }
    assert.deepEqual(readdirSync(join(box.history, "records")), ["ctx_a.json"], "no temporary file is left behind");
  } finally {
    box.cleanup();
  }
});

test("a transcript is stored redacted in its own file, and no inspection command prints its text", () => {
  const box = sandbox();
  try {
    const leaky = [
      message("m1", `I read the env: SONDER_TEST_SECRET_TOKEN=${ENV_SECRET} and curl -H "Authorization: Bearer abcdef1234567890xyz"`, 1000),
      message("m2", "TYPESAFE_API_KEY=sk-live-abcdefghijklmnopqrstuv and ya29.a0AfH6SMBexampletokenvalue", 2000),
      message("m3", "unique-transcript-marker-4821 plain working text", 3000),
    ];
    box.stage("ctx_a", { pages: [leaky] });
    const captured = box.cli(["capture", "--dispatch", "ctx_a"]);
    const stored = readFileSync(join(box.history, "transcripts", "ctx_a.jsonl"), "utf8");
    for (const secret of [ENV_SECRET, "abcdef1234567890xyz", "sk-live-abcdefghijklmnopqrstuv", "ya29.a0AfH6SMBexampletokenvalue"]) {
      assert.ok(!stored.includes(secret), `${secret} is not stored`);
    }
    assert.match(stored, /unique-transcript-marker-4821/, "ordinary text is kept");
    assert.match(stored, /\[redacted\]/);
    assert.equal(captured.json.transcript.messageCount, 3);

    const wholeRecord = readFileSync(join(box.history, "records", "ctx_a.json"), "utf8");
    assert.ok(!wholeRecord.includes("unique-transcript-marker-4821"), "the record holds only transcript metadata");
    for (const printed of [captured.out, box.cli(["show", "--id", "ctx_a"]).out, box.cli(["list"]).out]) {
      assert.ok(!printed.includes("unique-transcript-marker-4821"), "inspection does not print transcript text");
    }
    const read = box.cli(["transcript", "--id", "ctx_a"]).json;
    assert.ok(JSON.stringify(read.entries).includes("unique-transcript-marker-4821"), "the transcript command does");
    assert.match(read.transcript.note, /never sent to Jev/);
  } finally {
    box.cleanup();
  }
});

test("record fields exclude the spec, the terminal title and preview, and credentials from every input", async () => {
  const box = sandbox();
  try {
    box.stage("ctx_a");
    const { file } = await recommendation(box, ["--judgment", "standard", "--judgment-reason", `uses key ${ENV_SECRET}`]);
    box.cli(["capture", "--dispatch", "ctx_a", "--recommendation", file, "--no-transcript"]);
    box.cli(["record-check", "--dispatch", "ctx_a", "--name", "unit", "--result", "pass", "--source", `ran with password=correct-horse-battery`]);
    const text = readdirSync(join(box.history, "records")).map((name) => readFileSync(join(box.history, "records", name), "utf8")).join("\n");
    for (const forbidden of ["SPEC-BODY-MUST-NOT-BE-KEPT", "private title", "private preview", ENV_SECRET, "correct-horse-battery"]) {
      assert.ok(!text.includes(forbidden), `${forbidden} is not kept`);
    }
    assert.equal(existsSync(join(box.history, "transcripts", "ctx_a.jsonl")), false, "--no-transcript stores none");
    assert.equal(box.cli(["show", "--id", "ctx_a"]).json.transcript.status, "unknown");
    assert.equal(box.cli(["transcript", "--id", "ctx_a"]).status, 1);
  } finally {
    box.cleanup();
  }
});

test("transcript pages are merged in time order and a repeated capture adds no duplicates", () => {
  const box = sandbox();
  try {
    box.stage("ctx_a", { pages: [[message("m2", "second", 2000), message("m1", "first", 1000)], [message("m3", "third", 3000)]] });
    const first = box.cli(["capture", "--dispatch", "ctx_a"]).json;
    assert.equal(first.transcript.messageCount, 3);
    assert.equal(first.transcript.complete, false, "Orca reported clipped content");
    const second = box.cli(["capture", "--dispatch", "ctx_a"]).json;
    assert.equal(second.transcript.messageCount, 3);
    const entries = box.cli(["transcript", "--id", "ctx_a"]).json.entries;
    assert.deepEqual(entries.map((e) => e.id), ["m1", "m2", "m3"]);
  } finally {
    box.cleanup();
  }
});

test("terminal output is stored when Orca has no transcript, and an unreadable worker leaves the record without losing the earlier transcript", () => {
  const box = sandbox();
  try {
    box.stage("ctx_term");
    const terminalRead = structuredClone(READ_TERMINAL);
    terminalRead.result.dispatchId = "ctx_term";
    writeFileSync(join(box.stub, "worker-read-ctx_term.json"), JSON.stringify(terminalRead));
    const term = box.cli(["capture", "--dispatch", "ctx_term"]).json;
    assert.equal(term.transcript.source, "terminal");
    assert.equal(term.transcript.messageCount, READ_TERMINAL.result.terminal.tail.length);

    box.stage("ctx_a");
    box.cli(["capture", "--dispatch", "ctx_a"]);
    rmSync(join(box.stub, "worker-read-ctx_a.json"));
    const view = box.cli(["capture", "--dispatch", "ctx_a"]);
    assert.equal(view.status, 0, "a transcript failure does not fail the capture");
    assert.equal(view.json.transcript.status, "stored");
    assert.equal(view.json.transcript.lastAttempt.status, "unavailable");
    assert.equal(box.cli(["transcript", "--id", "ctx_a"]).json.entries.length, 2);

    box.stage("ctx_b");
    rmSync(join(box.stub, "worker-read-ctx_b.json"));
    const none = box.cli(["capture", "--dispatch", "ctx_b"]).json;
    assert.equal(none.transcript.status, "unavailable");
    assert.match(none.transcript.reason, /ctx_b was not found/);
  } finally {
    box.cleanup();
  }
});

test("capturing a dispatch Orca does not know fails and creates nothing", () => {
  const box = sandbox();
  try {
    const run = box.cli(["capture", "--dispatch", "ctx_missing"]);
    assert.equal(run.status, 1);
    assert.match(run.err, /Orca refused: Worker Dispatch ctx_missing was not found/);
    assert.equal(existsSync(join(box.history, "records")), false);
  } finally {
    box.cleanup();
  }
});

test("deleting one record removes its transcript and its mention in shared usage, and leaves the others", () => {
  const box = sandbox();
  try {
    for (const id of ["ctx_w1", "ctx_w2"]) {
      box.stage(id, { agent: "antigravity", model: "gemini-4-argon-high", noEffort: true });
      box.cli(["capture", "--dispatch", id]);
    }
    box.stage("ctx_fix", { completed: "2026-10-30 13:10:00" });
    box.cli(["capture", "--dispatch", "ctx_fix"]);
    box.cli(["link", "--from", "ctx_fix", "--to", "ctx_w1", "--kind", "fix_of", "--evidence", "fixes it"]);
    const before = join(box.root, "b.json");
    const after = join(box.root, "a.json");
    writeFileSync(before, JSON.stringify(observation(6.61, 8.1, { observedAt: "2026-10-30T11:00:00.000Z" })));
    writeFileSync(after, JSON.stringify(observation(7.31, 9.5, { observedAt: "2026-10-30T11:30:00.000Z" })));
    const shared = box.cli(["record-shared-usage", "--provider", "antigravity", "--before", before, "--after", after, "--workers", "ctx_w1,ctx_w2"]).json;

    const deleted = box.cli(["delete", "--id", "ctx_w1"]).json;
    assert.deepEqual(deleted, { deleted: "record", id: "ctx_w1" });
    assert.equal(existsSync(join(box.history, "transcripts", "ctx_w1.jsonl")), false);
    assert.equal(box.cli(["show", "--id", "ctx_w1"]).status, 1);
    assert.deepEqual(box.cli(["list"]).json.records.map((r) => r.id), ["ctx_fix", "ctx_w2"]);
    assert.deepEqual(box.cli(["show", "--id", shared.id]).json.workers, ["ctx_w2"]);
    assert.equal(box.cli(["show", "--id", "ctx_fix"]).json.links[0].targetState, "not recorded");
    assert.equal(box.cli(["transcript", "--id", "ctx_w2"]).json.entries.length, 2);
    assert.equal(box.cli(["delete", "--id", "ctx_w1"]).status, 1, "deleting twice is reported");

    assert.deepEqual(box.cli(["delete", "--id", shared.id]).json, { deleted: "shared-usage", id: shared.id });
    assert.deepEqual(box.cli(["show", "--id", "ctx_w2"]).json.usage.shared, []);
    assert.deepEqual(box.cli(["list"]).json.sharedUsage, []);
  } finally {
    box.cleanup();
  }
});

test("delete --all needs confirmation and then leaves nothing readable", () => {
  const box = sandbox();
  try {
    for (const id of ["ctx_a", "ctx_b"]) {
      box.stage(id);
      box.cli(["capture", "--dispatch", id]);
    }
    const refused = box.cli(["delete", "--all"]);
    assert.equal(refused.status, 2);
    assert.equal(box.cli(["list"]).json.records.length, 2, "nothing was deleted");
    assert.equal(box.cli(["delete", "--all", "--id", "ctx_a", "--yes"]).status, 2);
    const result = box.cli(["delete", "--all", "--yes"]).json;
    assert.deepEqual(result, { deleted: "all", records: 2, sharedUsage: 0 });
    assert.deepEqual(box.cli(["list"]).json, { records: [], sharedUsage: [] });
    assert.deepEqual(readdirSync(box.history), [], "records, transcripts and shared usage are all gone");
    assert.equal(box.cli(["transcript", "--id", "ctx_a"]).status, 1);
  } finally {
    box.cleanup();
  }
});

test("identifiers that are not plain names are refused before any file is touched", () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.root, "victim.json"), "{}");
    for (const id of ["../victim", "a/b", ".hidden", ""]) {
      for (const args of [["show", "--id", id], ["delete", "--id", id], ["transcript", "--id", id]]) {
        const run = box.cli(args);
        assert.notEqual(run.status, 0, args.join(" "));
      }
    }
    assert.equal(box.cli(["capture", "--dispatch", "../escape"]).status, 1);
    assert.ok(existsSync(join(box.root, "victim.json")));
  } finally {
    box.cleanup();
  }
});

test("usage errors exit 2 and name the problem", () => {
  const box = sandbox();
  try {
    assert.equal(box.cli(["frobnicate"]).status, 2);
    assert.match(box.cli(["capture"]).err, /capture needs --dispatch/);
    assert.match(box.cli(["record-check", "--dispatch", "ctx_a", "--name", "n"]).err, /needs --result or --report/);
    assert.match(box.cli(["record-check", "--dispatch", "ctx_a", "--name", "n", "--result", "great"]).err, /--result must be one of/);
    assert.match(box.cli(["record-review", "--dispatch", "ctx_a"]).err, /at least one of/);
    assert.match(box.cli(["record-review", "--dispatch", "ctx_a", "--high", "many"]).err, /whole number/);
    assert.match(box.cli(["link", "--from", "a", "--to", "b", "--kind", "cause_of", "--evidence", "x"]).err, /--kind must be one of/);
    assert.match(box.cli(["capture", "--dispatch", "ctx_a", "--files", "many"]).err, /whole number/);
    assert.match(box.cli(["capture", "--dispatch", "ctx_a", "--bogus", "x"]).err, /unknown option/);
    const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /delete --all --yes/);
  } finally {
    box.cleanup();
  }
});

test("the recommender sends Jev nothing from the history, transcripts included", async () => {
  const box = sandbox();
  try {
    box.stage("ctx_a", { pages: [[message("m1", "unique-transcript-marker-9137 private working text", 1000)]] });
    box.cli(["capture", "--dispatch", "ctx_a"]);
    box.cli(["record-check", "--dispatch", "ctx_a", "--name", "unit", "--result", "pass", "--source", "history-source-marker-5521"]);
    await withFakeJev(async (url, requests) => {
      const models = join(box.root, "models.md");
      writeFileSync(models, BASELINE);
      const run = await runAsync([recommendScript, "--task", "111", "--summary", "Scripted change with a clear spec", "--kind", "feature", "--models", models], { ...box.env, TYPESAFE_API_KEY: "k-test-key", ORCA_RECOMMEND_JEV_URL: url });
      assert.equal(run.status, 0, run.err);
      assert.equal(requests.length, 1);
      const sent = requests[0];
      assert.ok(!sent.includes("unique-transcript-marker-9137") && !sent.includes("history-source-marker-5521") && !sent.includes("ctx_a"));
      assert.deepEqual(Object.keys(JSON.parse(sent).state).sort(), ["kind", "task"]);
    });
  } finally {
    box.cleanup();
  }
});

test("credential-named keys redact the whole value, including spaces, in key=value, key: value, quoted and JSON forms", () => {
  const cases = [
    ["password=correct horse battery", "password=[redacted]", "correct horse battery"],
    ["passwd: correct horse battery", "passwd: [redacted]", "correct horse battery"],
    ['secret="correct horse battery"', 'secret="[redacted]"', "correct horse battery"],
    ["token: 'correct horse battery'", "token: '[redacted]'", "correct horse battery"],
    ['{"password":"correct horse battery","ok":true}', '"password":"[redacted]"', "correct horse battery"],
    ["authorization: correct horse battery", "authorization: [redacted]", "correct horse battery"],
    ["cookie=session=abc def", "cookie=[redacted]", "session=abc def"],
    ["api_key=correct horse battery", "api_key=[redacted]", "correct horse battery"],
  ];
  for (const [input, kept, forbidden] of cases) {
    const out = redactText(input, {});
    assert.match(out, new RegExp(kept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), input);
    assert.ok(!out.includes(forbidden), `${input} still contains ${forbidden}: ${out}`);
  }
  assert.equal(redactText("password=correct horse battery note", {}), "password=[redacted]");
});

test("a remote dispatch does not record the locally installed agent version", () => {
  const box = sandbox();
  try {
    box.stage("ctx_remote", { host: { kind: "remote", id: "deck" } });
    const view = box.cli(["capture", "--dispatch", "ctx_remote"]).json;
    assert.equal(view.host.kind, "remote");
    assert.equal(view.versions.agent, "unknown");
    const withFlag = box.cli(["capture", "--dispatch", "ctx_remote", "--agent-version", "claude 2.1.0 on deck"]).json;
    assert.equal(withFlag.versions.agent.value, "claude 2.1.0 on deck");
    assert.equal(withFlag.versions.agent.basis, "coordinator");
  } finally {
    box.cleanup();
  }
});

test("the coordinator documentation points at the history command and its privacy rules", () => {
  const doc = readFileSync(join(repoRoot, "docs", "agents", "worker-history.md"), "utf8");
  for (const command of ["capture", "record-check", "record-review", "link", "record-shared-usage", "delete --all --yes", "transcript --id"]) assert.ok(doc.includes(command), command);
  assert.match(doc, /Unknown is not zero/);
  assert.match(doc, /never print them/);
  assert.match(doc, /automatic/i);
  assert.match(doc, /orca-check/);
  assert.match(doc, /orca-spawn/);
  assert.match(doc, /unknown unless.*worker host|observed on the worker host/i);
  assert.doesNotMatch(doc, /Capturing and recording are manual steps: nothing runs them at `worker_done`/);
  assert.match(readFileSync(join(repoRoot, "AGENTS.md"), "utf8"), /docs\/agents\/worker-history\.md/);
  const spec = readFileSync(join(repoRoot, "docs", "agents", "worker-spec.md"), "utf8");
  assert.match(spec, /orca-history\.mjs capture/);
  assert.match(spec, /automatic/i);
});
