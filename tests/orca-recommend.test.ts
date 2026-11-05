import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error The collector is plain JavaScript without type declarations.
import { UsageStore } from "../scripts/orca-usage.mjs";
// @ts-expect-error The fixture is plain JavaScript without type declarations.
import { FAR_RESET, REAL_ERRORS, REAL_EXHAUSTED, fakeCodexCalls, rateLimits, writeFakeCodex } from "./codex-fixture.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "orca-recommend.mjs");
const spawnScript = join(repoRoot, "scripts", "orca-spawn.sh");
const API_KEY = "test-key-do-not-print";

// Bodies copied from live POST /v1/systemone calls against jev-1.14.0 on 2026-10-30. Only `legend` is shortened.
const reasoningLegend = { "0": "Mechanical", "1": "Moderate", "2": "Deep" };
function liveBody(enough: number, score: number, confidence: number, probabilities: Record<string, number>, wide: number) {
  return {
    model: "jev-1.14.0",
    answers: {
      enough_information: { type: "noul", noul: enough },
      reasoning: { type: "score", score, confidence, legend: reasoningLegend, probabilities },
      wide_change: { type: "noul", noul: wide },
    },
    usage: { input_tokens: 451, output_tokens: 54 },
  };
}
const LIVE = {
  deep: liveBody(0.4, 1.99, 0.98, { "0": 0, "1": 0.01, "2": 0.99 }, 0.34),
  moderate: liveBody(0.41, 1, 1, { "0": 0, "1": 1, "2": 0 }, 0.1),
  mechanical: liveBody(0.76, 0, 1, { "0": 1, "1": 0, "2": 0 }, 0.07),
  vague: liveBody(0.06, 0.91, 0, { "0": 0.43, "1": 0.23, "2": 0.34 }, 0.3),
  moderateWide: liveBody(0.41, 1.06, 0.84, { "0": 0.02, "1": 0.89, "2": 0.09 }, 0.95),
  moderateMaybeWide: liveBody(0.33, 1.18, 0.73, { "0": 0, "1": 0.82, "2": 0.18 }, 0.66),
};
// The live answers to a request without a key (403, although the TypeSafe docs say 401) and with a wrong one (401).
const LIVE_403 = { detail: { error_type: "authentication_error", message: "Must supply an API key! Check your request and try again." } };
const LIVE_401 = { detail: { error_type: "authentication_error", message: "Cannot authenticate with the server. Please check your API key and try again." } };

const BASELINE = `# Verified Subagent Models

| Agent       | Model ID              | Supported effort values | Capability      | Suits                | Last verified |
| ----------- | --------------------- | ----------------------- | --------------- | -------------------- | ------------- |
| claude      | \`claude-opus-5-5\`     | \`high\`                  | reasoning-heavy | Reasoning-heavy work | 2026-10-28    |
| claude      | \`claude-sonnet-5-5\`   | \`medium\`, \`high\`        | standard        | Analysis and scripts | 2026-10-28    |
| antigravity | \`gemini-4-argon-high\` | none                    | mechanical      | Small changes        | 2026-10-28    |
| cursor      | \`composer-2.5\`        | none                    | standard        | Scripting            | 2026-10-28    |
| cursor      | \`retired-model\`       | none                    | standard        | Gone from the list   | 2026-10-28    |
| claude      | \`claude-unrated\`      | \`high\`                  | -               | Not rated            | 2026-10-28    |

## Usage limits

| Not | A model row |
| --- | ----------- |
| x   | y           |
`;
// `agent --list-models` output, cut down from a real run.
const AGENT_MODELS = "Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\ncomposer-2.5-fast - Composer 2.5 Fast\n";

type Reply = { status?: number; body?: unknown; raw?: string } | "destroy" | "hang";

async function fakeJev(reply: Reply) {
  const requests: { headers: IncomingHttpHeaders; body: any }[] = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(text) });
      if (reply === "hang") return;
      if (reply === "destroy") return void req.socket.destroy();
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(reply.raw ?? JSON.stringify(reply.body));
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-recommend-")));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(dir, "models.md"), BASELINE);
  writeFileSync(join(dir, "agent-models"), AGENT_MODELS);
  stub(bin, "agent", `cat "${dir}/agent-models"\nexit $(cat "${dir}/agent-exit" 2>/dev/null || echo 0)`);
  stub(bin, "orca", `echo "$@" >> "${dir}/orca.log"`);
  // A baseline with a Codex row makes the command read usage, and that must never reach the real account.
  stub(bin, "codex", `echo called >> "${dir}/codex.log"\nexit 1`);
  stub(bin, "agy", `echo missing >> "${dir}/agy.log"\nexit 1`);
  return { dir, bin, home, orcaLog: join(dir, "orca.log"), models: join(dir, "models.md") };
}

