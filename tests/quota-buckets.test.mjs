import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessCandidateUsage as assessAntigravityCandidate,
  assessAntigravityUsage,
} from "../scripts/antigravity-usage.mjs";
import {
  assessCandidateUsage as assessCursorCandidate,
  assessCursorUsage,
} from "../scripts/cursor-usage.mjs";
import { assessCandidateUsage as assessClaudeCandidate } from "../scripts/claude-usage.mjs";
import { assessCandidateUsage as assessCodexCandidate } from "../scripts/codex-usage.mjs";
import { modelChoiceSection, recommend } from "../scripts/orca-recommend.mjs";
import { planWave, parseWave } from "../scripts/orca-plan.mjs";
import { PROVIDERS } from "../scripts/orca-usage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-31T12:05:00.000Z");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(HERE, "fixtures", "quota-buckets", name), "utf8"));
}

function choice(value) {
  const [agent, model, effort = null] = value.split("/");
  return { agent, model, effort };
}

const AGY = loadFixture("antigravity-observation-2026-10-31.json");
const CURSOR = loadFixture("cursor-observation-2026-10-31.json");

const CANDIDATES = [
  { agent: "antigravity", model: "gemini-3.8-flash-high", effort: null, capability: "mechanical", suits: "flash" },
  { agent: "antigravity", model: "gemini-4-argon-high", effort: null, capability: "mechanical", suits: "argon" },
  { agent: "cursor", model: "auto", effort: null, capability: "standard", suits: "auto" },
  { agent: "cursor", model: "composer-2.5", effort: null, capability: "standard", suits: "composer" },
  { agent: "cursor", model: "claude-opus-5-5-high", effort: null, capability: "reasoning-heavy", suits: "named api" },
];

// output of agy models on 2026-10-31
const AGY_MODELS = [
  "gemini-4-argon-low",
  "gemini-4-argon-medium",
  "gemini-4-argon-high",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-high",
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-high",
  "gpt-oss-120b-medium",
];

test("every agy models id maps to a quota bucket; ids outside the list stay unknown", () => {
  assert.equal(AGY_MODELS.length, 13);
  for (const model of AGY_MODELS) {
    const assessed = assessAntigravityCandidate(AGY, { model }, NOW);
    assert.notEqual(assessed.status, "unknown", model);
    assert.ok(assessed.buckets.length > 0, model);
  }
  assert.equal(assessAntigravityCandidate(AGY, { model: "gpt-6.1-terra" }, NOW).status, "unknown");
  assert.equal(assessAntigravityCandidate(AGY, { model: "claude-fable-5-1" }, NOW).status, "unknown");
});

test("antigravity flash is fresh while Argon is low on the real 2026-10-31 reading", () => {
  const flash = assessAntigravityCandidate(AGY, { model: "gemini-3.8-flash-high" }, NOW);
  const argon = assessAntigravityCandidate(AGY, { model: "gemini-4-argon-high" }, NOW);
  assert.equal(flash.status, "fresh");
  assert.equal(flash.capacityConfirmed, true);
  assert.ok(flash.buckets.some((b) => b.id === "gemini-weekly"));
  assert.ok(!flash.buckets.some((b) => b.id === "gemini-argon-wtu-weekly"));
  assert.equal(argon.status, "low");
  assert.equal(argon.capacityConfirmed, true);
  assert.ok(argon.buckets.some((b) => b.id === "gemini-argon-wtu-weekly"));
  assert.ok(!argon.buckets.some((b) => b.id === "gemini-weekly"));
});

test("exhausted Gemini 5-hour window exhausts flash only (fabricated variant)", () => {
  const variant = structuredClone(AGY);
  const fiveHour = variant.windows.find((w) => w.id === "gemini-5h");
  fiveHour.remainingFraction = 0;
  fiveHour.usedPercent = 100;
  fiveHour.exhausted = true;
  variant.exhaustedWindows = ["gemini-5h"];
  variant.status = "limited";
  const flash = assessAntigravityCandidate(variant, { model: "gemini-3.8-flash-high" }, NOW);
  const argon = assessAntigravityCandidate(variant, { model: "gemini-4-argon-high" }, NOW);
  const opus = assessAntigravityCandidate(variant, { model: "claude-opus-5-5-high" }, NOW);
  assert.equal(flash.status, "exhausted");
  assert.match(flash.reason, /gemini-5h|Five Hour|5-hour|Five Hour Limit/i);
  assert.equal(argon.status, "low");
  assert.equal(opus.status, "fresh");
});

