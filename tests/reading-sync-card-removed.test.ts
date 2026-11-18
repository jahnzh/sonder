// The reader's Reading sync card gave way to the Reading sync page (#543): the card and the modules only it used are
// gone, nothing imports them, and the reader's map loading reads no `/alignments/options`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const removed = ["src/components/ReadingSync.tsx", "src/reading-sync-prepare.ts", "src/reading-sync-status.ts", "src/components/PoolFailureReasons.tsx"];

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

test("the card and the modules only it used are removed, and nothing imports them", () => {
  for (const file of removed) assert.equal(existsSync(join(root, file)), false, file);
  const importsRemoved = /from\s+["'][^"']*\/(ReadingSync|reading-sync-prepare|reading-sync-status|PoolFailureReasons)(\.tsx?)?["']|import\(["'][^"']*\/(ReadingSync|reading-sync-prepare|reading-sync-status|PoolFailureReasons)(\.tsx?)?["']\)/;
  const importers = [...sources("src"), ...sources("server"), ...sources("tests")].filter((file) => importsRemoved.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(importers, []);
});

test("of reading-sync-controls only what the page uses is left", async () => {
  const controls = await import("../src/reading-sync-controls.ts");
  assert.deepEqual(Object.keys(controls).sort(), ["JOB_NOT_LISTED", "runJobAction", "shownAfterAction"]);
});

test("the reader's map loading reads no /alignments/options", () => {
  for (const file of ["src/reader-map.ts", "src/use-reader-map.ts", "src/alignment-map-deps.ts"])
    assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /alignments\/options/, file);
  assert.doesNotMatch(readFileSync(join(root, "src/components/Reader.tsx"), "utf8"), /alignments\/options/);
});
