// Fails on a class that a stylesheet under `src/` styles and that no file of the app uses (#610,
// spec #608 "Stylesheet rules whose classes are gone"). A class is used when it appears as a whole
// word in a string of a `.ts` or `.tsx` file under `src/` or in an attribute of `index.html` (a
// `className`, a `clsx`/`cn` argument and a `classList` call are strings too, and the keys of an
// object passed to `clsx`/`cn` count), when it starts with a prefix that a template string in a
// class position builds (`` className={`status-${state}`} `` makes `status-` a prefix), or when a
// library outside the app's code sets it (LIBRARY_CLASSES). Comments are not strings, so a class
// that only a comment names is reported. Files are read with the file system, never through git,
// so the check runs in `npm run check`'s snapshot too.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import ts from "typescript";

/**
 * Classes that something outside the app's code puts on an element, each with what sets it.
 * They stay styled although no file of the app names them.
 */
export const LIBRARY_CLASSES = {
  "epub-container": "epub.js (its stage puts the view container in this class)",
  "lucide-pause": "lucide-react (every icon carries `lucide-<icon name>`)",
};

const WORD = /[A-Za-z0-9_-]+/g;
const CLASS_CALLS = new Set(["clsx", "cn", "classNames", "cx"]);
const CLASS_LIST_METHODS = new Set(["add", "remove", "toggle", "replace", "contains"]);

function wordsOf(text, into) {
  for (const match of text.matchAll(WORD)) into.add(match[0]);
}

/** The word a template part ends with just before `${`, when that word starts the part or follows a space. */
function trailingPrefix(text, isHead) {
  const match = /(^|\s)([A-Za-z_-][A-Za-z0-9_-]*)$/.exec(text);
  if (!match) return undefined;
  if (match[1] === "" && !isHead) return undefined; // `${a}-b-${c}`: `-b-` continues a dynamic word
  return match[2];
}

/** The strings an expression can be, when every one of them is a literal (or nothing), else undefined. */
function literalLeaves(node) {
  if (ts.isParenthesizedExpression(node)) return literalLeaves(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === "undefined") ||
    node.kind === ts.SyntaxKind.FalseKeyword) return [""];
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalLeaves(node.whenTrue);
    const whenFalse = literalLeaves(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : undefined;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const right = literalLeaves(node.right);
    return right ? ["", ...right] : undefined;
  }
  return undefined;
}

/** Whether an interpolation only ever adds nothing or a new space-separated word (`${on ? " on" : ""}`), so the part before it is not a prefix. */
function startsNewWord(expression) {
  const leaves = literalLeaves(expression);
  return leaves !== undefined && leaves.every((text) => text === "" || /^\s/.test(text));
}

/** Whether a node sits where its value becomes a class: a `className`/`class` attribute, a `clsx`/`cn` argument, a `classList` call, or a variable or property named after a class. */
function inClassPosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxAttribute(current)) return /^class(Name)?$/.test(current.name.getText());
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isIdentifier(callee) && CLASS_CALLS.has(callee.text)) return true;
      if (ts.isPropertyAccessExpression(callee) && CLASS_LIST_METHODS.has(callee.name.text) &&
        ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "classList") return true;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "setAttribute" && current.arguments[0] &&
        ts.isStringLiteral(current.arguments[0]) && current.arguments[0].text === "class") return true;
    }
    if ((ts.isVariableDeclaration(current) || ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)) &&
      current.name && /class/i.test(current.name.getText())) return true;
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      /class/i.test(current.left.getText())) return true;
    // A statement block ends the search: a template in a function body is not the value of the class around it.
    if (ts.isBlock(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

/** The words and template prefixes of one script file. */
export function scriptUses(source, file, uses = { words: new Set(), prefixes: new Set() }) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) wordsOf(node.text, uses.words);
    else if (ts.isTemplateExpression(node)) {
      const classy = inClassPosition(node);
      // Each literal part with the expression that follows it (none after the last part).
      const parts = [{ text: node.head.text, isHead: true, next: node.templateSpans[0]?.expression }, ...node.templateSpans.map((span, index) => ({
        text: span.literal.text,
        isHead: false,
        next: node.templateSpans[index + 1]?.expression,
      }))];
      for (const part of parts) {
        wordsOf(part.text, uses.words);
        if (classy && part.next && !startsNewWord(part.next)) {
          const prefix = trailingPrefix(part.text, part.isHead);
          if (prefix && /[A-Za-z]/.test(prefix)) uses.prefixes.add(prefix);
        }
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_CALLS.has(node.expression.text)) {
      for (const argument of node.arguments) objectKeys(argument, uses.words);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return uses;
}

function objectKeys(node, into) {
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) into.add(property.name.text);
    }
  } else if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) objectKeys(element, into);
}