test("antigravity Argon exhaustion rejects Argon but not flash", () => {
  const exhausted = structuredClone(AGY);
  const argonWin = exhausted.windows.find((w) => w.id === "gemini-argon-wtu-weekly");
  argonWin.remainingFraction = 0;
  argonWin.usedPercent = 100;
  argonWin.exhausted = true;
  exhausted.exhaustedWindows = ["gemini-argon-wtu-weekly"];
  exhausted.status = "limited";

  const flash = assessAntigravityCandidate(exhausted, { model: "gemini-3.8-flash-high" }, NOW);
  const argon = assessAntigravityCandidate(exhausted, { model: "gemini-4-argon-high" }, NOW);
  assert.equal(flash.status, "fresh");
  assert.equal(argon.status, "exhausted");
  assert.match(argon.reason, /2026-11-06/);
});

test("cursor auto and composer-2.5 are fresh while Other Models is 100% used", () => {
  const auto = assessCursorCandidate(CURSOR, { model: "auto" }, NOW);
  const composer = assessCursorCandidate(CURSOR, { model: "composer-2.5" }, NOW);
  const named = assessCursorCandidate(CURSOR, { model: "claude-4-sonnet" }, NOW);
  assert.equal(auto.status, "fresh");
  assert.equal(auto.capacityConfirmed, true);
  assert.match(auto.reason, /Cursor Models .*25\.\d% used/);
  assert.ok(auto.buckets.some((b) => b.id === "included_auto" && b.label === "Cursor Models"));
  assert.equal(composer.status, "fresh");
  assert.equal(composer.capacityConfirmed, true);
  assert.equal(named.status, "exhausted");
  assert.match(named.reason, /Other Models/);
  assert.ok(named.buckets.some((b) => b.id === "included_api" && b.label === "Other Models"));

  const autoModels = CURSOR.windows.find((w) => w.id === "included_auto")?.applicableModels ?? [];
  assert.ok(autoModels.includes("auto"));
  assert.ok(autoModels.includes("composer-2.5"));
  assert.ok(autoModels.includes("composer-2.5-fast"));
  for (const model of ["auto", "default", "composer-2.5", "vega-high", "grok-4.7-high"]) {
    if (!autoModels.map((m) => m.toLowerCase()).includes(model.toLowerCase())) continue;
    const assessed = assessCursorCandidate(CURSOR, { model }, NOW);
    assert.equal(assessed.status, "fresh", model);
    assert.equal(assessed.capacityConfirmed, true, model);
  }
});

test("agent-level Cursor report follows Cursor Models when Other Models is exhausted", () => {
  const agent = assessCursorUsage(CURSOR, NOW);
  assert.equal(agent.status, "fresh");
  assert.equal(agent.capacityConfirmed, true);
  assert.match(agent.reason, /Cursor Models .*25\.\d% used/);
  assert.match(agent.reason, /Other Models exhausted/);
  assert.notEqual(agent.status, "unknown");
});

test("unrecognised models stay unknown, never available", () => {
  assert.equal(assessAntigravityCandidate(AGY, { model: "not-a-real-model" }, NOW).status, "unknown");
  assert.equal(assessCursorCandidate(CURSOR, { model: "???" }, NOW).status, "unknown");
  assert.equal(
    assessClaudeCandidate(
      { status: "available", windows: [], exhaustedWindows: [], observedAt: NOW.toISOString() },
      { model: "mystery" },
      NOW,
    ).status,
    "unknown",
  );
});

test("codex assessCandidateUsage applies the one bucket to every model", () => {
  const observation = {
    provider: "codex",
    status: "available",
    observedAt: "2026-10-31T12:00:00.000Z",
    windows: [
      {
        limitId: "codex",
        id: "codex-5h",
        label: "Codex 5h",
        usedPercent: 20,
        remainingPercent: 80,
        exhausted: false,
        resetsAt: "2026-10-31T17:00:00.000Z",
      },
    ],
    exhaustedWindows: [],
    raw: { rateLimitsByLimitId: { codex: { limitId: "codex", limitName: null, normalModelSlug: null } } },
  };
  const a = assessCodexCandidate(observation, { model: "gpt-6.1-terra" }, NOW);
  const b = assessCodexCandidate(observation, { model: "gpt-5-codex" }, NOW);
  assert.equal(a.status, "fresh");
  assert.equal(b.status, "fresh");
  assert.deepEqual(
    a.buckets.map((bucket) => bucket.id),
    b.buckets.map((bucket) => bucket.id),
  );
});

