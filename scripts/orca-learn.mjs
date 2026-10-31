#!/usr/bin/env node
/**
 * Conservative learning from worker history (#112, part of #103).
 * Reads structured history records only (never transcripts). Never starts a worker,
 * never sends history to Jev, and never deletes raw history on reset.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDir as defaultHistoryDir, mainCheckoutRoot, openStore, viewRecord } from "./orca-history.mjs";

export const SCHEMA = 1;
export const MIN_COMPARABLE_COUNT = 3;
export const MIN_WEIGHTED_EVIDENCE = 2;
export const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
export const EXPLORATION_RATE = 0.1;
export const UNKNOWN = "unknown";

const USAGE = `Usage: node scripts/orca-learn.mjs <command> [options]

Inspect or reset learned adjustments derived from worker history. Adjustments are
computed from comparable outcomes (agent/model/effort/version, task kind and
difficulty). Reset clears the learning epoch only; raw history is untouched.
Transcripts are never read. Histories are never sent to Jev. Nothing here launches
a worker.

  inspect [--history-dir <dir>] [--learn-dir <dir>] [--kind <kind>] [--difficulty <req>] [--now <iso>]
      Print the baseline ordering note, each learned adjustment with its evidence,
      and which combinations stay uncertain for lack of comparable outcomes.
  reset --yes [--learn-dir <dir>] [--now <iso>]
      Record a reset epoch so earlier evidence no longer influences recommendations.
      Does not delete history records, shared usage or transcripts.

Exit codes: 0 done, 1 failed, 2 bad usage.
Reads ORCA_HISTORY_DIR and ORCA_LEARN_DIR (defaults: artifacts/orca/history and artifacts/orca/learning under the main checkout, shared across worktrees). ORCA_LEARN_NOW / --now replaces the clock (tests).`;

const choiceName = ({ agent, model, effort }) => [agent, model, effort].filter((part) => part !== undefined && part !== null && part !== "" && part !== UNKNOWN).join("/");

/** @param {string | undefined} value */
function known(value) {
  return value !== undefined && value !== null && value !== "" && value !== UNKNOWN;
}

/** @param {any} versionsAgent */
export function agentVersionValue(versionsAgent) {
  if (!versionsAgent || versionsAgent === UNKNOWN) return UNKNOWN;
  if (typeof versionsAgent === "string") return versionsAgent;
  if (typeof versionsAgent === "object" && known(versionsAgent.value)) return String(versionsAgent.value);
  return UNKNOWN;
}

/**
 * Comparability key: agent / model / effort / agent-version / kind / difficulty.
 * @param {{ agent: string, model: string, effort?: string | null, agentVersion?: string, kind: string | null, difficulty: string | null }} parts
 */
export function comparabilityKey(parts) {
  const effort = known(parts.effort) ? parts.effort : UNKNOWN;
  const version = known(parts.agentVersion) ? parts.agentVersion : UNKNOWN;
  const kind = known(parts.kind) ? parts.kind : UNKNOWN;
  const difficulty = known(parts.difficulty) ? parts.difficulty : UNKNOWN;
  return [parts.agent, parts.model, effort, version, kind, difficulty].join("|");
}

/** @param {string} key */
export function parseComparabilityKey(key) {
  const [agent, model, effort, agentVersion, kind, difficulty] = key.split("|");
  return {
    agent,
    model,
    effort: effort === UNKNOWN ? null : effort,
    agentVersion,
    kind: kind === UNKNOWN ? null : kind,
    difficulty: difficulty === UNKNOWN ? null : difficulty,
  };
}

export function defaultLearnDir(env = process.env, repoRoot = mainCheckoutRoot()) {
  return env.ORCA_LEARN_DIR?.trim() || path.join(repoRoot, "artifacts", "orca", "learning");
}

/**
 * @param {string} dir
 */
