#!/usr/bin/env node
/**
 * Coordinated wave planner for ready tasks (#110). Builds on scripts/orca-recommend.mjs;
 * never starts a worker. Learning from worker history (#112) may reorder within a capability
 * tier; the baseline recommendation stays visible beside any adjustment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, usageForPlanning } from "./orca-usage.mjs";
import { loadCandidates, recommend } from "./orca-recommend.mjs";

const REQUIREMENTS = ["mechanical", "standard", "reasoning-heavy"];
const DEFAULT_CONCURRENCY = 3;
const TASK_KINDS = ["feature", "fix", "refactor", "test", "docs", "review"];

const USAGE = `Usage: node scripts/orca-plan.mjs --wave <file.json> [--models <file>] [--concurrency <n>]
         [--history-dir <dir>] [--learn-dir <dir>] [--no-learning]

Plans a ready wave of tasks together and prints JSON. It never starts a worker: pass each
assignment's launch.args to scripts/orca-spawn.sh after the existing preflight checks.
Build on scripts/orca-recommend.mjs for each task; this command only coordinates across the wave.
Histories and transcripts are never sent to Jev.

  --wave           JSON file describing the wave (see docs/agents/wave-planner.md). Use - for stdin.
  --models         The capability baseline (default: docs/agents/models.md).
  --concurrency    Max concurrent workers including active ones (default: ${DEFAULT_CONCURRENCY}, or the wave's concurrency).
  --history-dir    Worker history directory (default: $ORCA_HISTORY_DIR or artifacts/orca/history).
  --learn-dir      Learned-adjustment state (default: $ORCA_LEARN_DIR or artifacts/orca/learning).
  --no-learning    Capability-and-usage baseline only; still shows baselineRecommendation per task.

Takes a fresh usage reading first for each agent scripts/orca-usage.mjs collects (Claude, Codex,
Cursor and Antigravity). A failed or unknown reading stays unknown or unavailable and is not capacity.
Shared allowances list active and proposed workers; percentages are not compared across providers and
capacity is never reserved. Learning may reorder within a capability tier when comparable outcomes
exist; see docs/agents/learned-adjustments.md.

Exit codes: 0 a plan was produced (including delays and needs-decision), 1 the wave could not be
read or had no tasks, 2 bad usage.
Reads TYPESAFE_API_KEY and ORCA_USAGE_STATE_DIR. ORCA_RECOMMEND_JEV_URL and ORCA_RECOMMEND_JEV_TIMEOUT_MS
replace the Jev endpoint and timeout (tests).`;

const choiceName = ({ agent, model, effort }) => [agent, model, effort].filter(Boolean).join("/");
const rank = (requirement) => REQUIREMENTS.indexOf(requirement);
const CAPACITY_RANK = { fresh: 0, low: 1, unknown: 2, stale: 3, unavailable: 4, exhausted: 5 };

/**
 * @param {string[]} argv
 * @returns {{ help: true } | { error: string } | { options: Record<string, any> }}
 */
