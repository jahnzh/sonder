#!/usr/bin/env node
/**
 * Apply a one-occurrence text mutation, compile-check, run a test, then restore.
 *
 * Usage:
 *   node scripts/mutate.mjs --file <path> --search <text> --replace <text> [--compile "<cmd>"] -- <test command...>
 *
 * --compile defaults to `npx tsc --noEmit`. Pass `--compile none` to skip.
 * --search / --replace are taken from argv (no shell interpolation).
 *
 * Exit codes:
 *   0  CAUGHT — the test command failed (mutation detected)
 *   1  SURVIVED — the test command passed (mutation not detected)
 *   2  bad usage, --search not exactly once, or compile failed
 *
 * The file is always restored byte-for-byte (finally + SIGINT/SIGTERM handlers).
 * The test command is run with async spawn so those handlers can fire mid-run
 * (spawnSync defers signals until the child exits).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_COMPILE = "npx tsc --noEmit";

function usage(msg) {
  if (msg) console.error(msg);
  console.error(
    "usage: node scripts/mutate.mjs --file <path> --search <text> --replace <text> [--compile \"<cmd>\"] -- <test command...>",
  );
  process.exit(2);
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ file?: string, search?: string, replace?: string, compile: string, testCmd: string[] }} */
  const opts = { compile: DEFAULT_COMPILE, testCmd: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      opts.testCmd = argv.slice(i + 1);
      break;
    }
    if (a === "--file" || a === "--search" || a === "--replace" || a === "--compile") {
      if (i + 1 >= argv.length) return { ok: false, error: `missing value for ${a}` };
      const key = a.slice(2);
      opts[key] = argv[i + 1];
      i += 2;
      continue;
    }
    return { ok: false, error: `unknown argument: ${a}` };
  }
  if (!opts.file || opts.search === undefined || opts.replace === undefined) {
    return { ok: false, error: "required: --file, --search, --replace, and -- <test command...>" };
  }
  if (opts.testCmd.length === 0) {
    return { ok: false, error: "required: -- <test command...>" };
  }
  return { ok: true, options: opts };
}

/**
 * @param {string} text
 * @param {string} search
 */
export function countOccurrences(text, search) {
  if (search.length === 0) return text.length + 1; // empty search is never "exactly once"
  let count = 0;
  let from = 0;
  while (true) {
    const at = text.indexOf(search, from);
    if (at === -1) break;
    count += 1;
    from = at + search.length;
  }
  return count;
}

/**
 * @param {string} output
 * @param {number} n
 */
export function lastLines(output, n = 15) {
  const lines = String(output ?? "").replace(/\s+$/, "").split("\n");
  if (lines.length <= n) return lines.join("\n");
  return lines.slice(-n).join("\n");
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ spawnAsync?: typeof spawn }} hooks
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string, signal: NodeJS.Signals | null }>}
 */
function runTestCommand(cmd, args, hooks) {
  const spawnAsync = hooks.spawnAsync || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnAsync(cmd, args, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, stdout, stderr, signal });
    });
    // Expose the child so signal handlers can kill it before restoring.
    hooks._child = child;
  });
}

/**
 * @param {{ file: string, search: string, replace: string, compile: string, testCmd: string[] }} options
 * @param {{
 *   spawnSyncFn?: typeof spawnSync,
 *   spawnAsync?: typeof spawn,
 *   write?: typeof fs.writeFileSync,
 *   read?: typeof fs.readFileSync,
 * }} [hooks]
 */
export async function runMutate(options, hooks = {}) {
  const read = hooks.read || ((p) => fs.readFileSync(p));
  const write = hooks.write || ((p, data) => fs.writeFileSync(p, data));
  const spawnSyncFn = hooks.spawnSyncFn || spawnSync;

  const original = read(options.file);
  const text = Buffer.isBuffer(original) ? original.toString("utf8") : String(original);
  const originalBytes = Buffer.isBuffer(original) ? Buffer.from(original) : Buffer.from(text, "utf8");

  const occurrences = countOccurrences(text, options.search);
  if (occurrences !== 1) {
    console.error(
      `--search occurs ${occurrences} time(s) in ${options.file}; need exactly once`,
    );
    return 2;
  }

  /** @type {{ _child?: import('node:child_process').ChildProcess }} */
  const live = hooks;

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      live._child?.kill("SIGTERM");
    } catch {
      // ignore
    }
    write(options.file, originalBytes);
  };

  const onSignal = (sig) => {
    restore();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    const mutated = text.replace(options.search, options.replace);
    write(options.file, mutated);

    if (options.compile !== "none") {
      const compile = spawnSyncFn(options.compile, {
        shell: true,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const compileOut = `${compile.stdout || ""}${compile.stderr || ""}`;
      if (compile.status !== 0) {
        console.error("compile failed:");
        console.error(compileOut);
        return 2;
      }
    }

    const [cmd, ...args] = options.testCmd;
    const test = await runTestCommand(cmd, args, live);
    const testOut = `${test.stdout || ""}${test.stderr || ""}`;
    const tail = lastLines(testOut, 15);
    if (tail) console.log(tail);

    if (test.status === 0) {
      console.log("SURVIVED");
      return 1;
    }
    console.log("CAUGHT");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    restore();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}

export async function main(argv = process.argv.slice(2)) {
  // --help before the `--` that starts the test command prints the usage and succeeds.
  const dashes = argv.indexOf("--");
  if ((dashes < 0 ? argv : argv.slice(0, dashes)).some((a) => a === "--help" || a === "-h")) {
    console.log(
      "usage: node scripts/mutate.mjs --file <path> --search <text> --replace <text> [--compile \"<cmd>\"] -- <test command...>",
    );
    return 0;
  }
  const parsed = parseArgs(argv);
  if (!parsed.ok) usage(parsed.error);
  return runMutate(parsed.options);
}

const isDirectCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  const code = await main();
  process.exit(code);
}