function recommend(box: ReturnType<typeof sandbox>, args: string[], jevUrl: string, env: Record<string, string | undefined> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; json: any }>((done) => {
    const child = spawn(process.execPath, [script, "--task", "105", "--summary", "Add a parser with unit tests", "--models", box.models, ...args], {
      cwd: box.dir,
      env: {
        ...process.env,
        PATH: `${box.bin}:${process.env.PATH}`,
        HOME: box.home,
        CLAUDE_CONFIG_DIR: join(box.dir, "claude"),
        TYPESAFE_API_KEY: API_KEY,
        ORCA_RECOMMEND_JEV_URL: jevUrl,
        ORCA_USAGE_STATE_DIR: join(box.dir, "usage-state"),
        // Without these the command reads the real checkout's worker history, and learned adjustments
        // (which draw on Math.random) make the pick differ from run to run on a machine with history.
        ORCA_HISTORY_DIR: join(box.dir, "history"),
        ORCA_LEARN_DIR: join(box.dir, "learning"),
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

async function scenario(reply: Reply, args: string[] = [], env: Record<string, string | undefined> = {}, prepare?: (box: ReturnType<typeof sandbox>) => void) {
  const box = sandbox();
  const jev = await fakeJev(reply);
  try {
    prepare?.(box);
    const result = await recommend(box, args, jev.url, env);
    return { ...result, box, jev, spec: (name: string) => readFileSync(join(box.dir, name), "utf8") };
  } finally {
    await jev.close();
  }
}
const clean = (box: { dir: string }) => rmSync(box.dir, { recursive: true, force: true });
const named = (c: { agent: string; model: string; effort: string | null }) => [c.agent, c.model, c.effort].filter(Boolean).join("/");

// --- Suitable models

test("recommends a suitable worker for a deep task without starting one", async () => {
  const r = await scenario({ body: LIVE.deep });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.status, "recommended");
    assert.equal(named(r.json.recommendation), "claude/claude-opus-5-5/high");
    assert.equal(r.json.assessment.requirement, "reasoning-heavy");
    assert.match(r.json.recommendation.reason, /reasoning-heavy/);
    assert.deepEqual(r.json.launch, { started: false, args: ["--agent", "claude", "--model", "claude-opus-5-5", "--effort", "high"] });
    assert.equal(existsSync(r.box.orcaLog), false, "the command must never call orca");
  } finally {
    clean(r.box);
  }
});

test("a moderate task gets the smallest suitable model, its lowest effort, and the other suitable choices", async () => {
  const r = await scenario({ body: LIVE.moderate });
  try {
    assert.equal(named(r.json.recommendation), "claude/claude-sonnet-5-5/medium");
    assert.deepEqual(
      r.json.alternatives.map((a: any) => [named(a), a.relation]),
      [
        ["claude/claude-sonnet-5-5/high", "equivalent"],
        ["cursor/composer-2.5", "equivalent"],
        ["claude/claude-opus-5-5/high", "stronger"],
      ],
    );
  } finally {
    clean(r.box);
  }
});

test("a model with no effort setting reports none and launches without --effort", async () => {
  const r = await scenario({ body: LIVE.mechanical });
  try {
    assert.equal(r.json.assessment.requirement, "mechanical");
    assert.equal(r.json.recommendation.effort, null);
    assert.deepEqual(r.json.launch.args, ["--agent", "antigravity", "--model", "gemini-4-argon-high"]);
  } finally {
    clean(r.box);
  }
});

test("a wide change raises moderate work to reasoning-heavy", async () => {
  const r = await scenario({ body: LIVE.moderateWide });
  try {
    assert.equal(r.json.assessment.requirement, "reasoning-heavy");
    assert.equal(named(r.json.recommendation), "claude/claude-opus-5-5/high");
  } finally {
    clean(r.box);
  }
});

test("a wide change does not raise mechanical work", async () => {
  const r = await scenario({ body: liveBody(0.76, 0, 1, { "0": 1, "1": 0, "2": 0 }, 0.95) });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.assessment.requirement, "mechanical");
  } finally {
    clean(r.box);
  }
});

test("split reasoning distributions and 0.3 enoughInformation are inconclusive, and uncertainty includes score and probabilities", async () => {
  const split = await scenario({ body: liveBody(0.5, 1.49, 0.8, { "0": 0, "1": 0.51, "2": 0.49 }, 0.1) });
  const tie = await scenario({ body: liveBody(0.5, 1.5, 0.5, { "0": 0, "1": 0.5, "2": 0.5 }, 0.1) });
  const boundaryNoInfo = await scenario({ body: liveBody(0.3, 1, 1, { "0": 0, "1": 1, "2": 0 }, 0.1) });
  const justEnoughInfo = await scenario({ body: liveBody(0.31, 1, 1, { "0": 0, "1": 1, "2": 0 }, 0.3) });
  const badScore = await scenario({ body: liveBody(0.5, 2.5, 0.9, { "0": 0, "1": 0, "2": 1 }, 0.1) });
  const extraProbKey = await scenario({ body: liveBody(0.5, 2, 0.9, { "0": 0, "1": 0, "2": 1, "3": 0.2 }, 0.1) });
  try {
    assert.equal(split.status, 3);
    assert.equal(split.json.status, "needs-judgment");
    assert.equal(split.json.assessment.jev.status, "inconclusive");
    assert.equal(split.json.assessment.requirement, null);
    assert.equal(split.json.assessment.jev.uncertainty.conclusive, false);
    assert.equal(split.json.assessment.jev.uncertainty.reasoningScore, 1.49);
    assert.deepEqual(split.json.assessment.jev.uncertainty.reasoningProbabilities, { "0": 0, "1": 0.51, "2": 0.49 });

    assert.equal(tie.status, 3);
    assert.equal(tie.json.assessment.jev.status, "inconclusive");

    assert.equal(boundaryNoInfo.status, 3);
    assert.equal(boundaryNoInfo.json.assessment.jev.status, "inconclusive");

    assert.equal(justEnoughInfo.status, 0, justEnoughInfo.stderr);
    assert.equal(justEnoughInfo.json.assessment.requirement, "standard");

    assert.equal(badScore.status, 3);
    assert.equal(badScore.json.assessment.jev.status, "invalid");

    assert.equal(extraProbKey.status, 3);
    assert.equal(extraProbKey.json.assessment.jev.status, "invalid");
  } finally {
    clean(split.box);
    clean(tie.box);
    clean(boundaryNoInfo.box);
    clean(justEnoughInfo.box);
    clean(badScore.box);
    clean(extraProbKey.box);
  }
});

// --- Unsupported models

test("a candidate that does not meet the requirement is listed with the reason", async () => {
  const r = await scenario({ body: LIVE.deep });
  try {
    const weak = r.json.rejected.find((c: any) => c.model === "gemini-4-argon-high");
    assert.match(weak.reason, /mechanical.*below.*reasoning-heavy/);
  } finally {
    clean(r.box);
  }
});

test("an eligible entry outside the baseline or with an undocumented effort is rejected, and the rest still compete", async () => {
  const r = await scenario({ body: LIVE.moderate }, ["--eligible", "claude/gpt-nonsense", "--eligible", "claude/claude-sonnet-5-5/max", "--eligible", "cursor/composer-2.5"]);
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(named(r.json.recommendation), "cursor/composer-2.5");
    assert.deepEqual(r.json.alternatives, []);
    assert.match(r.json.rejected.find((c: any) => c.model === "gpt-nonsense").reason, /not in/);
    assert.match(r.json.rejected.find((c: any) => c.effort === "max").reason, /effort/);
  } finally {
    clean(r.box);
  }
});

test("an eligible model named without an effort covers each documented effort", async () => {
  const r = await scenario({ body: LIVE.moderate }, ["--eligible", "claude/claude-sonnet-5-5"]);
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(named(r.json.recommendation), "claude/claude-sonnet-5-5/medium");
    assert.deepEqual(r.json.alternatives.map(named), ["claude/claude-sonnet-5-5/high"]);
    assert.deepEqual(r.json.rejected, []);
  } finally {
    clean(r.box);
  }
});

test("an eligible model that cannot be launched is rejected once", async () => {
  const r = await scenario({ body: LIVE.moderate }, ["--eligible", "cursor/retired-model", "--eligible", "cursor/composer-2.5"]);
  try {
    assert.equal(r.json.rejected.filter((c: any) => c.model === "retired-model").length, 1);
  } finally {
    clean(r.box);
  }
});

test("when no eligible candidate is suitable nothing is recommended", async () => {
  const r = await scenario({ body: LIVE.deep }, ["--eligible", "antigravity/gemini-4-argon-high", "--record", "spec.md"], {}, (box) => writeFileSync(join(box.dir, "spec.md"), "# spec\n"));
  try {
    assert.equal(r.status, 1);
    assert.equal(r.json.status, "no-suitable-candidate");
    assert.equal(r.json.recommendation, null);
    assert.equal(r.json.launch, null);
    assert.equal(r.spec("spec.md"), "# spec\n");
  } finally {
    clean(r.box);
  }
});

test("a cursor model that agent --list-models no longer lists is not recommended", async () => {
  const r = await scenario({ body: LIVE.moderate }, ["--eligible", "cursor/retired-model", "--eligible", "cursor/composer-2.5"]);
  try {
    assert.equal(named(r.json.recommendation), "cursor/composer-2.5");
    assert.match(r.json.rejected.find((c: any) => c.model === "retired-model").reason, /list-models/);
  } finally {
    clean(r.box);
  }
});

