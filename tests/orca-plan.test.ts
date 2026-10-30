import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error Plain JS module under test.
import { parseCliArgs, parseWave, planWave } from "../scripts/orca-plan.mjs";
// @ts-expect-error Plain JS module under test.
import { loadCandidates, recommend } from "../scripts/orca-recommend.mjs";
// @ts-expect-error The collector is plain JavaScript without type declarations.
import { UsageStore } from "../scripts/orca-usage.mjs";
// @ts-expect-error The fixture is plain JavaScript without type declarations.
import { FAR_RESET, rateLimits, writeFakeCodex, fakeCodexCalls } from "./codex-fixture.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "orca-plan.mjs");
const API_KEY = "test-key-do-not-print";

const reasoningLegend = { "0": "Mechanical", "1": "Moderate", "2": "Deep" };
function liveBody(enough: number, score: number, confidence: number, probabilities: Record<string, number>, wide: number) {
  return {
    model: "jev-1.14.0",
    answers: {
      enough_information: { type: "noul", noul: enough },
      reasoning: { type: "score", score, confidence, legend: reasoningLegend, probabilities },
      wide_change: { type: "noul", noul: wide },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}
const LIVE = {
  deep: liveBody(0.4, 1.99, 0.98, { "0": 0, "1": 0.01, "2": 0.99 }, 0.34),
  moderate: liveBody(0.41, 1, 1, { "0": 0, "1": 1, "2": 0 }, 0.1),
  mechanical: liveBody(0.76, 0, 1, { "0": 1, "1": 0, "2": 0 }, 0.07),
};

const BASELINE = `# Verified Subagent Models

| Agent       | Model ID              | Supported effort values | Capability      | Suits                | Last verified |
| ----------- | --------------------- | ----------------------- | --------------- | -------------------- | ------------- |
| claude      | \`claude-opus-5-5\`     | \`high\`                  | reasoning-heavy | Reasoning-heavy work | 2026-10-28    |
| claude      | \`claude-sonnet-5-5\`   | \`medium\`, \`high\`        | standard        | Analysis and scripts | 2026-10-28    |
| antigravity | \`gemini-4-argon-high\` | none                    | mechanical      | Small changes        | 2026-10-28    |
| cursor      | \`composer-2.5\`        | none                    | standard        | Scripting            | 2026-10-28    |
| codex       | \`gpt-6.1-terra\`       | \`max\`                   | standard        | Larger changes       | 2026-10-30    |

## Usage limits

| Not | A model row |
| --- | ----------- |
| x   | y           |
`;
const AGENT_MODELS = "Available models\n\nauto - Auto\ncomposer-2.5 - Composer 2.5\n";

type Reply = { status?: number; body?: unknown } | ((n: number) => { status?: number; body?: unknown });

async function fakeJev(reply: Reply) {
  const requests: { headers: IncomingHttpHeaders; body: any }[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(text) });
      const payload = typeof reply === "function" ? reply(n++) : reply;
      res.writeHead(payload.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}

function stub(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-plan-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "models.md"), BASELINE);
  writeFileSync(join(dir, "agent-models"), AGENT_MODELS);
  stub(bin, "agent", `cat "${dir}/agent-models"\nexit 0`);
  stub(bin, "codex", `echo called >> "${dir}/codex.log"\nexit 1`);
  return { dir, bin, models: join(dir, "models.md"), wave: join(dir, "wave.json") };
}

const clean = (box: { dir: string }) => rmSync(box.dir, { recursive: true, force: true });

function runPlan(box: ReturnType<typeof sandbox>, env: Record<string, string | undefined> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; json: any }>((done) => {
    const child = spawn(process.execPath, [script, "--wave", box.wave, "--models", box.models], {
      cwd: box.dir,
      env: {
        ...process.env,
        PATH: `${box.bin}:${process.env.PATH}`,
        TYPESAFE_API_KEY: API_KEY,
        ORCA_USAGE_STATE_DIR: join(box.dir, "usage-state"),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      done({ status, stdout, stderr, json });
    });
  });
}

function unknownUsage(agent = "claude") {
  return {
    status: "unknown",
    reason: "no verified usage collector covers this agent",
    source: null,
    observedAt: null,
    account: "unknown",
    host: "unknown",
    capacityConfirmed: false,
  };
}

