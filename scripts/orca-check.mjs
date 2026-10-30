#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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
with heartbeats=<n>. --heartbeats prints every delivery as Orca returns it and acks nothing.`);
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
 * @param {{ runOrca?: (args: string[]) => { status: number | null, stdout: string, stderr: string }, now?: () => number }} [hooks]
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
