import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  classifyDeliveryStatus,
  countVisibleQueuedFollowUps,
  extractFollowUpsBox,
  isWorkerScreenBusyLine,
} from "../scripts/orca/coordinator-screen.ts";

/**
 * Kill a detached session leader and every process in its group (bash, stub node, etc.).
 * Uses the process-group id returned by spawn(..., { detached: true }) — same as leader pid on Linux.
 */
function killWatcherProcessGroup(leaderPid: number) {
  try {
    process.kill(-leaderPid, "SIGKILL");
  } catch {
    try {
      process.kill(leaderPid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

/** No leftover watch-inbox.sh for this run id (avoids orphaned sleep 9999 stubs reparented to init). */
function assertNoWatchInboxForRun(runId: string) {
  // [/] so pgrep -f does not match its own argv.
  const needle = `[/]scripts/orca/watch-inbox.sh ${runId}`;
  const r = spawnSync("pgrep", ["-af", needle], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) {
    throw new Error(`leaked watch-inbox for ${runId}:\n${r.stdout.trim()}`);
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

test("delivery confirmation: idle agent, mid-turn agent, Codex agent, and not-found", () => {
  const idleScreen = readFileSync(join(fixtures, "idle-agent-turn-start.txt"), "utf8");
  assert.equal(classifyDeliveryStatus(idleScreen, "Please run unit tests"), "delivered");

  const midTurnScreen = readFileSync(join(fixtures, "mid-turn-follow-up.txt"), "utf8");
  assert.equal(classifyDeliveryStatus(midTurnScreen, "Fix issue 292 send-agent confirmation"), "queued");

  const codexScreen = readFileSync(join(fixtures, "codex-prompt-turn.txt"), "utf8");
  assert.equal(classifyDeliveryStatus(codexScreen, "Fix issue 292 send-agent confirmation"), "delivered");

  assert.equal(classifyDeliveryStatus(idleScreen, "nonexistent prompt message"), "not found");
});

test("follow-ups box: count ignores blank ○", () => {
  const screen = readFileSync(join(fixtures, "follow-ups-queue.txt"), "utf8");
  const box = extractFollowUpsBox(screen);
  assert.ok(box.includes("┌─ follow-ups"));
  assert.equal(countVisibleQueuedFollowUps(box), 2);
});

test("watch-inbox: lock contention, then consume and log", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-watch-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  /** Unique per run so pgrep cannot collide with other tests or leaked PIDs. */
  const run = `run_test_watch_inbox_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

  let first: ChildProcess | null = null;
  let groupLeader: number | null = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (groupLeader != null) {
      killWatcherProcessGroup(groupLeader);
      groupLeader = null;
    }
    if (first) {
      first.removeAllListeners();
      if (!first.killed) {
        try {
          first.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
      first = null;
    }
    try {
      assertNoWatchInboxForRun(run);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir race */
      }
    }
  };

  t.after(cleanup);

  try {
    // Own process group (leader pid == pgid) so one kill reaches bash + stub node.
    first = spawn("bash", [watchScript, run], {
      env,
      detached: true,
      stdio: "ignore",
    }) as ChildProcess;
    const firstPid = first.pid;
    if (firstPid == null) throw new Error("watch-inbox spawn returned no pid");
    groupLeader = firstPid;

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

    killWatcherProcessGroup(firstPid);
    groupLeader = null;
    await Promise.race([
      once(first, "exit"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("first watcher did not exit")), 5000)),
    ]);

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
  } finally {
    cleanup();
  }
});
