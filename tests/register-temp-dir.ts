import fs from "node:fs";
import type { TestContext } from "node:test";

/** Remove a mkdtemp directory when the test finishes, including after assertion failures. */
export function registerTempDir(t: TestContext, dir: string) {
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
