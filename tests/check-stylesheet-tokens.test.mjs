// The check that keeps stylesheets inside the tokens (#611, spec #608 "The rule that keeps stylesheets inside the
// tokens", ADR 0023). Each tree is built in a temp folder with a fixture tokens stylesheet; the last tests read the
// real source tree with the file system, never through git, so they also run in `npm run check`'s snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkStylesheet, checkStylesheetTokens, formatEntry, readTokenNames } from "../scripts/check-stylesheet-tokens.mjs";
import { tempDir } from "./temp-dir.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("../scripts/check-stylesheet-tokens.mjs", import.meta.url));

// Every value the boards draw that no token gives, marked `/* tokens: <reason> */` on its declaration.
// A new exception changes this number, so it is seen in review.
const EXCEPTIONS = 32;

// A fixture `appearance.css` with the tokens' names, and values on purpose unlike the real ones: the check reads
// names only, and only from `:root` (a variable a rule sets for itself is not a token).
const APPEARANCE = `:root {
  --background: #101510;
  --space-4: 5px;
  --space-8: 9px;
  --space-16: 17px;
  --corner-control: 7px;
  --corner-round: 999px;
  --height-control: 44px;
  --edge: 16px;
}
.button { padding: 3px; --corner-tiny: 2px; --space-2: 2px; }
`;
const TOKENS = readTokenNames(APPEARANCE);

/** Builds a tree with the fixture `src/appearance.css` and the given files, and returns its root. */
function tree(files) {
  const root = tempDir("sonder-stylesheet-tokens-");
  for (const [name, text] of Object.entries({ "src/appearance.css": APPEARANCE, ...files })) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}

function findings(css) {
  return checkStylesheet(css, TOKENS, "src/part.css").findings;
}

test("the token names are read from the tokens stylesheet's :root, without their values", () => {
  assert.deepEqual(TOKENS, {
    spacing: ["--edge", "--space-16", "--space-4", "--space-8"],
    corner: ["--corner-control", "--corner-round"],
  });
  // A name the fixture does not define is not a token, though the real tokens have it.
  assert.equal(findings(".a { padding: var(--space-12); }").length, 1);
});

test("each allowed form passes", () => {
  const css = `.a {
  padding: var(--space-8);
  padding: var(--space-8) var(--edge) 0 var(--space-4);
  margin: 0 auto;
  margin-inline: auto;
  gap: inherit;
  row-gap: initial;
  column-gap: unset;
  padding-bottom: env(safe-area-inset-bottom);
  padding-top: env(safe-area-inset-top, 0px);
  padding-top: var(--sonder-safe-top, env(safe-area-inset-top, 0px));
  padding: calc(var(--space-16) + env(safe-area-inset-top)) var(--space-16);
  margin: calc(-1 * var(--space-8)) 0 0;
  margin-top: calc(var(--space-4) * -2);
  margin-top: calc(var(--space-8) / 2);
  padding: min(var(--space-16), var(--edge)) max(0, var(--space-4));
  padding: calc((var(--space-16) - var(--space-4)) * 2);
  border-radius: var(--corner-control);
  border-radius: var(--corner-round) var(--corner-round) 0 0;
  border-radius: var(--corner-control) / var(--corner-round);
  border-radius: calc(var(--corner-control) - var(--space-4) / 2);
  padding: var(--space-8) !important;
}`;
  assert.deepEqual(findings(css), []);
});

test("a pixel value equal to a token, em, rem, a percentage and a calc() with a pixel term are each reported", () => {
  const css = `.a {
  padding: 8px;
}
.b { margin: 1em; }
.c { gap: 0.5rem; }
@media (min-width: 760px) {
  .d { border-radius: 50%; }
}
.e { padding: calc(var(--space-8) + 2px); }
`;
  const found = findings(css).map(({ file, line, property, value }) => ({ file, line, property, value }));
  assert.deepEqual(found, [
    { file: "src/part.css", line: 2, property: "padding", value: "8px" },
    { file: "src/part.css", line: 4, property: "margin", value: "1em" },
    { file: "src/part.css", line: 5, property: "gap", value: "0.5rem" },
    { file: "src/part.css", line: 7, property: "border-radius", value: "50%" },
    { file: "src/part.css", line: 9, property: "padding", value: "calc(var(--space-8) + 2px)" },
  ]);
  assert.match(formatEntry(findings(css)[0]), /^src\/part\.css:2: padding: 8px \(a px value: 8px\)$/);
});

test("other refused forms: auto off a margin, a number that multiplies nothing, a variable that is not a token", () => {
  for (const declaration of [
    "padding: auto",
    "margin: calc(auto + var(--space-4))",
    "gap: calc(2 + var(--space-4))",
    "padding: var(--rail-width)",
    "padding: var(--space-8, 8px)",
    "padding: var(--sonder-safe-top, 0px)",
    "padding: var(--sonder-safe-top, env(safe-area-inset-bottom))",
    "padding: env(keyboard-inset-height)",
    "padding: clamp(var(--space-4), 1vw, var(--space-8))",
    "border-radius: 2px",
    "border-radius: var(--height-control)",
  ])
    assert.equal(findings(`.a { ${declaration}; }`).length, 1, declaration);
});