test("cursor candidates are rejected when agent --list-models fails, because the launch would refuse them", async () => {
  const r = await scenario({ body: LIVE.moderate }, ["--eligible", "cursor/composer-2.5"], {}, (box) => writeFileSync(join(box.dir, "agent-exit"), "1"));
  try {
    assert.equal(r.status, 1);
    assert.equal(r.json.status, "no-suitable-candidate");
    assert.match(r.json.rejected.find((c: any) => c.model === "composer-2.5").reason, /list-models/);
  } finally {
    clean(r.box);
  }
});

test("a baseline row without a documented capability is never recommended", async () => {
  const r = await scenario({ body: LIVE.moderate }, ["--eligible", "claude/claude-unrated/high"]);
  try {
    assert.equal(r.status, 1);
    assert.match(r.json.rejected.find((c: any) => c.model === "claude-unrated").reason, /capability/);
  } finally {
    clean(r.box);
  }
});

test("a missing baseline fails before Jev is called", async () => {
  const r = await scenario({ body: LIVE.deep }, [], {}, (box) => rmSync(box.models));
  try {
    assert.equal(r.status, 1);
    assert.equal(r.jev.requests.length, 0);
  } finally {
    clean(r.box);
  }
});

// --- What Jev receives and reports

test("Jev receives only the summary and assessment inputs, never the spec", async () => {
  const r = await scenario({ body: LIVE.deep }, ["--kind", "fix", "--files", "3", "--record", "spec.md"], {}, (box) =>
    writeFileSync(join(box.dir, "spec.md"), "# spec\nPRIVATE-TRANSCRIPT-TEXT\n"),
  );
  try {
    assert.equal(r.jev.requests.length, 1);
    const { headers, body } = r.jev.requests[0];
    assert.equal(headers.authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
    assert.deepEqual(body.state, { task: "Add a parser with unit tests", kind: "fix", estimated_files: 3 });
    assert.equal(body.model, "jev-1.14.0");
    assert.deepEqual(Object.keys(body.questions).sort(), ["enough_information", "reasoning", "wide_change"]);
    assert.equal(JSON.stringify(body).includes("PRIVATE-TRANSCRIPT-TEXT"), false);
  } finally {
    clean(r.box);
  }
});

test("a long description is refused before anything is sent", async () => {
  const box = sandbox();
  const jev = await fakeJev({ body: LIVE.deep });
  try {
    const r = await recommend(box, ["--summary", "x".repeat(601)], jev.url);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /600/);
    assert.equal(jev.requests.length, 0);
  } finally {
    await jev.close();
    clean(box);
  }
});

test("reports the version Jev answered with and its uncertainty", async () => {
  const r = await scenario({ body: { ...LIVE.deep, model: "jev-1.15.0" } });
  try {
    assert.equal(r.json.assessment.source, "jev");
    assert.equal(r.json.assessment.jev.status, "ok");
    assert.equal(r.json.assessment.jev.requestedModel, "jev-1.14.0");
    assert.equal(r.json.assessment.jev.version, "jev-1.15.0");
    assert.equal(r.json.assessment.jev.uncertainty.reasoningScore, 1.99);
    assert.equal(r.json.assessment.jev.uncertainty.reasoningConfidence, 0.98);
    assert.deepEqual(r.json.assessment.jev.uncertainty.reasoningProbabilities, { "0": 0, "1": 0.01, "2": 0.99 });
    assert.equal(r.json.assessment.jev.uncertainty.enoughInformation, 0.4);
    assert.equal(r.json.assessment.jev.uncertainty.wideChange, 0.34);
    assert.equal(r.json.assessment.jev.uncertainty.conclusive, true);
    assert.equal(r.json.fallback, null);
  } finally {
    clean(r.box);
  }
});

test("doubt about breadth does not block work it cannot change", async () => {
  const r = await scenario({ body: liveBody(0.4, 1.99, 0.98, { "0": 0, "1": 0.01, "2": 0.99 }, 0.5) });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.assessment.requirement, "reasoning-heavy");
  } finally {
    clean(r.box);
  }
});

// --- Jev failure and uncertainty

const failures: [string, Reply, string, Record<string, string | undefined>?][] = [
  ["no key", { body: LIVE.deep }, "unavailable", { TYPESAFE_API_KEY: "" }],
  ["the live 403 answer", { status: 403, body: LIVE_403 }, "unavailable"],
  ["the live 401 answer", { status: 401, body: LIVE_401 }, "unavailable"],
  ["a rate limit", { status: 429, body: { detail: "slow down" } }, "unavailable"],
  ["an overload", { status: 529, body: {} }, "unavailable"],
  ["a dropped connection", "destroy", "unavailable"],
  ["a hung request", "hang", "unavailable", { ORCA_RECOMMEND_JEV_TIMEOUT_MS: "200" }],
  ["a body that is not JSON", { raw: "<html>gateway</html>" }, "invalid"],
  ["a missing answer", { body: { model: "jev-1.14.0", answers: { reasoning: LIVE.deep.answers.reasoning } } }, "invalid"],
  ["a missing version", { body: { ...LIVE.deep, model: undefined } }, "invalid"],
  ["a wrong answer type", { body: { ...LIVE.deep, answers: { ...LIVE.deep.answers, wide_change: { type: "score", score: 1 } } } }, "invalid"],
  ["a noul out of range", { body: { ...LIVE.deep, answers: { ...LIVE.deep.answers, enough_information: { type: "noul", noul: 1.4 } } } }, "invalid"],
  ["probabilities that do not sum to one", { body: liveBody(0.5, 1, 1, { "0": 0.9, "1": 0.9, "2": 0.9 }, 0.1) }, "invalid"],
  ["the live vague task", { body: LIVE.vague }, "inconclusive"],
  ["low reasoning confidence alone", { body: liveBody(0.6, 0.91, 0.2, { "0": 0.43, "1": 0.23, "2": 0.34 }, 0.1) }, "inconclusive"],
  ["too little information", { body: liveBody(0.1, 1, 1, { "0": 0, "1": 1, "2": 0 }, 0.1) }, "inconclusive"],
  ["undecided breadth on moderate work", { body: LIVE.moderateMaybeWide }, "inconclusive"],
];

for (const [name, reply, jevStatus, env] of failures) {
  test(`${name}: stops for the coordinator's judgment and recommends nothing`, async () => {
    const r = await scenario(reply, ["--record", "spec.md"], env, (box) => writeFileSync(join(box.dir, "spec.md"), "# spec\n"));
    try {
      assert.equal(r.status, 3, r.stderr);
      assert.equal(r.json.status, "needs-judgment");
      assert.equal(r.json.assessment.jev.status, jevStatus);
      assert.equal(r.json.recommendation, null);
      assert.equal(r.json.launch, null);
      assert.equal(r.spec("spec.md"), "# spec\n");
      assert.match(r.stderr, /--judgment/);
      assert.equal(`${r.stdout}${r.stderr}`.includes(API_KEY), false);
    } finally {
      clean(r.box);
    }
  });

  test(`${name}: the coordinator's judgment is used and the fallback recorded`, async () => {
    const r = await scenario(reply, ["--judgment", "reasoning-heavy", "--judgment-reason", "Touches the sync queue", "--record", "spec.md"], env, (box) =>
      writeFileSync(join(box.dir, "spec.md"), "## Model choice\n\n- Agent: <id>\n"),
    );
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.status, "recommended");
      assert.equal(r.json.assessment.source, "coordinator");
      assert.equal(r.json.assessment.requirement, "reasoning-heavy");
      assert.equal(named(r.json.recommendation), "claude/claude-opus-5-5/high");
      assert.equal(r.json.fallback.because, jevStatus);
      assert.equal(r.json.fallback.reason, "Touches the sync queue");
      assert.match(r.spec("spec.md"), new RegExp(`Fallback: coordinator judgment reasoning-heavy because Jev was ${jevStatus}`));
      assert.match(r.spec("spec.md"), /Touches the sync queue/);
      assert.equal(`${r.stdout}${r.stderr}${r.spec("spec.md")}`.includes(API_KEY), false);
    } finally {
      clean(r.box);
    }
  });
}

