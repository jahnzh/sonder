// Temp folders for tests that remove themselves when the test process exits.
// `npm test` runs each file in its own process, so a file's folders go when that file is done.
// tests/temp-leftovers.test.mjs fails if a test file leaves a folder behind.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const created: string[] = [];
let registered = false;

/** Creates `<tmpdir>/<prefix>XXXXXX` and removes it at process exit. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  if (!registered) {
    registered = true;
    process.on("exit", () => {
      for (const entry of created) {
        try {
          rmSync(entry, { recursive: true, force: true });
        } catch {
          // A folder that cannot be removed must not turn a passing test file into a failing one.
        }
      }
    });
  }
  return dir;
}
