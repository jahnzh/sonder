import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
// append their name to a log, so a test can see which checks ran.
function fixture(checks, { images = "sonder-audiobooks:rollback aaaaaaaaaaaa", tagFails = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-deploy-")));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "data"));
  mkdirSync(bin);
  copyFileSync(join(repoRoot, "scripts", "deploy.sh"), join(repo, "scripts", "deploy.sh"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { backup: "cp" } }));
  writeFileSync(join(repo, "data", "sonder.db"), "db");
  const log = join(dir, "ran.log");
  for (const [name, exit] of Object.entries(checks)) {
    writeFileSync(join(repo, "scripts", name), `import fs from "node:fs";fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + "\\n");process.exit(${exit});\n`);
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
    `  "tag "*) if [ -e ${JSON.stringify(built)} ] || ${tagFails}; then echo "Error response from daemon: No such image" >&2; exit 1; fi ;;`,
    '  *) exit 0 ;;',
    "esac",
  ].join("\n"));
  stub(bin, "curl", "exit 0");
  const run = (args, extra = {}) => spawnSync("bash", ["scripts/deploy.sh", "HEAD", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({ PATH: `${bin}:${process.env.PATH}`, SONDER_DEPLOY_DOCKER: join(bin, "docker"), SONDER_DEPLOY_LIVE_CHECKS: Object.keys(checks).map((n) => `scripts/${n}`).join(" "), ...extra }),
  });
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]]) {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() });
    assert.equal(r.status, 0, r.stderr);
  }
  const ran = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const dockerCalls = () => { try { return readFileSync(calls, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return { dir, run, ran, dockerCalls };
}

test("every live check runs and a clean run exits 0", () => {
  const f = fixture({ "verify-a.mjs": 0, "verify-b.mjs": 0 });
  try {
    const r = f.run([]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(f.ran(), ["verify-a.mjs", "verify-b.mjs"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a failing live check does not stop the next one, and the deploy still exits 1 with a rollback line", () => {
  const f = fixture({ "verify-a.mjs": 1, "verify-b.mjs": 0 });
  try {
    const r = f.run([]);
    assert.equal(r.status, 1);
    assert.deepEqual(f.ran(), ["verify-a.mjs", "verify-b.mjs"]);
    assert.match(r.stderr, /live check failed: scripts\/verify-a\.mjs/);
    assert.match(r.stderr, /1 live check\(s\) failed: scripts\/verify-a\.mjs/);
    assert.match(r.stderr, /roll back with: docker tag sonder-audiobooks:rollback sonder-audiobooks:local/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a reader check with no recording to use is a failed check, and the others still run", () => {
  const f = fixture({ "verify-integrated-reader.mjs": 0, "verify-b.mjs": 0 });
  try {
    const r = f.run([]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot run the reader live check/);
    assert.deepEqual(f.ran(), ["verify-b.mjs"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the running image is tagged before the build when :local is its only tag", () => {
  const f = fixture({ "verify-a.mjs": 0 }, { images: "sonder-audiobooks:local aaaaaaaaaaaa" });
  try {
    const r = f.run([]);
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
    const r = f.run([]);
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
    const r = f.run([]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not tag the running image for rollback; not building/);
    const calls = f.dockerCalls();
    assert.equal(calls.includes("compose build sonder"), false);
    assert.equal(calls.some((c) => c.startsWith("compose up")), false);
    assert.deepEqual(f.ran(), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