function freshUsage(agent: string, overrides: Record<string, unknown> = {}) {
  return {
    status: "fresh",
    reason: "5h limit 10% used",
    capacityConfirmed: true,
    source: { kind: `${agent}-test` },
    observedAt: new Date().toISOString(),
    account: "sha256:0123456789abcdef",
    host: "andi",
    freshness: "fresh",
    resetsAt: new Date(FAR_RESET * 1000).toISOString(),
    windows: [
      {
        id: `${agent}-5h`,
        kind: "five_hour",
        label: "5h limit",
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: new Date(FAR_RESET * 1000).toISOString(),
        exhausted: false,
      },
    ],
    ...overrides,
  };
}

function exhaustedUsage(agent: string) {
  return freshUsage(agent, {
    status: "exhausted",
    reason: "rate_limit_reached: 5h limit 100% used",
    capacityConfirmed: false,
    windows: [
      {
        id: `${agent}-5h`,
        kind: "five_hour",
        label: "5h limit",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(FAR_RESET * 1000).toISOString(),
        exhausted: true,
      },
    ],
  });
}

type RecommendOptions = {
  task?: string;
  summary?: string;
  kind?: string | null;
  files?: number | null;
  eligible?: Array<{ agent: string; model: string; effort: string | null }>;
  judgment?: string;
  judgmentReason?: string;
};
type UsageByAgent = Record<string, unknown>;
type Candidates = ReturnType<typeof loadCandidates>;
type RecommendFn = (options: RecommendOptions, candidates: Candidates, usageByAgent: UsageByAgent) => ReturnType<typeof recommend>;

const judgedRecommend: RecommendFn = (options, cands, usage) =>
  recommend(
    {
      ...options,
      judgment: options.judgment ?? "standard",
      judgmentReason: options.judgmentReason ?? "test",
    },
    cands,
    usage,
  );

const plainRecommend: RecommendFn = (options, cands, usage) => recommend(options, cands, usage);

async function withRestoredEnv<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function withoutApiKey<T>(fn: () => Promise<T>): Promise<T> {
  return withRestoredEnv(["TYPESAFE_API_KEY"], async () => {
    delete process.env.TYPESAFE_API_KEY;
    return fn();
  });
}

async function withCandidates(fn: (candidates: Candidates, box: ReturnType<typeof sandbox>) => Promise<void>) {
  const box = sandbox();
  await withRestoredEnv(["PATH"], async () => {
    process.env.PATH = `${box.bin}:${process.env.PATH}`;
    try {
      await fn(loadCandidates(box.models), box);
    } finally {
      clean(box);
    }
  });
}

// --- CLI parsing

test("parseCliArgs requires --wave and accepts concurrency", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { help: true });
  assert.match(parseCliArgs([]).error, /--wave/);
  assert.equal(parseCliArgs(["--wave", "w.json", "--concurrency", "2"]).options.concurrency, 2);
  assert.match(parseCliArgs(["--wave", "w.json", "--concurrency", "0"]).error, /positive/);
});

test("parseWave rejects bad shapes and normalizes tasks", () => {
  assert.throws(() => parseWave("{}"), /non-empty/);
  const wave = parseWave(
    JSON.stringify({
      concurrency: 2,
      completed: [1],
      activeWorkers: [{ agent: "codex", model: "gpt-6.1-terra", effort: "max", dispatchId: "ctx_1" }],
      tasks: [
        { id: 10, summary: "A", dependsOn: [1], kind: "feature", judgment: "standard", judgmentReason: "clear spec" },
        { id: "11", summary: "B", ready: false },
      ],
    }),
  );
  assert.equal(wave.concurrency, 2);
  assert.equal(wave.tasks[0].id, "10");
  assert.deepEqual([...wave.completed], ["1"]);
  assert.equal(wave.tasks[1].ready, false);
});

// --- Core planning