export function openLearnState(dir) {
  const file = path.join(dir, "state.json");
  const ensure = () => mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (text) => {
    ensure();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  };
  return {
    dir,
    file,
    read() {
      if (!existsSync(file)) return { schema: SCHEMA, resetAt: null };
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return {
          schema: Number.isInteger(parsed.schema) ? parsed.schema : SCHEMA,
          resetAt: typeof parsed.resetAt === "string" ? parsed.resetAt : null,
        };
      } catch (error) {
        throw new Error(`cannot read learn state: ${error.message}`);
      }
    },
    write(state) {
      write(`${JSON.stringify({ schema: SCHEMA, resetAt: state.resetAt ?? null }, null, 2)}\n`);
    },
  };
}

/** Half-life exponential decay. Invalid or future-dated timestamps contribute nothing. */
export function evidenceWeight(at, now, halfLifeMs = HALF_LIFE_MS) {
  const then = Date.parse(at);
  const nowMs = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(nowMs) || then > nowMs) return 0;
  const age = nowMs - then;
  return Math.pow(0.5, age / halfLifeMs);
}

/** Sum of numeric meter values on attributable entries; null when none are recorded. */
export function attributableCost(attributable) {
  if (!attributable || attributable.status !== "recorded" || !attributable.entries?.length) return null;
  let total = 0;
  let saw = false;
  for (const entry of attributable.entries) {
    const metrics = entry?.metrics;
    if (!metrics || typeof metrics !== "object") continue;
    for (const value of Object.values(metrics)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        total += value;
        saw = true;
      }
    }
  }
  return saw ? total : null;
}

/**
 * Separate quality contributions. Missing signals contribute 0 and are listed as unknown —
 * they are never treated as success. Shared usage is ignored entirely.
 * @param {ReturnType<typeof viewRecord>} view
 */
