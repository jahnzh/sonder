import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The baseline freezes pre-existing fallbacks. New or changed catches must
// handle their error, even when they are in a file that has a legacy fallback.
const baselinePath = new URL("./server-catches-baseline.json", import.meta.url);

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isBindingElement(element) ? bindingIdentifiers(element.name) : []);
}

function isRead(identifier) {
  let node = identifier;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return false;
  if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    return false;
  return true;
}

function usesCaughtError(catchClause, checker) {
  if (!catchClause.variableDeclaration) return false;
  const symbols = new Set(bindingIdentifiers(catchClause.variableDeclaration.name)
    .map((name) => checker.getSymbolAtLocation(name)));
  let used = false;
  function visit(node) {
    if (ts.isIdentifier(node) && isRead(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol && symbols.has(symbol)) used = true;
    }
    if (!used) ts.forEachChild(node, visit);
  }
  visit(catchClause.block);
  return used;
}

function contextOf(node, sourceFile) {
  const names = [];
  for (let parent = node.parent; parent && parent !== sourceFile; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) ||
         ts.isVariableDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name)
      names.unshift(parent.name.getText(sourceFile));
  }
  return names.join(".") || "<top-level>";
}

export function findDroppingCatches(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const options = { noLib: true, noResolve: true, allowJs: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === file ? sourceFile : undefined;
  const checker = ts.createProgram([file], options, host).getTypeChecker();
  const findings = [];
  function visit(node) {
    if (ts.isCatchClause(node) && (!node.block.statements.length || !usesCaughtError(node, checker))) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push({
        file,
        line: line + 1,
        column: character + 1,
        context: contextOf(node, sourceFile),
        hash: createHash("sha256").update(node.getText(sourceFile)).digest("hex"),
        reason: node.block.statements.length ? "caught error is discarded" : "empty catch block",
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

function sourceFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(root, name);
    return entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [name] : [];
  });
}

function fingerprint(finding) {
  return JSON.stringify([finding.file, finding.context, finding.hash]);
}

export function checkServerCatches(root, baseline = []) {
  const allowed = new Map();
  for (const finding of baseline) {
    const key = fingerprint(finding);
    allowed.set(key, (allowed.get(key) ?? 0) + 1);
  }
  const findings = [];
  let baselined = 0;
  for (const name of sourceFiles(root)) {
    const file = path.relative(root, name).split(path.sep).join("/");
    for (const finding of findDroppingCatches(readFileSync(name, "utf8"), file)) {
      const key = fingerprint(finding);
      const remaining = allowed.get(key) ?? 0;
      if (remaining) {
        allowed.set(key, remaining - 1);
        baselined++;
      } else findings.push(finding);
    }
  }
  return { findings, baselined };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? "server");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { findings, baselined } = checkServerCatches(root, baseline);
  for (const finding of findings)
    console.error(`${path.join(root, finding.file)}:${finding.line}:${finding.column}: ${finding.reason}`);
  if (findings.length) process.exitCode = 1;
  else console.log(`Server catch check passed (${baselined} legacy catches baselined).`);
}
