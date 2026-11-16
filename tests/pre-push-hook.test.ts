import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tempDir } from "./temp-dir.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The caller's environment without its GIT_ variables and git configuration: git in `home` answers for `home` alone. */
function isolatedGitEnv(home: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
}

function gitIn(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: isolatedGitEnv(cwd),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeTempRepo() {
  const root = tempDir("sonder-git-hooks-");
  mkdirSync(join(root, ".githooks"), { recursive: true });
  // lib.sh is what the two hooks share; it is not a hook.
  for (const hook of ["pre-push", "pre-commit", "lib.sh"]) {
    cpSync(join(repoRoot, ".githooks", hook), join(root, ".githooks", hook));
    chmodSync(join(root, ".githooks", hook), 0o755);
  }
  gitIn(root, "init", "-q");
  return root;
}

function writeStubNpm(root: string) {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, "npm.log");
  writeFileSync(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
set -eu
echo "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "run" && "$2" == "build" ]]; then
  exit "\${SONDER_STUB_BUILD_EXIT:-0}"
fi
echo "unexpected npm invocation: $*" >&2
exit 1
`,
    { mode: 0o755 },
  );
  return { binDir, logPath };
}

function runHook(
  root: string,
  binDir: string,
  env: Record<string, string | undefined> = {},
  stdin = "refs/heads/main abc refs/heads/main def\n",
) {
  // Git calls the hook with the remote's name and address.
  return spawnSync(join(root, ".githooks", "pre-push"), ["origin", join(root, "remote.git")], {
    cwd: root,
    encoding: "utf8",
    input: stdin,
    env: {
      // The hook asks git what is pushed; a GIT_ variable of the caller (a hook that runs these tests) must not answer for it.
      ...isolatedGitEnv(root),
      // What the caller's shell has set must not decide these tests.
      SONDER_SKIP_PREPUSH: undefined,
      SONDER_SKIP_PUSH_CI: undefined,
      SONDER_PUSH_CI_WRAPPER: undefined,
      SONDER_PUSH_CI_RUNNER: undefined,
      SONDER_PUSH_CI_ARTIFACTS: undefined,
      // How often and how long the job the hook leaves behind looks for the pushed commit on the remote.
      SONDER_PUSH_CI_LAND_INTERVAL: "0.1",
      SONDER_PUSH_CI_LAND_TIMEOUT: "10",
      ...env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

const ZERO = "0".repeat(40);
/** One ref update as git sends it to the hook. */
const update = (local: string, remote: string, ref = "refs/heads/work") => `${ref} ${local} ${ref} ${remote}\n`;
const npmCalls = (logPath: string) => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : []);

/** One commit on main, which the remote has too. Returns that commit. */
function seedRepo(root: string) {
  gitIn(root, "symbolic-ref", "HEAD", "refs/heads/main");
  gitIn(root, "config", "user.name", "Test");
  gitIn(root, "config", "user.email", "test@example.test");
  const base = commitFiles(root, { "src/app.ts": "export const one = 1;\n" }, "base");
  gitIn(root, "update-ref", "refs/remotes/origin/main", base);
  return base;
}

function commitFiles(root: string, files: Record<string, string>, message = "change") {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    gitIn(root, "add", path);
  }
  gitIn(root, "commit", "-qm", message);
  return gitIn(root, "rev-parse", "HEAD");
}

function writeStubNpx(root: string) {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, "npx.log");
  writeFileSync(
    join(binDir, "npx"),
    `#!/usr/bin/env bash
set -eu
echo "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "tsc" && "$2" == "--noEmit" ]]; then
  exit "\${SONDER_STUB_TSC_EXIT:-0}"
fi
echo "unexpected npx invocation: $*" >&2
exit 1
`,
    { mode: 0o755 },
  );
  return { binDir, logPath };
}

function runPreCommit(
  root: string,
  binDir: string,
  env: Record<string, string | undefined> = {},
) {
  return spawnSync(join(root, ".githooks", "pre-commit"), [], {
    cwd: root,
    encoding: "utf8",
    env: {
      // The hook asks git what is staged; a GIT_ variable of the caller must not answer for it.
      ...isolatedGitEnv(root),
      // A skip variable set in the caller's shell must not decide these tests.
      SONDER_SKIP_PRECOMMIT: undefined,
      ...env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

/** A seeded repository with the hook and a stub npm; its folder is removed when this file's process ends. */
function withRepo(run: (context: { root: string; base: string; binDir: string; logPath: string }) => void) {
  const root = makeTempRepo();
  const base = seedRepo(root);
  run({ root, base, ...writeStubNpm(root) });
}

test("pre-push hook runs the build, and not the unit suite, when code is pushed", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    const head = commitFiles(root, { "src/app.ts": "export const one = 2;\n" });
    const result = runHook(root, binDir, {}, update(head, base));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    // The stub fails on "npm test", so a hook that still ran the unit suite would be blocked here.
    assert.deepEqual(npmCalls(logPath), ["run build"]);
  });
});

test("pre-push hook runs nothing when only documentation is pushed", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    const head = commitFiles(root, {
      "docs/adr/0001-a-decision.md": "# A decision\n",
      "docs/agents/policy.json": "{}\n",
      "README.md": "# Readme\n",
      "tests/e2e/prototype/README.md": "# Notes\n",
    });
    const result = runHook(root, binDir, {}, update(head, base));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /only documentation is pushed/);
    assert.deepEqual(npmCalls(logPath), []);
  });
});

test("pre-push hook runs the build when documentation and code are pushed together", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    commitFiles(root, { "docs/notes.md": "notes\n" });
    const head = commitFiles(root, { "server/app.ts": "export {};\n" });
    const result = runHook(root, binDir, {}, update(head, base));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(npmCalls(logPath), ["run build"]);
  });
});

test("pre-push hook compares a new branch with where it left main", () => {
  withRepo(({ root, binDir, logPath }) => {
    // Main moves on with code after the branch left it. Compared with main's tip the branch would
    // seem to change that code too; compared with where it left main it changes documentation only.
    gitIn(root, "checkout", "-q", "-b", "work");
    const docs = commitFiles(root, { "docs/plan.md": "plan\n" });
    gitIn(root, "checkout", "-q", "main");
    const mainTip = commitFiles(root, { "src/app.ts": "export const one = 100;\n" }, "main moves on");
    gitIn(root, "update-ref", "refs/remotes/origin/main", mainTip);
    gitIn(root, "checkout", "-q", "work");

    // The remote does not have the branch yet: its id is all zeros.
    const onlyDocs = runHook(root, binDir, {}, update(docs, ZERO));
    assert.equal(onlyDocs.status, 0, onlyDocs.stderr || onlyDocs.stdout);
    assert.match(onlyDocs.stdout, /only documentation is pushed/);
    assert.deepEqual(npmCalls(logPath), []);

    const code = commitFiles(root, { "server/app.ts": "export {};\n" });
    const withCode = runHook(root, binDir, {}, update(code, ZERO));
    assert.equal(withCode.status, 0, withCode.stderr || withCode.stdout);
    assert.deepEqual(npmCalls(logPath), ["run build"]);
  });
});

test("pre-push hook runs the build when a code file is moved into docs or renamed to markdown", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    // Git lists a rename under its new name only, unless it is told not to follow renames.
    mkdirSync(join(root, "docs"), { recursive: true });
    gitIn(root, "mv", "src/app.ts", "docs/app.ts");
    gitIn(root, "commit", "-qm", "move code into docs");
    const moved = gitIn(root, "rev-parse", "HEAD");
    const result = runHook(root, binDir, {}, update(moved, base));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(npmCalls(logPath), ["run build"]);
  });
});

test("pre-push hook treats a documentation file with other than ASCII letters in its name as documentation", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    const head = commitFiles(root, { "docs/læsevejledning.md": "tekst\n", "docs/two words.md": "text\n" });
    const result = runHook(root, binDir, {}, update(head, base));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /only documentation is pushed/);
    assert.deepEqual(npmCalls(logPath), []);
  });
});

test("pre-push hook reads a ref update that does not end with a newline", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    const head = commitFiles(root, { "src/app.ts": "export const one = 7;\n" });
    const result = runHook(root, binDir, {}, update(head, base).trimEnd());
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(npmCalls(logPath), ["run build"]);
  });
});

test("pre-push hook says so when the pushed commits change no file", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    // A new branch that points at a commit main already has.
    const result = runHook(root, binDir, {}, update(base, ZERO));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /change no file/);
    assert.deepEqual(npmCalls(logPath), []);
  });
});

test("pre-push hook runs the build when it cannot tell what is pushed", () => {
  withRepo(({ root, binDir, logPath }) => {
    const head = commitFiles(root, { "docs/plan.md": "plan\n" });
    // A commit of the remote that this repository does not have.
    const unknownRemote = runHook(root, binDir, {}, update(head, "1".repeat(40)));
    assert.equal(unknownRemote.status, 0, unknownRemote.stderr || unknownRemote.stdout);
    assert.match(unknownRemote.stdout, /could not list what is pushed/);
    // A new branch in a repository that does not know the remote's main.
    gitIn(root, "update-ref", "-d", "refs/remotes/origin/main");
    const noMain = runHook(root, binDir, {}, update(head, ZERO));
    assert.equal(noMain.status, 0, noMain.stderr || noMain.stdout);
    // Ids that are no commits at all.
    const nonsense = runHook(root, binDir);
    assert.equal(nonsense.status, 0, nonsense.stderr || nonsense.stdout);
    assert.deepEqual(npmCalls(logPath), ["run build", "run build", "run build"]);
  });
});

test("pre-push hook runs nothing when a branch is deleted or nothing is pushed", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    const deleted = runHook(root, binDir, {}, update(ZERO, base));
    assert.equal(deleted.status, 0, deleted.stderr || deleted.stdout);
    assert.match(deleted.stdout, /no commits are pushed/);
    const empty = runHook(root, binDir, {}, "");
    assert.equal(empty.status, 0, empty.stderr || empty.stdout);
    assert.match(empty.stdout, /no commits are pushed/);
    assert.deepEqual(npmCalls(logPath), []);
  });
});

test("pre-push hook runs the build when one of several pushed branches carries code", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    const docs = commitFiles(root, { "docs/plan.md": "plan\n" });
    const code = commitFiles(root, { "src/app.ts": "export const one = 4;\n" });
    const result = runHook(
      root,
      binDir,
      {},
      update(docs, base, "refs/heads/docs") + update(ZERO, base, "refs/heads/gone") + update(code, docs, "refs/heads/code"),
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(npmCalls(logPath), ["run build"]);
  });
});

test("pre-push hook blocks push when npm run build fails", () => {
  withRepo(({ root, base, binDir }) => {
    const head = commitFiles(root, { "src/app.ts": "export const one = 5;\n" });
    const result = runHook(root, binDir, { SONDER_STUB_BUILD_EXIT: "1" }, update(head, base));
    assert.notEqual(result.status, 0);
    const err = `${result.stderr}${result.stdout}`;
    assert.match(err, /build/i);
    assert.match(err, /Skip once with SONDER_SKIP_PREPUSH=1 git push/);
  });
});

test("pre-push hook skips checks when SONDER_SKIP_PREPUSH=1", () => {
  withRepo(({ root, base, binDir, logPath }) => {
    const head = commitFiles(root, { "src/app.ts": "export const one = 6;\n" });
    const result = runHook(root, binDir, { SONDER_SKIP_PREPUSH: "1", SONDER_STUB_BUILD_EXIT: "1" }, update(head, base));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /skipped/i);
    assert.equal(existsSync(logPath), false);
  });
});

/**
 * Gives the repository what a real checkout has for starting a committed check: a remote, the
 * shared start code and a runner. The runner is a stub that records its argument and the GIT_
 * variables it sees, and can be told to take its time.
 */
function installRunner(root: string) {
  gitIn(root, "init", "-q", "--bare", join(root, "remote.git"));
  gitIn(root, "remote", "add", "origin", join(root, "remote.git"));
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  cpSync(join(repoRoot, "scripts", "lib", "push-dispatch.sh"), join(root, "scripts", "lib", "push-dispatch.sh"));
  const runnerLog = join(root, "runner.log");
  writeFileSync(
    join(root, "scripts", "ci-run.sh"),
    `#!/usr/bin/env bash
git_names=$(env | grep -o '^GIT_[^=]*' | sort | tr '\\n' ',' || true)
echo "sha=$1 git=[$git_names]" >> ${JSON.stringify(runnerLog)}
echo "stub runner for $1"
if [[ -n \${STUB_RUNNER_SLEEP:-} ]]; then sleep "$STUB_RUNNER_SLEEP"; fi
`,
    { mode: 0o755 },
  );
  return { runnerLog, artifacts: join(root, "artifacts", "ci") };
}
/** The push itself: what git does after the hook has let it through. */
const land = (root: string, sha: string, branch = "work") => gitIn(root, "push", "-q", "origin", `${sha}:refs/heads/${branch}`);
const runnerCalls = (runnerLog: string) => (existsSync(runnerLog) ? readFileSync(runnerLog, "utf8").trim().split("\n") : []);
const dispatched = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("dispatching "));
const logOf = (line: string) => line.split("log=")[1];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The job the hook leaves behind works on after the hook has returned; wait for what it does.
async function waitFor(condition: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await pause(50);
  }
  return condition();
}

function withRunner() {
  const root = makeTempRepo();
  const base = seedRepo(root);
  return { root, base, ...writeStubNpm(root), ...installRunner(root) };
}

test("pre-push hook starts the committed check once the pushed commit is on the remote", async () => {
  const { root, base, binDir, logPath, runnerLog, artifacts } = withRunner();
  const head = commitFiles(root, { "src/app.ts": "export const one = 2;\n" });
  const result = runHook(
    root,
    binDir,
    // What git exports to a hook must not reach the check.
    { GIT_DIR: join(root, ".git"), GIT_INDEX_FILE: join(root, ".git", "index"), GIT_FUTURE_TEST_VARIABLE: "x" },
    update(head, base),
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(npmCalls(logPath), ["run build"]);
  const lines = dispatched(result.stdout);
  assert.equal(lines.length, 1, result.stdout);
  assert.match(lines[0], new RegExp(`^dispatching ${head} work when the push has landed log=${artifacts}/${head}/push-dispatch-`));

  // Nothing starts while the commit is not on the remote.
  await pause(400);
  assert.deepEqual(runnerCalls(runnerLog), []);

  land(root, head);
  assert.ok(await waitFor(() => runnerCalls(runnerLog).length === 1), "the runner must start once the push has landed");
  assert.deepEqual(runnerCalls(runnerLog), [`sha=${head} git=[]`]);
  // The runner's output goes to the log the hook named, not to the push.
  assert.ok(await waitFor(() => readFileSync(logOf(lines[0]), "utf8").includes(`stub runner for ${head}`)));
  assert.doesNotMatch(result.stdout, /stub runner/);
});

test("pre-push hook starts no committed check for a push that does not land", async () => {
  // A dry run and a rejected push both run the hook and then send nothing.
  const { root, base, binDir, runnerLog, artifacts } = withRunner();
  const head = commitFiles(root, { "src/app.ts": "export const one = 3;\n" });
  const result = runHook(root, binDir, { SONDER_PUSH_CI_LAND_TIMEOUT: "1" }, update(head, base));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = dispatched(result.stdout);
  assert.equal(lines.length, 1, result.stdout);
  assert.ok(await waitFor(() => readFileSync(logOf(lines[0]), "utf8").includes("no committed check started")));
  assert.deepEqual(runnerCalls(runnerLog), []);
  // The job has gone, so a later push of the same commit is free to start one.
  assert.equal(existsSync(join(artifacts, head, "push-dispatch.pid")), false);
});

test("pre-push hook returns at once and leaves the waiting to a job of its own", async () => {
  const { root, base, binDir, runnerLog } = withRunner();
  const head = commitFiles(root, { "src/app.ts": "export const one = 4;\n" });
  const startedAt = Date.now();
  const result = runHook(root, binDir, { STUB_RUNNER_SLEEP: "3" }, update(head, base));
  const hookMs = Date.now() - startedAt;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // The job waits up to 10 s for the push and the runner then sleeps 3 s; the hook waited for neither.
  assert.ok(hookMs < 2500, `the hook took ${hookMs} ms`);
  land(root, head);
  assert.ok(await waitFor(() => runnerCalls(runnerLog).length === 1));
});

test("pre-push hook starts one committed check when the same commit is pushed again while the first waits or runs", async () => {
  const { root, base, binDir, runnerLog } = withRunner();
  const head = commitFiles(root, { "src/app.ts": "export const one = 5;\n" });
  const first = runHook(root, binDir, { STUB_RUNNER_SLEEP: "2" }, update(head, base));
  assert.equal(dispatched(first.stdout).length, 1, first.stdout);
  // The job writes its process id as it starts.
  await pause(300);
  const whileWaiting = runHook(root, binDir, {}, update(head, base));
  assert.equal(whileWaiting.status, 0, whileWaiting.stderr || whileWaiting.stdout);
  assert.deepEqual(dispatched(whileWaiting.stdout), []);
  assert.match(whileWaiting.stdout, new RegExp(`skipped ${head} work \\(its check is already starting or running\\)`));

  land(root, head);
  assert.ok(await waitFor(() => runnerCalls(runnerLog).length === 1));
  const whileRunning = runHook(root, binDir, {}, update(head, base));
  assert.match(whileRunning.stdout, /its check is already starting or running/);
  await pause(400);
  assert.equal(runnerCalls(runnerLog).length, 1);
});

test("pre-push hook starts the committed check for a documentation-only push without running the build", async () => {
  // The build cannot be affected by documentation, but the unit suite reads some of it.
  const { root, base, binDir, logPath, runnerLog } = withRunner();
  const head = commitFiles(root, { "docs/plan.md": "plan\n" });
  const result = runHook(root, binDir, {}, update(head, base));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /only documentation is pushed/);
  assert.deepEqual(npmCalls(logPath), []);
  assert.equal(dispatched(result.stdout).length, 1, result.stdout);
  land(root, head);
  assert.ok(await waitFor(() => runnerCalls(runnerLog).length === 1));
});

test("pre-push hook starts a committed check only for the pushed branches that change a file", async () => {
  const { root, base, binDir, runnerLog } = withRunner();
  const head = commitFiles(root, { "src/app.ts": "export const one = 6;\n" });
  // "same" is a new branch at a commit main already has; "v1" is a tag; "gone" is deleted.
  const result = runHook(
    root,
    binDir,
    {},
    update(base, ZERO, "refs/heads/same") + update(head, base, "refs/heads/work") + update(head, ZERO, "refs/tags/v1") + update(ZERO, base, "refs/heads/gone"),
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = dispatched(result.stdout);
  assert.equal(lines.length, 1, result.stdout);
  assert.match(lines[0], new RegExp(`^dispatching ${head} work `));
  land(root, head);
  assert.ok(await waitFor(() => runnerCalls(runnerLog).length === 1));
  await pause(300);
  assert.deepEqual(runnerCalls(runnerLog), [`sha=${head} git=[]`]);
});

test("pre-push hook starts no committed check after a failed build, through ci:push, or with SONDER_SKIP_PUSH_CI=1", async () => {
  const { root, base, binDir, logPath, runnerLog } = withRunner();
  const head = commitFiles(root, { "src/app.ts": "export const one = 7;\n" });

  const failedBuild = runHook(root, binDir, { SONDER_STUB_BUILD_EXIT: "1" }, update(head, base));
  const throughWrapper = runHook(root, binDir, { SONDER_PUSH_CI_WRAPPER: "1" }, update(head, base));
  const skipped = runHook(root, binDir, { SONDER_SKIP_PUSH_CI: "1" }, update(head, base));
  assert.notEqual(failedBuild.status, 0);
  assert.equal(throughWrapper.status, 0, throughWrapper.stderr || throughWrapper.stdout);
  assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
  assert.match(skipped.stdout, /committed check is not started \(SONDER_SKIP_PUSH_CI=1\)/);
  // The build ran each time.
  assert.deepEqual(npmCalls(logPath), ["run build", "run build", "run build"]);
  for (const result of [failedBuild, throughWrapper, skipped]) assert.deepEqual(dispatched(result.stdout), []);
  // Had a job been left behind, it would start the runner now.
  land(root, head);
  await pause(600);
  assert.deepEqual(runnerCalls(runnerLog), []);
});

test("pre-push hook starts one check for a commit pushed to two branches, and none for a commit already checked", async () => {
  const { root, base, binDir, runnerLog, artifacts } = withRunner();
  const head = commitFiles(root, { "src/app.ts": "export const one = 8;\n" });

  const twice = runHook(root, binDir, {}, update(head, base, "refs/heads/one") + update(head, base, "refs/heads/two"));
  assert.equal(twice.status, 0, twice.stderr || twice.stdout);
  assert.equal(dispatched(twice.stdout).length, 1, twice.stdout);
  assert.match(twice.stdout, new RegExp(`skipped ${head} two \\(same commit as one\\)`));
  land(root, head, "one");
  assert.ok(await waitFor(() => runnerCalls(runnerLog).length === 1));

  // A finished run of the commit, as the runners leave it.
  writeFileSync(join(artifacts, head, "ci-ssh-result.txt"), "result=passed\n");
  const again = runHook(root, binDir, {}, update(head, base, "refs/heads/one"));
  assert.equal(again.status, 0, again.stderr || again.stdout);
  assert.match(again.stdout, new RegExp(`skipped ${head} one \\(already checked\\)`));
  await pause(400);
  assert.equal(runnerCalls(runnerLog).length, 1);
});

test("pre-push hook lets the push through when the committed check cannot be started", () => {
  const root = makeTempRepo();
  const base = seedRepo(root);
  const { binDir } = writeStubNpm(root);
  const head = commitFiles(root, { "src/app.ts": "export const one = 9;\n" });

  // A checkout without the runner (a bare copy of the hooks, as in the first tests of this file).
  const noRunner = runHook(root, binDir, {}, update(head, base));
  assert.equal(noRunner.status, 0, noRunner.stderr || noRunner.stdout);
  assert.match(noRunner.stdout, /committed check is not started \(this checkout has no runner\); run: npm run ci:run <sha>/);

  // A place for the run's log that cannot be created.
  installRunner(root);
  writeFileSync(join(root, "not-a-folder"), "");
  const noLog = runHook(root, binDir, { SONDER_PUSH_CI_ARTIFACTS: join(root, "not-a-folder", "ci") }, update(head, base));
  assert.equal(noLog.status, 0, noLog.stderr || noLog.stdout);
  assert.match(noLog.stderr, /not dispatched/);
});

test("the hooks run from a real commit and a real push, and a rejected push starts no check", async () => {
  const { root, binDir, runnerLog } = withRunner();
  writeStubNpx(root);
  gitIn(root, "config", "core.hooksPath", ".githooks");
  const git = (...args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...isolatedGitEnv(root), PATH: `${binDir}:${process.env.PATH ?? ""}`, SONDER_PUSH_CI_LAND_INTERVAL: "0.1", SONDER_PUSH_CI_LAND_TIMEOUT: "2" },
    });
  const npxLog = join(root, "npx.log");

  // A commit of documentation only: no typecheck. One with code, staged by -a: a typecheck.
  writeFileSync(join(root, "NOTES.md"), "notes\n");
  gitIn(root, "add", "NOTES.md");
  const docsCommit = git("commit", "-m", "notes");
  assert.equal(docsCommit.status, 0, docsCommit.stderr);
  assert.equal(existsSync(npxLog), false);
  writeFileSync(join(root, "src", "app.ts"), "export const one = 10;\n");
  const codeCommit = git("commit", "-am", "code");
  assert.equal(codeCommit.status, 0, codeCommit.stderr);
  assert.deepEqual(readFileSync(npxLog, "utf8").trim().split("\n"), ["tsc --noEmit"]);
  const head = gitIn(root, "rev-parse", "HEAD");

  // A dry run goes through the hook and sends nothing: no check.
  const dryRun = git("push", "--dry-run", "origin", "HEAD:refs/heads/work");
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout + dryRun.stderr, /when the push has landed/);
  await pause(2600);
  assert.deepEqual(runnerCalls(runnerLog), []);

  // The real push: one check, for the commit that landed.
  const push = git("push", "origin", "HEAD:refs/heads/work");
  assert.equal(push.status, 0, push.stderr);
  assert.ok(await waitFor(() => runnerCalls(runnerLog).length === 1));
  assert.deepEqual(runnerCalls(runnerLog), [`sha=${head} git=[]`]);
});

test("pre-commit hook runs no typecheck when only documentation is staged", () => {
  const root = makeTempRepo();
  seedRepo(root);
  const { binDir, logPath } = writeStubNpx(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "plan.md"), "plan\n");
  writeFileSync(join(root, "README.md"), "readme\n");
  gitIn(root, "add", "docs/plan.md", "README.md");
  const result = runPreCommit(root, binDir, { SONDER_STUB_TSC_EXIT: "1" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /only documentation is staged/);
  assert.equal(existsSync(logPath), false);
});

test("pre-commit hook typechecks when code is staged, also beside documentation or moved into docs", () => {
  const root = makeTempRepo();
  seedRepo(root);
  const { binDir, logPath } = writeStubNpx(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "plan.md"), "plan\n");
  writeFileSync(join(root, "src", "other.ts"), "export {};\n");
  gitIn(root, "add", "docs/plan.md", "src/other.ts");
  const mixed = runPreCommit(root, binDir, { SONDER_STUB_TSC_EXIT: "0" });
  assert.equal(mixed.status, 0, mixed.stderr || mixed.stdout);
  gitIn(root, "commit", "-qm", "mixed", "--no-verify");

  // A code file moved into docs/ is also a code file removed.
  gitIn(root, "mv", "src/app.ts", "docs/app.ts");
  const moved = runPreCommit(root, binDir, { SONDER_STUB_TSC_EXIT: "0" });
  assert.equal(moved.status, 0, moved.stderr || moved.stdout);
  assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), ["tsc --noEmit", "tsc --noEmit"]);
});

test("pre-commit hook allows commit when npx tsc --noEmit passes", () => {
  const root = makeTempRepo();
  try {
    const { binDir, logPath } = writeStubNpx(root);
    const result = runPreCommit(root, binDir, {
      SONDER_STUB_TSC_EXIT: "0",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    // The hook must run exactly the typecheck, nothing else.
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), ["tsc --noEmit"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-commit hook blocks commit when npx tsc --noEmit fails", () => {
  const root = makeTempRepo();
  try {
    const { binDir } = writeStubNpx(root);
    const result = runPreCommit(root, binDir, {
      SONDER_STUB_TSC_EXIT: "1",
    });
    assert.notEqual(result.status, 0);
    const err = `${result.stderr}${result.stdout}`;
    assert.match(err, /npx tsc --noEmit/);
    assert.match(err, /Skip once with SONDER_SKIP_PRECOMMIT=1 git commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-commit hook skips checks when SONDER_SKIP_PRECOMMIT=1", () => {
  const root = makeTempRepo();
  try {
    const { binDir, logPath } = writeStubNpx(root);
    const result = runPreCommit(root, binDir, {
      SONDER_SKIP_PRECOMMIT: "1",
      SONDER_STUB_TSC_EXIT: "1",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Pre-commit hook skipped \(SONDER_SKIP_PRECOMMIT=1\)\./);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-hooks.sh sets core.hooksPath in a temporary clone", () => {
  const root = makeTempRepo();
  const installScript = join(repoRoot, "scripts", "install-hooks.sh");
  try {
    const result = spawnSync("bash", [installScript], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = spawnSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(config.stdout.trim(), ".githooks");
    assert.match(result.stdout, /\.githooks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-hooks.sh is a no-op outside a git repository", () => {
  // npm ci runs the "prepare" script even where there is no .git (a git
  // archive snapshot under npm run check); the script must not fail there.
  const root = mkdtempSync(join(tmpdir(), "sonder-install-hooks-"));
  const installScript = join(repoRoot, "scripts", "install-hooks.sh");
  try {
    const result = spawnSync("bash", [installScript], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /not inside a git repository/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package.json defines a prepare script that installs the hooks", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    pkg.scripts?.prepare,
    "test -f scripts/install-hooks.sh && bash scripts/install-hooks.sh || true",
  );
});

test("prepare command exits 0 when scripts/install-hooks.sh is missing", () => {
  // The Dockerfile copies package.json before scripts/, so npm ci runs the
  // prepare script in a directory without it and must not fail.
  const root = mkdtempSync(join(tmpdir(), "sonder-prepare-"));
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const prepare = pkg.scripts?.prepare;
  assert.ok(typeof prepare === "string", "prepare script must be defined");
  try {
    const result = spawnSync("bash", ["-c", prepare], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
