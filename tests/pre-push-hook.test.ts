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
const hookSource = join(repoRoot, ".githooks", "pre-push");

function makeTempRepo() {
  const root = mkdtempSync(join(tmpdir(), "sonder-pre-push-hook-"));
  mkdirSync(join(root, ".githooks"), { recursive: true });
  cpSync(hookSource, join(root, ".githooks", "pre-push"));
  chmodSync(join(root, ".githooks", "pre-push"), 0o755);
  spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
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
