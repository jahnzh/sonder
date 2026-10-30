#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// Pinned, not jev-latest: an alias can move and change answers without any change here.
const JEV_MODEL = "jev-1.14.0";
const JEV_TIMEOUT_MS = 20000;
const MAX_SUMMARY_LENGTH = 600;
const TASK_KINDS = ["feature", "fix", "refactor", "test", "docs", "review"];
const REQUIREMENTS = ["mechanical", "standard", "reasoning-heavy"];

// Starting points from TypeSafe's docs, checked against seven live tasks on jev-1.14.0 but not tuned.
const MIN_REASONING_CONFIDENCE = 0.5;
const NOUL_NO = 0.3;
const NOUL_YES = 0.7;

// Replaced by real observations when a verified collector exists.
const UNKNOWN_USAGE = { status: "unknown", reason: "no verified usage collector is connected", source: null, observedAt: null };

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

Recommends a worker for one ready task and prints JSON. It never starts a worker: pass launch.args to
scripts/orca-spawn.sh. Only --summary, --kind and --files are sent to Jev, so keep the summary shareable.

  --summary          The task in at most ${MAX_SUMMARY_LENGTH} characters.
  --kind             ${TASK_KINDS.join(", ")}.
  --files            Estimated number of files the change touches.
  --eligible         Limit the recommendation to these choices; repeatable. Without an effort, every documented one.
  --judgment         ${REQUIREMENTS.join(", ")}: the assessment to use when Jev gives none. Needs --judgment-reason.
  --override         The worker chosen instead of the recommendation. Needs --override-reason.
  --record           Write the choice into this spec's "## Model choice" section.
  --models           The capability baseline (default: docs/agents/models.md).

