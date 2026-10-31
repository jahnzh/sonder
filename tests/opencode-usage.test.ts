import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model = "nris/Qwen3.8-27B";
const at = new Date("2026-11-01T12:00:00Z");
const expiresAt = "2026-11-07T00:00:00Z";
// Sampled from `opencode models` on 2026-10-31; these lines contain no account data.
const modelListing = "nris/Qwen3.8-27B\nopenai/gpt-4.1\n";
const baseline = `# Models\n\n| Agent | Model ID | Supported effort values | Capability | Suits | Last verified |\n| --- | --- | --- | --- | --- | --- |\n| opencode | \`nris/Qwen3.8-27B\` | none | mechanical | Small changes | 2026-10-31 |\n| codex | \`example\` | none | mechanical | Small changes | 2026-10-31 |\n`;

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sonder-opencode-"));
  const home = path.join(dir, "home");
  const configPath = path.join(home, ".config", "opencode", "opencode.jsonc");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `{
    // JSONC permits comments and trailing commas; URLs must survive comment stripping.
    "model": "${model}",
    "provider": { "nris": { "options": { "baseURL": "https://gateway.example.test/v1" }, "models": { "Qwen3.8-27B": {} }, }, },
  }`);
  return { dir, home, configPath, close: () => rmSync(dir, { recursive: true, force: true }) };
}