export function parseCliArgs(argv) {
  const options = { learning: undefined };
  const flags = {
    "--wave": "wave",
    "--models": "models",
    "--concurrency": "concurrency",
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
    if (!flags[flag]) return { error: `unknown option: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith("-") && value !== "-")) return { error: `${flag} needs a value` };
    options[flags[flag]] = value;
    i += 2;
  }
  if (!options.wave?.trim()) return { error: "--wave is required" };
  if (options.concurrency !== undefined) {
    if (!/^\d+$/.test(options.concurrency) || Number(options.concurrency) < 1) {
      return { error: "--concurrency must be a positive whole number" };
    }
    options.concurrency = Number(options.concurrency);
  }
  if (options.models !== undefined && !options.models.trim()) return { error: "--models must not be blank" };
  if (options.historyDir !== undefined && !options.historyDir.trim()) return { error: "--history-dir must not be blank" };
  if (options.learnDir !== undefined && !options.learnDir.trim()) return { error: "--learn-dir must not be blank" };
  return { options };
}

/**
 * @param {string} text
 * @param {{ concurrency?: number }} [cli]
 */
export function parseWave(text, cli = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`wave JSON is invalid: ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("wave JSON must be an object");
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error("wave.tasks must be a non-empty array");

  const concurrency = cli.concurrency ?? raw.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive whole number");

  const activeWorkers = (raw.activeWorkers ?? []).map((worker, i) => {
    if (!worker || typeof worker !== "object") throw new Error(`activeWorkers[${i}] must be an object`);
    if (typeof worker.agent !== "string" || !worker.agent.trim()) throw new Error(`activeWorkers[${i}].agent is required`);
    return {
      agent: worker.agent,
      model: worker.model ?? null,
      effort: worker.effort ?? null,
      dispatchId: worker.dispatchId ?? null,
      task: worker.task != null ? String(worker.task) : null,
    };
  });

  const completed = new Set((raw.completed ?? []).map((id) => String(id)));
  const tasks = raw.tasks.map((task, i) => {
    if (!task || typeof task !== "object") throw new Error(`tasks[${i}] must be an object`);
    if (task.id === undefined || task.id === null || String(task.id).trim() === "") throw new Error(`tasks[${i}].id is required`);
    if (typeof task.summary !== "string" || !task.summary.trim()) throw new Error(`tasks[${i}].summary is required`);
    if (task.kind !== undefined && !TASK_KINDS.includes(task.kind)) {
      throw new Error(`tasks[${i}].kind must be one of ${TASK_KINDS.join(", ")}`);
    }
    if (task.judgment !== undefined && !REQUIREMENTS.includes(task.judgment)) {
      throw new Error(`tasks[${i}].judgment must be one of ${REQUIREMENTS.join(", ")}`);
    }
    if ((task.judgment === undefined) !== (task.judgmentReason === undefined)) {
      throw new Error(`tasks[${i}]: judgment and judgmentReason go together`);
    }
    const eligible = (task.eligible ?? []).map((value, j) => {
      if (typeof value !== "string") throw new Error(`tasks[${i}].eligible[${j}] must be a string`);
      const parts = value.split("/");
      if (parts.length < 2 || parts.length > 3 || parts.some((part) => !part)) {
        throw new Error(`tasks[${i}].eligible[${j}] must be <agent>/<model>[/<effort>]`);
      }
      return { agent: parts[0], model: parts[1], effort: parts[2] ?? null };
    });
    return {
      id: String(task.id),
      summary: task.summary,
      kind: task.kind,
      files: task.files,
      ready: task.ready !== false,
      dependsOn: (task.dependsOn ?? []).map(String),
      eligible,
      judgment: task.judgment,
      judgmentReason: task.judgmentReason,
    };
  });

  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new Error("wave.tasks ids must be unique");

  return { concurrency, activeWorkers, completed, tasks, raw };
}

function usageOf(usageByAgent, agent) {
  return (
    usageByAgent[agent] ?? {
      status: "unknown",
      reason: "no verified usage collector covers this agent",
      source: null,
      observedAt: null,
      account: "unknown",
      host: "unknown",
      capacityConfirmed: false,
    }
  );
}

function unmetDependencies(task, waveTaskIds, completed) {
  return task.dependsOn.filter((dep) => {
    if (completed.has(dep)) return false;
    // A dependency that is also in this wave is unmet until that task is marked completed.
    if (waveTaskIds.has(dep)) return true;
    // Outside the wave: treat as already done unless the coordinator marked this task not ready.
    return false;
  });
}

function suitableFrom(result) {
  const rows = [];
  if (result.recommendation) rows.push({ ...result.recommendation, relation: "primary" });
  for (const alt of result.alternatives ?? []) {
    rows.push({ ...alt, relation: alt.relation ?? "equivalent" });
  }
  return rows;
}

function weakerFrom(result) {
  return (result.rejected ?? [])
    .filter((row) => row.rejectionKind === "below-capability")
    .filter((row) => row.usage !== "exhausted")
    .map((row) => ({ ...row, relation: "weaker" }));
}

function exhaustedSuitableFrom(result) {
  return (result.rejected ?? []).filter((row) => row.usage === "exhausted");
}

/** Assignment or a held weaker alternative that occupies a concurrency slot. */
function heldChoice(row) {
  return row.assignment ?? row.weakerAlternative ?? null;
}

function agentLoad(agent, activeWorkers, proposed) {
  const active = activeWorkers.filter((worker) => worker.agent === agent);
  const proposedFor = proposed.filter((row) => heldChoice(row)?.agent === agent);
  return { active, proposed: proposedFor, count: active.length + proposedFor.length };
}

function uniqueNeedCount(agent, remainingTasks) {
  let only = 0;
  for (const task of remainingTasks) {
    const agents = new Set((task.suitable ?? []).map((row) => row.agent));
    if (agents.size === 1 && agents.has(agent)) only += 1;
  }
  return only;
}

/**
 * Prefer spreading across providers among roughly equivalent choices, then confirmed capacity,
 * without treating percentages as comparable. Scarce sole-capable agents are saved for tasks that need them.
 */
function pickCandidate(suitable, { activeWorkers, proposed, remainingTasks, usageByAgent }) {
  if (!suitable.length) return null;
  const minCap = Math.min(...suitable.map((row) => rank(row.capability)));
  const atFloor = suitable.filter((row) => rank(row.capability) === minCap);

  const scored = atFloor.map((row, index) => {
    const usage = usageOf(usageByAgent, row.agent);
    const load = agentLoad(row.agent, activeWorkers, proposed).count;
    const soleNeeds = uniqueNeedCount(row.agent, remainingTasks);
    const capacity = CAPACITY_RANK[usage.status] ?? CAPACITY_RANK.unknown;
    return { row, index, load, soleNeeds, capacity };
  });

  scored.sort((a, b) => {
    // Leave sole-capable agents free when another equivalent exists for this task.
    if (a.soleNeeds !== b.soleNeeds) return a.soleNeeds - b.soleNeeds;
    if (a.load !== b.load) return a.load - b.load;
    if (a.capacity !== b.capacity) return a.capacity - b.capacity;
    return a.index - b.index;
  });
  return scored[0].row;
}

function launchArgs({ agent, model, effort }) {
  return ["--agent", agent, "--model", model, ...(effort ? ["--effort", effort] : [])];
}

function describeWindows(usage) {
  if (!Array.isArray(usage.windows) || !usage.windows.length) {
    return usage.resetsAt ? [{ resetsAt: usage.resetsAt }] : [];
  }
  return usage.windows.map((window) => ({
    id: window.id ?? null,
    kind: window.kind ?? null,
    label: window.label ?? null,
    resetsAt: window.resetsAt ?? null,
    exhausted: window.exhausted === true,
    // Keep provider figures for inspection; do not compare them across agents.
    usedPercent: window.usedPercent ?? null,
    remainingPercent: window.remainingPercent ?? null,
    remainingFraction: window.remainingFraction ?? null,
  }));
}

function sharingReport(usageByAgent, activeWorkers, proposed) {
  const agents = new Set([
    ...Object.keys(usageByAgent),
    ...activeWorkers.map((worker) => worker.agent),
    ...proposed.map((row) => heldChoice(row)?.agent).filter(Boolean),
  ]);
  const out = {};
  for (const agent of agents) {
    const usage = usageOf(usageByAgent, agent);
    const load = agentLoad(agent, activeWorkers, proposed);
    out[agent] = {
      status: usage.status,
      reason: usage.reason,
      capacityConfirmed: usage.capacityConfirmed === true,
      source: usage.source ?? null,
      observedAt: usage.observedAt ?? null,
      freshness: usage.freshness ?? null,
      account: usage.account ?? "unknown",
      host: usage.host ?? "unknown",
      plan: usage.plan ?? null,
      resetsAt: usage.resetsAt ?? null,
      staleAfter: usage.staleAfter ?? null,
      windows: describeWindows(usage),
      refresh: usage.refresh ?? null,
      sharedWith: {
        active: load.active,
        proposed: load.proposed.map((row) => {
          const held = heldChoice(row);
          return {
            task: row.task,
            agent: held.agent,
            model: held.model,
            effort: held.effort,
          };
        }),
        note: "Shared allowance only: percentages are provider-specific and not comparable across agents; capacity is a snapshot, not a reservation.",
      },
    };
  }
  return out;
}

function taskPriority(entry) {
  const requirement = entry.result.assessment?.requirement;
  const reqRank = rank(requirement);
  const suitableCount = entry.suitable.length;
  // Higher requirement first; among equals, scarcer suitable pools first (ascending count).
  return { reqRank: reqRank < 0 ? -1 : reqRank, scarcity: suitableCount };
}

/**
 * @param {{
 *   wave: ReturnType<typeof parseWave>,
 *   candidates: ReturnType<typeof loadCandidates>,
 *   usageByAgent?: Record<string, any>,
 *   recommendFn?: typeof recommend,
 *   learningOptions?: Record<string, any>,
 * }} args
 */
export async function planWave({ wave, candidates, usageByAgent = {}, recommendFn = recommend, learningOptions = {} }) {
  const waveTaskIds = new Set(wave.tasks.map((task) => task.id));
  const entries = [];

  for (const task of wave.tasks) {
    const unmet = unmetDependencies(task, waveTaskIds, wave.completed);
    if (!task.ready) {
      entries.push({
        task,
        status: "not-ready",
        reason: "coordinator marked ready: false",
        result: null,
        suitable: [],
        weaker: [],
        exhaustedSuitable: [],
      });
      continue;
    }
    if (unmet.length) {
      entries.push({
        task,
        status: "blocked",
        reason: `waiting on dependencies: ${unmet.join(", ")}`,
        unmetDependencies: unmet,
        result: null,
        suitable: [],
        weaker: [],
        exhaustedSuitable: [],
      });
      continue;
    }

    const options = {
      task: task.id,
      summary: task.summary,
      kind: task.kind,
      files: task.files,
      eligible: task.eligible,
      judgment: task.judgment,
      judgmentReason: task.judgmentReason,
      ...learningOptions,
    };
    const result = await recommendFn(options, candidates, usageByAgent);
    entries.push({
      task,
      status: "assessed",
      result,
      suitable: suitableFrom(result),
      weaker: weakerFrom(result),
      exhaustedSuitable: exhaustedSuitableFrom(result),
    });
  }

  const assignable = entries
    .filter((entry) => entry.status === "assessed")
    .sort((a, b) => {
      const pa = taskPriority(a);
      const pb = taskPriority(b);
      if (pa.reqRank !== pb.reqRank) return pb.reqRank - pa.reqRank;
      if (pa.scarcity !== pb.scarcity) return pa.scarcity - pb.scarcity;
      return String(a.task.id).localeCompare(String(b.task.id));
    });

  const slots = Math.max(0, wave.concurrency - wave.activeWorkers.length);
  const proposed = [];
  const decisions = [];
  const remaining = [...assignable];

  while (remaining.length) {
    const entry = remaining.shift();
    const { task, result, suitable, weaker, exhaustedSuitable } = entry;

    if (result.status === "needs-judgment") {
      decisions.push({
        task: task.id,
        status: "needs-judgment",
        assessment: result.assessment,
        reason: `Jev gave no usable assessment (${result.assessment.jev.status}: ${result.assessment.jev.detail}). Supply judgment and replan.`,
        recommendation: null,
        alternatives: [],
        launch: { started: false, args: null },
      });
      continue;
    }

    if (proposed.length >= slots) {
      decisions.push({
        task: task.id,
        status: "deferred",
        assessment: result.assessment,
        reason: `concurrency limit ${wave.concurrency} with ${wave.activeWorkers.length} active and ${proposed.length} proposed; replan when a slot frees`,
        recommendation: result.recommendation,
        alternatives: result.alternatives,
        rejected: result.rejected,
        launch: { started: false, args: null },
      });
      continue;
    }

    const remainingTasks = remaining.map((row) => ({
      id: row.task.id,
      suitable: row.suitable.filter((candidate) => usageOf(usageByAgent, candidate.agent).status !== "exhausted"),
    }));

    const available = suitable.filter((row) => usageOf(usageByAgent, row.agent).status !== "exhausted");
    const pick = pickCandidate(available, {
      activeWorkers: wave.activeWorkers,
      proposed,
      remainingTasks,
      usageByAgent,
    });

    if (!pick) {
      const weakerAvailable = weaker.filter((row) => {
        const usage = usageOf(usageByAgent, row.agent);
        return usage.status !== "exhausted";
      });
      const weakerPick = pickCandidate(
        weakerAvailable.map((row) => ({
          ...row,
          capability: candidates.find((c) => choiceName(c) === choiceName(row))?.capability ?? "mechanical",
          suits: candidates.find((c) => choiceName(c) === choiceName(row))?.suits ?? "",
        })),
        { activeWorkers: wave.activeWorkers, proposed, remainingTasks: [], usageByAgent },
      );
      const requirement = result.assessment.requirement;
      const whyStrongerGone = exhaustedSuitable.length
        ? exhaustedSuitable.map((row) => `${choiceName(row)} exhausted (${row.reason})`).join("; ")
        : suitable.length
          ? "suitable choices lack confirmed capacity or are otherwise unavailable"
          : (result.rejected ?? []).map((row) => `${choiceName(row)}: ${row.reason}`).join("; ") || "no suitable candidate in the baseline";

      const delay = {
        task: task.id,
        status: "delay",
        assessment: result.assessment,
        reason: `No suitable launch with confirmed or uncertain capacity. Assessed ${requirement}. Stronger choices unavailable: ${whyStrongerGone}.`,
        recommendation: null,
        alternatives: result.alternatives,
        rejected: result.rejected,
        exhaustedSuitable,
        launch: { started: false, args: null },
        capacityNote: "Capacity is never reserved; replan after a reset or worker change.",
      };

      if (weakerPick) {
        const usage = usageOf(usageByAgent, weakerPick.agent);
        delay.weakerAlternative = {
          ...weakerPick,
          usage: usage.status,
          usageScope: { account: usage.account, host: usage.host },
          capacityConfirmed: usage.capacityConfirmed === true,
          warning:
            `Weaker than assessed ${requirement}: ${choiceName(weakerPick)} is below that requirement. ` +
            `Stronger choices unavailable: ${whyStrongerGone}.`,
          launch: { started: false, args: launchArgs(weakerPick) },
        };
        delay.status = "needs-decision";
        delay.reason =
          `Suitable options are exhausted or unavailable for assessed ${requirement}. ` +
          `Choose the warned weaker alternative or delay. Stronger choices unavailable: ${whyStrongerGone}.`;
        // Hold the slot and shared load the same way an uncertain suitable choice does.
        proposed.push(delay);
      }
      decisions.push(delay);
      continue;
    }

    const usage = usageOf(usageByAgent, pick.agent);
    const equivalents = available
      .filter((row) => choiceName(row) !== choiceName(pick) && rank(row.capability) === rank(pick.capability))
      .map((row) => {
        const rowUsage = usageOf(usageByAgent, row.agent);
        return {
          ...row,
          usage: rowUsage.status,
          usageScope: { account: rowUsage.account, host: rowUsage.host },
          capacityConfirmed: rowUsage.capacityConfirmed === true,
          relation: "equivalent",
        };
      });
    const stronger = available
      .filter((row) => choiceName(row) !== choiceName(pick) && rank(row.capability) > rank(pick.capability))
      .map((row) => {
        const rowUsage = usageOf(usageByAgent, row.agent);
        return {
          ...row,
          usage: rowUsage.status,
          usageScope: { account: rowUsage.account, host: rowUsage.host },
          capacityConfirmed: rowUsage.capacityConfirmed === true,
          relation: "stronger",
        };
      });

    const assignment = {
      agent: pick.agent,
      model: pick.model,
      effort: pick.effort,
      capability: pick.capability,
      suits: pick.suits,
      usage: usage.status,
      usageScope: { account: usage.account, host: usage.host },
      capacityConfirmed: usage.capacityConfirmed === true,
      reason:
        `${result.recommendation?.reason ?? `Assessed ${result.assessment.requirement}`}. ` +
        `Wave pick ${choiceName(pick)} after balancing shared load and scarce capable combinations across the ready set.`,
    };

    const decision = {
      task: task.id,
      status: "proposed",
      assessment: result.assessment,
      assignment,
      recommendation: result.recommendation,
      baselineRecommendation: result.baselineRecommendation ?? null,
      learning: result.learning ?? null,
      alternatives: [...equivalents, ...stronger],
      rejected: result.rejected,
      warning: usage.status === "low" ? `${pick.agent} usage is low: ${usage.reason}` : null,
      launch: { started: false, args: launchArgs(pick) },
      capacityNote: "Snapshot only — not reserved capacity. Replan when workers or usage change.",
    };

    // Suitable with unknown/stale/unavailable capacity beside a weaker known-capacity option.
    if (!usage.capacityConfirmed) {
      const knownWeaker = weaker
        .map((row) => {
          const rowUsage = usageOf(usageByAgent, row.agent);
          const baseline = candidates.find((c) => choiceName(c) === choiceName(row));
          return {
            ...row,
            capability: baseline?.capability ?? null,
            suits: baseline?.suits ?? null,
            usage: rowUsage.status,
            usageScope: { account: rowUsage.account, host: rowUsage.host },
            capacityConfirmed: rowUsage.capacityConfirmed === true,
          };
        })
        .filter((row) => row.capacityConfirmed);
      if (knownWeaker.length) {
        const alt = knownWeaker[0];
        decision.status = "needs-decision";
        decision.uncertaintyAlternative = {
          ...alt,
          relation: "weaker",
          warning:
            `Assessed ${result.assessment.requirement}: ${choiceName(pick)} is suitable but usage is ${usage.status} ` +
            `(${usage.reason}). ${choiceName(alt)} has known capacity (${alt.usage}) but is below that requirement.`,
          launch: { started: false, args: launchArgs(alt) },
        };
        decision.reason =
          `Suitable choice ${choiceName(pick)} has unconfirmed capacity (${usage.status}); ` +
          `weaker known-capacity option ${choiceName(alt)} is also shown. Coordinator decides.`;
      } else {
        decision.warning = [decision.warning, `${pick.agent} usage is ${usage.status}: ${usage.reason}`].filter(Boolean).join("; ");
      }
    }

    proposed.push(decision);
    decisions.push(decision);
  }

  // Preserve input order for non-assignable rows, then decisions in priority order already pushed.
  const byId = new Map(decisions.map((row) => [row.task, row]));
  for (const entry of entries) {
    if (entry.status === "blocked" || entry.status === "not-ready") {
      byId.set(entry.task.id, {
        task: entry.task.id,
        status: entry.status,
        reason: entry.reason,
        unmetDependencies: entry.unmetDependencies,
        assessment: null,
        launch: { started: false, args: null },
      });
    }
  }

  const ordered = wave.tasks.map((task) => byId.get(task.id)).filter(Boolean);
  const allowances = sharingReport(usageByAgent, wave.activeWorkers, proposed);

  return {
    status: "planned",
    concurrency: {
      limit: wave.concurrency,
      active: wave.activeWorkers.length,
      proposed: proposed.length,
      remainingSlots: Math.max(0, wave.concurrency - wave.activeWorkers.length - proposed.length),
    },
    activeWorkers: wave.activeWorkers,
    usageByAgent,
    allowances,
    notes: [
      "The planner never starts a worker; pass launch.args through scripts/orca-spawn.sh and the existing preflight/receipt checks.",
      "Provider usage percentages are not comparable across agents.",
      "Active and proposed workers share allowances; projected capacity is uncertain and not reserved.",
      "Unknown, stale, low and exhausted usage are distinct; only fresh and low confirm capacity.",
      "Learning may reorder within a capability tier from comparable history; baselineRecommendation stays visible; transcripts are never read or sent to Jev.",
    ],
    tasks: ordered,
    launch: { started: false },
  };
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

  let waveText;
  try {
    waveText = options.wave === "-" ? readFileSync(0, "utf8") : readFileSync(options.wave, "utf8");
  } catch (error) {
    console.error(`cannot read wave file ${options.wave}: ${error.message}`);
    return 1;
  }

  let wave;
  try {
    wave = parseWave(waveText, { concurrency: options.concurrency });
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  let candidates;
  try {
    candidates = loadCandidates(options.models);
  } catch (error) {
    console.error(`cannot read the capability baseline ${options.models}: ${error.message}`);
    return 1;
  }

  const collected = PROVIDERS.filter((provider) => candidates.some((candidate) => candidate.agent === provider.name));
  const usageByAgent = collected.length ? await usageForPlanning({ providers: collected }) : {};
  const learningOptions = {
    learning: options.learning,
    historyDir: options.historyDir,
    learnDir: options.learnDir,
  };
  const plan = await planWave({ wave, candidates, usageByAgent, learningOptions });
  console.log(JSON.stringify(plan, null, 2));
  return 0;
}

const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  process.exitCode = await main();
}
