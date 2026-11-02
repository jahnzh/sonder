#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WAIT_SECONDS = 90;
const MAX_WAIT_SECONDS = 100;

function printUsage() {
  console.error(`Usage: node scripts/orca-check.mjs [--terminal <handle>] [--run <run_id>] [--types <type,...>] [--wait [<seconds>]] [--ack <delivery_id>] [--heartbeats]

Runs $ORCA_CLI_COMMAND orchestration check --json (default command: orca), strips keepalive lines, and prints messages.
--wait defaults to ${DEFAULT_WAIT_SECONDS}s and cannot exceed ${MAX_WAIT_SECONDS}s.
A delivery that holds only heartbeats is acknowledged and the wait continues; a delivery with any other message is
printed without its heartbeats and left for the caller to ack. When only heartbeats arrived, the count line ends
with heartbeats=<n>. --heartbeats prints every delivery as Orca returns it and acks nothing.
Each worker_done whose payload names a dispatchId also runs orca-history capture for that dispatch; the payload may
be a JSON string, as the orca CLI sends structured payloads, or an object. A successful automatic capture prints a
\`history: captured <id> (automatic)\` line on stderr; a capture failure is printed to stderr and does not change the
check exit code.
A worker_done body that includes a line \`Findings: blocking=N high=N medium=N low=N\` also records
record-review on the dispatch named by that reviewer's review_of link (with --reviewer-dispatch) and prints a
\`history: recorded review on <id> (automatic)\` line on stderr; a reviewer's worker_done without the line or without
a review_of link records nothing and prints one reminder (implementer worker_dones never remind).`);
}

/** Exact line reviewers emit in the worker_done body so orca-check can record-review automatically. */
export const FINDINGS_LINE_RE =
  /^Findings:\s*blocking=(\d+)\s+high=(\d+)\s+medium=(\d+)\s+low=(\d+)\s*$/m;

/**
 * @param {unknown} text
 * @returns {{ blocking: number, high: number, medium: number, low: number } | null}
 */
export function parseFindingsLine(text) {
  if (typeof text !== "string") return null;
  const match = text.match(FINDINGS_LINE_RE);
  if (!match) return null;
  return {
    blocking: Number(match[1]),
    high: Number(match[2]),
    medium: Number(match[3]),
    low: Number(match[4]),
  };
}

/**
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseAllJsonValues(text) {
  const values = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    if (text[i] !== "{") {
      const next = text.indexOf("{", i);
      if (next === -1) break;
      i = next;
    }
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
          const slice = text.slice(start, i + 1);
          try {
            values.push(JSON.parse(slice));
          } catch {
            // skip malformed object
          }
          i += 1;
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return values;
}

/**
 * @param {string} text
 * @returns {{ ok: true, envelope: Record<string, unknown>, result: Record<string, unknown> } | { ok: false, error: { code?: string, message?: string } }}
 */
export function parseOrcaCheckOutput(text) {
  const values = parseAllJsonValues(text);
  let lastError = null;
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const obj = /** @type {Record<string, unknown>} */ (value);
    if (obj._keepalive === true || obj._heartbeat === true) continue;
    if (obj.ok === false && obj.error) {
      lastError = obj;
      continue;
    }
    if (obj.result && typeof obj.result === "object") {
      return {
        ok: true,
        envelope: obj,
        result: /** @type {Record<string, unknown>} */ (obj.result),
      };
    }
  }
  if (lastError) {
    const err = /** @type {Record<string, unknown>} */ (lastError.error);
    return {
      ok: false,
      error: {
        code: typeof err.code === "string" ? err.code : undefined,
        message: typeof err.message === "string" ? err.message : undefined,
      },
    };
  }
  return { ok: false, error: { message: "No orchestration check result in output" } };
}

function truncate(value, maxLen) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= maxLen ? text : text.slice(0, maxLen);
}

/**
 * @param {Record<string, unknown>} message
 * @returns {string}
 */
export function formatMessageLine(message) {
  const id = typeof message.id === "string" ? message.id : "";
  const type = typeof message.type === "string" ? message.type : "";
  const subject = typeof message.subject === "string" ? message.subject : "";
  const sender = truncate(message.sender, 24);
  const body = truncate(message.body, 300);
  const payload = truncate(message.payload, 200);
  return `${id} ${type} | ${subject} | ${sender} | ${body} | ${payload}`;
}

/**
 * @param {Record<string, unknown>} result
 * @param {{ hidden?: number }} [opts] hidden: heartbeats left out of the lines below the count line
 * @returns {string[]}
 */
