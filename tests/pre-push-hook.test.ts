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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function gitIn(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...env, HOME: cwd, XDG_CONFIG_HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeTempRepo() {
  const root = mkdtempSync(join(tmpdir(), "sonder-git-hooks-"));
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
if [[ "$1" == "test" ]]; then
  if [[ -n "\${SONDER_STUB_TEST_HANG:-}" ]]; then
    exec sleep 86400
  fi
  exit "\${SONDER_STUB_TEST_EXIT:-0}"
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
      ...process.env,
      // A skip variable set in the caller's shell must not decide these tests.
      SONDER_SKIP_PREPUSH: undefined,
      ...env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
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

test("pre-push hook allows push when build and unit tests pass", () => {
  const root = makeTempRepo();
  try {
    const { binDir, logPath } = writeStubNpm(root);
    const result = runHook(root, binDir, {
      SONDER_STUB_BUILD_EXIT: "0",
      SONDER_STUB_TEST_EXIT: "0",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    // Both commands must have run, in this order.
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), ["run build", "test"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-push isolates a git fixture from the pushing repository and every GIT_ variable", () => {
  const root = makeTempRepo();
  try {
    const pushingRepo = join(root, "pushing-repo");
    const fixtureRepo = join(root, "fixture-repo");
    const binDir = join(root, "bin");
    const envFile = join(root, "test-env.json");
    for (const dir of [pushingRepo, fixtureRepo, binDir]) mkdirSync(dir);

    gitIn(pushingRepo, "init");
    gitIn(pushingRepo, "config", "user.name", "Original User");
    gitIn(pushingRepo, "config", "user.email", "original@example.test");
    writeFileSync(join(pushingRepo, "original.txt"), "original content\n");
    gitIn(pushingRepo, "add", "original.txt");
    gitIn(pushingRepo, "commit", "-m", "original");
    const before = {
      head: gitIn(pushingRepo, "rev-parse", "HEAD"),
      status: gitIn(pushingRepo, "status", "--porcelain"),
      config: readFileSync(join(pushingRepo, ".git", "config")),
      index: readFileSync(join(pushingRepo, ".git", "index")),
      content: readFileSync(join(pushingRepo, "original.txt"), "utf8"),
    };

    writeFileSync(join(binDir, "npm"), `#!/usr/bin/env bash
set -eu
if [[ "$1" == "run" && "$2" == "build" ]]; then exit 0; fi
[[ "$1" == "test" ]]
node -e 'require("fs").writeFileSync(process.env.TEST_ENV_FILE, JSON.stringify({ git: Object.keys(process.env).filter((key) => key.startsWith("GIT_")), keep: process.env.TEST_KEEP }))'
cd "$TEST_FIXTURE_REPO"
git init
git config user.name Fixture
git config user.email fixture@example.test
printf 'fixture content\\n' > fixture.txt
git add fixture.txt
git commit -m fixture
`, { mode: 0o755 });

    const result = runHook(root, binDir, {
      HOME: root,
      XDG_CONFIG_HOME: root,
      GIT_DIR: join(pushingRepo, ".git"),
      GIT_WORK_TREE: pushingRepo,
      GIT_INDEX_FILE: join(pushingRepo, ".git", "index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Injected Name",
      GIT_FUTURE_TEST_VARIABLE: "must disappear",
      "GIT_FUTURE.TEST_VARIABLE": "must also disappear",
      TEST_ENV_FILE: envFile,
      TEST_FIXTURE_REPO: fixtureRepo,
      TEST_KEEP: "preserved\nGIT_DECOY=part of a value",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(envFile, "utf8")), {
      git: [], keep: "preserved\nGIT_DECOY=part of a value",
    });
    assert.equal(gitIn(fixtureRepo, "log", "-1", "--format=%s"), "fixture");
    assert.equal(gitIn(pushingRepo, "rev-parse", "HEAD"), before.head);
    assert.equal(gitIn(pushingRepo, "status", "--porcelain"), before.status);
    assert.deepEqual(readFileSync(join(pushingRepo, ".git", "config")), before.config);
    assert.deepEqual(readFileSync(join(pushingRepo, ".git", "index")), before.index);
    assert.equal(readFileSync(join(pushingRepo, "original.txt"), "utf8"), before.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-push hook blocks push when npm run build fails", () => {
  const root = makeTempRepo();
  try {
    const { binDir } = writeStubNpm(root);
    const result = runHook(root, binDir, {
      SONDER_STUB_BUILD_EXIT: "1",
      SONDER_STUB_TEST_EXIT: "0",
    });
    assert.notEqual(result.status, 0);
    const err = `${result.stderr}${result.stdout}`;
    assert.match(err, /build/i);
    assert.match(err, /Skip once with SONDER_SKIP_PREPUSH=1 git push/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-push hook blocks push when npm test fails", () => {
  const root = makeTempRepo();
  try {
    const { binDir } = writeStubNpm(root);
    const result = runHook(root, binDir, {
      SONDER_STUB_BUILD_EXIT: "0",
      SONDER_STUB_TEST_EXIT: "1",
    });
    assert.notEqual(result.status, 0);
    const err = `${result.stderr}${result.stdout}`;
    assert.match(err, /npm test/i);
    assert.match(err, /Skip once with SONDER_SKIP_PREPUSH=1 git push/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-push hook times out a hung npm test in bounded time and keeps HEAD on the pushing branch", () => {
  const root = makeTempRepo();
  try {
    gitIn(root, "checkout", "-q", "-b", "feature/push");
    gitIn(root, "config", "user.name", "Test");
    gitIn(root, "config", "user.email", "test@example.test");
    writeFileSync(join(root, "tracked.txt"), "content\n");
    gitIn(root, "add", "tracked.txt");
    gitIn(root, "commit", "-qm", "tracked");
    const before = {
      head: gitIn(root, "rev-parse", "HEAD"),
      branch: gitIn(root, "symbolic-ref", "--short", "HEAD"),
    };
    const { binDir } = writeStubNpm(root);
    const startedAt = Date.now();
    const result = runHook(root, binDir, {
      SONDER_STUB_BUILD_EXIT: "0",
      SONDER_STUB_TEST_HANG: "1",
      SONDER_PREPUSH_TEST_TIMEOUT_SEC: "2",
    });
    const elapsedMs = Date.now() - startedAt;
    assert.notEqual(result.status, 0);
    const err = `${result.stderr}${result.stdout}`;
    assert.match(err, /npm test timed out after 2s/i);
    assert.match(err, /Skip once with SONDER_SKIP_PREPUSH=1 git push/);
    assert.ok(elapsedMs < 15_000, `hook should fail closed quickly (took ${elapsedMs}ms)`);
    assert.equal(gitIn(root, "rev-parse", "HEAD"), before.head);
    assert.equal(gitIn(root, "symbolic-ref", "--short", "HEAD"), before.branch);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-push hook skips checks when SONDER_SKIP_PREPUSH=1", () => {
  const root = makeTempRepo();
  try {
    const { binDir, logPath } = writeStubNpm(root);
    const result = runHook(root, binDir, { SONDER_SKIP_PREPUSH: "1" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /skipped/i);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
