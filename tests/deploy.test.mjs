import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
// The stubbed docker keeps what :local and the container point at (files `local` and `running`): aaaaaaaaaaaa is the
// image production runs, bbbbbbbbbbbb the commit's new image. `prebuilt`: the commit's image is there before the deploy.
// `newUnhealthy`: /api/health does not answer while the container runs the new image.
function fixture(checks, { images = "sonder-audiobooks:rollback aaaaaaaaaaaa", tagFails = false, smokeFails = false, markerFails = false, markerFileFails = false, buildFails = false, prebuilt = false, newUnhealthy = false, jobs = [], healthTimes = ["0.010"], prepareExit = 0 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-deploy-")));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "data"));
  mkdirSync(bin);
  for (const name of ["deploy.sh", "deploy-prod.sh", "build-image.sh", "deploy-wait.sh"])
    copyFileSync(join(repoRoot, "scripts", name), join(repo, "scripts", name));
  mkdirSync(join(repo, "scripts", "lib"));
  copyFileSync(join(repoRoot, "scripts", "lib", "deploy-markers.sh"), join(repo, "scripts", "lib", "deploy-markers.sh"));
  // The commit's code, which a --marker is looked for in before the build: "needle" is in it.
  mkdirSync(join(repo, "server"));
  writeFileSync(join(repo, "server", "app.ts"), "export const needle = 1;\n");
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
  const running = join(dir, "running");
  const local = join(dir, "local");
  const prebuiltFile = join(dir, "prebuilt");
  writeFileSync(running, "aaaaaaaaaaaa\n");
  writeFileSync(local, "aaaaaaaaaaaa\n");
  // A check is its exit code, or {exit, skip, sleep, logEnv, takeOver}: a check that writes `skip` to
  // SONDER_LIVE_CHECK_SKIP_FILE before exiting, as verify-integrated-reader.mjs does when no recording qualifies (#431);
  // `sleep` milliseconds before it exits; `takeOver`: the container runs another image by then (a later deploy).
  for (const [name, spec] of Object.entries(checks)) {
    const { exit, skip, logEnv, sleep = 0, takeOver = false } = typeof spec === "number" ? { exit: spec } : spec;
    const writeSkip = skip === undefined ? "" : `if(process.env.SONDER_LIVE_CHECK_SKIP_FILE)fs.writeFileSync(process.env.SONDER_LIVE_CHECK_SKIP_FILE, ${JSON.stringify(skip)});`;
    const take = takeOver ? `fs.writeFileSync(${JSON.stringify(running)}, "cccccccccccc\\n");` : "";
    writeFileSync(join(repo, "scripts", name), `import fs from "node:fs";fs.appendFileSync(${JSON.stringify(log)}, [${JSON.stringify(name)}, ...process.argv.slice(2), ...${JSON.stringify(logEnv ?? [])}.map((key) => key + "=" + (process.env[key] ?? ""))].join(" ") + "\\n");${writeSkip}${take}setTimeout(() => process.exit(${exit}), ${sleep});\n`);
  }
  // The command that prepares the library's text (#827): it logs that it ran, with the server it was pointed at.
  writeFileSync(
    join(repo, "scripts", "prepare-library.sh"),
    `#!/usr/bin/env bash\necho "prepare-library.sh $SONDER_ADMIN_URL timeout=$SONDER_PREPARE_TIMEOUT" >> ${JSON.stringify(log)}\necho "prepare-library: 3 of 4 editions prepared"\nexit ${prepareExit}\n`,
  );
  const calls = join(dir, "docker-calls.log");
  const built = join(dir, "built");
  const q = JSON.stringify;
  if (prebuilt) writeFileSync(prebuiltFile, "");
  // Like the real daemon: once :local has moved to the new image, the previous image (if :local was its only tag) is
  // gone and cannot be tagged (#153).
  stub(bin, "docker", [
    `echo "$*" >> ${q(calls)}`,
    'case "$*" in',
    '  "inspect sonder") exit 0 ;;',
    '  *State.Status*) echo running ;;',
    `  *"{{.Image}}"*) echo "sha256:$(cat ${q(running)})" ;;`,
    // The commit's image: there when prebuilt or built, labelled with the commit (the image's name holds it).
    `  "image inspect --format {{index .Config.Labels \\"sonder.commit\\"}} "*)
    [ -e ${q(prebuiltFile)} ] || exit 1
    echo "\${@: -1}" | sed 's/.*:commit-//' ;;`,
    `  "image inspect --format {{.Id}} "*) [ -e ${q(prebuiltFile)} ] && echo sha256:bbbbbbbbbbbb ;;`,
    `  "build "*) cat > /dev/null; ${buildFails ? 'echo "npm ci failed" >&2; exit 1' : `touch ${q(prebuiltFile)}`} ;;`,
    '  "images --filter "*) exit 0 ;;',
    // The running image's tags: those `images` lists with its id.
    `  "image inspect --format {{range .RepoTags}}{{println .}}{{end}} "*)
    id=\${@: -1}; id=\${id#sha256:}
    printf '%b\\n' ${q(images)} | awk -v id="$id" '$2 == id {print $1}' ;;`,
    '  "rmi "*) exit 0 ;;',
    // One container checks the markers and runs the smoke (#915).
    `  "compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs"*)
    ${smokeFails ? 'echo "alignment pool host wsl (worker@wsl.example): ssh true failed" >&2; exit 1' : ":"}
    set -- "\${@:11}"
    while [ $# -gt 0 ]; do
      case $1 in
        --marker) ${markerFails ? 'echo "marker not found in the built image: $2" >&2; exit 1' : 'echo "marker ok: $2"'} ;;
        --marker-file) ${markerFileFails ? 'echo "marker file not found in the built image: $2" >&2; exit 1' : 'echo "marker file ok: $2"'} ;;
      esac
      shift 2
    done
    echo "image smoke passed" ;;`,
    `  "compose up -d --no-build sonder") cp ${q(local)} ${q(running)} ;;`,
    `  "tag "*)
    if ${tagFails}; then echo "Error response from daemon: No such image" >&2; exit 1; fi
    case "$*" in
      *sha256:aaaaaaaaaaaa*)
        if [ -e ${q(built)} ]; then echo "Error response from daemon: No such image" >&2; exit 1; fi ;;
    esac
    case "$2" in
      sonder-audiobooks:commit-*) echo bbbbbbbbbbbb > ${q(local)}; touch ${q(built)} ;;
      *) echo aaaaaaaaaaaa > ${q(local)} ;;
    esac ;;`,
    '  *) exit 0 ;;',
    "esac",
  ].join("\n"));
  const times = join(dir, "health-times");
  const asked = join(dir, "health-asked.log");
  const ended = join(dir, "health-ended.log");
  writeFileSync(times, healthTimes.join("\n") + "\n");
  // Each request takes the next answer time; only a request that asks for the time (-w) uses one up. A request
  // without -w is the swap's "answers once".
  stub(bin, "curl", [
    `case "$*" in *time_total*) ;; *) ${newUnhealthy ? `[ "$(cat ${q(running)})" = bbbbbbbbbbbb ] && exit 7;` : ""} exit 0 ;; esac`,
    `next=$(head -n 1 ${q(times)})`,
    `if [ "$(wc -l < ${q(times)})" -gt 1 ]; then sed -i 1d ${q(times)}; fi`,
    `echo "$next" >> ${q(asked)}`,
    // When each request ended, in milliseconds: a test measures a stretch by the clock, not by how many requests fit in it.
    // Since boot, as deploy.sh counts: the wall clock of a busy host can go back (NTP).
    `read -r up _ </proc/uptime; up=\${up/./}; echo $(( 10#$up * 10 )) >> ${q(ended)}`,
    `[ "$next" = fail ] && exit 7`,
    `printf %s "$next"`,
  ].join("\n"));
  const state = join(dir, "state");
  // A failed build leaves its builder's lines in TMPDIR: inside the fixture.
  mkdirSync(join(dir, "tmp"));
  const baseEnv = () => cleanEnv({
    TMPDIR: join(dir, "tmp"),
    PATH: `${bin}:${process.env.PATH}`,
    SONDER_DEPLOY_DOCKER: join(bin, "docker"),
    SONDER_DEPLOY_LIVE_CHECKS: Object.keys(checks).map((n) => `scripts/${n}`).join(" "),
    SONDER_DEPLOY_SETTLE_SECONDS: "0",
    SONDER_DEPLOY_STATE_DIR: state,
    SONDER_IMAGE_LOCK: join(dir, "build.lock"),
  });
  // The checks are waited for (--wait-checks) unless `background` is asked for.
  const run = (args, extra = {}, { background = false } = {}) => spawnSync("bash", ["scripts/deploy.sh", "HEAD", ...(background || args.includes("--dry-run") ? [] : ["--wait-checks"]), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...baseEnv(), ...extra },
  });
  const script = (name, args, extra = {}) => spawnSync("bash", [`scripts/${name}`, ...args], { cwd: repo, encoding: "utf8", env: { ...baseEnv(), ...extra } });
  const runProd = (args) => spawnSync("bash", ["scripts/deploy-prod.sh", "HEAD", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({ PATH: `${bin}:${process.env.PATH}`, SONDER_PROD_ROOT: repo, SONDER_DEPLOY_DOCKER: join(bin, "docker"), SONDER_DEPLOY_STATE_DIR: state }),
  });
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]]) {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() });
    assert.equal(r.status, 0, r.stderr);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", env: cleanEnv() }).stdout.trim();
  // `ran`: the live checks, in order. `everything`: those and the preparing of the library's text after them.
  const everything = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const ran = () => everything().filter((line) => !line.startsWith("prepare-library.sh"));
  const dockerCalls = () => { try { return readFileSync(calls, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const healthAsked = () => { try { return readFileSync(asked, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const healthEnded = () => { try { return readFileSync(ended, "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; } };
  const runningImage = () => readFileSync(running, "utf8").trim();
  return { dir, repo, state, head, run, script, runProd, ran, everything, dockerCalls, healthAsked, healthEnded, runningImage };
}

// The background checks' result file, once they have written it.
async function resultOf(path, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`no result in ${path} after ${ms} ms`);
}

test("production dry run lists the image smoke before the swap", () => {
  const f = fixture({});
  try {
    const r = f.runProd(["--no-marker", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /smoke-test the new image, markers included, in one container: docker compose run --rm --no-deps --entrypoint node sonder --import tsx scripts\/image-smoke\.mjs\n/);
    assert.ok(r.stdout.indexOf("smoke-test the new image") < r.stdout.indexOf("docker compose up -d --no-build sonder"));
    assert.match(r.stdout, /1\. image: sonder-audiobooks:commit-[0-9a-f]{40} is not built yet; build it now/);
    assert.equal(f.dockerCalls().some((c) => c.startsWith("run ") || c.startsWith("compose ")), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a failing image smoke aborts after the image and before the container swap, restores :local, and does not compose up", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { smokeFails: true });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /alignment pool host wsl \(worker@wsl\.example\): ssh true failed/);
    assert.match(r.stderr, /image smoke failed; the container is still running the previous image/);
    assert.match(r.stderr, /restoring :local to the rollback image/);
    const calls = f.dockerCalls();
    const local = calls.indexOf(`tag sonder-audiobooks:commit-${f.head} sonder-audiobooks:local`);
    const smoke = calls.indexOf("compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs");
    assert.ok(local >= 0 && smoke > local, calls.join("\n"));
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
    // The marker is checked by the smoke's own container (#915): no container of its own.
    assert.ok(calls.includes("compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs --marker needle"), calls.join("\n"));
    assert.equal(calls.filter((c) => c.startsWith("run ") || c.startsWith("compose run ")).length, 1, calls.join("\n"));
    assert.ok(calls.some((c) => c === "tag sonder-audiobooks:rollback sonder-audiobooks:local"), calls.join("\n"));
    assert.equal(calls.some((c) => c.startsWith("compose up")), false);
    assert.deepEqual(f.ran(), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a --marker the commit does not hold fails before the image is built", () => {
  const f = fixture({ "verify-a.mjs": 0 });
  try {
    const r = f.run(["--marker", "needle", "--marker", "not-in-the-code"]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /marker not found in [0-9a-f]{7} \(server\/, src\/, dist\/\): not-in-the-code/);
    assert.doesNotMatch(r.stderr, /marker not found[^\n]*: needle/);
    assert.match(r.stderr, /nothing was built/);
    const calls = f.dockerCalls();
    assert.equal(calls.some((c) => c.startsWith("build ") || c.startsWith("tag ") || c.startsWith("compose ")), false, calls.join("\n"));
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

test("a failing live check does not stop the next one, and the deploy is rolled back and exits 1", () => {
  const f = fixture({ "verify-a.mjs": 1, "verify-b.mjs": 0 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.deepEqual(f.ran(), ["verify-a.mjs", "verify-b.mjs"]);
    assert.match(r.stderr, /live check failed: scripts\/verify-a\.mjs/);
    assert.match(r.stderr, /1 live check\(s\) failed: scripts\/verify-a\.mjs/);
    assert.match(r.stderr, /rolling back: sonder-audiobooks:rollback becomes :local again/);
    assert.match(r.stderr, /rolled back to sonder-audiobooks:rollback; \/api\/health answers/);
    const calls = f.dockerCalls();
    const swap = calls.indexOf("compose up -d --no-build sonder");
    const back = calls.lastIndexOf("tag sonder-audiobooks:rollback sonder-audiobooks:local");
    assert.ok(swap >= 0 && back > swap && calls.lastIndexOf("compose up -d --no-build sonder") > back, calls.join("\n"));
    assert.equal(f.runningImage(), "aaaaaaaaaaaa", "the container runs the previous image again");
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
    assert.match(r.stdout, /live checks: scripts\/verify-integrated-reader\.mjs scripts\/verify-multi-user\.mjs scripts\/verify-covers\.mjs\n/);
    r = f.run(["--no-marker", "--dry-run"], { SONDER_DEPLOY_LIVE_CHECKS: "", SONDER_DEPLOY_SLICE_PASS: "1" });
    assert.match(r.stdout, /live checks: scripts\/verify-integrated-reader\.mjs scripts\/verify-multi-user\.mjs scripts\/verify-covers\.mjs scripts\/verify-slice-pass\.mjs\n/);
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

test("the running image is tagged before :local moves when :local is its only tag", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { images: "sonder-audiobooks:local aaaaaaaaaaaa" });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const calls = f.dockerCalls();
    const tagged = calls.findIndex((c) => /^tag sha256:aaaaaaaaaaaa sonder-audiobooks:before-/.test(c));
    const moved = calls.indexOf(`tag sonder-audiobooks:commit-${f.head} sonder-audiobooks:local`);
    assert.ok(tagged >= 0 && moved >= 0 && tagged < moved, calls.join("\n"));
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
    assert.equal(f.dockerCalls().some((c) => c.startsWith("tag sha256:")), false);
    assert.match(r.stdout, /rollback: docker tag sonder-audiobooks:abc1234 sonder-audiobooks:local/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("when the running image cannot be tagged :local does not move and the container is left alone", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { images: "sonder-audiobooks:local aaaaaaaaaaaa", tagFails: true });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not tag the running image for rollback; not deploying/);
    assert.match(r.stderr, /roll back by rebuilding the previous commit: git checkout <previous-commit> && docker compose build sonder && docker compose up -d sonder/);
    const calls = f.dockerCalls();
    assert.equal(calls.some((c) => c.endsWith(" sonder-audiobooks:local")), false, calls.join("\n"));
    assert.equal(calls.some((c) => c.startsWith("compose run")), false);
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
    assert.ok(f.dockerCalls().includes("compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs --marker-file /app/dist/index.html"), f.dockerCalls().join("\n"));
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
    assert.equal(f.dockerCalls().some((c) => c.startsWith("run --rm --entrypoint") || c.includes("--marker")), false);
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

// The library's text is prepared by the deploy, after its checks (#827, review of #829).
test("the library's text is prepared after the live checks have passed, on the deployed server", () => {
  const f = fixture({ "verify-a.mjs": 0, "verify-b.mjs": 0 });
  try {
    const r = f.run(["--no-marker"], { SONDER_DEPLOY_PORT: "3555" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.everything(), ["verify-a.mjs", "verify-b.mjs", "prepare-library.sh http://127.0.0.1:3555 timeout=1800"]);
    // The deploy is done at the swap; the library's text is prepared after the checks.
    assert.ok(r.stdout.indexOf("deployed ") < r.stdout.indexOf("preparing the library's text: scripts/prepare-library.sh"), r.stdout);
    assert.match(r.stdout, /prepare-library: 3 of 4 editions prepared/);
    assert.doesNotMatch(r.stderr, /NOT FULLY PREPARED/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a library that could not be fully prepared is said loudly, in the last line too, and the deploy still exits 0", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { prepareExit: 1 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /deployed [0-9a-f]+ /);
    const said = r.stderr.split("\n").filter((line) => line.startsWith("THE LIBRARY'S TEXT IS NOT FULLY PREPARED: scripts/prepare-library.sh exited 1"));
    assert.equal(said.length, 2, r.stderr);
    assert.equal(r.stderr.trim().split("\n").at(-1), said[1], "it is the deploy's last line");
    assert.doesNotMatch(r.stderr, /roll back with/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a command that could not ask the server is not reported as an unprepared library (#858)", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { prepareExit: 3 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stderr, /NOT FULLY PREPARED/);
    const said = r.stderr.split("\n").filter((line) => line.startsWith("THE LIBRARY'S TEXT WAS NOT CHECKED: scripts/prepare-library.sh could not ask the server (exit 3"));
    assert.equal(said.length, 2, r.stderr);
    assert.match(said[0], /This says nothing about the library/);
    assert.equal(r.stderr.trim().split("\n").at(-1), said[1]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the library is not prepared when a live check failed, and the step can be left out", () => {
  let f = fixture({ "verify-a.mjs": 1 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.deepEqual(f.everything(), ["verify-a.mjs"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
  f = fixture({ "verify-a.mjs": 0 });
  try {
    let r = f.run(["--no-marker"], { SONDER_DEPLOY_PREPARE_LIBRARY: "" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.everything(), ["verify-a.mjs"]);
    // Without live checks the library is still prepared: nothing else is running.
    r = f.run(["--no-marker", "--skip-live-checks"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.everything(), ["verify-a.mjs", "prepare-library.sh http://127.0.0.1:3001 timeout=1800"]);
    r = f.run(["--no-marker", "--dry-run"]);
    assert.match(r.stdout, /  9\. prepare the library's text: scripts\/prepare-library\.sh \(after the live checks; its failure does not fail the deploy\)\n/);
    r = f.run(["--no-marker", "--dry-run"], { SONDER_DEPLOY_PREPARE_LIBRARY: "" });
    assert.match(r.stdout, /  9\. prepare the library's text: skipped/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
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
    // Measured by the clock and not by how many requests fit into the second, which depends on the host's load
    // (#837). Requests 0.4 s apart and a ceiling far away: a loaded host only makes the run longer.
    const r = f.run(["--no-marker"], { ...SETTLE, SONDER_DEPLOY_SETTLE_INTERVAL: "0.4", SONDER_DEPLOY_SETTLE_CEILING: "60" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /settled:/);
    const asked = f.healthAsked();
    assert.deepEqual(asked.slice(0, 5), ["0.010", "0.900", "0.010", "fail", "0.010"]);
    // The stretch of one second begins at the fifth request, the first quick one after the request without an
    // answer. Had it begun at the third (the stretch not started again), it would have ended at most 0.2 s after
    // the fifth, since the fourth and fifth each came 0.4 s later.
    const ended = f.healthEnded();
    assert.equal(ended.length, asked.length);
    assert.ok(ended.at(-1) - ended[4] >= 600, `the last request ended ${ended.at(-1) - ended[4]} ms after the fifth: ${asked.join(" ")}`);
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

// #915: the image is built ahead of the deploy, from the commit itself; the deploy only swaps to it.
test("a prebuilt image is swapped to without a build, and the deploy prints its steps' times", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { prebuilt: true });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(r.stdout.includes(`image ready: sonder-audiobooks:commit-${f.head} (prebuilt)`), r.stdout);
    const calls = f.dockerCalls();
    assert.equal(calls.some((c) => c.startsWith("build ")), false, calls.join("\n"));
    assert.ok(calls.includes(`tag sonder-audiobooks:commit-${f.head} sonder-audiobooks:local`), calls.join("\n"));
    assert.ok(calls.includes("compose up -d --no-build sonder"), calls.join("\n"));
    assert.equal(calls.some((c) => c === "compose up -d sonder" || c.startsWith("compose build")), false, calls.join("\n"));
    assert.equal(f.runningImage(), "bbbbbbbbbbbb");
    assert.match(r.stdout, /deploy times: verify \d+\.\ds · image \d+\.\ds · backup \d+\.\ds · rollback-tag \d+\.\ds · smoke \d+\.\ds · swap \d+\.\ds · health \d+\.\ds · total \d+\.\ds\n/);
    assert.match(r.stdout, /checks' times: verify-a \d+\.\ds · prepare \d+\.\ds · total \d+\.\ds\n/);
    // The dry run says the image is there.
    const plan = f.run(["--no-marker", "--dry-run"]);
    assert.match(plan.stdout, /1\. image: sonder-audiobooks:commit-[0-9a-f]{40} is built \(prebuilt\)/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("an image that is not built yet is built from the commit before the backup", () => {
  const f = fixture({ "verify-a.mjs": 0 });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const calls = f.dockerCalls();
    const build = calls.indexOf(`build --progress=plain --label sonder.commit=${f.head} -t sonder-audiobooks:commit-${f.head} -`);
    assert.ok(build >= 0, calls.join("\n"));
    assert.ok(r.stdout.indexOf("image ready: ") < r.stdout.indexOf("backing up "), r.stdout);
    assert.match(r.stdout, new RegExp(`image ready: sonder-audiobooks:commit-${f.head} \\(built in \\d+\\.\\ds\\)`));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a failed build stops the deploy before the backup; nothing is tagged and the container is untouched", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { buildFails: true });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /npm ci failed\nimage build failed: sonder-audiobooks:commit-[0-9a-f]{40} \(the builder's lines: /);
    assert.match(r.stderr, /the image of [0-9a-f]{7} could not be built; the container is untouched/);
    assert.doesNotMatch(r.stdout, /backing up/);
    const calls = f.dockerCalls();
    assert.equal(calls.some((c) => c.startsWith("tag ") || c.startsWith("compose ")), false, calls.join("\n"));
    assert.deepEqual(f.ran(), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a new container whose health never answers is rolled back at once, and no live check runs", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { newUnhealthy: true });
  try {
    const r = f.run(["--no-marker"], { SONDER_DEPLOY_HEALTH_TIMEOUT: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\/api\/health did not answer on 127\.0\.0\.1:3001 within 1s; rolling back to sonder-audiobooks:rollback/);
    assert.match(r.stderr, /rolled back to sonder-audiobooks:rollback; \/api\/health answers/);
    assert.equal(f.runningImage(), "aaaaaaaaaaaa");
    assert.equal(f.dockerCalls().filter((c) => c === "compose up -d --no-build sonder").length, 2);
    assert.deepEqual(f.ran(), []);
    assert.doesNotMatch(r.stdout, /deployed /);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("the live checks run in the background after the swap: the deploy returns, a failure rolls back and the result says so", async () => {
  const f = fixture({ "verify-a.mjs": { exit: 1, sleep: 300 }, "verify-b.mjs": 0 }, { prebuilt: true });
  try {
    const r = f.run(["--no-marker"], {}, { background: true });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /live checks: running in the background; a failure rolls back to sonder-audiobooks:rollback/);
    const resultFile = /result: (\S+\.json)/.exec(r.stdout)?.[1];
    assert.ok(resultFile?.startsWith(f.state), r.stdout);
    // The container runs the new image as soon as the deploy returns.
    assert.equal(f.runningImage(), "bbbbbbbbbbbb");
    const result = await resultOf(resultFile);
    assert.equal(result.result, "rolled_back");
    assert.deepEqual(result.failed, ["scripts/verify-a.mjs"]);
    assert.equal(result.commit, f.head);
    assert.equal(result.rollbackTag, "rollback");
    assert.match(result.times, /checks' times: verify-a \d+\.\ds · verify-b \d+\.\ds · rollback \d+\.\ds · total/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.state, "latest.json"), "utf8")), result);
    assert.equal(f.runningImage(), "aaaaaaaaaaaa", "rolled back");
    assert.deepEqual(f.ran(), ["verify-a.mjs", "verify-b.mjs"], "the library is not prepared after a failure");
    const log = readFileSync(resultFile.replace(/\.json$/, ".log"), "utf8");
    assert.match(log, /rolled back to sonder-audiobooks:rollback/);
    const waited = f.script("deploy-wait.sh", [resultFile]);
    assert.equal(waited.status, 1, waited.stderr + waited.stdout);
    assert.match(waited.stdout, /"result": "rolled_back"/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("checks that pass in the background prepare the library, and deploy-wait.sh waits for them and exits 0", () => {
  const f = fixture({ "verify-a.mjs": { exit: 0, sleep: 500 } }, { prebuilt: true });
  try {
    const r = f.run(["--no-marker"], {}, { background: true });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    // The deploy itself names the checks' process, so a wait started at once finds them.
    assert.ok(existsSync(join(f.state, "checks.pid")));
    // Without a file, the newest deploy's.
    const waited = f.script("deploy-wait.sh", ["--timeout", "20"]);
    assert.equal(waited.status, 0, waited.stderr + waited.stdout);
    assert.match(waited.stdout, /"result": "passed"/);
    assert.match(waited.stdout, /deploy of [0-9a-f]{7}: live checks passed/);
    assert.deepEqual(f.everything(), ["verify-a.mjs", "prepare-library.sh http://127.0.0.1:3001 timeout=1800"]);
    assert.equal(f.runningImage(), "bbbbbbbbbbbb");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a failed check does not roll back a container that already runs another image", () => {
  const f = fixture({ "verify-a.mjs": { exit: 1, takeOver: true } }, { prebuilt: true });
  try {
    const r = f.run(["--no-marker"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not rolled back: the container runs image cccccccccccc, not this deploy's bbbbbbbbbbbb/);
    assert.equal(f.runningImage(), "cccccccccccc");
    assert.equal(f.dockerCalls().some((c) => c === "tag sonder-audiobooks:rollback sonder-audiobooks:local"), false);
    const status = JSON.parse(readFileSync(join(f.state, "latest.json"), "utf8"));
    assert.equal(status.result, "not_rolled_back");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("--stop-checks stops an earlier deploy's background checks, whose result says superseded, without a rollback", async () => {
  const f = fixture({ "verify-a.mjs": { exit: 1, sleep: 20000 } }, { prebuilt: true });
  try {
    const r = f.run(["--no-marker"], {}, { background: true });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const resultFile = /result: (\S+\.json)/.exec(r.stdout)?.[1];
    const until = Date.now() + 10000;
    while (!f.ran().length && Date.now() < until) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.deepEqual(f.ran(), ["verify-a.mjs"], "the check has started");
    const began = Date.now();
    const stopped = f.script("deploy.sh", ["--stop-checks"]);
    assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
    assert.match(stopped.stdout, /stopping the background checks of an earlier deploy/);
    assert.ok(Date.now() - began < 10000, "the check is not waited out");
    const result = await resultOf(resultFile);
    assert.equal(result.result, "superseded");
    assert.equal(f.runningImage(), "bbbbbbbbbbbb", "nothing is rolled back");
    assert.equal(existsSync(join(f.state, "checks.pid")), false);
    // Nothing running: a second stop has nothing to do.
    assert.doesNotMatch(f.script("deploy.sh", ["--stop-checks"]).stdout, /stopping/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a second deploy while one runs is refused", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { prebuilt: true });
  try {
    mkdirSync(f.state, { recursive: true });
    const r = spawnSync("flock", [join(f.state, ".deploy.lock"), "bash", "scripts/deploy.sh", "HEAD", "--no-marker", "--wait-checks"], {
      cwd: f.repo, encoding: "utf8", env: cleanEnv({ PATH: process.env.PATH, SONDER_DEPLOY_DOCKER: join(f.dir, "bin", "docker"), SONDER_DEPLOY_STATE_DIR: f.state }),
    });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /another deploy is running/);
    assert.equal(f.dockerCalls().some((c) => c.startsWith("tag ") || c.startsWith("compose ")), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("checks waited for with --wait-checks can be stopped by a later deploy too", async () => {
  const f = fixture({ "verify-a.mjs": { exit: 0, sleep: 20000 } }, { prebuilt: true });
  try {
    const waiting = spawn("bash", ["scripts/deploy.sh", "HEAD", "--no-marker", "--wait-checks"], {
      cwd: f.repo,
      env: cleanEnv({ PATH: `${join(f.dir, "bin")}:${process.env.PATH}`, SONDER_DEPLOY_DOCKER: join(f.dir, "bin", "docker"), SONDER_DEPLOY_LIVE_CHECKS: "scripts/verify-a.mjs", SONDER_DEPLOY_SETTLE_SECONDS: "0", SONDER_DEPLOY_STATE_DIR: f.state, SONDER_IMAGE_LOCK: join(f.dir, "build.lock"), TMPDIR: join(f.dir, "tmp") }),
      stdio: "ignore",
    });
    const ended = new Promise((resolveEnd) => waiting.on("close", (status) => resolveEnd(status)));
    const until = Date.now() + 10000;
    while (!f.ran().length && Date.now() < until) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.deepEqual(f.ran(), ["verify-a.mjs"], "the check has started");
    const stopped = f.script("deploy.sh", ["--stop-checks"]);
    assert.match(stopped.stdout, /stopping the background checks of an earlier deploy/);
    assert.notEqual(await ended, 0, "the waiting deploy ends with the stopped checks");
    assert.equal(JSON.parse(readFileSync(join(f.state, "latest.json"), "utf8")).result, "superseded");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
