#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, usageForPlanning } from "./orca-usage.mjs";
import { applyLearning, defaultLearnDir, loadLearningContext } from "./orca-learn.mjs";
import { defaultDir as defaultHistoryDir } from "./orca-history.mjs";
import {
  NO_POLICY,
  burnPressure,
  expectedShareFor,
  expectedShareSkip,
  formatBurnReason,
  policyVerdict,
  rankByPressure,
  resolvePolicy,
  shortBucketLabel as routingShortBucketLabel,
} from "./orca-routing.mjs";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// Pinned, not jev-latest: an alias can move and change answers without any change here.
const JEV_MODEL = "jev-1.14.0";
const JEV_TIMEOUT_MS = 20000;
const MAX_SUMMARY_LENGTH = 600;
const TASK_KINDS = ["feature", "fix", "refactor", "test", "docs", "review"];
const REQUIREMENTS = ["mechanical", "standard", "reasoning-heavy"];

// Starting points from TypeSafe's docs, checked against seven live tasks on jev-1.14.0 but not tuned.
// One reasoning level must hold >= MIN_REASONING_PROBABILITY so split distributions stay inconclusive.
const MIN_REASONING_CONFIDENCE = 0.5;
const MIN_REASONING_PROBABILITY = 0.7;
const NOUL_NO = 0.3;
const NOUL_YES = 0.7;

// For agents that are not in PROVIDERS / usageByAgent for this run.
const UNKNOWN_USAGE = {
  status: "unknown",
  reason: "no verified usage collector covers this agent",
  source: null,
  observedAt: null,
  account: "unknown",
  host: "unknown",
  capacityConfirmed: false,
};

// Narrow questions, combined in assessJev: TypeSafe advises against one multi-factor question.
const REASONING_LEVELS = [
  "Mechanical: the steps are spelled out, such as a scripted change, a small UI edit or a documentation change",
  "Moderate: analysis, diagnosis or scripting with a clear spec",
  "Deep: reproducing timing or rendering bugs, metric and analysis work, or designing behaviour across components",
];
const QUESTIONS = {
  enough_information: {
    type: "noul",
    instructions: "The description says enough to judge how hard this software task is.",
  },
  reasoning: {
    type: "score",
    instructions: "How much reasoning does this software task need from the engineer doing it?",
    criteria: REASONING_LEVELS,
  },
  wide_change: {
    type: "noul",
    instructions: "This change reaches many files or a shared interface across the codebase, such as a cross-file refactor.",
  },
};

const USAGE = `Usage: node scripts/orca-recommend.mjs --task <id> --summary <text> [--kind <kind>] [--files <n>]
         [--eligible <agent>/<model>[/<effort>]]... [--judgment <requirement> --judgment-reason <text>]
         [--override <agent>/<model>[/<effort>] --override-reason <text>] [--record <spec-file>] [--models <file>]
         [--policy <file>] [--review-of <agent>/<model>[/<effort>]]
         [--history-dir <dir>] [--learn-dir <dir>] [--no-learning] [--agent-version <agent>=<version>]...

Recommends a worker for one ready task and prints JSON. It never starts a worker: pass launch.args to
scripts/orca-spawn.sh. Only --summary, --kind and --files are sent to Jev, so keep the summary shareable.
History and transcripts are never sent to Jev. Learning never launches a worker.

  --summary          The task in at most ${MAX_SUMMARY_LENGTH} characters.
  --kind             ${TASK_KINDS.join(", ")}.
  --files            Estimated number of files the change touches.
  --eligible         Limit the recommendation to these choices; repeatable. Without an effort, every documented one.
  --judgment         ${REQUIREMENTS.join(", ")}: the assessment to use when Jev gives none. Needs --judgment-reason.
  --override         The worker chosen instead of the recommendation. Needs --override-reason.
  --record           Write the choice into this spec's "## Model choice" section.
  --models           The capability baseline (default: docs/agents/models.md).
  --policy           Routing policy JSON (default: routing-policy.json beside --models). See docs/agents/routing-policy.md.
  --review-of        Pick a reviewer on a different agent and quota bucket than this implementer (policy reviewerOnDifferentPool).
  --history-dir      Worker history directory (default: $ORCA_HISTORY_DIR or artifacts/orca/history).
  --learn-dir        Learned-adjustment state (default: $ORCA_LEARN_DIR or artifacts/orca/learning).
  --no-learning      Use only the capability-and-usage baseline (still prints baselineRecommendation).
  --agent-version    Current agent tooling version for comparability; repeatable as <agent>=<version>.

Takes a fresh usage reading first for each agent scripts/orca-usage.mjs collects. Candidates with exhausted usage
are rejected, and only "fresh" and "low" usage confirm any capacity; see docs/agents/usage-collector.md.
With a routing policy, capability is a hard filter and burn pressure ranks within the tier (docs/agents/routing-policy.md).
When history has enough comparable outcomes, learning may reorder within the smallest suitable capability
tier but never past the policy; the baseline pick is always shown beside any adjusted recommendation
(see docs/agents/learned-adjustments.md).

Exit codes: 0 a worker was chosen, 1 nothing suitable or an override was refused, 2 bad usage,
3 Jev gave no usable assessment and no --judgment was supplied.
Reads TYPESAFE_API_KEY and ORCA_USAGE_STATE_DIR. ORCA_RECOMMEND_JEV_URL and ORCA_RECOMMEND_JEV_TIMEOUT_MS replace the endpoint and timeout (tests).`;

/** @param {string} value */
function parseChoice(value) {
  const parts = value.split("/");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !part)) return null;
  return { agent: parts[0], model: parts[1], effort: parts[2] ?? null };
}

/**
 * @param {string[]} argv
 * @returns {{ help: true } | { error: string } | { options: Record<string, any> }}
 */