test("respects readiness, dependencies, active workers and concurrency; never starts a worker", async () => {
  await withCandidates(async (candidates) => {
    // Force coordinator judgment by omitting a key so Jev is unavailable.
    await withoutApiKey(async () => {
      const wave = parseWave(
        JSON.stringify({
          concurrency: 2,
          completed: [],
          activeWorkers: [{ agent: "cursor", model: "composer-2.5", dispatchId: "ctx_active" }],
          tasks: [
            { id: "blocked", summary: "Needs parent", dependsOn: ["parent"], judgment: "mechanical", judgmentReason: "docs" },
            { id: "parent", summary: "Parent work", ready: false, judgment: "mechanical", judgmentReason: "docs" },
            { id: "a", summary: "Ready A", judgment: "standard", judgmentReason: "clear" },
            { id: "b", summary: "Ready B", judgment: "standard", judgmentReason: "clear" },
            { id: "c", summary: "Ready C", judgment: "mechanical", judgmentReason: "docs" },
          ],
        }),
      );
      const plan = await planWave({ wave, candidates, usageByAgent: {}, recommendFn: judgedRecommend });
      assert.equal(plan.launch.started, false);
      assert.equal(plan.concurrency.limit, 2);
      assert.equal(plan.concurrency.active, 1);
      assert.equal(plan.concurrency.proposed, 1); // one free slot

      const byId = Object.fromEntries(plan.tasks.map((row: any) => [row.task, row]));
      assert.equal(byId.blocked.status, "blocked");
      assert.match(byId.blocked.reason, /parent/);
      assert.equal(byId.parent.status, "not-ready");
      assert.equal(byId.a.status, "proposed");
      assert.equal(byId.a.launch.started, false);
      assert.ok(Array.isArray(byId.a.launch.args));
      assert.equal(byId.b.status, "deferred");
      assert.match(byId.b.reason, /concurrency/);
      assert.equal(byId.c.status, "deferred");
    });
  });
});

test("prioritizes scarce capable combinations and lists equivalent alternatives across agents", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const wave = parseWave(
        JSON.stringify({
          concurrency: 3,
          tasks: [
            {
              id: "deep",
              summary: "Hard bug across files",
              judgment: "reasoning-heavy",
              judgmentReason: "cross-file timing",
              eligible: ["claude/claude-opus-5-5/high"],
            },
            {
              id: "std-open",
              summary: "Open standard work",
              judgment: "standard",
              judgmentReason: "clear spec",
            },
            {
              id: "std-cursor-only",
              summary: "Cursor-only standard work",
              judgment: "standard",
              judgmentReason: "clear spec",
              eligible: ["cursor/composer-2.5"],
            },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent: {},
        recommendFn: plainRecommend,
      });
      const byId = Object.fromEntries(plan.tasks.map((row: any) => [row.task, row]));
      assert.equal(byId.deep.status, "proposed");
      assert.equal(byId.deep.assignment.agent, "claude");
      assert.equal(byId.deep.assignment.model, "claude-opus-5-5");
      // Cursor-only task keeps cursor; the open standard task should not steal it when alternatives exist.
      assert.equal(byId["std-cursor-only"].assignment.agent, "cursor");
      assert.notEqual(byId["std-open"].assignment.agent, "cursor");
      assert.ok(byId["std-open"].alternatives.some((alt: any) => alt.relation === "equivalent"));
    });
  });
});

test("exhausted stronger choices produce a warned weaker alternative or delay", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const usageByAgent = {
        claude: exhaustedUsage("claude"),
        antigravity: freshUsage("antigravity"),
      };
      const wave = parseWave(
        JSON.stringify({
          concurrency: 2,
          tasks: [
            {
              id: "deep",
              summary: "Needs deep reasoning",
              judgment: "reasoning-heavy",
              judgmentReason: "hard bug",
              eligible: ["claude/claude-opus-5-5/high", "antigravity/gemini-4-argon-high"],
            },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent,
        recommendFn: plainRecommend,
      });
      const [row] = plan.tasks;
      assert.equal(row.status, "needs-decision");
      assert.match(row.reason, /assessed reasoning-heavy/i);
      assert.match(row.weakerAlternative.warning, /Weaker than assessed reasoning-heavy/);
      assert.match(row.weakerAlternative.warning, /exhausted|unavailable/i);
      assert.equal(row.weakerAlternative.agent, "antigravity");
      assert.equal(row.launch.started, false);
      assert.equal(row.weakerAlternative.launch.started, false);
      assert.equal(plan.concurrency.proposed, 1);
    });
  });
});

