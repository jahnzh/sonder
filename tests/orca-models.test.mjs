import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/orca-models.mjs", import.meta.url));

// Lines sampled from `agy models` and `agent --list-models` on 2026-10-31.
const agyModels = `gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)`;
const cursorModels = `Available models

auto - Auto (current, default)
gpt-5.3-codex-low - Codex 5.3 Low
composer-2.5 - Composer 2.5`;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sonder-models-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(root, "docs", "agents"), { recursive: true });
  writeFileSync(path.join(root, "docs", "agents", "models.md"), `# Verified models

| Agent | Model ID | Supported effort values | Capability | Suits |
| --- | --- | --- | --- | --- |
| antigravity | \`gemini-3.8-flash-high\` | none | mechanical | Small tasks |
| antigravity | \`claude-opus-5-5-high\` | none | reasoning-heavy | Analysis |
| cursor | \`auto\` | none | standard | Analysis |
| claude | \`claude-opus-5-5\` | \`high\` | reasoning-heavy | Analysis |
| codex | \`gpt-6.1-terra\` | \`max\` | standard | Analysis |
`);
  const command = (name, text) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${text}\n`);
    chmodSync(file, 0o755);
  };
  command("agy", `printf '%s\\n' '${agyModels}'`);
  command("agent", `printf '%s\\n' '${cursorModels}'`);
  command("claude", "printf 'Commands:\\n  agents  Manage background agents\\n'");
  command("codex", "printf 'Commands:\\n  exec  Run Codex non-interactively\\n'");
  return {
    root,
    command,
    run: (...args) => spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, PATH: bin, ORCA_USAGE_STATE_DIR: path.join(root, "state") },
      encoding: "utf8",
    }),
    seed: (observations) => {
      const state = path.join(root, "state");
      mkdirSync(state, { recursive: true });
      const db = new DatabaseSync(path.join(state, "usage.sqlite"));
      db.exec("CREATE TABLE readings (id INTEGER PRIMARY KEY, provider TEXT, observed_at TEXT, usable INTEGER, observation TEXT)");
      const insert = db.prepare("INSERT INTO readings (provider, observed_at, usable, observation) VALUES (?, ?, ?, ?)");
      for (const observation of observations) insert.run(observation.provider, observation.observedAt, 1, JSON.stringify(observation));
      db.close();
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("list discovers provider models and reports documented-only providers", () => {
  const f = fixture();
  try {
    const result = f.run("list", "--json");
    assert.equal(result.status, 0, result.stderr);
    const { providers } = JSON.parse(result.stdout);
    assert.deepEqual(providers.antigravity.models.map((model) => model.id), [
      "gemini-4-argon-medium", "gemini-3.8-flash-high", "claude-sonnet-5-5-medium",
    ]);
    assert.equal(providers.cursor.count, 3);
    assert.deepEqual(providers.cursor.models.map((model) => model.id), ["auto", "gpt-5.3-codex-low", "composer-2.5"]);
    assert.equal(providers.claude.message, "no provider list available");
    assert.equal(providers.codex.message, "no provider list available");
    assert.deepEqual(providers.claude.models.map((model) => model.id), ["claude-opus-5-5"]);
    assert.deepEqual(providers.codex.models.map((model) => model.id), ["gpt-6.1-terra"]);
  } finally {
    f.close();
  }
});

// Sanitized shapes from the collector's Antigravity and Cursor observations; timestamps are made current.
function observations() {
  const observedAt = new Date().toISOString();
  return [
    {
      provider: "antigravity", status: "available", observedAt,
      windows: [
        { id: "gemini-weekly", kind: "weekly", group: "Gemini Models", usedPercent: 8.65, remainingFraction: 0.9135, exhausted: false },
        { id: "3p-weekly", kind: "weekly", group: "Claude and GPT models", usedPercent: 0, remainingFraction: 1, exhausted: false },
        { id: "gemini-argon-wtu-weekly", kind: "weekly", group: "Gemini 4 Argon", usedPercent: 100, remainingFraction: 0, exhausted: true },
      ],
      groups: [
        { name: "Gemini Models", models: ["Gemini Flash", "Gemini Pro"], windowIds: ["gemini-weekly"] },
        { name: "Claude and GPT models", models: ["Claude Opus", "Claude Sonnet", "GPT-OSS"], windowIds: ["3p-weekly"] },
        { name: "Gemini 4 Argon", models: ["Gemini 4 Argon"], windowIds: ["gemini-argon-wtu-weekly"] },
      ],
    },
    {
      provider: "cursor", status: "limited", observedAt, observedAtMs: Date.parse(observedAt),
      scope: { account: { known: true } }, reset: {},
      windows: [
        { id: "included_total", kind: "percentage_allowance", usedPercent: 29, remainingPercent: 71 },
        { id: "included_auto", kind: "percentage_allowance", usedPercent: 25, remainingPercent: 75, modelScopeKnown: true, applicableModels: ["auto", "default", "composer-2.5"] },
        { id: "included_api", kind: "percentage_allowance", usedPercent: 100, remainingPercent: 0, modelScopeKnown: true },
      ],
    },
  ];
}

test("diff assesses each model's collector bucket and flags candidates, stale rows and unmapped models", () => {
  const f = fixture();
  try {
    f.seed(observations());
    f.command("agy", `printf '%s\\n' '${agyModels}\nmystery-model\tMystery model'`);
    const result = f.run("diff");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /antigravity\/gemini-3\.8-flash-high.*verified.*mechanical.*gemini-weekly.*fresh/);
    assert.match(result.stdout, /antigravity\/claude-sonnet-5-5-medium.*UNVERIFIED.*3p-weekly.*fresh.*CANDIDATE/);
    assert.match(result.stdout, /antigravity\/gemini-4-argon-medium.*UNVERIFIED.*gemini-argon-wtu-weekly.*exhausted/);
    assert.doesNotMatch(result.stdout, /antigravity\/gemini-4-argon-medium[^\n]*CANDIDATE/);
    assert.match(result.stdout, /antigravity\/claude-opus-5-5-high.*STALE ROW/);
    assert.match(result.stdout, /antigravity\/mystery-model.*UNMAPPED/);
    assert.match(result.stdout, /cursor\/composer-2\.5.*UNVERIFIED.*included_auto.*fresh.*CANDIDATE/);
    assert.match(result.stdout, /cursor\/composer-2\.5.*bucket=included_auto,included_total/);
    assert.match(result.stdout, /cursor\/gpt-5\.3-codex-low.*included_api.*exhausted/);
    assert.doesNotMatch(result.stdout, /cursor\/gpt-5\.3-codex-low[^\n]*CANDIDATE/);
    const listed = JSON.parse(f.run("list", "--json").stdout);
    assert.deepEqual(listed.providers.cursor.freeBucketModels, ["auto", "composer-2.5"]);
    assert.match(f.run("list").stdout, /Cursor Models bucket \(2\): auto, composer-2\.5/);
  } finally {
    f.close();
  }
});

test("list keeps other providers visible when a provider fails", () => {
  const f = fixture();
  try {
    f.command("agy", "exit 1");
    const result = f.run("list", "--json");
    assert.equal(result.status, 0, result.stderr);
    const { providers } = JSON.parse(result.stdout);
    assert.equal(providers.antigravity.status, "unavailable");
    assert.equal(providers.cursor.count, 3);
    assert.match(f.run("list").stdout, /cursor: 3 models/);
    const diff = f.run("diff");
    assert.equal(diff.status, 0, diff.stderr);
    assert.match(diff.stdout, /antigravity\/gemini-3\.8-flash-high.*verified.*mechanical.*LIST UNAVAILABLE/);
    assert.doesNotMatch(diff.stdout, /antigravity\/gemini-3\.8-flash-high.*STALE ROW/);
  } finally {
    f.close();
  }
});

test("verify prints a read-only launch recipe and writes a spec only on request", () => {
  const f = fixture();
  try {
    for (const name of ["agy", "agent", "claude", "codex"]) f.command(name, "exit 99");
    const before = readdirSync(f.root);
    const preview = f.run("verify", "antigravity/claude-sonnet-5-5-medium");
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(readdirSync(f.root), before);
    assert.match(preview.stdout, /scripts\/orca-spawn\.sh --spec-file .* --name .* --base main --agent antigravity --model claude-sonnet-5-5-medium/);
    assert.match(preview.stdout, /first 12 lines of AGENTS\.md/i);
    assert.match(preview.stdout, /git log -1/);
    assert.match(preview.stdout, /node -v/);
    assert.match(preview.stdout, /report.*model id/i);
    assert.match(preview.stdout, /no changes/i);
    const dir = path.join(f.root, "model specs");
    const written = f.run("verify", "antigravity/claude-sonnet-5-5-medium", "--base", "feature/demo", "--write", dir);
    assert.equal(written.status, 0, written.stderr);
    const file = path.join(dir, "model-verification-antigravity-claude-sonnet-5-5-medium.md");
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, "utf8"), /git log -1/);
    assert.match(written.stdout, /--base feature\/demo/);
    assert.match(written.stdout, /'[^']*model specs[^']*'/);
    assert.notEqual(f.run("verify", "antigravity/claude-sonnet-5-5-medium", "--write", dir).status, 0);
    assert.notEqual(f.run("verify", "antigravity/../../unsafe").status, 0);
  } finally {
    f.close();
  }
});

test("help explains the commands without querying providers or creating files", () => {
  const f = fixture();
  try {
    for (const name of ["agy", "agent", "claude", "codex"]) f.command(name, "exit 99");
    const before = readdirSync(f.root);
    const result = f.run("--help");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /list \[--json\]/);
    assert.match(result.stdout, /verify <agent>\/<model>/);
    assert.deepEqual(readdirSync(f.root), before);
  } finally {
    f.close();
  }
});
