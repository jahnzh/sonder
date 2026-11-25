// The size limits of a browser test (#904), held by the tools rather than by a rule in prose: a test takes at most
// 30 seconds (Playwright's default timeout, playwright.config.ts) and a loop over pages, parts or turns at most 100
// steps. This fails on a spec under tests/e2e that raises a test's time over 30 s (`test.setTimeout`, `test.slow`, a
// `timeout:` option) or loops more than 100 steps, naming the file and line. A line that names LONG_READS is the
// opt-in long read (SONDER_LONG_READS=1), skipped in the check, and is not held to the limits.
//
// The files that still break them are listed in tests/e2e/slow-tests.json, each with its reason; an entry for a file
// that keeps the limits fails too, so the list only shrinks.
//
//   node scripts/check-test-limits.mjs [root]
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MOST_MS = 30_000;
export const MOST_STEPS = 100;
export const ALLOW_LIST = "tests/e2e/slow-tests.json";
/** Loop variables that count pages, parts, turns or steps of a read. */
const COUNTED = /^(step|steps|turn|turns|leg|legs|cycle|cycles|page|pages|part|parts|round|rounds)$/;

const number = (text) => Number(text.replace(/_/g, ""));

/** Numeric constants a spec may name in a timeout: `const NAME = 120_000` in any file under tests/e2e. */
export function numericConstants(sources) {
  const constants = new Map();
  for (const source of sources)
    for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([\d_]+)\s*[;,\n]/g)) constants.set(match[1], number(match[2]));
  return constants;
}

/** The largest number an expression names, its numeric constants resolved. */
function largest(expression, constants) {
  let most = 0;
  for (const match of expression.matchAll(/\b\d[\d_]*\b/g)) most = Math.max(most, number(match[0]));
  for (const match of expression.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) if (constants.has(match[0])) most = Math.max(most, constants.get(match[0]));
  return most;
}

/** Every place in one spec's source that breaks a limit, as `{ line, what }`. */
export function breachesOf(source, constants = new Map()) {
  const found = [];
  source.split("\n").forEach((text, index) => {
    if (/\bLONG_READS\b/.test(text)) return;
    const line = index + 1;
    for (const match of text.matchAll(/\btest\.setTimeout\(([^)]*)\)/g)) {
      const ms = largest(match[1], constants);
      if (ms > MOST_MS) found.push({ line, what: `test.setTimeout of ${ms} ms` });
    }
    if (/\btest(\.describe)?\.slow\(/.test(text)) found.push({ line, what: "test.slow (three times the timeout)" });
    for (const match of text.matchAll(/\btimeout\s*:\s*([\w$]+)/g)) {
      const ms = largest(match[1], constants);
      if (ms > MOST_MS) found.push({ line, what: `a timeout of ${ms} ms` });
    }
    for (const match of text.matchAll(/\bfor\s*\(\s*let\s+([A-Za-z_$][\w$]*)\s*=[^;]*;([^;]*);/g)) {
      if (!COUNTED.test(match[1])) continue;
      const bound = new RegExp(`\\b${match[1]}\\s*<=?\\s*([\\w$]+)`).exec(match[2]);
      const steps = bound ? largest(bound[1], constants) : 0;
      if (steps > MOST_STEPS) found.push({ line, what: `a loop of ${steps} ${match[1].replace(/s$/, "")}s` });
    }
  });
  return found;
}

/** The breaches of every spec under `root`/tests/e2e, the allow-list's files apart, and the allow-list's stale entries. */
export function checkTestLimits(root) {
  const dir = path.join(root, "tests", "e2e");
  const names = readdirSync(dir).sort();
  const constants = numericConstants(names.filter((name) => /\.[cm]?[jt]s$/.test(name)).map((name) => readFileSync(path.join(dir, name), "utf8")));
  const allowed = JSON.parse(readFileSync(path.join(root, ALLOW_LIST), "utf8")).files ?? {};
  const breaches = [];
  const stale = [];
  for (const name of names.filter((entry) => /\.spec\.[cm]?[jt]s$/.test(entry))) {
    const file = `tests/e2e/${name}`;
    const found = breachesOf(readFileSync(path.join(dir, name), "utf8"), constants);
    if (file in allowed) {
      if (!found.length) stale.push(file);
    } else breaches.push(...found.map((entry) => ({ file, ...entry })));
  }
  for (const file of Object.keys(allowed)) if (!names.includes(path.basename(file))) stale.push(file);
  const config = readFileSync(path.join(root, "playwright.config.ts"), "utf8");
  const timeout = /^\s*timeout:\s*([\d_]+)/m.exec(config);
  const configTimeout = timeout ? number(timeout[1]) : null;
  return { breaches, stale, configTimeout };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { breaches, stale, configTimeout } = checkTestLimits(process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  for (const entry of breaches) console.log(`${entry.file}:${entry.line}: ${entry.what}`);
  for (const file of stale) console.log(`${ALLOW_LIST}: ${file} keeps the limits now; take it off the list`);
  if (configTimeout === null || configTimeout > MOST_MS) console.log(`playwright.config.ts: the default timeout is ${configTimeout ?? "not set"}, over ${MOST_MS} ms`);
  process.exit(breaches.length || stale.length || configTimeout === null || configTimeout > MOST_MS ? 1 : 0);
}
