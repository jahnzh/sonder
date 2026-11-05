#!/usr/bin/env node
import { USAGE_LIMIT_TERMINAL_SAMPLES } from "./usage-limit-patterns.mjs";

export { USAGE_LIMIT_TERMINAL_SAMPLES };

function parseOneJsonObject(text, startIndex) {
  let i = startIndex;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (i >= text.length || text[i] !== "{") return null;
  const start = i;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), next: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
export function parseTerminalReadResult(text) {
  let i = 0;
  while (i < text.length) {
    const parsed = parseOneJsonObject(text, i);
    if (!parsed) break;
    i = parsed.next;
    const obj = parsed.value;
    if (!obj || typeof obj !== "object") continue;
    if (obj._keepalive === true || obj._heartbeat === true) continue;
    if (obj.ok === true && obj.result && typeof obj.result === "object") {
      return /** @type {Record<string, unknown>} */ (obj.result);
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{ agent: string, id: string, matched: string, source: string } | null}
 */
export function detectUsageLimitInText(text) {
  if (typeof text !== "string" || !text) return null;
  for (const sample of USAGE_LIMIT_TERMINAL_SAMPLES) {
    if (text.includes(sample.substring)) {
      return {
        agent: sample.agent,
        id: sample.id,
        matched: sample.substring,
        source: sample.source,
      };
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} result
 * @returns {string}
 */
export function terminalTextFromReadResult(result) {
  const tail = result.tail;
  if (Array.isArray(tail)) return tail.filter((line) => typeof line === "string").join("\n");
  const terminal = result.terminal;
  if (terminal && typeof terminal === "object" && !Array.isArray(terminal)) {
    const termTail = /** @type {Record<string, unknown>} */ (terminal).tail;
    if (Array.isArray(termTail)) return termTail.filter((line) => typeof line === "string").join("\n");
  }
  if (typeof result.text === "string") return result.text;
  return "";
}

/**
 * @param {unknown} worker
 * @returns {string | null}
 */
export function workerTerminalHandle(worker) {
  if (!worker || typeof worker !== "object") return null;
  const w = /** @type {Record<string, unknown>} */ (worker);
  if (typeof w.agentTerminalHandle === "string" && w.agentTerminalHandle) return w.agentTerminalHandle;
  const resource = w.resource;
  if (resource && typeof resource === "object") {
    const handle = /** @type {Record<string, unknown>} */ (resource).terminalHandle;
    if (typeof handle === "string" && handle) return handle;
  }
  return null;
}

/**
 * @param {unknown} worker
 * @returns {string | null}
 */
export function workerWorktreePath(worker) {
  if (!worker || typeof worker !== "object") return null;
  const w = /** @type {Record<string, unknown>} */ (worker);
  const projection = w.projection;
  if (projection && typeof projection === "object") {
    const workspace = /** @type {Record<string, unknown>} */ (projection).workspace;
    if (workspace && typeof workspace === "object") {
      const id = /** @type {Record<string, unknown>} */ (workspace).id;
      if (typeof id === "string") {
        const sep = id.indexOf("::");
        if (sep !== -1) return id.slice(sep + 2);
      }
    }
  }
  const resource = w.resource;
  if (resource && typeof resource === "object") {
    const worktreeId = /** @type {Record<string, unknown>} */ (resource).worktreeId;
    if (typeof worktreeId === "string") {
      const sep = worktreeId.indexOf("::");
      if (sep !== -1) return worktreeId.slice(sep + 2);
    }
  }
  return null;
}

/**
 * @param {unknown} worker
 * @returns {string | null}
 */
export function workerDispatchId(worker) {
  if (!worker || typeof worker !== "object") return null;
  const w = /** @type {Record<string, unknown>} */ (worker);
  if (typeof w.dispatchId === "string" && w.dispatchId) return w.dispatchId;
  const projection = w.projection;
  if (projection && typeof projection === "object") {
    const id = /** @type {Record<string, unknown>} */ (projection).dispatchId;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * @param {unknown} worker
 * @returns {string | null}
 */
export function workerAgentId(worker) {
  if (!worker || typeof worker !== "object") return null;
  const projection = /** @type {Record<string, unknown>} */ (worker).projection;
  if (projection && typeof projection === "object") {
    const provider = /** @type {Record<string, unknown>} */ (projection).provider;
    if (provider && typeof provider === "object") {
      const id = /** @type {Record<string, unknown>} */ (provider).id;
      if (typeof id === "string" && id) return id;
    }
  }
  return null;
}

/**
 * Build one stderr line for watch scripts (must not start with msg_ or delivery=).
 * @param {{ dispatchId: string, terminal: string, agent: string, detection: { id: string, matched: string } }} row
 */
export function usageLimitFlagLine({ dispatchId, terminal, agent, detection }) {
  return `liveness: usage-limit dispatch=${dispatchId} terminal=${terminal} agent=${agent} pattern=${detection.id} matched=${JSON.stringify(detection.matched)}`;
}
