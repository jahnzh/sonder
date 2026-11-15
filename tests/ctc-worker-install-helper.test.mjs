// scripts/ctc-worker-install-helper.py: worker.env parsed the way systemd's EnvironmentFile= reads it, merged
// without losing lines, and /health answers judged for the installer (#411).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(repoRoot, "scripts", "ctc-worker-install-helper.py");

function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-ctc-helper-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function helperRun(args, { env = {}, input } = {}) {
  return spawnSync("python3", [helper, ...args], { encoding: "utf8", input, env: { ...process.env, ...env } });
}

// Captured on 2026-11-15 with systemd 255 (255.4-1ubuntu8.18): this file was passed as EnvironmentFile= to
// `systemd-run --user --pipe --wait -p EnvironmentFile=<file> /usr/bin/env`, which printed SYSTEMD_255 below.
const EDGE_FILE = "A_PLAIN=one\r\nMEDIA_ROOT=\"/srv/sonder media\"\r\n# comment \\\nB_AFTER_COMMENT=x\n"
  + "  C_SPACED = spaced value   \nD_SQ='single $x \"q\"'\nE_DQ=\"a\\\"b\\\\c\\$d\\ne\"\nF_CONT=first\\\nsecond\n"
  + "export G_EXP=1\nH_MIX=\"x\"y'z'\n1BAD=no\nI_LAST=1\nI_LAST=2\nJ_EMPTY=\nK_TRAIL=v  # not comment\nL_NOEOL=end";
const SYSTEMD_255 = {
  A_PLAIN: "one",
  MEDIA_ROOT: "/srv/sonder media",
  B_AFTER_COMMENT: "x",
  C_SPACED: "spaced value",
  D_SQ: "single $x \"q\"",
  E_DQ: "a\"b\\c$d\\ne",
  F_CONT: "firstsecond",
  H_MIX: "xy'z'",
  I_LAST: "2",
  J_EMPTY: "",
  K_TRAIL: "v  # not comment",
  L_NOEOL: "end",
};

test("env-get reads every value as systemd 255 does: quotes, CRLF, escapes, continuations, last assignment wins", (t) => {
  const dir = scratch(t);
  const file = join(dir, "edge.env");
  writeFileSync(file, EDGE_FILE);
  for (const [key, value] of Object.entries(SYSTEMD_255)) {
    const result = helperRun(["env-get", file, key]);
    assert.equal(result.status, 0, `${key}: ${result.stderr}`);
    assert.equal(result.stdout, value, key);
  }
  for (const key of ["G_EXP", "export G_EXP", "1BAD", "MISSING"]) {
    assert.equal(helperRun(["env-get", file, key]).status, 1, `${key} is not set for systemd either`);
  }
  assert.equal(helperRun(["env-get", join(dir, "absent.env"), "A_PLAIN"]).status, 1);
});