export function formatCheckLines(result, opts = {}) {
  const count = typeof result.count === "number" ? result.count : 0;
  const delivery =
    result.deliveryId == null ? "null" : String(result.deliveryId);
  const timedOut = result.timedOut === true ? "true" : "false";
  const hidden = opts.hidden ? ` heartbeats=${opts.hidden}` : "";
  const lines = [`count=${count} delivery=${delivery} timedOut=${timedOut}${hidden}`];
  const messages = Array.isArray(result.messages) ? result.messages : [];
  for (const message of messages) {
    if (message && typeof message === "object") {
      lines.push(formatMessageLine(/** @type {Record<string, unknown>} */ (message)));
    }
  }
  return lines;
}

/** @param {unknown} message */
function isHeartbeat(message) {
  return !!message && typeof message === "object" && /** @type {Record<string, unknown>} */ (message).type === "heartbeat";
}

/**
 * The orca CLI stringifies structured payloads when sending them, so a message payload may arrive as a JSON string
 * or as an object. Returns the object form, or null when the payload is not (or does not parse into) an object.
 * @param {unknown} payload
 * @returns {Record<string, unknown> | null}
 */
export function payloadObject(payload) {
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload)) return null;
    return /** @type {Record<string, unknown>} */ (payload);
  }
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      // not JSON
    }
  }
  return null;
}

/**
 * @param {unknown} message
 * @returns {string | null}
 */
export function dispatchIdOfWorkerDone(message) {
  if (!message || typeof message !== "object") return null;
  const msg = /** @type {Record<string, unknown>} */ (message);
  if (msg.type !== "worker_done") return null;
  const payload = payloadObject(msg.payload);
  if (!payload) return null;
  const id = payload.dispatchId;
  return typeof id === "string" && id ? id : null;
}

/**
 * Runs `orca-history capture` for one dispatch. Failures are the caller's to swallow.
 * @param {string} dispatchId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function defaultCaptureHistory(dispatchId, env = process.env) {
  const script = fileURLToPath(new URL("./orca-history.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "capture", "--dispatch", dispatchId], {
    encoding: "utf8",
    env,
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (run.error) throw new Error(run.error.message);
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || `capture exited ${run.status}`).trim().slice(0, 300));
  }
}

/**
 * After a worker_done message, capture that dispatch. Never throws; never changes the check exit code.
 * @param {unknown[]} messages
 * @param {{ captureHistory?: (dispatchId: string) => void }} [hooks]
 */
export function autoCaptureWorkerDone(messages, hooks = {}) {
  const capture = hooks.captureHistory || defaultCaptureHistory;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (/** @type {Record<string, unknown>} */ (message).type !== "worker_done") continue;
    const id = dispatchIdOfWorkerDone(message);
    if (!id) {
      console.error("history: worker_done has no dispatchId; skipping automatic capture");
      continue;
    }
    try {
      capture(id);
      console.error(`history: captured ${id} (automatic)`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`history: automatic capture failed for ${id}: ${detail}`);
    }
  }
}

/** Same allowlist as scripts/orca-history.mjs requireId / safeId. */
const SAFE_HISTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function historyDir(env = process.env) {
  if (env.ORCA_HISTORY_DIR?.trim()) return env.ORCA_HISTORY_DIR;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "artifacts", "orca", "history");
}

/**
 * The dispatch a reviewer was linked to via `orca-spawn --review-of` (kind review_of).
 * @param {string} reviewerDispatchId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveReviewedDispatch(reviewerDispatchId, env = process.env) {
  if (!SAFE_HISTORY_ID.test(reviewerDispatchId)) return null;
  const file = path.join(historyDir(env), "records", `${reviewerDispatchId}.json`);
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    const links = Array.isArray(record?.links) ? record.links : [];
    const link = links.find(
      (entry) =>
        entry &&
        entry.kind === "review_of" &&
        typeof entry.target === "string" &&
        SAFE_HISTORY_ID.test(entry.target),
    );
    return link ? link.target : null;
  } catch {
    return null;
  }
}

/**
 * Runs `orca-history record-review` on the reviewed dispatch. Failures are the caller's to swallow.
 * When the reviewing dispatch has no review_of link, records nothing and prints one reminder.
 * @param {string} reviewerDispatchId
 * @param {{ blocking: number, high: number, medium: number, low: number }} findings
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null} the reviewed dispatch id when a review was recorded, else null
 */
export function defaultRecordReview(reviewerDispatchId, findings, env = process.env) {
  const reviewedId = resolveReviewedDispatch(reviewerDispatchId, env);
  if (!reviewedId) {
    console.error(
      `history: worker_done for ${reviewerDispatchId} has Findings but no review_of link; skipping automatic record-review`,
    );
    return null;
  }
  const script = fileURLToPath(new URL("./orca-history.mjs", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [
      script,
      "record-review",
      "--dispatch",
      reviewedId,
      "--reviewer-dispatch",
      reviewerDispatchId,
      "--blocking",
      String(findings.blocking),
      "--high",
      String(findings.high),
      "--medium",
      String(findings.medium),
      "--low",
      String(findings.low),
      "--evidence",
      "worker_done Findings line",
    ],
    {
      encoding: "utf8",
      env,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (run.error) throw new Error(run.error.message);
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || `record-review exited ${run.status}`).trim().slice(0, 300));
  }
  return reviewedId;
}