test("codex second limit id is model-specific; unmapped models stay unknown (fabricated)", () => {
  // Fabricated shape: not a live reading. A second limit declares normalModelSlug.
  const observation = {
    provider: "codex",
    status: "available",
    observedAt: "2026-10-31T12:00:00.000Z",
    windows: [
      {
        limitId: "codex",
        id: "codex-5h",
        label: "5h limit",
        usedPercent: 10,
        remainingPercent: 90,
        exhausted: false,
        resetsAt: "2026-10-31T17:00:00.000Z",
      },
      {
        limitId: "special-research",
        id: "special-research-5h",
        label: "Special research 5h",
        usedPercent: 100,
        remainingPercent: 0,
        exhausted: true,
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    exhaustedWindows: ["special-research-5h"],
    raw: {
      rateLimitsByLimitId: {
        codex: { limitId: "codex", limitName: null, normalModelSlug: null },
        "special-research": {
          limitId: "special-research",
          limitName: "Special research",
          normalModelSlug: "research-preview",
        },
      },
    },
  };
  const main = assessCodexCandidate(observation, { model: "gpt-6.1-terra" }, NOW);
  const special = assessCodexCandidate(observation, { model: "research-preview" }, NOW);
  const unknown = assessCodexCandidate(observation, { model: "mystery-slug" }, NOW);
  assert.equal(main.status, "fresh");
  assert.ok(main.buckets.every((b) => String(b.id).startsWith("codex")));
  assert.equal(special.status, "exhausted");
  assert.ok(special.buckets.some((b) => b.id === "special-research-5h"));
  assert.equal(unknown.status, "unknown");
});

test("claude Opus scoped exhaustion leaves Sonnet fresh (fabricated)", () => {
  const observation = {
    provider: "claude",
    status: "limited",
    observedAt: "2026-10-31T12:00:00.000Z",
    windows: [
      {
        kind: "session",
        group: "session",
        label: "Current session",
        appliesTo: "all",
        usedPercent: 41,
        resetsAt: "2026-10-31T17:00:00.000Z",
      },
      {
        kind: "weekly_all",
        group: "weekly",
        label: "Current week (all models)",
        appliesTo: "all",
        usedPercent: 84,
        resetsAt: "2026-11-04T16:00:00.000Z",
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        label: "Current week (Opus)",
        appliesTo: "scoped",
        scope: { model: "Opus", surface: null },
        usedPercent: 100,
        resetsAt: "2026-11-04T16:00:00.000Z",
      },
    ],
    exhaustedWindows: [
      {
        kind: "weekly_scoped",
        appliesTo: "scoped",
        scope: { model: "Opus", surface: null },
      },
    ],
  };
  const opus = assessClaudeCandidate(observation, { model: "claude-opus-5-5" }, NOW);
  const sonnet = assessClaudeCandidate(observation, { model: "claude-sonnet-5-5" }, NOW);
  assert.equal(opus.status, "exhausted");
  assert.equal(sonnet.status, "fresh");
  assert.equal(sonnet.capacityConfirmed, true);
});

test("recommendation reason names the bucket and percent; Argon low does not exhaust flash", async () => {
  const usageByAgent = {
    antigravity: {
      ...assessAntigravityUsage(AGY, NOW),
      account: "sha256:84f4d41978459895",
      host: "andi",
      source: { kind: "agy-test" },
      observedAt: AGY.observedAt,
    },
  };
  const usageByCandidate = {
    "antigravity/gemini-3.8-flash-high": {
      ...assessAntigravityCandidate(AGY, { model: "gemini-3.8-flash-high" }, NOW),
      account: "sha256:84f4d41978459895",
      host: "andi",
      source: { kind: "agy-test" },
      observedAt: AGY.observedAt,
    },
    "antigravity/gemini-4-argon-high": {
      ...assessAntigravityCandidate(AGY, { model: "gemini-4-argon-high" }, NOW),
      account: "sha256:84f4d41978459895",
      host: "andi",
      source: { kind: "agy-test" },
      observedAt: AGY.observedAt,
    },
  };
  const result = await recommend(
    {
      task: "quota-check",
      summary: "quota bucket check",
      judgment: "mechanical",
      judgmentReason: "quota check",
      eligible: [choice("antigravity/gemini-3.8-flash-high"), choice("antigravity/gemini-4-argon-high")],
      learning: false,
    },
    CANDIDATES.filter((c) => c.agent === "antigravity"),
    usageByAgent,
    usageByCandidate,
  );
  assert.equal(result.status, "recommended");
  assert.equal(result.recommendation.agent, "antigravity");
  assert.equal(result.recommendation.model, "gemini-3.8-flash-high");
  assert.equal(result.recommendation.usage, "fresh");
  assert.match(result.recommendation.reason, /antigravity\/gemini-3\.8-flash-high:.*Gemini Models.*8\.7% used/i);
  const argonAlt = result.alternatives.find((row) => row.model === "gemini-4-argon-high");
  assert.ok(argonAlt);
  assert.equal(argonAlt.usage, "low");
  assert.equal(result.rejected.filter((row) => row.model === "gemini-3.8-flash-high").length, 0);
});

test("exhausted Argon rejects only Argon; Cursor auto stays usable when Other Models is exhausted", async () => {
  const exhaustedAgy = structuredClone(AGY);
  const argonWin = exhaustedAgy.windows.find((w) => w.id === "gemini-argon-wtu-weekly");
  argonWin.remainingFraction = 0;
  argonWin.usedPercent = 100;
  argonWin.exhausted = true;
  exhaustedAgy.exhaustedWindows = ["gemini-argon-wtu-weekly"];
  exhaustedAgy.status = "limited";

  const usageByCandidate = {
    "antigravity/gemini-3.8-flash-high": {
      ...assessAntigravityCandidate(exhaustedAgy, { model: "gemini-3.8-flash-high" }, NOW),
      account: "sha256:84f4d41978459895",
      host: "andi",
      observedAt: exhaustedAgy.observedAt,
    },
    "antigravity/gemini-4-argon-high": {
      ...assessAntigravityCandidate(exhaustedAgy, { model: "gemini-4-argon-high" }, NOW),
      account: "sha256:84f4d41978459895",
      host: "andi",
      observedAt: exhaustedAgy.observedAt,
    },
    "cursor/auto": {
      ...assessCursorCandidate(CURSOR, { model: "auto" }, NOW),
      account: "sha256:2c339aff19d5eec2",
      host: "andi",
      observedAt: CURSOR.observedAt,
    },
    "cursor/claude-opus-5-5-high": {
      ...assessCursorCandidate(CURSOR, { model: "claude-4-sonnet" }, NOW),
      account: "sha256:2c339aff19d5eec2",
      host: "andi",
      observedAt: CURSOR.observedAt,
    },
  };
  const result = await recommend(
    {
      task: "quota-check",
      summary: "quota bucket check",
      judgment: "mechanical",
      judgmentReason: "quota check",
      eligible: [
        choice("antigravity/gemini-3.8-flash-high"),
        choice("antigravity/gemini-4-argon-high"),
        choice("cursor/auto"),
        choice("cursor/claude-opus-5-5-high"),
      ],
      learning: false,
    },
    CANDIDATES,
    {
      antigravity: { status: "low", capacityConfirmed: true, account: "sha256:84f4d41978459895", host: "andi" },
      cursor: { ...assessCursorUsage(CURSOR, NOW), account: "sha256:2c339aff19d5eec2", host: "andi" },
    },
    usageByCandidate,
  );
  assert.ok(result.rejected.some((row) => row.model === "gemini-4-argon-high" && row.usage === "exhausted"));
  assert.ok(!result.rejected.some((row) => row.model === "gemini-3.8-flash-high"));
  assert.ok(result.rejected.some((row) => row.model === "claude-opus-5-5-high" && row.usage === "exhausted"));
  assert.ok(
    result.recommendation?.model === "gemini-3.8-flash-high" ||
      result.alternatives?.some((row) => row.model === "auto" && row.usage === "fresh") ||
      result.recommendation?.model === "auto",
  );
});

test("planner shared-allowance report groups by bucket: Gemini models share, Argon does not", async () => {
  const usageByCandidate = {
    "antigravity/gemini-3.8-flash-high": {
      ...assessAntigravityCandidate(AGY, { model: "gemini-3.8-flash-high" }, NOW),
      account: "sha256:84f4d41978459895",
      host: "andi",
      source: { kind: "agy-test" },
      observedAt: AGY.observedAt,
      freshness: "fresh",
    },
    "antigravity/gemini-4-argon-high": {
      ...assessAntigravityCandidate(AGY, { model: "gemini-4-argon-high" }, NOW),
      account: "sha256:84f4d41978459895",
      host: "andi",
      source: { kind: "agy-test" },
      observedAt: AGY.observedAt,
      freshness: "fresh",
    },
  };
  const wave = parseWave(
    JSON.stringify({
      concurrency: 2,
      tasks: [
        {
          id: "flash-task",
          summary: "Flash work",
          judgment: "mechanical",
          judgmentReason: "docs",
          eligible: ["antigravity/gemini-3.8-flash-high"],
        },
        {
          id: "argon-task",
          summary: "Argon work",
          judgment: "mechanical",
          judgmentReason: "docs",
          eligible: ["antigravity/gemini-4-argon-high"],
        },
      ],
    }),
  );
  const plan = await planWave({
    wave,
    candidates: CANDIDATES.filter((c) => c.agent === "antigravity"),
    usageByAgent: {
      antigravity: {
        status: "low",
        capacityConfirmed: true,
        account: "sha256:84f4d41978459895",
        host: "andi",
        source: { kind: "agy-test" },
        observedAt: AGY.observedAt,
        freshness: "fresh",
        windows: AGY.windows,
      },
    },
    usageByCandidate,
    recommendFn: recommend,
  });
  assert.ok(plan.allowances.antigravity, "agent-level allowance remains");
  const byBucket = plan.allowancesByBucket ?? {};
  const geminiKey = Object.keys(byBucket).find((key) => key.includes("gemini-weekly"));
  const argonKey = Object.keys(byBucket).find((key) => key.includes("gemini-argon"));
  assert.ok(geminiKey, "Gemini Models bucket reported");
  assert.ok(argonKey, "Argon bucket reported");
  const geminiShared = byBucket[geminiKey].sharedWith.proposed.map((row) => row.task);
  const argonShared = byBucket[argonKey].sharedWith.proposed.map((row) => row.task);
  assert.ok(geminiShared.includes("flash-task"));
  assert.ok(!geminiShared.includes("argon-task"));
  assert.ok(argonShared.includes("argon-task"));
  assert.ok(!argonShared.includes("flash-task"));
});

test("recorded Model choice Usage line names the candidate bucket and percent", () => {
  const usage = {
    ...assessCursorCandidate(CURSOR, { model: "auto" }, NOW),
    account: "sha256:2c339aff19d5eec2",
    host: "andi",
    source: { kind: "cursor-dashboard-rpc" },
    observedAt: CURSOR.observedAt,
  };
  const section = modelChoiceSection({
    decision: {
      kind: "recommendation",
      agent: "cursor",
      model: "auto",
      effort: null,
      reason: "quota check",
      warning: null,
    },
    recommendation: { agent: "cursor", model: "auto", effort: null },
    assessment: { source: "coordinator", requirement: "standard", jev: { status: "unavailable", detail: "n/a" }, coordinator: { requirement: "standard", reason: "quota" } },
    fallback: null,
    usage,
  });
  assert.match(section, /^- Usage: fresh — Cursor Models 25\.\d% used \(account sha256:2c339aff19d5eec2, host andi; read .* from cursor-dashboard-rpc\)$/m);
});

test("PROVIDERS expose assessCandidate next to assess", () => {
  for (const provider of PROVIDERS) {
    assert.equal(typeof provider.assess, "function", provider.name);
    assert.equal(typeof provider.assessCandidate, "function", provider.name);
  }
});

test("provider assessCandidate matches usageReport candidate path", () => {
  const provider = PROVIDERS.find((row) => row.name === "antigravity");
  const flash = provider.assessCandidate(AGY, { model: "gemini-3.8-flash-high" }, NOW);
  assert.equal(flash.status, "fresh");
  assert.ok(flash.buckets.some((b) => b.id === "gemini-weekly"));
  const cursorProvider = PROVIDERS.find((row) => row.name === "cursor");
  const auto = cursorProvider.assessCandidate(CURSOR, { model: "auto" }, NOW);
  assert.equal(auto.status, "fresh");
  assert.match(auto.reason, /Cursor Models/);
});