test("suitable unknown usage beside weaker known capacity shows both with uncertainty", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const usageByAgent = {
        claude: unknownUsage(),
        antigravity: freshUsage("antigravity"),
      };
      const wave = parseWave(
        JSON.stringify({
          concurrency: 1,
          tasks: [
            {
              id: "std",
              summary: "Standard scripting",
              judgment: "standard",
              judgmentReason: "clear",
              eligible: ["claude/claude-sonnet-5-5/medium", "antigravity/gemini-4-argon-high"],
            },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent,
        recommendFn: plainRecommend,
      });
      const [row] = plan.tasks;
      assert.equal(row.status, "needs-decision");
      assert.equal(row.assignment.agent, "claude");
      assert.equal(row.assignment.capacityConfirmed, false);
      assert.equal(row.uncertaintyAlternative.agent, "antigravity");
      assert.equal(row.uncertaintyAlternative.capacityConfirmed, true);
      assert.match(row.uncertaintyAlternative.warning, /unconfirmed|unknown|below/i);
    });
  });
});

test("plan reports usage provenance, shared allowances and reset windows without comparing percentages", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const usageByAgent = {
        codex: freshUsage("codex"),
        cursor: freshUsage("cursor", { reason: "included 40% used", windows: [{ id: "cursor-month", kind: "monthly", label: "monthly", usedPercent: 40, remainingPercent: 60, resetsAt: new Date(FAR_RESET * 1000).toISOString(), exhausted: false }] }),
      };
      const wave = parseWave(
        JSON.stringify({
          concurrency: 3,
          activeWorkers: [{ agent: "codex", model: "gpt-6.1-terra", effort: "max", dispatchId: "ctx_live" }],
          tasks: [
            { id: "t1", summary: "One", judgment: "standard", judgmentReason: "x", eligible: ["codex/gpt-6.1-terra/max"] },
            { id: "t2", summary: "Two", judgment: "standard", judgmentReason: "x", eligible: ["cursor/composer-2.5"] },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent,
        recommendFn: plainRecommend,
      });
      assert.equal(plan.allowances.codex.source.kind, "codex-test");
      assert.ok(plan.allowances.codex.windows[0].resetsAt);
      assert.equal(plan.allowances.codex.sharedWith.active[0].dispatchId, "ctx_live");
      assert.ok(plan.allowances.codex.sharedWith.proposed.some((row: any) => row.task === "t1"));
      assert.match(plan.allowances.codex.sharedWith.note, /not comparable/);
      assert.match(plan.allowances.codex.sharedWith.note, /not a reservation/);
      assert.ok(plan.notes.some((note: string) => /not comparable/i.test(note)));
      // Distinct statuses remain distinct in the report surface.
      assert.equal(plan.usageByAgent.codex.status, "fresh");
    });
  });
});

test("handles unknown, stale and low usage distinctly", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const usageByAgent = {
        claude: unknownUsage(),
        cursor: freshUsage("cursor", { status: "stale", capacityConfirmed: false, reason: "older_than_30_minutes", freshness: "stale" }),
        codex: freshUsage("codex", { status: "low", reason: "5h limit 93% used", capacityConfirmed: true }),
      };
      const wave = parseWave(
        JSON.stringify({
          concurrency: 3,
          tasks: [
            { id: "u", summary: "Unknown agent task", judgment: "standard", judgmentReason: "x", eligible: ["claude/claude-sonnet-5-5/high"] },
            { id: "s", summary: "Stale agent task", judgment: "standard", judgmentReason: "x", eligible: ["cursor/composer-2.5"] },
            { id: "l", summary: "Low agent task", judgment: "standard", judgmentReason: "x", eligible: ["codex/gpt-6.1-terra/max"] },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent,
        recommendFn: plainRecommend,
      });
      const byId = Object.fromEntries(plan.tasks.map((row: any) => [row.task, row]));
      assert.equal(byId.u.assignment.usage, "unknown");
      assert.equal(byId.s.assignment.usage, "stale");
      assert.equal(byId.l.assignment.usage, "low");
      assert.match(byId.l.warning, /low/);
      assert.equal(plan.allowances.claude.status, "unknown");
      assert.equal(plan.allowances.cursor.status, "stale");
      assert.equal(plan.allowances.codex.status, "low");
    });
  });
});

