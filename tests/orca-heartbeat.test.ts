import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tempDir } from "./temp-dir.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The heartbeat runs from a copy in a scratch repository, with shims for node, curl, df and
// check-workers.sh, so it reads no inbox, no production and not this machine's disk.
function sandbox(dfRoot: string) {
  const dir = tempDir("orca-heartbeat-");
  const bin = join(dir, "bin");
  const orca = join(dir, "scripts", "orca");
  mkdirSync(bin, { recursive: true });
  mkdirSync(orca, { recursive: true });
  copyFileSync(join(repoRoot, "scripts", "orca", "heartbeat.sh"), join(orca, "heartbeat.sh"));
  const shim = (path: string, body: string) => {
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  shim(join(orca, "check-workers.sh"), 'echo "no workers"');
  shim(join(bin, "node"), "exit 0");
  shim(join(bin, "curl"), "exit 7");
  // Real `df -h /` and `df -BG .` output shapes (GNU coreutils), the root line from dfRoot.
  shim(
    join(bin, "df"),
    [
      'if [[ $1 == -h && $2 == / ]]; then',
      "  printf 'Filesystem      Size  Used Avail Use%% Mounted on\\n%s\\n' " + JSON.stringify(dfRoot),
      "else",
      "  printf 'Filesystem     1G-blocks  Used Available Use%% Mounted on\\n/dev/sda2           457G  425G       12G  98%% /\\n'",
      "fi",
    ].join("\n"),
  );
  return { dir, script: join(orca, "heartbeat.sh"), env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

test("the heartbeat output names the root filesystem's use from df -h /", () => {
  const box = sandbox("/dev/sda2       457G  425G   12G  98% /");
  const r = spawnSync("bash", [box.script, "run-1"], { cwd: box.dir, env: box.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^== host$/m);
  assert.match(r.stdout, /^root filesystem: 98% used, 12G free of 457G \(\/dev\/sda2\)$/m);
  assert.match(r.stdout, /^disk free: 12G$/m);
  assert.match(readFileSync(join(box.dir, "artifacts", "orca", "HEARTBEAT.log"), "utf8"), /^\d{4}-\d\d-\d\dT[\d:]+Z$/m);
});
