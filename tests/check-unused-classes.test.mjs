// The check that fails on a class a stylesheet under src/ styles and no file of the app uses (#610, spec #608
// "Stylesheet rules whose classes are gone"). Each tree is built in a temp folder; the last tests read the real source
// tree with the file system, never through git, so they also run in `npm run check`'s snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LIBRARY_CLASSES, findUnusedClasses, selectorClasses } from "../scripts/check-unused-classes.mjs";
import { tempDir } from "./temp-dir.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("../scripts/check-unused-classes.mjs", import.meta.url));

/** Builds a tree with the given files and returns its root. */
function tree(files) {
  const root = tempDir("sonder-unused-classes-");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}

/** The dead classes the check reports for a tree, as `file:line selector`. */
function report(root, libraries) {
  return findUnusedClasses(root, libraries).map((finding) => `${finding.file}:${finding.line} ${finding.selector}`);
}

test("a class in a string, in a className, in a clsx argument and in index.html is used", () => {
  const root = tree({
    "src/styles.css": ".in-string { } .in-classname { } .in-clsx-key { } .in-clsx-string { } .in-html { } .dead { }\n",
    "src/a.ts": 'export const kind = "card in-string";\n',
    "src/B.tsx": 'export const B = () => <div className="row in-classname" />;\n',
    "src/C.tsx": 'import { clsx } from "clsx";\nexport const C = (on: boolean) => <div className={clsx("in-clsx-string", { "in-clsx-key": on })} />;\n',
    "index.html": '<!doctype html><html><body><div id="root" class="in-html"></div></body></html>\n',
  });
  assert.deepEqual(report(root), ["src/styles.css:1 .dead"]);
});

test("a clsx argument's object key is used even when it is a bare identifier", () => {
  const root = tree({
    "src/styles.css": ".active { }\n.idle { }\n",
    "src/a.tsx": 'import { cn } from "./lib";\nexport const A = (active: boolean) => <i className={cn("x", { active })} />;\n',
  });
  assert.deepEqual(report(root), ["src/styles.css:2 .idle"]);
});

test("a class that starts with a prefix a template string builds is used", () => {
  const root = tree({
    "src/styles.css": ".status-ok { }\n.status-failed { }\n.status { }\n.other-thing { }\n",
    "src/a.tsx": "export const A = ({ state }: { state: string }) => <span className={`badge status-${state}`} />;\n",
  });
  // `status-` is a prefix; `status` alone is no class the template can build, and `other-` is in no template.
  assert.deepEqual(report(root), ["src/styles.css:3 .status", "src/styles.css:4 .other-thing"]);
});

test("a fragment between two interpolations and a prefix of no letter build no prefix", () => {
  const root = tree({
    "src/styles.css": ".b-wide { }\n.-x { }\n.size-x { }\n",
    "src/a.tsx": "export const A = ({ a, c }: { a: string; c: string }) => <i className={`size-${a}b-${c} -${a}`} />;\n",
  });
  // `size-` is a prefix; `b-` continues the word `size-${a}`, and `-` alone has no letter.
  assert.deepEqual(report(root), ["src/styles.css:1 .b-wide", "src/styles.css:2 .-x"]);
});

test("a template in a classList call, a class attribute set by hand or a class variable builds a prefix", () => {
  const root = tree({
    "src/styles.css": ".is-open { }\n.tone-dark { }\n.kind-epub { }\n.gone-x { }\n",
    "src/a.ts": [
      "export function mark(element: HTMLElement, state: string, tone: string, kind: string) {",
      "  element.classList.add(`is-${state}`);",
      "  element.setAttribute(\"class\", `tone-${tone}`);",
      "  const rowClass = `kind-${kind}`;",
      "  element.dataset.label = `gone-${kind}`;",
      "  return rowClass;",
      "}",
      "",
    ].join("\n"),
  });
  assert.deepEqual(report(root), ["src/styles.css:4 .gone-x"]);
});

test("an arrow's expression in a className builds a prefix, a statement in a function body under a class name does not", () => {
  const root = tree({
    "src/styles.css": ".tag-fiction { }\n.note-x { }\n",
    "src/a.tsx": [
      "export const A = ({ tags }: { tags: string[] }) => <p className={tags.map((tag) => `tag-${tag}`).join(\" \")} />;",
      "export const rowClass = (element: HTMLElement, kind: string) => {",
      "  element.dataset.note = `note-${kind}`;",
      "  return \"row\";",
      "};",
      "",
    ].join("\n"),
  });
  assert.deepEqual(report(root), ["src/styles.css:2 .note-x"]);
});

