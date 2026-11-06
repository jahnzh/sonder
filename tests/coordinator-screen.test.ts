import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  countVisibleQueuedFollowUps,
  extractFollowUpsBox,
  isWorkerScreenBusyLine,
} from "../scripts/orca/coordinator-screen.ts";

/** detached bash+stub subtree: kill the whole process group (negative signal). */
function killWatcherTree(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(repoRoot, "tests/fixtures/orca-screen");

test("busy line: Cursor spinner + Titlecase+ing", () => {
  const line = readFileSync(join(fixtures, "cursor-busy.txt"), "utf8").split(/\r?\n/)[2];
  assert.equal(isWorkerScreenBusyLine(line), true);
});

test("busy line: Codex • Working (", () => {
  const line = readFileSync(join(fixtures, "codex-bullet-working.txt"), "utf8").split(/\r?\n/)[0];
  assert.equal(isWorkerScreenBusyLine(line), true);
});

test("follow-ups box: count ignores blank ○", () => {
  const screen = readFileSync(join(fixtures, "follow-ups-queue.txt"), "utf8");
  const box = extractFollowUpsBox(screen);
  assert.ok(box.includes("┌─ follow-ups"));
  assert.equal(countVisibleQueuedFollowUps(box), 2);
});

test("watch-inbox: lock contention, then consume and log", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-watch-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const run = "run_test_watch_inbox";
  const rt = join(dir, "runtime");
  mkdirSync(rt);

  const nodeStub = join(bin, "node");
  const writeStubBlock = () => {
    writeFileSync(
      nodeStub,
      `#!/usr/bin/env bash
set -euo pipefail
if echo "$*" | grep -qE -- '--wait'; then
  sleep 9999
  exit 0
fi
exit 0
`,
    );
    chmodSync(nodeStub, 0o755);
  };

  const writeStubMessage = () => {
    writeFileSync(
      nodeStub,
      `#!/usr/bin/env bash
set -euo pipefail
if echo "$*" | grep -qE -- '--wait'; then
  printf '%s\\n' "count=1 delivery=delivery_stub001 timedOut=false"
  printf '%s\\n' "msg_abc222 worker_done | hello subject | term_t1 | body | {}"
elif echo "$*" | grep -qE -- '--ack delivery_stub001'; then
  printf '%s\\n' "count=0 delivery=null timedOut=false"
fi
exit 0
`,
    );
    chmodSync(nodeStub, 0o755);
  };

  writeStubBlock();

  const watchScript = join(repoRoot, "scripts/orca/watch-inbox.sh");
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
    XDG_RUNTIME_DIR: rt,
  };

  const first = spawn("bash", [watchScript, run], {
    env,
    detached: true,
    stdio: "ignore",
  }) as ChildProcess;
  const firstPid = first.pid;
  if (firstPid == null) throw new Error("watch-inbox spawn returned no pid");

  const holderFile = join(rt, `sonder-watch-inbox-${run}.pid`);
  let sawPid = false;
  for (let i = 0; i < 80; i++) {
    try {
      const h = readFileSync(holderFile, "utf8").trim().split(/\r?\n/)[0];
      if (h && h === String(firstPid)) {
        sawPid = true;
        break;
      }
    } catch {
      /* not created yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(sawPid, "first watcher should write its PID beside the lock file");

  const second = spawnSync("bash", [watchScript, run], {
    env,
    encoding: "utf8",
  });
  assert.equal(second.status, 1, second.stdout + second.stderr);
  const combined = `${second.stderr}${second.stdout}`;
  assert.match(combined, /PID\s+\d+/);
  assert.ok(combined.includes(String(firstPid)));

  killWatcherTree(firstPid);
  await once(first, "exit");

  writeStubMessage();
  const third = spawnSync("bash", [watchScript, run], {
    env,
    encoding: "utf8",
  });
  assert.equal(third.status, 0, third.stdout + third.stderr);

  const logPath = join(rt, `sonder-watch-inbox-${run}.log`);
  const log = readFileSync(logPath, "utf8").trim();
  assert.ok(log.includes("msg_abc222"));
  assert.ok(log.includes("worker_done"));
  assert.ok(log.includes("hello subject"));

  rmSync(dir, { recursive: true, force: true });
});