test("repeat planning responds to changed worker and usage state", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const tasks = [
        { id: "a", summary: "A", judgment: "mechanical", judgmentReason: "docs" },
        { id: "b", summary: "B", judgment: "mechanical", judgmentReason: "docs" },
      ];
      const first = await planWave({
        wave: parseWave(JSON.stringify({ concurrency: 1, tasks })),
        candidates,
        usageByAgent: {},
        recommendFn: plainRecommend,
      });
      assert.equal(first.tasks.filter((row: any) => row.status === "proposed").length, 1);
      assert.equal(first.tasks.filter((row: any) => row.status === "deferred").length, 1);

      const proposed = first.tasks.find((row: any) => row.status === "proposed");
      const second = await planWave({
        wave: parseWave(
          JSON.stringify({
            concurrency: 1,
            activeWorkers: [{ agent: proposed.assignment.agent, model: proposed.assignment.model, dispatchId: "ctx_done_slot_busy" }],
            completed: [proposed.task],
            tasks: tasks.filter((task) => task.id !== proposed.task),
          }),
        ),
        candidates,
        usageByAgent: { antigravity: exhaustedUsage("antigravity") },
        recommendFn: plainRecommend,
      });
      // Slot still full because of the active worker; remaining task stays deferred or delayed under exhausted usage.
      assert.ok(second.tasks.every((row: any) => row.status === "deferred" || row.status === "delay" || row.status === "needs-decision"));
      assert.equal(second.concurrency.active, 1);
      assert.equal(second.concurrency.proposed, 0);
    });
  });
});

test("CLI refreshes usage before planning and never starts a worker", async () => {
  const box = sandbox();
  const jev = await fakeJev({ body: LIVE.moderate });
  try {
    writeFakeCodex(box.bin, { rateLimits: { result: rateLimits({ primary: 20, resetsAt: FAR_RESET, secondaryResetsAt: FAR_RESET }) } });
    writeFileSync(
      box.wave,
      JSON.stringify({
        concurrency: 2,
        tasks: [{ id: "1", summary: "Plan a parser with tests", kind: "feature", eligible: ["codex/gpt-6.1-terra/max"] }],
      }),
    );
    const result = await runPlan(box, { ORCA_RECOMMEND_JEV_URL: jev.url });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.launch.started, false);
    assert.equal(result.json.tasks[0].launch.started, false);
    assert.equal(result.json.usageByAgent.codex.status, "fresh");
    assert.equal(result.json.usageByAgent.codex.refresh.attempted, true);
    assert.equal(result.json.allowances.codex.source.kind, "codex-app-server-rate-limits");
    const reads = fakeCodexCalls(box.bin).filter((call: { method?: string }) => call.method === "account/rateLimits/read");
    assert.equal(reads.length, 1);
    assert.equal(result.json.tasks[0].status, "proposed");
    assert.ok(!existsOrcaStart(box));
  } finally {
    await jev.close();
    clean(box);
  }
});

function existsOrcaStart(box: { dir: string }) {
  try {
    return readFileSync(join(box.dir, "orca.log"), "utf8").includes("worker-start");
  } catch {
    return false;
  }
}

test("CLI reports Jev failure as needs-judgment without launching", async () => {
  const box = sandbox();
  const jev = await fakeJev({ status: 500, body: { detail: "nope" } });
  try {
    writeFileSync(
      box.wave,
      JSON.stringify({
        tasks: [{ id: "1", summary: "Something vague" }],
      }),
    );
    // Baseline without codex so no reader starts.
    writeFileSync(
      box.models,
      BASELINE.replace("| codex       | `gpt-6.1-terra`       | `max`                   | standard        | Larger changes       | 2026-10-30    |\n", ""),
    );
    const result = await runPlan(box, { ORCA_RECOMMEND_JEV_URL: jev.url });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.tasks[0].status, "needs-judgment");
    assert.equal(result.json.launch.started, false);
  } finally {
    await jev.close();
    clean(box);
  }
});

test("shared-capacity scenario spreads equivalent work across agents", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const usageByAgent = {
        cursor: freshUsage("cursor"),
        codex: freshUsage("codex"),
        claude: freshUsage("claude"),
      };
      const wave = parseWave(
        JSON.stringify({
          concurrency: 2,
          activeWorkers: [{ agent: "cursor", model: "composer-2.5", dispatchId: "ctx_1" }],
          tasks: [
            { id: "one", summary: "Task one", judgment: "standard", judgmentReason: "x" },
            { id: "two", summary: "Task two", judgment: "standard", judgmentReason: "x" },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent,
        recommendFn: plainRecommend,
      });
      const proposed = plan.tasks.filter((row: any) => row.status === "proposed");
      assert.equal(proposed.length, 1); // one free slot
      assert.notEqual(proposed[0].assignment.agent, "cursor");
      assert.ok(plan.allowances.cursor.sharedWith.active.length === 1);
    });
  });
});

