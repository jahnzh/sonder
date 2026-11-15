// scripts/ctc-worker-install-helper.py: worker.env parsed the way systemd's EnvironmentFile= reads it, merged
// without losing lines, and /health answers judged for the installer (#411).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

  // A bare CR ends a line too: systemd 255 gave CR_A=1, CR_B=two words, CR_C=3 for this file.
  const crOnly = join(dir, "cr.env");
  writeFileSync(crOnly, "CR_A=1\rCR_B=\"two words\"\rCR_C=3");
  for (const [key, value] of [["CR_A", "1"], ["CR_B", "two words"], ["CR_C", "3"]]) {
    assert.equal(helperRun(["env-get", crOnly, key]).stdout, value, key);
  }
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
  assert.equal(merged, "ALIGNMENT_WORKER_SLOTS=4\nALIGNMENT_WORKER_TOKEN=\"t o\\\"k\\$\"\n# keep me\r\nMEDIA_ROOT='/srv/a b'\r\nX=1");
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
  const good = { ready: true, revision: "abc", mediaRoot: media, busy: false, stuck: false,
    ctc: { engine: "ctc-x", ready: true, device: "cuda", precision: "float16" } };
  const check = (value) => {
    writeFileSync(body, JSON.stringify(value));
    return helperRun(["health-check", "200", body, "ctc-x", "cuda", "abc", media]);
  };
  assert.equal(check(good).status, 0);
  // "-" checks no revision: the worker before #411 reports none.
  writeFileSync(body, JSON.stringify({ ...good, revision: undefined }));
  assert.equal(helperRun(["health-check", "200", body, "ctc-x", "cuda", "-", media]).status, 0);
  for (const [value, reason] of [
    [{ ...good, ready: false }, /not ready/],
    [{ ...good, ctc: { ...good.ctc, engine: "aeneas-1.7.3" } }, /engine aeneas-1\.7\.3, expected ctc-x/],
    [{ ...good, ctc: { ...good.ctc, ready: false } }, /CTC model is not ready/],
    [{ ...good, ctc: { ...good.ctc, device: "cpu" } }, /on cpu\/float16, expected cuda\/float16/],
    [{ ...good, ctc: { ...good.ctc, precision: "float32" } }, /on cuda\/float32, expected cuda\/float16/],
    [{ ...good, mediaRoot: "relative" }, /no absolute media root/],
    [{ ...good, busy: 0 }, /no busy\/stuck state/],
    [{ ...good, stuck: undefined }, /no busy\/stuck state/],
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
  assert.match(body.audio, /^\/srv\/media\/alignment\/\.install-check-[0-9a-f]{32}\.wav$/);
  assert.ok(body.output.startsWith("/srv/media/alignment/"));
  assert.ok(body.fragments.length >= 1 && body.windows.length >= 1);
});

// Review round 1 of #411 (artifacts/orca/review-411-round1.md).

// The bookJobs object of worker/align.py's /health (#402): `jobs` is len(book_jobs.keys()), `slotsHeld` the
// gate's background batches, `resuming` a bool while retained jobs are picked up.
const LIVE_IDLE = { ready: true, engine: "aeneas-1.7.3", busy: false, stuck: false, busySeconds: null, lastTimeout: null,
  slots: 8, activeRequests: 0, mediaRoot: "/home/jahn/sonder-ctc-worker/media", revision: "abc",
  ctc: { engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-v2", ready: true, device: "cuda", precision: "float16",
    anchorReady: true, passageReady: true, anchorBatch: true },
  bookJobs: { engine: "ctc-book-v1", ready: true, jobs: 0, resuming: false, slotsHeld: 0, batchSeconds: null,
    stuck: [], diskReservedBytes: 0, diskBudgetBytes: 1000 } };

test("health-idle (HIGH 1): whole-book work is busy; bookJobs absent is a worker from before #402", (t) => {
  const dir = scratch(t);
  const body = join(dir, "health.json");
  const { bookJobs, ...beforeBookJobs } = LIVE_IDLE;
  const cases = [
    ["idle with bookJobs", LIVE_IDLE, 0],
    ["no bookJobs (before #402)", beforeBookJobs, 0],
    ["a book job", { ...LIVE_IDLE, bookJobs: { ...bookJobs, jobs: 2 } }, 3],
    ["a held slot", { ...LIVE_IDLE, bookJobs: { ...bookJobs, slotsHeld: 1 } }, 3],
    ["resuming", { ...LIVE_IDLE, bookJobs: { ...bookJobs, resuming: true } }, 3],
    ["bookJobs null", { ...LIVE_IDLE, bookJobs: null }, 4],
    ["bookJobs a list", { ...LIVE_IDLE, bookJobs: [] }, 4],
    ["jobs a string", { ...LIVE_IDLE, bookJobs: { ...bookJobs, jobs: "0" } }, 4],
    ["jobs a bool", { ...LIVE_IDLE, bookJobs: { ...bookJobs, jobs: false } }, 4],
    ["jobs a list", { ...LIVE_IDLE, bookJobs: { ...bookJobs, jobs: [] } }, 4],
    ["no slotsHeld", { ...LIVE_IDLE, bookJobs: { ...bookJobs, slotsHeld: undefined } }, 4],
    ["slotsHeld negative", { ...LIVE_IDLE, bookJobs: { ...bookJobs, slotsHeld: -1 } }, 4],
    ["resuming 0", { ...LIVE_IDLE, bookJobs: { ...bookJobs, resuming: 0 } }, 4],
    ["no resuming", { ...LIVE_IDLE, bookJobs: { ...bookJobs, resuming: undefined } }, 4],
  ];
  for (const [label, value, code] of cases) {
    writeFileSync(body, JSON.stringify(value));
    const result = helperRun(["health-idle", "200", body]);
    assert.equal(result.status, code, `${label}: ${result.stdout}`);
  }
  writeFileSync(body, JSON.stringify({ ...LIVE_IDLE, bookJobs: { ...bookJobs, jobs: 1, slotsHeld: 1 } }));
  assert.match(helperRun(["health-idle", "200", body]).stdout, /bookJobs\.jobs=1 bookJobs\.slotsHeld=1 bookJobs\.resuming=false/);
});