test("env-merge keeps a file it does not need to change byte for byte, missing final newline included", (t) => {
  const dir = scratch(t);
  const file = join(dir, "worker.env");
  writeFileSync(file, EDGE_FILE);
  const out = join(dir, "worker.env.next");
  const result = helperRun(["env-merge", file, out], { env: { CTC_SET_A_PLAIN: "one", CTC_DEFAULT_MEDIA_ROOT: "/other" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(out, "utf8"), EDGE_FILE);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.match(result.stdout, /^kept A_PLAIN$/m);
  assert.match(result.stdout, /^kept MEDIA_ROOT$/m);
  assert.match(result.stdout, /^kept F_CONT$/m);
});

test("env-merge replaces only the assignments of a changed key, including one spanning lines, and proves the result", (t) => {
  const dir = scratch(t);
  const file = join(dir, "worker.env");
  writeFileSync(file, "# keep me\r\nALIGNMENT_WORKER_SLOTS=\"2\r\n\"\r\nMEDIA_ROOT='/srv/a b'\r\nALIGNMENT_WORKER_SLOTS=3\r\nX=1");
  const out = join(dir, "next");
  const result = helperRun(["env-merge", file, out], {
    env: { CTC_SET_ALIGNMENT_WORKER_SLOTS: "4", CTC_SET_ALIGNMENT_WORKER_TOKEN: "t o\"k$" },
  });
  assert.equal(result.status, 0, result.stderr);
  const merged = readFileSync(out, "utf8");
  assert.equal(merged, "# keep me\r\nMEDIA_ROOT='/srv/a b'\r\nX=1\nALIGNMENT_WORKER_SLOTS=4\nALIGNMENT_WORKER_TOKEN=\"t o\\\"k\\$\"\n");
  for (const [key, value] of [["MEDIA_ROOT", "/srv/a b"], ["X", "1"], ["ALIGNMENT_WORKER_SLOTS", "4"],
    ["ALIGNMENT_WORKER_TOKEN", "t o\"k$"]]) {
    assert.equal(helperRun(["env-get", out, key]).stdout, value, key);
  }
  assert.match(result.stdout, /^changed ALIGNMENT_WORKER_SLOTS$/m);
  assert.match(result.stdout, /^added ALIGNMENT_WORKER_TOKEN$/m);
  assert.ok(!result.stdout.includes("t o"), "values are not printed");
});

test("env-merge refuses to edit a line it shares with an assignment it keeps", (t) => {
  const dir = scratch(t);
  const file = join(dir, "worker.env");
  writeFileSync(file, "A=1\rALIGNMENT_WORKER_SLOTS=2\n");
  const result = helperRun(["env-merge", file, join(dir, "next")], { env: { CTC_SET_ALIGNMENT_WORKER_SLOTS: "4" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /edit it by hand/);
});

test("health-idle is idle only on a valid answer with no request, busy or stuck task", (t) => {
  const dir = scratch(t);
  const body = join(dir, "health.json");
  // The live WSL answer of 2026-11-15 (docs/LOCAL_CHECKS.md, tests/image-smoke.test.mjs).
  const live = { ready: true, engine: "aeneas-1.7.3", busy: false, stuck: false, busySeconds: null, lastTimeout: null,
    slots: 8, activeRequests: 0, mediaRoot: "/home/jahn/sonder-ctc-worker/media",
    ctc: { engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-v2", ready: true, device: "cuda", precision: "float16",
      anchorReady: true, passageReady: true, anchorBatch: true } };
  const cases = [
    ["200", live, 0],
    ["200", { ...live, activeRequests: 1, busy: true }, 3],
    ["200", { ...live, stuck: true }, 3],
    ["200", { ...live, busy: true }, 3],
    ["200", { ...live, activeRequests: undefined }, 4],
    ["200", { ...live, activeRequests: true }, 4],
    ["200", { ...live, activeRequests: -1 }, 4],
    ["200", { ...live, busy: "no" }, 4],
    ["503", live, 4],
    ["000", null, 4],
  ];
  for (const [status, value, code] of cases) {
    writeFileSync(body, value === null ? "" : JSON.stringify(value));
    assert.equal(helperRun(["health-idle", status, body]).status, code, `${status} ${JSON.stringify(value)}`);
  }
  writeFileSync(body, "not json");
  assert.equal(helperRun(["health-idle", "200", body]).status, 4);
});

test("health-check names the first difference from the expected worker", (t) => {
  const dir = scratch(t);
  const body = join(dir, "health.json");
  const media = join(dir, "media");
  const good = { ready: true, revision: "abc", mediaRoot: media,
    ctc: { engine: "ctc-x", ready: true, device: "cuda" } };
  const check = (value) => {
    writeFileSync(body, JSON.stringify(value));
    return helperRun(["health-check", "200", body, "ctc-x", "cuda", "abc", media]);
  };
  assert.equal(check(good).status, 0);
  for (const [value, reason] of [
    [{ ...good, ready: false }, /not ready/],
    [{ ...good, ctc: { ...good.ctc, engine: "aeneas-1.7.3" } }, /engine aeneas-1\.7\.3, expected ctc-x/],
    [{ ...good, ctc: { ...good.ctc, ready: false } }, /CTC model is not ready/],
    [{ ...good, ctc: { ...good.ctc, device: "cpu" } }, /on cpu, expected cuda/],
    [{ ...good, revision: undefined }, /revision None, expected abc/],
    [{ ...good, mediaRoot: "/x" }, /media root \/x/],
  ]) {
    const result = check(value);
    assert.equal(result.status, 1);
    assert.match(result.stdout, reason);
  }
});

test("auth-body reads the token on stdin and names audio that cannot exist", () => {
  const result = helperRun(["auth-body", "/srv/media"], { input: "secret-token" });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.token, "secret-token");
  assert.equal(body.audio, "/srv/media/alignment/.install-check-missing.wav");
  assert.ok(body.output.startsWith("/srv/media/alignment/"));
  assert.ok(body.fragments.length >= 1 && body.windows.length >= 1);
});
