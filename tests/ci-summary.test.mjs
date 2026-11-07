import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "ci-summary.sh");
const fixtures = path.join(repoRoot, "tests", "fixtures");

function run(args, options = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    ...options,
  });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-summary-test-"));
}

test("usage and help flag -h and --help print usage and exit 0", () => {
  for (const flag of ["-h", "--help"]) {
    const res = run([flag]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /usage: scripts\/ci-summary\.sh/);
  }
});

test("refuses missing argument or non-existent path with exit 2", () => {
  const missing = run(["/path/that/does/not/exist"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /artifact directory not found/);
});

test("recorded passed report: prints under 30 lines with commit, host, stages with status, and browser failures", () => {
  const tmp = makeTempDir();
  try {
    fs.copyFileSync(path.join(fixtures, "ci-deck-result.txt"), path.join(tmp, "ci-deck-result.txt"));
    fs.copyFileSync(path.join(fixtures, "check-report.json"), path.join(tmp, "check-report.json"));

    const res = run([tmp]);
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const lines = res.stdout.trim().split("\n");
    assert.ok(lines.length < 30, `expected under 30 lines, got ${lines.length}`);

    // Commit
    assert.match(res.stdout, /commit:\s+[0-9a-f]{40}/);

    // Host
    assert.match(res.stdout, /host:\s+deck@steamdeck/);

    // Stages with status
    assert.match(res.stdout, /stages:/);
    assert.match(res.stdout, /install:\s+passed/);
    assert.match(res.stdout, /build:\s+passed/);
    assert.match(res.stdout, /unit:\s+passed/);
    assert.match(res.stdout, /browser:\s+passed/);

    // Known browser failure from check-report.json fixture (issue 37)
    assert.match(res.stdout, /new browser failures:\s+0/);
    assert.match(res.stdout, /known browser failures \(1\):/);
    assert.match(
      res.stdout,
      /webkit tests\/e2e\/device-reset\.spec\.ts reset refreshes the app shell while preserving device data \(#37\)/,
    );

    // Unit stage did not fail, so no unit failure details
    assert.doesNotMatch(res.stdout, /unit failures/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("recorded unit-failed report: prints under 30 lines, stages with status, failing test names and first lines of errors", () => {
  const tmp = makeTempDir();
  try {
    fs.writeFileSync(
      path.join(tmp, "ci-ssh-result.txt"),
      "mode=remote\nhost=192.168.1.119\ncommit=cb9be24ee8384a55180916b46c6921195250a16e\nexit_code=1\nresult=remote_check_failed\n",
    );
    fs.copyFileSync(
      path.join(fixtures, "check-report-with-unit-failure.json"),
      path.join(tmp, "check-report.json"),
    );

    const res = run([tmp]);
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const lines = res.stdout.trim().split("\n");
    assert.ok(lines.length < 30, `expected under 30 lines, got ${lines.length}`);

    // Commit and Host
    assert.match(res.stdout, /commit:\s+cb9be24ee8384a55180916b46c6921195250a16e/);
    assert.match(res.stdout, /host:\s+192\.168\.1\.119/);

    // Stages with status
    assert.match(res.stdout, /unit:\s+failed/);
    assert.match(res.stdout, /browser:\s+skipped/);

    // Unit failures
    assert.match(res.stdout, /unit failures \(1\):/);
    assert.match(
      res.stdout,
      /a passing run boots the emulator for each browser, tunnels once and leaves it stopped/,
    );
    assert.match(
      res.stdout,
      /AssertionError \[ERR_ASSERTION\]: \[test-android\] Port 25565 is already in use on this machine\./,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("recorded browser-failed report: prints under 30 lines, stages, new and known browser failures with project, file, title, issue", () => {
  const tmp = makeTempDir();
  try {
    fs.writeFileSync(
      path.join(tmp, "ci-ssh-result.txt"),
      "mode=remote\nhost=192.168.1.119\ncommit=f6fe50ff82ff2d125c186370c4e9e47ba5ffeefa\nexit_code=1\nresult=remote_check_failed\n",
    );
    fs.copyFileSync(
      path.join(fixtures, "check-report-with-new-failure.json"),
      path.join(tmp, "check-report.json"),
    );

    const res = run([tmp]);
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const lines = res.stdout.trim().split("\n");
    assert.ok(lines.length < 30, `expected under 30 lines, got ${lines.length}`);

    // Commit and Host
    assert.match(res.stdout, /commit:\s+f6fe50ff82ff2d125c186370c4e9e47ba5ffeefa/);
    assert.match(res.stdout, /host:\s+192\.168\.1\.119/);

    // Stages
    assert.match(res.stdout, /stages:/);
    assert.match(res.stdout, /browser:\s+failed/);

    // New browser failure (project, file, title)
    assert.match(res.stdout, /new browser failures \(1\):/);
    assert.match(res.stdout, /chromium tests\/e2e\/example\.spec\.ts fails newly/);

    // Known browser failure (project, file, title, issue)
    assert.match(res.stdout, /known browser failures \(1\):/);
    assert.match(
      res.stdout,
      /webkit tests\/e2e\/device-reset\.spec\.ts reset refreshes the app shell while preserving device data \(#37\)/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("works from the [ci-ssh] Artifacts: line of a log file", () => {
  const tmp = makeTempDir();
  const runDir = path.join(tmp, "run-12345");
  fs.mkdirSync(runDir, { recursive: true });
  try {
    fs.copyFileSync(path.join(fixtures, "ci-deck-result.txt"), path.join(runDir, "ci-deck-result.txt"));
    fs.copyFileSync(path.join(fixtures, "check-report.json"), path.join(runDir, "check-report.json"));

    const logFile = path.join(tmp, "ci.log");
    fs.writeFileSync(
      logFile,
      `[ci-ssh] Starting remote check\n[ci-ssh] Artifacts: ${runDir}\n[ci-ssh] Done\n`,
    );

    const res = run([logFile]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /commit:\s+[0-9a-f]{40}/);
    assert.match(res.stdout, /stages:/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("works from a raw [ci-ssh] Artifacts: line passed as argument string", () => {
  const tmp = makeTempDir();
  try {
    fs.copyFileSync(path.join(fixtures, "ci-deck-result.txt"), path.join(tmp, "ci-deck-result.txt"));
    fs.copyFileSync(path.join(fixtures, "check-report.json"), path.join(tmp, "check-report.json"));

    const res = run([`[ci-ssh] Artifacts: ${tmp}`]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /commit:\s+[0-9a-f]{40}/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("works from stdin containing the Artifacts: line", () => {
  const tmp = makeTempDir();
  try {
    fs.copyFileSync(path.join(fixtures, "ci-deck-result.txt"), path.join(tmp, "ci-deck-result.txt"));
    fs.copyFileSync(path.join(fixtures, "check-report.json"), path.join(tmp, "check-report.json"));

    const res = run(["-"], { input: `[ci-ssh] Artifacts: ${tmp}\n` });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /commit:\s+[0-9a-f]{40}/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("enforces under 30 lines guarantee even with many failures", () => {
  const tmp = makeTempDir();
  try {
    const manyNewFailures = [];
    for (let i = 0; i < 40; i++) {
      manyNewFailures.push({
        project: "chromium",
        file: `tests/e2e/test-${i}.spec.ts`,
        title: `test number ${i} fails`,
        message: `Error in test ${i}`,
      });
    }

    const report = {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ok: false,
      result: "failed",
      stages: [
        { name: "install", status: "passed" },
        { name: "build", status: "passed" },
        { name: "unit", status: "passed" },
        { name: "browser", status: "failed" },
      ],
      knownFailures: {
        summary: "failed",
        known: [],
        new: manyNewFailures,
      },
    };

    fs.writeFileSync(path.join(tmp, "check-report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(tmp, "ci-ssh-result.txt"),
      "mode=remote\nhost=192.168.1.119\ncommit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nexit_code=1\nresult=remote_check_failed\n",
    );

    const res = run([tmp]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const lines = res.stdout.trim().split("\n");
    assert.ok(lines.length < 30, `expected under 30 lines, got ${lines.length}`);
    assert.match(res.stdout, /truncated/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
