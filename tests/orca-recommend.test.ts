import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  mkdirSync(bin);
  writeFileSync(join(dir, "models.md"), BASELINE);
  writeFileSync(join(dir, "agent-models"), AGENT_MODELS);
  stub(bin, "agent", `cat "${dir}/agent-models"\nexit $(cat "${dir}/agent-exit" 2>/dev/null || echo 0)`);
  stub(bin, "orca", `echo "$@" >> "${dir}/orca.log"`);
  return { dir, bin, orcaLog: join(dir, "orca.log"), models: join(dir, "models.md") };
}

function recommend(box: ReturnType<typeof sandbox>, args: string[], jevUrl: string, env: Record<string, string | undefined> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; json: any }>((done) => {
    const child = spawn(process.execPath, [script, "--task", "105", "--summary", "Add a parser with unit tests", "--models", box.models, ...args], {
      cwd: box.dir,
      env: { ...process.env, PATH: `${box.bin}:${process.env.PATH}`, TYPESAFE_API_KEY: API_KEY, ORCA_RECOMMEND_JEV_URL: jevUrl, ...env },
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

test("a tie between two reasoning levels takes the higher one", async () => {
  const r = await scenario({ body: liveBody(0.5, 1.5, 0.5, { "0": 0, "1": 0.5, "2": 0.5 }, 0.1) });
  try {
    assert.equal(r.json.assessment.requirement, "reasoning-heavy");
  } finally {
    clean(r.box);
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
    assert.equal(r.json.assessment.jev.uncertainty.reasoningConfidence, 0.98);
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

test("usage is reported as unknown overall and for every candidate", async () => {
  const r = await scenario({ body: LIVE.moderate });
  try {
    assert.deepEqual(r.json.usage, { status: "unknown", reason: "no verified usage collector is connected", source: null, observedAt: null });
    assert.equal(r.json.recommendation.usage, "unknown");
    assert.ok(r.json.alternatives.length > 0);
    for (const alternative of r.json.alternatives) assert.equal(alternative.usage, "unknown");
    assert.match(r.json.recommendation.reason, /[Uu]sage is unknown/);
    assert.doesNotMatch(r.stdout, /"available"|"fresh"/);
  } finally {
    clean(r.box);
  }
});

test("equivalent candidates are not ordered as though usage were known", async () => {
  const r = await scenario({ body: LIVE.moderate });
  try {
    assert.match(r.json.recommendation.reason, /not balanced/);
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
