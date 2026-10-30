import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendTimingRecord,
  formatSlowStepWarning,
  installReaderWaitBudget,
  READER_SPEC_TIMEOUT_MS,
  READER_WAIT_MS,
  recordSlowStep,
  SLOW_STEP_MS,
  timedWait,
  timingEnabled,
  timingFilePath,
  type TimingRecord,
} from "./e2e/timing.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const summarize = join(repoRoot, "scripts", "summarize-e2e-timing.mjs");

test("timing stays off unless SONDER_E2E_TIMING is 1", () => {
  assert.equal(timingEnabled({}), false);
  assert.equal(timingEnabled({ SONDER_E2E_TIMING: "0" }), false);
  assert.equal(timingEnabled({ SONDER_E2E_TIMING: "1" }), true);
  assert.equal(timingFilePath({}), "test-results/e2e-timing.jsonl");
  assert.equal(
    timingFilePath({ SONDER_E2E_TIMING_FILE: "/tmp/custom.jsonl" }),
    "/tmp/custom.jsonl",
  );
});

test("READER_WAIT_MS ceilings are named and sit above the measured idle maxima", () => {
  // Idle-machine maxima from issue #115 / d47d13c: 103 ms, 1.2 s, 116 ms, 2.6 s.
  assert.equal(READER_WAIT_MS.sentenceChange, 45_000);
  assert.equal(READER_WAIT_MS.followHighlight, 45_000);
  assert.equal(READER_WAIT_MS.historyRestore, 45_000);
  assert.equal(READER_WAIT_MS.checkpointRestore, 45_000);
  assert.equal(SLOW_STEP_MS, 10_000);
  assert.equal(READER_SPEC_TIMEOUT_MS, 180_000);
  assert.ok(READER_WAIT_MS.sentenceChange > SLOW_STEP_MS);
  assert.ok(READER_WAIT_MS.checkpointRestore > 2_600);
});

