/**
 * Routing policy loader and burn-pressure helpers for orca-recommend / orca-plan (#124).
 * Read docs/agents/routing-policy.md before changing the rules.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const KNOWN_FIELDS = new Set([
  "version",
  "decidedAt",
  "decision",
  "allow",
  "reserve",
  "order",
  "safetyFloorPercent",
  "maxConcurrentPerBucket",
  "maxConcurrentTotal",
  "expiringBoost",
  "reviewerOnDifferentPool",
  "maxBucketSharePerWorkerPercent",
  "expectedBucketSharePercent",
  "bucketCostNotes",
]);

/** No allow list: every baseline row stays eligible (tests and custom baselines without a policy file). */
export const NO_POLICY = Object.freeze({
  source: null,
  allow: null,
  reserve: [],
  order: ["antigravity", "codex", "cursor"],
  safetyFloorPercent: 10,
  maxConcurrentPerBucket: 2,
  maxConcurrentTotal: 3,
  expiringBoost: 1,
  reviewerOnDifferentPool: true,
  maxBucketSharePerWorkerPercent: 25,
  expectedBucketSharePercent: [],
  bucketCostNotes: null,
  decidedAt: null,
  decision: null,
  version: null,
});

const DAY_MS = 86_400_000;
const TIE_FRACTION = 0.05;
const EXPIRE_WITHIN_DAYS = 2;
const EXPIRE_MIN_LEFT = 20;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function requireNumber(file, field, value, { min = -Infinity, max = Infinity, integer = false, exclusiveMin = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(file, `${field} must be a number${integer ? " and a positive whole number" : ` from ${min} to ${max}`}`);
  if (integer && (!Number.isInteger(value) || value < 1)) fail(file, `${field} must be a positive whole number`);
  if (exclusiveMin ? value <= min : value < min) {
    if (field === "expiringBoost") fail(file, `${field} must be a number greater than 0`);
    fail(file, `${field} must be a number from ${min} to ${max}`);
  }
  if (value > max) fail(file, `${field} must be a number from ${min} to ${max}`);
  return value;
}

function requireBoolean(file, field, value) {
  if (typeof value !== "boolean") fail(file, `${field} must be true or false`);
  return value;
}

/** Model patterns: exact id, trailing `foo-*`, or lone `*`. */
export function modelPatternOk(pattern) {
  if (typeof pattern !== "string" || !pattern) return false;
  if (pattern === "*") return true;
  if (pattern.includes("*")) return /^[^*]+\*$/.test(pattern);
  return true;
}

export function modelMatches(pattern, model) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*") && !pattern.slice(0, -1).includes("*")) {
    return model.startsWith(pattern.slice(0, -1));
  }
  return pattern === model;
}

function parseAllowOrReserve(file, field, rows, { requireReason = false } = {}) {
  if (!Array.isArray(rows)) fail(file, `${field} must be an array`);
  return rows.map((row, i) => {
    if (!isObject(row)) fail(file, `${field}[${i}] must be an object`);
    if (typeof row.agent !== "string" || !row.agent.trim()) fail(file, `${field}[${i}].agent must be a non-empty string`);
    if (!Array.isArray(row.models) || row.models.length === 0) fail(file, `${field}[${i}].models must be a non-empty array`);
    const models = row.models.map((pattern, j) => {
      if (!modelPatternOk(pattern)) fail(file, `${field}[${i}].models[${j}] must be an exact id, a trailing prefix* pattern, or *`);
      return pattern;
    });
    if (requireReason) {
      if (typeof row.reason !== "string" || !row.reason.trim()) fail(file, `${field}[${i}].reason must be a non-empty string`);
    }
    const out = { agent: row.agent, models };
    if (row.reason !== undefined) out.reason = row.reason;
    return out;
  });
}

function parseExpectedShare(file, rows) {
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) fail(file, "expectedBucketSharePercent must be an array");
  return rows.map((row, i) => {
    if (!isObject(row)) fail(file, `expectedBucketSharePercent[${i}] must be an object`);
    if (typeof row.agent !== "string" || !row.agent.trim()) fail(file, `expectedBucketSharePercent[${i}].agent must be a non-empty string`);
    if (typeof row.model !== "string" || !row.model.trim()) fail(file, `expectedBucketSharePercent[${i}].model must be a non-empty string`);
    const percent = requireNumber(file, `expectedBucketSharePercent[${i}].percent`, row.percent, { min: 0, max: 100 });
    return { agent: row.agent, model: row.model, percent };
  });
}

