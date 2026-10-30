#!/usr/bin/env node
/**
 * Summarise SONDER_E2E_TIMING JSONL files: per step count, median, p90 and max.
 *
 * Usage: node scripts/summarize-e2e-timing.mjs [--label <host>] <file...>
 *
 * Each file is tagged with the current --label (default "default"). Pass
 * --label again before the next file to group runs by host. Steps whose max
 * is above 5000 ms are flagged SLOW.
 *
 * Exit: 0 ok, 2 bad usage / missing file.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SLOW_MS = 5000;

function usage(stream = process.stderr) {
  stream.write(
    "usage: node scripts/summarize-e2e-timing.mjs [--label <host>] <file...>\n",
  );
}

/**
 * @param {string[]} argv
 * @returns {{ ok: true, groups: { label: string, files: string[] }[] } | { ok: false, error: string, help?: boolean }}
 */
export function parseArgs(argv) {
  if (argv.some((a) => a === "--help" || a === "-h")) {
    return { ok: false, error: "", help: true };
  }
  /** @type {{ label: string, files: string[] }[]} */
  const groups = [];
  let label = "default";
  /** @type {string[]} */
  let current = [];
  const flush = () => {
    if (current.length) groups.push({ label, files: current });
    current = [];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--label") {
      flush();
      if (i + 1 >= argv.length) return { ok: false, error: "missing value for --label" };
      label = argv[++i];
      continue;
    }
    if (a.startsWith("-")) return { ok: false, error: `unknown option ${a}` };
    current.push(a);
  }
  flush();
  if (!groups.length) return { ok: false, error: "need at least one timing file" };
  return { ok: true, groups };
}

/**
 * @param {number[]} values
 * @param {number} p 0..1
 */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  // Median: average the two middle values when the count is even.
  if (p === 0.5) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  // Nearest-rank for other percentiles (p90, …).
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/**
 * @param {string} text
 * @returns {{ step: string, elapsedMs: number }[]}
 */
export function parseTimingLines(text) {
  /** @type {{ step: string, elapsedMs: number }[]} */
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (typeof row.step !== "string" || typeof row.elapsedMs !== "number") {
      throw new Error(`bad timing line: ${line}`);
    }
    rows.push({ step: row.step, elapsedMs: row.elapsedMs });
  }
  return rows;
}

/**
 * @param {{ step: string, elapsedMs: number }[]} rows
 */
export function summariseSteps(rows) {
  /** @type {Map<string, number[]>} */
  const byStep = new Map();
  for (const row of rows) {
    const list = byStep.get(row.step) || [];
    list.push(row.elapsedMs);
    byStep.set(row.step, list);
  }
  return [...byStep.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([step, values]) => {
      const count = values.length;
      const median = Math.round(percentile(values, 0.5));
      const p90 = Math.round(percentile(values, 0.9));
      const max = Math.max(...values);
      return { step, count, median, p90, max, slow: max > SLOW_MS };
    });
}

/**
 * @param {string[]} argv
 */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      usage(process.stdout);
      return 0;
    }
    usage();
    if (parsed.error) process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  for (const group of parsed.groups) {
    /** @type {{ step: string, elapsedMs: number }[]} */
    const rows = [];
    for (const file of group.files) {
      const path = resolve(file);
      if (!existsSync(path)) {
        process.stderr.write(`not found: ${path}\n`);
        return 2;
      }
      rows.push(...parseTimingLines(readFileSync(path, "utf8")));
    }
    process.stdout.write(`host: ${group.label}\n`);
    if (!rows.length) {
      process.stdout.write("  (no timing rows)\n");
      continue;
    }
    for (const s of summariseSteps(rows)) {
      const flag = s.slow ? " SLOW" : "";
      process.stdout.write(
        `  ${s.step}: count=${s.count} median=${s.median} p90=${s.p90} max=${s.max}${flag}\n`,
      );
    }
  }
  return 0;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exit(main());
}