export function signalContributions(view) {
  const signals = [];
  let total = 0;

  const outcome = view.signals.completion.status;
  if (outcome === "succeeded") {
    signals.push({ name: "completion", value: 1, detail: "succeeded" });
    total += 1;
  } else if (outcome === "failed") {
    signals.push({ name: "completion", value: -1, detail: "failed" });
    total -= 1;
  } else {
    signals.push({ name: "completion", value: 0, detail: `unknown (${outcome}) — not counted as success` });
  }

  const checks = view.signals.checks;
  if (checks.status === "recorded") {
    for (const entry of checks.entries) {
      let value = 0;
      if (entry.result === "pass") value = 0.5;
      else if (entry.result === "pass_with_known_failures") value = 0.25;
      else if (entry.result === "fail" || entry.result === "aborted") value = -0.75;
      signals.push({ name: "check", value, detail: `${entry.name}:${entry.result}` });
      total += value;
    }
  } else {
    signals.push({ name: "check", value: 0, detail: "unknown — missing checks are not a pass" });
  }

  const reviews = view.signals.reviews;
  if (reviews.status === "recorded") {
    for (const entry of reviews.entries ?? []) {
      const findings = entry.findings ?? {};
      const blocking = findings.blocking;
      const high = findings.high;
      let value = 0;
      let detail = "no severity counts";
      if (typeof blocking === "number" || typeof high === "number") {
        if ((blocking ?? 0) > 0 || (high ?? 0) > 0) {
          value = -0.5;
          detail = `blocking=${blocking ?? "unknown"} high=${high ?? "unknown"}`;
        } else if (blocking === 0 && high === 0) {
          value = 0.25;
          detail = "blocking=0 high=0";
        } else {
          detail = `blocking=${blocking ?? "unknown"} high=${high ?? "unknown"}`;
        }
      }
      signals.push({ name: "review", value, detail });
      total += value;
    }
  } else {
    signals.push({ name: "review", value: 0, detail: "unknown — missing reviews are not a pass" });
  }

  const fixes = view.signals.followUpFixes;
  if (fixes.status === "linked") {
    const value = Math.max(-1, -0.5 * fixes.entries.length);
    signals.push({ name: "followUpFixes", value, detail: `${fixes.entries.length} linked fix(es)` });
    total += value;
  } else {
    signals.push({ name: "followUpFixes", value: 0, detail: fixes.reason ?? "unknown" });
  }

  const retries = view.signals.retries;
  const retriedBy = retries.retriedBy?.length ?? 0;
  if (retriedBy > 0) {
    const value = Math.max(-1, -0.5 * retriedBy);
    signals.push({ name: "retries", value, detail: `retriedBy=${retriedBy}` });
    total += value;
  } else {
    signals.push({ name: "retries", value: 0, detail: "none linked" });
  }

  // Attributable usage stays out of the quality total. When recorded, its numeric meters feed a
  // separate peer tiebreaker in applyLearning; shared usage never becomes a per-worker cost.
  const attributable = view.usage.attributable;
  const cost = attributableCost(attributable);
  if (attributable.status === "recorded") {
    signals.push({
      name: "attributableUsage",
      value: 0,
      detail:
        cost === null
          ? "recorded but no numeric meters — not available for ranking; kept apart from quality"
          : `recorded cost ${cost}; kept apart from quality; peer tiebreaker only when peers also have meters`,
      available: cost !== null,
      cost,
      entries: attributable.entries,
    });
  } else {
    signals.push({
      name: "attributableUsage",
      value: 0,
      detail: `not available — ${attributable.reason ?? "no per-worker meter has been recorded"}`,
      available: false,
      cost: null,
    });
  }

  if (view.usage.shared?.length) {
    signals.push({
      name: "sharedUsage",
      value: 0,
      detail: "present but ignored for learning — shared change is not a per-worker cost",
      count: view.usage.shared.length,
    });
  }

  // Elapsed time is a separate low-weight peer tiebreaker when known; it does not enter the quality mean.
  const elapsed = view.signals.elapsed;
  if (elapsed?.status === "known" && typeof elapsed.ms === "number" && Number.isFinite(elapsed.ms)) {
    signals.push({
      name: "elapsed",
      value: 0,
      detail: `${elapsed.ms}ms — kept apart from quality; low-weight peer tiebreaker when peers also have elapsed`,
      available: true,
      ms: elapsed.ms,
    });
  }

  // Overrides are choices, not correctness labels: selection.kind is recorded for inspection only.
  if (view.selection?.kind === "override") {
    signals.push({
      name: "override",
      value: 0,
      detail: view.selection.note ?? "an override is a choice, not a label of the recommendation being wrong",
    });
  }

  // Bucket cost delta is kept apart from quality. It feeds learned expected share for routing and peer tiebreaking.
  const bucketCost = view.usage?.bucketCost;
  if (bucketCost?.valid && typeof bucketCost.deltaPercent === "number") {
    signals.push({
      name: "bucketCost",
      value: 0,
      detail: `recorded bucket delta ${bucketCost.deltaPercent}% on ${bucketCost.bucketId}; kept apart from quality; peer tiebreaker and expected share forecasting`,
      available: true,
      bucketId: bucketCost.bucketId,
      deltaPercent: bucketCost.deltaPercent,
    });
  } else {
    signals.push({
      name: "bucketCost",
      value: 0,
      detail: `not available — ${bucketCost?.reason ?? bucketCost?.note ?? "no bucket cost delta recorded"}`,
      available: false,
      bucketId: bucketCost?.bucketId ?? null,
      deltaPercent: null,
    });
  }

  return {
    total,
    signals,
    attributableCost: cost,
    elapsedMs: elapsed?.status === "known" ? elapsed.ms : null,
    bucketDeltaPercent: bucketCost?.valid ? bucketCost.deltaPercent : null,
    bucketId: bucketCost?.bucketId ?? null,
  };
}

/**
 * @param {ReturnType<typeof viewRecord>} view
 * @param {{ resetAt?: string | null, now: string }} opts
 */
