import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(repoRoot, "tests", "ci-script-host-runner.mjs");

/** Minimal tree so ci-run.test.mjs can run from a throwaway hosting repo (works under git archive). */
const HOSTING_COPY_PATHS = [
  "package.json",
  "scripts/ci-run.sh",
  "tests/ci-run.test.mjs",
];

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

function makeHostingRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-script-host-"));
  const hosting = path.join(base, "hosting");
  fs.mkdirSync(hosting, { recursive: true });
  for (const rel of HOSTING_COPY_PATHS) {
    const src = path.join(repoRoot, rel);
    const dest = path.join(hosting, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(hosting, "node_modules"), "dir");
  gitIn(hosting, "init", "-q", "-b", "main");
  gitIn(hosting, "config", "user.name", "Hosting Repo");
  gitIn(hosting, "config", "user.email", "host@example.test");
  gitIn(hosting, "add", ...HOSTING_COPY_PATHS);
  gitIn(hosting, "commit", "-qm", "fixture");
  gitIn(hosting, "checkout", "-q", "-b", "hosting-branch");
  fs.writeFileSync(path.join(hosting, "host-marker.txt"), "hosting\n");
  gitIn(hosting, "add", "host-marker.txt");
  gitIn(hosting, "commit", "-qm", "hosting marker");
  const before = {
    head: gitIn(hosting, "rev-parse", "HEAD"),
    branch: gitIn(hosting, "symbolic-ref", "--short", "HEAD"),
    status: gitIn(hosting, "status", "--porcelain"),
  };
  return { base, hosting, before };
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

test("ci-run tests do not mutate a hosting repo HEAD or branch", { timeout: 120_000 }, () => {
  const { base, hosting, before } = makeHostingRepo();
  const startedAt = Date.now();
  try {
    const result = spawnSync(process.execPath, [runner, hosting], {
      encoding: "utf8",
      env: cleanRunnerEnv(base),
      timeout: 90_000,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(
      result.status,
      0,
      `ci-run tests failed in hosting repo (${elapsedMs}ms):\n${result.stderr}\n${result.stdout}`,
    );
    assert.equal(gitIn(hosting, "rev-parse", "HEAD"), before.head);
    assert.equal(gitIn(hosting, "symbolic-ref", "--short", "HEAD"), before.branch);
    assert.equal(gitIn(hosting, "status", "--porcelain"), before.status);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
