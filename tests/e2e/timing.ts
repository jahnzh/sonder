import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Ceilings for the instrumented reader waits. Measured on an idle machine
 * (issue #115, commit d47d13c): sentence-change max 103 ms (788 steps),
 * follow-highlight max 1.2 s, history-restore max 116 ms, checkpoint-restore
 * max 2.6 s. Deck/WSL failures were fixed 10 s expect timeouts under CPU
 * contention, so each ceiling is 45 s — enough for a contended host, still
 * bounded. Assertions stay on the real condition; only the clock limit grows.
 */
export const READER_WAIT_MS = {
  sentenceChange: 45_000,
  followHighlight: 45_000,
  historyRestore: 45_000,
  checkpointRestore: 45_000,
} as const;

/**
 * A step slower than this still passes (the ceiling is higher) but is printed
 * immediately as a "slow step" warning on stderr so a real slowdown is visible
 * and not hidden by the larger wait. Must stay in sync with SLOW_MS in
 * scripts/summarize-e2e-timing.mjs.
 */
export const SLOW_STEP_MS = 10_000;

/** Per-spec Playwright timeout: room for many 45 s expect ceilings. */
export const READER_SPEC_TIMEOUT_MS = 180_000;

/** One measured wait when SONDER_E2E_TIMING=1. */
export type TimingRecord = {
  step: string;
  test: string;
  elapsedMs: number;
  at: string;
};

export type TimingEnv = {
  SONDER_E2E_TIMING?: string;
  SONDER_E2E_TIMING_FILE?: string;
};

export type SlowStep = {
  step: string;
  elapsedMs: number;
  test: string;
};

/** Minimal Playwright `test` surface used by installReaderWaitBudget. */
export type ReaderSpecTest = {
  beforeEach: (fn: () => void) => void;
  setTimeout: (ms: number) => void;
};

/**
 * Shared beforeEach that raises the Playwright test timeout for the three
 * instrumented reader specs (word-reader, follow-highlight, position-history).
 */
export function installReaderWaitBudget(testApi: ReaderSpecTest): void {
  testApi.beforeEach(() => {
    testApi.setTimeout(READER_SPEC_TIMEOUT_MS);
  });
}

export function timingEnabled(env: TimingEnv = process.env): boolean {
  return env.SONDER_E2E_TIMING === "1";
}

export function timingFilePath(env: TimingEnv = process.env): string {
  return env.SONDER_E2E_TIMING_FILE || "test-results/e2e-timing.jsonl";
}

/** Append one JSON line; creates the parent directory when missing. */
export function appendTimingRecord(filePath: string, record: TimingRecord): void {
  const absolute = resolve(filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  appendFileSync(absolute, `${JSON.stringify(record)}\n`, "utf8");
}

/** Format one slow-step warning line (stable for unit tests and CI logs). */
export function formatSlowStepWarning(
  test: string,
  step: string,
  elapsedMs: number,
): string {
  return `slow step ${test} ${step} ${elapsedMs}`;
}

/**
 * Print a slow-step warning immediately on stderr (or `write`). Playwright
 * ends workers with process.exit(), which skips beforeExit, so buffering until
 * exit loses the warning.
 */
export function recordSlowStep(
  step: string,
  elapsedMs: number,
  test: string,
  write: (line: string) => void = (line) => console.warn(line),
): void {
  if (elapsedMs <= SLOW_STEP_MS) return;
  write(formatSlowStepWarning(test, step, elapsedMs));
}

export type TimedWaitOptions = {
  /** Playwright test title; required for a useful record when timing is on. */
  testName?: string;
  env?: TimingEnv;
  now?: () => number;
  write?: (filePath: string, record: TimingRecord) => void;
  /** Override stderr for unit tests. */
  warn?: (line: string) => void;
  onSlow?: (step: string, elapsedMs: number, test: string) => void;
};

/**
 * Run `work` and always measure elapsed ms. When SONDER_E2E_TIMING=1, also
 * append a JSONL timing record. Steps slower than SLOW_STEP_MS print
 * immediately (`slow step <test> <name> <ms>` on stderr).
 */
export async function timedWait<T>(
  step: string,
  work: () => Promise<T>,
  options: TimedWaitOptions = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const started = now();
  try {
    return await work();
  } finally {
    const elapsedMs = now() - started;
    const testName = options.testName || "unknown";
    if (timingEnabled(env)) {
      (options.write ?? appendTimingRecord)(timingFilePath(env), {
        step,
        test: testName,
        elapsedMs,
        at: new Date(started).toISOString(),
      });
    }
    if (elapsedMs > SLOW_STEP_MS) {
      if (options.onSlow) {
        options.onSlow(step, elapsedMs, testName);
      } else {
        recordSlowStep(step, elapsedMs, testName, options.warn);
      }
    }
  }
}