export function evidenceFromView(view, { resetAt = null, now }) {
  const completedAt = known(view.lifecycle.completedAt) ? view.lifecycle.completedAt : view.updatedAt;
  if (resetAt && Date.parse(completedAt) <= Date.parse(resetAt)) {
    return null;
  }
  const outcome = view.signals.completion.status;
  if (outcome !== "succeeded" && outcome !== "failed") {
    return {
      id: view.id,
      included: false,
      reason: "missing outcome is not success",
      outcome,
      key: null,
    };
  }
  if (!known(view.agent.name) || !known(view.agent.effectiveModel)) {
    return { id: view.id, included: false, reason: "agent or model unknown", key: null };
  }
  if (!known(view.task.type) || !known(view.task.difficulty)) {
    return { id: view.id, included: false, reason: "task kind or difficulty unknown — not comparable", key: null };
  }
  const key = comparabilityKey({
    agent: view.agent.name,
    model: view.agent.effectiveModel,
    effort: view.agent.effectiveEffort,
    agentVersion: agentVersionValue(view.versions.agent),
    kind: view.task.type,
    difficulty: view.task.difficulty,
  });
  const weight = evidenceWeight(completedAt, now);
  if (weight === 0) {
    return {
      id: view.id,
      included: false,
      reason: "future-dated or invalid completedAt",
      outcome,
      key: null,
      completedAt,
    };
  }
  const { total, signals, attributableCost: cost, elapsedMs, bucketDeltaPercent, bucketId } = signalContributions(view);
  return {
    id: view.id,
    included: true,
    key,
    outcome,
    completedAt,
    weight,
    score: total,
    weightedScore: total * weight,
    signals,
    selectionKind: view.selection?.kind ?? UNKNOWN,
    attributable: cost !== null,
    attributableCost: cost,
    elapsedMs: typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? elapsedMs : null,
    bucketDeltaPercent: typeof bucketDeltaPercent === "number" && Number.isFinite(bucketDeltaPercent) ? bucketDeltaPercent : null,
    bucketId: bucketId ?? null,
  };
}

/**
 * @param {ReturnType<typeof openStore>} store
 * @param {{ resetAt?: string | null, now: string }} opts
 */
export function collectEvidence(store, opts) {
  const evidence = [];
  const seen = new Set();
  for (const id of store.recordIds()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const record = store.getRecord(id);
    if (!record) continue;
    const view = viewRecord(store, record);
    const row = evidenceFromView(view, opts);
    if (row) evidence.push(row);
  }
  return evidence;
}

/**
 * @param {Array<ReturnType<typeof evidenceFromView>>} evidence
 * @param {{ kind?: string | null, difficulty?: string | null }} filter
 */
export function buildAdjustments(evidence, filter = {}) {
  /** @type {Map<string, any>} */
  const buckets = new Map();
  const seenIds = new Set();
  for (const row of evidence) {
    if (!row?.included || !row.key) continue;
    if (row.id != null) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
    }
    const parts = parseComparabilityKey(row.key);
    if (filter.kind && parts.kind !== filter.kind) continue;
    if (filter.difficulty && parts.difficulty !== filter.difficulty) continue;
    if (!buckets.has(row.key)) {
      buckets.set(row.key, {
        key: row.key,
        ...parts,
        choice: choiceName(parts),
        outcomes: [],
        weightedScore: 0,
        weightedCount: 0,
        rawCount: 0,
        attributableCostSum: 0,
        attributableCostCount: 0,
        bucketDeltaSum: 0,
        bucketDeltaCount: 0,
        elapsedSum: 0,
        elapsedCount: 0,
      });
    }
    const bucket = buckets.get(row.key);
    bucket.outcomes.push({
      id: row.id,
      outcome: row.outcome,
      completedAt: row.completedAt,
      weight: row.weight,
      score: row.score,
      weightedScore: row.weightedScore,
      signals: row.signals,
      selectionKind: row.selectionKind,
      attributableCost: row.attributableCost ?? null,
      bucketDeltaPercent: row.bucketDeltaPercent ?? null,
      bucketId: row.bucketId ?? null,
      elapsedMs: row.elapsedMs ?? null,
    });
    bucket.weightedScore += row.weightedScore;
    bucket.weightedCount += row.weight;
    bucket.rawCount += 1;
    if (typeof row.attributableCost === "number" && Number.isFinite(row.attributableCost)) {
      bucket.attributableCostSum += row.attributableCost;
      bucket.attributableCostCount += 1;
    }
    if (typeof row.bucketDeltaPercent === "number" && Number.isFinite(row.bucketDeltaPercent)) {
      bucket.bucketDeltaSum += row.bucketDeltaPercent;
      bucket.bucketDeltaCount += 1;
    }
    if (typeof row.elapsedMs === "number" && Number.isFinite(row.elapsedMs)) {
      bucket.elapsedSum += row.elapsedMs;
      bucket.elapsedCount += 1;
    }
  }

  const adjustments = [];
  const uncertain = [];
  for (const bucket of buckets.values()) {
    const mean = bucket.weightedCount > 0 ? bucket.weightedScore / bucket.weightedCount : 0;
    const sufficient = bucket.rawCount >= MIN_COMPARABLE_COUNT && bucket.weightedCount >= MIN_WEIGHTED_EVIDENCE;
    const entry = {
      ...bucket,
      meanScore: mean,
      preference: mean,
      meanAttributableCost:
        bucket.attributableCostCount > 0 ? bucket.attributableCostSum / bucket.attributableCostCount : null,
      meanBucketDeltaPercent:
        bucket.bucketDeltaCount > 0 ? Math.round((bucket.bucketDeltaSum / bucket.bucketDeltaCount) * 10) / 10 : null,
      bucketDeltaCount: bucket.bucketDeltaCount,
      meanElapsedMs: bucket.elapsedCount > 0 ? bucket.elapsedSum / bucket.elapsedCount : null,
      sufficient,
      uncertain: !sufficient,
      rule: {
        minComparableCount: MIN_COMPARABLE_COUNT,
        minWeightedEvidence: MIN_WEIGHTED_EVIDENCE,
        halfLifeDays: HALF_LIFE_MS / (24 * 60 * 60 * 1000),
      },
      evidence: bucket.outcomes,
    };
    delete entry.outcomes;
    delete entry.attributableCostSum;
    delete entry.attributableCostCount;
    delete entry.bucketDeltaSum;
    delete entry.elapsedSum;
    delete entry.elapsedCount;
    if (sufficient) adjustments.push(entry);
    else uncertain.push(entry);
  }

  adjustments.sort((a, b) => b.preference - a.preference || a.key.localeCompare(b.key));
  uncertain.sort((a, b) => a.key.localeCompare(b.key));
  return { adjustments, uncertain };
}

