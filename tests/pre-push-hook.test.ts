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
  for (const hook of ["pre-push", "pre-commit"]) {
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
  return spawnSync(join(root, ".githooks", "pre-push"), [], {
    cwd: root,
    encoding: "utf8",
    input: stdin,
    env: {
      // The hook asks git what is pushed; a GIT_ variable of the caller (a hook that runs these tests) must not answer for it.
      ...isolatedGitEnv(root),
      // A skip variable set in the caller's shell must not decide these tests.
      SONDER_SKIP_PREPUSH: undefined,
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
      ...process.env,
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
