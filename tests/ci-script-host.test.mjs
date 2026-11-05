import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(repoRoot, "tests", "ci-script-host-runner.mjs");

function gitIn(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...env, HOME: cwd, XDG_CONFIG_HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeHostingClone() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-script-host-"));
  const clone = path.join(base, "clone");
  const cloneResult = spawnSync("git", ["clone", "--local", "-q", repoRoot, clone], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
  assert.equal(cloneResult.status, 0, cloneResult.stderr || cloneResult.stdout);
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(clone, "node_modules"), "dir");
  gitIn(clone, "checkout", "-q", "-b", "hosting-branch");
  gitIn(clone, "config", "user.name", "Hosting Clone");
  gitIn(clone, "config", "user.email", "host@example.test");
  fs.writeFileSync(path.join(clone, "host-marker.txt"), "hosting\n");
  gitIn(clone, "add", "host-marker.txt");
  gitIn(clone, "commit", "-qm", "hosting marker");
  const before = {
    head: gitIn(clone, "rev-parse", "HEAD"),
    branch: gitIn(clone, "symbolic-ref", "--short", "HEAD"),
    status: gitIn(clone, "status", "--porcelain"),
  };
  return { base, clone, before };
}

function cleanRunnerEnv(base) {
  const env = {
    ...process.env,
    HOME: base,
    XDG_CONFIG_HOME: base,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST")) {
      delete env[key];
    }
  }
  return env;
}

test("ci script unit tests do not mutate a hosting clone HEAD or branch", { timeout: 600_000 }, () => {
  const { base, clone, before } = makeHostingClone();
  try {
    const result = spawnSync(process.execPath, [runner, clone], {
      encoding: "utf8",
      env: cleanRunnerEnv(base),
      timeout: 540_000,
    });
    assert.equal(
      result.status,
      0,
      `ci script tests failed in hosting clone:\n${result.stderr}\n${result.stdout}`,
    );
    assert.equal(gitIn(clone, "rev-parse", "HEAD"), before.head);
    assert.equal(gitIn(clone, "symbolic-ref", "--short", "HEAD"), before.branch);
    assert.equal(gitIn(clone, "status", "--porcelain"), before.status);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