/**
 * Load history + learn state into adjustments for a task context.
 */
export function loadLearningContext({
  historyDir,
  learnDir,
  kind = null,
  difficulty = null,
  now = new Date().toISOString(),
  agentVersions = {},
} = {}) {
  const history = historyDir ?? defaultHistoryDir();
  const learn = learnDir ?? defaultLearnDir();
  const state = openLearnState(learn).read();
  const store = openStore(history);
  const evidence = collectEvidence(store, { resetAt: state.resetAt, now });
  const { adjustments, uncertain } = buildAdjustments(evidence, { kind, difficulty });
  return {
    enabled: true,
    historyDir: history,
    learnDir: learn,
    resetAt: state.resetAt,
    now,
    agentVersions,
    evidence,
    adjustments,
    uncertain,
    excluded: evidence.filter((row) => row && !row.included),
    rule: {
      minComparableCount: MIN_COMPARABLE_COUNT,
      minWeightedEvidence: MIN_WEIGHTED_EVIDENCE,
      halfLifeDays: HALF_LIFE_MS / (24 * 60 * 60 * 1000),
      explorationRate: EXPLORATION_RATE,
      comparability: "agent|model|effort|agentVersion|kind|difficulty",
    },
  };
}

function candidateKey(candidate, { kind, difficulty, agentVersions }) {
  const version = agentVersions?.[candidate.agent] ?? UNKNOWN;
  return comparabilityKey({
    agent: candidate.agent,
    model: candidate.model,
    effort: candidate.effort,
    agentVersion: version,
    kind,
    difficulty,
  });
}

function lookupAdjustment(adjustments, candidate, ctx) {
  const exact = candidateKey(candidate, ctx);
  const found = adjustments.find((row) => row.key === exact);
  if (found) return found;
  // If the current agent version is unknown, do not borrow another version's evidence.
  return null;
}

/**
 * Reorder capability-suitable candidates conservatively. Capability tier is unchanged:
 * learning only reorders within the same capability rank as the baseline first pick.
 * Always returns baselineRecommendation beside the (possibly adjusted) recommendation.
 *
 * @param {{
 *   usable: any[],
 *   kind: string | null,
 *   difficulty: string | null,
 *   learning: ReturnType<typeof loadLearningContext> | null,
 *   random?: () => number,
 * }} args
 */
