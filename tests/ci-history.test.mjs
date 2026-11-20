import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(repoRoot, "scripts", "lib", "ci-history.sh");

function runHelper(body, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-history-"));
  const script = join(dir, "run.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -uo pipefail
ROOT=${JSON.stringify(repoRoot)}
LOCAL_REPORT_DIR=${JSON.stringify(join(dir, "report"))}
source "$ROOT/scripts/lib/ci-history.sh"
log() { echo "[log] $*"; }
${body}
`,
  );
  chmodSync(script, 0o755);
  mkdirSync(join(dir, "report"), { recursive: true });
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: process.env.PATH },
  });
  return { dir, status: result.status, out: result.stdout + result.stderr, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("history_check_result maps a failed report result to fail", () => {
  const r = runHelper(`
RESULT=passed
echo '{"ok":false,"result":"failed"}' >"$LOCAL_REPORT_DIR/report.json"
history_check_result
`);
  try {
    assert.equal(r.status, 0, r.out);
    assert.match(r.out.trim().split("\n").at(-1), /^fail$/);
  } finally {
    r.cleanup();
  }
});

test("history_check_result falls back to the shell RESULT when the report is missing", () => {
  const fail = runHelper(`
RESULT=remote_check_failed
history_check_result
`);
  try {
    assert.equal(fail.status, 0, fail.out);
    assert.match(fail.out.trim().split("\n").at(-1), /^fail$/);
  } finally {
    fail.cleanup();
  }

  const pass = runHelper(`
RESULT=passed
history_check_result
`);
  try {
    assert.equal(pass.status, 0, pass.out);
    assert.match(pass.out.trim().split("\n").at(-1), /^pass$/);
  } finally {
    pass.cleanup();
  }
});

test("history_check_result: ok:true without result and RESULT failed gives fail", () => {
  const r = runHelper(`
RESULT=failed
echo '{"ok":true}' >"$LOCAL_REPORT_DIR/report.json"
history_check_result
`);
  try {
    assert.equal(r.status, 0, r.out);
    assert.match(r.out.trim().split("\n").at(-1), /^fail$/);
  } finally {
    r.cleanup();
  }
});

test("history_check_result is pass_with_known_failures only when the report says so", () => {
  const known = runHelper(`
RESULT=passed
echo '{"ok":true,"result":"passed_with_known_failures"}' >"$LOCAL_REPORT_DIR/report.json"
history_check_result
`);
  try {
    assert.equal(known.status, 0, known.out);
    assert.match(known.out.trim().split("\n").at(-1), /^pass_with_known_failures$/);
  } finally {
    known.cleanup();
  }

  const plain = runHelper(`
RESULT=passed
echo '{"ok":true}' >"$LOCAL_REPORT_DIR/report.json"
history_check_result
`);
  try {
    assert.equal(plain.status, 0, plain.out);
    assert.match(plain.out.trim().split("\n").at(-1), /^pass$/);
    assert.doesNotMatch(plain.out, /pass_with_known_failures/);
  } finally {
    plain.cleanup();
  }
});

test("history_check_result is pass_with_flaky when the report passed on failures that passed alone (#792)", () => {
  const flaky = runHelper(`
RESULT=passed
echo '{"ok":true,"result":"passed_with_flaky"}' >"$LOCAL_REPORT_DIR/report.json"
history_check_result
`);
  try {
    assert.equal(flaky.status, 0, flaky.out);
    assert.match(flaky.out.trim().split("\n").at(-1), /^pass_with_flaky$/);
  } finally {
    flaky.cleanup();
  }
});

test("a dispatch id with shell metacharacters is rejected by requireId, no command run, exit unchanged, one warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-history-meta-"));
  const historyLog = join(dir, "history.log");
  const historyStub = join(dir, "history-stub.mjs");
  writeFileSync(
    historyStub,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(historyLog)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  const script = join(dir, "run.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -uo pipefail
ROOT=${JSON.stringify(repoRoot)}
LOCAL_REPORT_DIR=${JSON.stringify(join(dir, "report"))}
FULL_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RESULT=passed
ORCA_HISTORY_SCRIPT=${JSON.stringify(historyStub)}
SONDER_CI_DISPATCH='ctx_$(rm -rf /);evil'
source "$ROOT/scripts/lib/ci-history.sh"
log() { echo "[log] $*"; }
record_history_check ci:deck
exit 0
`,
  );
  chmodSync(script, 0o755);
  mkdirSync(join(dir, "report"), { recursive: true });
  try {
    assert.ok(existsSync(helper), "shared helper must exist");
    const result = spawnSync("bash", [script], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const out = result.stdout + result.stderr;
    assert.match(out, /warning: SONDER_CI_DISPATCH is not a valid history id; skipping record-check/);
    assert.equal((out.match(/warning:/g) || []).length, 1);
    assert.equal(existsSync(historyLog), false, "history command must not run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
