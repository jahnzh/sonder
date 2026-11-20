// Fails on a corner or a spacing value in a stylesheet under `src/` that is not built from the tokens
// (#611, spec #608 "The rule that keeps stylesheets inside the tokens", ADR 0023).
//
// Checked: `border-radius`, its longhands and logical forms; `padding`, `margin`, `gap`, `row-gap`,
// `column-gap`, their longhands and logical forms. Allowed: a token variable (the spacing and corner
// names the tokens stylesheet defines, read from it; no value is copied here), `0`, `auto` for a
// margin, `inherit`, `initial`, `unset`, `env(safe-area-inset-*)`, and `calc()`, `min()`, `max()` of
// only tokens, insets, numbers multiplying a token and `0`. A value the boards draw that no token
// gives is marked on its declaration with `/* tokens: <reason> */`; the test pins how many there are.
//
// Files are read with the file system, never through git, so the check runs in `npm run check`'s snapshot.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

/** Where #486 put the tokens' `:root` block. */
export const TOKENS_FILE = "src/parts/tokens.css";

const CSS_WIDE = new Set(["inherit", "initial", "unset"]);
const SIDES = "(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?";
const CORNER = /^border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius$/;
const SPACING = new RegExp(`^(?:(?:padding|margin)${SIDES}|(?:grid-)?(?:row-|column-)?gap)$`);
const INSET = /^safe-area-inset-(top|right|bottom|left)$/;
// The browser tests give Firefox and WebKit insets through these (src/reader.css, tests/e2e/reader-bands.ts):
// `var(--sonder-safe-<side>, env(safe-area-inset-<side>…))` is the safe-area inset.
const INSET_HOOK = /^--sonder-safe-(top|right|bottom|left)$/;
const EXCEPTION = /^\s*tokens:([\s\S]*)$/;

/** The kind of value a property takes, or undefined when the check does not read it. */
export function checkedKind(property) {
  const name = property.toLowerCase().replace(/^-(?:webkit|moz|ms|o)-/, "");
  if (CORNER.test(name)) return "corner";
  if (SPACING.test(name)) return name.startsWith("margin") ? "margin" : "spacing";
  return undefined;
}

/**
 * The spacing and corner token names a tokens stylesheet defines: the custom properties declared in its
 * `:root` rules whose names start with `--space-` or `--corner-`, and `--edge` (the page edge, a spacing step).
 */
export function readTokenNames(css) {
  const spacing = new Set();
  const corner = new Set();
  postcss.parse(css).walkDecls((decl) => {
    if (decl.parent?.type !== "rule" || decl.parent.selector.trim() !== ":root") return;
    if (decl.prop.startsWith("--space-") || decl.prop === "--edge") spacing.add(decl.prop);
    else if (decl.prop.startsWith("--corner-")) corner.add(decl.prop);
  });
  return { spacing: [...spacing].sort(), corner: [...corner].sort() };
}

