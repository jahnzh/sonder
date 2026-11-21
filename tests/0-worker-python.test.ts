import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The worker's logic is plain Python so it can be tested without fastapi.
//
// Why this file's name starts with 0, and why it runs several Python processes (measured on lisa, 21 Nov 2026):
// lisa's Python has numpy, so the alignment tests of tests/worker/test_book_align.py run there (WSL's has not and
// skips them), and they take two minutes on one core. Node starts the test files in the order of their names, so as
// worker-python.test.ts this file started last, about 80 s into the unit stage, and the stage waited 140 s more for
// it: 220 s, of which the other 299 files needed 149. Now it starts first, and the classes of the heavy module each
// run in a process of their own beside one process for all the other modules, in their old order (several of those
// time things and failed when they were run side by side under load). Every test of every module still runs.
const available = spawnSync("python3", ["--version"]).status === 0;
const root = fileURLToPath(new URL("..", import.meta.url));
const workerTests = fileURLToPath(new URL("./worker/", import.meta.url));
const HEAVY = ["test_book_align"];
const modules = readdirSync(workerTests).filter((name) => /^test_.*\.py$/.test(name)).map((name) => name.slice(0, -3)).sort();

function python(args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    // The modules import the worker's code by their own path handling, as under `unittest discover -s tests/worker`.
    const child = spawn("python3", ["-B", ...args], { cwd: workerTests, env: { ...process.env, PYTHONPATH: workerTests } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ status: 1, output: String(error) }));
    child.on("close", (status) => resolve({ status, output }));
  });
}
const ran = (output: string) => Number(/^Ran (\d+) tests? in /m.exec(output)?.[1] ?? -1);

/** The test classes of a module, asked of Python itself so that a new class is run without a change here. */
function classesOf(module: string): string[] {
  const listed = spawnSync(
    "python3",
    ["-B", "-c", `import unittest, ${module} as m\nprint("\\n".join(sorted(n for n, c in vars(m).items() if isinstance(c, type) and issubclass(c, unittest.TestCase))))`],
    { cwd: workerTests, encoding: "utf8", env: { ...process.env, PYTHONPATH: workerTests } },
  );
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.trim().split("\n").filter(Boolean);
}

describe("worker deadline tests pass", { concurrency: true, skip: !available && "python3 is not installed" }, () => {
  const light = modules.filter((module) => !HEAVY.includes(module));
  test("every Python test module is run: the heavy ones by class, the others together", () => {
    assert.ok(modules.length >= 19, `tests/worker has ${modules.length} test modules`);
    for (const module of HEAVY) assert.ok(modules.includes(module), `${module} is a module of tests/worker`);
    assert.deepEqual([...light, ...HEAVY].sort(), modules);
  });
  test(`the ${light.length} other modules, one after another in one process`, { timeout: 600000 }, async () => {
    const run = await python(["-m", "unittest", ...light]);
    assert.equal(run.status, 0, run.output);
    assert.ok(ran(run.output) > 0, run.output);
  });
  for (const module of HEAVY) {
    // Counted once in one process (collection only), so the classes' runs can be held to the module's whole count.
    const classes = available ? classesOf(module) : [];
    const counts: number[] = [];
    for (const name of classes) {
      test(`${module}.${name}`, { timeout: 600000 }, async () => {
        const run = await python(["-m", "unittest", `${module}.${name}`]);
        assert.equal(run.status, 0, run.output);
        counts.push(ran(run.output));
      });
    }
    test(`${module}: its classes together are all of its tests`, { timeout: 600000 }, async () => {
      const whole = await python(["-c", `import unittest, ${module}\nprint(unittest.defaultTestLoader.loadTestsFromModule(${module}).countTestCases())`]);
      assert.equal(whole.status, 0, whole.output);
      // Wait for the classes' runs, which go on beside this test.
      while (counts.length < classes.length) await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(counts.reduce((sum, count) => sum + count, 0), Number(whole.output.trim()), `${classes.join(", ")}: ${counts.join(" + ")}`);
    });
  }
});