/** The words of an HTML file's attribute values and inline scripts' strings; comments are skipped. */
export function htmlUses(source, uses = { words: new Set(), prefixes: new Set() }) {
  const text = source.replace(/<!--[\s\S]*?-->/g, " ");
  for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) scriptUses(match[1], "inline.ts", uses);
  const markup = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  for (const match of markup.matchAll(/\s[\w:-]+\s*=\s*("([^"]*)"|'([^']*)')/g)) wordsOf(match[2] ?? match[3], uses.words);
  return uses;
}

/** The classes a selector names. Quoted strings (attribute values) are taken out first; an unquoted attribute value cannot hold a dot. */
export function selectorClasses(selector) {
  const plain = selector.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "\"\"");
  const classes = [];
  for (const match of plain.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
    classes.push(match[1].replace(/\\(.)/g, "$1"));
  }
  return classes;
}

function insideKeyframes(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent)
    if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) return true;
  return false;
}

/** Whether a class is used: a word, a template prefix, or a library's. */
export function isUsed(name, uses, libraryClasses = LIBRARY_CLASSES) {
  if (Object.hasOwn(libraryClasses, name) || uses.words.has(name)) return true;
  for (const prefix of uses.prefixes) if (name.startsWith(prefix) && name.length > prefix.length) return true;
  return false;
}

/**
 * The dead classes of one stylesheet's text: one finding per selector of a rule that names a class
 * nothing uses, with the line, the selector and the dead classes in it.
 */
export function unusedInStylesheet(css, file, uses, libraryClasses = LIBRARY_CLASSES) {
  const findings = [];
  postcss.parse(css, { from: file }).walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    for (const selector of rule.selectors) {
      const dead = selectorClasses(selector).filter((name) => !isUsed(name, uses, libraryClasses));
      if (dead.length) findings.push({ file, line: rule.source.start.line, selector: selector.trim(), classes: [...new Set(dead)] });
    }
  });
  return findings;
}

function filesUnder(directory, test) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : filesUnder(name, test);
    return entry.isFile() && test(entry.name) ? [name] : [];
  }).sort();
}

/** The words and prefixes of every `.ts`/`.tsx` file under `root/src` and of `root/index.html`. */
export function appUses(root) {
  const uses = { words: new Set(), prefixes: new Set() };
  for (const name of filesUnder(path.join(root, "src"), (file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts")))
    scriptUses(readFileSync(name, "utf8"), name, uses);
  const html = path.join(root, "index.html");
  if (existsSync(html)) htmlUses(readFileSync(html, "utf8"), uses);
  return uses;
}

/** Every selector in a `.css` file under `root/src` that names a class nothing uses, paths relative to `root`. */
export function findUnusedClasses(root, libraryClasses = LIBRARY_CLASSES) {
  const uses = appUses(root);
  return filesUnder(path.join(root, "src"), (file) => file.endsWith(".css")).flatMap((name) =>
    unusedInStylesheet(readFileSync(name, "utf8"), path.relative(root, name).split(path.sep).join("/"), uses, libraryClasses));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? ".");
  const findings = findUnusedClasses(root);
  for (const finding of findings)
    console.error(`${finding.file}:${finding.line}: ${finding.selector} (${finding.classes.map((name) => `.${name}`).join(", ")} unused)`);
  if (findings.length) process.exitCode = 1;
  else console.log("Unused class check passed.");
}