/**
 * @param {string} text
 * @param {string} file Path used only in error messages.
 */
export function parsePolicy(text, file = "routing-policy.json") {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(file, `not valid JSON (${error.message})`);
  }
  if (!isObject(raw)) fail(file, "must be a JSON object");
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) fail(file, `unknown field "${key}"`);
  }
  for (const field of ["safetyFloorPercent", "maxConcurrentPerBucket", "maxConcurrentTotal", "expiringBoost", "reviewerOnDifferentPool", "allow", "reserve", "order"]) {
    if (!(field in raw)) fail(file, `${field} is required`);
  }

  const safetyFloorPercent = requireNumber(file, "safetyFloorPercent", raw.safetyFloorPercent, { min: 0, max: 100 });
  const maxConcurrentPerBucket = requireNumber(file, "maxConcurrentPerBucket", raw.maxConcurrentPerBucket, { integer: true });
  const maxConcurrentTotal = requireNumber(file, "maxConcurrentTotal", raw.maxConcurrentTotal, { integer: true });
  const expiringBoost = requireNumber(file, "expiringBoost", raw.expiringBoost, { min: 0, exclusiveMin: true });
  const reviewerOnDifferentPool = requireBoolean(file, "reviewerOnDifferentPool", raw.reviewerOnDifferentPool);
  const maxBucketSharePerWorkerPercent =
    raw.maxBucketSharePerWorkerPercent === undefined
      ? 25
      : requireNumber(file, "maxBucketSharePerWorkerPercent", raw.maxBucketSharePerWorkerPercent, { min: 0, max: 100 });

  if (!Array.isArray(raw.order) || raw.order.length === 0) fail(file, "order must be a non-empty array of agent names");
  if (new Set(raw.order).size !== raw.order.length) fail(file, "order must list each agent once");
  if (raw.order.some((name) => typeof name !== "string" || !name.trim())) fail(file, "order must list each agent once");

  const allow = parseAllowOrReserve(file, "allow", raw.allow);
  const reserve = parseAllowOrReserve(file, "reserve", raw.reserve, { requireReason: true });
  const expectedBucketSharePercent = parseExpectedShare(file, raw.expectedBucketSharePercent);
  if (raw.bucketCostNotes !== undefined && raw.bucketCostNotes !== null && typeof raw.bucketCostNotes !== "string") {
    fail(file, "bucketCostNotes must be a string");
  }

  return {
    source: file,
    version: raw.version ?? null,
    decidedAt: raw.decidedAt ?? null,
    decision: raw.decision ?? null,
    allow,
    reserve,
    order: [...raw.order],
    safetyFloorPercent,
    maxConcurrentPerBucket,
    maxConcurrentTotal,
    expiringBoost,
    reviewerOnDifferentPool,
    maxBucketSharePerWorkerPercent,
    expectedBucketSharePercent,
    bucketCostNotes: raw.bucketCostNotes ?? null,
  };
}