export function parseCliArgs(argv) {
  const options = { eligible: [], agentVersions: {}, learning: undefined };
  const flags = {
    "--task": "task",
    "--summary": "summary",
    "--kind": "kind",
    "--files": "files",
    "--judgment": "judgment",
    "--judgment-reason": "judgmentReason",
    "--override": "override",
    "--override-reason": "overrideReason",
    "--record": "record",
    "--models": "models",
    "--policy": "policy",
    "--review-of": "reviewOf",
    "--history-dir": "historyDir",
    "--learn-dir": "learnDir",
  };
  for (let i = 0; i < argv.length; ) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--no-learning") {
      options.learning = false;
      i += 1;
      continue;
    }
    if (flag === "--eligible" || flag === "--agent-version" || flags[flag]) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) return { error: `${flag} needs a value` };
      if (flag === "--eligible") {
        const choice = parseChoice(value);
        if (!choice) return { error: `--eligible must be <agent>/<model>[/<effort>], got: ${value}` };
        options.eligible.push(choice);
      } else if (flag === "--agent-version") {
        const eq = value.indexOf("=");
        if (eq <= 0 || eq === value.length - 1) return { error: `--agent-version must be <agent>=<version>, got: ${value}` };
        options.agentVersions[value.slice(0, eq)] = value.slice(eq + 1);
      } else {
        options[flags[flag]] = value;
      }
      i += 2;
      continue;
    }
    return { error: `unknown option: ${flag}` };
  }
  if (!options.task?.trim() || !options.summary?.trim()) return { error: "--task and --summary are required" };
  if (options.summary.length > MAX_SUMMARY_LENGTH) return { error: `--summary is ${options.summary.length} characters; the limit is ${MAX_SUMMARY_LENGTH}` };
  if (options.kind !== undefined && !TASK_KINDS.includes(options.kind)) return { error: `--kind must be one of ${TASK_KINDS.join(", ")}` };
  if (options.files !== undefined) {
    if (!/^\d+$/.test(options.files)) return { error: "--files must be a whole number" };
    options.files = Number(options.files);
  }
  if (options.judgment !== undefined && !REQUIREMENTS.includes(options.judgment)) return { error: `--judgment must be one of ${REQUIREMENTS.join(", ")}` };
  if ((options.judgment === undefined) !== (options.judgmentReason === undefined)) return { error: "--judgment and --judgment-reason go together" };
  if (options.judgmentReason !== undefined && !options.judgmentReason.trim()) return { error: "--judgment-reason must not be blank" };
  if ((options.override === undefined) !== (options.overrideReason === undefined)) return { error: "--override and --override-reason go together" };
  if (options.overrideReason !== undefined && !options.overrideReason.trim()) return { error: "--override-reason must not be blank" };
  if (options.override !== undefined) {
    options.override = parseChoice(options.override);
    if (!options.override) return { error: "--override must be <agent>/<model>[/<effort>]" };
  }
  if (options.reviewOf !== undefined) {
    options.reviewOf = parseChoice(options.reviewOf);
    if (!options.reviewOf) return { error: "--review-of must be <agent>/<model>[/<effort>]" };
  }
  if (options.record !== undefined && (!options.record.trim() || !existsSync(options.record))) return { error: `spec file not found: ${options.record}` };
  if (options.models !== undefined && !options.models.trim()) return { error: "--models must not be blank" };
  if (options.policy !== undefined && !String(options.policy).trim()) return { error: "--policy must not be blank" };
  if (options.historyDir !== undefined && !options.historyDir.trim()) return { error: "--history-dir must not be blank" };
  if (options.learnDir !== undefined && !options.learnDir.trim()) return { error: "--learn-dir must not be blank" };
  return { options };
}

/**
 * Reads the first table of the baseline; one candidate per model and effort.
 * @param {string} text
 */
export function parseBaseline(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith("|"));
  if (start < 0) throw new Error("the baseline has no table");
  const end = lines.findIndex((line, i) => i > start && !line.trimStart().startsWith("|"));
  const rows = lines.slice(start, end < 0 ? lines.length : end).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const column = (name) => rows[0].indexOf(name);
  const [agent, model, efforts, capability, suits] = ["Agent", "Model ID", "Supported effort values", "Capability", "Suits"].map(column);
  if ([agent, model, efforts, capability, suits].includes(-1)) throw new Error("the baseline table lacks a required column");
  return rows.slice(2).flatMap((row) => {
    const listed = [...row[efforts].matchAll(/`([^`]+)`/g)]
      .map((match) => match[1].trim())
      .filter((effort) => effort && effort.toLowerCase() !== "none");
    return (listed.length ? listed : [null]).map((effort) => ({
      agent: row[agent],
      model: row[model].replaceAll("`", ""),
      effort,
      capability: row[capability],
      suits: row[suits],
    }));
  });
}

/** The same check orca-spawn.sh makes, so a model it would refuse is not recommended. */
function listedCursorModels() {
  const listing = spawnSync("agent", ["--list-models"], { encoding: "utf8", timeout: 30000 });
  if (listing.status !== 0) return null;
  return new Set(listing.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]));
}

/** Why a candidate cannot be launched at all, or null. */
export function loadCandidates(file) {
  const candidates = parseBaseline(readFileSync(file, "utf8"));
  const cursorModels = candidates.some((c) => c.agent === "cursor") ? listedCursorModels() : undefined;
  return candidates.map((candidate) => {
    let unusable = null;
    if (!REQUIREMENTS.includes(candidate.capability)) unusable = "no documented capability";
    else if (candidate.agent === "cursor" && cursorModels === null) unusable = "agent --list-models failed, so the launch would refuse it";
    else if (candidate.agent === "cursor" && !cursorModels.has(candidate.model)) unusable = "agent --list-models does not list it";
    return { ...candidate, unusable };
  });
}

