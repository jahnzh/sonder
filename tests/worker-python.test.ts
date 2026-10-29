import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The worker's deadline logic is plain Python so it can be tested without fastapi or aeneas.
const available = spawnSync("python3", ["--version"]).status === 0;
test("worker deadline tests pass", { skip: !available && "python3 is not installed", timeout: 120000 }, () => {
  const run = spawnSync(
    "python3",
    ["-B", "-m", "unittest", "discover", "-s", "tests/worker"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
});