/**
 * Rank band for a scored candidate: positive (1) > unevidenced (0) > negative (-1).
 * Negative evidence demotes below the unevidenced band; it never promotes a choice.
 * Preference is compared only inside the positive band (see applyLearning sort).
 * @param {{ adjustment: any }} row
 */
function evidenceBand(row) {
  if (!row.adjustment) return 0;
  if (row.adjustment.preference > 0) return 1;
  if (row.adjustment.preference < 0) return -1;
  return 0;
}

/**
 * Secondary peer signals: lower attributable cost, lower bucket delta, then lower elapsed, only when both sides have them.
 * @param {{ adjustment: any, candidate: any }} a
 * @param {{ adjustment: any, candidate: any }} b
 * @param {any[]} sameTier
 */
function comparePeerSignals(a, b, sameTier) {
  const aCost = a.adjustment?.meanAttributableCost;
  const bCost = b.adjustment?.meanAttributableCost;
  if (typeof aCost === "number" && typeof bCost === "number" && aCost !== bCost) return aCost - bCost;
  const aDelta = a.adjustment?.meanBucketDeltaPercent;
  const bDelta = b.adjustment?.meanBucketDeltaPercent;
  if (typeof aDelta === "number" && typeof bDelta === "number" && aDelta !== bDelta) return aDelta - bDelta;
  const aElapsed = a.adjustment?.meanElapsedMs;
  const bElapsed = b.adjustment?.meanElapsedMs;
  if (typeof aElapsed === "number" && typeof bElapsed === "number" && aElapsed !== bElapsed) return aElapsed - bElapsed;
  return sameTier.indexOf(a.candidate) - sameTier.indexOf(b.candidate);
}

/**
 * Returns the learned bucket share percent for a candidate from learning adjustments.
 * @param {ReturnType<typeof loadLearningContext> | { adjustments?: any[] }} learning
 * @param {{ agent: string, model: string, effort?: string | null }} candidate
 * @param {{ kind?: string | null, difficulty?: string | null }} [filter]
 * @returns {number | null}
 */
export function learnedBucketShareFrom(learning, candidate, { kind = null, difficulty = null } = {}) {
  if (!learning?.adjustments || !Array.isArray(learning.adjustments)) return null;
  const matches = learning.adjustments.filter(
    (adj) =>
      adj.agent === candidate.agent &&
      adj.model === candidate.model &&
      (candidate.effort === undefined || candidate.effort === null || adj.effort === candidate.effort || adj.effort === null) &&
      typeof adj.meanBucketDeltaPercent === "number" &&
      adj.bucketDeltaCount > 0,
  );
  if (!matches.length) return null;
  if (kind || difficulty) {
    const contextual = matches.find(
      (adj) => (!kind || adj.kind === kind) && (!difficulty || adj.difficulty === difficulty),
    );
    if (contextual) return contextual.meanBucketDeltaPercent;
  }
  const totalDelta = matches.reduce((sum, adj) => sum + adj.meanBucketDeltaPercent * adj.bucketDeltaCount, 0);
  const totalCount = matches.reduce((sum, adj) => sum + adj.bucketDeltaCount, 0);
  return totalCount > 0 ? Math.round((totalDelta / totalCount) * 10) / 10 : matches[0].meanBucketDeltaPercent;
}