test("health-idle (HIGH 2): busy and stuck are JSON booleans and activeRequests a JSON integer, exactly", (t) => {
  const dir = scratch(t);
  const body = join(dir, "health.json");
  for (const [label, text] of [
    ["busy 0", '{"activeRequests":0,"busy":0,"stuck":false}'],
    ["stuck 0", '{"activeRequests":0,"busy":false,"stuck":0}'],
    ["both 0", '{"activeRequests":0,"busy":0,"stuck":0}'],
    ["busy 1", '{"activeRequests":0,"busy":1,"stuck":false}'],
    ["busy 0.0", '{"activeRequests":0,"busy":0.0,"stuck":false}'],
    ["busy null", '{"activeRequests":0,"busy":null,"stuck":false}'],
    ["activeRequests 0.0", '{"activeRequests":0.0,"busy":false,"stuck":false}'],
    ["activeRequests false", '{"activeRequests":false,"busy":false,"stuck":false}'],
  ]) {
    writeFileSync(body, text);
    assert.equal(helperRun(["health-idle", "200", body]).status, 4, label);
  }
  writeFileSync(body, '{"activeRequests":0,"busy":false,"stuck":false}');
  assert.equal(helperRun(["health-idle", "200", body]).status, 0);
});

test("auth-body (MEDIUM 2): a new random audio and output name on every run, under the media root's alignment folder", () => {
  const bodies = [0, 1, 2].map(() => JSON.parse(helperRun(["auth-body", "/srv/media"], { input: "t" }).stdout));
  const audios = new Set(bodies.map((body) => body.audio));
  const outputs = new Set(bodies.map((body) => body.output));
  assert.equal(audios.size, 3);
  assert.equal(outputs.size, 3);
  for (const body of bodies) {
    assert.match(body.audio, /^\/srv\/media\/alignment\/\.install-check-[0-9a-f]{32}\.wav$/);
    assert.match(body.output, /^\/srv\/media\/alignment\/\.install-check-[0-9a-f]{32}\.json$/);
  }
});

test("env-merge (MEDIUM 3): a changed or added key never alters an unrelated last line without a terminator", (t) => {
  const dir = scratch(t);
  const file = join(dir, "worker.env");
  const out = join(dir, "next");
  for (const [label, text, expected] of [
    ["added key, unterminated comment", "MEDIA_ROOT=/srv\n# operator comment",
      "ALIGNMENT_WORKER_SLOTS=4\nMEDIA_ROOT=/srv\n# operator comment"],
    ["changed key, unterminated assignment", "ALIGNMENT_WORKER_SLOTS=2\r\nX=1",
      "ALIGNMENT_WORKER_SLOTS=4\nX=1"],
    ["changed last line itself", "X=1\nALIGNMENT_WORKER_SLOTS=2",
      "ALIGNMENT_WORKER_SLOTS=4\nX=1\n"],
    ["empty file", "", "ALIGNMENT_WORKER_SLOTS=4\n"],
  ]) {
    writeFileSync(file, text);
    const result = helperRun(["env-merge", file, out], { env: { CTC_SET_ALIGNMENT_WORKER_SLOTS: "4" } });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(readFileSync(out, "utf8"), expected, label);
  }
});

test("unit-names (BLOCKING 1): the first deletion path a unit names, through %h and symlinks", (t) => {
  const dir = scratch(t);
  const home = join(dir, "home");
  const target = join(home, "w");
  mkdirSync(join(target, "releases", "r1", "worker"), { recursive: true });
  mkdirSync(join(target, "envs", "e1", "bin"), { recursive: true });
  mkdirSync(join(target, "worker"), { recursive: true });
  symlinkSync("../../envs/e1", join(target, "releases", "r1", "env"));
  symlinkSync("releases/r1", join(target, "current"));
  const unit = join(dir, "unit");
  const names = (text, paths) => {
    writeFileSync(unit, text);
    const result = helperRun(["unit-names", unit, home, ...paths]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const legacy = "[Service]\nWorkingDirectory=%h/w/worker\nEnvironmentFile=-%h/w/worker.env\nExecStart=/usr/bin/nice -n 10 %h/w/env/bin/python -m x\n";
  assert.equal(names(legacy, [join(target, "releases", "r0"), join(target, "worker"), join(target, "env")]), join(target, "worker"));
  assert.equal(names(legacy, [join(target, "env")]), join(target, "env"));
  assert.equal(names(legacy, [join(target, "work")]), "", "a name prefix is not a path prefix");
  // Through the release's env link and through `current`, the unit names envs/e1 and releases/r1.
  const viaLinks = "[Service]\nWorkingDirectory=%h/w/current/worker\nExecStart=%h/w/releases/r1/env/bin/python\n";
  assert.equal(names(viaLinks, [join(target, "envs", "e1")]), join(target, "envs", "e1"));
  assert.equal(names(viaLinks, [join(target, "releases", "r1")]), join(target, "releases", "r1"));
  // A symlink on the deletion list is removed as a link: its target is not what it names.
  assert.equal(names("[Service]\nWorkingDirectory=%h/w/releases/r1/worker\n", [join(target, "current")]), "");
  assert.equal(names("# WorkingDirectory=%h/w/worker\n[Service]\n", [join(target, "worker")]), "", "comments name nothing");
});
