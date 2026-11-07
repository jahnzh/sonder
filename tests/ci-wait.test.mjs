import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/ci-wait.sh");

function wait(content, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wait-"));
  const log = path.join(dir, "run.log");
  if (content !== null) fs.writeFileSync(log, content);
  const r = spawnSync("bash", [script, log], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, SONDER_CI_WAIT_INTERVAL: "0.1", SONDER_CI_WAIT_TIMEOUT: "2", ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test("exits 0 on Artifacts after a passing run", () => {
  const r = wait("[ci-ssh] SSH reachable\n[ci-ssh] Waiting for the check\n# fail 0\n[ci-ssh] Artifacts: /x\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /passed/);
});

test("exits 0 on a bare passed line", () => {
  assert.equal(wait("passed\n").status, 0);
});

test("exits 1 when the remote check failed", () => {
  const r = wait("[ci-ssh] Remote check failed with exit code 7 (no local rerun)\n[ci-ssh] Artifacts: /x\n");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /failed/);
});

test("exits 1 on a bare failed line and on a bare exit code", () => {
  assert.equal(wait("failed\n").status, 1);
  assert.equal(wait("exit code 3\n").status, 1);
  assert.equal(wait("exit code 0\n").status, 0);
});

test("exits 1 on setup failure without Artifacts", () => {
  for (const line of [
    "[ci-ssh] Invalid commit ref: nope",
    "[ci-ssh] Refusing to run: scripts differ",
    "[ci-ssh] SONDER_CI_MAX_WAIT must be whole seconds",
    "[ci-ssh] Could not create the git bundle",
  ]) {
    const r = wait(`${line}\n`);
    assert.equal(r.status, 1, line);
    assert.match(r.stdout, /setup failure/);
  }
});

test("test output such as '0 failed' does not end the wait", () => {
  const r = wait("ℹ 0 failed\n12 passed\n");
  assert.equal(r.status, 124);
});

test("waits for a log written later", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wait-"));
  const log = path.join(dir, "run.log");
  fs.writeFileSync(log, "[ci-ssh] working\n");
  const child = spawnSync(
    "bash",
    ["-c", `(sleep 0.5; echo '[ci-ssh] Artifacts: /x' >> "${log}") & bash "${script}" "${log}"`],
    { encoding: "utf8", timeout: 20000, env: { ...process.env, SONDER_CI_WAIT_INTERVAL: "0.1", SONDER_CI_WAIT_TIMEOUT: "10" } },
  );
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test("usage error and missing log exit 2", () => {
  assert.equal(spawnSync("bash", [script], { encoding: "utf8" }).status, 2);
  assert.equal(wait(null).status, 2);
});
