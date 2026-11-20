// The slice pass (#794): importing it starts nothing, it walks a phone's and a desktop's size, and each Settings page
// and the offline line it looks for are the app's own.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFLINE_TEXT, SETTINGS_PAGES, SLICE_PASS_SIZES, runSlicePass } from "../scripts/verify-slice-pass.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("importing the slice pass launches nothing; it walks 390 by 844 and 1280 by 800", () => {
  assert.equal(typeof runSlicePass, "function");
  assert.deepEqual(SLICE_PASS_SIZES.map(({ width, height }) => [width, height]), [[390, 844], [1280, 800]]);
  assert.ok(Object.isFrozen(SLICE_PASS_SIZES));
});

test("the offline line and the Settings pages are the app's", () => {
  const lines = readFileSync(join(root, "src/status-lines.ts"), "utf8");
  const [lead, rest] = OFFLINE_TEXT.split(" · ");
  assert.match(lines, new RegExp(`OFFLINE_LINE = \\{ lead: NO_CONNECTION_LINE, rest: "${rest}" \\}`));
  assert.match(lines, new RegExp(`NO_CONNECTION_LINE = "${lead}"`));
  const list = readFileSync(join(root, "src/settings-list.ts"), "utf8");
  for (const [word, name] of SETTINGS_PAGES) {
    assert.match(list, new RegExp(`\\n  ${word}: "${name}",`), `${word}: ${name}`);
  }
});

test("the walk never sends a request of its own but GETs and the sign-in", () => {
  const source = readFileSync(join(root, "scripts/verify-slice-pass.mjs"), "utf8");
  const direct = [...source.matchAll(/request\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(direct)].sort(), ["post"]);
  assert.equal((source.match(/request\.post\(/g) || []).length, 1);
  assert.match(source, /request\.post\('\/api\/auth\/login'/);
  // Every page opens after the guard: protectBrowserMutations comes before newPage in each context.
  assert.ok(source.indexOf("protectBrowserMutations(context") < source.indexOf("context.newPage()"));
});
