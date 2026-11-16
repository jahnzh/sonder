import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = ["watchdog.sh", "watch-inbox.sh", "check-workers.sh", "heartbeat.sh"] as const;

// A scratch directory with `orca` and `node` shims that only record that they were called. A helper that
// refuses the missing run id must never reach either of them, so no real Orca runtime is involved.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "orca-helper-run-id-"));
  const bin = join(dir, "bin");
  const runtime = join(dir, "runtime");
  const calls = join(dir, "calls.log");
  for (const name of ["orca", "node"]) {
    const shim = join(bin, name);
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(shim, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\nexit 0\n`);
    chmodSync(shim, 0o755);
  }
  spawnSync("mkdir", ["-p", runtime]);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: runtime };
  return { dir, runtime, calls, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const helper of HELPERS) {
  const script = join(repoRoot, "scripts", "orca", helper);

  test(`${helper} refuses to run without a run id, prints a usage line and touches nothing`, () => {
    const box = sandbox();
    try {
      const r = spawnSync("bash", [script], { cwd: box.dir, env: box.env, encoding: "utf8", timeout: 15_000 });
      assert.equal(r.status, 2, `exit code (stderr: ${r.stderr})`);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr.trim(), `usage: ${helper} <run_id>`);
      assert.equal(existsSync(box.calls), false, "neither orca nor node was called");
      assert.deepEqual(readdirSync(box.runtime), [], "no lock, pid or log file was created");
    } finally {
      box.cleanup();
    }
  });

  test(`${helper} refuses an empty run id`, () => {
    const box = sandbox();
    try {
      const r = spawnSync("bash", [script, ""], { cwd: box.dir, env: box.env, encoding: "utf8", timeout: 15_000 });
      assert.equal(r.status, 2);
      assert.equal(r.stderr.trim(), `usage: ${helper} <run_id>`);
      assert.equal(existsSync(box.calls), false);
    } finally {
      box.cleanup();
    }
  });

  test(`${helper} has no run id written into it`, () => {
    assert.doesNotMatch(readFileSync(script, "utf8"), /run_[0-9a-f]{6,}/);
  });
}

test("check-workers.sh passes the run id it was given to the Orca worker list", () => {
  const box = sandbox();
  try {
    const r = spawnSync("bash", [join(repoRoot, "scripts", "orca", "check-workers.sh"), "run_testonly"], { cwd: box.dir, env: box.env, encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(box.calls, "utf8").trim(), "orca orchestration worker-list --run run_testonly");
  } finally {
    box.cleanup();
  }
});