export function applyLearning({ usable, kind, difficulty, learning, random = Math.random }) {
  const baselineFirst = usable[0] ?? null;
  const empty = {
    baselineRecommendation: baselineFirst,
    recommendation: baselineFirst,
    ordered: [...usable],
    applied: [],
    demoted: [],
    uncertain: [],
    exploration: null,
    usedLearning: false,
  };
  if (!baselineFirst || !learning?.enabled) return empty;

  const ctx = { kind, difficulty, agentVersions: learning.agentVersions ?? {} };
  const tier = baselineFirst.capability;
  const sameTier = usable.filter((row) => row.capability === tier);
  const stronger = usable.filter((row) => row.capability !== tier);

  const scored = sameTier.map((candidate) => {
    const adjustment = lookupAdjustment(learning.adjustments, candidate, ctx);
    const uncertainRow = lookupAdjustment(learning.uncertain, candidate, ctx);
    return {
      candidate,
      adjustment,
      uncertain: !adjustment,
      preference: adjustment ? adjustment.preference : 0,
      evidenceCount: adjustment?.rawCount ?? uncertainRow?.rawCount ?? 0,
      weightedCount: adjustment?.weightedCount ?? uncertainRow?.weightedCount ?? 0,
      key: candidateKey(candidate, ctx),
    };
  });

  const withEvidence = scored.filter((row) => row.adjustment);
  const underObserved = scored.filter((row) => row.uncertain);

  let orderedTier = [...sameTier];
  const applied = [];
  const demoted = [];
  if (withEvidence.length) {
    // Bands: positive > unevidenced > negative. Preference ranks only inside the
    // positive band. Equal non-positive peers keep baseline order so a less-bad
    // negative score never tips the pick away from the baseline.
    orderedTier = [...scored]
      .sort((a, b) => {
        const bandA = evidenceBand(a);
        const bandB = evidenceBand(b);
        const bandDiff = bandB - bandA;
        if (bandDiff !== 0) return bandDiff;
        if (bandA > 0 && a.adjustment && b.adjustment && b.preference !== a.preference) {
          return b.preference - a.preference;
        }
        if (bandA > 0) return comparePeerSignals(a, b, sameTier);
        return sameTier.indexOf(a.candidate) - sameTier.indexOf(b.candidate);
      })
      .map((row) => row.candidate);

    for (const row of scored) {
      if (!row.adjustment) continue;
      const evidence = row.adjustment.evidence.map((e) => ({
        id: e.id,
        outcome: e.outcome,
        completedAt: e.completedAt,
        weight: e.weight,
        score: e.score,
        selectionKind: e.selectionKind,
      }));
      if (row.preference > 0 && orderedTier[0] && choiceName(orderedTier[0]) === choiceName(row.candidate) && choiceName(baselineFirst) !== choiceName(row.candidate)) {
        applied.push({
          choice: choiceName(row.candidate),
          key: row.key,
          preference: row.preference,
          rawCount: row.adjustment.rawCount,
          weightedCount: row.adjustment.weightedCount,
          meanScore: row.adjustment.meanScore,
          evidence,
          effect: `preferred over baseline ${choiceName(baselineFirst)} within capability ${tier}`,
        });
      }
      if (row.preference < 0) {
        demoted.push({
          choice: choiceName(row.candidate),
          key: row.key,
          preference: row.preference,
          rawCount: row.adjustment.rawCount,
          weightedCount: row.adjustment.weightedCount,
          meanScore: row.adjustment.meanScore,
          evidence,
          effect: `demoted below unevidenced options within capability ${tier} because mean score ${row.adjustment.meanScore.toFixed(2)} is negative`,
        });
      }
    }
  }

  let recommendation = orderedTier[0] ?? baselineFirst;
  let exploration = null;
  // Explore only when the corpus has at least one included comparable outcome for this kind/difficulty.
  // Otherwise every candidate is under-observed and a random tip would be noise, not learning.
  const corpusHasEvidence = (learning.evidence ?? []).some((row) => row?.included);
  const explorables = underObserved.filter((row) => choiceName(row.candidate) !== choiceName(recommendation));
  if (corpusHasEvidence && explorables.length && random() < EXPLORATION_RATE) {
    const pick = explorables[Math.floor(random() * explorables.length)];
    exploration = {
      choice: choiceName(pick.candidate),
      key: pick.key,
      reason: "suitable under-observed combination proposed to gather evidence",
      uncertain: true,
      evidenceCount: pick.evidenceCount,
      weightedCount: pick.weightedCount,
    };
    recommendation = pick.candidate;
    // Keep the learned/baseline order intact for alternatives; exploration is the tip only.
    orderedTier = [pick.candidate, ...orderedTier.filter((c) => choiceName(c) !== choiceName(pick.candidate))];
  }

  const uncertain = underObserved.map((row) => ({
    choice: choiceName(row.candidate),
    key: row.key,
    rawCount: row.evidenceCount,
    weightedCount: row.weightedCount,
    reason:
      row.evidenceCount === 0
        ? "no comparable outcomes for this agent/model/effort/version/kind/difficulty"
        : `only ${row.evidenceCount} comparable outcome(s) (need ${MIN_COMPARABLE_COUNT}) or weighted evidence ${row.weightedCount.toFixed(2)} < ${MIN_WEIGHTED_EVIDENCE}`,
  }));

  // Surface version-mismatched evidence so the coordinator can see why it did not apply.
  const versionMismatches = (learning.adjustments ?? [])
    .concat(learning.uncertain ?? [])
    .filter((row) => {
      if (row.kind !== kind || row.difficulty !== difficulty) return false;
      return sameTier.some(
        (c) => c.agent === row.agent && c.model === row.model && (c.effort ?? null) === (row.effort ?? null) && (ctx.agentVersions[c.agent] ?? UNKNOWN) !== row.agentVersion,
      );
    })
    .map((row) => ({
      choice: row.choice,
      key: row.key,
      agentVersion: row.agentVersion,
      currentVersion: ctx.agentVersions[row.agent] ?? UNKNOWN,
      reason: "evidence from a different agent version is not comparable",
      rawCount: row.rawCount,
    }));

  return {
    baselineRecommendation: baselineFirst,
    recommendation,
    ordered: [...orderedTier, ...stronger],
    applied,
    demoted,
    uncertain,
    versionMismatches,
    exploration,
    usedLearning: applied.length > 0 || demoted.length > 0 || exploration !== null,
    resetAt: learning.resetAt ?? null,
    rule: learning.rule,
  };
}

