import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error Plain JS module under test.
import { activeWorkersFromWorkerList, bindingBucketIdFor, burnPressure, countBucketLoad, effectiveBucketLoad, expectedShareFor, expectedShareSkip, isFiveHourBucket, loadPolicy, NO_POLICY, parsePolicy, policyVerdict, rankByPressure, resolvePolicy } from "../scripts/orca-routing.mjs";
// @ts-expect-error Plain JS module under test.
import { modelChoiceSection, parseCliArgs as parseRecommendArgs, recommend } from "../scripts/orca-recommend.mjs";
// @ts-expect-error Plain JS module under test.
import { parseCliArgs as parsePlanArgs, parseWave, planWave } from "../scripts/orca-plan.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_FILE = join(repoRoot, "docs", "agents", "routing-policy.json");
const NOW = "2026-10-31T17:25:00.000Z";
const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.parse(NOW) + days * DAY).toISOString();

type Bucket = { id: string; label: string; usedPercent: number; resetsAt: string | null };
function usage(status: string, buckets: Bucket[]) {
  return {
    status,
    reason: buckets.map((b) => `${b.label} ${b.usedPercent}% used`).join("; "),
    capacityConfirmed: status === "fresh" || status === "low",
    source: { kind: "test" },
    observedAt: NOW,
    account: "sha256:0000000000000000",
    host: "test",
    resetsAt: buckets[0]?.resetsAt ?? null,
    buckets,
  };
}

// Bucket figures copied from a live `usageByCandidate` reading on 2026-10-31 (account and host removed).
const B = {
  claudeSession: { id: "session", label: "Current session", usedPercent: 26, resetsAt: "2026-10-31T18:29:59.818Z" },
  claudeWeek: { id: "weekly_all", label: "Current week (all models)", usedPercent: 90, resetsAt: "2026-11-04T15:59:59.818Z" },
  argon: { id: "gemini-argon-wtu-weekly", label: "Gemini 4 Argon: Gemini 4 Argon Weekly Limit", usedPercent: 99.19, resetsAt: "2026-11-06T08:55:59.000Z" },
  cursorPlan: { id: "included_total", label: "Plan", usedPercent: 31.71428571428571, resetsAt: "2026-11-21T08:14:23.000Z" },
  cursorAuto: { id: "included_auto", label: "Cursor Models", usedPercent: 28.297777777777778, resetsAt: "2026-11-21T08:14:23.000Z" },
  geminiWeek: { id: "gemini-weekly", label: "Gemini Models: Weekly Limit Remaining", usedPercent: 8.67, resetsAt: "2026-11-05T23:16:23.000Z" },
  gemini5h: { id: "gemini-5h", label: "Gemini Models: Five Hour Limit Remaining", usedPercent: 0.04, resetsAt: "2026-10-31T17:33:32.000Z" },
  codex5h: { id: "codex-5h", label: "5h limit", usedPercent: 2, resetsAt: "2026-10-31T22:24:09.000Z" },
  codexWeek: { id: "codex-weekly", label: "Weekly limit", usedPercent: 65, resetsAt: "2026-11-04T11:06:09.000Z" },
  thirdWeek: { id: "3p-weekly", label: "Claude and GPT models: Weekly Limit Remaining", usedPercent: 23.32, resetsAt: "2026-11-07T13:20:13.000Z" },
  third5h: { id: "3p-5h", label: "Claude and GPT models: Five Hour Limit Remaining", usedPercent: 46.63, resetsAt: "2026-10-31T18:20:13.000Z" },
};

function liveUsage(changes: Partial<Record<keyof typeof B, Partial<Bucket>>> = {}, statuses: Record<string, string> = {}) {
  const b = Object.fromEntries(Object.entries(B).map(([k, v]) => [k, { ...v, ...(changes[k as keyof typeof B] ?? {}) }])) as typeof B;
  const rows: Record<string, ReturnType<typeof usage>> = {
    "claude/claude-opus-5-5": usage("low", [b.claudeSession, b.claudeWeek]),
    "claude/claude-sonnet-5-5": usage("low", [b.claudeSession, b.claudeWeek]),
    "antigravity/gemini-4-argon-high": usage("low", [b.argon]),
    "cursor/composer-2.5": usage("fresh", [b.cursorPlan, b.cursorAuto]),
    "antigravity/gemini-3.8-flash-high": usage("fresh", [b.geminiWeek, b.gemini5h]),
    "cursor/auto": usage("fresh", [b.cursorPlan, b.cursorAuto]),
    "codex/gpt-6.1-terra": usage("fresh", [b.codex5h, b.codexWeek]),
    "antigravity/claude-opus-5-5-high": usage("fresh", [b.thirdWeek, b.third5h]),
    "antigravity/claude-sonnet-5-5-medium": usage("fresh", [b.thirdWeek, b.third5h]),
  };
  for (const [key, status] of Object.entries(statuses)) rows[key] = { ...rows[key], status, capacityConfirmed: status === "fresh" || status === "low" };
  return rows;
}

// The rows of docs/agents/models.md on 2026-10-31.
const row = (agent: string, model: string, effort: string | null, capability: string) => ({ agent, model, effort, capability, suits: `${capability} work`, unusable: null });
const CANDIDATES = [
  row("claude", "claude-opus-5-5", "high", "reasoning-heavy"),
  row("claude", "claude-sonnet-5-5", "medium", "standard"),
  row("claude", "claude-sonnet-5-5", "high", "standard"),
  row("antigravity", "gemini-4-argon-high", null, "mechanical"),
  row("cursor", "composer-2.5", null, "standard"),
  row("antigravity", "gemini-3.8-flash-high", null, "mechanical"),
  row("cursor", "auto", null, "standard"),
  row("codex", "gpt-6.1-terra", "max", "standard"),
  row("antigravity", "claude-opus-5-5-high", null, "reasoning-heavy"),
  row("antigravity", "claude-sonnet-5-5-medium", null, "standard"),
];

const named = (c: { agent: string; model: string; effort?: string | null } | null) => (c ? [c.agent, c.model, c.effort].filter(Boolean).join("/") : null);
const policy = () => loadPolicy(POLICY_FILE);

async function withoutKey<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    return await fn();
  } finally {
    if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
  }
}

function choose(requirement: string, extra: Record<string, unknown> = {}, usageByCandidate = liveUsage(), candidates: unknown[] = CANDIDATES): Promise<any> {
  return withoutKey(() =>
    recommend(
      { task: "t", summary: "x", eligible: [], judgment: requirement, judgmentReason: "r", learning: false, now: NOW, policy: policy(), ...extra },
      candidates,
      {},
      usageByCandidate,
    ),
  );
}

// --- 1. Policy file

test("the repository policy holds the owner's policy C", () => {
  const p = policy();
  assert.equal(p.source, POLICY_FILE);
  assert.equal(p.decidedAt, "2026-10-31");
  assert.equal(p.safetyFloorPercent, 10);
  assert.equal(p.maxConcurrentPerBucket, 2);
  assert.equal(p.maxConcurrentTotal, 3);
  assert.equal(p.expiringBoost, 1);
  assert.equal(p.reviewerOnDifferentPool, true);
  assert.deepEqual(p.order, ["antigravity", "codex", "cursor"]);
  for (const allowed of ["cursor/auto", "cursor/composer-2.5", "antigravity/claude-opus-5-5-high", "antigravity/claude-sonnet-5-5-medium", "antigravity/gemini-3.8-flash-high", "codex/gpt-6.1-terra"]) {
    const [agent, model] = allowed.split("/");
    assert.equal(policyVerdict(p, { agent, model }), null, allowed);
  }
  const claude = policyVerdict(p, { agent: "claude", model: "claude-opus-5-5" });
  assert.equal(claude.policy, "reserve");
  assert.match(claude.reason, /coordinator/);
  const argon = policyVerdict(p, { agent: "antigravity", model: "gemini-4-argon-high" });
  assert.equal(argon.policy, "reserve");
  assert.match(argon.reason, /exhausted/);
  const other = policyVerdict(p, { agent: "cursor", model: "gpt-9-other" });
  assert.equal(other.policy, "not-allowed");
  assert.match(other.reason, /not in the routing policy allow list/);
});

test("the policy is validated on load with errors that name the file and the field", () => {
  const good = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
  const bad = (change: Record<string, unknown>) => JSON.stringify({ ...good, ...change });
  assert.throws(() => parsePolicy("{ not json", "p.json"), /p\.json: .*not valid JSON/);
  assert.throws(() => parsePolicy("[]", "p.json"), /p\.json: .*must be a JSON object/);
  assert.throws(() => parsePolicy(bad({ surprise: 1 }), "p.json"), /p\.json: unknown field "surprise"/);
  assert.throws(() => parsePolicy(bad({ safetyFloorPercent: 120 }), "p.json"), /p\.json: safetyFloorPercent must be a number from 0 to 100/);
  assert.throws(() => parsePolicy(bad({ safetyFloorPercent: "10" }), "p.json"), /safetyFloorPercent/);
  assert.throws(() => parsePolicy(bad({ maxConcurrentPerBucket: 0 }), "p.json"), /maxConcurrentPerBucket must be a positive whole number/);
  assert.throws(() => parsePolicy(bad({ maxConcurrentTotal: 1.5 }), "p.json"), /maxConcurrentTotal must be a positive whole number/);
  assert.throws(() => parsePolicy(bad({ expiringBoost: 0 }), "p.json"), /expiringBoost must be a number greater than 0/);
  assert.throws(() => parsePolicy(bad({ reviewerOnDifferentPool: "yes" }), "p.json"), /reviewerOnDifferentPool must be true or false/);
  assert.throws(() => parsePolicy(bad({ allow: "cursor" }), "p.json"), /allow must be an array/);
  assert.throws(() => parsePolicy(bad({ allow: [{ agent: "cursor" }] }), "p.json"), /allow\[0\]\.models must be a non-empty array/);
  assert.throws(() => parsePolicy(bad({ allow: [{ agent: "cursor", models: ["a*b"] }] }), "p.json"), /allow\[0\]\.models\[0\]/);
  assert.throws(() => parsePolicy(bad({ reserve: [{ agent: "claude", models: ["*"] }] }), "p.json"), /reserve\[0\]\.reason must be a non-empty string/);
  assert.throws(() => parsePolicy(bad({ order: ["codex", "codex"] }), "p.json"), /order must list each agent once/);
  const { safetyFloorPercent: _drop, ...missing } = good;
  assert.throws(() => parsePolicy(JSON.stringify(missing), "p.json"), /p\.json: safetyFloorPercent is required/);
  assert.throws(() => loadPolicy(join(tmpdir(), "no-such-routing-policy.json")), /cannot read the routing policy/);
});

