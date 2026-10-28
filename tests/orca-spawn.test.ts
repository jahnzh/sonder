import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "orca-spawn.sh");

function stub(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function setup(receipt = '{"ok":true,"dispatchId":"ctx_abc","model":"gpt-5.3-codex"}') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-spawn-")));
  const bin = join(dir, "bin");
  const workspaces = join(dir, "ws");
  mkdirSync(bin);
  mkdirSync(join(workspaces, "wt"), { recursive: true });
  // The preflight reads the base branch with git. `npm run check` runs the unit tests in a `git archive` snapshot
  // that has no .git, so the tests build their own repository instead of using the surrounding checkout.
  const repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "AGENTS.md"), "# agents\n");
  writeFileSync(join(repo, "CLAUDE.md"), "# claude\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "AGENTS.md", "CLAUDE.md"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]]) {
    const g = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (g.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${g.stderr}`);
  }
  writeFileSync(join(dir, "spec.md"), "do the thing\n");
  writeFileSync(join(dir, "receipt"), receipt);
  stub(bin, "orca", `echo "$@" >> "${dir}/orca.log"\necho 'keepalive'\ncat "${dir}/receipt"\nexit $(cat "${dir}/exitcode" 2>/dev/null || echo 0)`);
  stub(bin, "codegraph", `echo "$PWD: $@" >> "${dir}/codegraph.log"`);
  stub(bin, "agent", `printf 'Available models\\n\\nauto - Auto\\ngpt-5.3-codex - Codex 5.3\\n'`);
  const run = (args: string[]) =>
    spawnSync("bash", [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCA_SPAWN_WORKSPACES: workspaces, ORCA_PREFLIGHT_REPO: repo, ORCA_CLI_COMMAND: "orca" },
    });
  const base = ["--spec-file", join(dir, "spec.md"), "--name", "wt", "--base", "HEAD", "--agent", "cursor"];
  return { dir, run, base, workspaces, orcaLog: join(dir, "orca.log"), cgLog: join(dir, "codegraph.log") };
}

test("refuses to run without --model", () => {
  const t = setup();
  try {
    const r = t.run(t.base);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--model/);
    assert.match(r.stderr, /usage:/);
    assert.equal(existsSync(t.orcaLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("exits 2 with usage on an unknown flag", () => {
  const t = setup();
  try {
    const r = t.run([...t.base, "--model", "x", "--bogus", "1"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses a cursor model that agent --list-models does not list", () => {
  const t = setup();
  try {
    const r = t.run([...t.base, "--model", "gpt-9"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown cursor model: gpt-9/);
    assert.equal(existsSync(t.orcaLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("a preflight failure prints its output and stops before worker-start", () => {
  const t = setup();
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex", "--doc", "NO_SUCH_DOC.md"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /missing doc: NO_SUCH_DOC\.md/);
    assert.equal(existsSync(t.orcaLog), false);
    assert.equal(existsSync(t.cgLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("fails when the effective model differs from the requested one", () => {
  const t = setup('{"ok":true,"dispatchId":"ctx_abc","model":"auto"}');
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /dispatch: ctx_abc/);
    assert.match(r.stderr, /differs from requested/);
    assert.equal(existsSync(t.cgLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("fails when the receipt says ok is false", () => {
  const t = setup('{"ok":false,"dispatchId":"ctx_abc","model":"gpt-5.3-codex"}');
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 1);
    assert.equal(existsSync(t.cgLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("happy path prints the dispatch id and model, passes the flags, and runs codegraph init -y", async () => {
  const t = setup();
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex", "--effort", "high"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /dispatch: ctx_abc/);
    assert.match(r.stdout, /effective model: gpt-5.3-codex/);
    assert.match(r.stdout, /codegraph init -y running in the background/);
    const call = readFileSync(t.orcaLog, "utf8");
    assert.match(call, /orchestration worker-start --spec do the thing/);
    assert.match(call, /--worktree new-top-level --name wt --repo path:.* --base-branch HEAD --agent cursor --model gpt-5.3-codex --effort high --json/);
    for (let i = 0; i < 50 && !existsSync(t.cgLog); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(readFileSync(t.cgLog, "utf8"), /\/ws\/wt: init -y/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// Shape copied from a real `orca orchestration worker-start --json` receipt: everything is under "result",
// and the top-level "id" is the request id, not the dispatch id.
const realReceipt = (effectiveModel: string) =>
  JSON.stringify(
    {
      id: "35b31a49-dca9-4895-a3f6-36b8494caa12",
      ok: true,
      result: {
        runId: "run_561373069493",
        dispatchId: "ctx_real0000001",
        state: "ready",
        launch: {
          requested: { agent: "cursor", model: "gpt-5.3-codex", effort: null },
          effective: { agent: "cursor", model: effectiveModel, effort: null },
        },
      },
      _meta: { runtimeId: "22eeea5e" },
    },
    null,
    2,
  );

test("reads the dispatch id and effective model from a real receipt", () => {
  const t = setup(realReceipt("gpt-5.3-codex"));
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /dispatch: ctx_real0000001/);
    assert.doesNotMatch(r.stdout, /35b31a49/);
    assert.match(r.stdout, /effective model: gpt-5.3-codex/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("fails on a real receipt whose effective model is not the requested one", () => {
  const t = setup(realReceipt("auto"));
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /differs from requested/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("fails when worker-start exits non-zero with output that is not JSON", () => {
  const t = setup("Error: Orca is not running");
  try {
    writeFileSync(join(t.dir, "exitcode"), "1");
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no JSON receipt/);
    assert.equal(existsSync(t.cgLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("fails when worker-start exits non-zero even if the receipt says ok", () => {
  const t = setup('{"ok":true,"dispatchId":"ctx_abc","model":"gpt-5.3-codex"}');
  try {
    writeFileSync(join(t.dir, "exitcode"), "3");
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /did not succeed/);
    assert.equal(existsSync(t.cgLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("uses the worktree path from the receipt effects", async () => {
  const t = setup();
  try {
    const actual = join(t.dir, "elsewhere", "wt");
    mkdirSync(actual, { recursive: true });
    const receipt = {
      ok: true,
      result: {
        dispatchId: "ctx_effects01",
        launch: { effective: { model: "gpt-5.3-codex" } },
        effects: [{ kind: "worktree", id: "9e9b9113-repo::" + actual }],
      },
    };
    writeFileSync(join(t.dir, "receipt"), JSON.stringify(receipt));
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (let i = 0; i < 50 && !existsSync(t.cgLog); i++) await new Promise((res) => setTimeout(res, 100));
    assert.match(readFileSync(t.cgLog, "utf8"), new RegExp(actual + ": init -y"));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("a missing worktree after a successful launch is a warning, not a failure", () => {
  const t = setup();
  try {
    rmSync(join(t.workspaces, "wt"), { recursive: true, force: true });
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /dispatch: ctx_abc/);
    assert.match(r.stderr, /warning: worktree .* not found; the worker is running/);
    assert.equal(existsSync(t.cgLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses a spec larger than one command-line argument can hold, before starting anything", () => {
  const t = setup();
  try {
    writeFileSync(join(t.dir, "spec.md"), "x".repeat(130000));
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /130000 bytes/);
    assert.equal(existsSync(t.orcaLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
