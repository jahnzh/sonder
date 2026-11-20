import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Never inherit git's own variables (a hook sets GIT_DIR and friends): the fixture must only touch its own repository.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, ...extra };
}

function stub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// A throwaway repository holding a copy of deploy.sh, a stubbed docker and curl, and live-check scripts that
// append their name (and any CLI arguments) to a log, so a test can see which checks ran.
// `healthTimes`: what the stubbed curl prints as the answer time of each request in turn, the last one for good;
// "fail" is a request that gets no answer.
function fixture(checks, { images = "sonder-audiobooks:rollback aaaaaaaaaaaa", tagFails = false, smokeFails = false, markerFails = false, markerFileFails = false, jobs = [], healthTimes = ["0.010"] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-deploy-")));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "data"));
  mkdirSync(bin);
  copyFileSync(join(repoRoot, "scripts", "deploy.sh"), join(repo, "scripts", "deploy.sh"));
  copyFileSync(join(repoRoot, "scripts", "deploy-prod.sh"), join(repo, "scripts", "deploy-prod.sh"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { backup: "cp" } }));
  const sqlite = new Database(join(repo, "data", "sonder.db"));
  sqlite.exec(`
    CREATE TABLE works(id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, description TEXT NOT NULL, genre TEXT NOT NULL, year INTEGER NOT NULL);
    CREATE TABLE audio_editions(id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), cover TEXT NOT NULL, narrator TEXT NOT NULL, rating REAL NOT NULL, source_label TEXT NOT NULL);
    CREATE TABLE recordings(id TEXT PRIMARY KEY, edition_id TEXT NOT NULL REFERENCES audio_editions(id));
    CREATE TABLE ebook_editions(id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), format TEXT NOT NULL, source TEXT NOT NULL);
    CREATE TABLE alignment_jobs(id TEXT PRIMARY KEY, ebook_id TEXT NOT NULL REFERENCES ebook_editions(id), recording_id TEXT NOT NULL REFERENCES recordings(id), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  for (const [i, job] of jobs.entries()) {
    const workId = job.workId ?? `work-${i}`;
    const audioEditionId = job.audioEditionId ?? `ae-${i}`;
    const ebookId = job.ebookId ?? `ee-${i}`;
    const format = job.format ?? "epub";
    sqlite.prepare("INSERT OR IGNORE INTO works VALUES (?, 'T', 'A', '', '', 2026)").run(workId);
    sqlite.prepare("INSERT OR IGNORE INTO audio_editions VALUES (?, ?, '', '', 0, '')").run(audioEditionId, workId);
    sqlite.prepare("INSERT OR IGNORE INTO recordings VALUES (?, ?)").run(job.recordingId, audioEditionId);
    sqlite.prepare("INSERT OR IGNORE INTO ebook_editions VALUES (?, ?, ?, '')").run(ebookId, job.ebookWorkId ?? workId, format);
    sqlite.prepare("INSERT INTO alignment_jobs VALUES (?, ?, ?, ?, ?)").run(
      job.id ?? `job-${i}`,
      ebookId,
      job.recordingId,
      JSON.stringify(job.data),
      job.updatedAt,
    );
  }
  sqlite.close();
  const log = join(dir, "ran.log");
  // A check is its exit code, or {exit, skip}: a check that writes `skip` to SONDER_LIVE_CHECK_SKIP_FILE before exiting,
  // as verify-integrated-reader.mjs does when no recording qualifies (#431).
  for (const [name, spec] of Object.entries(checks)) {
    const { exit, skip, logEnv } = typeof spec === "number" ? { exit: spec } : spec;
    const writeSkip = skip === undefined ? "" : `if(process.env.SONDER_LIVE_CHECK_SKIP_FILE)fs.writeFileSync(process.env.SONDER_LIVE_CHECK_SKIP_FILE, ${JSON.stringify(skip)});`;
    writeFileSync(join(repo, "scripts", name), `import fs from "node:fs";fs.appendFileSync(${JSON.stringify(log)}, [${JSON.stringify(name)}, ...process.argv.slice(2), ...${JSON.stringify(logEnv ?? [])}.map((key) => key + "=" + (process.env[key] ?? ""))].join(" ") + "\\n");${writeSkip}process.exit(${exit});\n`);
  }
  const calls = join(dir, "docker-calls.log");
  const built = join(dir, "built");
  // Like the real daemon: once the build has moved sonder-audiobooks:local, the previous image is gone and cannot be tagged.
  stub(bin, "docker", [
    `echo "$*" >> ${JSON.stringify(calls)}`,
    'case "$*" in',
    '  "inspect sonder") exit 0 ;;',
    '  *State.Status*) echo running ;;',
    '  *"{{.Image}}"*) echo sha256:aaaaaaaaaaaa ;;',
    '  *"{{.Id}}"*) echo sha256:bbbbbbbbbbbb ;;',
    '  *Health*) echo healthy ;;',
    `  "images "*) printf '%b\\n' ${JSON.stringify(images)} ;;`,
    `  "compose build sonder") touch ${JSON.stringify(built)} ;;`,
    `  "compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs") ${smokeFails ? 'echo "alignment pool host wsl (worker@wsl.example): ssh true failed" >&2; exit 1' : "exit 0"} ;;`,
    // Do not put "-c*" at the end of a case pattern: the first ")" closes the branch (bash parse error on --rm).
    `  *run*--entrypoint*sh*sonder-audiobooks:local*grep*) ${markerFails ? "exit 1" : "exit 0"} ;;`,
    `  *run*--entrypoint*test*sonder-audiobooks:local*) ${markerFileFails ? "exit 1" : "exit 0"} ;;`,
    `  "tag "*)
    if ${tagFails}; then echo "Error response from daemon: No such image" >&2; exit 1; fi
    case "$*" in
      *sha256:*)
        if [ -e ${JSON.stringify(built)} ]; then echo "Error response from daemon: No such image" >&2; exit 1; fi ;;
    esac ;;`,
    '  *) exit 0 ;;',
    "esac",
  ].join("\n"));
  const times = join(dir, "health-times");
  const asked = join(dir, "health-asked.log");
  writeFileSync(times, healthTimes.join("\n") + "\n");
  // Each request takes the next answer time; only a request that asks for the time (-w) uses one up.
  stub(bin, "curl", [
    `case "$*" in *time_total*) ;; *) exit 0 ;; esac`,
    `next=$(head -n 1 ${JSON.stringify(times)})`,
    `if [ "$(wc -l < ${JSON.stringify(times)})" -gt 1 ]; then sed -i 1d ${JSON.stringify(times)}; fi`,
    `echo "$next" >> ${JSON.stringify(asked)}`,
    `[ "$next" = fail ] && exit 7`,
    `printf %s "$next"`,
  ].join("\n"));
  const run = (args, extra = {}) => spawnSync("bash", ["scripts/deploy.sh", "HEAD", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({ PATH: `${bin}:${process.env.PATH}`, SONDER_DEPLOY_DOCKER: join(bin, "docker"), SONDER_DEPLOY_LIVE_CHECKS: Object.keys(checks).map((n) => `scripts/${n}`).join(" "), SONDER_DEPLOY_SETTLE_SECONDS: "0", ...extra }),
  });
  const runProd = (args) => spawnSync("bash", ["scripts/deploy-prod.sh", "HEAD", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({ PATH: `${bin}:${process.env.PATH}`, SONDER_PROD_ROOT: repo, SONDER_DEPLOY_DOCKER: join(bin, "docker") }),
  });
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]]) {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() });
    assert.equal(r.status, 0, r.stderr);
  }
  const ran = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const dockerCalls = () => { try { return readFileSync(calls, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const healthAsked = () => { try { return readFileSync(asked, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return { dir, run, runProd, ran, dockerCalls, healthAsked };
}

test("production dry run lists the image smoke before the swap", () => {
  const f = fixture({});
  try {
    const r = f.runProd(["--no-marker", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /smoke-test the built image: docker compose run --rm --no-deps --entrypoint node sonder --import tsx scripts\/image-smoke\.mjs/);
    assert.ok(r.stdout.indexOf("smoke-test the built image") < r.stdout.indexOf("docker compose up -d sonder"));
    assert.equal(f.dockerCalls().some((c) => c.startsWith("run ") || c.startsWith("compose ")), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a failing image smoke aborts after build and before the container swap, restores :local, and does not compose up", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { smokeFails: true });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /alignment pool host wsl \(worker@wsl\.example\): ssh true failed/);
    assert.match(r.stderr, /image smoke failed; the container is still running the previous image/);
    assert.match(r.stderr, /restoring :local to the rollback image/);
    const calls = f.dockerCalls();
    const build = calls.indexOf("compose build sonder");
    const smoke = calls.indexOf("compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs");
    assert.ok(build >= 0 && smoke > build, calls.join("\n"));
    assert.ok(calls.some((c) => c === "tag sonder-audiobooks:rollback sonder-audiobooks:local"), calls.join("\n"));
    assert.equal(calls.some((c) => c.startsWith("compose up")), false);
    assert.deepEqual(f.ran(), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a failing marker restores :local from the rollback tag and does not compose up", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { markerFails: true });
  try {
    const r = f.run(["--marker", "needle"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /marker not found in the built image: needle/);
    assert.match(r.stderr, /restoring :local to the rollback image/);
    const calls = f.dockerCalls();
    assert.ok(calls.some((c) => c === "tag sonder-audiobooks:rollback sonder-audiobooks:local"), calls.join("\n"));
    assert.equal(calls.some((c) => c.startsWith("compose up")), false);
    assert.deepEqual(f.ran(), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("every live check runs and a clean run exits 0", () => {
  const f = fixture({ "verify-a.mjs": 0, "verify-b.mjs": 0 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.ran(), ["verify-a.mjs", "verify-b.mjs"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a failing live check does not stop the next one, and the deploy still exits 1 with a rollback line", () => {
  const f = fixture({ "verify-a.mjs": 1, "verify-b.mjs": 0 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.deepEqual(f.ran(), ["verify-a.mjs", "verify-b.mjs"]);
    assert.match(r.stderr, /live check failed: scripts\/verify-a\.mjs/);
    assert.match(r.stderr, /1 live check\(s\) failed: scripts\/verify-a\.mjs/);
    assert.match(r.stderr, /roll back with: docker tag sonder-audiobooks:rollback sonder-audiobooks:local/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a check that finds no suitable recording is reported as skipped with its reason, and the deploy exits 0", () => {
  const reason = "1 aligned recording(s) in the library, none qualifies: rec-a: the saved position is 0 s before the end of the book (needs more than 300 s)";
  const f = fixture({ "verify-integrated-reader.mjs": { exit: 3, skip: reason }, "verify-b.mjs": 0 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.ran(), ["verify-integrated-reader.mjs", "verify-b.mjs"]);
    assert.ok(r.stdout.includes(`live check skipped: scripts/verify-integrated-reader.mjs (no suitable recording: ${reason})`), r.stdout);
    assert.doesNotMatch(r.stderr, /live check failed|live check\(s\) failed/);
    assert.match(r.stdout, /deployed [0-9a-f]{7} \(image/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a skipped check does not hide a real failure of another check", () => {
  const f = fixture({ "verify-integrated-reader.mjs": { exit: 3, skip: "no aligned recording(s) in the library" }, "verify-b.mjs": 1 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /live check skipped: scripts\/verify-integrated-reader\.mjs/);
    assert.match(r.stderr, /1 live check\(s\) failed: scripts\/verify-b\.mjs/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("exit 3 without a written reason, or a reason with another failing exit, stays a failure", () => {
  const f = fixture({ "verify-integrated-reader.mjs": 3, "verify-b.mjs": { exit: 1, skip: "written, then failed" } });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /live check skipped/);
    assert.match(r.stderr, /2 live check\(s\) failed: scripts\/verify-integrated-reader\.mjs scripts\/verify-b\.mjs/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("live checks run with SONDER_VERIFY_PRODUCTION=1, which the scripts need to reach production", () => {
  const f = fixture({ "verify-integrated-reader.mjs": { exit: 0, logEnv: ["SONDER_VERIFY_PRODUCTION"] }, "verify-multi-user.mjs": { exit: 0, logEnv: ["SONDER_VERIFY_PRODUCTION"] } });
  try {
    const r = f.run(["--no-marker"], { SONDER_VERIFY_PRODUCTION: "" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.ran(), ["verify-integrated-reader.mjs SONDER_VERIFY_PRODUCTION=1", "verify-multi-user.mjs SONDER_VERIFY_PRODUCTION=1"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// #774: an operator names the recording the deploy's checks use; without one each check chooses its own (never the
// book the owner listened to in the last 48 h, scripts/live-check-recording.mjs).
test("SONDER_VERIFY_RECORDING and SONDER_VERIFY_ALLOW_RECENT reach every live check, and the dry run names the recording", () => {
  const logEnv = ["SONDER_VERIFY_RECORDING", "SONDER_VERIFY_ALLOW_RECENT"];
  const f = fixture({ "verify-integrated-reader.mjs": { exit: 0, logEnv }, "verify-multi-user.mjs": { exit: 0, logEnv } });
  try {
    let r = f.run(["--no-marker"], { SONDER_VERIFY_RECORDING: "recording-excession", SONDER_VERIFY_ALLOW_RECENT: "1" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.ran(), [
      "verify-integrated-reader.mjs SONDER_VERIFY_RECORDING=recording-excession SONDER_VERIFY_ALLOW_RECENT=1",
      "verify-multi-user.mjs SONDER_VERIFY_RECORDING=recording-excession SONDER_VERIFY_ALLOW_RECENT=1",
    ]);
    r = f.run(["--no-marker", "--dry-run"], { SONDER_VERIFY_RECORDING: "recording-excession" });
    assert.match(r.stdout, /live checks: .*\n {5}recording: recording-excession\n/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// #794: the slice pass is one of the optional live checks, run only when asked for, after the others.
test("SONDER_DEPLOY_SLICE_PASS=1 adds the slice pass after the other live checks; without it the deploy does not run it", () => {
  const f = fixture({ "verify-a.mjs": 0, "verify-slice-pass.mjs": 0 });
  try {
    let r = f.run(["--no-marker"], { SONDER_DEPLOY_LIVE_CHECKS: "scripts/verify-a.mjs" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.ran(), ["verify-a.mjs"]);
    r = f.run(["--no-marker"], { SONDER_DEPLOY_LIVE_CHECKS: "scripts/verify-a.mjs", SONDER_DEPLOY_SLICE_PASS: "1" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.ran(), ["verify-a.mjs", "verify-a.mjs", "verify-slice-pass.mjs"]);
    // Any other value is not the opt-in.
    r = f.run(["--no-marker", "--dry-run"], { SONDER_DEPLOY_LIVE_CHECKS: "", SONDER_DEPLOY_SLICE_PASS: "yes" });
    assert.match(r.stdout, /live checks: scripts\/verify-integrated-reader\.mjs scripts\/verify-multi-user\.mjs\n/);
    r = f.run(["--no-marker", "--dry-run"], { SONDER_DEPLOY_LIVE_CHECKS: "", SONDER_DEPLOY_SLICE_PASS: "1" });
    assert.match(r.stdout, /live checks: scripts\/verify-integrated-reader\.mjs scripts\/verify-multi-user\.mjs scripts\/verify-slice-pass\.mjs\n/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the reader check is started without a recording id even when the database has a mapped recording", () => {
  const interval = { paragraphId: "p1", section: 0, trackId: "t1", start: 0, end: 5, confidence: 1 };
  const f = fixture(
    { "verify-integrated-reader.mjs": 0, "verify-b.mjs": 0 },
    { jobs: [{ recordingId: "rec-ready", updatedAt: 100, data: { progress: 1, status: "ready", intervals: [interval] } }] },
  );
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.ran(), ["verify-integrated-reader.mjs", "verify-b.mjs"]);
    assert.match(r.stdout, /live check: scripts\/verify-integrated-reader\.mjs\n/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the running image is tagged before the build when :local is its only tag", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { images: "sonder-audiobooks:local aaaaaaaaaaaa" });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const calls = f.dockerCalls();
    const tagged = calls.findIndex((c) => /^tag sha256:aaaaaaaaaaaa sonder-audiobooks:before-/.test(c));
    const built = calls.indexOf("compose build sonder");
    assert.ok(tagged >= 0 && built >= 0 && tagged < built, calls.join("\n"));
    assert.match(r.stdout, /rollback: docker tag sonder-audiobooks:before-[0-9a-f]{7}-\d+ sonder-audiobooks:local/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("an image that already has another sonder-audiobooks tag is not tagged again", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { images: "sonder-audiobooks:local aaaaaaaaaaaa\nsonder-audiobooks:abc1234 aaaaaaaaaaaa" });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(f.dockerCalls().some((c) => c.startsWith("tag ")), false);
    assert.match(r.stdout, /rollback: docker tag sonder-audiobooks:abc1234 sonder-audiobooks:local/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("when the running image cannot be tagged nothing is built and the container is left alone", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { images: "sonder-audiobooks:local aaaaaaaaaaaa", tagFails: true });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not tag the running image for rollback; not building/);
    assert.match(r.stderr, /roll back by rebuilding the previous commit: git checkout <previous-commit> && docker compose build sonder && docker compose up -d sonder/);
    const calls = f.dockerCalls();
    assert.equal(calls.includes("compose build sonder"), false);
    assert.equal(calls.some((c) => c.startsWith("compose up")), false);
    assert.deepEqual(f.ran(), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("--marker-file passes when the file exists in the image", () => {
  const f = fixture({ "verify-a.mjs": 0 });
  try {
    const r = f.run(["--marker-file", "/app/dist/index.html"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /marker file ok: \/app\/dist\/index.html/);
    assert.ok(f.dockerCalls().includes("run --rm --entrypoint test sonder-audiobooks:local -f /app/dist/index.html"), f.dockerCalls().join("\n"));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("--marker-file absent from the image restores :local and does not compose up", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { markerFileFails: true });
  try {
    const r = f.run(["--marker-file", "/app/nope"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /marker file not found in the built image: \/app\/nope/);
    const calls = f.dockerCalls();
    assert.ok(calls.some((c) => c === "tag sonder-audiobooks:rollback sonder-audiobooks:local"), calls.join("\n"));
    assert.equal(calls.some((c) => c.startsWith("compose up")), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("--no-marker deploys without any image marker check", () => {
  const f = fixture({ "verify-a.mjs": 0 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /image marker check skipped/);
    assert.equal(f.dockerCalls().some((c) => c.startsWith("run --rm --entrypoint")), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a deploy with no marker flag is refused with exit 2 and runs nothing", () => {
  const f = fixture({ "verify-a.mjs": 0 });
  try {
    for (const args of [[], ["--dry-run"]]) {
      const r = f.run(args);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /refusing to deploy with no verification/);
    }
    assert.deepEqual(f.dockerCalls(), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("--no-marker cannot be combined with --marker or --marker-file; missing values are usage errors", () => {
  const f = fixture({});
  try {
    for (const args of [["--no-marker", "--marker", "x"], ["--no-marker", "--marker-file", "/x"]]) {
      const r = f.run(args);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--no-marker cannot be combined/);
    }
    const r = f.run(["--marker-file"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: deploy.sh .*--marker-file <path>.*--no-marker/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("dry run plans marker file and --no-marker steps", () => {
  const f = fixture({});
  try {
    let r = f.run(["--marker-file", "/app/x", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /verify marker file in the image: \/app\/x/);
    r = f.run(["--no-marker", "--dry-run"]);
    assert.match(r.stdout, /skipped \(--no-marker\)/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("deploy-prod.sh refuses with no marker flag", () => {
  const f = fixture({});
  try {
    const r = f.runProd([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing to deploy with no verification/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

// The settle wait before the live checks (#822).
const SETTLE = { SONDER_DEPLOY_SETTLE_SECONDS: "1", SONDER_DEPLOY_SETTLE_INTERVAL: "0.2", SONDER_DEPLOY_SETTLE_CEILING: "4" };

test("the live checks start only after health has answered quickly for the whole stretch", () => {
  const f = fixture({ "verify-a.mjs": 0 });
  try {
    const began = Date.now();
    const r = f.run(["--no-marker"], SETTLE);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(Date.now() - began >= 1000, "the stretch is waited out");
    assert.match(r.stdout, /waiting until \/api\/health has answered in under 0\.5s for 1s in a row \(at most 4s\)/);
    assert.match(r.stdout, /settled: \/api\/health answered in under 0\.5s for 1s/);
    assert.ok(r.stdout.indexOf("settled:") < r.stdout.indexOf("live check: scripts/verify-a.mjs"), r.stdout);
    assert.ok(f.healthAsked().length >= 2, "health is asked more than once");
    assert.deepEqual(f.ran(), ["verify-a.mjs"]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a slow answer or one that does not come starts the stretch again", () => {
  // Quick, slow, quick, none, then quick for good: the stretch that counts begins after the request without an answer.
  const f = fixture({ "verify-a.mjs": 0 }, { healthTimes: ["0.010", "0.900", "0.010", "fail", "0.010"] });
  try {
    const r = f.run(["--no-marker"], SETTLE);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /settled:/);
    const asked = f.healthAsked();
    assert.deepEqual(asked.slice(0, 5), ["0.010", "0.900", "0.010", "fail", "0.010"]);
    // After the fourth request at least a second of quick answers, 0.2 s apart, is needed.
    assert.ok(asked.length >= 4 + 5, asked.join(" "));
    assert.deepEqual(f.ran(), ["verify-a.mjs"]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a server that stays slow: at the ceiling the script says so and runs the checks, and a failing check still fails the deploy", () => {
  const f = fixture({ "verify-a.mjs": 1, "verify-b.mjs": 0 }, { healthTimes: ["0.700"] });
  try {
    const r = f.run(["--no-marker"], { ...SETTLE, SONDER_DEPLOY_SETTLE_CEILING: "1" });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /not settled: \/api\/health did not answer in under 0\.5s for 1s in a row within 1s \(last answer: 0\.700s\); starting the live checks anyway/);
    assert.doesNotMatch(r.stdout, /settled: /);
    // Every check runs once: nothing is run again.
    assert.deepEqual(f.ran(), ["verify-a.mjs", "verify-b.mjs"]);
    assert.match(r.stderr, /1 live check\(s\) failed: scripts\/verify-a\.mjs/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("without live checks there is nothing to wait for, and 0 seconds skips the wait", () => {
  const f = fixture({ "verify-a.mjs": 0 });
  try {
    const skipped = f.run(["--no-marker", "--skip-live-checks"], SETTLE);
    assert.equal(skipped.status, 0, skipped.stderr + skipped.stdout);
    assert.doesNotMatch(skipped.stdout, /waiting until/);
    const none = f.run(["--no-marker"], { SONDER_DEPLOY_SETTLE_SECONDS: "0" });
    assert.equal(none.status, 0, none.stderr + none.stdout);
    assert.doesNotMatch(none.stdout, /waiting until/);
    assert.deepEqual(f.healthAsked(), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("the dry run names the wait and its settings, and a setting that is not whole seconds is refused", () => {
  const f = fixture({ "verify-a.mjs": 0 });
  try {
    const plan = f.run(["--no-marker", "--dry-run"], { SONDER_DEPLOY_SETTLE_SECONDS: "60" });
    assert.equal(plan.status, 0, plan.stderr + plan.stdout);
    assert.match(plan.stdout, /7\. wait until \/api\/health has answered in under 0\.5s for 60s in a row \(at most 300s\)\n\s+8\. live checks: scripts\/verify-a\.mjs/);
    const bad = f.run(["--no-marker"], { SONDER_DEPLOY_SETTLE_SECONDS: "a minute" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /whole seconds, got: a minute/);
    assert.deepEqual(f.ran(), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