const choiceName = ({ agent, model, effort }) => [agent, model, effort].filter(Boolean).join("/");
const inRange = (value, max) => typeof value === "number" && value >= 0 && value <= max;
const inUnit = (value) => inRange(value, 1);
const rank = (requirement) => REQUIREMENTS.indexOf(requirement);

function redactSecret(text) {
  if (typeof text !== "string") return text;
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? text.replaceAll(key, "[redacted]") : text;
}

/** Reads the three answers, or throws a message that says which one is wrong. */
function readAnswers(body) {
  if (typeof body?.model !== "string" || !body.model) throw new Error("the response names no model");
  const answers = body.answers ?? {};
  for (const name of ["enough_information", "wide_change"]) {
    if (answers[name]?.type !== "noul" || !inUnit(answers[name].noul)) throw new Error(`${name} is not a valid noul answer`);
  }
  const reasoning = answers.reasoning;
  const rawProbabilities = reasoning?.probabilities;
  const validProbabilities =
    rawProbabilities !== null &&
    typeof rawProbabilities === "object" &&
    !Array.isArray(rawProbabilities) &&
    Object.keys(rawProbabilities).length === REASONING_LEVELS.length;
  const levelProbabilities = REASONING_LEVELS.map((_, level) => rawProbabilities?.[String(level)]);
  const total = levelProbabilities.reduce((sum, p) => sum + p, 0);
  if (
    reasoning?.type !== "score" ||
    !inRange(reasoning.score, REASONING_LEVELS.length - 1) ||
    !inUnit(reasoning.confidence) ||
    !validProbabilities ||
    !levelProbabilities.every(inUnit) ||
    Math.abs(total - 1) > 0.02
  ) {
    throw new Error("reasoning is not a valid score answer");
  }
  const level = levelProbabilities.reduce((best, p, i) => (p >= levelProbabilities[best] ? i : best), 0);
  const probabilities = Object.fromEntries(REASONING_LEVELS.map((_, i) => [String(i), levelProbabilities[i]]));
  return {
    level,
    levelProbability: levelProbabilities[level],
    score: reasoning.score,
    probabilities,
    confidence: reasoning.confidence,
    enoughInformation: answers.enough_information.noul,
    wideChange: answers.wide_change.noul,
  };
}

/** Reads the requirement from the answers, or null when they do not settle it. */
function requirementFrom({ level, levelProbability, confidence, enoughInformation, wideChange }) {
  // Split distributions (< MIN_REASONING_PROBABILITY) and "no" enough_information (<= NOUL_NO) stay inconclusive.
  if (confidence < MIN_REASONING_CONFIDENCE || levelProbability < MIN_REASONING_PROBABILITY || enoughInformation <= NOUL_NO) return null;
  // Breadth only moves moderate work, so doubt about it elsewhere is harmless. A cross-file change is
  // reasoning-heavy under AGENTS.md, while a mechanical rename across many files stays mechanical.
  if (level !== 1) return REQUIREMENTS[level];
  if (wideChange >= NOUL_YES) return "reasoning-heavy";
  return wideChange <= NOUL_NO ? "standard" : null;
}

/** @param {Record<string, any>} options */
async function assessJev(options) {
  const report = { status: "unavailable", requestedModel: JEV_MODEL, version: null, detail: null, uncertainty: null };
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) return { ...report, detail: "TYPESAFE_API_KEY is not set" };
  const redact = (text) => redactSecret(text).slice(0, 200);

  const state = { task: redactSecret(options.summary) };
  if (options.kind !== undefined) state.kind = options.kind;
  if (options.files !== undefined) state.estimated_files = options.files;

  let response;
  let text;
  try {
    response = await fetch(process.env.ORCA_RECOMMEND_JEV_URL || JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions: QUESTIONS }),
      signal: AbortSignal.timeout(Number(process.env.ORCA_RECOMMEND_JEV_TIMEOUT_MS) || JEV_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    return { ...report, detail: redact(`${error.name}: ${error.cause?.code ?? error.message}`) };
  }
  if (!response.ok) {
    let reason = "";
    try {
      // A 422 detail is an array that can echo the request, so only the documented message fields are read.
      const { error_type: type, message } = JSON.parse(text).detail;
      if (typeof type === "string" && typeof message === "string") reason = ` ${type}: ${message}`;
    } catch {}
    return { ...report, detail: redact(`HTTP ${response.status}${reason}`) };
  }

  let answers;
  let body;
  try {
    body = JSON.parse(text);
    answers = readAnswers(body);
  } catch (error) {
    return { ...report, status: "invalid", version: typeof body?.model === "string" ? redact(body.model) : null, detail: redact(error.message) };
  }
  const requirement = requirementFrom(answers);
  return {
    ...report,
    status: requirement ? "ok" : "inconclusive",
    version: redact(body.model),
    requirement,
    detail: requirement ? null : "the answers do not settle the requirement",
    uncertainty: {
      conclusive: requirement !== null,
      reasoningScore: answers.score,
      reasoningConfidence: answers.confidence,
      reasoningProbabilities: answers.probabilities,
      enoughInformation: answers.enoughInformation,
      wideChange: answers.wideChange,
      thresholds: {
        minReasoningConfidence: MIN_REASONING_CONFIDENCE,
        minReasoningProbability: MIN_REASONING_PROBABILITY,
        noulNo: NOUL_NO,
        noulYes: NOUL_YES,
      },
    },
  };
}

/** Why a named choice is outside the baseline, or null. An entry with no effort stands for every documented one. */
function undocumented(choice, candidates) {
  const rows = candidates.filter((c) => c.agent === choice.agent && c.model === choice.model);
  if (!rows.length) return "not in the capability baseline";
  if (choice.effort !== null && !rows.some((c) => c.effort === choice.effort)) return `effort ${choice.effort} is not documented for it`;
  return null;
}

