import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendTimingRecord,
  flushSlowStepWarnings,
  formatSlowStepWarning,
  READER_WAIT_MS,
  recordSlowStep,
  resetSlowStepsForTests,
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

test("timedWait records a slow step over 10 s with a fake clock and flush prints one line", async () => {
  const root = mkdtempSync(join(tmpdir(), "sonder-e2e-slow-"));
  try {
    resetSlowStepsForTests();
    const file = join(root, "out", "timing.jsonl");
    let clock = 5_000;
    const slow: { step: string; elapsedMs: number; test: string }[] = [];
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
        onSlow: (step, elapsedMs, testName) => slow.push({ step, elapsedMs, test: testName }),
      },
    );
    assert.deepEqual(slow, [
      { step: "sentence-change", elapsedMs: 12_700, test: "switching from Word to Page" },
    ]);
    const line = JSON.parse(readFileSync(file, "utf8").trim()) as TimingRecord;
    assert.equal(line.elapsedMs, 12_700);

    // Default recorder + flush path (no onSlow): one warning line, then empty.
    resetSlowStepsForTests();
    recordSlowStep("checkpoint-restore", 11_000, "reload");
    recordSlowStep("follow-highlight", 9_999, "lyrics"); // at/under threshold: ignored
    const printed: string[] = [];
    assert.equal(flushSlowStepWarnings((line) => printed.push(line)), 1);
    assert.deepEqual(printed, [formatSlowStepWarning("checkpoint-restore", 11_000)]);
    assert.match(printed[0]!, /^slow step checkpoint-restore 11000$/);
    assert.equal(flushSlowStepWarnings((line) => printed.push(line)), 0);
  } finally {
    resetSlowStepsForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarize-e2e-timing prints count median p90 max and flags steps over 5s", () => {
  const root = mkdtempSync(join(tmpdir(), "sonder-e2e-timing-sum-"));
  try {
    mkdirSync(root, { recursive: true });
    const file = join(root, "run.jsonl");
    const rows = [
      { step: "sentence-change", test: "a", elapsedMs: 100, at: "t" },
      { step: "sentence-change", test: "a", elapsedMs: 200, at: "t" },
      { step: "sentence-change", test: "a", elapsedMs: 300, at: "t" },
      { step: "sentence-change", test: "a", elapsedMs: 400, at: "t" },
      { step: "sentence-change", test: "a", elapsedMs: 6000, at: "t" },
      { step: "checkpoint-restore", test: "b", elapsedMs: 50, at: "t" },
    ];
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const help = spawnSync(process.execPath, [summarize, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage:/);

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
    assert.match(run.stdout, /p90=6000/);
    assert.match(run.stdout, /max=6000/);
    assert.match(run.stdout, /SLOW/);
    assert.match(run.stdout, /checkpoint-restore/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