test("the real error details are reported, and a key echoed by the server is redacted", async () => {
  const live = await scenario({ status: 403, body: LIVE_403 });
  const echoed = await scenario({ status: 400, body: { detail: { error_type: "bad", message: `key ${API_KEY} refused` } } });
  try {
    assert.match(live.json.assessment.jev.detail, /HTTP 403 authentication_error: Must supply an API key/);
    assert.equal(`${echoed.stdout}${echoed.stderr}`.includes(API_KEY), false);
    assert.match(echoed.json.assessment.jev.detail, /\[redacted\]/);
  } finally {
    clean(live.box);
    clean(echoed.box);
  }
});

test("a judgment given while Jev is conclusive is shown but does not replace the assessment", async () => {
  const r = await scenario({ body: LIVE.mechanical }, ["--judgment", "reasoning-heavy", "--judgment-reason", "Looks harder"]);
  try {
    assert.equal(r.json.assessment.source, "jev");
    assert.equal(r.json.assessment.requirement, "mechanical");
    assert.deepEqual(r.json.assessment.coordinator, { requirement: "reasoning-heavy", reason: "Looks harder", used: false });
    assert.equal(r.json.fallback, null);
  } finally {
    clean(r.box);
  }
});

// --- Usage

test("usage is reported as unknown overall and for every candidate when no local login is present", async () => {
  const r = await scenario({ body: LIVE.moderate }, ["--record", "spec.md"], {}, (box) => writeFileSync(join(box.dir, "spec.md"), "# spec\n"));
  try {
    assert.equal(r.json.usage.status, "unknown");
    assert.equal(r.json.usage.capacityConfirmed, false);
    assert.equal(r.json.usage.account, "unknown");
    assert.equal(r.json.usage.refresh.attempted, true);
    assert.equal(r.json.recommendation.usage, "unknown");
    assert.equal(r.json.recommendation.usageScope.account, "unknown");
    assert.ok(r.json.alternatives.length > 0);
    for (const alternative of r.json.alternatives) {
      assert.equal(alternative.usage, "unknown");
      assert.equal(alternative.usageScope.account, "unknown");
    }
    assert.match(r.json.recommendation.reason, /[Uu]sage is unknown/);
    assert.match(r.spec("spec.md"), /^- Usage: unknown — .+ \(account unknown, host .+;/m);
    assert.doesNotMatch(r.stdout, /"status": "fresh"/);
  } finally {
    clean(r.box);
  }
});

test("equivalent candidates are not ordered as though usage were known", async () => {
  const r = await scenario({ body: LIVE.moderate });
  try {
    // No routing-policy.json beside the sandbox baseline: keep the legacy note when usage is unknown.
    assert.match(r.json.recommendation.reason, /not balanced|no confirmed burn pressure/);
  } finally {
    clean(r.box);
  }
});

// --- Collected usage

const CODEX_ROW = "| codex       | `gpt-6.1-terra`       | `max`                   | standard        | Larger changes       | 2026-10-30    |\n";
const CODEX = ["--eligible", "codex/gpt-6.1-terra/max"];
const farFuture = (figures: object) => ({ rateLimits: { result: rateLimits({ ...figures, resetsAt: FAR_RESET, secondaryResetsAt: FAR_RESET }) } });

async function withCodex(behaviour: object, args: string[], prepare?: (box: ReturnType<typeof sandbox>, stateDir: string) => void) {
  const r = await scenario({ body: LIVE.moderate }, args, {}, (box) => {
    writeFileSync(box.models, BASELINE.replace("| cursor      | `retired-model`", `${CODEX_ROW}| cursor      | \`retired-model\``));
    writeFakeCodex(box.bin, behaviour);
    prepare?.(box, join(box.dir, "usage-state"));
  });
  return r;
}

function usageReads(box: { bin: string }) {
  return fakeCodexCalls(box.bin).filter((call: { method?: string }) => call.method === "account/rateLimits/read").length;
}

test("a reading is taken before planning and the plan exposes it with its provenance", async () => {
  const r = await withCodex(farFuture({ primary: 40 }), [...CODEX, "--record", "spec.md"], (box) => writeFileSync(join(box.dir, "spec.md"), "# spec\n"));
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(usageReads(r.box), 1);
    assert.equal(r.json.status, "recommended");
    assert.equal(r.json.recommendation.usage, "fresh");
    assert.match(r.json.recommendation.usageScope.account, /^sha256:[0-9a-f]{16}$/);
    assert.equal(r.json.usage.status, "fresh");
    assert.equal(r.json.usage.capacityConfirmed, true);
    assert.equal(r.json.usage.source.kind, "codex-app-server-rate-limits");
    assert.ok(Date.parse(r.json.usage.observedAt) > 0);
    assert.equal(r.json.usage.resetsAt, new Date(FAR_RESET * 1000).toISOString());
    assert.equal(r.json.usage.freshness, "fresh");
    assert.equal(r.json.usage.refresh.attempted, true);
    assert.ok("lastSuccessAt" in r.json.usage.collector);
    assert.equal(r.json.usageByAgent.codex.status, "fresh");
    assert.ok(r.json.usageByCandidate["codex/gpt-6.1-terra"]);
    assert.deepEqual(r.json.usage, r.json.usageByCandidate["codex/gpt-6.1-terra"]);
    assert.equal(r.json.decision.warning, null);
    assert.match(r.json.recommendation.reason, /codex\/gpt-6\.1-terra\/max:.*(5h limit 40(?:\.0)?% used|Weekly limit 64(?:\.0)?% used)/);
    assert.match(
      r.spec("spec.md"),
      /^- Usage: fresh — (?:5h limit 40(?:\.0)?% used|Weekly limit 64(?:\.0)?% used) \(account sha256:[0-9a-f]{16}, host .+; read .* from codex-app-server-rate-limits\)$/m,
    );

    const store = new UsageStore(join(r.box.dir, "usage-state"));
    assert.equal(store.listReadings()[0].origin, "planner");
    store.close();
  } finally {
    clean(r.box);
  }
});

test("a collected agent without local credentials stays unknown beside a confirmed Codex reading", async () => {
  const r = await withCodex(farFuture({}), []);
  try {
    assert.equal(r.json.recommendation.agent, "claude");
    assert.equal(r.json.recommendation.usage, "unknown");
    assert.equal(r.json.usage.status, "unknown");
    assert.equal(r.json.usageByAgent.claude.refresh.attempted, true);
    assert.equal(r.json.usageByAgent.claude.capacityConfirmed, false);
    assert.match(r.json.recommendation.reason, /capacity is not confirmed/);
    const codex = r.json.alternatives.find((c: { agent: string }) => c.agent === "codex");
    assert.equal(codex.usage, "fresh");
    assert.equal(r.json.usageByAgent.codex.status, "fresh");
  } finally {
    clean(r.box);
  }
});