/**
 * After a worker_done message, record-review when the body has a Findings line and the
 * reviewing dispatch has a review_of link. Never throws; never changes the exit code.
 * An implementer worker_done (no review_of link) never reminds about the missing Findings line.
 * @param {unknown[]} messages
 * @param {{
 *   recordReview?: (reviewedId: string, findings: { blocking: number, high: number, medium: number, low: number }, reviewerId: string) => void,
 *   resolveReviewedDispatch?: (reviewerId: string) => string | null,
 * }} [hooks]
 */
export function autoRecordReviewWorkerDone(messages, hooks = {}) {
  const resolve = hooks.resolveReviewedDispatch || ((id) => resolveReviewedDispatch(id));
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (/** @type {Record<string, unknown>} */ (message).type !== "worker_done") continue;
    const msg = /** @type {Record<string, unknown>} */ (message);
    const body = typeof msg.body === "string" ? msg.body : "";
    const findings = parseFindingsLine(body);
    const reviewerId = dispatchIdOfWorkerDone(message);
    if (!findings) {
      // Only a reviewer's worker_done (one with a review_of link) is expected to carry the Findings line.
      if (reviewerId && resolve(reviewerId)) {
        console.error(
          `history: worker_done for ${reviewerId} has no Findings line; skipping automatic record-review`,
        );
      }
      continue;
    }
    if (!reviewerId) {
      console.error("history: worker_done has Findings but no dispatchId; skipping automatic record-review");
      continue;
    }
    try {
      let recordedId;
      if (hooks.recordReview) {
        recordedId = resolve(reviewerId);
        if (!recordedId) {
          console.error(
            `history: worker_done for ${reviewerId} has Findings but no review_of link; skipping automatic record-review`,
          );
          continue;
        }
        hooks.recordReview(recordedId, findings, reviewerId);
      } else {
        recordedId = defaultRecordReview(reviewerId, findings);
      }
      if (recordedId) console.error(`history: recorded review on ${recordedId} (automatic)`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reviewedId = resolve(reviewerId);
      console.error(
        `history: automatic record-review failed for ${reviewedId || reviewerId}: ${detail}`,
      );
    }
  }
}/**
 * @param {string[]} argv
 * @returns {{ ok: true, options: Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  /** @type {Record<string, unknown>} */
  const options = {
    terminal: null,
    run: null,
    types: null,
    waitSeconds: null,
    ack: null,
    heartbeats: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--heartbeats") {
      options.heartbeats = true;
    } else if (arg === "--terminal") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        return { ok: false, error: "Missing value for --terminal" };
      }
      options.terminal = argv[++i];
    } else if (arg.startsWith("--terminal=")) {
      const val = arg.slice("--terminal=".length);
      if (!val) return { ok: false, error: "Missing value for --terminal" };
      options.terminal = val;
    } else if (arg === "--run") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        return { ok: false, error: "Missing value for --run" };
      }
      options.run = argv[++i];
    } else if (arg.startsWith("--run=")) {
      const val = arg.slice("--run=".length);
      if (!val) return { ok: false, error: "Missing value for --run" };
      options.run = val;
    } else if (arg === "--types") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        return { ok: false, error: "Missing value for --types" };
      }
      options.types = argv[++i];
    } else if (arg.startsWith("--types=")) {
      const val = arg.slice("--types=".length);
      if (!val) return { ok: false, error: "Missing value for --types" };
      options.types = val;
    } else if (arg === "--wait") {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        const raw = argv[i + 1];
        if (!/^\d+$/.test(raw)) {
          return { ok: false, error: "--wait seconds must be a positive integer" };
        }
        options.waitSeconds = Number.parseInt(raw, 10);
        i += 1;
      } else {
        options.waitSeconds = DEFAULT_WAIT_SECONDS;
      }
    } else if (arg.startsWith("--wait=")) {
      const raw = arg.slice("--wait=".length);
      if (!/^\d+$/.test(raw)) {
        return { ok: false, error: "--wait seconds must be a positive integer" };
      }
      options.waitSeconds = Number.parseInt(raw, 10);
    } else if (arg === "--ack") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        return { ok: false, error: "Missing value for --ack" };
      }
      options.ack = argv[++i];
    } else if (arg.startsWith("--ack=")) {
      const val = arg.slice("--ack=".length);
      if (!val) return { ok: false, error: "Missing value for --ack" };
      options.ack = val;
    } else {
      return { ok: false, error: `Unknown argument "${arg}"` };
    }
  }

  if (options.help) {
    return { ok: true, options };
  }


  if (options.waitSeconds != null) {
    if (options.waitSeconds < 1 || options.waitSeconds > MAX_WAIT_SECONDS) {
      return {
        ok: false,
        error: `--wait must be between 1 and ${MAX_WAIT_SECONDS} seconds`,
      };
    }
  }

  return { ok: true, options };
}

