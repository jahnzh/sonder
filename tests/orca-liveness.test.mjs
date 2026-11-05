import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeWorkersAfterEmptyWaits,
  readLivenessState,
  snapshotWorkerWorktrees,
  worktreeSnapshotsEqual,
} from "../scripts/orca-liveness.mjs";
import { REAL_EXHAUSTED } from "./codex-fixture.mjs";

const worker = {
  dispatchId: "ctx_codex1",
  agentTerminalHandle: "term_codex1",
  projection: {
    dispatchId: "ctx_codex1",
    provider: { id: "codex" },
    workspace: { id: "uuid::/tmp/worktree-a" },
  },
};

test("probeWorkersAfterEmptyWaits waits for two stable empty waits before reading terminals", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-liveness-"));
  const statePath = join(dir, "state.json");
  const reads = [];
  try {
    const fp = () => "deadbeef\n";
    probeWorkersAfterEmptyWaits({
      runId: "run_1",
      workers: [worker],
      statePath,
      readTerminal: (handle) => {
        reads.push(handle);
        return { ok: true, text: "" };
      },
      worktreeFingerprint: fp,
    });
    assert.deepEqual(reads, []);
    assert.equal(readLivenessState(statePath).emptyWaits, 1);

    probeWorkersAfterEmptyWaits({
      runId: "run_1",
      workers: [worker],
      statePath,
      readTerminal: (handle) => {
        reads.push(handle);
        return { ok: true, text: REAL_EXHAUSTED.rateLimitUpsell.title };
      },
      worktreeFingerprint: fp,
    });
    assert.deepEqual(reads, ["term_codex1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeWorkersAfterEmptyWaits flags usage-limit lines on stderr payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-liveness-flag-"));
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ runId: "run_1", emptyWaits: 1, snapshots: { ctx_codex1: "same\n" } }));
  try {
    const flags = probeWorkersAfterEmptyWaits({
      runId: "run_1",
      workers: [worker],
      statePath,
      readTerminal: () => ({ ok: true, text: REAL_EXHAUSTED.rateLimitUpsell.title }),
      worktreeFingerprint: () => "same\n",
    });
    assert.equal(flags.length, 1);
    assert.match(flags[0], /^liveness: usage-limit dispatch=ctx_codex1 terminal=term_codex1 agent=codex pattern=codex-out-of-messages/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktreeSnapshotsEqual compares dispatch fingerprints", () => {
  const a = snapshotWorkerWorktrees([worker], { worktreeFingerprint: () => "abc\n" });
  const b = snapshotWorkerWorktrees([worker], { worktreeFingerprint: () => "abc\n" });
  assert.equal(worktreeSnapshotsEqual(a, b), true);
  const c = snapshotWorkerWorktrees([worker], { worktreeFingerprint: () => "def\n" });
  assert.equal(worktreeSnapshotsEqual(a, c), false);
});
