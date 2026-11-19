/**
 * The tooltip texts (#496, spec #493 "One vocabulary"): the module holds the design's list word for word, the six
 * pause sentences equal what the server sends, and the server never imports the module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error the design's tools are plain JavaScript without declarations
import { T } from "../docs/design/redesign/tools/tips.mjs";
import { TIPS, tip } from "../src/tooltip-texts.ts";
import { PAUSABLE_PROCESSES, PAUSE_EFFECT } from "../server/activity-pause-model.ts";

const design = T as Record<string, string>;

test("the module holds the design's names and texts, word for word", () => {
  assert.ok(Object.keys(design).length > 0);
  assert.deepEqual(Object.keys(TIPS).sort(), Object.keys(design).sort(), "the same names (after a board change: node scripts/sync-tooltip-texts.mjs)");
  for (const [name, text] of Object.entries(design)) {
    assert.equal((TIPS as Record<string, string>)[name], text, name);
    assert.equal(tip(name as keyof typeof TIPS), text, `tip(${name})`);
  }
});

test("the six pause sentences equal the ones the server sends", () => {
  const nameOf: Record<(typeof PAUSABLE_PROCESSES)[number], keyof typeof TIPS> = {
    acquisitions: "downloadQueue",
    "server-copies": "copies",
    "series-acquisition": "seriesSearch",
    alignment: "syncQueue",
    "ebook-set": "ebookChecks",
    backups: "backups",
  };
  assert.equal(PAUSABLE_PROCESSES.length, 6);
  for (const id of PAUSABLE_PROCESSES) assert.equal(TIPS[nameOf[id]], PAUSE_EFFECT[id], id);
});

test("the server imports nothing from the tooltip module", () => {
  const root = join(import.meta.dirname, "..");
  const files = readdirSync(join(root, "server")).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 10, "the scan finds the server's files");
  for (const name of files) {
    assert.doesNotMatch(readFileSync(join(root, "server", name), "utf8"), /tooltip-texts/, name);
  }
});

test("no tooltip is left of Hardcover's sync, page or settings, and the module holds as many texts as the design's list (#721 part d)", async () => {
  // @ts-expect-error the design's tools are plain JavaScript without declarations
  const { tipGroups } = (await import("../docs/design/redesign/tools/tips.mjs")) as { tipGroups: [string, [string, string][]][] };
  assert.equal(tipGroups.find(([screen]) => screen === "Hardcover"), undefined, "the design lists no Hardcover page");
  for (const name of ["hardcoverPosition", "hardcoverEdition", "hardcoverMatch", "hardcoverSync", "hardcoverProgress"])
    assert.equal(name in TIPS, false, name);
  const named = tipGroups.flatMap(([, tips]) => tips.map(([label]) => label));
  for (const label of ["Use Hardcover position", "Hardcover edition", "Match on Hardcover", "Hardcover sync", "Sync listening and reading progress"])
    assert.equal(named.includes(label), false, label);
  assert.equal(Object.keys(TIPS).length, Object.keys(design).length);
});
