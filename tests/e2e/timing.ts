import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

export type TimedWaitOptions = {
  /** Playwright test title; required for a useful record when timing is on. */
  testName?: string;
  env?: TimingEnv;
  now?: () => number;
  write?: (filePath: string, record: TimingRecord) => void;
};

/**
 * Run `work` unchanged when timing is off. When SONDER_E2E_TIMING=1, record how
 * long it took (ms) with the test title into SONDER_E2E_TIMING_FILE
 * (default test-results/e2e-timing.jsonl).
 */
export async function timedWait<T>(
  step: string,
  work: () => Promise<T>,
  options: TimedWaitOptions = {},
): Promise<T> {
  const env = options.env ?? process.env;
  if (!timingEnabled(env)) return work();

  const now = options.now ?? Date.now;
  const started = now();
  try {
    return await work();
  } finally {
    const elapsedMs = now() - started;
    (options.write ?? appendTimingRecord)(timingFilePath(env), {
      step,
      test: options.testName || "unknown",
      elapsedMs,
      at: new Date(started).toISOString(),
    });
  }
}
