import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "ci-result.sh");
const fixtures = path.join(repoRoot, "tests", "fixtures");

function run(args) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8", cwd: repoRoot });
}

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-result-"));
  const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const older = path.join(dir, "artifacts", "ci", shaA, "run-old");
  const newer = path.join(dir, "artifacts", "ci", shaA, "run-new");
  const other = path.join(dir, "artifacts", "ci", shaB, "run-b");
  for (const p of [older, newer, other]) fs.mkdirSync(p, { recursive: true });
  return { dir, shaA, shaB, older, newer, other };
}

function copyPassed(runDir) {
  fs.copyFileSync(path.join(fixtures, "ci-deck-result.txt"), path.join(runDir, "ci-deck-result.txt"));
  fs.copyFileSync(path.join(fixtures, "check-report.json"), path.join(runDir, "check-report.json"));
}

function copyFailed(runDir) {
  fs.copyFileSync(path.join(fixtures, "ci-deck-result-failed.txt"), path.join(runDir, "ci-deck-result.txt"));
  fs.copyFileSync(
    path.join(fixtures, "check-report-with-new-failure.json"),
    path.join(runDir, "check-report.json"),
  );
}

test("usage exit 2 when called with no args", () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test("exits 3 and prints running when the result file is missing", () => {
  const t = makeTree();
  try {
    fs.copyFileSync(path.join(fixtures, "check-report.json"), path.join(t.newer, "check-report.json"));
    // Only one unfinished run for this sha (delete the empty older sibling).
    fs.rmSync(t.older, { recursive: true, force: true });
    fs.rmSync(t.other, { recursive: true, force: true });
    const r = run([t.dir, "aaa"]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /result=running/);
    assert.match(r.stdout, /run_dir=/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("prints every matching run for one sha with host and result", () => {
  const t = makeTree();
  try {
    copyPassed(t.older);
    copyPassed(t.newer);
    copyPassed(t.other);
    // Older deck run + newer WSL run for the same sha.
    fs.writeFileSync(
      path.join(t.older, "ci-deck-result.txt"),
      "mode=remote\nhost=deck@steamdeck\ncommit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nexit_code=0\nresult=passed\n",
    );
    fs.writeFileSync(
      path.join(t.newer, "ci-ssh-result.txt"),
      "mode=remote\nhost=192.168.1.119\ncommit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nexit_code=0\nresult=passed\n",
    );
    fs.rmSync(path.join(t.newer, "ci-deck-result.txt"), { force: true });
    const oldTime = new Date(Date.now() - 60_000);
    const newTime = new Date();
    fs.utimesSync(t.older, oldTime, oldTime);
    fs.utimesSync(t.other, oldTime, oldTime);
    fs.utimesSync(t.newer, newTime, newTime);

    const r = run([t.dir, "aaa"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /host=192\.168\.1\.119 result=passed run_dir=.*run-new/);
    assert.match(r.stdout, /host=deck@steamdeck result=passed run_dir=.*run-old/);
    assert.doesNotMatch(r.stdout, /run-b/, "sha-prefix aaa excludes bbb");
    assert.match(r.stdout, /knownFailures\.summary=passed_with_known_failures: 4 known failures \(4 environment\), 0 new/);
    assert.match(r.stdout, /new failures: 0/);
    assert.match(r.stdout, /slowest browser tests:/);
    assert.match(r.stdout, /41\.2s chromium tests\/e2e\/device-reset\.spec\.ts/);
    assert.doesNotMatch(r.stdout, /settings\.spec\.ts/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("--host deck keeps only Deck runs; --host wsl keeps only WSL runs", () => {
  const t = makeTree();
  try {
    copyPassed(t.older);
    copyPassed(t.newer);
    fs.writeFileSync(
      path.join(t.older, "ci-deck-result.txt"),
      "mode=remote\nhost=deck@steamdeck\ncommit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nexit_code=0\nresult=passed\n",
    );
    fs.writeFileSync(
      path.join(t.newer, "ci-ssh-result.txt"),
      "mode=remote\nhost=192.168.1.119\ncommit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nexit_code=0\nresult=passed\n",
    );
    fs.rmSync(path.join(t.newer, "ci-deck-result.txt"), { force: true });

    const deck = run(["--host", "deck", t.dir, "aaa"]);
    assert.equal(deck.status, 0, deck.stdout + deck.stderr);
    assert.match(deck.stdout, /host=deck@steamdeck result=passed/);
    assert.doesNotMatch(deck.stdout, /192\.168\.1\.119/);

    const wsl = run(["--host", "wsl", t.dir, "aaa"]);
    assert.equal(wsl.status, 0, wsl.stdout + wsl.stderr);
    assert.match(wsl.stdout, /host=192\.168\.1\.119 result=passed/);
    assert.doesNotMatch(wsl.stdout, /deck@steamdeck/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("accepts a run directory directly", () => {
  const t = makeTree();
  try {
    copyPassed(t.newer);
    const r = run([t.newer]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /result=passed/);
    assert.doesNotMatch(r.stderr, /using newest/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("prints each new failure as project file title: first line of message and exits 1", () => {
  const t = makeTree();
  try {
    copyFailed(t.newer);
    const r = run([t.newer]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /result=failed/);
    assert.match(
      r.stdout,
      /chromium tests\/e2e\/example\.spec\.ts fails newly: Error: expected 1 to equal 2/,
    );
    assert.doesNotMatch(r.stdout, /at Object\.<anonymous>/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("exits 1 when result=passed but check-report has new failures", () => {
  const t = makeTree();
  try {
    // Deck said passed, but the report still lists a new failure — not green.
    fs.copyFileSync(path.join(fixtures, "ci-deck-result.txt"), path.join(t.newer, "ci-deck-result.txt"));
    fs.copyFileSync(
      path.join(fixtures, "check-report-with-new-failure.json"),
      path.join(t.newer, "check-report.json"),
    );
    const r = run([t.newer]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /result=passed/);
    assert.match(r.stdout, /fails newly/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("fixture ci-deck-result.txt matches a real Deck sample shape", () => {
  const text = fs.readFileSync(path.join(fixtures, "ci-deck-result.txt"), "utf8");
  assert.match(text, /^mode=remote$/m);
  assert.match(text, /^commit=[0-9a-f]{40}$/m);
  assert.match(text, /^exit_code=\d+$/m);
  assert.match(text, /^result=passed$/m);
});

test("fixture check-report.json keeps the real knownFailures.summary field", () => {
  const report = JSON.parse(fs.readFileSync(path.join(fixtures, "check-report.json"), "utf8"));
  assert.match(report.knownFailures.summary, /known failures/);
  assert.ok(Array.isArray(report.knownFailures.new));
  assert.ok(Array.isArray(report.browserSlowestTests));
  assert.equal(report.browserSlowestTests[0].durationMs, 41234);
});

test("--help prints the usage on stdout and exits 0", () => {
  const script = fileURLToPath(new URL("../scripts/ci-result.sh", import.meta.url));
  for (const flag of ["--help", "-h"]) {
    const result = spawnSync("bash", [script, flag], { encoding: "utf8" });
    assert.equal(result.status, 0, flag);
    assert.match(result.stdout, /usage: scripts\/ci-result\.sh/);
    assert.match(result.stdout, /--host deck\|wsl/);
  }
});

test("refuses an unknown --host value", () => {
  const r = run(["--host", "laptop", "."]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /deck or wsl/);
});
