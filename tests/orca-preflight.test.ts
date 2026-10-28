import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "orca-preflight.sh");

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-preflight-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
  git(dir, "add", "AGENTS.md");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  return dir;
}

function preflight(args: string[], cwd = tmpdir()) {
  return spawnSync("bash", [script, ...args], { cwd, encoding: "utf8" });
}

test("passes when the doc exists on the base branch and the worktree is idle", () => {
  const repo = makeRepo();
  try {
    const result = preflight(["main", repo, "AGENTS.md"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fails with one line per missing doc", () => {
  const repo = makeRepo();
  try {
    const result = preflight(["main", repo, "AGENTS.md", "CLAUDE.md", "NOPE.md"]);
    assert.equal(result.status, 1);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /CLAUDE\.md/);
    assert.match(lines[1], /NOPE\.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reports a process whose working directory is the worktree", async () => {
  const repo = makeRepo();
  const sub = join(repo, "sub");
  mkdirSync(sub);
  const child = spawn("sleep", ["30"], { cwd: sub, stdio: "ignore" });
  try {
    await new Promise((done) => child.once("spawn", done));
    const full = preflight(["main", repo, "AGENTS.md"]);
    assert.equal(full.status, 1);
    assert.match(full.stdout, new RegExp(`process ${child.pid} .*sleep 30`));

    const after = preflight(["--after-stop", repo]);
    assert.equal(after.status, 1);
    assert.match(after.stdout, new RegExp(`process ${child.pid} `));

    // --after-stop runs only the process check, so a missing doc is not reported.
    child.kill();
    await new Promise((done) => child.once("exit", done));
    const clean = preflight(["--after-stop", repo]);
    assert.equal(clean.status, 0, clean.stdout);
  } finally {
    child.kill();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ignores the caller and its parents even when they sit in the worktree", () => {
  const repo = makeRepo();
  try {
    const result = preflight(["main", repo, "AGENTS.md"], repo);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checks docs in the current repo when the worktree path does not exist yet", () => {
  const repo = makeRepo();
  try {
    const missingPath = join(repo, "not-created-yet");
    const ok = preflight(["main", missingPath, "AGENTS.md"], repo);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const missing = preflight(["main", missingPath, "NOPE.md"], repo);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /NOPE\.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("exits 2 on bad usage", () => {
  assert.equal(preflight([]).status, 2);
  assert.equal(preflight(["main", "/tmp"]).status, 2);
  assert.equal(preflight(["--after-stop"]).status, 2);
});
