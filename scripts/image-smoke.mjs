import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

// Importing the app opens its database, so never use the image's DATA_DIR.
const dataDir = mkdtempSync(join(tmpdir(), "sonder-image-smoke-"));
process.env.DATA_DIR = dataDir;
const serverModule = (name) => pathToFileURL(resolve("server", name)).href;

try {
  const { createApp } = await import(serverModule("app.ts"));
  assert.equal(typeof createApp, "function");
  const { runConsensusBuild } = await import(serverModule("ebook-set-consensus-runner.ts"));
  const sentence = { text: "Hello world.", norm: "hello world", paragraphId: "p1", section: 0 };
  const rows = await runConsensusBuild("image-smoke", [[sentence], [sentence]]);
  assert.deepEqual(rows, [{ text: "Hello world.", norm: "hello world", memberParagraphIds: ["p1", "p1"] }]);
  console.log("image smoke passed: server imports and consensus worker");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
