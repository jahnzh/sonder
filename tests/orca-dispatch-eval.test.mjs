import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildDispatchEvaluation,
  choiceKey,
  compareAssignment,
  formatEvaluationMarkdown,
  main,
} from "../scripts/orca-dispatch-eval.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "scripts", "orca-dispatch-eval.mjs");

test("choiceKey and compareAssignment record agree and disagree without claiming correctness", () => {
  assert.equal(choiceKey({ agent: "claude", model: "claude-opus-5-5", effort: "high" }), "claude/claude-opus-5-5/high");
  assert.equal(choiceKey({ agent: "cursor", model: "auto", effort: null }), "cursor/auto/none");
  assert.deepEqual(
    compareAssignment(
      { agent: "claude", model: "claude-opus-5-5", effort: "high" },
      { agent: "claude", model: "claude-opus-5-5", effort: "high" },
    ).agreement,
    "agree",
  );
  const cross = compareAssignment(
    { agent: "claude", model: "claude-opus-5-5", effort: "high" },
    { agent: "cursor", model: "auto", effort: null },
  );
  assert.equal(cross.agreement, "disagree");
  assert.match(cross.detail, /different agent/);
  assert.equal(compareAssignment(null, { agent: "codex", model: "gpt-6.1-terra", effort: "max" }).agreement, "unknown");
});

test("buildDispatchEvaluation summarizes controlled hard, constrained, shared, override and learning cases", () => {
  const report = buildDispatchEvaluation({
    generatedAt: "2026-10-30T17:00:00.000Z",
    liveUsage: {
      claude: { status: "fresh", capacityConfirmed: true, freshness: "fresh", reason: "session 12% used" },
      codex: { status: "exhausted", capacityConfirmed: false, freshness: "fresh", reason: "5h exhausted" },
      cursor: { status: "unknown", capacityConfirmed: false, freshness: "unknown", reason: "credentials missing" },
      antigravity: { status: "fresh", capacityConfirmed: true, freshness: "fresh", reason: "flash ok" },
    },
    scenarios: [
      {
        id: "hard-reasoning",
        kind: "hard",
        summary: "Reproduce a timing bug across player and reader",
        requirement: "reasoning-heavy",
        baseline: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
        recommended: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
        usageByAgent: { claude: { status: "fresh", capacityConfirmed: true, freshness: "fresh" } },
        actualOutcome: "not_run",
        evidenceGaps: ["no live worker outcome recorded"],
      },
      {
        id: "constrained-codex",
        kind: "constrained",
        summary: "Standard scripting while Codex is exhausted",
        requirement: "standard",
        baseline: { agent: "codex", model: "gpt-6.1-terra", effort: "max" },
        recommended: { agent: "cursor", model: "composer-2.5", effort: null },
        usageByAgent: {
          codex: { status: "exhausted", capacityConfirmed: false, freshness: "fresh", reason: "5h" },
          cursor: { status: "fresh", capacityConfirmed: true, freshness: "fresh" },
        },
        actualOutcome: "not_run",
        evidenceGaps: ["disagreement vs baseline is expected under exhaustion; outcome unknown"],
        providerLimitations: ["Codex percentages are not comparable with Cursor"],
      },
      {
        id: "shared-capacity",
        kind: "shared",
        summary: "Two mechanical tasks share Antigravity",
        requirement: "mechanical",
        baseline: { agent: "antigravity", model: "gemini-4-argon-high", effort: null },
        recommended: { agent: "antigravity", model: "gemini-4-argon-high", effort: null },
        usageByAgent: { antigravity: { status: "low", capacityConfirmed: true, freshness: "fresh", reason: "remaining 8%" } },
        actualOutcome: "not_run",
        notes: "sharedWith would list active and proposed on a real plan",
      },
      {
        id: "override",
        kind: "override",
        summary: "Coordinator forces Codex despite a Cursor recommendation",
        requirement: "standard",
        baseline: { agent: "cursor", model: "composer-2.5", effort: null },
        recommended: { agent: "codex", model: "gpt-6.1-terra", effort: "max" },
        usageByAgent: { codex: { status: "fresh", capacityConfirmed: true }, cursor: { status: "fresh", capacityConfirmed: true } },
        actualOutcome: "not_run",
        evidenceGaps: ["override is recorded without labeling the original wrong"],
      },
      {
        id: "learned-reorder",
        kind: "learning",
        summary: "Learning reorders within a tier but baseline stays visible",
        requirement: "standard",
        baseline: { agent: "cursor", model: "composer-2.5", effort: null },
        baselineRecommendation: { agent: "cursor", model: "composer-2.5", effort: null },
        recommended: { agent: "codex", model: "gpt-6.1-terra", effort: "max" },
        learnedAdjustment: true,
        usageByAgent: {
          cursor: { status: "fresh", capacityConfirmed: true },
          codex: { status: "fresh", capacityConfirmed: true },
        },
        actualOutcome: "not_run",
      },
    ],
    notes: ["Controlled fixtures only; live readings are documented separately."],
  });

  assert.equal(report.summary.scenarioCount, 5);
  assert.equal(report.summary.agreements.agree, 2);
  assert.equal(report.summary.agreements.disagree, 3);
  assert.equal(report.summary.learnedAdjustments, 1);
  assert.deepEqual(report.summary.unmetLiveProviders, ["codex", "cursor"]);
  const markdown = formatEvaluationMarkdown(report);
  assert.match(markdown, /hard-reasoning/);
  assert.match(markdown, /Agreement: disagree/);
  assert.match(markdown, /Learned adjustment changed assignment: true/);
  assert.match(markdown, /Coordinator workflow/);
  assert.match(markdown, /never launch duplicate workers/i);
});

test("CLI prints markdown from a scenarios file built in a temporary directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sonder-dispatch-eval-"));
  try {
    const scenarios = join(dir, "scenarios.json");
    writeFileSync(
      scenarios,
      JSON.stringify({
        title: "Fixture evaluation",
        generatedAt: "2026-10-30T17:00:00.000Z",
        scenarios: [
          {
            id: "fixture",
            baseline: { agent: "antigravity", model: "gemini-4-argon-high", effort: null },
            recommended: { agent: "antigravity", model: "gemini-4-argon-high", effort: null },
            usageByAgent: { antigravity: { status: "fresh", capacityConfirmed: true, freshness: "fresh" } },
          },
        ],
      }),
    );
    const lines = [];
    const code = await main(["--scenarios", scenarios], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /Fixture evaluation/);
    assert.match(lines.join("\n"), /Agreement: agree/);

    const spawned = spawnSync(process.execPath, [cli, "--scenarios", scenarios, "--json"], { encoding: "utf8" });
    assert.equal(spawned.status, 0, spawned.stderr);
    const json = JSON.parse(spawned.stdout);
    assert.equal(json.scenarios[0].comparison.agreement, "agree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
