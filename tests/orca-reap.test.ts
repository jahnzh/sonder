import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "orca-reap.sh");

function reap(args: string[]) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    timeout: 60000,
  });
}

function makeWorktree() {
  return realpathSync(mkdtempSync(join(tmpdir(), "sonder-reap-")));
}

test("exits 2 on bad usage", () => {
  assert.equal(reap([]).status, 2);
  assert.equal(reap(["a", "b"]).status, 2);
});

test("exits 1 when the worktree does not exist", () => {
  const result = reap([join(tmpdir(), "sonder-reap-nope-missing")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /worktree not found/);
});

test("prints nothing to reap for a clean worktree", () => {
  const worktree = makeWorktree();
  try {
    const result = reap([worktree]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^nothing to reap: .+$/m);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("SIGTERMs a process whose working directory is the worktree", async () => {
  const worktree = makeWorktree();
  const child = spawn("sleep", ["30"], { cwd: worktree, stdio: "ignore" });
  try {
    await new Promise((done) => child.once("spawn", done));
    const result = reap([worktree]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`reaping: ${child.pid}`));
    assert.match(result.stdout, new RegExp(`reaped: ${child.pid}`));
    await new Promise((done) => child.once("exit", done));
    assert.equal(child.signalCode, "SIGTERM");
  } finally {
    child.kill();
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
  const worktree = makeWorktree();
  // One bash process (no children) that ignores SIGTERM and blocks in read while its stdin stays open.
  const child = spawn("bash", ["-c", "trap '' TERM; read -r _"], {
    cwd: worktree,
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    await new Promise((done) => child.once("spawn", done));
    const result = reap([worktree]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`reaping: ${child.pid}`));
    assert.match(result.stdout, new RegExp(`reaped: ${child.pid}`));
    await new Promise((done) => child.once("exit", done));
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    if (child.stdin && child.stdin.writable) child.stdin.end();
    child.kill();
    rmSync(worktree, { recursive: true, force: true });
  }
});
