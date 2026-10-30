#!/usr/bin/env node
/**
 * Builds a repeatable multi-provider dispatch evaluation report from controlled
 * scenario records. It never starts workers, never calls Jev, and never sends
 * history anywhere. Live readings belong in docs/agents/dispatch-evaluation.md.
 *
 * See docs/agents/dispatch-evaluation.md.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/orca-dispatch-eval.mjs [--scenarios <file.json>] [--json]

Reads controlled scenario records and prints an evaluation report (Markdown by
default, JSON with --json). Does not refresh usage, call Jev, launch workers or
touch history. For live verification, see docs/agents/dispatch-evaluation.md.`;

/**
 * @param {{ agent?: string, model?: string, effort?: string | null } | null | undefined} choice
 */
export function choiceKey(choice) {
  if (!choice || typeof choice !== "object" || !choice.agent || !choice.model) return null;
  return [choice.agent, choice.model, choice.effort ?? "none"].join("/");
}

/**
 * Compares a baseline (pre-usage coordinator / models.md) pick with a planner pick.
 * Disagreement is recorded without claiming either side is correct.
 *
 * @param {{ agent?: string, model?: string, effort?: string | null } | null | undefined} baseline
 * @param {{ agent?: string, model?: string, effort?: string | null } | null | undefined} recommended
 */
export function compareAssignment(baseline, recommended) {
  const baselineKey = choiceKey(baseline);
  const recommendedKey = choiceKey(recommended);
  if (!baselineKey && !recommendedKey) {
    return { agreement: "unknown", baseline: null, recommended: null, detail: "neither side produced a choice" };
  }
  if (!baselineKey) {
    return { agreement: "unknown", baseline: null, recommended: recommendedKey, detail: "baseline choice missing" };
  }
  if (!recommendedKey) {
    return { agreement: "disagree", baseline: baselineKey, recommended: null, detail: "planner produced no choice" };
  }
  if (baselineKey === recommendedKey) {
    return { agreement: "agree", baseline: baselineKey, recommended: recommendedKey, detail: "same agent/model/effort" };
  }
  if (baseline?.agent === recommended?.agent) {
    return {
      agreement: "disagree",
      baseline: baselineKey,
      recommended: recommendedKey,
      detail: "same agent, different model or effort",
    };
  }
  return {
    agreement: "disagree",
    baseline: baselineKey,
    recommended: recommendedKey,
    detail: "different agent",
  };
}

/**
 * @param {object} scenario
 */
function normalizeScenario(scenario) {
  const comparison = compareAssignment(scenario.baseline, scenario.recommended);
  const usage = scenario.usageByAgent && typeof scenario.usageByAgent === "object" ? scenario.usageByAgent : {};
  const usageSummary = Object.fromEntries(
    Object.entries(usage).map(([agent, report]) => [
      agent,
      {
        status: report?.status ?? "unknown",
        capacityConfirmed: report?.capacityConfirmed === true,
        freshness: report?.freshness ?? null,
        reason: report?.reason ?? null,
        fallback: report?.refresh?.reason === "rate_limited_backoff" || report?.status === "stale" || report?.status === "unavailable" || report?.status === "unknown",
      },
    ]),
  );
  const learned = scenario.learnedAdjustment === true || scenario.learnedAdjustment === false
    ? scenario.learnedAdjustment
    : Boolean(scenario.baselineRecommendation && choiceKey(scenario.baselineRecommendation) !== choiceKey(scenario.recommended));
  return {
    id: String(scenario.id ?? "untitled"),
    kind: scenario.kind ?? "representative",
    summary: scenario.summary ?? "",
    requirement: scenario.requirement ?? null,
    comparison,
    usageByAgent: usageSummary,
    actualOutcome: scenario.actualOutcome ?? "not_run",
    evidenceGaps: Array.isArray(scenario.evidenceGaps) ? scenario.evidenceGaps : [],
    providerLimitations: Array.isArray(scenario.providerLimitations) ? scenario.providerLimitations : [],
    learnedAdjustment: learned,
    notes: scenario.notes ?? null,
  };
}

/**
 * Builds a structured evaluation report from controlled scenario records.
 *
 * @param {{
 *   title?: string,
 *   generatedAt?: string,
 *   scenarios?: object[],
 *   liveUsage?: Record<string, object> | null,
 *   coordinatorWorkflow?: string[],
 *   notes?: string[],
 * }} [input]
 */