test("a template that only adds a new word after a class builds no prefix from it", () => {
  const root = tree({
    "src/styles.css": ".row { }\n.row-text { }\n.off { }\n",
    "src/a.tsx": 'export const A = ({ off }: { off: boolean }) => <li className={`row${off ? " off" : ""}`} />;\n',
  });
  assert.deepEqual(report(root), ["src/styles.css:2 .row-text"]);
});

test("a template outside a class position builds no prefix", () => {
  const root = tree({
    "src/styles.css": ".edit-field { }\n",
    "src/a.tsx": "export const A = ({ field }: { field: string }) => <li data-testid={`edit-${field}`} />;\n",
  });
  assert.deepEqual(report(root), ["src/styles.css:1 .edit-field"]);
});

test("a class that only a comment names is reported", () => {
  const root = tree({
    "src/styles.css": "/* .commented is described here */\n.commented { color: red; }\n",
    "src/a.tsx": '// <div className="commented">\n/* "commented" */\nexport const A = () => <div className="other" />;\n',
    "index.html": '<!-- <div class="commented"></div> -->\n<div class="other"></div>\n',
  });
  assert.deepEqual(report(root), ["src/styles.css:2 .commented"]);
});

test("a tag name and the text between tags are not strings: a class they name is reported", () => {
  const root = tree({
    "src/styles.css": ".small { }\n",
    "src/a.tsx": "export const A = () => <small>small print</small>;\n",
  });
  assert.deepEqual(report(root), ["src/styles.css:1 .small"]);
});

test("in a selector list only the dead selector is reported, with its file and line", () => {
  const root = tree({
    "src/pages/page.css": ".alive,\n.alive > .gone,\n.also-alive:hover {\n  color: red;\n}\n",
    "src/a.tsx": 'export const A = () => <p className="alive also-alive" />;\n',
  });
  assert.deepEqual(findUnusedClasses(root), [
    { file: "src/pages/page.css", line: 1, selector: ".alive > .gone", classes: ["gone"] },
  ]);
});

test("rules inside media and @supports blocks are checked, keyframe steps are not classes", () => {
  const root = tree({
    "src/styles.css": "@media (max-width: 600px) { .narrow { } }\n@supports (display: grid) { .grid { } }\n@keyframes spin { from { opacity: 0; } 50.5% { opacity: 1; } }\n",
    "src/a.ts": 'export const grid = "grid";\n',
  });
  assert.deepEqual(report(root), ["src/styles.css:1 .narrow"]);
});

test("a class named in an attribute selector's value or a string is not read as a class", () => {
  assert.deepEqual(selectorClasses('a[href$=".epub"] .x:not(.y)::after'), ["x", "y"]);
  assert.deepEqual(selectorClasses(".md\\:wide"), ["md:wide"]);
});

test("a class a listed library sets is used", () => {
  const root = tree({
    "src/reader.css": ".reader .epub-container { }\n.reader .epub-view { }\n",
    "src/a.tsx": 'export const A = () => <div className="reader" />;\n',
  });
  assert.deepEqual(report(root, { "epub-container": "epub.js" }), ["src/reader.css:2 .reader .epub-view"]);
  assert.deepEqual(report(root, { "epub-container": "epub.js", "epub-view": "epub.js" }), []);
});

test("every listed library class names the library that sets it", () => {
  for (const [name, library] of Object.entries(LIBRARY_CLASSES)) assert.match(library, /\S/, name);
});

test("the CLI exits with 1 and names file, line and selector of a dead class", () => {
  const root = tree({ "src/styles.css": "\n.gone { }\n" });
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/styles\.css:2: \.gone \(\.gone unused\)/);
});

test("the real tree has no stylesheet rule for a class nothing uses", () => {
  assert.deepEqual(findUnusedClasses(repository), []);
});

test("every listed library class is still styled by a stylesheet", () => {
  // A library class no stylesheet names any more is a stale entry.
  const styled = new Set(findUnusedClasses(repository, {}).flatMap((finding) => finding.classes));
  for (const name of Object.keys(LIBRARY_CLASSES)) assert.ok(styled.has(name), `${name} is listed but no stylesheet styles it`);
});
