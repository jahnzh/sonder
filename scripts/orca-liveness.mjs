#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  detectUsageLimitInText,
  parseTerminalReadResult,
  terminalTextFromReadResult,
  workerAgentId,
  workerDispatchId,
  workerTerminalHandle,
  workerWorktreePath,
  usageLimitFlagLine,
} from "./orca-usage-limit-detect.mjs";

/**
 * @param {unknown} workersJson
 * @returns {unknown[]}
 */
export function loadWorkersFromJson(workersJson) {
  if (Array.isArray(workersJson)) return workersJson;
  if (workersJson && typeof workersJson === "object") {
    const workers = /** @type {Record<string, unknown>} */ (workersJson).workers;
    if (Array.isArray(workers)) return workers;
    const result = /** @type {Record<string, unknown>} */ (workersJson).result;
    if (result && typeof result === "object") {
      const nested = /** @type {Record<string, unknown>} */ (result).workers;
      if (Array.isArray(nested)) return nested;
    }
  }
  return [];
}

/**
 * @param {string} worktreePath
 * @param {{ runGit?: (args: string[], cwd: string) => { status: number | null, stdout: string } }} [hooks]
 * @returns {string | null}
 */
export function worktreeFingerprint(worktreePath, hooks = {}) {
  if (!worktreePath) return null;
  const runGit =
    hooks.runGit ||
    ((args, cwd) =>
      spawnSync("git", args, { encoding: "utf8", cwd, maxBuffer: 1024 * 1024 }));
  const head = runGit(["rev-parse", "HEAD"], worktreePath);
  if (head.status !== 0) return null;
  const status = runGit(["status", "--porcelain"], worktreePath);
  if (status.status !== 0) return null;
  return `${head.stdout.trim()}\n${status.stdout}`;
}

/**
 * @param {unknown[]} workers
 * @param {{ worktreeFingerprint?: (path: string) => string | null }} [hooks]
 * @returns {Record<string, string | null>}
 */
export function snapshotWorkerWorktrees(workers, hooks = {}) {
  const fingerprint = hooks.worktreeFingerprint || ((path) => worktreeFingerprint(path));
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const worker of workers) {
    const dispatchId = workerDispatchId(worker);
    if (!dispatchId) continue;
    const path = workerWorktreePath(worker);
    out[dispatchId] = path ? fingerprint(path) : null;
  }
  return out;
}

/**
 * @param {Record<string, string | null> | null} a
 * @param {Record<string, string | null> | null} b
 */
export function worktreeSnapshotsEqual(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * @param {string} path
 * @returns {{ runId: string | null, emptyWaits: number, snapshots: Record<string, string | null> | null }}
 */
export function readLivenessState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      runId: typeof parsed.runId === "string" ? parsed.runId : null,
      emptyWaits: typeof parsed.emptyWaits === "number" ? parsed.emptyWaits : 0,
      snapshots: parsed.snapshots && typeof parsed.snapshots === "object" ? parsed.snapshots : null,
    };
  } catch {
    return { runId: null, emptyWaits: 0, snapshots: null };
  }
}

/**
 * @param {string} path
 * @param {{ runId: string, emptyWaits: number, snapshots: Record<string, string | null> | null }} state
 */
export function writeLivenessState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * @param {Record<string, unknown>} result orchestration check result
 */
export function isEmptyInboxResult(result) {
  const count = typeof result.count === "number" ? result.count : 0;
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return count === 0 && messages.length === 0;
}

/**
 * After consecutive empty inbox waits with stable worktrees, read worker terminals and flag usage limits.
 * @param {{
 *   runId: string,
 *   workers: unknown[],
 *   statePath: string,
 *   readTerminal?: (handle: string) => { ok: boolean, text?: string, error?: string },
 *   worktreeFingerprint?: (path: string) => string | null,
 * }} opts
 * @returns {string[]} stderr lines (liveness: ...)
 */
export function probeWorkersAfterEmptyWaits(opts) {
  const readTerminal =
    opts.readTerminal ||
    ((handle) => {
      const orca = process.env.ORCA_CLI_COMMAND || "orca";
      const run = spawnSync(orca, ["terminal", "read", "--terminal", handle, "--limit", "200", "--json"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const combined = `${run.stdout || ""}${run.stderr || ""}`;
      const parsed = parseTerminalReadResult(combined);
      if (!parsed) return { ok: false, error: "no terminal read result" };
      return { ok: true, text: terminalTextFromReadResult(parsed) };
    });

  let state = readLivenessState(opts.statePath);
  if (state.runId !== opts.runId) {
    state = { runId: opts.runId, emptyWaits: 0, snapshots: null };
  }

  const snapshots = snapshotWorkerWorktrees(opts.workers, {
    worktreeFingerprint: opts.worktreeFingerprint,
  });
  state.emptyWaits += 1;
  if (state.emptyWaits === 1) state.snapshots = snapshots;

  const flags = [];
  const stable = state.emptyWaits >= 2 && worktreeSnapshotsEqual(state.snapshots, snapshots);

  writeLivenessState(opts.statePath, {
    runId: opts.runId,
    emptyWaits: state.emptyWaits,
    snapshots: state.snapshots,
  });

  if (!stable) return flags;

  for (const worker of opts.workers) {
    const dispatchId = workerDispatchId(worker);
    const terminal = workerTerminalHandle(worker);
    if (!dispatchId || !terminal) continue;
    const read = readTerminal(terminal);
    if (!read.ok || !read.text) {
      console.error(
        `liveness: terminal read failed dispatch=${dispatchId} terminal=${terminal}: ${read.error || "empty tail"}`,
      );
      continue;
    }
    const detection = detectUsageLimitInText(read.text);
    if (!detection) continue;
    const agent = workerAgentId(worker) || detection.agent;
    flags.push(
      usageLimitFlagLine({
        dispatchId,
        terminal,
        agent,
        detection,
      }),
    );
  }
  return flags;
}

/**
 * Reset liveness counters when the inbox delivers a message.
 * @param {string} statePath
 * @param {string} runId
 */
export function resetLivenessState(statePath, runId) {
  writeLivenessState(statePath, { runId, emptyWaits: 0, snapshots: null });
}