test("one-slot wave plans the scarcer suitable pool before the open pool", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const wave = parseWave(
        JSON.stringify({
          concurrency: 1,
          tasks: [
            { id: "open", summary: "Open standard work", judgment: "standard", judgmentReason: "clear" },
            {
              id: "only-cursor",
              summary: "Cursor-only standard work",
              judgment: "standard",
              judgmentReason: "clear",
              eligible: ["cursor/composer-2.5"],
            },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent: {},
        recommendFn: plainRecommend,
      });
      const byId = Object.fromEntries(plan.tasks.map((row: any) => [row.task, row]));
      assert.equal(byId["only-cursor"].status, "proposed");
      assert.equal(byId["only-cursor"].assignment.agent, "cursor");
      assert.equal(byId.open.status, "deferred");
      assert.match(byId.open.reason, /concurrency/);
    });
  });
});

test("needs-decision weaker alternative holds a concurrency slot and shared load", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const usageByAgent = {
        claude: exhaustedUsage("claude"),
        antigravity: freshUsage("antigravity"),
      };
      const wave = parseWave(
        JSON.stringify({
          concurrency: 1,
          tasks: [
            {
              id: "deep",
              summary: "Needs deep reasoning",
              judgment: "reasoning-heavy",
              judgmentReason: "hard bug",
              eligible: ["claude/claude-opus-5-5/high", "antigravity/gemini-4-argon-high"],
            },
            {
              id: "easy",
              summary: "Mechanical docs",
              judgment: "mechanical",
              judgmentReason: "docs",
              eligible: ["antigravity/gemini-4-argon-high"],
            },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent,
        recommendFn: plainRecommend,
      });
      const byId = Object.fromEntries(plan.tasks.map((row: any) => [row.task, row]));
      assert.equal(byId.deep.status, "needs-decision");
      assert.equal(byId.deep.weakerAlternative.agent, "antigravity");
      assert.equal(byId.easy.status, "deferred");
      assert.equal(plan.concurrency.proposed, 1);
      assert.equal(plan.concurrency.remainingSlots, 0);
      assert.ok(plan.allowances.antigravity.sharedWith.proposed.some((row: any) => row.task === "deep"));
    });
  });
});

test("dependency cycle leaves both tasks blocked", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const wave = parseWave(
        JSON.stringify({
          concurrency: 2,
          tasks: [
            { id: "a", summary: "Depends on b", dependsOn: ["b"], judgment: "mechanical", judgmentReason: "docs" },
            { id: "b", summary: "Depends on a", dependsOn: ["a"], judgment: "mechanical", judgmentReason: "docs" },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent: {},
        recommendFn: plainRecommend,
      });
      const byId = Object.fromEntries(plan.tasks.map((row: any) => [row.task, row]));
      assert.equal(byId.a.status, "blocked");
      assert.match(byId.a.reason, /b/);
      assert.equal(byId.b.status, "blocked");
      assert.match(byId.b.reason, /a/);
      assert.equal(plan.concurrency.proposed, 0);
    });
  });
});

test("pure delay when suitable choices are exhausted and no weaker alternative exists", async () => {
  await withCandidates(async (candidates) => {
    await withoutApiKey(async () => {
      const usageByAgent = { claude: exhaustedUsage("claude") };
      const wave = parseWave(
        JSON.stringify({
          concurrency: 1,
          tasks: [
            {
              id: "deep",
              summary: "Needs deep reasoning",
              judgment: "reasoning-heavy",
              judgmentReason: "hard bug",
              eligible: ["claude/claude-opus-5-5/high"],
            },
          ],
        }),
      );
      const plan = await planWave({
        wave,
        candidates,
        usageByAgent,
        recommendFn: plainRecommend,
      });
      const [row] = plan.tasks;
      assert.equal(row.status, "delay");
      assert.equal(row.weakerAlternative, undefined);
      assert.match(row.reason, /assessed reasoning-heavy/i);
      assert.match(row.reason, /exhausted|unavailable/i);
      assert.equal(plan.concurrency.proposed, 0);
    });
  });
});
