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
  mkdirSync(workspaces);
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
  // The new worktree "wt" (branch jahnzh/wt, as Orca names it) and a worker's worktree "src" whose local branch
  // jahnzh/fix-79 differs from the remote name; both are real worktrees of the test repository.
  for (const [wtName, branch] of [["wt", "jahnzh/wt"], ["src", "jahnzh/fix-79"]]) {
    const g = spawnSync("git", ["worktree", "add", "-q", "-b", branch, join(workspaces, wtName)], { cwd: repo, encoding: "utf8" });
    if (g.status !== 0) throw new Error(`git worktree add ${wtName} failed: ${g.stderr}`);
  }
  writeFileSync(join(dir, "spec.md"), "do the thing\n");
  writeFileSync(join(dir, "receipt"), receipt);
  stub(bin, "orca", `echo "$@" >> "${dir}/orca.log"\necho 'keepalive'\ncat "${dir}/receipt"\nexit $(cat "${dir}/exitcode" 2>/dev/null || echo 0)`);
  stub(bin, "codegraph", `echo "$PWD: $@" >> "${dir}/codegraph.log"`);
  stub(bin, "npm", `echo "$PWD: $@" >> "${dir}/npm.log"`);
  // The preflight checks free disk space; never ask the real one.
  stub(bin, "df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/fake 102626232 1000 99999999 1% /"`);
  stub(bin, "agent", `printf 'Available models\\n\\nauto - Auto\\ngpt-5.3-codex - Codex 5.3\\n'`);
  const historyStub = join(dir, "history-stub.mjs");
  writeFileSync(
    historyStub,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "history.log"))}, args.join(" ") + "\\n");
const mode = process.env.ORCA_HISTORY_STUB_FAIL || "";
if (mode === "1" || (mode === "link" && args[0] === "link") || (mode === "capture" && args[0] === "capture")) {
  console.error("stub " + (args[0] || "history") + " failed");
  process.exit(1);
}
`,
  );
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? dir,
        ORCA_SPAWN_WORKSPACES: workspaces,
        ORCA_PREFLIGHT_REPO: repo,
        ORCA_PREFLIGHT_DF: join(bin, "df"),
        ORCA_CLI_COMMAND: "orca",
        ORCA_HISTORY_SCRIPT: historyStub,
        ...env,
      },
    });
  const base = ["--spec-file", join(dir, "spec.md"), "--name", "wt", "--base", "HEAD", "--agent", "cursor"];
  return { dir, run, base, repo, workspaces, orcaLog: join(dir, "orca.log"), cgLog: join(dir, "codegraph.log"), npmLog: join(dir, "npm.log"), historyLog: join(dir, "history.log") };
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
    assert.match(r.stdout, /^branch: jahnzh\/wt$/m);
    const call = readFileSync(t.orcaLog, "utf8");
    assert.match(call, /orchestration worker-start --spec do the thing/);
    assert.match(call, /--worktree new-top-level --name wt --repo path:.* --base-branch HEAD --agent cursor --model gpt-5.3-codex --effort high --json/);
    for (let i = 0; i < 50 && !existsSync(t.cgLog); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(readFileSync(t.cgLog, "utf8"), /\/ws\/wt: init -y/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("fresh worktree gets npm ci started", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.workspaces, "wt", "package.json"), "{}\n");
    const r = t.run([...t.base, "--model", "gpt-5.3-codex", "--effort", "high"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /npm ci running in the background/);
    for (let i = 0; i < 50 && !existsSync(t.npmLog); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(readFileSync(t.npmLog, "utf8"), /\/ws\/wt: ci --no-audit --no-fund/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("worktree with node_modules does not", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.workspaces, "wt", "package.json"), "{}\n");
    mkdirSync(join(t.workspaces, "wt", "node_modules"));
    const r = t.run([...t.base, "--model", "gpt-5.3-codex", "--effort", "high"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /npm ci running/);
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

test("--base-worktree resolves the worktree's local branch and passes it to worker-start", () => {
  const t = setup();
  try {
    const base = t.base.filter((_, i) => t.base[i - 1] !== "--base" && t.base[i] !== "--base");
    const r = t.run([...base, "--base-worktree", "src", "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /base branch: jahnzh\/fix-79 \(from worktree src\)/);
    assert.match(readFileSync(t.orcaLog, "utf8"), /--base-branch jahnzh\/fix-79 /);
    assert.match(r.stdout, /^branch: jahnzh\/wt$/m);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("--base-worktree fails before starting anything when the worktree has no branch", () => {
  const t = setup();
  try {
    const base = t.base.filter((_, i) => t.base[i - 1] !== "--base" && t.base[i] !== "--base");
    const missing = t.run([...base, "--base-worktree", "nope", "--model", "gpt-5.3-codex"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /cannot resolve a branch from worktree .*\/nope/);
    // A detached HEAD has no branch name either.
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: t.repo, encoding: "utf8" }).stdout.trim();
    spawnSync("git", ["checkout", "-q", "--detach", sha], { cwd: join(t.workspaces, "src") });
    const detached = t.run([...base, "--base-worktree", "src", "--model", "gpt-5.3-codex"]);
    assert.equal(detached.status, 1);
    assert.match(detached.stderr, /detached HEAD/);
    assert.equal(existsSync(t.orcaLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("exactly one of --base and --base-worktree is required", () => {
  const t = setup();
  try {
    const noBase = t.base.filter((_, i) => t.base[i - 1] !== "--base" && t.base[i] !== "--base");
    const neither = t.run([...noBase, "--model", "gpt-5.3-codex"]);
    assert.equal(neither.status, 2);
    assert.match(neither.stderr, /usage:.*--base-worktree/);
    const both = t.run([...t.base, "--base-worktree", "src", "--model", "gpt-5.3-codex"]);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /either --base or --base-worktree/);
    assert.equal(existsSync(t.orcaLog), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("a launched worker whose worktree has no readable branch is a warning, not a failure", () => {
  const t = setup();
  try {
    const plain = join(t.dir, "plain", "wt");
    mkdirSync(plain, { recursive: true });
    writeFileSync(
      join(t.dir, "receipt"),
      JSON.stringify({ ok: true, result: { dispatchId: "ctx_nb", launch: { effective: { model: "gpt-5.3-codex" } }, effects: [{ kind: "worktree", id: "r::" + plain }] } }),
    );
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /^branch:/m);
    assert.match(r.stderr, /could not read the branch/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("a successful launch automatically captures the dispatch in worker history", () => {
  const t = setup();
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(t.historyLog, "utf8"), /^capture --dispatch ctx_abc$/m);
    assert.match(r.stdout, /history: captured ctx_abc/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("a failed automatic history capture does not fail the spawn", () => {
  const t = setup();
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex"], { ORCA_HISTORY_STUB_FAIL: "1" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /warning: automatic history capture failed/);
    assert.match(readFileSync(t.historyLog, "utf8"), /capture --dispatch ctx_abc/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("--fix-of links the new dispatch after capture", () => {
  const t = setup();
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex", "--fix-of", "ctx_earlier"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const log = readFileSync(t.historyLog, "utf8");
    assert.match(log, /^capture --dispatch ctx_abc$/m);
    assert.match(
      log,
      /^link --from ctx_abc --to ctx_earlier --kind fix_of --evidence orca-spawn --fix-of$/m,
    );
    assert.match(r.stdout, /history: linked ctx_abc as fix_of ctx_earlier/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("--review-of links the new dispatch after capture", () => {
  const t = setup();
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex", "--review-of", "ctx_impl"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const log = readFileSync(t.historyLog, "utf8");
    assert.match(
      log,
      /^link --from ctx_abc --to ctx_impl --kind review_of --evidence orca-spawn --review-of$/m,
    );
    assert.match(r.stdout, /history: linked ctx_abc as review_of ctx_impl/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("a failed automatic history link does not fail the spawn", () => {
  const t = setup();
  try {
    const r = t.run([...t.base, "--model", "gpt-5.3-codex", "--fix-of", "ctx_earlier"], {
      ORCA_HISTORY_STUB_FAIL: "link",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /warning: automatic history link \(fix_of\) failed/);
    assert.match(readFileSync(t.historyLog, "utf8"), /link --from ctx_abc --to ctx_earlier/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