export function buildDispatchEvaluation(input = {}) {
  const scenarios = (input.scenarios ?? []).map(normalizeScenario);
  const agreements = { agree: 0, disagree: 0, unknown: 0 };
  for (const row of scenarios) agreements[row.comparison.agreement] += 1;
  return {
    title: input.title ?? "Multi-provider dispatch evaluation",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    summary: {
      scenarioCount: scenarios.length,
      agreements,
      learnedAdjustments: scenarios.filter((row) => row.learnedAdjustment).length,
      unmetLiveProviders: Object.entries(input.liveUsage ?? {})
        .filter(([, report]) => !report || report.capacityConfirmed !== true)
        .map(([agent]) => agent),
    },
    scenarios,
    liveUsage: input.liveUsage ?? null,
    coordinatorWorkflow: input.coordinatorWorkflow ?? [
      "Refresh collector status (`node scripts/orca-usage.mjs status`) or rely on the minute poll.",
      "Plan the ready wave with `node scripts/orca-plan.mjs --wave <file>` (refreshes all four readers first).",
      "Accept or override each proposal; record the choice in the worker spec. Do not treat Jev confidence as proof.",
      "After workers finish, store outcomes with `node scripts/orca-history.mjs` and inspect learning with `node scripts/orca-learn.mjs`.",
      "Re-run this evaluation from controlled scenario JSON; never launch duplicate workers to regenerate it.",
    ],
    notes: input.notes ?? [],
  };
}

/**
 * @param {ReturnType<typeof buildDispatchEvaluation>} report
 */
export function formatEvaluationMarkdown(report) {
  const lines = [
    `# ${report.title}`,
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Scenarios: ${report.summary.scenarioCount}`,
    `- Agreements: agree ${report.summary.agreements.agree}, disagree ${report.summary.agreements.disagree}, unknown ${report.summary.agreements.unknown}`,
    `- Learned adjustments present: ${report.summary.learnedAdjustments}`,
    `- Live providers without confirmed capacity in this report: ${report.summary.unmetLiveProviders.length ? report.summary.unmetLiveProviders.join(", ") : "(none listed)"}`,
    "",
    "## Coordinator workflow",
    "",
    ...report.coordinatorWorkflow.map((step) => `1. ${step}`),
    "",
    "## Scenarios",
    "",
  ];
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.id}`);
    lines.push("");
    if (scenario.summary) lines.push(scenario.summary, "");
    lines.push(`- Kind: ${scenario.kind}`);
    if (scenario.requirement) lines.push(`- Requirement: ${scenario.requirement}`);
    lines.push(`- Baseline: ${scenario.comparison.baseline ?? "(none)"}`);
    lines.push(`- Recommended: ${scenario.comparison.recommended ?? "(none)"}`);
    lines.push(`- Agreement: ${scenario.comparison.agreement} (${scenario.comparison.detail})`);
    lines.push(`- Actual outcome: ${scenario.actualOutcome}`);
    lines.push(`- Learned adjustment changed assignment: ${scenario.learnedAdjustment}`);
    const usageBits = Object.entries(scenario.usageByAgent).map(
      ([agent, row]) => `${agent}=${row.status}${row.fallback ? " (fallback/unconfirmed)" : ""}`,
    );
    lines.push(`- Usage: ${usageBits.length ? usageBits.join("; ") : "(none)"}`);
    if (scenario.evidenceGaps.length) lines.push(`- Evidence gaps: ${scenario.evidenceGaps.join("; ")}`);
    if (scenario.providerLimitations.length) lines.push(`- Provider limitations: ${scenario.providerLimitations.join("; ")}`);
    if (scenario.notes) lines.push(`- Notes: ${scenario.notes}`);
    lines.push("");
  }
  if (report.liveUsage) {
    lines.push("## Live usage snapshot", "");
    for (const [agent, row] of Object.entries(report.liveUsage)) {
      lines.push(
        `- ${agent}: status=${row?.status ?? "unknown"} capacityConfirmed=${row?.capacityConfirmed === true} freshness=${row?.freshness ?? "n/a"} reason=${row?.reason ?? "n/a"}`,
      );
    }
    lines.push("");
  }
  if (report.notes.length) {
    lines.push("## Notes", "", ...report.notes.map((note) => `- ${note}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseArgs(argv) {
  const options = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--scenarios") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) return { error: "--scenarios needs a file path" };
      options.scenarios = value;
      i += 1;
      continue;
    }
    return { error: `unknown option: ${arg}` };
  }
  return { options };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? ((line) => console.log(line));
  const stderr = deps.stderr ?? ((line) => console.error(line));
  const parsed = parseArgs(argv);
  if (parsed.help) {
    stdout(USAGE);
    return 0;
  }
  if (parsed.error) {
    stderr(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  let input = { scenarios: [] };
  if (parsed.options.scenarios) {
    try {
      input = JSON.parse(readFileSync(parsed.options.scenarios, "utf8"));
    } catch (error) {
      stderr(`cannot read scenarios: ${error.message}`);
      return 1;
    }
  }
  const report = buildDispatchEvaluation(input);
  stdout(parsed.options.json ? JSON.stringify(report, null, 2) : formatEvaluationMarkdown(report));
  return 0;
}

const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  process.exitCode = await main();
}
