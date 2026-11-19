// What the live checks name must exist in the app (#617): a check that clicks a removed screen fails a deploy on a
// missing button. Read by tests/live-check-locators.test.mjs over a fixture tree and once over the real one.
// Keep side-effect free: importing this module must not launch a browser or reach a server.
import fs from "node:fs";
import path from "node:path";

/** Names of screens, classes and texts the redesign removed (spec #608, "The live checks"); the checks name none. */
export const REMOVED_NAMES = Object.freeze(["More sheet", "Playback options", "Versions & sources", "Your home server", "drawer", ".topbar", "hc-"]);

/** The live checks and the helpers whose locators they run. */
export const LIVE_CHECK_FILE = /^(verify-.*|live-reader-controls)\.mjs$/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The CSS classes in the selectors a check passes to `locator(...)` or `querySelector(...)`. */
export function selectorClasses(script) {
  const selectors = [...script.matchAll(/(?:locator|querySelector(?:All)?)\(\s*(["'`])((?:(?!\1).)+)\1/g)].map((m) => m[2]);
  return [...new Set(selectors.flatMap((selector) => [...selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1])))];
}

/** The accessible names a check looks for as plain strings: `getByRole(..., { name: "…" })` and `getByLabel("…")`. */
export function accessibleNames(script) {
  const quoted = `(["'])((?:(?!\\1)[^\\\\$]|\\\\.)+)\\1`;
  const role = [...script.matchAll(new RegExp(`getByRole\\(\\s*["'][a-z]+["']\\s*,\\s*\\{\\s*name\\s*:\\s*${quoted}`, "g"))].map((m) => m[2]);
  const label = [...script.matchAll(new RegExp(`getByLabel\\(\\s*${quoted}`, "g"))].map((m) => m[2]);
  return [...new Set([...role, ...label])];
}

/**
 * What the checks name that the app does not have.
 * @param {{ scripts: Record<string, string>, source: string }} tree the checks by file name, and the app's source
 *   (`src/**` .ts and .tsx, concatenated)
 * @returns {{ file: string, kind: "removed" | "class" | "name", value: string }[]}
 */
export function staleLocators({ scripts, source }) {
  const found = [];
  const hasClass = (name) => new RegExp(`(^|[^\\w-])${escape(name)}($|[^\\w-])`).test(source);
  // A back button is named after where it goes (`Back to ${page}`, src/parts/back-name.ts): the page's name exists.
  // A name is a whole string or a whole JSX text in the source ("Plays from", `>Undo<`), not part of a longer one.
  const whole = (text) => new RegExp(`["'\`>]\\s*${escape(text)}\\s*["'\`<]`).test(source);
  const hasName = (name) => whole(name) || (/^Back to ./.test(name) && whole(name.slice("Back to ".length)));
  for (const [file, script] of Object.entries(scripts)) {
    for (const name of REMOVED_NAMES) if (script.includes(name)) found.push({ file, kind: "removed", value: name });
    for (const name of selectorClasses(script)) if (!hasClass(name)) found.push({ file, kind: "class", value: name });
    for (const name of accessibleNames(script)) if (!hasName(name)) found.push({ file, kind: "name", value: name });
  }
  return found;
}

/** The tree `staleLocators` reads, from a checkout at `root`. */
export function readTree(root) {
  const scriptsDir = path.join(root, "scripts");
  const scripts = Object.fromEntries(
    fs.readdirSync(scriptsDir).filter((name) => LIVE_CHECK_FILE.test(name)).map((name) => [name, fs.readFileSync(path.join(scriptsDir, name), "utf8")]),
  );
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const source = walk(path.join(root, "src"))
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  return { scripts, source };
}