/** Why an override cannot be launched as named, or null. It needs one exact row, because it becomes the launch. */
function refuseOverride(override, candidates) {
  const reason = undocumented(override, candidates);
  if (reason) return reason;
  const row = candidates.find((c) => c.agent === override.agent && c.model === override.model && c.effort === override.effort);
  if (!row) return `name an effort: ${candidates.filter((c) => c.model === override.model).map((c) => c.effort).join(", ")}`;
  return row.unusable;
}

function describeAssessment({ source, requirement, jev, coordinator }) {
  if (source === "coordinator") return `Coordinator judged it ${requirement}: ${coordinator.reason}`;
  const { reasoningConfidence, wideChange } = jev.uncertainty;
  return `Jev ${jev.version} assessed it ${requirement} (reasoning confidence ${reasoningConfidence}, wide change ${wideChange})`;
}

function describeJevReport(jev) {
  const parts = [];
  if (jev?.version) parts.push(redactSecret(jev.version));
  if (jev?.uncertainty) {
    const u = jev.uncertainty;
    parts.push(
      `reasoning score ${u.reasoningScore}`,
      `reasoning confidence ${u.reasoningConfidence}`,
      `probabilities ${JSON.stringify(u.reasoningProbabilities)}`,
      `enough information ${u.enoughInformation}`,
      `wide change ${u.wideChange}`,
    );
  }
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function shortBucketLabel(bucket) {
  return routingShortBucketLabel(bucket);
}

function formatBucketUsage(usage) {
  const buckets = Array.isArray(usage.buckets) ? usage.buckets : [];
  if (!buckets.length) return usage.reason ?? usage.status;
  // Prefer the model-scoped Cursor/Antigravity bucket over a parent Plan/total window.
  const scoped =
    buckets.find((bucket) => bucket.id === "included_auto" || bucket.id === "included_api") ??
    buckets.find((bucket) => bucket.id === "gemini-argon-wtu-weekly") ??
    buckets.find((bucket) => bucket.id === "gemini-weekly" || bucket.id === "3p-weekly") ??
    [...buckets].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
  const pct =
    typeof scoped.usedPercent === "number" && Number.isFinite(scoped.usedPercent)
      ? `${(Math.round(scoped.usedPercent * 10) / 10).toFixed(1)}%`
      : "?%";
  return `${shortBucketLabel(scoped)} ${pct} used`;
}

function describeUsage(usage, choice = null) {
  if (choice && Array.isArray(usage.buckets) && usage.buckets.length) {
    const named = `${choiceName(choice)}: ${formatBucketUsage(usage)}`;
    if (usage.status === "fresh") return named;
    if (usage.status === "low") return `${named}, low`;
    if (usage.status === "exhausted") {
      const reset = usage.resetsAt ? `, resets ${usage.resetsAt}` : "";
      return `${named}, exhausted${reset}`;
    }
    if (usage.status === "stale") return `${named}, stale (${usage.reason})`;
    if (usage.status === "unavailable") return `${named}, unavailable (${usage.reason})`;
    return `${named}, unknown`;
  }
  if (usage.status === "fresh") return `Usage read ${usage.observedAt}: ${usage.reason}. That is a snapshot, not reserved capacity`;
  if (usage.status === "low") return `Usage is low, read ${usage.observedAt}: ${usage.reason}`;
  if (usage.status === "stale") return `Usage is stale (${usage.reason}), so capacity is not confirmed`;
  if (usage.status === "unavailable") return `provider data unavailable (${usage.reason})`;
  return "Usage is unknown, so capacity is not confirmed";
}

function usageWarning(agent, usage, choice = null) {
  if (usage.status !== "exhausted" && usage.status !== "low") return null;
  if (choice && Array.isArray(usage.buckets) && usage.buckets.length) {
    const reset = usage.status === "exhausted" && usage.resetsAt ? `, resets ${usage.resetsAt}` : "";
    return `${choiceName(choice)} usage is ${usage.status}: ${formatBucketUsage(usage)}${reset}`;
  }
  return `${agent} usage is ${usage.status}: ${usage.reason}`;
}

function launchArgs({ agent, model, effort }) {
  return ["--agent", agent, "--model", model, ...(effort ? ["--effort", effort] : [])];
}

/**
 * @param {Record<string, any>} options
 * @param {ReturnType<typeof loadCandidates>} candidates
 * @param {Record<string, any>} usageByAgent Reports from usageForPlanning; kept for the summary only.
 * @param {Record<string, any>} [usageByCandidate] Per `agent/model` assessments; a missing key is unknown, never the agent report.
 */
function withPressureFields(candidate, usage, policy, now) {
  const report = burnPressure(usage, policy, now);
  const expectedSharePercent = expectedShareFor(policy, candidate);
  return {
    ...candidate,
    pressure: report.pressure,
    binding: report.binding,
    expectedSharePercent,
    burn: report,
  };
}

function pressureBalanceNote(first, others, usageOf, policy, now, hasEquivalent) {
  if (!hasEquivalent) return "";
  if (policy?.allow) {
    const firstUsage = usageOf(first);
    const firstBurn = burnPressure(firstUsage, policy, now);
    const runner = others.find((c) => c.capability === first.capability);
    if (firstBurn.pressure != null && firstBurn.binding) {
      const runnerBurn = runner ? burnPressure(usageOf(runner), policy, now) : null;
      const burn = formatBurnReason(choiceName(first), firstBurn, runnerBurn?.pressure != null && runnerBurn.binding
        ? { name: choiceName(runner), pressure: runnerBurn.pressure, binding: runnerBurn.binding }
        : null);
      return burn ? `; ${burn}` : "";
    }
    return "; equivalent choices have no confirmed burn pressure";
  }
  return "; equivalent choices are not balanced by quota";
}

export async function recommend(options, candidates, usageByAgent = {}, usageByCandidate = {}) {
  const sanitizedOptions = {
    ...options,
    task: redactSecret(options.task),
    summary: redactSecret(options.summary),
    judgmentReason: options.judgmentReason !== undefined ? redactSecret(options.judgmentReason) : undefined,
    overrideReason: options.overrideReason !== undefined ? redactSecret(options.overrideReason) : undefined,
  };
  const policy =
    sanitizedOptions.policy && typeof sanitizedOptions.policy === "object"
      ? sanitizedOptions.policy
      : sanitizedOptions.policy
        ? resolvePolicy({ policy: sanitizedOptions.policy, models: sanitizedOptions.models })
        : sanitizedOptions.models
          ? resolvePolicy({ models: sanitizedOptions.models })
          : { ...NO_POLICY };
  const now = sanitizedOptions.now ?? new Date().toISOString();
  const jev = await assessJev(sanitizedOptions);
  const { requirement: jevRequirement, ...jevReport } = jev;
  const conclusive = jev.status === "ok";
  const given = sanitizedOptions.judgment ? { requirement: sanitizedOptions.judgment, reason: sanitizedOptions.judgmentReason, used: !conclusive } : null;
  const requirement = conclusive ? jevRequirement : (given?.requirement ?? null);
  const assessment = { source: conclusive ? "jev" : given ? "coordinator" : null, requirement, jev: jevReport, coordinator: given };
  const usageOf = (choice) => {
    const key = `${choice.agent}/${choice.model}`;
    if (Object.hasOwn(usageByCandidate, key)) return usageByCandidate[key];
    return {
      status: "unknown",
      reason: `no per-model quota reading for ${key}`,
      source: null,
      observedAt: null,
      account: "unknown",
      host: "unknown",
      capacityConfirmed: false,
    };
  };
  const base = {
    task: sanitizedOptions.task,
    request: { kind: sanitizedOptions.kind ?? null, files: sanitizedOptions.files ?? null },
    assessment,
    fallback: null,
    recommendation: null,
    alternatives: [],
    rejected: [],
    excluded: [],
    policy: {
      source: policy.source ?? null,
      decidedAt: policy.decidedAt ?? null,
      safetyFloorPercent: policy.safetyFloorPercent,
      maxConcurrentPerBucket: policy.maxConcurrentPerBucket,
      maxConcurrentTotal: policy.maxConcurrentTotal,
      reviewerOnDifferentPool: policy.reviewerOnDifferentPool,
      order: policy.order ?? null,
      allow: policy.allow,
    },
    usage: UNKNOWN_USAGE,
    usageByAgent,
    usageByCandidate,
    decision: null,
    launch: null,
  };

  if (!requirement) return { ...base, status: "needs-judgment" };
  if (!conclusive) {
    base.fallback = { because: jev.status, detail: jev.detail, version: jev.version, uncertainty: jev.uncertainty, requirement, reason: given.reason };
  }

  const usable = [];
  const excluded = [];
  const rejected = sanitizedOptions.eligible.flatMap((choice) => {
    const reason = undocumented(choice, candidates);
    return reason ? [{ ...choice, reason }] : [];
  });
  const named = (c) => sanitizedOptions.eligible.some((e) => e.agent === c.agent && e.model === c.model && (e.effort === null || e.effort === c.effort));

  let reviewOfBinding = null;
  if (sanitizedOptions.reviewOf && policy.reviewerOnDifferentPool) {
    reviewOfBinding = burnPressure(usageOf(sanitizedOptions.reviewOf), policy, now).binding;
  }

  for (const { unusable, ...candidate } of candidates) {
    const { agent, model, effort } = candidate;
    if (sanitizedOptions.eligible.length && !named(candidate)) continue;
    const usage = usageOf(candidate);

    const verdict = policyVerdict(policy, candidate);
    if (verdict) {
      excluded.push({ agent, model, effort, policy: verdict.policy, reason: verdict.reason });
      continue;
    }

    if (sanitizedOptions.reviewOf && policy.reviewerOnDifferentPool) {
      const sameAgent = agent === sanitizedOptions.reviewOf.agent;
      const candidateBinding = burnPressure(usage, policy, now).binding;
      const sameBucket =
        reviewOfBinding?.bucketId &&
        candidateBinding?.bucketId &&
        reviewOfBinding.bucketId === candidateBinding.bucketId;
      if (sameAgent || sameBucket) {
        excluded.push({
          agent,
          model,
          effort,
          policy: "reviewer-pool",
          reason: `must run on a different pool from the implementer ${choiceName(sanitizedOptions.reviewOf)}`,
        });
        continue;
      }
    }

    if (unusable) rejected.push({ agent, model, effort, reason: unusable });
    else if (rank(candidate.capability) < rank(requirement)) {
      // Attach burn pressure so planners ranking below-capability alternatives (uncertainty /
      // weaker paths) order by pressure instead of preserving baseline table order.
      rejected.push({
        ...withPressureFields(
          { agent, model, effort, capability: candidate.capability, suits: candidate.suits },
          usage,
          policy,
          now,
        ),
        rejectionKind: "below-capability",
        reason: `${candidate.capability} capability is below the assessed ${requirement}`,
        usage: usage.status,
      });
    } else if (usage.status === "exhausted") {
      rejected.push({ agent, model, effort, reason: usageWarning(agent, usage, candidate), usage: usage.status });
    } else {
      const floorSkip = policy.allow ? burnPressure(usage, policy, now).skip : null;
      const shareSkip = policy.allow ? expectedShareSkip(usage, policy, candidate, now) : null;
      const skip = floorSkip || shareSkip;
      if (skip) {
        rejected.push({
          agent,
          model,
          effort,
          rejectionKind: floorSkip ? "safety-floor" : "expected-share",
          reason: skip,
          usage: usage.status,
        });
      } else {
        usable.push(
          withPressureFields(
            { ...candidate, usage: usage.status, usageScope: { account: usage.account, host: usage.host } },
            usage,
            policy,
            now,
          ),
        );
      }
    }
  }

  // Capability is a hard filter: smallest tier that still has an available allowed candidate.
  // If that tier has only unknown/stale capacity, prefer a confirmed stronger tier when one exists.
  const requiredRank = rank(requirement);
  const capacityConfirmed = (c) => {
    const reading = usageOf(c);
    return reading.capacityConfirmed === true || reading.status === "fresh" || reading.status === "low";
  };
  const atOrAbove = usable.filter((c) => rank(c.capability) >= requiredRank);
  const availableRanks = [...new Set(atOrAbove.map((c) => rank(c.capability)))].sort((a, b) => a - b);
  let chosenRank = availableRanks.find((r) => r >= requiredRank) ?? -1;
  /** @type {number | null} */
  let unconfirmedRequiredRank = null;
  if (chosenRank >= 0) {
    const tierHasConfirmed = atOrAbove.some((c) => rank(c.capability) === chosenRank && capacityConfirmed(c));
    if (!tierHasConfirmed) {
      const strongerConfirmed = availableRanks.find(
        (r) => r > chosenRank && atOrAbove.some((c) => rank(c.capability) === r && capacityConfirmed(c)),
      );
      if (strongerConfirmed != null) {
        unconfirmedRequiredRank = chosenRank;
        chosenRank = strongerConfirmed;
      }
    }
  }
  const tier = chosenRank < 0 ? [] : atOrAbove.filter((c) => rank(c.capability) === chosenRank);
  const stronger = chosenRank < 0 ? [] : atOrAbove.filter((c) => rank(c.capability) > chosenRank);
  // Keep unknown/stale candidates at the pre-upgrade rank so a capped stronger tier can still fall back.
  const uncertainFallback =
    unconfirmedRequiredRank == null
      ? []
      : atOrAbove.filter((c) => rank(c.capability) === unconfirmedRequiredRank && !capacityConfirmed(c));
  // Within each tier, burn pressure ranks when a policy allow-list is active; else keep table order.
  const tierOrdered = policy.allow ? rankByPressure(tier, policy) : [...tier];
  const strongerOrdered = policy.allow ? rankByPressure(stronger, policy) : [...stronger];
  const usableOrdered = [...tierOrdered, ...strongerOrdered, ...uncertainFallback];
  // Preserve below-tier rejects already recorded; drop higher-than-chosen from usable path is fine (they stay as stronger alts only when chosenRank is required).
  const learningPool = usableOrdered.length ? usableOrdered : usable.sort((a, b) => rank(a.capability) - rank(b.capability));
  const baselineFirst = learningPool[0] ?? null;
  const capabilityUpgradeWarning =
    baselineFirst && rank(baselineFirst.capability) > requiredRank
      ? `no available allowed candidate at ${requirement}; ${choiceName(baselineFirst)} is ${baselineFirst.capability}`
      : null;

  let learningContext = null;
  /** @type {string | null} */
  let historyLoadNote = null;
  if (sanitizedOptions.learning === false) {
    learningContext = null;
  } else if (sanitizedOptions.learning && typeof sanitizedOptions.learning === "object") {
    learningContext = sanitizedOptions.learning;
  } else {
    const historyDir = sanitizedOptions.historyDir ?? process.env.ORCA_HISTORY_DIR?.trim() ?? defaultHistoryDir();
    // Stay on the baseline when no history directory exists yet, so empty checkouts and
    // unit tests without fixtures are deterministic.
    if (existsSync(historyDir) || sanitizedOptions.historyDir || process.env.ORCA_HISTORY_DIR?.trim()) {
      try {
        learningContext = loadLearningContext({
          historyDir,
          learnDir: sanitizedOptions.learnDir ?? defaultLearnDir(),
          kind: sanitizedOptions.kind ?? null,
          difficulty: requirement,
          now: sanitizedOptions.now ?? process.env.ORCA_LEARN_NOW ?? new Date().toISOString(),
          agentVersions: sanitizedOptions.agentVersions ?? {},
        });
      } catch (error) {
        // Missing or unreadable history must not block a baseline recommendation.
        learningContext = null;
        const reason = error instanceof Error ? error.message : String(error);
        historyLoadNote = `history unreadable: ${reason}, baseline used`;
      }
    }
  }

  const learned = applyLearning({
    usable: learningPool,
    kind: sanitizedOptions.kind ?? null,
    difficulty: requirement,
    learning: learningContext,
    random: sanitizedOptions.random ?? Math.random,
  });
  let ordered = learned.ordered.length ? learned.ordered : learningPool;
  // Learning may reorder within the tier but must not promote a lower capability or escape the policy set.
  // Do not re-sort by pressure after learning: the pool was already pressure-ranked, and a second
  // sort would undo an applied adjustment while the report still claimed learning preferred a pick.
  if (policy.allow && ordered.length) {
    const floor = rank(ordered[0].capability);
    const sameTier = ordered.filter((c) => rank(c.capability) === floor);
    const rest = ordered.filter((c) => rank(c.capability) !== floor);
    ordered = [...sameTier, ...rest];
  }
  const [first, ...others] = ordered;
  const alternatives = others.map((c) => {
    if (!first) return { ...c, relation: "stronger" };
    const cmp = rank(c.capability) - rank(first.capability);
    return {
      ...c,
      relation: cmp === 0 ? "equivalent" : cmp > 0 ? "stronger" : "uncertain-fallback",
    };
  });
  const hasEquivalent = alternatives.some((c) => c.relation === "equivalent");
  const balance = (pick, rest) => pressureBalanceNote(pick, rest, usageOf, policy, now, hasEquivalent || Boolean(policy.allow && pick));
  const annotate = (pick, rest) => {
    if (!pick) return null;
    const usage = usageOf(pick);
    const burn = burnPressure(usage, policy, now);
    const runner = rest.find((c) => c.capability === pick.capability);
    const runnerBurn = runner ? burnPressure(usageOf(runner), policy, now) : null;
    const burnText =
      policy.allow && burn.pressure != null && burn.binding
        ? formatBurnReason(
            choiceName(pick),
            burn,
            runnerBurn?.pressure != null && runnerBurn.binding
              ? { name: choiceName(runner), pressure: runnerBurn.pressure, binding: runnerBurn.binding }
              : null,
          )
        : null;
    const usageText = describeUsage(usage, pick);
    const balanceText = burnText ? `; ${burnText}` : balance(pick, rest);
    return {
      ...pick,
      pressure: burn.pressure,
      binding: burn.binding,
      expectedSharePercent: expectedShareFor(policy, pick),
      reason:
        `${describeAssessment(assessment)}. ${choiceName(pick)} is the smallest documented capability that meets it (${pick.capability}): ${pick.suits}. ` +
        `${usageText}${balanceText}.`,
    };
  };
  const baselineRecommendation = baselineFirst
    ? {
        ...annotate(baselineFirst, learningPool.slice(1)),
      }
    : null;
  const demotionNote =
    learned.demoted?.length
      ? ` Demoted ${learned.demoted.map((d) => `${d.choice}: ${d.effect}`).join("; ")}.`
      : "";
  const demotionMovedPick =
    Boolean(learned.demoted?.length) &&
    first &&
    baselineFirst &&
    choiceName(first) !== choiceName(baselineFirst);
  const learningNote = historyLoadNote
    ? ` ${historyLoadNote}.`
    : learned.applied.length
      ? ` Learned adjustment preferred ${choiceName(first)} over baseline ${choiceName(baselineFirst)} from ${learned.applied[0].rawCount} comparable outcomes (mean score ${learned.applied[0].meanScore.toFixed(2)}).${demotionNote}`
      : learned.exploration
        ? ` Exploration pick ${learned.exploration.choice}: suitable but under-observed (${learned.exploration.reason}).${demotionNote}`
        : demotionMovedPick
          ? ` Negative evidence demoted the baseline; recommending ${choiceName(first)} instead.${demotionNote}`
          : learned.demoted?.length
            ? ` Negative evidence did not promote any choice over the capability-and-usage baseline.${demotionNote}`
            : learningContext
              ? " Sparse or missing comparable evidence: falling back to the capability-and-usage baseline."
              : "";
  const annotatedFirst = first ? annotate(first, others) : null;
  const recommendation = annotatedFirst
    ? {
        ...annotatedFirst,
        reason: `${annotatedFirst.reason}${learningNote}`,
        exploration: learned.exploration
          ? { uncertain: true, reason: learned.exploration.reason, evidenceCount: learned.exploration.evidenceCount }
          : undefined,
      }
    : null;
  const learningReport = {
    enabled: Boolean(learningContext?.enabled),
    resetAt: learned.resetAt ?? learningContext?.resetAt ?? null,
    rule: learned.rule ?? learningContext?.rule ?? null,
    baselineRecommendation: baselineRecommendation
      ? { agent: baselineRecommendation.agent, model: baselineRecommendation.model, effort: baselineRecommendation.effort }
      : null,
    applied: learned.applied,
    demoted: learned.demoted ?? [],
    uncertain: learned.uncertain,
    versionMismatches: learned.versionMismatches ?? [],
    exploration: learned.exploration,
    note: historyLoadNote,
  };
  const result = { ...base, recommendation, baselineRecommendation, alternatives, rejected, excluded, learning: learningReport };

  if (sanitizedOptions.override) {
    const refused = refuseOverride(sanitizedOptions.override, candidates);
    if (refused) return { ...result, status: "override-refused", refused: { ...sanitizedOptions.override, reason: refused } };
    const { capability } = candidates.find((c) => choiceName(c) === choiceName(sanitizedOptions.override));
    const usage = usageOf(sanitizedOptions.override);
    const deviationNotes = [];
    const verdict = policyVerdict(policy, sanitizedOptions.override);
    if (verdict) {
      deviationNotes.push(
        `${choiceName(sanitizedOptions.override)} is ${verdict.policy === "reserve" ? "reserved" : "not allowed"}: ${verdict.reason}`,
      );
    }
    if (policy.allow) {
      const floorSkip = burnPressure(usage, policy, now).skip;
      if (floorSkip) deviationNotes.push(`bypasses safety floor: ${floorSkip}`);
      const shareSkip = expectedShareSkip(usage, policy, sanitizedOptions.override, now);
      if (shareSkip && shareSkip !== floorSkip) deviationNotes.push(`bypasses expected share: ${shareSkip}`);
    }
    if (sanitizedOptions.reviewOf && policy.reviewerOnDifferentPool) {
      const sameAgent = sanitizedOptions.override.agent === sanitizedOptions.reviewOf.agent;
      const overrideBinding = burnPressure(usage, policy, now).binding;
      const sameBucket =
        reviewOfBinding?.bucketId &&
        overrideBinding?.bucketId &&
        reviewOfBinding.bucketId === overrideBinding.bucketId;
      if (sameAgent || sameBucket) {
        deviationNotes.push(
          `bypasses reviewer-pool rule: must run on a different pool from the implementer ${choiceName(sanitizedOptions.reviewOf)}`,
        );
      }
    }
    const policyDeviation = deviationNotes.length ? deviationNotes.join("; ") : null;
    const warnings = [
      rank(capability) < rank(requirement) ? `${capability} capability is below the assessed ${requirement}` : null,
      usageWarning(sanitizedOptions.override.agent, usage, sanitizedOptions.override),
      policyDeviation ? "deviates from the routing policy" : null,
    ];
    const decision = {
      kind: "override",
      ...sanitizedOptions.override,
      reason: sanitizedOptions.overrideReason,
      warning: warnings.filter(Boolean).join("; ") || null,
      policyDeviation,
      note: "an override is a choice, not a label of the recommendation being wrong",
    };
    return { ...result, usage, status: "overridden", decision, launch: { started: false, args: launchArgs(sanitizedOptions.override) } };
  }
  if (!recommendation) return { ...result, status: "no-suitable-candidate" };
  const { agent, model, effort, reason } = recommendation;
  const usage = usageOf(recommendation);
  const decision = {
    kind: "recommendation",
    agent,
    model,
    effort,
    reason,
    warning: [capabilityUpgradeWarning, usageWarning(agent, usage, recommendation)].filter(Boolean).join("; ") || null,
    policyDeviation: null,
    exploration: recommendation.exploration ?? null,
  };
  return { ...result, usage, status: "recommended", decision, launch: { started: false, args: launchArgs(decision) } };
}

const oneLine = (text) => text.replace(/\s+/g, " ").trim();

export function modelChoiceSection({ decision, recommendation, assessment, fallback, usage }) {
  const decided =
    decision.kind === "recommendation" ? "recommendation accepted" : `coordinator override of ${recommendation ? choiceName(recommendation) : "no suitable recommendation"}`;
  const lines = [
    "## Model choice",
    "",
    `- Agent: ${decision.agent}`,
    `- Model: ${decision.model}`,
    `- Effort: ${decision.effort ?? "none"}`,
    `- Why: ${oneLine(redactSecret(decision.reason))}`,
    `- Decision: ${decided}`,
    `- Assessment: ${oneLine(redactSecret(describeAssessment(assessment)))}`,
  ];
  if (fallback) {
    lines.push(
      `- Fallback: coordinator judgment ${fallback.requirement} because Jev was ${fallback.because}${describeJevReport(assessment.jev)}: ${oneLine(redactSecret(fallback.detail ?? ""))}`,
    );
  }
  if (decision.policyDeviation) {
    lines.push(`- Policy: deviates from the routing policy: ${oneLine(redactSecret(decision.policyDeviation))}`);
  }
  if (decision.warning) lines.push(`- Warning: ${decision.warning}`);
  const evidence = usage.observedAt ? `; read ${usage.observedAt} from ${usage.source?.kind}` : "";
  const bucketBit =
    Array.isArray(usage.buckets) && usage.buckets.length
      ? formatBucketUsage(usage)
      : oneLine(usage.reason ?? usage.status);
  lines.push(
    `- Usage: ${usage.status} — ${bucketBit} (account ${usage.account}, host ${usage.host}${evidence})`,
  );
  return lines.join("\n");
}

/** Puts the choice in the spec's Model choice section, leaving every other section as it is. */
export function withModelChoice(spec, section) {
  const heading = /^## Model choice[ \t]*$/m.exec(spec);
  if (!heading) return `${spec.trimEnd()}\n\n${section}\n`;
  const rest = spec.slice(heading.index + heading[0].length);
  const next = rest.search(/^## /m);
  return `${spec.slice(0, heading.index)}${section}\n${next < 0 ? "" : `\n${rest.slice(next)}`}`;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if ("help" in parsed) {
    console.log(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    console.error(USAGE);
    console.error(redactSecret(parsed.error));
    return 2;
  }
  const { options } = parsed;
  options.models ??= path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "agents", "models.md");

  try {
    options.policy = resolvePolicy({ models: options.models, policy: options.policy });
  } catch (error) {
    console.error(redactSecret(error.message));
    return 1;
  }

  let candidates;
  try {
    candidates = loadCandidates(options.models);
  } catch (error) {
    console.error(redactSecret(`cannot read the capability baseline ${options.models}: ${error.message}`));
    return 1;
  }
  // A reading for every collected agent in the baseline, taken first so the plan reflects current usage.
  const collected = PROVIDERS.filter((provider) => candidates.some((candidate) => candidate.agent === provider.name));
  const usage = collected.length ? await usageForPlanning({ providers: collected, candidates }) : {};
  const usageByCandidate = usage.usageByCandidate ?? {};
  const result = await recommend(options, candidates, usage, usageByCandidate);

  if (result.status === "needs-judgment") {
    console.log(JSON.stringify(result, null, 2));
    console.error(`Jev gave no usable assessment (${result.assessment.jev.status}: ${result.assessment.jev.detail}). Rerun with --judgment <requirement> --judgment-reason <text>.`);
    return 3;
  }
  if (result.status === "override-refused") {
    console.log(JSON.stringify(result, null, 2));
    console.error(`override refused: ${choiceName(result.refused)}: ${result.refused.reason}`);
    return 1;
  }
  if (!result.decision) {
    console.log(JSON.stringify(result, null, 2));
    console.error(`nothing suitable for ${result.assessment.requirement}; see "rejected"`);
    return 1;
  }
  if (options.record) {
    try {
      writeFileSync(options.record, withModelChoice(readFileSync(options.record, "utf8"), modelChoiceSection(result)));
    } catch (error) {
      console.error(`cannot write spec file ${options.record}: ${redactSecret(error.message)}`);
      return 1;
    }
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

const isDirectCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  process.exitCode = await main();
}
