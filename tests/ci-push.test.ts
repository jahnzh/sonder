import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "ci-push.sh");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

// `git` stub: ls-remote prints before.txt until a push succeeded, then
// after.txt; push logs its call, prints a realistic section on stderr and
// exits with STUB_PUSH_EXIT. STUB_LSREMOTE_FAIL_BEFORE makes the pre-push
// ls-remote fail like an unreachable remote.
const gitStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/git.log"
case "$1" in
  ls-remote)
    if [[ -f $STUB_DIR/pushed ]]; then
      [[ -n \${STUB_LSREMOTE_FAIL_AFTER:-} ]] && { echo "fatal: unable to access remote" >&2; exit 128; }
      cat "$STUB_DIR/after.txt"; exit 0
    fi
    [[ -n \${STUB_LSREMOTE_FAIL_BEFORE:-} ]] && { echo "fatal: unable to access remote" >&2; exit 128; }
    cat "$STUB_DIR/before.txt"; exit 0 ;;
  push)
    echo "remote: pre-push hook output" >&2
    echo "To example.invalid:sonder.git" >&2
    if [[ \${STUB_PUSH_EXIT:-0} != 0 ]]; then
      echo "error: failed to push some refs" >&2
      exit "$STUB_PUSH_EXIT"
    fi
    touch "$STUB_DIR/pushed"; exit 0 ;;
esac
exit 1
`;

// Runner stub: logs argv and the dispatch env, prints a line, optionally
// sleeps and then appends a finishing line to its own stdout.
const runnerStub = `#!/usr/bin/env bash
echo "invoked argv=$*" >>"$STUB_RUNNER_LOG"
echo "stub-runner sha=$1"
if [[ -n \${STUB_RUNNER_SLEEP:-} ]]; then
  echo "$$" >"$STUB_DIR/runner.pid"
  sleep "$STUB_RUNNER_SLEEP"
  echo "stub-runner done"
