// scripts/prebuild-image.sh (#915): a landed commit's image is built in the production repository, once, and never
// while a deploy's live checks run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, ...extra };
}

// A production checkout with the two scripts, one commit, and a docker that builds by labelling.
function fixture({ built = false } = {}) {
  const dir = tempDir("sonder-prebuild-");
  const prod = join(dir, "prod");
  const bin = join(dir, "bin");
  mkdirSync(join(prod, "scripts"), { recursive: true });
  mkdirSync(bin);
  for (const name of ["prebuild-image.sh", "build-image.sh"]) copyFileSync(join(repoRoot, "scripts", name), join(prod, "scripts", name));
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c"]]) {
    const r = spawnSync("git", args, { cwd: prod, encoding: "utf8", env: cleanEnv() });
    assert.equal(r.status, 0, r.stderr);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: prod, encoding: "utf8", env: cleanEnv() }).stdout.trim();
  const calls = join(dir, "calls.log");
  const labelled = join(dir, "labelled");
  if (built) writeFileSync(labelled, `${head}\n`);
  const q = JSON.stringify;
  writeFileSync(join(bin, "docker"), [
    "#!/usr/bin/env bash",
    `echo "$*" >> ${q(calls)}`,
    'case "$*" in',
    `  "image inspect "*) [ -e ${q(labelled)} ] && cat ${q(labelled)} ;;`,
    `  "build "*) cat > /dev/null; echo ${head} > ${q(labelled)} ;;`,
    "esac",
    "exit 0",
  ].join("\n"));
  chmodSync(join(bin, "docker"), 0o755);
  const state = join(prod, "artifacts", "deploy");
  const run = (args = [head]) => spawnSync("bash", [join(prod, "scripts", "prebuild-image.sh"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: cleanEnv({ PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, SONDER_PROD_ROOT: prod, SONDER_IMAGE_LOCK: join(dir, "build.lock") }),
  });
  const builds = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((c) => c.startsWith("build ")) : []);
  return { prod, head, state, run, builds };
}

test("a landed commit is built in the production repository and the build is logged", () => {
  const f = fixture();
  const r = f.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(f.builds(), [`build --progress=plain --label sonder.commit=${f.head} -t sonder-audiobooks:commit-${f.head} -`]);
  assert.match(readFileSync(join(f.state, `prebuild-${f.head.slice(0, 7)}.log`), "utf8"), /image ready: sonder-audiobooks:commit-[0-9a-f]{40} \(built in /);
});

test("a commit that is built already is passed over without a word", () => {
  const f = fixture({ built: true });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.stdout, "");
  assert.deepEqual(f.builds(), []);
  assert.equal(existsSync(f.state), false, "no log for a commit that needs nothing");
});

test("nothing is built while a deploy's live checks run", async () => {
  const f = fixture();
  const checks = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    mkdirSync(f.state, { recursive: true });
    writeFileSync(join(f.state, "checks.pid"), `${checks.pid}\n`);
    const r = f.run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`a deploy's live checks are running \\(pid ${checks.pid}\\); not building ${f.head.slice(0, 7)} now`));
    assert.deepEqual(f.builds(), []);
  } finally {
    checks.kill();
  }
  // A pid file left by checks that are gone does not hold the build.
  await new Promise((resolveWait) => checks.on("close", resolveWait));
  assert.equal(f.run().status, 0);
  assert.equal(f.builds().length, 1);
});

test("an unknown commit exits 1 and a bad call exits 2", () => {
  const f = fixture();
  assert.equal(f.run(["no-such-commit"]).status, 1);
  assert.equal(f.run(["--nope"]).status, 2);
  assert.equal(f.run(["a", "b"]).status, 2);
  assert.deepEqual(f.builds(), []);
});
