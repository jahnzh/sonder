// The check that fails on a module under src/ that neither the app nor the server reaches (#609,
// spec #608 "Modules nothing imports"). Each tree is built in a temp folder; the last test reads the
// real source tree with the file system, never through git, so it also runs in `npm run check`'s snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { entryPoints, findUnusedModules } from "../scripts/check-unused-modules.mjs";
import { tempDir } from "./temp-dir.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("../scripts/check-unused-modules.mjs", import.meta.url));

/** Builds a tree with the four kinds of entry point and the given files, and returns its root. */
function tree(files) {
  const root = tempDir("sonder-unused-modules-");
  const all = {
    "src/main.tsx": "",
    "server/index.ts": "",
    "scripts/build-sw.mjs": "",
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}

test("a static import keeps a module alive, and the modules it imports", () => {
  const root = tree({
    "src/main.tsx": 'import App from "./App";\nimport type { Book } from "./types.ts";\n',
    "src/App.tsx": 'import { label } from "./label";\nexport default function App() { return label; }\n',
    "src/label.ts": 'export const label = "x";\n',
    "src/types.ts": "export type Book = { id: number };\n",
    "src/dead.ts": "export const dead = 1;\n",
  });
  assert.deepEqual(findUnusedModules(root), ["src/dead.ts"]);
});

test("a dynamic import() with a literal path keeps a module alive", () => {
  const root = tree({
    "src/main.tsx": 'void import("./lazy.tsx");\nconst name = "./computed"; void import(name);\n',
    "src/lazy.tsx": "export default 1;\n",
    "src/computed.ts": "export default 1;\n",
  });
  // A computed path is not followed: nothing can tell which file it names.
  assert.deepEqual(findUnusedModules(root), ["src/computed.ts"]);
});

test("a re-export keeps a module alive", () => {
  const root = tree({
    "src/main.tsx": 'import { a } from "./barrel";\n',
    "src/barrel.ts": 'export { a } from "./a";\nexport * from "./b";\nexport * as c from "./c";\n',
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 1;\n",
    "src/c.ts": "export const c = 1;\n",
  });
  assert.deepEqual(findUnusedModules(root), []);
});

test("a directory index keeps a module alive", () => {
  const root = tree({
    "src/main.tsx": 'import { part } from "./parts";\nimport "./styles";\n',
    "src/parts/index.ts": "export const part = 1;\n",
    "src/styles/index.css": ".x {}\n",
    "src/other/index.ts": "export const other = 1;\n",
  });
  assert.deepEqual(findUnusedModules(root), ["src/other/index.ts"]);
});

test("a module only a test imports is reported, and so is one only a dead module imports", () => {
  const root = tree({
    "src/main.tsx": "",
    "src/tested.ts": 'import "./helper";\nexport const tested = 1;\n',
    "src/helper.ts": "export const helper = 1;\n",
    "tests/tested.test.ts": 'import { tested } from "../src/tested.ts";\n',
  });
  assert.deepEqual(findUnusedModules(root), ["src/helper.ts", "src/tested.ts"]);
});

test("a .css import is followed, through CSS @import too", () => {
  const root = tree({
    "src/main.tsx": 'import "./styles.css";\nimport "tailwindcss";\n',
    "src/styles.css": '@import "tailwindcss";\n@import "./parts/tokens.css";\n@import url("./fonts.css");\n/* @import "./commented.css"; */\n',
    "src/parts/tokens.css": ":root { --space-4: 4px; }\n",
    "src/fonts.css": "",
    "src/commented.css": "",
    "src/unused.css": ".gone {}\n",
  });
  assert.deepEqual(findUnusedModules(root), ["src/commented.css", "src/unused.css"]);
});

test("two dead modules that import each other are both reported", () => {
  const root = tree({
    "src/main.tsx": "",
    "src/ping.ts": 'import { pong } from "./pong";\nexport const ping = () => pong();\n',
    "src/pong.ts": 'import { ping } from "./ping";\nexport const pong = () => ping();\n',
  });
  assert.deepEqual(findUnusedModules(root), ["src/ping.ts", "src/pong.ts"]);
});

test("a src/ file reached from the server entry is alive", () => {
  const root = tree({
    "server/index.ts": 'import { createApp } from "./app.ts";\n',
    "server/app.ts": 'import type { Book } from "../src/types.ts";\nimport { appearance } from "../src/appearance";\n',
    "src/types.ts": "export type Book = {};\n",
    "src/appearance.ts": "export const appearance = 1;\n",
  });
  assert.deepEqual(findUnusedModules(root), []);
});

test("the service worker build and every live check are entry points; other scripts are not", () => {
  const root = tree({
    "scripts/build-sw.mjs": 'import "../src/sw-list.ts";\n',
    "scripts/verify-reader.mjs": 'import "../src/reader-check.ts";\n',
    "scripts/other.mjs": 'import "../src/other.ts";\n',
    "src/sw-list.ts": "",
    "src/reader-check.ts": "",
    "src/other.ts": "",
  });
  assert.deepEqual(entryPoints(root), ["src/main.tsx", "server/index.ts", "scripts/build-sw.mjs", "scripts/verify-reader.mjs"]);
  assert.deepEqual(findUnusedModules(root), ["src/other.ts"]);
});

test("Vite's import.meta.glob and a worker's new URL(…, import.meta.url) keep modules alive", () => {
  const root = tree({
    "src/main.tsx": 'const sections = import.meta.glob("./sections/*.tsx", { eager: true });\n',
    "src/sections/a.tsx": "export default 1;\n",
    "src/sections/b.tsx": "export default 2;\n",
    "src/sections/nested/c.tsx": "export default 3;\n",
    "server/index.ts": 'new Worker(new URL("../src/worker.ts", import.meta.url));\n',
    "src/worker.ts": "",
  });
  assert.deepEqual(findUnusedModules(root), ["src/sections/nested/c.tsx"]);
});

test("the CLI names every unused module and fails, and passes on a clean tree", () => {
  const root = tree({ "src/dead.tsx": "export {};\n" });
  const failed = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /^src\/dead\.tsx: no entry point imports this module$/m);
  const clean = spawnSync(process.execPath, [script, tree({})], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Unused module check passed/);
});

test("the real source tree has no module that nothing imports", () => {
  assert.deepEqual(findUnusedModules(repository), []);
});