export function loadPolicy(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read the routing policy ${file}: ${error.message}`);
  }
  const policy = parsePolicy(text, file);
  policy.source = file;
  return policy;
}

/**
 * Resolve the policy for a recommend/plan run.
 * @param {{ models?: string, policy?: string | object | null }} options
 */
export function resolvePolicy(options = {}) {
  if (options.policy && typeof options.policy === "object") return options.policy;
  if (typeof options.policy === "string" && options.policy.trim()) {
    return loadPolicy(options.policy);
  }
  if (options.models) {
    const beside = path.join(path.dirname(path.resolve(options.models)), "routing-policy.json");
    if (existsSync(beside)) return loadPolicy(beside);
  }
  return { ...NO_POLICY };
}

/** Short label for reports (matches scripts/orca-recommend.mjs). */
export function shortBucketLabel(bucket) {
  const label = String(bucket?.label ?? bucket?.id ?? "quota");
  const id = String(bucket?.id ?? "");
  if (/argon/i.test(label) || /argon/i.test(id)) return "Gemini 4 Argon";
  if (/gemini/i.test(label) || /^gemini-/i.test(id)) {
    if (/5h|five.?hour/i.test(label) || /5h/i.test(id)) return "Gemini Models 5-hour";
    return "Gemini Models weekly";
  }
  if (/claude and gpt|3p-/i.test(label) || /^3p-/i.test(id)) {
    if (/5h|five.?hour/i.test(label) || /5h/i.test(id)) return "Claude and GPT models 5-hour";
    return "Claude and GPT models weekly";
  }
  if (id === "included_auto" || /cursor models|^auto$/i.test(label)) return "Cursor Models";
  if (id === "included_api" || /other models|^api$/i.test(label)) return "Other Models";
  if (id === "included_total" || /plan|^included$/i.test(label)) return "Plan";
  if (id === "on_demand" || /on-?demand/i.test(label)) return "On-demand";
  const head = label.split(":")[0].trim();
  return head || label;
}

export function isFiveHourBucket(bucket) {
  const id = String(bucket?.id ?? "");
  const label = String(bucket?.label ?? "");
  if (/^session$/i.test(id) || /5h|five.?hour/i.test(id)) return true;
  if (/current session|^session$/i.test(label) || /5h|five.?hour/i.test(label)) return true;
  return false;
}

/**
 * @param {{ agent: string, model: string }} candidate
 * @returns {{ policy: string, reason: string } | null}
 */
export function policyVerdict(policy, candidate) {
  if (!policy || policy.allow === null || policy.allow === undefined) return null;
  for (const row of policy.reserve ?? []) {
    if (row.agent === candidate.agent && row.models.some((pattern) => modelMatches(pattern, candidate.model))) {
      return { policy: "reserve", reason: row.reason };
    }
  }
  const allowed = (policy.allow ?? []).some(
    (row) => row.agent === candidate.agent && row.models.some((pattern) => modelMatches(pattern, candidate.model)),
  );
  if (!allowed) {
    return { policy: "not-allowed", reason: "not in the routing policy allow list" };
  }
  return null;
}

export function expectedShareFor(policy, candidate) {
  const listed = (policy.expectedBucketSharePercent ?? []).find(
    (row) => row.agent === candidate.agent && row.model === candidate.model,
  );
  if (listed) return listed.percent;
  return policy.maxBucketSharePerWorkerPercent ?? 25;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function bindingFromBuckets(buckets, nowMs, floor) {
  const scored = [...buckets].sort((a, b) => {
    const leftA = 100 - a.usedPercent;
    const leftB = 100 - b.usedPercent;
    if (leftA !== leftB) return leftA - leftB;
    return String(a.id).localeCompare(String(b.id));
  });
  const bindingBucket = scored[0];
  // Keep exact headroom for floor / share arithmetic; round only when formatting strings.
  const percentLeft = 100 - bindingBucket.usedPercent;
  const resetMs = bindingBucket.resetsAt ? Date.parse(bindingBucket.resetsAt) : NaN;
  let daysToReset = Number.isFinite(resetMs) ? (resetMs - nowMs) / DAY_MS : 0.05;
  if (!(daysToReset > 0)) daysToReset = 0.05;
  // Keep exact synthetic day counts (tests use whole-day resets) without tiny float noise.
  if (Math.abs(daysToReset - Math.round(daysToReset)) < 1e-9) daysToReset = Math.round(daysToReset);
  const label = shortBucketLabel(bindingBucket);
  const binding = {
    bucketId: bindingBucket.id,
    bucket: label,
    percentLeft,
    daysToReset,
    resetsAt: bindingBucket.resetsAt ?? null,
    boost: 1,
  };
  if (percentLeft < floor) {
    return {
      binding,
      skip: `${label} has ${round1(percentLeft)}% left, under the ${floor}% safety floor`,
    };
  }
  return { binding, skip: null };
}

/**
 * Burn pressure for one candidate usage reading.
 * @param {object} usage assessCandidateUsage-shaped report
 * @param {object} policy
 * @param {string | number | Date} [now]
 */
export function burnPressure(usage, policy = NO_POLICY, now = new Date()) {
  const nowMs = typeof now === "number" ? now : Date.parse(String(now));
  const floor = policy.safetyFloorPercent ?? 10;
  const boostFactor = policy.expiringBoost ?? 1;

  if (!usage || typeof usage !== "object") {
    return { pressure: null, skip: null, reason: "unknown usage", binding: null };
  }
  if (!usage.capacityConfirmed && usage.status !== "fresh" && usage.status !== "low") {
    const status = usage.status ?? "unknown";
    return { pressure: null, skip: null, reason: `${status}: capacity is not confirmed`, binding: null };
  }
  if (usage.status !== "fresh" && usage.status !== "low") {
    return { pressure: null, skip: null, reason: `${usage.status}: capacity is not confirmed`, binding: null };
  }

  const buckets = Array.isArray(usage.buckets) ? usage.buckets : [];
  const lasting = buckets.filter((bucket) => !isFiveHourBucket(bucket) && typeof bucket.usedPercent === "number");
  if (!lasting.length) {
    // 5-hour windows do not score burn pressure, but a fresh 5-hour-only reading still
    // faces the safety floor (and expected-share via expectedShareSkip) so it cannot bypass them.
    const fiveHour = buckets.filter((bucket) => isFiveHourBucket(bucket) && typeof bucket.usedPercent === "number");
    if (!fiveHour.length) {
      return { pressure: null, skip: null, reason: "no non-5-hour window to score burn pressure", binding: null };
    }
    const { binding, skip } = bindingFromBuckets(fiveHour, nowMs, floor);
    return {
      pressure: null,
      skip,
      reason: skip ? null : "no non-5-hour window to score burn pressure",
      binding,
    };
  }

  const { binding, skip } = bindingFromBuckets(lasting, nowMs, floor);
  if (skip) {
    return { pressure: null, skip, reason: null, binding };
  }

  let boost = 1;
  if (boostFactor !== 1 && binding.daysToReset <= EXPIRE_WITHIN_DAYS && binding.percentLeft > EXPIRE_MIN_LEFT) {
    boost = boostFactor;
  }
  const pressure = round2((binding.percentLeft / Math.max(binding.daysToReset, 0.05)) * boost);
  return {
    pressure,
    skip: null,
    reason: null,
    binding: { ...binding, boost },
  };
}

/**
 * Lasting (or 5-hour-only) binding derived from raw bucket usedPercent, even when capacity is
 * unconfirmed. Used so stale readings still face expected-share / safety-floor arithmetic.
 */
function bindingFromUsageBuckets(usage, policy, now) {
  if (!usage || typeof usage !== "object") return { binding: null, skip: null };
  const nowMs = typeof now === "number" ? now : Date.parse(String(now));
  const floor = policy.safetyFloorPercent ?? 10;
  const buckets = Array.isArray(usage.buckets) ? usage.buckets : [];
  const lasting = buckets.filter((bucket) => !isFiveHourBucket(bucket) && typeof bucket.usedPercent === "number");
  const fiveHour = buckets.filter((bucket) => isFiveHourBucket(bucket) && typeof bucket.usedPercent === "number");
  const pool = lasting.length ? lasting : fiveHour;
  if (!pool.length) return { binding: null, skip: null };
  return bindingFromBuckets(pool, nowMs, floor);
}

/**
 * Refuse when the expected worker share would push the binding window under the safety floor.
 * `committedPercent` is share already reserved by earlier proposals in the same wave (same binding bucket).
 * Stale / unconfirmed readings with bucket usedPercent still face this check so a later wave
 * pick cannot overdraw headroom reserved by an earlier proposal.
 * @returns {string | null} skip reason
 */
export function expectedShareSkip(usage, policy, candidate, now = new Date(), { committedPercent = 0 } = {}) {
  const pressure = burnPressure(usage, policy, now);
  let binding = pressure.binding;
  if (pressure.skip) return pressure.skip;
  if (!binding) {
    // Stale/unknown: burnPressure drops the binding, but usedPercent is still usable for share math.
    const derived = bindingFromUsageBuckets(usage, policy, now);
    if (derived.skip) return derived.skip;
    binding = derived.binding;
  }
  if (!binding) return null;
  const share = expectedShareFor(policy, candidate);
  const floor = policy.safetyFloorPercent ?? 10;
  const committed = typeof committedPercent === "number" && Number.isFinite(committedPercent) ? committedPercent : 0;
  // Exact remainder vs floor — do not round before the comparison (e.g. 87.04% used + 3% share
  // leaves 9.96%, which must fail a 10% floor even though round1(12.96)=13).
  const effectiveLeft = binding.percentLeft - committed;
  const remaining = effectiveLeft - share;
  if (remaining < floor) {
    const committedNote = committed > 0 ? ` (${committed}% already committed in this wave)` : "";
    return (
      `${binding.bucket} has ${round1(effectiveLeft)}% left${committedNote}; ` +
      `expected share ${share}% would leave ${round1(remaining)}%, under the ${floor}% safety floor`
    );
  }
  return null;
}

/**
 * Highest pressure first; ties within 5% of a band's maximum follow policy.order; nulls keep input order at the end.
 * Bands are formed transitively against the band leader so pairwise non-transitive 5% edges cannot invert order.
 * @template {{ agent: string, pressure: number | null }} T
 * @param {T[]} rows
 * @param {{ order?: string[] }} policy
 * @returns {T[]}
 */
export function rankByPressure(rows, policy = NO_POLICY) {
  const order = policy.order ?? NO_POLICY.order;
  const agentRank = (agent) => {
    const i = order.indexOf(agent);
    return i < 0 ? order.length + 1 : i;
  };
  const indexed = rows.map((row, index) => ({ row, index }));
  const known = indexed.filter((entry) => typeof entry.row.pressure === "number" && Number.isFinite(entry.row.pressure));
  const unknown = indexed.filter((entry) => !(typeof entry.row.pressure === "number" && Number.isFinite(entry.row.pressure)));
  known.sort((a, b) => {
    if (b.row.pressure !== a.row.pressure) return b.row.pressure - a.row.pressure;
    return a.index - b.index;
  });
  let band = -1;
  let bandMax = null;
  for (const entry of known) {
    if (bandMax == null || bandMax <= 0 || bandMax - entry.row.pressure > bandMax * TIE_FRACTION) {
      band += 1;
      bandMax = entry.row.pressure;
    }
    entry.band = band;
  }
  known.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    const byAgent = agentRank(a.row.agent) - agentRank(b.row.agent);
    if (byAgent !== 0) return byAgent;
    return a.index - b.index;
  });
  unknown.sort((a, b) => a.index - b.index);
  return [...known, ...unknown].map((entry) => entry.row);
}

export function formatBurnReason(choiceName, pressureReport, runnerUp = null) {
  if (!pressureReport?.binding || pressureReport.pressure == null) return null;
  const { binding, pressure } = pressureReport;
  let text =
    `burn pressure ${pressure}%/day on ${binding.bucket} ` +
    `(${round1(binding.percentLeft)}% left, resets ${binding.resetsAt ?? "unreported"})`;
  if (runnerUp?.name && runnerUp.pressure != null && runnerUp.binding) {
    text +=
      `; runner-up ${runnerUp.name}: burn pressure ${runnerUp.pressure}%/day on ${runnerUp.binding.bucket} ` +
      `(${round1(runnerUp.binding.percentLeft)}% left, resets ${runnerUp.binding.resetsAt ?? "unreported"})`;
  }
  return text;
}

function workersFromReceipt(raw, { allowIncomplete = false, enforcePageTotal = !allowIncomplete } = {}) {
  const workers = raw?.result?.workers;
  if (!Array.isArray(workers)) throw new Error("worker-list receipt has no result.workers array");
  const page = raw?.result?.page;
  if (!allowIncomplete && page && page.hasMore === true) {
    const total = page.total ?? "?";
    const limit = page.limit ?? workers.length;
    throw new Error(
      `worker-list receipt is incomplete: page.hasMore is true (total ${total}, limit ${limit}); ` +
        `pass every page as a JSON array or { "pages": [...] } (continue with page.nextCursor)`,
    );
  }
  // Single-receipt only: a final page with hasMore=false can still omit workers (total > length).
  // Multi-page merges disable this and check rawCount against page.total across all pages instead.
  if (enforcePageTotal && page && typeof page.total === "number" && workers.length !== page.total) {
    throw new Error(
      `worker-list receipt is incomplete: got ${workers.length} workers, page.total is ${page.total}`,
    );
  }
  const active = [];
  for (const worker of workers) {
    const stage = worker?.projection?.stage?.worker ?? worker?.workerState;
    const dispatch = worker?.projection?.stage?.dispatch ?? worker?.dispatchStatus;
    if (dispatch === "completed" || stage === "succeeded" || stage === "failed" || stage === "cancelled") continue;
    if (worker?.resource?.ownershipState === "released") continue;
    const provider = worker?.projection?.provider;
    // Providerless workers still occupy a concurrency slot; map them to the unknown bucket.
    const agent = typeof provider?.id === "string" && provider.id.trim() ? provider.id : "unknown";
    active.push({
      agent,
      model: provider && typeof provider === "object" ? (provider.model ?? null) : null,
      effort: provider && typeof provider === "object" ? (provider.effort ?? null) : null,
      dispatchId: worker.dispatchId ?? worker.projection?.dispatchId ?? null,
      task: worker.taskId ?? worker.projection?.taskId ?? null,
    });
  }
  return active;
}

/**
 * Active workers from an `orca orchestration worker-list --json` receipt.
 * Accepts one receipt, an array of page receipts, or `{ pages: [...] }`. A single
 * page with `page.hasMore: true` is refused — paginate with `--cursor` until complete.
 * Multi-page input must be contiguous: every non-last page has `hasMore` + `nextCursor`,
 * each follow-on page stamps `cursor` equal to the previous `nextCursor`, the last page
 * completes the sequence, and raw worker counts must match `page.total`.
 * @param {string} text
 */
export function activeWorkersFromWorkerList(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`worker-list JSON is invalid: ${error.message}`);
  }
  const pages = Array.isArray(raw) ? raw : Array.isArray(raw?.pages) ? raw.pages : null;
  if (pages) {
    if (!pages.length) throw new Error("worker-list pages array is empty");
    let expectedTotal = null;
    let rawCount = 0;
    let expectedCursor = null;
    const seenNextCursors = new Set();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const meta = page?.result?.page;
      const workers = page?.result?.workers;
      if (!Array.isArray(workers)) throw new Error("worker-list receipt has no result.workers array");
      rawCount += workers.length;
      // Multi-page input must carry page metadata on every page so continuity cannot be skipped.
      if (!meta || typeof meta !== "object") {
        throw new Error(
          `worker-list pages lack page metadata on page ${i}; each page needs result.page with total/hasMore/nextCursor`,
        );
      }

      const pageCursor = page?.cursor ?? meta?.cursor;
      if (i === 0) {
        if (pageCursor != null && pageCursor !== "") {
          throw new Error(
            `worker-list pages break cursor continuity: page 0 must not carry a request cursor (got ${pageCursor})`,
          );
        }
      } else if (expectedCursor != null) {
        if (pageCursor == null || pageCursor === "") {
          throw new Error(
            `worker-list pages break cursor continuity: page ${i} is missing cursor ${expectedCursor} from the previous nextCursor`,
          );
        }
        if (pageCursor !== expectedCursor) {
          throw new Error(
            `worker-list pages break cursor continuity: page ${i} expected cursor ${expectedCursor}, got ${pageCursor}`,
          );
        }
      }

      if (i === 0) {
        if (typeof meta.total !== "number" || !Number.isFinite(meta.total)) {
          throw new Error(
            `worker-list pages lack a numeric page.total on page 0 (got ${meta.total}); cannot prove the page set is complete`,
          );
        }
        expectedTotal = meta.total;
      } else {
        // Later pages must carry the same finite total — missing/null/string totals cannot
        // silently skip the completeness check.
        if (typeof meta.total !== "number" || !Number.isFinite(meta.total)) {
          throw new Error(
            `worker-list pages lack a numeric page.total on page ${i} (got ${meta.total}); expected ${expectedTotal}`,
          );
        }
        if (meta.total !== expectedTotal) {
          throw new Error(
            `worker-list pages disagree on page.total: page 0 has ${expectedTotal}, page ${i} has ${meta.total}`,
          );
        }
      }
      const last = i === pages.length - 1;
      if (!last) {
        if (meta.hasMore !== true) {
          throw new Error(
            `worker-list pages have a gap: page ${i} has hasMore=${meta.hasMore}, but more pages follow`,
          );
        }
        if (meta.nextCursor == null || meta.nextCursor === "") {
          throw new Error(
            `worker-list pages have a gap: page ${i} is incomplete but has no nextCursor`,
          );
        }
        if (seenNextCursors.has(meta.nextCursor)) {
          throw new Error(
            `worker-list pages break cursor continuity: repeated nextCursor ${meta.nextCursor} at page ${i}`,
          );
        }
        seenNextCursors.add(meta.nextCursor);
        expectedCursor = meta.nextCursor;
      } else if (meta.hasMore !== false) {
        throw new Error(
          `worker-list receipt is incomplete: last page must have hasMore false (got ${meta.hasMore}; continue with page.nextCursor ${meta.nextCursor ?? "?"})`,
        );
      } else {
        expectedCursor = null;
      }
    }
    if (rawCount !== expectedTotal) {
      throw new Error(
        `worker-list pages are missing workers (or a middle page): got ${rawCount} workers across ${pages.length} pages, page.total is ${expectedTotal}`,
      );
    }
    // Dedup across every raw worker (including completed/released) so padded duplicates cannot
    // satisfy page.total then disappear when only active rows are kept.
    const seenRaw = new Set();
    for (let i = 0; i < pages.length; i++) {
      const workers = pages[i]?.result?.workers;
      for (const worker of workers) {
        const provider = worker?.projection?.provider;
        const agent = typeof provider?.id === "string" && provider.id.trim() ? provider.id : "unknown";
        const model = provider && typeof provider === "object" ? (provider.model ?? null) : null;
        const task = worker.taskId ?? worker.projection?.taskId ?? null;
        const key = worker.dispatchId ?? worker.projection?.dispatchId ?? `${agent}/${model}/${task}`;
        if (seenRaw.has(key)) {
          throw new Error(`worker-list pages contain duplicate worker dispatch ${key}`);
        }
        seenRaw.add(key);
      }
    }
    if (seenRaw.size !== expectedTotal) {
      throw new Error(
        `worker-list pages are missing workers (or a middle page): got ${seenRaw.size} unique workers across ${pages.length} pages, page.total is ${expectedTotal}`,
      );
    }
    const merged = [];
    const seenActive = new Set();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const last = i === pages.length - 1;
      const rows = workersFromReceipt(page, { allowIncomplete: !last, enforcePageTotal: false });
      for (const row of rows) {
        const key = row.dispatchId ?? `${row.agent}/${row.model}/${row.task}`;
        if (seenActive.has(key)) {
          throw new Error(`worker-list pages contain duplicate worker dispatch ${key}`);
        }
        seenActive.add(key);
        merged.push(row);
      }
    }
    return merged;
  }
  return workersFromReceipt(raw);
}

/**
 * Static lasting (non-5-hour) quota bucket id for a documented candidate model, from
 * docs/agents/models.md. Used when usage is missing, stale, or unconfirmed so peers that
 * share a pool keep one bucket key. Returns null for unrecognised models.
 * @param {string} agent
 * @param {string | null | undefined} model
 * @returns {string | null}
 */
export function documentedLastingBucketId(agent, model) {
  if (typeof agent !== "string" || !agent.trim()) return null;
  if (typeof model !== "string" || !model.trim()) return null;
  const m = model.trim().toLowerCase();
  if (agent === "antigravity") {
    if (/^claude-(?:opus|sonnet)-5-5(?:-|$)/.test(m) || /^gpt-oss-/.test(m)) return "3p-weekly";
    if (/^gemini-3\.8-flash(?:-|$)/.test(m)) return "gemini-weekly";
    if (/^gemini-4-argon(?:-|$)/.test(m)) return "gemini-argon-wtu-weekly";
    return null;
  }
  if (agent === "cursor") {
    if (m === "auto" || m === "default" || m.startsWith("composer-")) return "included_auto";
    return null;
  }
  if (agent === "codex") return "codex-weekly";
  if (agent === "claude") return "weekly_all";
  return null;
}

/**
 * Binding bucket id for an active/proposed worker.
 * Prefer the observed lasting burn-pressure binding when present (live Ultra Gemini pool,
 * Cursor Plan/`included_total`, …). Fall back to the static documented lasting bucket when
 * usage is missing, stale, or unconfirmed so peers still share one key (e.g. Opus+Sonnet →
 * `3p-weekly`). Model-less / unrecognised models stay `agent/unknown`.
 */
export function bindingBucketIdFor(choice, usageByCandidate = {}, policy = NO_POLICY, now = new Date()) {
  if (!choice?.agent) return null;
  if (!choice.model) return `${choice.agent}/unknown`;
  const key = `${choice.agent}/${choice.model}`;
  const usage = usageByCandidate[key];
  if (usage) {
    const report = burnPressure(usage, policy, now);
    if (report.binding?.bucketId && !isFiveHourBucket({ id: report.binding.bucketId, label: report.binding.bucket })) {
      return `${choice.agent}/${report.binding.bucketId}`;
    }
    // Stale/unconfirmed: burnPressure drops the binding, but lasting usedPercent still names the
    // shared pool (e.g. Ultra Argon+Flash → gemini-weekly) so share/cap math stays coherent.
    const derived = bindingFromUsageBuckets(usage, policy, now);
    if (
      derived.binding?.bucketId &&
      !isFiveHourBucket({ id: derived.binding.bucketId, label: derived.binding.bucket })
    ) {
      return `${choice.agent}/${derived.binding.bucketId}`;
    }
  }
  const documented = documentedLastingBucketId(choice.agent, choice.model);
  if (documented) return `${choice.agent}/${documented}`;
  return `${choice.agent}/unknown`;
}

/**
 * Wave expected-share already reserved for `choice`'s binding bucket, including ambiguous
 * `agent/unknown` share against a known same-agent bucket (and the reverse).
 * @param {Record<string, number>} shareCommitted
 * @param {{ agent?: string, model?: string | null }} choice
 */
export function committedShareFor(shareCommitted, choice, usageByCandidate = {}, policy = NO_POLICY, now = new Date()) {
  const key = bindingBucketIdFor(choice, usageByCandidate, policy, now);
  if (!key || !shareCommitted || typeof shareCommitted !== "object") return 0;
  const agent = choice?.agent;
  let total = shareCommitted[key] ?? 0;
  if (!agent) return total;
  if (key.endsWith("/unknown")) {
    for (const [bucketKey, amount] of Object.entries(shareCommitted)) {
      if (bucketKey !== key && bucketKey.startsWith(`${agent}/`) && typeof amount === "number") {
        total += amount;
      }
    }
    return total;
  }
  const ambiguous = shareCommitted[`${agent}/unknown`];
  if (typeof ambiguous === "number") total += ambiguous;
  return total;
}

/**
 * Count toward a bucket cap, including model-less / ambiguous workers for the same agent
 * so they cannot evade `maxConcurrentPerBucket` under a separate `agent/unknown` key.
 * When the candidate itself maps to `agent/unknown`, known same-agent buckets count too —
 * otherwise two Sonnets at cap would still allow an unknown Opus on that agent.
 * Providerless workers (`unknown/...`) count against every real agent bucket (and the
 * global active set already includes them via `activeWorkers.length`).
 */
export function effectiveBucketLoad(load, key, agent) {
  if (!key) return 0;
  let providerless = 0;
  for (const [bucketKey, row] of Object.entries(load)) {
    if (bucketKey === "unknown/unknown" || bucketKey.startsWith("unknown/")) {
      providerless += row?.count ?? 0;
    }
  }
  const direct = load[key]?.count ?? 0;
  if (key === "unknown/unknown" || key.startsWith("unknown/")) {
    return direct;
  }
  if (key.endsWith("/unknown")) {
    if (!agent || agent === "unknown") return direct;
    let total = providerless;
    for (const [bucketKey, row] of Object.entries(load)) {
      if (bucketKey === `${agent}/unknown` || bucketKey.startsWith(`${agent}/`)) {
        total += row?.count ?? 0;
      }
    }
    return total;
  }
  const ambiguous = agent ? (load[`${agent}/unknown`]?.count ?? 0) : 0;
  let total = direct + ambiguous + providerless;
  // Cursor Plan (`included_total`) and every per-surface `included_*` window draw from the
  // same account allowance — distinct surfaces (e.g. included_api vs included_auto) and
  // reading-less static bindings must still cap each other.
  if (key.startsWith("cursor/included_")) {
    for (const [bucketKey, row] of Object.entries(load)) {
      if (bucketKey !== key && bucketKey.startsWith("cursor/included_")) {
        total += row?.count ?? 0;
      }
    }
  }
  // Claude session + weekly_* windows share one subscription — an active weekly_sonnet
  // worker must block a live weekly_all (or session) candidate under the same cap.
  if (key === "claude/session" || key.startsWith("claude/weekly_")) {
    for (const [bucketKey, row] of Object.entries(load)) {
      if (
        bucketKey !== key &&
        (bucketKey === "claude/session" || bucketKey.startsWith("claude/weekly_"))
      ) {
        total += row?.count ?? 0;
      }
    }
  }
  return total;
}

export function countBucketLoad({ activeWorkers = [], proposed = [], usageByCandidate = {}, policy = NO_POLICY, now = new Date() }) {
  const load = {};
  const bump = (choice) => {
    const key = bindingBucketIdFor(choice, usageByCandidate, policy, now);
    if (!key) return;
    load[key] ??= { count: 0, bucketId: key.split("/").slice(1).join("/"), agent: choice.agent };
    load[key].count += 1;
  };
  for (const worker of activeWorkers) bump(worker);
  for (const row of proposed) {
    // needs-decision may keep launch args for an unconfirmed primary while offering an alternative —
    // conservatively count both so neither bucket can be overdrawn if the coordinator picks either.
    const held = [];
    if (row.uncertaintyAlternative?.agent || row.weakerAlternative?.agent) {
      if (row.assignment?.agent) held.push(row.assignment);
      if (row.uncertaintyAlternative?.agent) held.push(row.uncertaintyAlternative);
      if (row.weakerAlternative?.agent) held.push(row.weakerAlternative);
    } else if (row.assignment?.agent) {
      held.push(row.assignment);
    } else if (row?.agent) {
      held.push(row);
    }
    for (const choice of held) bump(choice);
  }
  return load;
}