/**
 * @param {Record<string, unknown>} options
 * @param {{ runOrca?: (args: string[]) => { status: number | null, stdout: string, stderr: string }, now?: () => number, captureHistory?: (dispatchId: string) => void, recordReview?: (dispatchId: string, findings: { blocking: number, high: number, medium: number, low: number }) => void }} [hooks]
 */
export function runOrcaCheck(options, hooks = {}) {
  const orca = process.env.ORCA_CLI_COMMAND || "orca";
  const runOrca =
    hooks.runOrca ||
    ((orcaArgs) =>
      spawnSync(orca, orcaArgs, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }));
  const now = hooks.now || Date.now;

  /**
   * @param {string | null} ack
   * @param {number | null} waitMs null: do not block
   */
  const buildArgs = (ack, waitMs) => {
    /** @type {string[]} */
    const args = ["orchestration", "check", "--json"];
    // A worker passes its own handle; the coordinator omits it inside its own Orca terminal.
    if (options.terminal) args.push("--terminal", String(options.terminal));
    if (options.run) args.push("--run", String(options.run));
    if (options.types) args.push("--types", String(options.types));
    if (ack) args.push("--ack", ack);
    if (waitMs != null) args.push("--wait", "--timeout-ms", String(waitMs));
    return args;
  };

  const budgetMs = options.waitSeconds != null ? Number(options.waitSeconds) * 1000 : null;
  const deadline = budgetMs == null ? 0 : now() + budgetMs;
  let ack = options.ack ? String(options.ack) : null;
  let waitMs = budgetMs;
  let hidden = 0;
  let proc;
  let result;

  for (;;) {
    proc = runOrca(buildArgs(ack, waitMs));
    const combined = `${proc.stdout || ""}${proc.stderr || ""}`;
    const parsed = parseOrcaCheckOutput(combined);

    if (!parsed.ok) {
      const code = parsed.error.code || "error";
      const message = parsed.error.message || "Orca orchestration check failed";
      console.error(`${code}: ${message}`);
      return { ok: false, exitCode: 1 };
    }

    result = parsed.result;
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const heartbeatOnly = messages.length > 0 && messages.every(isHeartbeat);
    // Acking a delivery returns the next batch, so one call acknowledges the heartbeats and keeps waiting.
    // The same delivery id back means the ack did not take; stop instead of looping.
    if (options.heartbeats || !heartbeatOnly || result.deliveryId == null || result.deliveryId === ack) break;
    hidden += messages.length;
    ack = String(result.deliveryId);
    if (budgetMs != null) {
      const left = deadline - now();
      // Out of budget: the last call only acks and reads what is queued, without blocking.
      waitMs = left >= 1000 ? left : null;
    }
  }

  // The budget ran out in this script, not in Orca, so the empty last call did not report the timeout.
  if (budgetMs != null && waitMs == null && hidden > 0 && result.count === 0) result = { ...result, timedOut: true };

  if (!options.heartbeats) {
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const shown = messages.filter((m) => !isHeartbeat(m));
    hidden += messages.length - shown.length;
    result = { ...result, messages: shown };
  }

  // Lifecycle capture and optional review findings: every worker_done updates history. Failures are logged only.
  const batch = Array.isArray(result.messages) ? result.messages : [];
  autoCaptureWorkerDone(batch, hooks);
  autoRecordReviewWorkerDone(batch, hooks);

  const lines = [];
  const formatOpts = { hidden };
  if (options.ack) {
    const remaining = typeof result.count === "number" ? result.count : 0;
    lines.push(`acked=${options.ack} remaining=${remaining}`);
    // Orca returns the next batch with the ack; show it so one call acknowledges and reads.
    if (remaining > 0 || hidden > 0) lines.push(...formatCheckLines(result, formatOpts));
  } else {
    lines.push(...formatCheckLines(result, formatOpts));
  }

  console.log(lines.join("\n"));
  return { ok: true, exitCode: proc.status === 0 || proc.status == null ? 0 : proc.status };
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    printUsage();
    console.error(parsed.error);
    return 2;
  }
  if (parsed.options.help) {
    printUsage();
    return 0;
  }
  const outcome = runOrcaCheck(parsed.options);
  return outcome.exitCode;
}

const isDirectCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  process.exit(main());
}