test("longhand and logical properties are checked; heights, positions and custom properties are not", () => {
  const checked = [
    "padding-top", "padding-right", "padding-bottom", "padding-left", "padding-inline", "padding-block",
    "padding-inline-start", "padding-inline-end", "padding-block-start", "padding-block-end",
    "margin-top", "margin-left", "margin-inline", "margin-block", "margin-inline-end", "margin-block-start",
    "gap", "row-gap", "column-gap", "grid-gap",
    "border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius",
    "border-bottom-right-radius", "border-start-start-radius", "border-start-end-radius", "border-end-start-radius",
    "border-end-end-radius", "-webkit-border-radius",
  ];
  for (const property of checked) assert.equal(findings(`.a { ${property}: 3px; }`).length, 1, property);
  for (const property of ["height", "width", "top", "inset", "outline-offset", "scroll-padding", "--gutter", "font-size"])
    assert.equal(findings(`.a { ${property}: 3px; }`).length, 0, property);
});

test("an exception with a reason is counted, and one without a reason is reported", () => {
  const css = `.a {
  border-radius: 2px; /* tokens: Tooltips.dc.html, the pointer's corner */
  margin: -11px -12px /* tokens: Tooltips.dc.html, the mark's hit area */;
  padding: 6px; /* tokens: */
  gap: 2px; /* tokens:   */
  padding: var(--space-8); /* tokens: needless */
  width: 3px; /* tokens: not a checked property */
  padding: 10px;
  /* tokens: a comment on its own line marks nothing */
}`;
  const result = checkStylesheet(css, TOKENS, "src/part.css");
  assert.deepEqual(result.exceptions.map(({ line, property, reason }) => ({ line, property, reason })), [
    { line: 2, property: "border-radius", reason: "Tooltips.dc.html, the pointer's corner" },
    { line: 3, property: "margin", reason: "Tooltips.dc.html, the mark's hit area" },
  ]);
  assert.deepEqual(result.findings.map(({ line, reason }) => [line, reason]), [
    [4, "an exception needs a reason: /* tokens: <reason> */"],
    [5, "an exception needs a reason: /* tokens: <reason> */"],
    [6, "an exception on a value the tokens already allow"],
    [7, "an exception on a property the check does not read"],
    [8, "a px value: 10px"],
  ]);
});

test("the tree check reads every stylesheet under src/ and skips none", () => {
  const root = tree({
    "src/parts/row.css": ".row {\n  padding: var(--space-8);\n  gap: 2px; /* tokens: Row.dc.html */\n}\n",
    "src/pages/deep/page.css": ".page { margin: 12px; }\n",
    "src/styles.css": ".old { border-radius: 10px; }\n",
    "src/notes.txt": "padding: 3px;",
  });
  // A skip list is no longer read (#612): an old option passed by mistake skips nothing.
  const result = checkStylesheetTokens(root, { skip: ["src/styles.css"], tokensFile: "src/appearance.css" });
  assert.deepEqual(result.files, ["src/appearance.css", "src/pages/deep/page.css", "src/parts/row.css", "src/styles.css"]);
  assert.deepEqual(result.findings.map(({ file, line, property, value }) => [file, line, property, value]), [
    ["src/appearance.css", 11, "padding", "3px"],
    ["src/pages/deep/page.css", 1, "margin", "12px"],
    ["src/styles.css", 1, "border-radius", "10px"],
  ]);
  assert.deepEqual(result.exceptions.map(({ file, line }) => [file, line]), [["src/parts/row.css", 3]]);
  // A tree without its tokens stylesheet is a finding, not a pass.
  assert.match(checkStylesheetTokens(root, { tokensFile: "src/missing.css" }).findings[0].reason, /tokens stylesheet does not exist/);
});

test("the command line fails on a finding and passes a clean tree", () => {
  const clean = APPEARANCE.replace(/\.button \{[^}]*\}/, "");
  const root = tree({ "src/appearance.css": clean, "src/parts/tokens.css": clean, "src/a.css": ".a { gap: 4px; }\n" });
  const failing = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stderr, /src\/a\.css:1: gap: 4px/);
  writeFileSync(path.join(root, "src/a.css"), ".a { gap: var(--space-4); }\n");
  const passing = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /Stylesheet token check passed: 3 stylesheets, 0 exceptions/);
});

test("every stylesheet of the real tree keeps inside the tokens, with no list of skipped files", () => {
  const result = checkStylesheetTokens(repository);
  assert.deepEqual(result.findings.map(formatEntry), []);
  assert.ok(result.tokens.spacing.includes("--space-8") && result.tokens.corner.includes("--corner-control"));
  // The parts and the new pages are among the checked stylesheets.
  for (const file of ["src/parts/row.css", "src/parts/sheet.css", "src/pages/library-page.css", "src/shell.css", "src/appearance.css", "src/player.css", "src/reader.css", "src/signin.css", "src/styles.css"])
    assert.ok(result.files.includes(file), file);
  console.log(`${result.exceptions.length} exceptions:\n${result.exceptions.map((entry) => `  ${formatEntry(entry)}`).join("\n")}`);
  assert.equal(result.exceptions.length, EXCEPTIONS);
});