fi
`;

function cleanEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SONDER_CI_") || key.startsWith("SONDER_PUSH_CI_") || key.startsWith("STUB_") || key === "SONDER_SKIP_PUSH_CI") {
      delete env[key];
    }
  }
  return env;
}

interface Fixture {
  dir: string;
  artifacts: string;
  runnerLog: string;
  runner: string;
  env: NodeJS.ProcessEnv;
}

function ls(entries: Array<[string, string]>) {
  return entries.map(([sha, ref]) => `${sha}\trefs/heads/${ref}\n`).join("");
}

function setup(before: Array<[string, string]>, after: Array<[string, string]>): Fixture {
  const dir = tempDir("ci-push-test-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), gitStub, { mode: 0o755 });
  const runner = path.join(dir, "runner.sh");
  fs.writeFileSync(runner, runnerStub, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "before.txt"), ls(before));
  fs.writeFileSync(path.join(dir, "after.txt"), ls(after));
  const artifacts = path.join(dir, "artifacts", "ci");
  const runnerLog = path.join(dir, "runner.log");
  const env = {
    ...cleanEnv(),
    PATH: `${bin}:${process.env.PATH}`,
    STUB_DIR: dir,
    STUB_RUNNER_LOG: runnerLog,
    SONDER_PUSH_CI_RUNNER: runner,
    SONDER_PUSH_CI_ARTIFACTS: artifacts,
  };
  return { dir, artifacts, runnerLog, runner, env };
}

function run(fx: Fixture, args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
  const start = Date.now();
  const r = spawnSync("bash", [script, ...args], {
    env: { ...fx.env, ...extra },
    encoding: "utf8",
    cwd: fx.dir,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - start };
}

function invocations(fx: Fixture): string[] {
  return fs.existsSync(fx.runnerLog)
    ? fs.readFileSync(fx.runnerLog, "utf8").split("\n").filter(Boolean)
    : [];
}

// Detached runners finish after the wrapper returns; wait for them.
async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

function dispatchLines(out: string) {
  return out.split("\n").filter((l) => l.startsWith("dispatching "));
}

test("fast-forward push dispatches the new SHA with a log holding the runner output", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const r = run(fx, ["origin", "main"]);
  assert.equal(r.status, 0);
  const lines = dispatchLines(r.stdout);
  assert.equal(lines.length, 1);
  const m = lines[0].match(/^dispatching (\w+) main log=(.+)$/);
  assert.ok(m, lines[0]);
  assert.equal(m[1], SHA_B);
  assert.ok(m[2].startsWith(path.join(fx.artifacts, SHA_B, "push-dispatch-")));
  assert.ok(await waitFor(() => invocations(fx).length === 1 && fs.readFileSync(m[2], "utf8").includes("stub-runner")));
  assert.deepEqual(invocations(fx), [`invoked argv=${SHA_B}`]);
  assert.match(fs.readFileSync(m[2], "utf8"), new RegExp(`stub-runner sha=${SHA_B}`));
  // The real push output reaches the user.
  assert.match(r.stderr, /pre-push hook output/);
  assert.match(fs.readFileSync(path.join(fx.dir, "git.log"), "utf8"), /push origin main/);
});

test("a new branch is dispatched with its SHA", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_A, "main"], [SHA_C, "feature"]]);
  const r = run(fx, ["-u", "origin", "feature"]);
  assert.equal(r.status, 0);
  assert.equal(dispatchLines(r.stdout).length, 1);
  assert.match(r.stdout, new RegExp(`dispatching ${SHA_C} feature log=`));
  assert.ok(await waitFor(() => invocations(fx).length === 1));
  assert.deepEqual(invocations(fx), [`invoked argv=${SHA_C}`]);
});

test("two updated branches dispatch in sorted order; a shared SHA runs once", async () => {
  const fx = setup(
    [[SHA_A, "zeta"], [SHA_A, "alpha"], [SHA_A, "mid"], [SHA_A, "twin"]],
    [[SHA_B, "zeta"], [SHA_C, "alpha"], [SHA_D, "mid"], [SHA_D, "twin"]],
  );
  const r = run(fx);
  assert.equal(r.status, 0);
  const lines = dispatchLines(r.stdout);
  assert.deepEqual(
    lines.map((l) => l.split(" ").slice(1, 3).join(" ")),
    [`${SHA_C} alpha`, `${SHA_D} mid`, `${SHA_B} zeta`],
  );
  assert.match(r.stdout, new RegExp(`skipped ${SHA_D} twin \\(same commit as mid\\)`));
  assert.ok(await waitFor(() => invocations(fx).length === 3));
  assert.deepEqual(invocations(fx).sort(), [SHA_B, SHA_C, SHA_D].map((s) => `invoked argv=${s}`).sort());
});

test("a failing push exits with its status and dispatches nothing", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const r = run(fx, [], { STUB_PUSH_EXIT: "1" });
  assert.equal(r.status, 1);
  assert.equal(dispatchLines(r.stdout).length, 0);
  assert.match(r.stderr, /failed to push some refs/);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(invocations(fx).length, 0);
});

test("an up-to-date push dispatches nothing", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_A, "main"]]);
  const r = run(fx);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  assert.equal(invocations(fx).length, 0);
});

test("a branch deleted on the remote is not dispatched", async () => {
  const fx = setup([[SHA_A, "main"], [SHA_B, "old"]], [[SHA_A, "main"]]);
  const r = run(fx, ["origin", "--delete", "old"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(invocations(fx).length, 0);
});

test("a SHA with a finished result file is skipped as already checked", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const runDir = path.join(fx.artifacts, SHA_B, "ci-deck-20260101T000000Z-1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "ci-deck-result.txt"), "result=passed\n");
  const r = run(fx);
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`skipped ${SHA_B} main \\(already checked\\)`));
  assert.equal(dispatchLines(r.stdout).length, 0);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(invocations(fx).length, 0);
});

test("SONDER_SKIP_PUSH_CI=1 is a plain push and propagates its status", async () => {
  const ok = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const r = run(ok, ["origin", "main"], { SONDER_SKIP_PUSH_CI: "1" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  assert.equal(fs.readFileSync(path.join(ok.dir, "git.log"), "utf8").trim(), "push origin main");
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(invocations(ok).length, 0);

  const bad = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const rb = run(bad, [], { SONDER_SKIP_PUSH_CI: "1", STUB_PUSH_EXIT: "3" });
  assert.equal(rb.status, 3);
  assert.equal(invocations(bad).length, 0);
});

test("a failing snapshot still pushes, warns on stderr and dispatches nothing", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const r = run(fx, [], { STUB_LSREMOTE_FAIL_BEFORE: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /cannot list remote 'origin' before the push/);
  assert.ok(fs.existsSync(path.join(fx.dir, "pushed")));
  assert.equal(r.stdout.trim(), "");
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(invocations(fx).length, 0);

  const bad = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const rb = run(bad, [], { STUB_LSREMOTE_FAIL_BEFORE: "1", STUB_PUSH_EXIT: "7" });
  assert.equal(rb.status, 7);
});

test("a failing post-push snapshot still pushes, warns on stderr and dispatches nothing", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const r = run(fx, [], { STUB_LSREMOTE_FAIL_AFTER: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /cannot list remote 'origin' after the push/);
  assert.ok(fs.existsSync(path.join(fx.dir, "pushed")));
  assert.equal(r.stdout.trim(), "");
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(invocations(fx).length, 0);
});

test("the check is detached: the wrapper returns while the runner keeps running and logging", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const r = run(fx, [], { STUB_RUNNER_SLEEP: "1" });
  assert.equal(r.status, 0);
  assert.ok(r.ms < 900, `wrapper took ${r.ms} ms`);
  const log = r.stdout.match(/log=(.+)$/m)![1];
  const pidFile = path.join(fx.dir, "runner.pid");
  assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== ""));
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.ok(alive, "runner should outlive the wrapper");
  assert.ok(!fs.readFileSync(log, "utf8").includes("done"));
  assert.ok(await waitFor(() => fs.readFileSync(log, "utf8").includes("stub-runner done")));
});

test("SONDER_PUSH_CI_RUNNER is honoured and the default is scripts/ci-run.sh", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const other = path.join(fx.dir, "other-runner.sh");
  fs.writeFileSync(other, `#!/usr/bin/env bash\necho "other argv=$*" >>"$STUB_RUNNER_LOG"\n`, { mode: 0o755 });
  const r = run(fx, [], { SONDER_PUSH_CI_RUNNER: other });
  assert.equal(r.status, 0);
  assert.ok(await waitFor(() => invocations(fx).length === 1));
  assert.deepEqual(invocations(fx), [`other argv=${SHA_B}`]);

  // The default is the repo's own ci-run.sh: the header and code agree.
  const text = fs.readFileSync(script, "utf8");
  assert.match(text, /RUNNER=\$\{SONDER_PUSH_CI_RUNNER:-\$ROOT\/scripts\/ci-run\.sh\}/);
});

test("results are written under the temp artifact root, not the repository's", async () => {
  const fx = setup([[SHA_A, "main"]], [[SHA_B, "main"]]);
  const r = run(fx);
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(fx.artifacts, SHA_B)));
  assert.ok(!fs.existsSync(path.join(repoRoot, "artifacts", "ci", SHA_B)));
  assert.ok(await waitFor(() => invocations(fx).length === 1));
});
