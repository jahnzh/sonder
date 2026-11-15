import fs from "node:fs";
import { after, type TestContext } from "node:test";

/** Remove a mkdtemp directory when the test finishes, including after assertion failures. */
export function registerTempDir(t: TestContext, dir: string) {
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// Directories made by trackedMkdtemp, removed when the test file ends. The hook is registered while
// this module loads, so it belongs to the file's root test rather than to the test that first made a
// directory (a directory shared by several tests must outlive the first of them).
const tracked = new Set<string>();
after(() => {
  for (const dir of tracked) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** fs.mkdtempSync that removes the directory when the test file finishes, pass or fail. */
export function trackedMkdtemp(prefix: string): string {
  const dir = fs.mkdtempSync(prefix);
  tracked.add(dir);
  return dir;
}