// A small parser for the value grammar the rule needs: words, operators, commas and functions.
function parseValue(text) {
  let index = 0;
  function list(closing) {
    const nodes = [];
    while (index < text.length) {
      const char = text[index];
      if (char === ")") {
        if (closing) index += 1;
        return nodes;
      }
      if (/\s/.test(char)) {
        index += 1;
      } else if (char === "," || char === "*" || char === "/") {
        nodes.push({ type: char === "," ? "comma" : "op", value: char });
        index += 1;
      } else if (char === "(") {
        index += 1;
        nodes.push({ type: "function", name: "", nodes: list(true) });
      } else {
        let end = index;
        while (end < text.length && !/[\s,*/()]/.test(text[end])) end += 1;
        const word = text.slice(index, end);
        index = end;
        if (text[index] === "(") {
          index += 1;
          nodes.push({ type: "function", name: word.toLowerCase(), nodes: list(true) });
        } else if (word === "+" || word === "-") nodes.push({ type: "op", value: word });
        else nodes.push({ type: "word", value: word });
      }
    }
    return nodes;
  }
  return list(false);
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

function numeric(word) {
  const match = word.match(NUMBER);
  if (!match) return undefined;
  return { number: Number(match[0]), unit: word.slice(match[0].length).toLowerCase() };
}

function splitCommas(nodes) {
  const parts = [[]];
  for (const node of nodes) {
    if (node.type === "comma") parts.push([]);
    else parts[parts.length - 1].push(node);
  }
  return parts;
}

function stringify(node) {
  if (node.type === "function") return `${node.name}(${node.nodes.map(stringify).join(" ").replace(/ ,/g, ",")})`;
  return node.value;
}

/** `env(safe-area-inset-<side>)`, optionally with a fallback the rule allows. */
function refuseInset(node, context, side) {
  const [name, ...fallback] = splitCommas(node.nodes);
  const inset = name.length === 1 && name[0].type === "word" ? name[0].value.match(INSET) : null;
  if (!inset || (side && inset[1] !== side)) return `not a safe-area inset: ${stringify(node)}`;
  return fallback.length ? refuseComponents(fallback.flat(), context) : undefined;
}

/** Why a term is refused, or undefined when it is built from the tokens. */
function refuseTerm(node, context) {
  if (node.type === "word") {
    const value = numeric(node.value);
    if (value && value.number === 0) return undefined;
    if (node.value.toLowerCase() === "auto" && context.kind === "margin" && !context.math) return undefined;
    if (value && value.unit === "" && context.multiplier) return undefined;
    if (value && value.unit === "") return `a number that does not multiply a token: ${node.value}`;
    if (value && value.unit === "%") return `a percentage: ${node.value}`;
    if (value) return `a ${value.unit} value: ${node.value}`;
    return `not a token: ${node.value}`;
  }
  if (node.type !== "function") return `not a token: ${stringify(node)}`;
  if (node.name === "var") {
    const [name, ...fallback] = splitCommas(node.nodes);
    const token = name.length === 1 && name[0].type === "word" ? name[0].value : undefined;
    const hook = token?.match(INSET_HOOK);
    if (hook) {
      const [inset, ...rest] = fallback.flat();
      if (inset?.type === "function" && inset.name === "env" && !rest.length) return refuseInset(inset, context, hook[1]);
      return `not a safe-area inset: ${stringify(node)}`;
    }
    if (!token || !context.tokens.has(token)) return `not a token: ${stringify(node)}`;
    return fallback.length ? refuseComponents(fallback.flat(), context) : undefined;
  }
  if (node.name === "env") return refuseInset(node, context);
  if (node.name === "calc" || node.name === "min" || node.name === "max" || node.name === "") {
    for (const argument of splitCommas(node.nodes)) {
      if (!argument.length) return `an empty argument: ${stringify(node)}`;
      const reason = refuseExpression(argument, context);
      if (reason) return reason;
    }
    return undefined;
  }
  return `a function the rule does not allow: ${stringify(node)}`;
}

function refuseExpression(nodes, context) {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.type === "op") continue;
    const multiplier = nodes[index - 1]?.value === "*" || nodes[index - 1]?.value === "/" || nodes[index + 1]?.value === "*";
    const reason = refuseTerm(node, { ...context, math: true, multiplier });
    if (reason) return reason;
  }
  return undefined;
}

function refuseComponents(nodes, context) {
  for (const node of nodes) {
    // `/` separates the horizontal and vertical radii of a corner.
    if (node.type === "op" && node.value === "/" && context.kind === "corner" && !context.math) continue;
    const reason = refuseTerm(node, { ...context, math: false, multiplier: false });
    if (reason) return reason;
  }
  return undefined;
}

/** Why a declaration's value is refused, or undefined when it keeps inside the tokens. `tokens` is a Set of names. */
export function refuseValue(value, kind, tokens) {
  const text = value.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/!\s*important\s*$/i, "").trim();
  if (!text) return "an empty value";
  if (CSS_WIDE.has(text.toLowerCase())) return undefined;
  return refuseComponents(parseValue(text), { kind, tokens });
}

