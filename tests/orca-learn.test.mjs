import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  MIN_COMPARABLE_COUNT,
  MIN_WEIGHTED_EVIDENCE,
  applyLearning,
  attributableCost,
  buildAdjustments,
  collectEvidence,
  evidenceFromView,
  evidenceWeight,
  inspectLearning,
  loadLearningContext,
  openLearnState,
  resetLearning,
  signalContributions,
} from "../scripts/orca-learn.mjs";
import { openStore, viewRecord } from "../scripts/orca-history.mjs";
import { recommend } from "../scripts/orca-recommend.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "orca-learn.mjs");
const NOW = "2026-10-30T12:00:00.000Z";
const AGENT_VERSION = "claude 1.0.0";

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orca-learn-")));
  const history = join(root, "history");
  const learn = join(root, "learn");
  mkdirSync(join(history, "records"), { recursive: true, mode: 0o700 });
  mkdirSync(join(history, "transcripts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(history, "shared-usage"), { recursive: true, mode: 0o700 });
  mkdirSync(learn, { recursive: true, mode: 0o700 });
  return {
    root,
    history,
    learn,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    cli(args, env = {}) {
      const run = spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          ORCA_HISTORY_DIR: history,
          ORCA_LEARN_DIR: learn,
          ORCA_LEARN_NOW: NOW,
          ...env,
        },
      });
      return {
        status: run.status,
        out: run.stdout,
        err: run.stderr,
        json: run.status === 0 && run.stdout.trim() ? JSON.parse(run.stdout) : null,
      };
    },
  };
}