test("appendTimingRecord creates the parent directory in a temp tree", () => {
  const root = mkdtempSync(join(tmpdir(), "sonder-e2e-timing-"));
  try {
    const file = join(root, "out", "nested", "timing.jsonl");
    const record: TimingRecord = {
      step: "sentence-change",
      test: "example",
      elapsedMs: 42,
      at: "2026-10-30T00:00:00.000Z",
    };
    appendTimingRecord(file, record);
    assert.equal(existsSync(file), true);
    assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(record)}\n`);
    appendTimingRecord(file, { ...record, elapsedMs: 7 });
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timedWait skips the JSONL file without the env var and records elapsed ms when set", async () => {
  const root = mkdtempSync(join(tmpdir(), "sonder-e2e-timing-"));
  try {
    const file = join(root, "results", "e2e-timing.jsonl");
    let ran = 0;
    const slow: { step: string; elapsedMs: number }[] = [];
    await timedWait("sentence-change", async () => {
      ran += 1;
      return "ok";
    }, { env: {}, testName: "off", onSlow: (step, elapsedMs) => slow.push({ step, elapsedMs }) });
    assert.equal(ran, 1);
    assert.equal(existsSync(file), false);
    assert.equal(slow.length, 0);

    let clock = 1_000;
    const result = await timedWait(
      "follow-highlight",
      async () => {
        clock += 250;
        ran += 1;
        return "done";
      },
      {
        env: { SONDER_E2E_TIMING: "1", SONDER_E2E_TIMING_FILE: file },
        testName: "lyrics mode shows the narrated sentence",
        now: () => clock,
        onSlow: (step, elapsedMs) => slow.push({ step, elapsedMs }),
      },
    );
    assert.equal(result, "done");
    assert.equal(ran, 2);
    assert.equal(slow.length, 0);
    const line = JSON.parse(readFileSync(file, "utf8").trim()) as TimingRecord;
    assert.equal(line.step, "follow-highlight");
    assert.equal(line.test, "lyrics mode shows the narrated sentence");
    assert.equal(line.elapsedMs, 250);
    assert.equal(typeof line.at, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatSlowStepWarning includes the test name", () => {
  assert.equal(
    formatSlowStepWarning("SlowStep.test", "sentence-change", 12_700),
    "slow step SlowStep.test sentence-change 12700",
  );
});

test("recordSlowStep prints immediately before any process exit hook runs", () => {
  const printed: string[] = [];
  let exitHookRan = false;
  const onBeforeExit = () => {
    exitHookRan = true;
  };
  process.on("beforeExit", onBeforeExit);
  try {
    recordSlowStep("follow-highlight", 9_999, "under threshold", (line) => {
      printed.push(line);
    });
    assert.equal(printed.length, 0);

    recordSlowStep("sentence-change", 12_700, "SlowStep.test", (line) => {
      assert.equal(exitHookRan, false, "warning must print before beforeExit");
      printed.push(line);
    });
    assert.equal(exitHookRan, false);
    assert.deepEqual(printed, [
      formatSlowStepWarning("SlowStep.test", "sentence-change", 12_700),
    ]);
    assert.match(printed[0]!, /^slow step SlowStep\.test sentence-change 12700$/);
  } finally {
    process.off("beforeExit", onBeforeExit);
  }
});

test("timedWait writes the slow-step warning immediately with a fake clock and appends timing when on", async () => {
  const root = mkdtempSync(join(tmpdir(), "sonder-e2e-slow-"));
  try {
    const file = join(root, "out", "timing.jsonl");
    let clock = 5_000;
    const printed: string[] = [];
    let exitHookRan = false;
    const onBeforeExit = () => {
      exitHookRan = true;
    };
    process.on("beforeExit", onBeforeExit);
    try {
      await timedWait(
        "sentence-change",
        async () => {
          clock += 12_700;
          return "ok";
        },
        {
          env: { SONDER_E2E_TIMING: "1", SONDER_E2E_TIMING_FILE: file },
          testName: "switching from Word to Page",
          now: () => clock,
          warn: (line) => {
            assert.equal(exitHookRan, false, "warning must print before beforeExit");
            printed.push(line);
          },
        },
      );
      assert.equal(exitHookRan, false);
      assert.deepEqual(printed, [
        formatSlowStepWarning("switching from Word to Page", "sentence-change", 12_700),
      ]);
      const line = JSON.parse(readFileSync(file, "utf8").trim()) as TimingRecord;
      assert.equal(line.elapsedMs, 12_700);
      assert.equal(line.test, "switching from Word to Page");
      assert.equal(line.step, "sentence-change");
    } finally {
      process.off("beforeExit", onBeforeExit);
    }

    // At/under the threshold: no warning.
    printed.length = 0;
    clock = 0;
    await timedWait(
      "follow-highlight",
      async () => {
        clock += 9_999;
      },
      {
        env: {},
        testName: "lyrics",
        now: () => clock,
        warn: (line) => printed.push(line),
      },
    );
    assert.equal(printed.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarize-e2e-timing prints count median p90 max and flags steps over 10s", () => {
  const root = mkdtempSync(join(tmpdir(), "sonder-e2e-timing-sum-"));
  try {
    mkdirSync(root, { recursive: true });
    const file = join(root, "run.jsonl");
    const rows = [
      { step: "sentence-change", test: "a", elapsedMs: 100, at: "t" },
      { step: "sentence-change", test: "a", elapsedMs: 200, at: "t" },
      { step: "sentence-change", test: "a", elapsedMs: 300, at: "t" },
      { step: "sentence-change", test: "a", elapsedMs: 400, at: "t" },
      { step: "sentence-change", test: "a", elapsedMs: 12_000, at: "t" },
      { step: "checkpoint-restore", test: "b", elapsedMs: 50, at: "t" },
    ];
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const help = spawnSync(process.execPath, [summarize, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage:/);
    assert.match(help.stdout, /10000/);
    assert.match(help.stdout, /SLOW_STEP_MS/);

    const bad = spawnSync(process.execPath, [summarize], { encoding: "utf8" });
    assert.equal(bad.status, 2);

    const run = spawnSync(
      process.execPath,
      [summarize, "--label", "local", file],
      { encoding: "utf8", cwd: repoRoot },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /host: local/);
    assert.match(run.stdout, /sentence-change/);
    assert.match(run.stdout, /count=5/);
    assert.match(run.stdout, /median=300/);
    assert.match(run.stdout, /p90=12000/);
    assert.match(run.stdout, /max=12000/);
    assert.match(run.stdout, /SLOW/);
    assert.match(run.stdout, /checkpoint-restore/);

    // 6000 ms is under the shared 10 s cutoff — not flagged.
    const under = join(root, "under.jsonl");
    writeFileSync(
      under,
      `${JSON.stringify({ step: "follow-highlight", test: "c", elapsedMs: 6000, at: "t" })}\n`,
    );
    const underRun = spawnSync(
      process.execPath,
      [summarize, "--label", "local", under],
      { encoding: "utf8", cwd: repoRoot },
    );
    assert.equal(underRun.status, 0, underRun.stderr);
    assert.match(underRun.stdout, /max=6000/);
    assert.doesNotMatch(underRun.stdout, /SLOW/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installReaderWaitBudget registers the shared 180 s beforeEach timeout", () => {
  const calls: number[] = [];
  const hooks: Array<() => void> = [];
  const fakeTest = {
    beforeEach(fn: () => void) {
      hooks.push(fn);
    },
    setTimeout(ms: number) {
      calls.push(ms);
    },
  };
  installReaderWaitBudget(fakeTest);
  assert.equal(hooks.length, 1);
  hooks[0]!();
  assert.deepEqual(calls, [READER_SPEC_TIMEOUT_MS]);
});