function executable(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${text}\n`);
  chmodSync(file, 0o755);
}

async function reader() {
  // @ts-expect-error The provider is implemented in JavaScript.
  return import("../scripts/opencode-usage.mjs");
}

function readOptions(configPath: string, extra: Record<string, unknown> = {}) {
  return { configPath, expiresAt, now: () => at, fetch: async () => ({ ok: true, status: 200 }), ...extra };
}

test("available gateway reports unlimited, model-scoped confirmed capacity without percentage windows", async () => {
  const f = sandbox();
  try {
    const { readOpencodeUsage, assessOpencodeUsage, assessCandidateUsage } = await reader();
    let checked = "";
    let cancelled = false;
    const observation = await readOpencodeUsage(readOptions(f.configPath, { fetch: async (url: string) => { checked = url; return { ok: true, status: 200, body: { cancel: async () => { cancelled = true; } } }; } }));
    assert.match(checked, /^https:\/\/gateway\.example\.test\/v1/);
    assert.equal(cancelled, true);
    assert.equal(observation.status, "available");
    assert.equal(observation.unlimited, true);
    assert.equal(observation.capacityConfirmed, true);
    assert.deepEqual(observation.bucket, { id: "opencode-nris", label: "NRIS gateway (no quota)" });
    assert.deepEqual(observation.windows, []);
    assert.equal(assessOpencodeUsage(observation, at).capacityConfirmed, true);
    const assessment = assessCandidateUsage(observation, { model }, at);
    assert.equal(assessment.status, "fresh");
    assert.equal(assessment.capacityConfirmed, true);
    assert.deepEqual(assessment.buckets, [{ id: "opencode-nris", label: "NRIS gateway (no quota)", usedPercent: null, resetsAt: null }]);
    assert.equal(assessCandidateUsage(observation, { model: "openai/gpt-4.1" }, at).status, "unknown");
    assert.equal(assessCandidateUsage(observation, { model: "nris/other" }, at).capacityConfirmed, false);
  } finally { f.close(); }
});

test("expiry, missing or invalid configuration, and a down gateway are unavailable", async () => {
  const f = sandbox();
  try {
    const { readOpencodeUsage, assessCandidateUsage } = await reader();
    let calls = 0;
    const expired = await readOpencodeUsage(readOptions(f.configPath, { now: () => new Date(expiresAt), fetch: async () => { calls++; } }));
    assert.equal(expired.status, "unavailable");
    assert.equal(expired.reason, "access expired");
    assert.equal(calls, 0);
    const invalid = await readOpencodeUsage(readOptions(f.configPath, { expiresAt: "invalid" }));
    assert.equal(invalid.status, "unavailable");
    const missing = await readOpencodeUsage(readOptions(path.join(f.dir, "missing")));
    assert.equal(missing.status, "unavailable");
    assert.match(missing.reason, /config/i);
    const down = await readOpencodeUsage(readOptions(f.configPath, { fetch: async () => { throw new Error("private details"); } }));
    assert.equal(down.status, "unavailable");
    assert.match(down.reason, /gateway/i);
    assert.doesNotMatch(JSON.stringify(down), /private details/);
    assert.equal(assessCandidateUsage(down, { model }, new Date(expiresAt)).reason, "access expired");
    const badHttp = await readOpencodeUsage(readOptions(f.configPath, { fetch: async () => ({ ok: false, status: 503 }) }));
    assert.equal(badHttp.status, "unavailable");
    assert.equal((await readOpencodeUsage(readOptions(f.configPath, { fetch: async () => ({ ok: false, status: 401 }) }))).status, "unavailable");
    writeFileSync(f.configPath, '{"model":"openai/gpt-4.1","provider":{}}');
    assert.match((await readOpencodeUsage(readOptions(f.configPath))).reason, /default model/i);
    writeFileSync(f.configPath, "{ invalid");
    const malformed = await readOpencodeUsage(readOptions(f.configPath));
    assert.equal(malformed.status, "unavailable");
    const old = await readOpencodeUsage(readOptions(sandboxConfig(f.dir), {}));
    assert.equal(assessCandidateUsage(old, { model }, new Date(expiresAt)).status, "unavailable");
    assert.equal(assessCandidateUsage(old, { model }, new Date(at.getTime() + 31 * 60_000)).status, "stale");
  } finally { f.close(); }
});

test("the probe keeps configuration secrets and gateway errors out of observations", async () => {
  const f = sandbox();
  try {
    const { readOpencodeUsage } = await reader();
    const secret = randomBytes(24).toString("hex");
    writeFileSync(f.configPath, JSON.stringify({ model, provider: { nris: { options: { baseURL: "https://gateway.example.test/v1", apiKey: secret }, models: { "Qwen3.8-27B": {} } } } }));
    let authorized = false;
    const observation = await readOpencodeUsage(readOptions(f.configPath, { fetch: async (_url: string, options: any) => {
      authorized = options.headers.Authorization === `Bearer ${secret}`;
      throw new Error(secret);
    } }));
    assert.ok(authorized);
    assert.equal(observation.status, "unavailable");
    assert.ok(!JSON.stringify(observation).includes(secret));
    assert.ok(!JSON.stringify(observation).includes("gateway.example.test"));
  } finally { f.close(); }
});

test("configured expiry from the environment is enforced before contacting the gateway", async () => {
  const f = sandbox();
  const old = process.env.ORCA_OPENCODE_EXPIRES_AT;
  try {
    const { DEFAULT_EXPIRY, readOpencodeUsage } = await reader();
    let calls = 0;
    delete process.env.ORCA_OPENCODE_EXPIRES_AT;
    assert.equal(DEFAULT_EXPIRY, expiresAt);
    const defaultExpired = await readOpencodeUsage({ configPath: f.configPath, now: () => new Date(expiresAt), fetch: async () => { calls++; return { ok: true }; } });
    assert.equal(defaultExpired.reason, "access expired");
    process.env.ORCA_OPENCODE_EXPIRES_AT = "2026-11-01T00:00:00Z";
    const observation = await readOpencodeUsage({ configPath: f.configPath, now: () => at, fetch: async () => { calls++; return { ok: true }; } });
    assert.equal(observation.status, "unavailable");
    assert.equal(observation.reason, "access expired");
    assert.equal(calls, 0);
  } finally {
    if (old === undefined) delete process.env.ORCA_OPENCODE_EXPIRES_AT;
    else process.env.ORCA_OPENCODE_EXPIRES_AT = old;
    f.close();
  }
});

function sandboxConfig(dir: string) {
  const file = path.join(dir, "other.jsonc");
  writeFileSync(file, `{"model":"${model}","provider":{"nris":{"options":{"baseURL":"https://gateway.example.test/v1"},"models":{"Qwen3.8-27B":{}}}}}`);
  return file;
}

test("collector stores unlimited readings and immediately replaces capacity after a failed refresh", async () => {
  const f = sandbox();
  try {
    const { readOpencodeUsage, assessOpencodeUsage, assessCandidateUsage } = await reader();
    // @ts-expect-error Collector exports are plain JavaScript.
    const { UsageStore, collectOnce, usageReport, usageForPlanning, PROVIDERS } = await import("../scripts/orca-usage.mjs");
    assert.ok(PROVIDERS.some((p: any) => p.name === "opencode" && typeof p.assessCandidate === "function"));
    let down = false;
    const provider = { name: "opencode", assess: assessOpencodeUsage, assessCandidate: assessCandidateUsage, read: () => readOpencodeUsage(readOptions(f.configPath, { fetch: async () => down ? { ok: false, status: 503 } : { ok: true, status: 200 } })) };
    const clock = { now: () => at };
    const store = new UsageStore(path.join(f.dir, "state"));
    try {
      const first = await collectOnce({ store, provider, clock, origin: "test" });
      assert.equal(first.usable, true);
      assert.equal(usageReport(store, provider, at, { model }).capacityConfirmed, true);
      down = true;
      const second = await collectOnce({ store, provider, clock, origin: "test" });
      assert.equal(second.usable, false);
      assert.equal(usageReport(store, provider, at, { model }).status, "unavailable");
    } finally { store.close(); }
    down = false;
    const planning = await usageForPlanning({ stateDir: path.join(f.dir, "planning"), providers: [provider], clock, candidates: [{ agent: "opencode", model }] });
    assert.equal(planning.opencode.status, "fresh");
    assert.equal(planning.usageByCandidate[`opencode/${model}`].capacityConfirmed, true);
    down = true;
    const failed = await usageForPlanning({ stateDir: path.join(f.dir, "planning"), providers: [provider], clock, candidates: [{ agent: "opencode", model }] });
    assert.equal(failed.usageByCandidate[`opencode/${model}`].status, "unavailable");
  } finally { f.close(); }
});

test("model-scoped IDs work in the baseline, recommendation and wave eligibility; outages skip the gateway", async () => {
  const f = sandbox();
  const original = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    // @ts-expect-error Recommender exports are plain JavaScript.
    const { loadCandidates, parseCliArgs, recommend } = await import("../scripts/orca-recommend.mjs");
    // @ts-expect-error Planner exports are plain JavaScript.
    const { parseWave, planWave } = await import("../scripts/orca-plan.mjs");
    const file = path.join(f.dir, "models.md");
    writeFileSync(file, baseline);
    const candidates = loadCandidates(file);
    assert.equal(candidates[0].model, model);
    assert.equal(candidates[0].unusable, null);
    const unsafeBaseline = path.join(f.dir, "unsafe-models.md");
    writeFileSync(unsafeBaseline, baseline.replace("| codex |", "| opencode | `openai/gpt-4.1` | none | mechanical | Built in | 2026-10-31 |\n| codex |"));
    assert.match(loadCandidates(unsafeBaseline).find((c: any) => c.model === "openai/gpt-4.1").unusable, /supported OpenCode model/);
    const parsed = parseCliArgs(["--task", "1", "--summary", "small change", "--eligible", `opencode/${model}`]);
    assert.deepEqual(parsed.options.eligible, [{ agent: "opencode", model, effort: null }]);
    const wave = parseWave(JSON.stringify({ tasks: [{ id: "1", summary: "small change", eligible: [`opencode/${model}`], judgment: "mechanical", judgmentReason: "small" }] }));
    assert.equal(wave.tasks[0].eligible[0].model, model);
    const available = { status: "fresh", capacityConfirmed: true, buckets: [{ id: "opencode-nris", label: "NRIS gateway (no quota)", usedPercent: null, resetsAt: null }] };
    const choiceUsage = { [`opencode/${model}`]: available, "codex/example": { status: "fresh", capacityConfirmed: true } };
    const options = { task: "1", summary: "small change", eligible: [], judgment: "mechanical", judgmentReason: "small", learning: false };
    const recommendation = await recommend(options, candidates, { opencode: available }, choiceUsage);
    assert.equal(recommendation.recommendation.model, model);
    assert.equal(recommendation.usage.capacityConfirmed, true);
    const plan = await planWave({ wave, candidates, usageByAgent: { opencode: available }, usageByCandidate: choiceUsage, learningOptions: { learning: false } });
    assert.equal(plan.tasks[0].assignment.model, model);
    assert.equal(plan.tasks[0].assignment.capacityConfirmed, true);
    const failedUsage = { ...choiceUsage, [`opencode/${model}`]: { status: "unavailable", reason: "gateway unreachable", capacityConfirmed: false } };
    const fallback = await recommend(options, candidates, {}, failedUsage);
    assert.equal(fallback.recommendation.agent, "codex");
    const failedPlan = await planWave({ wave, candidates, usageByAgent: {}, usageByCandidate: failedUsage, learningOptions: { learning: false } });
    assert.notEqual(failedPlan.tasks[0]?.assignment?.agent, "opencode");
  } finally { if (original === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = original; f.close(); }
});

test("spawn validates JSONC default and omits model from the worker-start command", () => {
  const f = sandbox();
  try {
    const scripts = path.join(f.dir, "scripts");
    mkdirSync(scripts);
    copyFileSync(path.join(root, "scripts", "orca-spawn.sh"), path.join(scripts, "orca-spawn.sh"));
    // The config helper is part of the program under test, copied into the temporary repository.
    if (existsSync(path.join(root, "scripts", "opencode-config.mjs"))) copyFileSync(path.join(root, "scripts", "opencode-config.mjs"), path.join(scripts, "opencode-config.mjs"));
    executable(path.join(scripts, "orca-preflight.sh"), "exit 0");
    const orca = path.join(f.dir, "orca");
    executable(orca, 'printf "%s\\n" "$@" > "$ARGV_LOG"\ncat "$RECEIPT_FILE"');
    const spec = path.join(f.dir, "spec.md");
    const receipt = path.join(f.dir, "receipt.json");
    const log = path.join(f.dir, "argv.log");
    writeFileSync(spec, "# Work\n");
    // The nested result/launch/effects shape was captured by the existing spawn wrapper tests.
    const worktree = path.join(f.dir, "worker");
    writeFileSync(receipt, JSON.stringify({ ok: true, result: { dispatchId: "ctx_test", launch: { effective: {} }, effects: [{ kind: "worktree", id: `repo::${worktree}` }] } }));
    const run = () => spawnSync("bash", [path.join(scripts, "orca-spawn.sh"), "--spec-file", spec, "--name", "work", "--base", "main", "--agent", "opencode", "--model", model, "--effort", "ignored"], { cwd: f.dir, encoding: "utf8", env: { ...process.env, HOME: f.home, ORCA_CLI_COMMAND: orca, ORCA_HISTORY_AUTO: "0", ARGV_LOG: log, RECEIPT_FILE: receipt, ORCA_SPAWN_WORKSPACES: path.join(f.dir, "workspaces") } });
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.doesNotMatch(readFileSync(log, "utf8"), /--model/);
    assert.doesNotMatch(readFileSync(log, "utf8"), /--effort/);
    assert.match(readFileSync(log, "utf8"), /Verified OpenCode launch default: nris\/Qwen3\.8-27B/);
    assert.match(success.stdout, /default.*model|model.*default/i);
    assert.ok(success.stderr.includes(`worktree ${worktree} not found`));
    rmSync(log);
    writeFileSync(f.configPath, '{"model":"openai/gpt-4.1","provider":{}}');
    const mismatch = run();
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /default.*model|model.*default/i);
    assert.equal(existsSync(log), false);
    rmSync(f.configPath);
    assert.notEqual(run().status, 0);
    assert.equal(existsSync(log), false);
  } finally { f.close(); }
});

test("discovery lists configured models and flags built-in models as unusable", () => {
  const f = sandbox();
  try {
    const bin = path.join(f.dir, "bin");
    mkdirSync(bin);
    executable(path.join(bin, "opencode"), `printf '%s' '${modelListing}'`);
    for (const command of ["agy", "agent", "claude", "codex"]) executable(path.join(bin, command), "exit 1");
    const docs = path.join(f.dir, "docs", "agents");
    mkdirSync(docs, { recursive: true });
    writeFileSync(path.join(docs, "models.md"), baseline);
    const run = (...args: string[]) => spawnSync(process.execPath, [path.join(root, "scripts", "orca-models.mjs"), ...args], { cwd: f.dir, encoding: "utf8", env: { ...process.env, HOME: f.home, PATH: `${bin}:/usr/bin:/bin`, ORCA_USAGE_STATE_DIR: path.join(f.dir, "state"), ORCA_MODELS_PROVIDER_TIMEOUT_MS: "300" } });
    const result = run("list", "--json");
    assert.equal(result.status, 0, result.stderr);
    const found = JSON.parse(result.stdout).providers.opencode.models;
    assert.equal(found.find((m: any) => m.id === model).usable, true);
    assert.equal(found.find((m: any) => m.id === "openai/gpt-4.1").usable, false);
    assert.match(found.find((m: any) => m.id === "openai/gpt-4.1").reason, /built.in.*credentials/i);
    assert.match(run("diff").stdout, /openai\/gpt-4\.1.*built.in.*credentials/i);
    assert.notEqual(run("verify", "opencode/openai/gpt-4.1").status, 0);
    const verification = run("verify", `opencode/${model}`);
    assert.equal(verification.status, 0, verification.stderr);
    assert.match(verification.stdout, /--agent opencode --model nris\/Qwen3\.8-27B/);
    rmSync(f.configPath);
    assert.equal(JSON.parse(run("list", "--json").stdout).providers.opencode.models.find((m: any) => m.id === model).usable, false);
    rmSync(path.join(bin, "opencode"));
    executable(path.join(f.home, ".opencode", "bin", "opencode"), `printf '%s' '${modelListing}'`);
    assert.equal(JSON.parse(run("list", "--json").stdout).providers.opencode.count, 2);
  } finally { f.close(); }
});
