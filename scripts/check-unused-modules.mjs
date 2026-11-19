// Fails on a module under `src/` that neither the app nor the server reaches (#609, spec #608
// "Modules nothing imports"). From the entry points it follows static imports, `import()` with a
// literal path, re-exports, Vite's `import.meta.glob` with literal patterns, `new URL("<literal>",
// import.meta.url)` (workers) and CSS `@import`,
// resolving `.ts`, `.tsx`, `.mjs`, `.js`, `.css` and directory indexes. Tests are not entry points:
// a module that only a test imports is dead. Files are read with the file system, never through git,
// so the check runs in `npm run check`'s snapshot too.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".css"];
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** The entry points, relative to the repository root: the app, the server, the service worker build and the live checks. */
export function entryPoints(root) {
  const scripts = path.join(root, "scripts");
  const verify = existsSync(scripts)
    ? readdirSync(scripts).filter((name) => /^verify-.*\.mjs$/.test(name)).sort().map((name) => `scripts/${name}`)
    : [];
  return ["src/main.tsx", "server/index.ts", "scripts/build-sw.mjs", ...verify];
}

function cssImports(source) {
  const specifiers = [];
  const pattern = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1/g;
  for (const match of source.replace(/\/\*[\s\S]*?\*\//g, " ").matchAll(pattern)) specifiers.push(match[2]);
  return specifiers;
}

function isImportMetaUrl(node) {
  return ts.isPropertyAccessExpression(node) && node.name.text === "url" &&
    ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
}

function isImportMetaGlob(node) {
  return ts.isPropertyAccessExpression(node) && node.name.text === "glob" &&
    ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
}

/**
 * Every module specifier a script file names: imports, re-exports, literal `import()`, `require()`
 * and worker URLs, and the patterns of `import.meta.glob` (returned in `globs`).
 */
export function scriptImports(source, file) {
  return scriptReferences(source, file).specifiers;
}

function scriptReferences(source, file) {
  const kind = file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind);
  const specifiers = [];
  const globs = [];
  const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const text = literal(node.moduleSpecifier);
      if (text !== undefined) specifiers.push(text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const text = literal(node.moduleReference.expression);
      if (text !== undefined) specifiers.push(text);
    } else if (ts.isCallExpression(node) && isImportMetaGlob(node.expression) && node.arguments.length >= 1) {
      const argument = node.arguments[0];
      const patterns = ts.isArrayLiteralExpression(argument) ? argument.elements : [argument];
      for (const pattern of patterns) {
        const text = literal(pattern);
        if (text !== undefined) globs.push(text);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const text = literal(node.arguments[0]);
      if ((isImport || isRequire) && text !== undefined) specifiers.push(text);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" &&
      node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1])) {
      const text = literal(node.arguments[0]);
      if (text !== undefined) specifiers.push(text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const text = literal(node.argument.literal);
      if (text !== undefined) specifiers.push(text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { specifiers, globs };
}

function globPattern(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      pattern += glob[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += glob[index + 2] === "/" ? 2 : 1;
    } else if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else if (character === "{") {
      const end = glob.indexOf("}", index);
      pattern += `(?:${glob.slice(index + 1, end).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      index = end;
    } else pattern += character.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

/** The files a relative `import.meta.glob` pattern matches; `!` patterns are exclusions and match nothing. */
export function resolveGlob(from, glob) {
  if (!glob.startsWith("./") && !glob.startsWith("../")) return [];
  const directory = path.dirname(from);
  const fixed = glob.split("/").filter((_, index, parts) => !parts.slice(0, index + 1).some((part) => /[*?{]/.test(part)));
  const base = path.resolve(directory, fixed.join("/"));
  const pattern = globPattern(path.resolve(directory, glob).split(path.sep).join("/"));
  return filesUnder(base).filter((name) => pattern.test(name.split(path.sep).join("/")));
}

function isFile(name) {
  try {
    return statSync(name).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function isDirectory(name) {
  try {
    return statSync(name).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

/** Resolves a relative specifier to a file: as written, with an extension, or as a directory's index. */
export function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) return undefined;
  const bare = specifier.replace(/[?#].*$/, "");
  const base = path.resolve(path.dirname(from), bare);
  if (isFile(base)) return base;
  for (const extension of EXTENSIONS) if (isFile(base + extension)) return base + extension;
  // TypeScript's ESM convention: `./x.js` names `./x.ts`.
  const swapped = base.replace(/\.(m?)js$/, ".$1ts");
  if (swapped !== base && isFile(swapped)) return swapped;
  if (base.endsWith(".js") && isFile(base.slice(0, -3) + ".tsx")) return base.slice(0, -3) + ".tsx";
  if (isDirectory(base))
    for (const extension of EXTENSIONS) if (isFile(path.join(base, `index${extension}`))) return path.join(base, `index${extension}`);
  return undefined;
}

function filesUnder(directory) {
  if (!isDirectory(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(name);
    return entry.isFile() && EXTENSIONS.includes(path.extname(entry.name)) && !entry.name.endsWith(".d.ts") ? [name] : [];
  });
}

/**
 * Walks the imports from the entry points under `root` and returns every module under `root/src`
 * that none of them reaches, as sorted paths relative to `root` with `/` separators.
 */
export function findUnusedModules(root, entries = entryPoints(root)) {
  const reached = new Set();
  const pending = [];
  for (const entry of entries) {
    const name = path.resolve(root, entry);
    if (!isFile(name)) throw new Error(`Entry point ${entry} does not exist under ${root}`);
    pending.push(name);
  }
  while (pending.length) {
    const name = pending.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    if (name.split(path.sep).includes("node_modules")) continue;
    let references;
    if (name.endsWith(".css")) references = { specifiers: cssImports(readFileSync(name, "utf8")), globs: [] };
    else if (SCRIPT.test(name)) references = scriptReferences(readFileSync(name, "utf8"), name);
    else continue;
    for (const specifier of references.specifiers) {
      const target = resolveSpecifier(name, specifier);
      if (target && !reached.has(target)) pending.push(target);
    }
    for (const glob of references.globs)
      for (const target of resolveGlob(name, glob)) if (!reached.has(target)) pending.push(target);
  }
  return filesUnder(path.join(root, "src"))
    .filter((name) => !reached.has(name))
    .map((name) => path.relative(root, name).split(path.sep).join("/"))
    .sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? ".");
  const unused = findUnusedModules(root);
  for (const file of unused) console.error(`${file}: no entry point imports this module`);
  if (unused.length) process.exitCode = 1;
  else console.log("Unused module check passed.");
}