Exit codes: 0 a worker was chosen, 1 nothing suitable or an override was refused, 2 bad usage,
3 Jev gave no usable assessment and no --judgment was supplied.
Reads TYPESAFE_API_KEY. ORCA_RECOMMEND_JEV_URL and ORCA_RECOMMEND_JEV_TIMEOUT_MS replace the endpoint and timeout (tests).`;

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
  const options = { eligible: [] };
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
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    const value = argv[i + 1];
    if (value === undefined) return { error: `${flag} needs a value` };
    if (flag === "--eligible") {
      const choice = parseChoice(value);
      if (!choice) return { error: `--eligible must be <agent>/<model>[/<effort>], got: ${value}` };
      options.eligible.push(choice);
    } else if (flags[flag]) {
      options[flags[flag]] = value;
    } else {
      return { error: `unknown option: ${flag}` };
    }
  }
  if (!options.task || !options.summary) return { error: "--task and --summary are required" };
  if (options.summary.length > MAX_SUMMARY_LENGTH) return { error: `--summary is ${options.summary.length} characters; the limit is ${MAX_SUMMARY_LENGTH}` };
  if (options.kind !== undefined && !TASK_KINDS.includes(options.kind)) return { error: `--kind must be one of ${TASK_KINDS.join(", ")}` };
  if (options.files !== undefined) {
    if (!/^\d+$/.test(options.files)) return { error: "--files must be a whole number" };
    options.files = Number(options.files);
  }
  if (options.judgment !== undefined && !REQUIREMENTS.includes(options.judgment)) return { error: `--judgment must be one of ${REQUIREMENTS.join(", ")}` };
  if ((options.judgment === undefined) !== (options.judgmentReason === undefined)) return { error: "--judgment and --judgment-reason go together" };
  if ((options.override === undefined) !== (options.overrideReason === undefined)) return { error: "--override and --override-reason go together" };
  if (options.override !== undefined) {
    options.override = parseChoice(options.override);
    if (!options.override) return { error: "--override must be <agent>/<model>[/<effort>]" };
  }
  if (options.record !== undefined && !existsSync(options.record)) return { error: `spec file not found: ${options.record}` };
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
    const listed = [...row[efforts].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
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
function loadCandidates(file) {
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
const inUnit = (value) => typeof value === "number" && value >= 0 && value <= 1;
const rank = (requirement) => REQUIREMENTS.indexOf(requirement);

/** Reads the three answers, or throws a message that says which one is wrong. */
function readAnswers(body) {
  if (typeof body?.model !== "string" || !body.model) throw new Error("the response names no model");
  const answers = body.answers ?? {};
  for (const name of ["enough_information", "wide_change"]) {
    if (answers[name]?.type !== "noul" || !inUnit(answers[name].noul)) throw new Error(`${name} is not a valid noul answer`);
  }
  const reasoning = answers.reasoning;
  const probabilities = REASONING_LEVELS.map((_, level) => reasoning?.probabilities?.[level]);
  const total = probabilities.reduce((sum, p) => sum + p, 0);
  if (reasoning?.type !== "score" || !inUnit(reasoning.confidence) || !probabilities.every(inUnit) || Math.abs(total - 1) > 0.02) {
    throw new Error("reasoning is not a valid score answer");
  }
  // A tie takes the higher level: capability comes before saving a stronger model.
  const level = probabilities.reduce((best, p, i) => (p >= probabilities[best] ? i : best), 0);
  return { level, confidence: reasoning.confidence, enoughInformation: answers.enough_information.noul, wideChange: answers.wide_change.noul };
}

/** Reads the requirement from the answers, or null when they do not settle it. */
function requirementFrom({ level, confidence, enoughInformation, wideChange }) {
  if (confidence < MIN_REASONING_CONFIDENCE || enoughInformation < NOUL_NO) return null;
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
  const redact = (text) => text.replaceAll(key, "[redacted]").slice(0, 200);

  const state = { task: options.summary };
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
    return { ...report, status: "invalid", version: typeof body?.model === "string" ? body.model : null, detail: redact(error.message) };
  }
  const requirement = requirementFrom(answers);
  return {
    ...report,
    status: requirement ? "ok" : "inconclusive",
    version: body.model,
    requirement,
    detail: requirement ? null : "the answers do not settle the requirement",
    uncertainty: {
      conclusive: requirement !== null,
      reasoningConfidence: answers.confidence,
      enoughInformation: answers.enoughInformation,
      wideChange: answers.wideChange,
      thresholds: { minReasoningConfidence: MIN_REASONING_CONFIDENCE, noulNo: NOUL_NO, noulYes: NOUL_YES },
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

function launchArgs({ agent, model, effort }) {
  return ["--agent", agent, "--model", model, ...(effort ? ["--effort", effort] : [])];
}

/**
 * @param {Record<string, any>} options
 * @param {ReturnType<typeof loadCandidates>} candidates
 */
export async function recommend(options, candidates) {
  const jev = await assessJev(options);
  const { requirement: jevRequirement, ...jevReport } = jev;
  const conclusive = jev.status === "ok";
  const given = options.judgment ? { requirement: options.judgment, reason: options.judgmentReason, used: !conclusive } : null;
  const requirement = conclusive ? jevRequirement : (given?.requirement ?? null);
  const assessment = { source: conclusive ? "jev" : given ? "coordinator" : null, requirement, jev: jevReport, coordinator: given };
  const base = { task: options.task, assessment, fallback: null, recommendation: null, alternatives: [], rejected: [], usage: UNKNOWN_USAGE, decision: null, launch: null };

  if (!requirement) return { ...base, status: "needs-judgment" };
  if (!conclusive) base.fallback = { because: jev.status, detail: jev.detail, requirement, reason: given.reason };

  const usable = [];
  const rejected = options.eligible.flatMap((choice) => {
    const reason = undocumented(choice, candidates);
    return reason ? [{ ...choice, reason }] : [];
  });
  const named = (c) => options.eligible.some((e) => e.agent === c.agent && e.model === c.model && (e.effort === null || e.effort === c.effort));
  for (const { unusable, ...candidate } of candidates) {
    const { agent, model, effort } = candidate;
    if (options.eligible.length && !named(candidate)) continue;
    if (unusable) rejected.push({ agent, model, effort, reason: unusable });
    else if (rank(candidate.capability) < rank(requirement)) rejected.push({ agent, model, effort, reason: `${candidate.capability} capability is below the assessed ${requirement}` });
    else usable.push({ ...candidate, usage: UNKNOWN_USAGE.status });
  }
  // Smallest suitable first, so a scarce strong model is not spent on easier work; sort() keeps table order within a level.
  usable.sort((a, b) => rank(a.capability) - rank(b.capability));
  const [first, ...others] = usable;
  const alternatives = others.map((c) => ({ ...c, relation: c.capability === first.capability ? "equivalent" : "stronger" }));
  const hasEquivalent = alternatives.some((c) => c.relation === "equivalent");
  const recommendation = first
    ? {
        ...first,
        reason:
          `${describeAssessment(assessment)}. ${choiceName(first)} is the smallest documented capability that meets it (${first.capability}): ${first.suits}. ` +
          `Usage is unknown, so capacity is not confirmed${hasEquivalent ? " and equivalent choices are not balanced by quota" : ""}.`,
      }
    : null;
  const result = { ...base, recommendation, alternatives, rejected };

  if (options.override) {
    const refused = refuseOverride(options.override, candidates);
    if (refused) return { ...result, status: "override-refused", refused: { ...options.override, reason: refused } };
    const { capability } = candidates.find((c) => choiceName(c) === choiceName(options.override));
    const warning = rank(capability) < rank(requirement) ? `${capability} capability is below the assessed ${requirement}` : null;
    const decision = { kind: "override", ...options.override, reason: options.overrideReason, warning };
    return { ...result, status: "overridden", decision, launch: { started: false, args: launchArgs(options.override) } };
  }
  if (!recommendation) return { ...result, status: "no-suitable-candidate" };
  const { agent, model, effort, reason } = recommendation;
  const decision = { kind: "recommendation", agent, model, effort, reason, warning: null };
  return { ...result, status: "recommended", decision, launch: { started: false, args: launchArgs(decision) } };
}

const oneLine = (text) => text.replace(/\s+/g, " ").trim();

function modelChoiceSection({ decision, recommendation, assessment, fallback, usage }) {
  const decided =
    decision.kind === "recommendation" ? "recommendation accepted" : `coordinator override of ${recommendation ? choiceName(recommendation) : "no suitable recommendation"}`;
  const lines = [
    "## Model choice",
    "",
    `- Agent: ${decision.agent}`,
    `- Model: ${decision.model}`,
    `- Effort: ${decision.effort ?? "none"}`,
    `- Why: ${oneLine(decision.reason)}`,
    `- Decision: ${decided}`,
    `- Assessment: ${oneLine(describeAssessment(assessment))}`,
  ];
  if (fallback) lines.push(`- Fallback: coordinator judgment ${fallback.requirement} because Jev was ${fallback.because}: ${oneLine(fallback.detail ?? "")}`);
  if (decision.warning) lines.push(`- Warning: ${decision.warning}`);
  lines.push(`- Usage: ${usage.status} (${usage.reason})`);
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
    console.error(parsed.error);
    return 2;
  }
  const { options } = parsed;
  options.models ??= path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "agents", "models.md");

  let candidates;
  try {
    candidates = loadCandidates(options.models);
  } catch (error) {
    console.error(`cannot read the capability baseline ${options.models}: ${error.message}`);
    return 1;
  }
  const result = await recommend(options, candidates);
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "needs-judgment") {
    console.error(`Jev gave no usable assessment (${result.assessment.jev.status}: ${result.assessment.jev.detail}). Rerun with --judgment <requirement> --judgment-reason <text>.`);
    return 3;
  }
  if (result.status === "override-refused") {
    console.error(`override refused: ${choiceName(result.refused)}: ${result.refused.reason}`);
    return 1;
  }
  if (!result.decision) {
    console.error(`nothing suitable for ${result.assessment.requirement}; see "rejected"`);
    return 1;
  }
  if (options.record) writeFileSync(options.record, withModelChoice(readFileSync(options.record, "utf8"), modelChoiceSection(result)));
  return 0;
}

const isDirectCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  process.exitCode = await main();
}