/** Writes a history record JSON the learning code will read. Builds every path inside the temp dir. */
function putRecord(historyDir, {
  id,
  agent = "claude",
  model = "claude-sonnet-5-5",
  effort = "high",
  agentVersion = AGENT_VERSION,
  kind = "feature",
  difficulty = "standard",
  outcome = "succeeded",
  completedAt = "2026-10-20T12:00:00.000Z",
  checks = [{ name: "unit", result: "pass" }],
  reviews = [],
  followUpFixes = [],
  selectionKind = "recommendation",
  attributable = [],
  shared = [],
}) {
  const record = {
    schema: 1,
    id,
    dispatchId: id,
    taskId: `task_${id}`,
    runId: "run_x",
    capturedAt: completedAt,
    updatedAt: completedAt,
    task: {
      type: kind,
      typeSource: "recommendation",
      files: 3,
      difficulty,
      difficultySource: "jev",
      jevVersion: "jev-1.14.0",
      jevUncertainty: null,
    },
    agent: {
      name: agent,
      requestedModel: model,
      effectiveModel: model,
      requestedEffort: effort,
      effectiveEffort: effort,
    },
    versions: {
      agent: agentVersion === "unknown" ? "unknown" : { value: agentVersion, basis: "coordinator", observedAt: completedAt },
      model,
      jev: "jev-1.14.0",
    },
    host: { kind: "local" },
    branch: `jahnzh/${id}`,
    baseBranch: "main",
    selection: {
      status: "recorded",
      kind: selectionKind,
      recommended: { agent, model, effort },
      chosen: { agent, model, effort },
      reason: "test",
      warning: null,
      fallback: null,
      launchMatchesDecision: true,
      note: "an override is a choice, not a label of the recommendation being wrong",
    },
    lifecycle: {
      dispatchStatus: "completed",
      workerState: outcome === "failed" ? "failed" : "succeeded",
      outcome,
      dispatchedAt: "2026-10-20T11:00:00.000Z",
      completedAt,
      events: [],
    },
    retries: { failureCount: 0, retryOf: null },
    signals: {
      checks: checks.map((c) => ({ ...c, commit: "unknown", source: "test", detail: null, at: completedAt })),
      reviews: reviews.map((r) => ({ findings: r, reviewerDispatch: "unknown", evidence: "test", at: completedAt })),
    },
    links: followUpFixes.map((target) => ({ kind: "fix_of", target, evidence: "test", at: completedAt })),
    usage: { attributable, shared },
    transcript: { status: "stored", path: `transcripts/${id}.jsonl`, lines: 0, complete: true, source: "none" },
  };
  writeFileSync(join(historyDir, "records", `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

const CANDIDATES = [
  { agent: "claude", model: "claude-sonnet-5-5", effort: "high", capability: "standard", suits: "Analysis", usage: "unknown" },
  { agent: "cursor", model: "composer-2.5", effort: null, capability: "standard", suits: "Scripting", usage: "unknown" },
  { agent: "claude", model: "claude-opus-5-5", effort: "high", capability: "reasoning-heavy", suits: "Hard", usage: "unknown" },
];

test("evidence weight halves over the configured half-life", () => {
  const half = evidenceWeight("2026-09-30T12:00:00.000Z", "2026-10-30T12:00:00.000Z");
  assert.ok(Math.abs(half - 0.5) < 1e-9);
  assert.equal(evidenceWeight("2026-10-30T12:00:00.000Z", "2026-10-30T12:00:00.000Z"), 1);
});

test("future-dated or invalid completedAt get zero weight and are excluded", () => {
  assert.equal(evidenceWeight("2026-11-01T12:00:00.000Z", NOW), 0);
  assert.equal(evidenceWeight("not-a-date", NOW), 0);
  const box = sandbox();
  try {
    putRecord(box.history, {
      id: "ctx_future",
      agent: "cursor",
      model: "composer-2.5",
      effort: null,
      completedAt: "2026-11-15T12:00:00.000Z",
    });
    const store = openStore(box.history);
    const row = evidenceFromView(viewRecord(store, store.getRecord("ctx_future")), { now: NOW });
    assert.equal(row.included, false);
    assert.match(row.reason, /future-dated or invalid/);
  } finally {
    box.cleanup();
  }
});

test("missing outcomes and shared usage never count as success or per-worker cost", () => {
  const box = sandbox();
  try {
    putRecord(box.history, { id: "ctx_missing", outcome: "unknown", completedAt: "2026-10-25T12:00:00.000Z" });
    // Force unknown outcome after write — putRecord maps lifecycle; overwrite.
    const store = openStore(box.history);
    const record = store.getRecord("ctx_missing");
    record.lifecycle.outcome = "unknown";
    store.putRecord(record);
    putRecord(box.history, {
      id: "ctx_shared",
      outcome: "succeeded",
      shared: ["su_1"],
      attributable: [],
    });
    writeFileSync(
      join(box.history, "shared-usage", "su_1.json"),
      JSON.stringify({
        id: "su_1",
        provider: "claude",
        account: "a",
        from: {},
        to: {},
        windows: [],
        attribution: "shared",
        perWorkerCost: "unknown",
        workers: ["ctx_shared"],
      }),
    );

    const evidence = collectEvidence(store, { now: NOW });
    const missing = evidence.find((e) => e.id === "ctx_missing");
    assert.equal(missing.included, false);
    assert.match(missing.reason, /missing outcome/);

    const view = viewRecord(store, store.getRecord("ctx_shared"));
    const { signals } = signalContributions(view);
    assert.ok(signals.some((s) => s.name === "sharedUsage" && s.value === 0));
    const usageSignal = signals.find((s) => s.name === "attributableUsage");
    assert.equal(usageSignal.available, false);
    assert.match(usageSignal.detail, /not available/i);
    assert.ok(/no per-worker|unknown/i.test(usageSignal.detail));
    assert.ok(signals.some((s) => s.name === "elapsed" && s.available === true && typeof s.ms === "number"));
  } finally {
    box.cleanup();
  }
});

test("an override is not treated as a correctness label in signal contributions", () => {
  const box = sandbox();
  try {
    putRecord(box.history, { id: "ctx_ov", selectionKind: "override", outcome: "succeeded" });
    const store = openStore(box.history);
    const { signals, total } = signalContributions(viewRecord(store, store.getRecord("ctx_ov")));
    const override = signals.find((s) => s.name === "override");
    assert.equal(override.value, 0);
    assert.match(override.detail, /not a label/);
    assert.ok(total > 0, "successful outcome still contributes positively");
  } finally {
    box.cleanup();
  }
});

test("low evidence stays uncertain and falls back to the baseline recommendation", () => {
  const box = sandbox();
  try {
    putRecord(box.history, { id: "ctx_a", agent: "cursor", model: "composer-2.5", effort: null, outcome: "succeeded" });
    putRecord(box.history, { id: "ctx_b", agent: "cursor", model: "composer-2.5", effort: null, outcome: "succeeded" });
    const learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
    });
    assert.equal(learning.adjustments.length, 0);
    assert.ok(learning.uncertain.some((u) => u.choice === "cursor/composer-2.5" && u.rawCount === 2));
    assert.ok(learning.uncertain[0].rawCount < MIN_COMPARABLE_COUNT || learning.uncertain[0].weightedCount < MIN_WEIGHTED_EVIDENCE);

    const learned = applyLearning({
      usable: CANDIDATES.filter((c) => c.capability === "standard"),
      kind: "feature",
      difficulty: "standard",
      learning,
      random: () => 0.99,
    });
    assert.equal(choice(learned.baselineRecommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(choice(learned.recommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(learned.applied.length, 0);
    assert.ok(learned.uncertain.some((u) => u.choice === "cursor/composer-2.5"));
  } finally {
    box.cleanup();
  }
});

test("learning across successive runs prefers a better-evidenced equivalent", () => {
  const box = sandbox();
  try {
    const versions = { claude: AGENT_VERSION, cursor: AGENT_VERSION };
    const usable = CANDIDATES.filter((c) => c.capability === "standard");

    // First two cursor successes: still below the minimum — baseline wins.
    putRecord(box.history, { id: "c1", agent: "cursor", model: "composer-2.5", effort: null, completedAt: "2026-10-25T12:00:00.000Z" });
    putRecord(box.history, { id: "c2", agent: "cursor", model: "composer-2.5", effort: null, completedAt: "2026-10-26T12:00:00.000Z" });
    let learning = loadLearningContext({ historyDir: box.history, learnDir: box.learn, kind: "feature", difficulty: "standard", now: NOW, agentVersions: versions });
    let learned = applyLearning({ usable, kind: "feature", difficulty: "standard", learning, random: () => 0.99 });
    assert.equal(choice(learned.recommendation), "claude/claude-sonnet-5-5/high");

    // Third success crosses the threshold: cursor becomes the adjusted tip.
    putRecord(box.history, { id: "c3", agent: "cursor", model: "composer-2.5", effort: null, completedAt: "2026-10-27T12:00:00.000Z" });
    learning = loadLearningContext({ historyDir: box.history, learnDir: box.learn, kind: "feature", difficulty: "standard", now: NOW, agentVersions: versions });
    learned = applyLearning({ usable, kind: "feature", difficulty: "standard", learning, random: () => 0.99 });
    assert.equal(choice(learned.baselineRecommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(choice(learned.recommendation), "cursor/composer-2.5");
    assert.equal(learned.applied.length, 1);
    assert.equal(learned.applied[0].rawCount, 3);
    assert.ok(learned.applied[0].evidence.every((e) => e.id.startsWith("c")));
  } finally {
    box.cleanup();
  }
});

test("old evidence loses weight until the adjustment becomes uncertain again", () => {
  const box = sandbox();
  try {
    // Three successes a year ago: decayed weight falls below the threshold.
    for (const [id, day] of [
      ["old1", "2025-10-01"],
      ["old2", "2025-10-02"],
      ["old3", "2025-10-03"],
    ]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        completedAt: `${day}T12:00:00.000Z`,
      });
    }
    const learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { cursor: AGENT_VERSION },
    });
    const bucket = learning.uncertain.find((u) => u.choice === "cursor/composer-2.5") ?? learning.adjustments.find((u) => u.choice === "cursor/composer-2.5");
    assert.ok(bucket);
    assert.equal(bucket.rawCount, 3);
    assert.ok(bucket.weightedCount < MIN_WEIGHTED_EVIDENCE);
    assert.equal(learning.adjustments.length, 0);

    const learned = applyLearning({
      usable: CANDIDATES.filter((c) => c.capability === "standard"),
      kind: "feature",
      difficulty: "standard",
      learning,
      random: () => 0.99,
    });
    assert.equal(choice(learned.recommendation), choice(learned.baselineRecommendation));
  } finally {
    box.cleanup();
  }
});

test("changed agent versions are not comparable with prior evidence", () => {
  const box = sandbox();
  try {
    for (const id of ["v1", "v2", "v3"]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        agentVersion: "cursor-old",
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    const learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { cursor: "cursor-new" },
    });
    assert.ok(learning.adjustments.some((a) => a.agentVersion === "cursor-old"));
    const learned = applyLearning({
      usable: CANDIDATES.filter((c) => c.capability === "standard"),
      kind: "feature",
      difficulty: "standard",
      learning,
      random: () => 0.99,
    });
    assert.equal(choice(learned.recommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(learned.applied.length, 0);
    assert.ok(learned.versionMismatches.some((m) => m.agentVersion === "cursor-old" && m.currentVersion === "cursor-new"));
  } finally {
    box.cleanup();
  }
});

test("reset clears adjustments without deleting raw history", () => {
  const box = sandbox();
  try {
    for (const id of ["r1", "r2", "r3"]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    let learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { cursor: AGENT_VERSION },
    });
    assert.equal(learning.adjustments.length, 1);

    const reset = resetLearning({ learnDir: box.learn, now: NOW, yes: true });
    assert.equal(reset.resetAt, NOW);
    assert.equal(openLearnState(box.learn).read().resetAt, NOW);
    assert.ok(openStore(box.history).getRecord("r1"), "raw history kept");

    learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { cursor: AGENT_VERSION },
    });
    assert.equal(learning.adjustments.length, 0);
    assert.equal(learning.resetAt, NOW);

    // A new outcome after the reset can rebuild an adjustment.
    putRecord(box.history, {
      id: "r4",
      agent: "cursor",
      model: "composer-2.5",
      effort: null,
      completedAt: "2026-10-30T13:00:00.000Z",
    });
    putRecord(box.history, {
      id: "r5",
      agent: "cursor",
      model: "composer-2.5",
      effort: null,
      completedAt: "2026-10-30T14:00:00.000Z",
    });
    putRecord(box.history, {
      id: "r6",
      agent: "cursor",
      model: "composer-2.5",
      effort: null,
      completedAt: "2026-10-30T15:00:00.000Z",
    });
    learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: "2026-10-30T16:00:00.000Z",
      agentVersions: { cursor: AGENT_VERSION },
    });
    assert.equal(learning.adjustments.length, 1);
    assert.equal(learning.adjustments[0].rawCount, 3);
    assert.ok(learning.adjustments[0].evidence.every((e) => ["r4", "r5", "r6"].includes(e.id)));
  } finally {
    box.cleanup();
  }
});

test("inspect compares adjustments with the baseline and the CLI reset works", () => {
  const box = sandbox();
  try {
    for (const id of ["i1", "i2", "i3"]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    const report = inspectLearning({ historyDir: box.history, learnDir: box.learn, kind: "feature", difficulty: "standard", now: NOW });
    assert.equal(report.status, "inspected");
    assert.match(report.baseline.note, /baseline/i);
    assert.equal(report.adjustments.length, 1);
    assert.ok(report.adjustments[0].evidence.length >= MIN_COMPARABLE_COUNT);

    const inspected = box.cli(["inspect", "--history-dir", box.history, "--learn-dir", box.learn, "--kind", "feature", "--difficulty", "standard"]);
    assert.equal(inspected.status, 0, inspected.err);
    assert.equal(inspected.json.adjustments.length, 1);

    const refused = box.cli(["reset", "--learn-dir", box.learn]);
    assert.equal(refused.status, 2);

    const reset = box.cli(["reset", "--yes", "--learn-dir", box.learn, "--now", NOW]);
    assert.equal(reset.status, 0, reset.err);
    assert.equal(reset.json.resetAt, NOW);
    assert.ok(openStore(box.history).recordIds().length >= 3);
  } finally {
    box.cleanup();
  }
});

test("recommend surfaces baselineRecommendation beside a learned adjustment and never sends history to Jev inputs", async () => {
  const box = sandbox();
  try {
    for (const id of ["rec1", "rec2", "rec3"]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    const candidates = [
      { agent: "claude", model: "claude-sonnet-5-5", effort: "high", capability: "standard", suits: "Analysis", unusable: null },
      { agent: "cursor", model: "composer-2.5", effort: null, capability: "standard", suits: "Scripting", unusable: null },
    ];
    const result = await recommend(
      {
        task: "112",
        summary: "Scripted change with a clear spec",
        kind: "feature",
        files: 2,
        eligible: [],
        judgment: "standard",
        judgmentReason: "fixture judgment for learning test",
        historyDir: box.history,
        learnDir: box.learn,
        now: NOW,
        agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
        random: () => 0.99,
        learning: loadLearningContext({
          historyDir: box.history,
          learnDir: box.learn,
          kind: "feature",
          difficulty: "standard",
          now: NOW,
          agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
        }),
      },
      candidates,
      {},
    );
    assert.equal(result.status, "recommended");
    assert.equal(choice(result.baselineRecommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(choice(result.recommendation), "cursor/composer-2.5");
    assert.ok(result.learning.applied.length >= 1);
    assert.equal(result.launch.started, false);
  } finally {
    box.cleanup();
  }
});

test("exploration occasionally proposes an under-observed suitable option, marked uncertain, without launching", () => {
  const box = sandbox();
  try {
    // Enough evidence for claude so the corpus is active, but none for cursor.
    for (const id of ["e1", "e2", "e3"]) {
      putRecord(box.history, {
        id,
        agent: "claude",
        model: "claude-sonnet-5-5",
        effort: "high",
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    const learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { claude: AGENT_VERSION, cursor: AGENT_VERSION },
    });
    const learned = applyLearning({
      usable: CANDIDATES.filter((c) => c.capability === "standard"),
      kind: "feature",
      difficulty: "standard",
      learning,
      random: () => 0.01, // force exploration branch
    });
    assert.ok(learned.exploration);
    assert.equal(learned.exploration.uncertain, true);
    assert.equal(choice(learned.recommendation), learned.exploration.choice);
    assert.equal(choice(learned.baselineRecommendation), "claude/claude-sonnet-5-5/high");
  } finally {
    box.cleanup();
  }
});

test("buildAdjustments ignores evidence that does not match kind or difficulty", () => {
  const box = sandbox();
  try {
    for (const id of ["k1", "k2", "k3"]) {
      putRecord(box.history, { id, kind: "fix", difficulty: "standard", agent: "cursor", model: "composer-2.5", effort: null });
    }
    const evidence = collectEvidence(openStore(box.history), { now: NOW });
    const feature = buildAdjustments(evidence, { kind: "feature", difficulty: "standard" });
    assert.equal(feature.adjustments.length, 0);
    const fix = buildAdjustments(evidence, { kind: "fix", difficulty: "standard" });
    assert.equal(fix.adjustments.length, 1);
  } finally {
    box.cleanup();
  }
});

test("all-failure corpus demotes the choice and never promotes it over the baseline", () => {
  const box = sandbox();
  try {
    for (const id of ["f1", "f2", "f3"]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        outcome: "failed",
        checks: [{ name: "unit", result: "fail" }],
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    const learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
    });
    const adj = learning.adjustments.find((a) => a.choice === "cursor/composer-2.5");
    assert.ok(adj);
    assert.ok(adj.meanScore < 0);
    const learned = applyLearning({
      usable: CANDIDATES.filter((c) => c.capability === "standard"),
      kind: "feature",
      difficulty: "standard",
      learning,
      random: () => 0.99,
    });
    assert.equal(choice(learned.baselineRecommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(choice(learned.recommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(learned.applied.length, 0);
    assert.ok(learned.demoted.some((d) => d.choice === "cursor/composer-2.5" && /demoted/i.test(d.effect)));
    assert.ok(learned.ordered.findIndex((c) => choice(c) === "cursor/composer-2.5") >
      learned.ordered.findIndex((c) => choice(c) === "claude/claude-sonnet-5-5/high"));
  } finally {
    box.cleanup();
  }
});

test("mixed corpus promotes positive evidence and demotes negative evidence below the baseline band", () => {
  const box = sandbox();
  try {
    for (const id of ["good1", "good2", "good3"]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        outcome: "succeeded",
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    for (const id of ["bad1", "bad2", "bad3"]) {
      putRecord(box.history, {
        id,
        agent: "claude",
        model: "claude-sonnet-5-5",
        effort: "high",
        outcome: "failed",
        checks: [{ name: "unit", result: "fail" }],
        completedAt: "2026-10-26T12:00:00.000Z",
      });
    }
    // A third standard-tier option with no evidence stays in the unevidenced band above demotions.
    const usable = [
      ...CANDIDATES.filter((c) => c.capability === "standard"),
      { agent: "cursor", model: "auto", effort: null, capability: "standard", suits: "Review", usage: "unknown" },
    ];
    const learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
    });
    const learned = applyLearning({
      usable,
      kind: "feature",
      difficulty: "standard",
      learning,
      random: () => 0.99,
    });
    assert.equal(choice(learned.recommendation), "cursor/composer-2.5");
    assert.ok(learned.applied.some((a) => a.choice === "cursor/composer-2.5"));
    assert.ok(learned.demoted.some((d) => d.choice === "claude/claude-sonnet-5-5/high"));
    const order = learned.ordered.map(choice);
    assert.ok(order.indexOf("cursor/composer-2.5") < order.indexOf("cursor/auto"));
    assert.ok(order.indexOf("cursor/auto") < order.indexOf("claude/claude-sonnet-5-5/high"));
  } finally {
    box.cleanup();
  }
});

test("baseline stays recommended when the only evidence is bad", async () => {
  const box = sandbox();
  try {
    for (const id of ["onlybad1", "onlybad2", "onlybad3"]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        outcome: "failed",
        checks: [{ name: "unit", result: "fail" }],
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    const candidates = [
      { agent: "claude", model: "claude-sonnet-5-5", effort: "high", capability: "standard", suits: "Analysis", unusable: null },
      { agent: "cursor", model: "composer-2.5", effort: null, capability: "standard", suits: "Scripting", unusable: null },
    ];
    const result = await awaitRecommendWithLearning(box, candidates);
    assert.equal(choice(result.baselineRecommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(choice(result.recommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(result.learning.applied.length, 0);
    assert.ok(result.learning.demoted.some((d) => d.choice === "cursor/composer-2.5"));
    assert.match(result.recommendation.reason, /[Nn]egative evidence|Demoted/);
  } finally {
    box.cleanup();
  }
});

test("two negative options keep baseline order even when the baseline has the worse mean", async () => {
  const box = sandbox();
  try {
    // Baseline (claude) fails harder: completion fail + check fail ⇒ mean ≈ -1.75.
    for (const id of ["base_bad1", "base_bad2", "base_bad3"]) {
      putRecord(box.history, {
        id,
        agent: "claude",
        model: "claude-sonnet-5-5",
        effort: "high",
        outcome: "failed",
        checks: [{ name: "unit", result: "fail" }],
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    // Peer (cursor) also fails but less hard: failed outcome with a passing check ⇒ mean ≈ -0.5.
    for (const id of ["peer_bad1", "peer_bad2", "peer_bad3"]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        outcome: "failed",
        checks: [{ name: "unit", result: "pass" }],
        completedAt: "2026-10-26T12:00:00.000Z",
      });
    }
    const learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
    });
    const baseAdj = learning.adjustments.find((a) => a.choice === "claude/claude-sonnet-5-5/high");
    const peerAdj = learning.adjustments.find((a) => a.choice === "cursor/composer-2.5");
    assert.ok(baseAdj && peerAdj);
    assert.ok(baseAdj.meanScore < 0 && peerAdj.meanScore < 0);
    assert.ok(baseAdj.meanScore < peerAdj.meanScore, "baseline must be the worse (more negative) mean");

    const learned = applyLearning({
      usable: CANDIDATES.filter((c) => c.capability === "standard"),
      kind: "feature",
      difficulty: "standard",
      learning,
      random: () => 0.99,
    });
    assert.equal(choice(learned.baselineRecommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(choice(learned.recommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(learned.applied.length, 0);
    assert.ok(learned.demoted.some((d) => d.choice === "claude/claude-sonnet-5-5/high"));
    assert.ok(learned.demoted.some((d) => d.choice === "cursor/composer-2.5"));

    const candidates = [
      { agent: "claude", model: "claude-sonnet-5-5", effort: "high", capability: "standard", suits: "Analysis", unusable: null },
      { agent: "cursor", model: "composer-2.5", effort: null, capability: "standard", suits: "Scripting", unusable: null },
    ];
    const result = await awaitRecommendWithLearning(box, candidates);
    assert.equal(choice(result.recommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(result.learning.applied.length, 0);
    assert.match(result.recommendation.reason, /Negative evidence did not promote any choice over the capability-and-usage baseline/);
  } finally {
    box.cleanup();
  }
});

test("demoted baseline yields an unevidenced recommendation and the note says so", async () => {
  const box = sandbox();
  try {
    for (const id of ["demote1", "demote2", "demote3"]) {
      putRecord(box.history, {
        id,
        agent: "claude",
        model: "claude-sonnet-5-5",
        effort: "high",
        outcome: "failed",
        checks: [{ name: "unit", result: "fail" }],
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    const candidates = [
      { agent: "claude", model: "claude-sonnet-5-5", effort: "high", capability: "standard", suits: "Analysis", unusable: null },
      { agent: "cursor", model: "composer-2.5", effort: null, capability: "standard", suits: "Scripting", unusable: null },
    ];
    const result = await awaitRecommendWithLearning(box, candidates);
    assert.equal(choice(result.baselineRecommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(choice(result.recommendation), "cursor/composer-2.5");
    assert.equal(result.learning.applied.length, 0);
    assert.ok(result.learning.demoted.some((d) => d.choice === "claude/claude-sonnet-5-5/high"));
    assert.match(
      result.recommendation.reason,
      /demoted the baseline|changed the pick|recommending cursor\/composer-2\.5/i,
    );
    assert.doesNotMatch(
      result.recommendation.reason,
      /Negative evidence did not promote any choice over the capability-and-usage baseline/,
    );
  } finally {
    box.cleanup();
  }
});

test("duplicate record ids are counted once", () => {
  const box = sandbox();
  try {
    putRecord(box.history, {
      id: "dup1",
      agent: "cursor",
      model: "composer-2.5",
      effort: null,
      completedAt: "2026-10-25T12:00:00.000Z",
    });
    const store = openStore(box.history);
    const row = evidenceFromView(viewRecord(store, store.getRecord("dup1")), { now: NOW });
    const doubled = [row, { ...row }, { ...row, id: "dup2", completedAt: "2026-10-26T12:00:00.000Z" }, { ...row, id: "dup3", completedAt: "2026-10-27T12:00:00.000Z" }];
    // Four entries but dup1 appears thrice — rawCount must be 3 unique ids.
    const { adjustments } = buildAdjustments(doubled, { kind: "feature", difficulty: "standard" });
    assert.equal(adjustments.length, 1);
    assert.equal(adjustments[0].rawCount, 3);
    assert.deepEqual(
      adjustments[0].evidence.map((e) => e.id).sort(),
      ["dup1", "dup2", "dup3"],
    );
  } finally {
    box.cleanup();
  }
});

test("attributable usage is a separate peer signal and never comes from shared usage", () => {
  const box = sandbox();
  try {
    for (const [id, tokens] of [
      ["u1", 100],
      ["u2", 100],
      ["u3", 100],
    ]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        completedAt: "2026-10-25T12:00:00.000Z",
        attributable: [{ source: "provider per-session meter", metrics: { input_tokens: tokens }, at: "2026-10-25T12:00:00.000Z" }],
      });
    }
    for (const [id, tokens] of [
      ["v1", 900],
      ["v2", 900],
      ["v3", 900],
    ]) {
      putRecord(box.history, {
        id,
        agent: "claude",
        model: "claude-sonnet-5-5",
        effort: "high",
        completedAt: "2026-10-25T12:00:00.000Z",
        attributable: [{ source: "provider per-session meter", metrics: { input_tokens: tokens }, at: "2026-10-25T12:00:00.000Z" }],
      });
    }
    const store = openStore(box.history);
    const view = viewRecord(store, store.getRecord("u1"));
    const { total, signals } = signalContributions(view);
    const usage = signals.find((s) => s.name === "attributableUsage");
    assert.equal(usage.value, 0);
    assert.equal(usage.available, true);
    assert.equal(attributableCost(view.usage.attributable), 100);
    assert.ok(total > 0, "quality mean still comes from completion/checks, not usage");

    const learning = loadLearningContext({
      historyDir: box.history,
      learnDir: box.learn,
      kind: "feature",
      difficulty: "standard",
      now: NOW,
      agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
    });
    const cursorAdj = learning.adjustments.find((a) => a.choice === "cursor/composer-2.5");
    const claudeAdj = learning.adjustments.find((a) => a.choice === "claude/claude-sonnet-5-5/high");
    assert.equal(cursorAdj.meanAttributableCost, 100);
    assert.equal(claudeAdj.meanAttributableCost, 900);
    // Equal positive quality → lower attributable cost wins the peer tiebreaker.
    const learned = applyLearning({
      usable: CANDIDATES.filter((c) => c.capability === "standard"),
      kind: "feature",
      difficulty: "standard",
      learning,
      random: () => 0.99,
    });
    assert.equal(choice(learned.recommendation), "cursor/composer-2.5");
  } finally {
    box.cleanup();
  }
});

test("elapsed appears as a separate low-weight signal when the record has it", () => {
  const box = sandbox();
  try {
    putRecord(box.history, { id: "el1", completedAt: "2026-10-25T12:00:00.000Z" });
    const store = openStore(box.history);
    const view = viewRecord(store, store.getRecord("el1"));
    assert.equal(view.signals.elapsed.status, "known");
    const { signals, total, elapsedMs } = signalContributions(view);
    const elapsed = signals.find((s) => s.name === "elapsed");
    assert.ok(elapsed);
    assert.equal(elapsed.value, 0);
    assert.equal(elapsed.ms, view.signals.elapsed.ms);
    assert.equal(elapsedMs, view.signals.elapsed.ms);
    assert.equal(
      signals.filter((s) => s.name === "elapsed").length,
      1,
    );
    // Elapsed does not change the quality total by itself beyond other signals.
    assert.equal(typeof total, "number");
  } finally {
    box.cleanup();
  }
});

test("unreadable history surfaces a learning note and keeps the baseline", async () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.history, "records", "corrupt.json"), "{not-json", { mode: 0o600 });
    const candidates = [
      { agent: "claude", model: "claude-sonnet-5-5", effort: "high", capability: "standard", suits: "Analysis", unusable: null },
      { agent: "cursor", model: "composer-2.5", effort: null, capability: "standard", suits: "Scripting", unusable: null },
    ];
    const result = await recommend(
      {
        task: "112",
        summary: "Scripted change with a clear spec",
        kind: "feature",
        files: 2,
        eligible: [],
        judgment: "standard",
        judgmentReason: "fixture judgment for unreadable history",
        historyDir: box.history,
        learnDir: box.learn,
        now: NOW,
        agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
        random: () => 0.99,
      },
      candidates,
      {},
    );
    assert.equal(result.status, "recommended");
    assert.equal(choice(result.recommendation), "claude/claude-sonnet-5-5/high");
    assert.equal(choice(result.baselineRecommendation), "claude/claude-sonnet-5-5/high");
    assert.match(result.learning.note, /history unreadable:/);
    assert.match(result.learning.note, /baseline used/);
    assert.match(result.recommendation.reason, /history unreadable:/);
  } finally {
    box.cleanup();
  }
});

test("Jev request body never contains history", async () => {
  const box = sandbox();
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.TYPESAFE_API_KEY;
  /** @type {any[]} */
  const bodies = [];
  try {
    for (const id of ["jev1", "jev2", "jev3"]) {
      putRecord(box.history, {
        id,
        agent: "cursor",
        model: "composer-2.5",
        effort: null,
        completedAt: "2026-10-25T12:00:00.000Z",
      });
    }
    process.env.TYPESAFE_API_KEY = "test-key-do-not-print";
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: {
            enough_information: { type: "noul", noul: 0.41 },
            reasoning: {
              type: "score",
              score: 1,
              confidence: 1,
              legend: { "0": "Mechanical", "1": "Moderate", "2": "Deep" },
              probabilities: { "0": 0, "1": 1, "2": 0 },
            },
            wide_change: { type: "noul", noul: 0.1 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const candidates = [
      { agent: "claude", model: "claude-sonnet-5-5", effort: "high", capability: "standard", suits: "Analysis", unusable: null },
      { agent: "cursor", model: "composer-2.5", effort: null, capability: "standard", suits: "Scripting", unusable: null },
    ];
    const result = await recommend(
      {
        task: "112",
        summary: "Scripted change with a clear spec",
        kind: "feature",
        files: 2,
        eligible: [],
        historyDir: box.history,
        learnDir: box.learn,
        now: NOW,
        agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
        random: () => 0.99,
      },
      candidates,
      {},
    );
    assert.equal(result.status, "recommended");
    assert.equal(bodies.length, 1);
    const payload = JSON.stringify(bodies[0]);
    assert.equal(payload.includes("jev1"), false);
    assert.equal(payload.includes("composer-2.5"), false);
    assert.equal(payload.includes(box.history), false);
    assert.equal(payload.includes("history"), false);
    assert.equal(payload.includes("learning"), false);
    assert.deepEqual(Object.keys(bodies[0]).sort(), ["model", "questions", "state"]);
    assert.deepEqual(Object.keys(bodies[0].state).sort(), ["estimated_files", "kind", "task"]);
    assert.equal(bodies[0].state.task, "Scripted change with a clear spec");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    box.cleanup();
  }
});

test("documentation lists the learn commands in the agent gate list", () => {
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /scripts\/orca-learn\.mjs/);
  assert.match(agents, /docs\/agents\/learned-adjustments\.md/);
  const doc = readFileSync(join(repoRoot, "docs", "agents", "learned-adjustments.md"), "utf8");
  assert.match(doc, /MIN_COMPARABLE_COUNT|At least \*\*3\*\*/);
  assert.match(doc, /reset --yes/);
  assert.match(doc, /baselineRecommendation|baseline/);
  assert.match(doc, /shared usage/i);
  assert.match(doc, /override/i);
  assert.match(doc, /decay-weighted mean|combined score/i);
  assert.match(doc, /demotes|demoted/i);
  assert.match(doc, /not available/i);
  assert.doesNotMatch(doc, /no single opaque quality score/);
});

async function awaitRecommendWithLearning(box, candidates) {
  return recommend(
    {
      task: "112",
      summary: "Scripted change with a clear spec",
      kind: "feature",
      files: 2,
      eligible: [],
      judgment: "standard",
      judgmentReason: "fixture judgment for learning test",
      historyDir: box.history,
      learnDir: box.learn,
      now: NOW,
      agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
      random: () => 0.99,
      learning: loadLearningContext({
        historyDir: box.history,
        learnDir: box.learn,
        kind: "feature",
        difficulty: "standard",
        now: NOW,
        agentVersions: { cursor: AGENT_VERSION, claude: AGENT_VERSION },
      }),
    },
    candidates,
    {},
  );
}

function choice(row) {
  if (!row) return null;
  return [row.agent, row.model, row.effort].filter((part) => part !== undefined && part !== null && part !== "").join("/");
}