test("exhausted Codex usage rejects the candidate and names the reset", async () => {
  const r = await withCodex(farFuture({ primary: 100, allowed: false, reached: "rate_limit_reached" }), CODEX);
  try {
    assert.equal(r.status, 1);
    assert.equal(r.json.status, "no-suitable-candidate");
    assert.equal(r.json.decision, null);
    const [rejected] = r.json.rejected;
    assert.equal(rejected.agent, "codex");
    assert.equal(rejected.usage, "exhausted");
    assert.match(rejected.reason, /codex\/gpt-6\.1-terra\/max usage is exhausted: 5h limit 100(?:\.0)?% used/);
    assert.match(rejected.reason, /2100/);
    assert.equal(r.json.usageByAgent.codex.status, "exhausted");
    assert.equal(r.json.usageByAgent.codex.capacityConfirmed, false);
  } finally {
    clean(r.box);
  }
});

test("an override onto exhausted usage is refused and prints the usage reading", async () => {
  const r = await withCodex(farFuture({ primary: 100, allowed: false, reached: "rate_limit_reached" }), ["--override", "codex/gpt-6.1-terra/max", "--override-reason", "only codex knows this area"]);
  try {
    assert.equal(r.status, 1);
    assert.equal(r.json.status, "override-refused");
    assert.equal(r.json.usage.status, "exhausted");
    assert.match(r.stderr, /override usage: exhausted/);
    assert.match(r.stderr, /override refused: codex\/gpt-6\.1-terra\/max/);
  } finally {
    clean(r.box);
  }
});

test("low usage stays recommendable with a caution", async () => {
  const r = await withCodex(farFuture({ primary: 93 }), CODEX);
  try {
    assert.equal(r.json.status, "recommended");
    assert.equal(r.json.recommendation.usage, "low");
    assert.match(r.json.decision.warning, /codex\/gpt-6\.1-terra\/max usage is low: 5h limit 93(?:\.0)?% used/);
    assert.match(r.json.recommendation.reason, /5h limit 93(?:\.0)?% used, low/);
  } finally {
    clean(r.box);
  }
});