test("the policy defaults to routing-policy.json beside the baseline, and --policy replaces it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-routing-")));
  try {
    const models = join(dir, "models.md");
    writeFileSync(models, "| Agent |\n");
    assert.equal(resolvePolicy({ models }).source, null, "no file beside the baseline means no policy");
    assert.equal(resolvePolicy({ models }).allow, null);
    writeFileSync(join(dir, "routing-policy.json"), readFileSync(POLICY_FILE, "utf8"));
    assert.equal(resolvePolicy({ models }).source, join(dir, "routing-policy.json"));
    const other = join(dir, "other.json");
    writeFileSync(other, JSON.stringify({ ...JSON.parse(readFileSync(POLICY_FILE, "utf8")), safetyFloorPercent: 25 }));
    assert.equal(resolvePolicy({ models, policy: other }).safetyFloorPercent, 25);
    assert.throws(() => resolvePolicy({ models, policy: join(dir, "missing.json") }), /cannot read the routing policy/);
    assert.equal(resolvePolicy({ models: join(repoRoot, "docs", "agents", "models.md") }).source, POLICY_FILE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. Burn pressure

test("5-hour windows are recognised by id and label", () => {
  for (const bucket of [B.claudeSession, B.gemini5h, B.codex5h, B.third5h]) assert.equal(isFiveHourBucket(bucket), true, bucket.id);
  for (const bucket of [B.claudeWeek, B.argon, B.cursorPlan, B.cursorAuto, B.geminiWeek, B.codexWeek, B.thirdWeek]) assert.equal(isFiveHourBucket(bucket), false, bucket.id);
});

test("pressure uses the binding non-5-hour window: percent left over days to reset", () => {
  const p = policy();
  // The 5-hour window has less left, but it never counts toward pressure.
  const u = usage("fresh", [
    { id: "codex-5h", label: "5h limit", usedPercent: 95, resetsAt: inDays(0.1) },
    { id: "codex-weekly", label: "Weekly limit", usedPercent: 40, resetsAt: inDays(4) },
  ]);
  const r = burnPressure(u, p, NOW);
  assert.equal(r.skip, null);
  assert.equal(r.pressure, 15);
  assert.equal(r.binding.bucketId, "codex-weekly");
  assert.equal(r.binding.bucket, "Weekly limit");
  assert.equal(r.binding.percentLeft, 60);
  assert.equal(r.binding.daysToReset, 4);
  assert.equal(r.binding.resetsAt, inDays(4));

  // Cursor: the Plan window has less left than Cursor Models, so it binds.
  const cursor = burnPressure(liveUsage()["cursor/auto"], p, NOW);
  assert.equal(cursor.binding.bucketId, "included_total");
  assert.equal(cursor.binding.bucket, "Plan");
  assert.ok(Math.abs(cursor.pressure - 3.31) < 0.01, String(cursor.pressure));

  // A reset already passed counts as 0.05 days, not zero or negative.
  const due = burnPressure(usage("fresh", [{ id: "w", label: "Weekly", usedPercent: 50, resetsAt: inDays(-1) }]), p, NOW);
  assert.equal(due.pressure, 1000);
  assert.equal(due.binding.daysToReset, 0.05);
});

test("a binding window under the safety floor skips the candidate and names the window", () => {
  const r = burnPressure(usage("low", [{ id: "codex-weekly", label: "Weekly limit", usedPercent: 92.5, resetsAt: inDays(3) }]), policy(), NOW);
  assert.equal(r.pressure, null);
  assert.match(r.skip, /Weekly limit has 7\.5% left, under the 10% safety floor/);
  // Exactly at the floor is not under it.
  assert.equal(burnPressure(usage("low", [{ id: "w", label: "Weekly", usedPercent: 90, resetsAt: inDays(5) }]), policy(), NOW).skip, null);
  // A 5-hour window under the floor does not skip.
  assert.equal(burnPressure(usage("low", [{ id: "x-5h", label: "5h limit", usedPercent: 99, resetsAt: inDays(0.1) }, { id: "w", label: "Weekly", usedPercent: 10, resetsAt: inDays(5) }]), policy(), NOW).skip, null);
});

test("expiringBoost multiplies pressure only within 48 hours of reset with more than 20% left", () => {
  const boosted = { ...policy(), expiringBoost: 2 };
  const at = (usedPercent: number, days: number) => burnPressure(usage("fresh", [{ id: "w", label: "Weekly", usedPercent, resetsAt: inDays(days) }]), boosted, NOW);
  assert.equal(at(50, 1).pressure, 100);
  assert.equal(at(50, 1).binding.boost, 2);
  assert.equal(at(85, 1).pressure, 15, "20% or less left gets no boost");
  assert.equal(at(50, 3).pressure, 50 / 3 > 0 ? Math.round((50 / 3) * 100) / 100 : 0, "more than 48 hours gets no boost");
  assert.equal(at(50, 3).binding.boost, 1);
  // The repository default of 1.0 has no effect.
  assert.equal(burnPressure(usage("fresh", [{ id: "w", label: "Weekly", usedPercent: 50, resetsAt: inDays(1) }]), policy(), NOW).pressure, 50);
});

test("pressure is not computed for usage that does not confirm capacity", () => {
  for (const status of ["unknown", "stale", "unavailable"]) {
    const r = burnPressure(usage(status, [B.codexWeek]), policy(), NOW);
    assert.equal(r.pressure, null, status);
    assert.equal(r.skip, null, status);
    assert.match(r.reason, new RegExp(status));
  }
  assert.match(burnPressure(usage("fresh", [B.codex5h]), policy(), NOW).reason, /no non-5-hour window/);
});

test("ranking: highest pressure first, ties within 5% by the policy order, unknown pressure last in input order", () => {
  const rows = [
    { agent: "cursor", pressure: 10 },
    { agent: "codex", pressure: 9.7 },
    { agent: "antigravity", pressure: 5 },
    { agent: "claude", pressure: null },
    { agent: "other", pressure: 20 },
    { agent: "manual", pressure: null },
  ];
  assert.deepEqual(rankByPressure(rows, { order: ["antigravity", "codex", "cursor"] }).map((r: { agent: string }) => r.agent), ["other", "codex", "cursor", "antigravity", "claude", "manual"]);
  // 9.4 is more than 5% below 10, so it is not a tie.
  assert.deepEqual(rankByPressure([{ agent: "cursor", pressure: 10 }, { agent: "codex", pressure: 9.4 }], { order: ["antigravity", "codex", "cursor"] }).map((r: { agent: string }) => r.agent), ["cursor", "codex"]);
});

// --- 3. Chooser (live reading of 2026-10-31)

test("reasoning-heavy prefers antigravity/claude-opus-5-5-high and lists Claude Code as reserved, not dropped", async () => {
  const r = await choose("reasoning-heavy");
  assert.equal(r.status, "recommended");
  assert.equal(named(r.recommendation), "antigravity/claude-opus-5-5-high");
  assert.equal(r.recommendation.binding.bucket, "Claude and GPT models weekly");
  assert.ok(Math.abs(r.recommendation.pressure - 11.23) < 0.01, String(r.recommendation.pressure));
  assert.equal(r.recommendation.binding.percentLeft, 76.7);
  assert.equal(r.recommendation.binding.resetsAt, B.thirdWeek.resetsAt);
  assert.match(r.recommendation.reason, /burn pressure 11\.23%\/day on Claude and GPT models weekly \(76\.7% left, resets 2026-11-07T13:20:13\.000Z\)/);
  assert.doesNotMatch(r.recommendation.reason, /not balanced/);
  const claude = r.excluded.find((c: { agent: string; model: string }) => c.agent === "claude" && c.model === "claude-opus-5-5");
  assert.equal(claude.policy, "reserve");
  assert.match(claude.reason, /coordinator/);
  assert.ok(!r.rejected.some((c: { agent: string }) => c.agent === "claude"), "excluded rows are not rejections");
  assert.equal(r.policy.source, POLICY_FILE);
});

test("standard chooses the highest pressure and names the runner-up's pressure, bucket, percent and reset", async () => {
  const r = await choose("standard");
  // Live: agy Claude and GPT models (76.7% left over 6.8 days) outranks Codex weekly (35% over 3.7 days).
  assert.equal(named(r.recommendation), "antigravity/claude-sonnet-5-5-medium");
  assert.equal(named(r.alternatives[0]), "codex/gpt-6.1-terra/max");
  assert.match(r.recommendation.reason, /runner-up codex\/gpt-6\.1-terra\/max: burn pressure 9\.37%\/day on Weekly limit \(35(?:\.0)?% left, resets 2026-11-04T11:06:09\.000Z\)/);
  assert.deepEqual(
    r.alternatives.filter((c: { relation: string }) => c.relation === "equivalent").map(named),
    ["codex/gpt-6.1-terra/max", "cursor/composer-2.5", "cursor/auto"],
  );
  for (const alt of r.alternatives) assert.ok("pressure" in alt && "binding" in alt, named(alt) ?? undefined);
  assert.equal(r.baselineRecommendation.agent, "antigravity");
});

test("standard prefers Codex while its weekly bucket has headroom and resets soonest", async () => {
  const r = await choose("standard", {}, liveUsage({ thirdWeek: { usedPercent: 60 } }));
  assert.equal(named(r.recommendation), "codex/gpt-6.1-terra/max");
});

test("mechanical prefers antigravity Gemini Flash and lists Argon as reserved", async () => {
  const r = await choose("mechanical");
  assert.equal(named(r.recommendation), "antigravity/gemini-3.8-flash-high");
  const argon = r.excluded.find((c: { model: string }) => c.model === "gemini-4-argon-high");
  assert.equal(argon.policy, "reserve");
});

test("ties within 5% go by the policy order", async () => {
  // Codex weekly at 41.85% left over 3.7369 days is 11.20/day, within 5% of agy's 11.23.
  const r = await choose("standard", {}, liveUsage({ codexWeek: { usedPercent: 58.15 } }));
  assert.equal(named(r.recommendation), "antigravity/claude-sonnet-5-5-medium");
  const reordered = await choose("standard", { policy: { ...policy(), order: ["codex", "antigravity", "cursor"] } }, liveUsage({ codexWeek: { usedPercent: 58.15 } }));
  assert.equal(named(reordered.recommendation), "codex/gpt-6.1-terra/max");
});

test("a candidate under the safety floor is rejected with a reason that names the window", async () => {
  const r = await choose("standard", {}, liveUsage({ thirdWeek: { usedPercent: 95 } }, { "antigravity/claude-sonnet-5-5-medium": "low", "antigravity/claude-opus-5-5-high": "low" }));
  assert.equal(named(r.recommendation), "codex/gpt-6.1-terra/max");
  const floor = r.rejected.find((c: { model: string }) => c.model === "claude-sonnet-5-5-medium");
  assert.equal(floor.rejectionKind, "safety-floor");
  assert.match(floor.reason, /Claude and GPT models weekly has 5% left, under the 10% safety floor/);
});

test("capability is a hard filter: never lower, higher only with a warning when the required tier has nothing available", async () => {
  const noStandard = liveUsage({}, { "codex/gpt-6.1-terra": "exhausted", "cursor/auto": "exhausted", "cursor/composer-2.5": "exhausted", "antigravity/claude-sonnet-5-5-medium": "exhausted" });
  const up = await choose("standard", {}, noStandard);
  assert.equal(named(up.recommendation), "antigravity/claude-opus-5-5-high");
  assert.match(up.decision.warning, /no available allowed candidate at standard; antigravity\/claude-opus-5-5-high is reasoning-heavy/);

  const noDeep = await choose("reasoning-heavy", {}, liveUsage({}, { "antigravity/claude-opus-5-5-high": "exhausted" }));
  assert.equal(noDeep.status, "no-suitable-candidate");
  assert.equal(noDeep.recommendation, null);
});

test("a candidate outside the allow list is excluded with the policy reason", async () => {
  const candidates = [...CANDIDATES, row("cursor", "gpt-9-other", null, "standard")];
  const r = await choose("standard", {}, liveUsage(), candidates);
  const other = r.excluded.find((c: { model: string }) => c.model === "gpt-9-other");
  assert.equal(other.policy, "not-allowed");
  assert.match(other.reason, /not in the routing policy allow list/);
});

test("an override still works and records that it deviates from the policy", async () => {
  const r = await choose("reasoning-heavy", { override: { agent: "claude", model: "claude-opus-5-5", effort: "high" }, overrideReason: "owner asked" });
  assert.equal(r.status, "overridden");
  assert.match(r.decision.policyDeviation, /claude\/claude-opus-5-5\/high is reserved: .*coordinator/);
  assert.match(r.decision.warning, /deviates from the routing policy/);
  assert.match(modelChoiceSection(r), /^- Policy: deviates from the routing policy: claude\/claude-opus-5-5\/high is reserved/m);

  const within = await choose("standard", { override: { agent: "codex", model: "gpt-6.1-terra", effort: "max" }, overrideReason: "codex knows it" });
  assert.equal(within.decision.policyDeviation, null);
  assert.doesNotMatch(modelChoiceSection(within), /^- Policy:/m);
});

// --- 4. Reviewer pool

test("--review-of picks a reviewer on a different agent and bucket than the implementer", async () => {
  assert.deepEqual(parseRecommendArgs(["--task", "t", "--summary", "x", "--review-of", "antigravity/claude-sonnet-5-5-medium"]).options.reviewOf, { agent: "antigravity", model: "claude-sonnet-5-5-medium", effort: null });
  assert.match(parseRecommendArgs(["--task", "t", "--summary", "x", "--review-of", "nope"]).error, /--review-of/);

  const r = await choose("standard", { reviewOf: { agent: "antigravity", model: "claude-sonnet-5-5-medium", effort: null } });
  assert.equal(named(r.recommendation), "codex/gpt-6.1-terra/max");
  const same = r.excluded.find((c: { model: string }) => c.model === "claude-sonnet-5-5-medium");
  assert.equal(same.policy, "reviewer-pool");
  assert.match(same.reason, /different pool from the implementer antigravity\/claude-sonnet-5-5-medium/);
  assert.ok(r.excluded.some((c: { model: string; policy: string }) => c.model === "gemini-3.8-flash-high" && c.policy === "reviewer-pool"), "the same agent is excluded even on another bucket");

  const off = await choose("standard", { reviewOf: { agent: "antigravity", model: "claude-sonnet-5-5-medium", effort: null }, policy: { ...policy(), reviewerOnDifferentPool: false } });
  assert.equal(named(off.recommendation), "antigravity/claude-sonnet-5-5-medium");
});

// --- Planner

function wave(spec: Record<string, unknown>) {
  return parseWave(JSON.stringify(spec));
}
const plan = (w: ReturnType<typeof parseWave>, extra: Record<string, unknown> = {}, usageByCandidate = liveUsage()): Promise<any> =>
  withoutKey(() => planWave({ wave: w, candidates: CANDIDATES, usageByAgent: {}, usageByCandidate, learningOptions: { learning: false, now: NOW }, policy: policy(), now: NOW, ...extra }));

test("the planner reads --policy and --workers, and a wave task may name reviewOf", () => {
  const parsed = parsePlanArgs(["--wave", "w.json", "--policy", "p.json", "--workers", "workers.json"]);
  assert.equal(parsed.options.policy, "p.json");
  assert.equal(parsed.options.workers, "workers.json");
  const w = wave({ tasks: [{ id: "r", summary: "Review", reviewOf: "codex/gpt-6.1-terra" }] });
  assert.deepEqual(w.tasks[0].reviewOf, { agent: "codex", model: "gpt-6.1-terra", effort: null });
  assert.throws(() => wave({ tasks: [{ id: "r", summary: "Review", reviewOf: "codex" }] }), /tasks\[0\]\.reviewOf must be <agent>\/<model>/);
});

test("the planner caps total concurrency at the policy's maxConcurrentTotal", async () => {
  const tasks = ["a", "b", "c", "d"].map((id) => ({ id, summary: id, judgment: "mechanical", judgmentReason: "docs" }));
  const p = await plan(wave({ concurrency: 5, tasks }), { policy: { ...policy(), maxConcurrentPerBucket: 9 } });
  assert.equal(p.concurrency.limit, 3);
  assert.equal(p.concurrency.requested, 5);
  assert.equal(p.concurrency.proposed, 3);
});

test("the planner chooses by pressure and reports it in each assignment", async () => {
  const p = await plan(wave({ tasks: [{ id: "std", summary: "Standard", judgment: "standard", judgmentReason: "clear" }] }));
  const [t] = p.tasks;
  assert.equal(t.status, "proposed");
  assert.equal(named(t.assignment), "antigravity/claude-sonnet-5-5-medium");
  assert.ok(Math.abs(t.assignment.pressure - 11.23) < 0.01);
  assert.equal(t.assignment.binding.bucket, "Claude and GPT models weekly");
  assert.match(t.assignment.reason, /burn pressure 11\.23%\/day/);
  assert.match(t.assignment.reason, /runner-up codex\/gpt-6\.1-terra\/max/);
  assert.ok(t.excluded.some((c: { agent: string }) => c.agent === "claude"));
  assert.equal(p.policy.source, POLICY_FILE);
});

test("active workers count against the per-bucket cap, so the next pick moves to another bucket", async () => {
  const activeWorkers = [
    { agent: "antigravity", model: "claude-opus-5-5-high", dispatchId: "ctx_a" },
    { agent: "antigravity", model: "claude-opus-5-5-high", dispatchId: "ctx_b" },
  ];
  const p = await plan(wave({ concurrency: 5, activeWorkers, tasks: [{ id: "std", summary: "Standard", judgment: "standard", judgmentReason: "clear" }] }), { policy: { ...policy(), maxConcurrentTotal: 5 } });
  const [t] = p.tasks;
  assert.equal(named(t.assignment), "codex/gpt-6.1-terra/max", "agy sonnet shares the Claude and GPT models bucket with the two active workers");
  assert.ok(p.bucketLoad["antigravity/3p-weekly"].count >= 2);
});

test("proposed workers count against the per-bucket cap within one wave", async () => {
  const tasks = ["a", "b", "c"].map((id) => ({ id, summary: id, judgment: "mechanical", judgmentReason: "docs" }));
  const p = await plan(wave({ concurrency: 3, tasks }));
  const picks = p.tasks.map((t: { assignment?: { agent: string; model: string }; status: string; warning?: string | null; reason?: string }) => ({
    status: t.status,
    pick: named(t.assignment ?? null),
    warning: t.warning,
  }));
  assert.equal(picks.filter((row: { pick: string | null }) => row.pick === "antigravity/gemini-3.8-flash-high").length, 2, JSON.stringify(picks));
  // Third mechanical task upgrades to a stronger uncapped tier instead of delaying on the capped flash bucket.
  const third = picks.find((row: { pick: string | null }) => row.pick !== "antigravity/gemini-3.8-flash-high");
  assert.equal(third?.status, "proposed");
  assert.ok(third?.pick, JSON.stringify(picks));
  assert.notEqual(third?.pick, "antigravity/gemini-3.8-flash-high");
});

test("a wave reviewer task runs on a different pool from its implementer", async () => {
  const p = await plan(wave({ tasks: [{ id: "rev", summary: "Review", judgment: "standard", judgmentReason: "clear", kind: "review", reviewOf: "antigravity/claude-sonnet-5-5-medium" }] }));
  assert.equal(named(p.tasks[0].assignment), "codex/gpt-6.1-terra/max");
});

test("active workers are read from an orca worker-list receipt", () => {
  // tests/fixtures/routing/worker-list.json is a real `orca orchestration worker-list --json` receipt with identifiers replaced.
  const text = readFileSync(join(repoRoot, "tests", "fixtures", "routing", "worker-list.json"), "utf8");
  assert.deepEqual(activeWorkersFromWorkerList(text), [
    { agent: "codex", model: "gpt-6.1-terra", effort: null, dispatchId: "ctx_test1", task: "task_test1" },
    { agent: "antigravity", model: null, effort: null, dispatchId: "ctx_test2", task: "task_test2" },
  ]);
  assert.throws(() => activeWorkersFromWorkerList("{}"), /worker-list/);
});

test("without a policy every baseline row stays allowed", () => {
  assert.equal(NO_POLICY.allow, null);
  assert.equal(policyVerdict(NO_POLICY, { agent: "claude", model: "claude-opus-5-5" }), null);
});

// --- CLI

function run(script: string, args: string[], cwd: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [join(repoRoot, "scripts", script), ...args], {
      cwd,
      env: { ...process.env, TYPESAFE_API_KEY: "", ORCA_USAGE_STATE_DIR: join(cwd, "usage-state"), HOME: join(cwd, "home") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

const MANUAL_BASELINE = `# Verified Subagent Models

| Agent  | Model ID          | Supported effort values | Capability | Suits  | Last verified |
| ------ | ----------------- | ----------------------- | ---------- | ------ | ------------- |
| manual | \`hand-picked\`   | none                    | standard   | Manual | 2026-10-31    |
| manual | \`held-back\`     | none                    | standard   | Manual | 2026-10-31    |
`;

test("the recommender CLI applies --policy and refuses a broken policy with a clear error", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-routing-cli-")));
  try {
    mkdirSync(join(dir, "home"));
    writeFileSync(join(dir, "models.md"), MANUAL_BASELINE);
    const policyFile = join(dir, "custom-policy.json");
    writeFileSync(
      policyFile,
      JSON.stringify({ ...JSON.parse(readFileSync(POLICY_FILE, "utf8")), allow: [{ agent: "manual", models: ["hand-*"] }], reserve: [{ agent: "manual", models: ["held-back"], reason: "kept for the owner" }] }),
    );
    const args = ["--task", "t", "--summary", "x", "--judgment", "standard", "--judgment-reason", "r", "--no-learning", "--models", join(dir, "models.md")];
    const ok = await run("orca-recommend.mjs", [...args, "--policy", policyFile], dir);
    assert.equal(ok.status, 0, ok.stderr);
    const json = JSON.parse(ok.stdout);
    assert.equal(named(json.recommendation), "manual/hand-picked");
    assert.deepEqual(json.excluded.map((c: { model: string; policy: string; reason: string }) => [c.model, c.policy, c.reason]), [["held-back", "reserve", "kept for the owner"]]);
    assert.equal(json.policy.source, policyFile);

    const none = await run("orca-recommend.mjs", args, dir);
    assert.equal(JSON.parse(none.stdout).policy.source, null, "no routing-policy.json beside this baseline");

    writeFileSync(policyFile, "{ broken");
    const broken = await run("orca-recommend.mjs", [...args, "--policy", policyFile], dir);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /custom-policy\.json: .*not valid JSON/);

    writeFileSync(join(dir, "wave.json"), JSON.stringify({ tasks: [{ id: "1", summary: "x", judgment: "standard", judgmentReason: "r" }] }));
    const planBroken = await run("orca-plan.mjs", ["--wave", join(dir, "wave.json"), "--models", join(dir, "models.md"), "--policy", policyFile, "--no-learning"], dir);
    assert.equal(planBroken.status, 1);
    assert.match(planBroken.stderr, /custom-policy\.json: .*not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Docs

test("the routing policy is documented field by field and linked from the dispatch docs", () => {
  const doc = readFileSync(join(repoRoot, "docs", "agents", "routing-policy.md"), "utf8");
  for (const field of Object.keys(JSON.parse(readFileSync(POLICY_FILE, "utf8")))) assert.match(doc, new RegExp("`" + field + "`"), field);
  assert.match(doc, /2026-10-31/);
  assert.match(doc, /How to change/i);
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.equal(agents.split("\n").filter((l) => l.includes("docs/agents/routing-policy.md")).length, 1);
  assert.match(readFileSync(join(repoRoot, "docs", "agents", "models.md"), "utf8"), /docs\/agents\/routing-policy\.md/);
  assert.match(readFileSync(join(repoRoot, "docs", "agents", "wave-planner.md"), "utf8"), /--policy/);
});

// --- Review findings (ctx_81b4675c47c4)

test("expectedShareFor reads the listed share and falls back to maxBucketSharePerWorkerPercent", () => {
  const p = policy();
  assert.equal(expectedShareFor(p, { agent: "antigravity", model: "claude-opus-5-5-high" }), 35);
  assert.equal(expectedShareFor(p, { agent: "antigravity", model: "claude-sonnet-5-5-medium" }), 12);
  assert.equal(expectedShareFor(p, { agent: "codex", model: "gpt-6.1-terra" }), 10);
  assert.equal(expectedShareFor(p, { agent: "cursor", model: "auto" }), 3);
  assert.equal(expectedShareFor(p, { agent: "cursor", model: "composer-2.5" }), 25, "unlisted models use the default share");
  assert.equal(expectedShareFor({ ...p, maxBucketSharePerWorkerPercent: 8 }, { agent: "cursor", model: "composer-2.5" }), 8);
});

test("expectedShareSkip refuses when percentLeft minus share would fall under the safety floor", () => {
  const p = policy();
  // 30% left with listed 10% share → 20% remaining >= 10% floor → allowed.
  const tight = usage("fresh", [{ id: "codex-weekly", label: "Weekly limit", usedPercent: 70, resetsAt: inDays(4) }]);
  assert.equal(expectedShareSkip(tight, p, { agent: "codex", model: "gpt-6.1-terra" }, NOW), null);
  // Unlisted model uses 25% default: 30 - 25 = 5 < 10.
  assert.match(
    expectedShareSkip(tight, p, { agent: "codex", model: "unlisted-terra" }, NOW)!,
    /Weekly limit has 30% left; expected share 25% would leave 5%, under the 10% safety floor/,
  );
  // 19% left, share 10% → 9% < 10.
  const justUnder = usage("fresh", [{ id: "w", label: "Weekly", usedPercent: 81, resetsAt: inDays(4) }]);
  assert.match(expectedShareSkip(justUnder, p, { agent: "codex", model: "gpt-6.1-terra" }, NOW)!, /would leave 9%, under the 10%/);
  // Exactly at the floor after share is allowed (20 - 10 = 10).
  const atFloor = usage("fresh", [{ id: "w", label: "Weekly", usedPercent: 80, resetsAt: inDays(4) }]);
  assert.equal(expectedShareSkip(atFloor, p, { agent: "codex", model: "gpt-6.1-terra" }, NOW), null);
});

test("a recommender expected-share refuse names the window and leaves a safer candidate", async () => {
  // Opus share 35%: with 40% left, 40-35=5 < 10 floor → refuse Opus; Sonnet share 12% still fits.
  const u = liveUsage({ thirdWeek: { usedPercent: 60 } });
  const r = await choose("reasoning-heavy", {}, u);
  assert.equal(r.status, "no-suitable-candidate");
  const opus = r.rejected.find((c: { model: string }) => c.model === "claude-opus-5-5-high");
  assert.equal(opus.rejectionKind, "expected-share");
  assert.match(opus.reason, /expected share 35% would leave 5%, under the 10% safety floor/);

  const std = await choose("standard", {}, u);
  assert.ok(!std.rejected.some((c: { model: string; rejectionKind?: string }) => c.model === "claude-sonnet-5-5-medium" && c.rejectionKind === "expected-share"));
  assert.ok(["antigravity/claude-sonnet-5-5-medium", "codex/gpt-6.1-terra/max", "cursor/auto", "cursor/composer-2.5"].includes(named(std.recommendation) ?? ""));
});

test("a fresh five-hour-only reading is subject to the safety floor and expected-share checks", () => {
  const p = policy();
  const under = usage("fresh", [{ id: "codex-5h", label: "5h limit", usedPercent: 95, resetsAt: inDays(0.1) }]);
  const floor = burnPressure(under, p, NOW);
  assert.equal(floor.pressure, null, "5-hour windows do not score burn pressure");
  assert.match(floor.skip!, /5h limit has 5% left, under the 10% safety floor/);
  assert.equal(floor.binding?.bucketId, "codex-5h");

  const share = expectedShareSkip(
    usage("fresh", [{ id: "codex-5h", label: "5h limit", usedPercent: 80, resetsAt: inDays(0.1) }]),
    p,
    { agent: "codex", model: "unlisted-terra" },
    NOW,
  );
  assert.match(share!, /expected share 25% would leave -5%, under the 10% safety floor|expected share 25% would leave/);
});

test("fresh five-hour-only capacity does not enter usable when under the floor", async () => {
  const only5h = {
    "codex/gpt-6.1-terra": usage("fresh", [{ id: "codex-5h", label: "5h limit", usedPercent: 96, resetsAt: inDays(0.1) }]),
    "cursor/auto": usage("fresh", [B.cursorPlan, B.cursorAuto]),
    "cursor/composer-2.5": usage("fresh", [B.cursorPlan, B.cursorAuto]),
    "antigravity/claude-sonnet-5-5-medium": usage("exhausted", [B.thirdWeek, B.third5h]),
    "antigravity/claude-opus-5-5-high": usage("exhausted", [B.thirdWeek, B.third5h]),
    "antigravity/gemini-3.8-flash-high": usage("exhausted", [B.geminiWeek, B.gemini5h]),
  };
  const r = await choose("standard", {}, only5h);
  assert.match(named(r.recommendation) ?? "", /^cursor\//);
  const codex = r.rejected.find((c: { model: string }) => c.model === "gpt-6.1-terra");
  assert.equal(codex.rejectionKind, "safety-floor");
});

test("model-less and unknown-bucket active workers count toward the real bucket cap", () => {
  const p = policy();
  const u = liveUsage();
  const activeWorkers = [
    { agent: "antigravity", model: "claude-opus-5-5-high" },
    { agent: "antigravity", model: null },
  ];
  const load = countBucketLoad({ activeWorkers, usageByCandidate: u, policy: p, now: NOW });
  assert.equal(bindingBucketIdFor({ agent: "antigravity", model: null }, u, p, NOW), "antigravity/unknown");
  assert.equal(load["antigravity/unknown"].count, 1);
  assert.equal(load["antigravity/3p-weekly"].count, 1);
  // Cap check for the real bucket must include the ambiguous worker.
  assert.equal(effectiveBucketLoad(load, "antigravity/3p-weekly", "antigravity"), 2);
  // Unknown-bucket candidates must also count every known same-agent worker.
  assert.equal(effectiveBucketLoad(load, "antigravity/unknown", "antigravity"), 2);
});

test("a model-less active worker blocks another launch on the same agent's binding bucket", async () => {
  const activeWorkers = [
    { agent: "antigravity", model: "claude-opus-5-5-high", dispatchId: "ctx_a" },
    { agent: "antigravity", model: null, dispatchId: "ctx_b" },
  ];
  const p = await plan(
    wave({ concurrency: 5, activeWorkers, tasks: [{ id: "std", summary: "Standard", judgment: "standard", judgmentReason: "clear" }] }),
    { policy: { ...policy(), maxConcurrentTotal: 5 } },
  );
  assert.equal(named(p.tasks[0].assignment), "codex/gpt-6.1-terra/max");
});

test("rankByPressure tie-breaking is transitive inside the 5% band", () => {
  const order = { order: ["antigravity", "codex", "cursor"] };
  // Pairwise: 100~96 and 96~92, but 100 is not within 5% of 92. Sort must not put 92 above 100.
  const rows = [
    { agent: "cursor", pressure: 92 },
    { agent: "codex", pressure: 96 },
    { agent: "antigravity", pressure: 100 },
  ];
  assert.deepEqual(
    rankByPressure(rows, order).map((r: { agent: string; pressure: number }) => `${r.agent}:${r.pressure}`),
    ["antigravity:100", "codex:96", "cursor:92"],
  );
  // Contiguous band: 100, 97, 95 are one band (each within 5% of the band max 100) → policy order.
  assert.deepEqual(
    rankByPressure(
      [
        { agent: "cursor", pressure: 97 },
        { agent: "codex", pressure: 100 },
        { agent: "antigravity", pressure: 95 },
      ],
      order,
    ).map((r: { agent: string }) => r.agent),
    ["antigravity", "codex", "cursor"],
  );
});

test("stale or unknown lower-tier capacity does not block a confirmed stronger candidate", async () => {
  const u = liveUsage(
    {},
    {
      "antigravity/claude-sonnet-5-5-medium": "stale",
      "codex/gpt-6.1-terra": "unknown",
      "cursor/auto": "stale",
      "cursor/composer-2.5": "unknown",
    },
  );
  const r = await choose("standard", {}, u);
  assert.equal(named(r.recommendation), "antigravity/claude-opus-5-5-high");
  assert.match(r.decision.warning, /no available allowed candidate at standard; antigravity\/claude-opus-5-5-high is reasoning-heavy/);
});

test("an override that bypasses the floor, share, or reviewer rule records a policy deviation", async () => {
  const underFloor = liveUsage({ thirdWeek: { usedPercent: 95 } }, { "antigravity/claude-opus-5-5-high": "low" });
  const floor = await choose("reasoning-heavy", {
    override: { agent: "antigravity", model: "claude-opus-5-5-high", effort: null },
    overrideReason: "force opus",
  }, underFloor);
  assert.equal(floor.status, "overridden");
  assert.match(floor.decision.policyDeviation, /safety floor/i);
  assert.match(floor.decision.warning, /deviates from the routing policy/);

  const share = await choose("reasoning-heavy", {
    override: { agent: "antigravity", model: "claude-opus-5-5-high", effort: null },
    overrideReason: "force opus",
  }, liveUsage({ thirdWeek: { usedPercent: 60 } }));
  assert.match(share.decision.policyDeviation, /expected share/i);

  const review = await choose("standard", {
    override: { agent: "antigravity", model: "claude-sonnet-5-5-medium", effort: null },
    overrideReason: "same pool",
    reviewOf: { agent: "antigravity", model: "claude-opus-5-5-high", effort: null },
  });
  assert.match(review.decision.policyDeviation, /reviewer|different pool/i);
});

test("worker-list parsing merges paginated receipts and refuses an incomplete first page", () => {
  const base = JSON.parse(readFileSync(join(repoRoot, "tests", "fixtures", "routing", "worker-list.json"), "utf8"));
  const page1 = {
    ...base,
    result: {
      ...base.result,
      workers: [base.result.workers[0]],
      page: { limit: 1, total: 2, hasMore: true, nextCursor: "cursor-page-2" },
    },
  };
  const page2 = {
    ...base,
    cursor: "cursor-page-2",
    result: {
      ...base.result,
      workers: [base.result.workers[1]],
      page: { limit: 1, total: 2, hasMore: false, nextCursor: null },
    },
  };
  assert.throws(() => activeWorkersFromWorkerList(JSON.stringify(page1)), /hasMore|incomplete|page/i);
  assert.deepEqual(activeWorkersFromWorkerList(JSON.stringify([page1, page2])), [
    { agent: "codex", model: "gpt-6.1-terra", effort: null, dispatchId: "ctx_test1", task: "task_test1" },
    { agent: "antigravity", model: null, effort: null, dispatchId: "ctx_test2", task: "task_test2" },
  ]);
  assert.deepEqual(activeWorkersFromWorkerList(JSON.stringify({ pages: [page1, page2] })), [
    { agent: "codex", model: "gpt-6.1-terra", effort: null, dispatchId: "ctx_test1", task: "task_test1" },
    { agent: "antigravity", model: null, effort: null, dispatchId: "ctx_test2", task: "task_test2" },
  ]);
});

test("when the required tier is bucket-capped the planner tries an eligible stronger tier", async () => {
  const activeWorkers = [
    { agent: "antigravity", model: "claude-sonnet-5-5-medium", dispatchId: "ctx_a" },
    { agent: "antigravity", model: "claude-sonnet-5-5-medium", dispatchId: "ctx_b" },
    { agent: "codex", model: "gpt-6.1-terra", dispatchId: "ctx_c" },
    { agent: "codex", model: "gpt-6.1-terra", dispatchId: "ctx_d" },
    { agent: "cursor", model: "auto", dispatchId: "ctx_e" },
    { agent: "cursor", model: "composer-2.5", dispatchId: "ctx_f" },
  ];
  // All standard-tier buckets are at cap 2; Opus (reasoning-heavy) still has room on the same 3p-weekly?
  // Sonnet and Opus share 3p-weekly, so Opus is also capped. Use a policy that puts Opus on a distinct allow with room.
  // Simpler: exhaust/cap standard agents via active load, leave Opus uncapped by using maxConcurrentPerBucket:1 on
  // standard buckets only — instead, mark cursor/codex exhausted and fill agy sonnet bucket, while Opus is allowed
  // as upgrade when standard is capped. Cap sonnet's bucket with 2 sonnet workers; Opus shares that bucket though.
  // Use separate buckets: make standard candidates all cursor/codex capped, Opus on antigravity with room.
  const u = liveUsage({}, { "codex/gpt-6.1-terra": "exhausted", "cursor/auto": "exhausted", "cursor/composer-2.5": "exhausted" });
  // Two active sonnets fill the 3p-weekly cap; Opus shares it — so also capped. Change approach:
  // mechanical requirement with flash capped, and a standard/reasoning available as stronger.
  const mechActive = [
    { agent: "antigravity", model: "gemini-3.8-flash-high", dispatchId: "ctx_1" },
    { agent: "antigravity", model: "gemini-3.8-flash-high", dispatchId: "ctx_2" },
  ];
  const p = await plan(
    wave({
      concurrency: 5,
      activeWorkers: mechActive,
      tasks: [{ id: "m", summary: "Mech", judgment: "mechanical", judgmentReason: "docs" }],
    }),
    { policy: { ...policy(), maxConcurrentTotal: 5 } },
    liveUsage(),
  );
  // Flash bucket capped → should upgrade to a standard/reasoning allowed candidate rather than delay.
  assert.equal(p.tasks[0].status, "proposed");
  assert.notEqual(named(p.tasks[0].assignment), "antigravity/gemini-3.8-flash-high");
  assert.match(p.tasks[0].warning ?? p.tasks[0].assignment.reason, /mechanical|standard|reasoning|no available|capability|burn pressure/i);
});

test("below-capability alternatives must still pass the safety floor and expected-share guards", async () => {
  // Reasoning-heavy with Opus exhausted; Sonnet (below-capability) under the floor must not be offered.
  const u = liveUsage({ thirdWeek: { usedPercent: 95 } }, { "antigravity/claude-opus-5-5-high": "exhausted", "antigravity/claude-sonnet-5-5-medium": "low" });
  const p = await plan(
    wave({ tasks: [{ id: "deep", summary: "Deep", judgment: "reasoning-heavy", judgmentReason: "hard" }] }),
    {},
    u,
  );
  const row = p.tasks[0];
  assert.ok(row.status === "delay" || row.status === "needs-decision");
  if (row.weakerAlternative) {
    assert.notEqual(named(row.weakerAlternative), "antigravity/claude-sonnet-5-5-medium");
  }
});

test("wave reassignment recalculates the pick reason and keeps the upgrade warning", async () => {
  const activeWorkers = [
    { agent: "antigravity", model: "claude-opus-5-5-high", dispatchId: "ctx_a" },
    { agent: "antigravity", model: "claude-opus-5-5-high", dispatchId: "ctx_b" },
  ];
  const p = await plan(
    wave({ concurrency: 5, activeWorkers, tasks: [{ id: "std", summary: "Standard", judgment: "standard", judgmentReason: "clear" }] }),
    { policy: { ...policy(), maxConcurrentTotal: 5 } },
  );
  const t = p.tasks[0];
  assert.equal(named(t.assignment), "codex/gpt-6.1-terra/max");
  // Must describe the actual pick (Codex), not the recommender's original agy Sonnet reason alone.
  assert.match(t.assignment.reason, /codex\/gpt-6\.1-terra/);
  assert.doesNotMatch(t.assignment.reason, /Wave pick antigravity\/claude-sonnet-5-5-medium|antigravity\/claude-sonnet-5-5-medium is the smallest/);
});

// --- Round-2 review findings

test("providerless active workers still count toward total and unknown-bucket concurrency", () => {
  const base = JSON.parse(readFileSync(join(repoRoot, "tests", "fixtures", "routing", "worker-list.json"), "utf8"));
  const providerless = {
    ...base.result.workers[0],
    dispatchId: "ctx_providerless",
    taskId: "task_providerless",
    workerState: "ready",
    dispatchStatus: "dispatched",
    resource: { ...base.result.workers[0].resource, ownershipState: "owned", releaseState: "not_requested" },
    projection: {
      ...base.result.workers[0].projection,
      dispatchId: "ctx_providerless",
      taskId: "task_providerless",
      provider: null,
      stage: { worker: "ready", dispatch: "dispatched", detail: "input_accepted", activity: "working" },
      outcome: "in_progress",
    },
  };
  const text = JSON.stringify({
    ...base,
    result: {
      ...base.result,
      workers: [base.result.workers[0], providerless, base.result.workers[2]],
      counts: { active: 2, reclaimable: 0, retained: 0, released: 1 },
    },
  });
  const active = activeWorkersFromWorkerList(text);
  assert.equal(active.length, 2);
  assert.ok(active.some((w: { dispatchId: string }) => w.dispatchId === "ctx_providerless"));
  const mystery = active.find((w: { dispatchId: string }) => w.dispatchId === "ctx_providerless");
  assert.equal(mystery.agent, "unknown");
  assert.equal(mystery.model, null);
  const load = countBucketLoad({ activeWorkers: active, usageByCandidate: liveUsage(), policy: policy(), now: NOW });
  assert.ok(load["unknown/unknown"]?.count >= 1);
});

test("providerless active workers count against every real agent bucket cap", () => {
  const p = policy();
  const u = liveUsage();
  // One known Sonnet plus one providerless worker must fill a cap of 2 on the Sonnet bucket.
  const activeWorkers = [
    { agent: "antigravity", model: "claude-sonnet-5-5-medium", dispatchId: "ctx_a" },
    { agent: "unknown", model: null, dispatchId: "ctx_providerless" },
  ];
  const load = countBucketLoad({ activeWorkers, usageByCandidate: u, policy: p, now: NOW });
  const sonnetKey = bindingBucketIdFor({ agent: "antigravity", model: "claude-sonnet-5-5-medium" }, u, p, NOW);
  assert.equal(sonnetKey, "antigravity/3p-weekly");
  assert.equal(load["antigravity/3p-weekly"]?.count, 1);
  assert.equal(load["unknown/unknown"]?.count, 1);
  assert.equal(effectiveBucketLoad(load, sonnetKey, "antigravity"), 2);
  assert.equal(effectiveBucketLoad(load, sonnetKey, "antigravity") < (p.maxConcurrentPerBucket ?? 2), false);
  // Same for an unrelated agent's bucket: providerless still consumes a slot there.
  const codexKey = bindingBucketIdFor({ agent: "codex", model: "gpt-6.1-terra" }, u, p, NOW);
  assert.equal(effectiveBucketLoad(load, codexKey, "codex"), 1);
});

test("an unknown-bucket candidate counts known same-agent load against the bucket cap", () => {
  const p = policy();
  const u = liveUsage();
  // Two known Sonnet workers fill the Claude/GPT weekly cap.
  const activeWorkers = [
    { agent: "antigravity", model: "claude-sonnet-5-5-medium", dispatchId: "ctx_a" },
    { agent: "antigravity", model: "claude-sonnet-5-5-medium", dispatchId: "ctx_b" },
  ];
  const load = countBucketLoad({ activeWorkers, usageByCandidate: u, policy: p, now: NOW });
  assert.equal(load["antigravity/3p-weekly"].count, 2);
  // Opus with no usage reading maps to antigravity/unknown — must still see the two Sonnets.
  const unknownKey = bindingBucketIdFor({ agent: "antigravity", model: "claude-opus-5-5-high" }, {}, p, NOW);
  assert.equal(unknownKey, "antigravity/unknown");
  assert.equal(effectiveBucketLoad(load, unknownKey, "antigravity"), 2);
  assert.equal(effectiveBucketLoad(load, unknownKey, "antigravity") < (p.maxConcurrentPerBucket ?? 2), false);
});

test("paginated worker-list receipts refuse a missing middle page", () => {
  const base = JSON.parse(readFileSync(join(repoRoot, "tests", "fixtures", "routing", "worker-list.json"), "utf8"));
  const mk = (workers: unknown[], page: Record<string, unknown>, cursor?: string | null) => ({
    ...base,
    ...(cursor !== undefined ? { cursor } : {}),
    result: { ...base.result, workers, page },
  });
  const page1 = mk([base.result.workers[0]], { limit: 1, total: 3, hasMore: true, nextCursor: "cursor-page-2" });
  const page3 = mk([base.result.workers[1]], { limit: 1, total: 3, hasMore: false, nextCursor: null }, "cursor-page-3");
  // First+last without the middle page: raw worker count 2 !== total 3, and cursor chain breaks.
  assert.throws(() => activeWorkersFromWorkerList(JSON.stringify([page1, page3])), /gap|missing|page|total|incomplete|cursor/i);
  const page2 = mk(
    [{ ...base.result.workers[2], workerState: "ready", dispatchStatus: "dispatched", resource: { ...base.result.workers[2].resource, ownershipState: "owned" }, projection: { ...base.result.workers[2].projection, provider: { id: "cursor", model: "auto" }, stage: { worker: "ready", dispatch: "dispatched" }, outcome: "in_progress" } }],
    { limit: 1, total: 3, hasMore: true, nextCursor: "cursor-page-3" },
    "cursor-page-2",
  );
  const page3ok = mk([base.result.workers[1]], { limit: 1, total: 3, hasMore: false, nextCursor: null }, "cursor-page-3");
  assert.equal(activeWorkersFromWorkerList(JSON.stringify([page1, page2, page3ok])).length, 3);
});

test("paginated worker-list receipts refuse broken cursor continuity and repeated pages", () => {
  const base = JSON.parse(readFileSync(join(repoRoot, "tests", "fixtures", "routing", "worker-list.json"), "utf8"));
  const mk = (workers: unknown[], page: Record<string, unknown>, cursor?: string | null) => ({
    ...base,
    ...(cursor !== undefined ? { cursor } : {}),
    result: { ...base.result, workers, page },
  });
  const page1 = mk([base.result.workers[0]], { limit: 1, total: 3, hasMore: true, nextCursor: "cursor-page-2" });
  // Page stamped with the wrong request cursor (skipped middle).
  const wrongCursor = mk([base.result.workers[1]], { limit: 1, total: 3, hasMore: false, nextCursor: null }, "cursor-page-3");
  assert.throws(() => activeWorkersFromWorkerList(JSON.stringify([page1, wrongCursor])), /cursor|continuit/i);
  // Repeated first page: same nextCursor chain would under-count after dedup if continuity were ignored.
  const repeat = mk([base.result.workers[0]], { limit: 1, total: 2, hasMore: true, nextCursor: "cursor-page-2" }, "cursor-page-2");
  const last = mk([base.result.workers[1]], { limit: 1, total: 2, hasMore: false, nextCursor: null }, "cursor-page-2");
  assert.throws(() => activeWorkersFromWorkerList(JSON.stringify([page1, repeat, last])), /cursor|continuit|repeat|duplicate/i);
  // Missing cursor annotation on a follow-on page.
  const bare = mk([base.result.workers[1]], { limit: 1, total: 2, hasMore: false, nextCursor: null });
  assert.throws(() => activeWorkersFromWorkerList(JSON.stringify([page1, bare])), /cursor|continuit/i);
});

test("expectedShareSkip accounts for already-committed wave share", () => {
  const p = policy();
  // 50% left; Opus share 35% → first pick ok, second with 35% already committed is not.
  const half = usage("fresh", [{ ...B.thirdWeek, usedPercent: 50 }, B.third5h]);
  assert.equal(expectedShareSkip(half, p, { agent: "antigravity", model: "claude-opus-5-5-high" }, NOW), null);
  assert.match(
    expectedShareSkip(half, p, { agent: "antigravity", model: "claude-opus-5-5-high" }, NOW, { committedPercent: 35 })!,
    /under the 10% safety floor|expected share/,
  );
});

test("wave proposals accumulate expected share so a second pick cannot overdraw the bucket", async () => {
  // 50% left on Claude/GPT weekly; each Opus expects 35%. Two Opus proposals would leave -20%.
  const u = liveUsage(
    { thirdWeek: { usedPercent: 50 } },
    {
      "codex/gpt-6.1-terra": "exhausted",
      "cursor/auto": "exhausted",
      "cursor/composer-2.5": "exhausted",
      "antigravity/claude-sonnet-5-5-medium": "exhausted",
      "antigravity/gemini-3.8-flash-high": "exhausted",
    },
  );
  const p = await plan(
    wave({
      concurrency: 3,
      tasks: [
        { id: "a", summary: "A", judgment: "reasoning-heavy", judgmentReason: "hard" },
        { id: "b", summary: "B", judgment: "reasoning-heavy", judgmentReason: "hard" },
      ],
    }),
    { policy: { ...policy(), maxConcurrentTotal: 3, maxConcurrentPerBucket: 3 } },
    u,
  );
  const proposed = p.tasks.filter((t: { status: string }) => t.status === "proposed" || t.status === "needs-decision");
  const opus = proposed.filter((t: { assignment?: { model?: string } }) => t.assignment?.model === "claude-opus-5-5-high");
  assert.ok(
    opus.length <= 1,
    `expected at most one Opus proposal, got ${opus.length}: ${JSON.stringify(
      p.tasks.map((t: { status: string; assignment?: { agent: string; model: string; effort?: string | null } | null }) => ({
        status: t.status,
        assignment: named(t.assignment ?? null),
      })),
    )}`,
  );
  assert.ok(
    p.tasks.some((t: { status: string }) => t.status === "delay" || t.status === "deferred" || t.status === "needs-decision"),
    "second task should not silently propose another Opus over the share floor",
  );
});

test("uncertaintyAlternative must pass floor, expected-share and bucket-cap guards", async () => {
  // Suitable standard on Claude is unknown; weaker Codex has only 5% left — share 10% must refuse it.
  const u = liveUsage(
    { codexWeek: { usedPercent: 95 } },
    {
      "claude/claude-sonnet-5-5": "unknown",
      "antigravity/claude-sonnet-5-5-medium": "exhausted",
      "antigravity/claude-opus-5-5-high": "exhausted",
      "antigravity/gemini-3.8-flash-high": "exhausted",
      "cursor/auto": "exhausted",
      "cursor/composer-2.5": "exhausted",
    },
  );
  // Make claude allowed for this test by using a custom policy that allows it.
  const allowClaude = {
    ...policy(),
    allow: [...policy().allow, { agent: "claude", models: ["claude-sonnet-5-5"] }],
    reserve: policy().reserve.filter((r: { agent: string }) => r.agent !== "claude"),
  };
  const p: any = await withoutKey(() =>
    planWave({
      wave: wave({
        concurrency: 2,
        tasks: [
          {
            id: "std",
            summary: "Standard",
            judgment: "standard",
            judgmentReason: "clear",
            eligible: ["claude/claude-sonnet-5-5/medium", "codex/gpt-6.1-terra/max"],
          },
        ],
      }),
      candidates: CANDIDATES,
      usageByAgent: {},
      usageByCandidate: {
        ...u,
        "claude/claude-sonnet-5-5": { ...u["claude/claude-sonnet-5-5"], status: "unknown", capacityConfirmed: false },
        "codex/gpt-6.1-terra": usage("fresh", [{ ...B.codexWeek, usedPercent: 95 }, B.codex5h]),
      },
      learningOptions: { learning: false, now: NOW },
      policy: allowClaude,
      now: NOW,
    }),
  );
  const row = p.tasks[0];
  if (row.uncertaintyAlternative) {
    assert.notEqual(named(row.uncertaintyAlternative), "codex/gpt-6.1-terra/max");
  }
  // Codex with 5% left must appear in rejected/excluded share path when considered, not as a offered alt.
  assert.ok(!row.uncertaintyAlternative || named(row.uncertaintyAlternative) !== "codex/gpt-6.1-terra/max");
});

test("uncertainty path keeps upgrade warnings when the wave reassigns", async () => {
  const activeWorkers = [
    { agent: "antigravity", model: "gemini-3.8-flash-high", dispatchId: "ctx_1" },
    { agent: "antigravity", model: "gemini-3.8-flash-high", dispatchId: "ctx_2" },
  ];
  const p = await plan(
    wave({
      concurrency: 5,
      activeWorkers,
      tasks: [{ id: "m", summary: "Mech", judgment: "mechanical", judgmentReason: "docs" }],
    }),
    { policy: { ...policy(), maxConcurrentTotal: 5 } },
  );
  const t = p.tasks[0];
  assert.equal(t.status, "proposed");
  assert.notEqual(named(t.assignment), "antigravity/gemini-3.8-flash-high");
  assert.match(String(t.warning ?? t.assignment?.reason ?? ""), /mechanical|no available|capability|standard|reasoning/i);
});

test("capped-tier upgrades rank eligible stronger candidates by burn pressure", async () => {
  // Flash capped; among standard/reasoning upgrades, prefer highest pressure (agy Sonnet over low-pressure Cursor).
  const mechActive = [
    { agent: "antigravity", model: "gemini-3.8-flash-high", dispatchId: "ctx_1" },
    { agent: "antigravity", model: "gemini-3.8-flash-high", dispatchId: "ctx_2" },
  ];
  const u = liveUsage(
    {
      // Sonnet: high pressure (lots left, soon reset)
      thirdWeek: { usedPercent: 10, resetsAt: inDays(2) },
      // Cursor: lower pressure
      cursorAuto: { usedPercent: 80, resetsAt: inDays(20) },
      cursorPlan: { usedPercent: 80, resetsAt: inDays(20) },
      // Codex: mid
      codexWeek: { usedPercent: 50, resetsAt: inDays(5) },
    },
    {},
  );
  const p = await plan(
    wave({
      concurrency: 5,
      activeWorkers: mechActive,
      tasks: [{ id: "m", summary: "Mech", judgment: "mechanical", judgmentReason: "docs" }],
    }),
    { policy: { ...policy(), maxConcurrentTotal: 5 } },
    u,
  );
  assert.equal(p.tasks[0].status, "proposed");
  assert.equal(named(p.tasks[0].assignment), "antigravity/claude-sonnet-5-5-medium");
});

test("when a confirmed stronger upgrade is bucket-capped the unknown lower-tier remains offerable", async () => {
  // Standard (Codex) unknown; Opus confirmed but bucket already at cap → should not pure-delay; offer unknown Codex path.
  const activeWorkers = [
    { agent: "antigravity", model: "claude-opus-5-5-high", dispatchId: "ctx_a" },
    { agent: "antigravity", model: "claude-opus-5-5-high", dispatchId: "ctx_b" },
  ];
  const u = liveUsage(
    {},
    {
      "codex/gpt-6.1-terra": "unknown",
      "cursor/auto": "exhausted",
      "cursor/composer-2.5": "exhausted",
      "antigravity/claude-sonnet-5-5-medium": "exhausted",
      "antigravity/gemini-3.8-flash-high": "exhausted",
    },
  );
  const p = await plan(
    wave({
      concurrency: 5,
      activeWorkers,
      tasks: [{ id: "std", summary: "Standard", judgment: "standard", judgmentReason: "clear" }],
    }),
    { policy: { ...policy(), maxConcurrentTotal: 5 } },
    u,
  );
  const t = p.tasks[0];
  // Must not delay with nothing to offer: either propose/needs-decision on unknown Codex, or show it as uncertainty/weaker alt.
  assert.notEqual(t.status, "delay");
  const offered =
    named(t.assignment) === "codex/gpt-6.1-terra/max" ||
    named(t.uncertaintyAlternative) === "codex/gpt-6.1-terra/max" ||
    named(t.weakerAlternative) === "codex/gpt-6.1-terra/max";
  assert.ok(offered, JSON.stringify({ status: t.status, assignment: named(t.assignment ?? null), unc: named(t.uncertaintyAlternative ?? null), weak: named(t.weakerAlternative ?? null), reason: t.reason }));
});

test("learned adjustment is not undone by a later pressure re-sort", async () => {
  // Baseline pressure prefers Sonnet (high); learning prefers Codex. Selection and report must agree on Codex.
  const u = liveUsage({
    thirdWeek: { usedPercent: 5, resetsAt: inDays(1) },
    codexWeek: { usedPercent: 70, resetsAt: inDays(10) },
  });
  const learning = {
    enabled: true,
    resetAt: null,
    adjustments: [
      {
        key: "codex|gpt-6.1-terra|max|unknown|feature|standard",
        agent: "codex",
        model: "gpt-6.1-terra",
        effort: "max",
        agentVersion: "unknown",
        kind: "feature",
        difficulty: "standard",
        choice: "codex/gpt-6.1-terra/max",
        preference: 0.9,
        meanScore: 0.9,
        rawCount: 5,
        weightedCount: 5,
        sufficient: true,
        uncertain: false,
        evidence: [
          { id: "e1", outcome: "succeeded", completedAt: NOW, weight: 1, score: 1, selectionKind: "baseline" },
          { id: "e2", outcome: "succeeded", completedAt: NOW, weight: 1, score: 1, selectionKind: "baseline" },
          { id: "e3", outcome: "succeeded", completedAt: NOW, weight: 1, score: 1, selectionKind: "baseline" },
          { id: "e4", outcome: "succeeded", completedAt: NOW, weight: 1, score: 1, selectionKind: "baseline" },
          { id: "e5", outcome: "succeeded", completedAt: NOW, weight: 1, score: 1, selectionKind: "baseline" },
        ],
      },
    ],
    uncertain: [],
    evidence: [{ included: true }],
    rule: { minComparableCount: 3, minWeightedEvidence: 2, halfLifeDays: 30 },
    agentVersions: {},
  };
  const r = await choose("standard", { learning, kind: "feature", random: () => 0.99 }, u);
  assert.equal(named(r.recommendation), "codex/gpt-6.1-terra/max");
  assert.ok(r.learning.applied.length >= 1);
  assert.match(r.recommendation.reason, /Learned adjustment preferred codex\/gpt-6\.1-terra\/max/);
  assert.doesNotMatch(r.recommendation.reason, /preferred codex\/gpt-6\.1-terra\/max over baseline codex\/gpt-6\.1-terra\/max/);
  assert.notEqual(named(r.baselineRecommendation), named(r.recommendation));

  // Wave planner must keep the learned primary; re-sorting by pressure would flip back to Sonnet.
  const planned = await plan(
    wave({
      concurrency: 2,
      tasks: [{ id: "std", summary: "Standard", judgment: "standard", judgmentReason: "clear", kind: "feature" }],
    }),
    { learningOptions: { learning, kind: "feature", random: () => 0.99, now: NOW }, policy: { ...policy(), maxConcurrentTotal: 2 } },
    u,
  );
  assert.equal(named(planned.tasks[0].assignment), "codex/gpt-6.1-terra/max");
  assert.match(String(planned.tasks[0].assignment?.reason ?? ""), /Learned adjustment preferred codex\/gpt-6\.1-terra\/max/);
});

// --- Round-3 review findings

test("uncertaintyAlternative reserves the alternative's bucket and expected share", async () => {
  // Suitable standard Claude is unknown; weaker mechanical Flash is confirmed → uncertaintyAlternative.
  // Reserving the primary would leave Flash free; the alt's bucket/share must be held instead.
  const u = liveUsage(
    { geminiWeek: { usedPercent: 50 } },
    {
      "claude/claude-sonnet-5-5": "unknown",
      "antigravity/claude-sonnet-5-5-medium": "exhausted",
      "antigravity/claude-opus-5-5-high": "exhausted",
      "codex/gpt-6.1-terra": "exhausted",
      "cursor/auto": "exhausted",
      "cursor/composer-2.5": "exhausted",
    },
  );
  const allowClaude = {
    ...policy(),
    allow: [...policy().allow, { agent: "claude", models: ["claude-sonnet-5-5"] }],
    reserve: policy().reserve.filter((r: { agent: string }) => r.agent !== "claude"),
    expectedBucketSharePercent: [
      ...policy().expectedBucketSharePercent.filter(
        (r: { agent: string; model: string }) => !(r.agent === "antigravity" && r.model === "gemini-3.8-flash-high"),
      ),
      { agent: "antigravity", model: "gemini-3.8-flash-high", percent: 35 },
    ],
    maxConcurrentTotal: 3,
    maxConcurrentPerBucket: 2,
  };
  const usageByCandidate = {
    ...u,
    "claude/claude-sonnet-5-5": { ...u["claude/claude-sonnet-5-5"], status: "unknown", capacityConfirmed: false },
    "antigravity/gemini-3.8-flash-high": usage("fresh", [{ ...B.geminiWeek, usedPercent: 50 }, B.gemini5h]),
  };
  const p: any = await withoutKey(() =>
    planWave({
      wave: wave({
        concurrency: 3,
        tasks: [
          {
            id: "first",
            summary: "First",
            judgment: "standard",
            judgmentReason: "clear",
            eligible: ["claude/claude-sonnet-5-5/medium", "antigravity/gemini-3.8-flash-high"],
          },
          {
            id: "second",
            summary: "Second",
            judgment: "mechanical",
            judgmentReason: "docs",
            eligible: ["antigravity/gemini-3.8-flash-high"],
          },
        ],
      }),
      candidates: CANDIDATES,
      usageByAgent: {},
      usageByCandidate,
      learningOptions: { learning: false, now: NOW },
      policy: allowClaude,
      now: NOW,
    }),
  );
  const first = p.tasks.find((t: { task: string }) => t.task === "first");
  const second = p.tasks.find((t: { task: string }) => t.task === "second");
  assert.equal(first.status, "needs-decision");
  assert.ok(first.uncertaintyAlternative, "uncertainty branch must offer the weaker confirmed option");
  assert.equal(named(first.uncertaintyAlternative), "antigravity/gemini-3.8-flash-high");
  assert.equal(first.assignment?.agent, "claude");
  // Bucket load must follow the alternative (Flash), not the unknown primary.
  const flashKey = bindingBucketIdFor(
    { agent: "antigravity", model: "gemini-3.8-flash-high" },
    usageByCandidate,
    allowClaude,
    NOW,
  );
  assert.equal(flashKey, "antigravity/gemini-weekly");
  assert.ok(
    (p.bucketLoad?.[flashKey]?.count ?? 0) >= 1,
    `expected Flash bucket reserved after uncertaintyAlternative: ${JSON.stringify(p.bucketLoad)}`,
  );
  // 50% left, Flash share 35%: after first reserves 35%, second's 35% would leave -20% under the floor.
  assert.notEqual(named(second.assignment), "antigravity/gemini-3.8-flash-high");
  assert.ok(
    second.status === "delay" || second.status === "deferred" || second.status === "needs-decision",
    `second task must not propose another Flash over the reserved share: ${JSON.stringify({ status: second.status, assignment: named(second.assignment ?? null), reason: second.reason })}`,
  );
});

test("uncertaintyAlternative branch filters weaker options that fail share or floor guards", async () => {
  // Flash is mechanical (genuinely weaker than a standard task). Exercise floor and expected-share separately.
  const allowClaude = {
    ...policy(),
    allow: [...policy().allow, { agent: "claude", models: ["claude-sonnet-5-5"] }],
    reserve: policy().reserve.filter((r: { agent: string }) => r.agent !== "claude"),
    expectedBucketSharePercent: [
      ...policy().expectedBucketSharePercent.filter(
        (r: { agent: string; model: string }) => !(r.agent === "antigravity" && r.model === "gemini-3.8-flash-high"),
      ),
      { agent: "antigravity", model: "gemini-3.8-flash-high", percent: 35 },
    ],
  };
  const baseStatuses = {
    "claude/claude-sonnet-5-5": "unknown",
    "antigravity/claude-sonnet-5-5-medium": "exhausted",
    "antigravity/claude-opus-5-5-high": "exhausted",
    "codex/gpt-6.1-terra": "exhausted",
    "cursor/auto": "exhausted",
    "cursor/composer-2.5": "exhausted",
  } as const;
  const planOne = (flashUsage: ReturnType<typeof usage>) => {
    const u = liveUsage({}, baseStatuses);
    return withoutKey(() =>
      planWave({
        wave: wave({
          concurrency: 2,
          tasks: [
            {
              id: "std",
              summary: "Standard",
              judgment: "standard",
              judgmentReason: "clear",
              eligible: ["claude/claude-sonnet-5-5/medium", "antigravity/gemini-3.8-flash-high"],
            },
          ],
        }),
        candidates: CANDIDATES,
        usageByAgent: {},
        usageByCandidate: {
          ...u,
          "claude/claude-sonnet-5-5": { ...u["claude/claude-sonnet-5-5"], status: "unknown", capacityConfirmed: false },
          "antigravity/gemini-3.8-flash-high": flashUsage,
        },
        learningOptions: { learning: false, now: NOW },
        policy: allowClaude,
        now: NOW,
      }),
    );
  };

  // Floor failure: 5% left is under the 10% safety floor (burnPressure.skip).
  const floorFail: any = await planOne(usage("fresh", [{ ...B.geminiWeek, usedPercent: 95 }, B.gemini5h]));
  assert.equal(floorFail.tasks[0].assignment?.agent, "claude");
  assert.equal(floorFail.tasks[0].assignment?.capacityConfirmed, false);
  assert.equal(floorFail.tasks[0].uncertaintyAlternative, undefined);

  // Expected-share failure (floor itself passes): 40% left, Flash share 35% → 5% under the 10% floor.
  const shareFail: any = await planOne(usage("fresh", [{ ...B.geminiWeek, usedPercent: 60 }, B.gemini5h]));
  assert.equal(shareFail.tasks[0].assignment?.agent, "claude");
  assert.equal(shareFail.tasks[0].uncertaintyAlternative, undefined);
});

// --- Round-4 review findings

test("a single worker-list receipt with page.total greater than the worker count is refused", () => {
  const base = JSON.parse(readFileSync(join(repoRoot, "tests", "fixtures", "routing", "worker-list.json"), "utf8"));
  // total=2, one worker, hasMore=false — previously accepted and silently dropped the missing worker.
  const incomplete = {
    ...base,
    result: {
      ...base.result,
      workers: [base.result.workers[0]],
      page: { limit: 1, total: 2, hasMore: false, nextCursor: null },
    },
  };
  assert.throws(() => activeWorkersFromWorkerList(JSON.stringify(incomplete)), /total|incomplete|missing/i);
});

test("multi-page worker-list input without page metadata on every page is refused", () => {
  const base = JSON.parse(readFileSync(join(repoRoot, "tests", "fixtures", "routing", "worker-list.json"), "utf8"));
  const withMeta = {
    ...base,
    result: {
      ...base.result,
      workers: [base.result.workers[0]],
      page: { limit: 1, total: 2, hasMore: true, nextCursor: "cursor-page-2" },
    },
  };
  const withoutMeta = {
    ...base,
    cursor: "cursor-page-2",
    result: {
      ...base.result,
      workers: [base.result.workers[1]],
      // page metadata absent — previously accepted and skipped continuity checks.
    },
  };
  delete (withoutMeta.result as { page?: unknown }).page;
  assert.throws(() => activeWorkersFromWorkerList(JSON.stringify([withMeta, withoutMeta])), /page|metadata|incomplete|continuit/i);
  const bothBare = [
    { ...base, result: { ...base.result, workers: [base.result.workers[0]] } },
    { ...base, result: { ...base.result, workers: [base.result.workers[1]] } },
  ];
  for (const page of bothBare) delete (page.result as { page?: unknown }).page;
  assert.throws(() => activeWorkersFromWorkerList(JSON.stringify(bothBare)), /page|metadata|incomplete/i);
});

test("needs-decision reserves the unconfirmed primary so a later proposal cannot overdraw it", async () => {
  // Primary Claude unknown + Flash confirmed → needs-decision. Cap 1 per bucket: both buckets hold a slot.
  const u = liveUsage(
    {},
    {
      "claude/claude-sonnet-5-5": "unknown",
      "antigravity/claude-sonnet-5-5-medium": "exhausted",
      "antigravity/claude-opus-5-5-high": "exhausted",
      "codex/gpt-6.1-terra": "exhausted",
      "cursor/auto": "exhausted",
      "cursor/composer-2.5": "exhausted",
    },
  );
  const allowClaude = {
    ...policy(),
    allow: [...policy().allow, { agent: "claude", models: ["claude-sonnet-5-5"] }],
    reserve: policy().reserve.filter((r: { agent: string }) => r.agent !== "claude"),
    maxConcurrentTotal: 3,
    maxConcurrentPerBucket: 1,
  };
  const usageByCandidate = {
    ...u,
    "claude/claude-sonnet-5-5": { ...u["claude/claude-sonnet-5-5"], status: "unknown", capacityConfirmed: false },
    "antigravity/gemini-3.8-flash-high": usage("fresh", [{ ...B.geminiWeek, usedPercent: 20 }, B.gemini5h]),
  };
  const p: any = await withoutKey(() =>
    planWave({
      wave: wave({
        concurrency: 3,
        tasks: [
          {
            id: "first",
            summary: "First",
            judgment: "standard",
            judgmentReason: "clear",
            eligible: ["claude/claude-sonnet-5-5/medium", "antigravity/gemini-3.8-flash-high"],
          },
          {
            id: "second",
            summary: "Second",
            judgment: "standard",
            judgmentReason: "clear",
            eligible: ["claude/claude-sonnet-5-5/high"],
          },
        ],
      }),
      candidates: CANDIDATES,
      usageByAgent: {},
      usageByCandidate,
      learningOptions: { learning: false, now: NOW },
      policy: allowClaude,
      now: NOW,
    }),
  );
  const first = p.tasks.find((t: { task: string }) => t.task === "first");
  const second = p.tasks.find((t: { task: string }) => t.task === "second");
  assert.equal(first.status, "needs-decision");
  assert.equal(first.assignment?.agent, "claude");
  assert.ok(first.uncertaintyAlternative);
  const primaryKey = bindingBucketIdFor(
    { agent: "claude", model: "claude-sonnet-5-5" },
    usageByCandidate,
    allowClaude,
    NOW,
  );
  assert.ok(
    (p.bucketLoad?.[primaryKey!]?.count ?? 0) >= 1,
    `unconfirmed primary bucket must be reserved: ${JSON.stringify(p.bucketLoad)}`,
  );
  assert.notEqual(named(second.assignment), "claude/claude-sonnet-5-5/high");
  assert.ok(
    second.status === "delay" || second.status === "deferred" || second.status === "needs-decision",
    `second must not overdraw the reserved primary bucket: ${JSON.stringify({ status: second.status, assignment: named(second.assignment ?? null), reason: second.reason })}`,
  );
});

test("without a policy, underBucketCap does not block a weaker fallback", async () => {
  // Two active Flash workers would fill maxConcurrentPerBucket=2 on NO_POLICY, but with allow:null
  // bucket caps must not apply — a free global slot still gets the weaker alternative.
  const activeWorkers = [
    { agent: "antigravity", model: "gemini-3.8-flash-high", dispatchId: "ctx_a" },
    { agent: "antigravity", model: "gemini-3.8-flash-high", dispatchId: "ctx_b" },
  ];
  const u = liveUsage({}, { "antigravity/claude-opus-5-5-high": "exhausted", "claude/claude-opus-5-5": "exhausted" });
  const p: any = await withoutKey(() =>
    planWave({
      wave: wave({
        concurrency: 3,
        activeWorkers,
        tasks: [
          {
            id: "deep",
            summary: "Deep",
            judgment: "reasoning-heavy",
            judgmentReason: "hard",
            eligible: ["antigravity/claude-opus-5-5-high", "antigravity/gemini-3.8-flash-high"],
          },
        ],
      }),
      candidates: CANDIDATES,
      usageByAgent: {},
      usageByCandidate: u,
      learningOptions: { learning: false, now: NOW },
      policy: NO_POLICY,
      now: NOW,
    }),
  );
  const row = p.tasks[0];
  assert.equal(row.status, "needs-decision");
  assert.equal(named(row.weakerAlternative), "antigravity/gemini-3.8-flash-high");
});

test("below-capability rejected rows carry burn pressure so rankByPressure can order them", async () => {
  const r = await choose("reasoning-heavy");
  const below = (r.rejected ?? []).filter((c: { rejectionKind?: string }) => c.rejectionKind === "below-capability");
  assert.ok(below.length >= 2, `expected multiple below-capability rejects, got ${below.length}`);
  for (const row of below) {
    assert.equal(typeof row.pressure, "number", named(row) ?? undefined);
    assert.ok(row.binding, named(row) ?? undefined);
  }
  const ranked = rankByPressure(below, policy());
  assert.ok(ranked[0].pressure >= ranked[ranked.length - 1].pressure);
});

test("uncertaintyAlternative prefers the higher-pressure below-capability option", async () => {
  // Opus unknown; Sonnet exhausted; Cursor (low pressure) and Codex (high pressure) both confirmed weaker.
  // Without pressure on below-capability rows, baseline order kept Cursor; Codex must win by pressure.
  const u = liveUsage(
    {
      cursorAuto: { usedPercent: 70 },
      cursorPlan: { usedPercent: 70 },
      codexWeek: { usedPercent: 10 },
    },
    {
      "antigravity/claude-opus-5-5-high": "unknown",
      "antigravity/claude-sonnet-5-5-medium": "exhausted",
      "antigravity/gemini-3.8-flash-high": "exhausted",
      "cursor/composer-2.5": "exhausted",
      "claude/claude-opus-5-5": "exhausted",
      "claude/claude-sonnet-5-5": "exhausted",
    },
  );
  const usageByCandidate = {
    ...u,
    "antigravity/claude-opus-5-5-high": { ...u["antigravity/claude-opus-5-5-high"], status: "unknown", capacityConfirmed: false },
    "cursor/auto": usage("fresh", [
      { ...B.cursorAuto, usedPercent: 70 },
      { ...B.cursorPlan, usedPercent: 70 },
    ]),
    "codex/gpt-6.1-terra": usage("fresh", [{ ...B.codexWeek, usedPercent: 10 }, B.codex5h]),
  };
  const cursorBurn = burnPressure(usageByCandidate["cursor/auto"], policy(), NOW);
  const codexBurn = burnPressure(usageByCandidate["codex/gpt-6.1-terra"], policy(), NOW);
  assert.ok(
    (codexBurn.pressure ?? 0) > (cursorBurn.pressure ?? 0) + 1,
    `Codex pressure ${codexBurn.pressure} should beat Cursor ${cursorBurn.pressure}`,
  );
  const p: any = await withoutKey(() =>
    planWave({
      wave: wave({
        concurrency: 2,
        tasks: [
          {
            id: "deep",
            summary: "Deep",
            judgment: "reasoning-heavy",
            judgmentReason: "hard",
            eligible: ["antigravity/claude-opus-5-5-high", "cursor/auto", "codex/gpt-6.1-terra/max"],
          },
        ],
      }),
      candidates: CANDIDATES,
      usageByAgent: {},
      usageByCandidate,
      learningOptions: { learning: false, now: NOW },
      policy: policy(),
      now: NOW,
    }),
  );
  const row = p.tasks[0];
  assert.equal(row.status, "needs-decision");
  assert.equal(named(row.assignment), "antigravity/claude-opus-5-5-high");
  assert.equal(
    named(row.uncertaintyAlternative),
    "codex/gpt-6.1-terra/max",
    `expected higher-pressure Codex over Cursor: ${JSON.stringify({ alt: named(row.uncertaintyAlternative ?? null), reason: row.reason })}`,
  );
});