function exceptionComments(decl) {
  const comments = [];
  const raw = decl.raws.value?.raw ?? "";
  for (const match of raw.matchAll(/\/\*([\s\S]*?)\*\//g)) comments.push(match[1]);
  const next = decl.next();
  if (next?.type === "comment" && next.source?.start?.line === decl.source?.end?.line) comments.push(next.text);
  return comments.map((text) => text.match(EXCEPTION)).filter(Boolean).map((match) => match[1].trim());
}

/**
 * A stylesheet's findings and exceptions. `tokens` is `{ spacing, corner }`, each a list of names
 * (as `readTokenNames` returns). Each finding and exception has the file, line, property and value.
 */
export function checkStylesheet(css, tokens, file = "<stylesheet>") {
  // A spacing token may build a corner and a corner token a spacing (a fill nested inside a track's padding).
  const names = new Set([...tokens.spacing, ...tokens.corner]);
  const findings = [];
  const exceptions = [];
  let root;
  try {
    root = postcss.parse(css, { from: file });
  } catch (error) {
    return { findings: [{ file, line: error.line ?? 1, property: "", value: "", reason: `does not parse: ${error.reason ?? error.message}` }], exceptions };
  }
  root.walkDecls((decl) => {
    const kind = checkedKind(decl.prop);
    const value = decl.value.replace(/\s+/g, " ").trim();
    const where = { file, line: decl.source?.start?.line ?? 0, property: decl.prop, value };
    const marks = exceptionComments(decl);
    if (marks.length) {
      const reason = marks.find(Boolean);
      if (!reason) findings.push({ ...where, reason: "an exception needs a reason: /* tokens: <reason> */" });
      else if (!kind) findings.push({ ...where, reason: "an exception on a property the check does not read" });
      else if (!refuseValue(value, kind, names)) findings.push({ ...where, reason: "an exception on a value the tokens already allow" });
      else exceptions.push({ ...where, reason });
      return;
    }
    if (!kind) return;
    const reason = refuseValue(value, kind, names);
    if (reason) findings.push({ ...where, reason });
  });
  return { findings, exceptions };
}

function stylesheetsUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : stylesheetsUnder(full);
    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];
  });
}

/**
 * Runs the check over every `.css` file under `<root>/src`, except those in `skip` (paths relative to
 * the root, the stylesheets not yet converted). A listed file that does not exist is a finding.
 */
export function checkStylesheetTokens(root, { skip = [], tokensFile = TOKENS_FILE } = {}) {
  const findings = [];
  const exceptions = [];
  const tokensPath = path.join(root, tokensFile);
  if (!existsSync(tokensPath)) {
    findings.push({ file: tokensFile, line: 0, property: "", value: "", reason: "the tokens stylesheet does not exist" });
    return { findings, exceptions, files: [], tokens: { spacing: [], corner: [] } };
  }
  const tokens = readTokenNames(readFileSync(tokensPath, "utf8"));
  if (!tokens.spacing.length || !tokens.corner.length)
    findings.push({ file: tokensFile, line: 0, property: "", value: "", reason: "the tokens stylesheet defines no spacing or no corner token" });
  const skipped = new Set(skip);
  for (const file of skip)
    if (!existsSync(path.join(root, file)))
      findings.push({ file, line: 0, property: "", value: "", reason: "listed as not yet converted, but the file does not exist" });
  const files = stylesheetsUnder(path.join(root, "src"))
    .map((name) => path.relative(root, name).split(path.sep).join("/"))
    .filter((name) => !skipped.has(name))
    .sort();
  for (const file of files) {
    const result = checkStylesheet(readFileSync(path.join(root, file), "utf8"), tokens, file);
    findings.push(...result.findings);
    exceptions.push(...result.exceptions);
  }
  return { findings, exceptions, files, tokens };
}

export function formatEntry(entry) {
  const declaration = entry.property ? ` ${entry.property}: ${entry.value}` : "";
  return `${entry.file}:${entry.line}:${declaration} (${entry.reason})`;
}

// `node scripts/check-stylesheet-tokens.mjs [root] [--skip <file>]...`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const skip = [];
  let root = ".";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--skip") skip.push(args[++index]);
    else root = args[index];
  }
  const result = checkStylesheetTokens(path.resolve(root), { skip });
  for (const entry of result.exceptions) console.log(`exception ${formatEntry(entry)}`);
  for (const entry of result.findings) console.error(formatEntry(entry));
  if (result.findings.length) process.exitCode = 1;
  else console.log(`Stylesheet token check passed: ${result.files.length} stylesheets, ${result.exceptions.length} exceptions.`);
}