test("a provider failure leaves usage unavailable with the failure reason, never confirmed, and the plan continues", async () => {
  for (const behaviour of [{ rateLimits: { error: REAL_ERRORS.http500 } }, { exitCode: 1 }]) {
    const r = await withCodex(behaviour, CODEX);
    try {
      assert.equal(r.json.status, "recommended");
      assert.equal(r.json.recommendation.usage, "unavailable");
      assert.equal(r.json.usage.status, "unavailable");
      assert.equal(r.json.usage.capacityConfirmed, false);
      assert.equal(r.json.usage.refresh.ok, false);
      assert.match(r.json.recommendation.reason, /provider data unavailable \(/);
      assert.doesNotMatch(r.json.recommendation.reason, /snapshot|Usage is unknown/);
    } finally {
      clean(r.box);
    }
  }
});

test("an unknown login leaves usage unknown, never available, and the plan continues", async () => {
  const r = await withCodex({ rateLimits: { error: REAL_ERRORS.noLogin } }, CODEX);
  try {
    assert.equal(r.json.status, "recommended");
    assert.equal(r.json.recommendation.usage, "unknown");
    assert.equal(r.json.usage.capacityConfirmed, false);
    assert.equal(r.json.usage.refresh.ok, false);
    assert.match(r.json.recommendation.reason, /Usage is unknown, so capacity is not confirmed/);
    assert.doesNotMatch(r.json.recommendation.reason, /snapshot|provider data unavailable/);
  } finally {
    clean(r.box);
  }
});

test("a stale reading is shown as stale and does not confirm capacity", async () => {
  const seedStale = (_box: unknown, stateDir: string) => {
    const store = new UsageStore(stateDir);
    const observedAt = new Date(Date.now() - 45 * 60_000);
    const windows = [{ id: "codex-5h", limitId: "codex", kind: "five_hour", label: "5h limit", durationMinutes: 300, usedPercent: 10, remainingPercent: 90, resetsAt: new Date(FAR_RESET * 1000).toISOString(), exhausted: false }];
    store.recordAttempt({
      provider: "codex",
      origin: "poll",
      attemptedAt: observedAt,
      observation: { provider: "codex", observedAt: observedAt.toISOString(), status: "available", reason: null, detail: null, windows, exhaustedWindows: [], scope: { host: "andi", account: "sha256:0123456789abcdef" }, source: { kind: "codex-app-server-rate-limits" } },
    });
    store.close();
  };
  const r = await withCodex({ rateLimits: { error: REAL_ERRORS.http500 } }, CODEX, seedStale);
  try {
    assert.equal(r.json.status, "recommended");
    assert.equal(r.json.recommendation.usage, "stale");
    assert.equal(r.json.usage.capacityConfirmed, false);
    assert.match(r.json.recommendation.reason, /codex\/gpt-6\.1-terra\/max:.*stale \(.*older_than_30_minutes/);
  } finally {
    clean(r.box);
  }
});

test("the exhausted live reply from this account is read end to end", async () => {
  const r = await withCodex({ rateLimits: { result: REAL_EXHAUSTED } }, CODEX);
  try {
    // Its reset was on 2026-10-30, so what it says depends on when the test runs; it never confirms capacity.
    assert.equal(r.json.usageByAgent.codex.capacityConfirmed, false);
    assert.ok(["exhausted", "stale"].includes(r.json.usageByAgent.codex.status));
  } finally {
    clean(r.box);
  }
});

test("a baseline with no collected agent starts no reader and creates no state", async () => {
  const r = await scenario({ body: LIVE.moderate }, [], {}, (box) => {
    // Only an agent outside PROVIDERS: the collector must not open state or poll.
    writeFileSync(
      box.models,
      `# Verified Subagent Models

| Agent       | Model ID              | Supported effort values | Capability      | Suits                | Last verified |
| ----------- | --------------------- | ----------------------- | --------------- | -------------------- | ------------- |
| manual      | \`hand-picked\`         | none                    | standard        | Manual only          | 2026-10-30    |

## Usage limits

| Not | A model row |
| --- | ----------- |
| x   | y           |
`,
    );
  });
  try {
    assert.deepEqual(r.json.usageByAgent, {});
    assert.equal(existsSync(join(r.box.dir, "usage-state")), false);
  } finally {
    clean(r.box);
  }
});

test("a multi-provider baseline refreshes every collected reader before recommending", async () => {
  const r = await scenario({ body: LIVE.moderate });
  try {
    assert.equal(r.status, 0, r.stderr);
    for (const name of ["claude", "cursor", "antigravity"]) {
      assert.ok(r.json.usageByAgent[name], `usageByAgent must include ${name}`);
      assert.equal(r.json.usageByAgent[name].capacityConfirmed, false);
      assert.equal(r.json.usageByAgent[name].refresh.attempted, true);
    }
    assert.ok(existsSync(join(r.box.dir, "usage-state", "usage.sqlite")));
  } finally {
    clean(r.box);
  }
});

// --- Recording the choice

const templateSpec = "# Feature Worker Spec\n\nRules.\n\n## Model choice\n\n- Agent: <agent>\n- Model: <model_id>\n- Effort: <effort>\n- Why: <why>\n\n## Task\n\n- Issue: #105\n\n### Owner defaults\n\n- keep\n";

test("the accepted recommendation fills the Model choice section and leaves the rest of the spec", async () => {
  const r = await scenario({ body: LIVE.deep }, ["--record", "spec.md"], {}, (box) => writeFileSync(join(box.dir, "spec.md"), templateSpec));
  try {
    const spec = r.spec("spec.md");
    assert.match(spec, /^- Agent: claude$/m);
    assert.match(spec, /^- Model: claude-opus-5-5$/m);
    assert.match(spec, /^- Effort: high$/m);
    assert.match(spec, /^- Why: .*reasoning-heavy.*$/m);
    assert.match(spec, /^- Decision: recommendation accepted$/m);
    assert.match(spec, /^- Assessment: .*jev-1\.14\.0.*$/m);
    assert.match(spec, /^- Usage: unknown/m);
    assert.doesNotMatch(spec, /<model_id>/);
    assert.equal(spec.match(/## Model choice/g)?.length, 1);
    assert.ok(spec.startsWith("# Feature Worker Spec\n\nRules.\n\n## Model choice\n"));
    assert.ok(spec.endsWith("\n\n## Task\n\n- Issue: #105\n\n### Owner defaults\n\n- keep\n"));
  } finally {
    clean(r.box);
  }
});

test("a spec with no Model choice section gets one appended", async () => {
  const r = await scenario({ body: LIVE.mechanical }, ["--record", "spec.md"], {}, (box) => writeFileSync(join(box.dir, "spec.md"), "# Spec\n"));
  try {
    assert.match(r.spec("spec.md"), /^# Spec\n\n## Model choice\n\n- Agent: antigravity\n- Model: gemini-4-argon-high\n- Effort: none\n/);
  } finally {
    clean(r.box);
  }
});

test("recording twice keeps one section, and the coordinator's text cannot add lines or sections", async () => {
  const box = sandbox();
  const jev = await fakeJev({ body: LIVE.deep });
  try {
    const spec = join(box.dir, "spec.md");
    writeFileSync(spec, templateSpec);
    await recommend(box, ["--record", "spec.md"], jev.url);
    const r = await recommend(box, ["--record", "spec.md", "--override", "claude/claude-sonnet-5-5/high", "--override-reason", "Weighs $& less\n\n## Task\n- forged"], jev.url);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(spec, "utf8");
    assert.equal(text.match(/^## Model choice$/gm)?.length, 1);
    assert.equal(text.match(/^## Task$/gm)?.length, 1);
    assert.match(text, /Weighs \$& less ## Task - forged/);
  } finally {
    await jev.close();
    clean(box);
  }
});

test("a coordinator override and its reason are recorded next to the recommendation", async () => {
  const r = await scenario({ body: LIVE.moderate }, ["--override", "cursor/composer-2.5", "--override-reason", "Spreading work across providers", "--record", "spec.md"], {}, (box) =>
    writeFileSync(join(box.dir, "spec.md"), templateSpec),
  );
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.status, "overridden");
    assert.equal(named(r.json.recommendation), "claude/claude-sonnet-5-5/medium");
    assert.equal(named(r.json.decision), "cursor/composer-2.5");
    assert.equal(r.json.decision.kind, "override");
    assert.deepEqual(r.json.launch.args, ["--agent", "cursor", "--model", "composer-2.5"]);
    const spec = r.spec("spec.md");
    assert.match(spec, /^- Agent: cursor$/m);
    assert.match(spec, /^- Why: Spreading work across providers$/m);
    assert.match(spec, /^- Decision: coordinator override of claude\/claude-sonnet-5-5\/medium$/m);
    assert.equal(existsSync(r.box.orcaLog), false);
  } finally {
    clean(r.box);
  }
});

test("an override below the assessed requirement is allowed with a recorded warning", async () => {
  const r = await scenario({ body: LIVE.deep }, ["--override", "claude/claude-sonnet-5-5/high", "--override-reason", "Opus is rate limited", "--record", "spec.md"], {}, (box) =>
    writeFileSync(join(box.dir, "spec.md"), templateSpec),
  );
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.json.decision.warning, /standard.*below.*reasoning-heavy/);
    assert.match(r.spec("spec.md"), /^- Warning: .*below.*$/m);
  } finally {
    clean(r.box);
  }
});

test("an override can stand when no eligible candidate is suitable", async () => {
  const r = await scenario({ body: LIVE.deep }, ["--eligible", "antigravity/gemini-4-argon-high", "--override", "claude/claude-sonnet-5-5/high", "--override-reason", "Best available", "--record", "spec.md"], {}, (box) =>
    writeFileSync(join(box.dir, "spec.md"), templateSpec),
  );
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.status, "overridden");
    assert.equal(r.json.recommendation, null);
    assert.match(r.spec("spec.md"), /^- Decision: coordinator override of no suitable recommendation$/m);
  } finally {
    clean(r.box);
  }
});

test("an override outside the baseline is refused and nothing is recorded", async () => {
  for (const override of ["claude/gpt-nonsense", "claude/claude-sonnet-5-5/max", "claude/claude-sonnet-5-5", "cursor/retired-model"]) {
    const r = await scenario({ body: LIVE.moderate }, ["--override", override, "--override-reason", "Because", "--record", "spec.md"], {}, (box) =>
      writeFileSync(join(box.dir, "spec.md"), templateSpec),
    );
    try {
      assert.equal(r.status, 1, override);
      assert.equal(r.json.status, "override-refused");
      assert.equal(r.json.launch, null);
      assert.equal(r.spec("spec.md"), templateSpec);
      assert.match(r.stderr, /override/);
    } finally {
      clean(r.box);
    }
  }
});

test("an override cannot stand in for an assessment", async () => {
  const r = await scenario({ status: 500, body: {} }, ["--override", "cursor/composer-2.5", "--override-reason", "Because"]);
  try {
    assert.equal(r.status, 3);
    assert.equal(r.json.status, "needs-judgment");
    assert.equal(r.json.decision, null);
  } finally {
    clean(r.box);
  }
});

test("a baseline that cannot be parsed is named in the error", async () => {
  const r = await scenario({ body: LIVE.deep }, [], {}, (box) => writeFileSync(box.models, "no table here\n"));
  try {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /capability baseline.*no table/);
    assert.equal(r.jev.requests.length, 0);
  } finally {
    clean(r.box);
  }
});

test("usage errors exit 2 before Jev is called", async () => {
  const cases = [
    [],
    ["--task", "1"],
    ["--task", "1", "--summary", "s", "--bogus", "1"],
    ["--task", "1", "--summary", "s", "--kind", "banana"],
    ["--task", "1", "--summary", "s", "--files", "many"],
    ["--task", "1", "--summary", "s", "--judgment", "easy", "--judgment-reason", "r"],
    ["--task", "1", "--summary", "s", "--judgment", "standard"],
    ["--task", "1", "--summary", "s", "--override", "cursor/composer-2.5"],
    ["--task", "1", "--summary", "s", "--override", "cursor", "--override-reason", "r"],
    ["--task", "1", "--summary", "s", "--eligible", "cursor"],
    ["--task", "1", "--summary", "s", "--record", "no-such-spec.md"],
  ];
  const box = sandbox();
  const jev = await fakeJev({ body: LIVE.deep });
  try {
    for (const args of cases) {
      const child = spawnSync(process.execPath, [script, ...args], {
        cwd: box.dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${box.bin}:${process.env.PATH}`, TYPESAFE_API_KEY: API_KEY, ORCA_RECOMMEND_JEV_URL: "http://127.0.0.1:9/" },
      });
      assert.equal(child.status, 2, args.join(" "));
      assert.match(child.stderr, /[Uu]sage/);
    }
  } finally {
    await jev.close();
    clean(box);
  }
});

test("rejects whitespace-only summaries and reasons and option values that are flags", async () => {
  const cases = [
    ["--task", "1", "--summary", "   \t\n"],
    ["--task", "   ", "--summary", "valid summary"],
    ["--task", "1", "--summary", "valid", "--override", "cursor/composer-2.5", "--override-reason", "   \n\t "],
    ["--task", "1", "--summary", "valid", "--override", "cursor/composer-2.5", "--override-reason", ""],
    ["--task", "1", "--summary", "valid", "--judgment", "standard", "--judgment-reason", "   "],
    ["--task", "1", "--summary", "valid", "--judgment", "standard", "--judgment-reason", ""],
    ["--task", "1", "--summary", "valid", "--override", "cursor/composer-2.5", "--override-reason", "--help"],
    ["--task", "1", "--summary", "--kind", "--files", "2"],
  ];
  const box = sandbox();
  const jev = await fakeJev({ body: LIVE.deep });
  try {
    for (const args of cases) {
      const child = await new Promise<{ status: number | null; stderr: string }>((done) => {
        const proc = spawn(process.execPath, [script, "--models", box.models, ...args], {
          cwd: box.dir,
          env: { ...process.env, PATH: `${box.bin}:${process.env.PATH}`, TYPESAFE_API_KEY: API_KEY, ORCA_RECOMMEND_JEV_URL: jev.url },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => (stderr += chunk));
        proc.on("close", (status) => done({ status, stderr }));
      });
      assert.equal(child.status, 2, args.join(" "));
      assert.match(child.stderr, /[Uu]sage/);
    }
    assert.equal(jev.requests.length, 0);
  } finally {
    await jev.close();
    clean(box);
  }
});

test("recording an inconclusive fallback includes Jev version and uncertainty, and a directory record path exits non-zero cleanly", async () => {
  const fallbackRun = await scenario(
    { body: { ...LIVE.moderateMaybeWide, model: "jev-1.15.0" } },
    ["--judgment", "reasoning-heavy", "--judgment-reason", "Crosses sync boundary", "--record", "spec.md"],
    {},
    (box) => writeFileSync(join(box.dir, "spec.md"), templateSpec),
  );
  const dirRun = await scenario({ body: LIVE.deep }, ["--record", "spec-dir"], {}, (box) => mkdirSync(join(box.dir, "spec-dir")));
  try {
    assert.equal(fallbackRun.status, 0, fallbackRun.stderr);
    const spec = fallbackRun.spec("spec.md");
    assert.match(spec, /Fallback: coordinator judgment reasoning-heavy because Jev was inconclusive/);
    assert.match(spec, /jev-1\.15\.0/);
    assert.match(spec, /reasoning score 1\.18/);
    assert.match(spec, /reasoning confidence 0\.73/);
    assert.match(spec, /"1":0\.82/);
    assert.match(spec, /"2":0\.18/);
    assert.match(spec, /enough information 0\.33/);
    assert.match(spec, /wide change 0\.66/);

    assert.equal(dirRun.status, 1);
    assert.equal(dirRun.json, null);
    assert.match(dirRun.stderr, /spec-dir/);
    assert.doesNotMatch(dirRun.stderr, /at Object\.|at main/);
  } finally {
    clean(fallbackRun.box);
    clean(dirRun.box);
  }
});

test("redacts TYPESAFE_API_KEY from Jev version and from summary and reason inputs", async () => {
  const okRun = await scenario(
    { body: { ...LIVE.moderate, model: `jev-1.14.0-${API_KEY}` } },
    ["--summary", `Fix parser using ${API_KEY}`, "--override", "cursor/composer-2.5", "--override-reason", `Prefer cursor (${API_KEY})`, "--record", "spec.md"],
    {},
    (box) => writeFileSync(join(box.dir, "spec.md"), templateSpec),
  );
  const invalidRun = await scenario(
    { body: { model: `jev-bad-${API_KEY}`, answers: {} } },
    ["--judgment", "standard", "--judgment-reason", `Manual judgment (${API_KEY})`, "--record", "spec.md"],
    {},
    (box) => writeFileSync(join(box.dir, "spec.md"), templateSpec),
  );
  try {
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.equal(JSON.stringify(okRun.jev.requests[0].body).includes(API_KEY), false);
    assert.match(okRun.jev.requests[0].body.state.task, /\[redacted\]/);
    assert.equal(`${okRun.stdout}${okRun.stderr}${okRun.spec("spec.md")}`.includes(API_KEY), false);
    assert.match(okRun.json.assessment.jev.version, /\[redacted\]/);
    assert.match(okRun.json.decision.reason, /\[redacted\]/);
    assert.match(okRun.spec("spec.md"), /\[redacted\]/);

    assert.equal(invalidRun.status, 0, invalidRun.stderr);
    assert.equal(`${invalidRun.stdout}${invalidRun.stderr}${invalidRun.spec("spec.md")}`.includes(API_KEY), false);
    assert.match(invalidRun.json.assessment.jev.version, /\[redacted\]/);
    assert.match(invalidRun.json.assessment.coordinator.reason, /\[redacted\]/);
    assert.match(invalidRun.spec("spec.md"), /\[redacted\]/);
  } finally {
    clean(okRun.box);
    clean(invalidRun.box);
  }
});

test("parseBaseline treats a backticked none effort as no effort", async () => {
  const r = await scenario({ body: LIVE.mechanical }, ["--record", "spec.md"], {}, (box) => {
    writeFileSync(box.models, BASELINE.replace("| `gemini-4-argon-high` | none                    |", "| `gemini-4-argon-high` | `none`                  |"));
    writeFileSync(join(box.dir, "spec.md"), templateSpec);
  });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.recommendation.effort, null);
    assert.deepEqual(r.json.launch.args, ["--agent", "antigravity", "--model", "gemini-4-argon-high"]);
    assert.match(r.spec("spec.md"), /^- Effort: none$/m);
  } finally {
    clean(r.box);
  }
});

// --- The launch stays as it was

function spawnBox() {
  const box = sandbox();
  const workspaces = join(box.dir, "ws");
  const repo = join(box.dir, "repo");
  mkdirSync(workspaces);
  mkdirSync(repo);
  writeFileSync(join(repo, "AGENTS.md"), "# agents\n");
  writeFileSync(join(repo, "CLAUDE.md"), "# claude\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "AGENTS.md", "CLAUDE.md"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]]) {
    const g = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (g.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${g.stderr}`);
  }
  const g = spawnSync("git", ["worktree", "add", "-q", "-b", "jahnzh/wt", join(workspaces, "wt")], { cwd: repo, encoding: "utf8" });
  if (g.status !== 0) throw new Error(`git worktree add failed: ${g.stderr}`);
  writeFileSync(join(box.dir, "spec.md"), templateSpec);
  stub(box.bin, "orca", `echo "$@" >> "${box.dir}/orca.log"\ncat "${box.dir}/receipt"\nexit $(cat "${box.dir}/exitcode" 2>/dev/null || echo 0)`);
  stub(box.bin, "codegraph", "true");
  stub(box.bin, "df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/fake 102626232 1000 99999999 1% /"`);
  const launch = (args: string[], doc: string[] = []) =>
    spawnSync("bash", [spawnScript, "--spec-file", join(box.dir, "spec.md"), "--name", "wt", "--base", "HEAD", ...args, ...doc], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${box.bin}:${process.env.PATH}`, ORCA_SPAWN_WORKSPACES: workspaces, ORCA_PREFLIGHT_REPO: repo, ORCA_PREFLIGHT_DF: join(box.bin, "df"), ORCA_CLI_COMMAND: "orca" },
    });
  return { box, launch, workerStarts: () => (existsSync(box.orcaLog) ? readFileSync(box.orcaLog, "utf8").split("worker-start").length - 1 : 0) };
}

async function recommendFor(box: ReturnType<typeof sandbox>, body: unknown) {
  const jev = await fakeJev({ body });
  try {
    const r = await recommend(box, ["--record", "spec.md"], jev.url);
    assert.equal(r.status, 0, r.stderr);
    return r.json;
  } finally {
    await jev.close();
  }
}

const receiptFor = (model: string) => JSON.stringify({ ok: true, result: { dispatchId: "ctx_abc", launch: { effective: { model } }, effects: [] } });

test("the recommended arguments and recorded spec launch through orca-spawn.sh unchanged", async () => {
  const { box, launch, workerStarts } = spawnBox();
  try {
    const plan = await recommendFor(box, LIVE.deep);
    writeFileSync(join(box.dir, "receipt"), receiptFor("claude-opus-5-5"));
    const r = launch(plan.launch.args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(workerStarts(), 1);
    const log = readFileSync(box.orcaLog, "utf8");
    assert.match(log, /--agent claude --model claude-opus-5-5 --effort high --json/);
    assert.match(log, /- Decision: recommendation accepted/);
  } finally {
    clean(box);
  }
});

test("the launch still needs an explicit model after a recommendation", async () => {
  const { box, launch, workerStarts } = spawnBox();
  try {
    const plan = await recommendFor(box, LIVE.deep);
    const r = launch(plan.launch.args.slice(0, 2));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--model/);
    assert.equal(workerStarts(), 0);
  } finally {
    clean(box);
  }
});

test("a preflight failure still stops a recommended launch", async () => {
  const { box, launch, workerStarts } = spawnBox();
  try {
    const plan = await recommendFor(box, LIVE.deep);
    const r = launch(plan.launch.args, ["--doc", "NO_SUCH_DOC.md"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /missing doc: NO_SUCH_DOC\.md/);
    assert.equal(workerStarts(), 0);
  } finally {
    clean(box);
  }
});

test("the receipt check still catches a different effective model", async () => {
  const { box, launch, workerStarts } = spawnBox();
  try {
    const plan = await recommendFor(box, LIVE.deep);
    writeFileSync(join(box.dir, "receipt"), receiptFor("claude-sonnet-5-5"));
    const r = launch(plan.launch.args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /effective model 'claude-sonnet-5-5' differs from requested 'claude-opus-5-5'/);
    assert.equal(workerStarts(), 1, "the wrapper must not retry");
  } finally {
    clean(box);
  }
});

test("an ambiguous launch shows the recovery details and is not retried", async () => {
  const { box, launch, workerStarts } = spawnBox();
  try {
    const plan = await recommendFor(box, LIVE.deep);
    // Field names from the disposition builder in Orca CLI 0.1.0+4402cbac17e5; an outcome_unknown launch has not been observed live.
    writeFileSync(
      join(box.dir, "receipt"),
      JSON.stringify({
        ok: false,
        result: {
          dispatchId: "ctx_unknown",
          state: "outcome_unknown",
          effects: [],
          residualResources: [],
          recovery: {
            disposition: "outcome_unknown",
            workerDeathInferred: false,
            queryCommand: ["orca", "orchestration", "worker-show", "--dispatch", "ctx_unknown", "--json"],
          },
        },
      }),
    );
    writeFileSync(join(box.dir, "exitcode"), "1");
    const r = launch(plan.launch.args);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /dispatch: ctx_unknown/);
    assert.match(r.stderr, /outcome_unknown/);
    assert.match(r.stderr, /worker-show/);
    assert.equal(workerStarts(), 1, "the wrapper must not retry");
  } finally {
    clean(box);
  }
});

test("a cursor model removed after the recommendation is still refused at launch", async () => {
  const { box, launch, workerStarts } = spawnBox();
  try {
    writeFileSync(box.models, BASELINE.replace(/^\| (claude|antigravity).*\n/gm, ""));
    const plan = await recommendFor(box, LIVE.moderate);
    assert.equal(named(plan.recommendation), "cursor/composer-2.5");
    writeFileSync(join(box.dir, "agent-models"), "Available models\n\nauto - Auto (default)\n");
    const r = launch(plan.launch.args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown cursor model: composer-2\.5/);
    assert.equal(workerStarts(), 0);
  } finally {
    clean(box);
  }
});

// --- The documented baseline

test("every row of docs/agents/models.md has a capability the command can use", async () => {
  const box = sandbox();
  const jev = await fakeJev({ body: LIVE.moderate });
  try {
    box.models = join(repoRoot, "docs", "agents", "models.md");
    const r = await recommend(box, [], jev.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.rejected.filter((c: any) => /capability$/.test(c.reason) && !/below/.test(c.reason)).length, 0, JSON.stringify(r.json.rejected));
    assert.ok(r.json.alternatives.length > 0);
    assert.ok(existsSync(join(box.dir, "codex.log")), "the usage read went to the stub, not the installed codex");
    assert.equal(r.json.usageByAgent.codex.status, "unavailable");
    assert.equal(r.json.usageByAgent.codex.capacityConfirmed, false);
  } finally {
    await jev.close();
    clean(box);
  }
});

test("the worker docs tell the coordinator how to recommend, fall back and recover", () => {
  const spec = readFileSync(join(repoRoot, "docs", "agents", "worker-spec.md"), "utf8");
  const models = readFileSync(join(repoRoot, "docs", "agents", "models.md"), "utf8");
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(spec, /## Recommend a worker/);
  assert.match(spec, /scripts\/orca-recommend\.mjs/);
  assert.match(spec, /--judgment/);
  assert.match(spec, /--override/);
  assert.match(spec, /TYPESAFE_API_KEY/);
  assert.doesNotMatch(spec, /TYPESAFE_API_KEY=/, "the example must not put the key on a command line");
  assert.match(spec, /worker-show/, "must say to inspect a failed or ambiguous launch before retrying");
  assert.match(models, /Capability/);
  assert.match(agents, /scripts\/orca-recommend\.mjs/);
});