export function inspectLearning(options = {}) {
  const now = options.now ?? process.env.ORCA_LEARN_NOW ?? new Date().toISOString();
  const learning = loadLearningContext({
    historyDir: options.historyDir,
    learnDir: options.learnDir,
    kind: options.kind ?? null,
    difficulty: options.difficulty ?? null,
    now,
  });
  return {
    status: "inspected",
    baseline: {
      note: "Capability-and-usage baseline is unchanged: smallest suitable capability from docs/agents/models.md, then usage. Learning only reorders within that capability tier when evidence is sufficient.",
      source: "docs/agents/models.md + scripts/orca-recommend.mjs",
    },
    resetAt: learning.resetAt,
    now: learning.now,
    rule: learning.rule,
    adjustments: learning.adjustments,
    uncertain: learning.uncertain,
    excluded: learning.excluded,
    historyDir: learning.historyDir,
    learnDir: learning.learnDir,
  };
}

export function resetLearning({ learnDir, now = new Date().toISOString(), yes = false } = {}) {
  if (!yes) throw new Error("reset needs --yes");
  const dir = learnDir ?? defaultLearnDir();
  const state = openLearnState(dir);
  state.write({ resetAt: now });
  return {
    status: "reset",
    resetAt: now,
    learnDir: dir,
    note: "Learned adjustments ignore evidence at or before resetAt. Raw history, shared usage and transcripts are unchanged.",
  };
}

/**
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") return { help: true };
  const command = argv[0];
  if (!["inspect", "reset"].includes(command)) return { error: `unknown command: ${command}` };
  const options = { command };
  const flags = {
    "--history-dir": "historyDir",
    "--learn-dir": "learnDir",
    "--kind": "kind",
    "--difficulty": "difficulty",
    "--now": "now",
  };
  for (let i = 1; i < argv.length; ) {
    const flag = argv[i];
    if (flag === "--yes") {
      options.yes = true;
      i += 1;
      continue;
    }
    if (!flags[flag]) return { error: `unknown option: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) return { error: `${flag} needs a value` };
    options[flags[flag]] = value;
    i += 2;
  }
  if (command === "reset" && !options.yes) return { error: "reset needs --yes" };
  return { options };
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
  const { options } = parsed;
  const now = options.now ?? env.ORCA_LEARN_NOW ?? new Date().toISOString();
  try {
    if (options.command === "inspect") {
      const report = inspectLearning({
        historyDir: options.historyDir ?? defaultHistoryDir(env),
        learnDir: options.learnDir ?? defaultLearnDir(env),
        kind: options.kind,
        difficulty: options.difficulty,
        now,
      });
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    const result = resetLearning({
      learnDir: options.learnDir ?? defaultLearnDir(env),
      now,
      yes: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  process.exitCode = main();
}
