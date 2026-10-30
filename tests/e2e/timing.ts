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
 * A step slower than this still passes (the ceiling is higher) but is recorded
 * and printed as a "slow step" warning at process exit so a real slowdown is
 * visible and not hidden by the larger wait.
 */
export const SLOW_STEP_MS = 10_000;

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

let slowSteps: SlowStep[] = [];
let flushRegistered = false;

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
export function formatSlowStepWarning(step: string, elapsedMs: number): string {
  return `slow step ${step} ${elapsedMs}`;
}

export function recordSlowStep(step: string, elapsedMs: number, test: string): void {
  if (elapsedMs <= SLOW_STEP_MS) return;
  slowSteps.push({ step, elapsedMs, test });
  ensureSlowStepFlush();
}

/** Print and clear recorded slow steps. Returns how many were printed. */
export function flushSlowStepWarnings(
  write: (line: string) => void = (line) => console.warn(line),
): number {
  const pending = slowSteps.splice(0);
  for (const item of pending) {
    write(formatSlowStepWarning(item.step, item.elapsedMs));
  }
  return pending.length;
}

/** Test hook: drop recorded slow steps without printing. */
export function resetSlowStepsForTests(): void {
  slowSteps = [];
}

function ensureSlowStepFlush(): void {
  if (flushRegistered) return;
  flushRegistered = true;
  process.on("beforeExit", () => {
    flushSlowStepWarnings();
  });
}

export type TimedWaitOptions = {
  /** Playwright test title; required for a useful record when timing is on. */
  testName?: string;
  env?: TimingEnv;
  now?: () => number;
  write?: (filePath: string, record: TimingRecord) => void;
  onSlow?: (step: string, elapsedMs: number, test: string) => void;
};

/**
 * Run `work` and always measure elapsed ms. When SONDER_E2E_TIMING=1, also
 * append a JSONL timing record. Steps slower than SLOW_STEP_MS are recorded
 * and printed once at process exit (`slow step <name> <ms>`).
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
      (options.onSlow ?? recordSlowStep)(step, elapsedMs, testName);
    }
  }
}
