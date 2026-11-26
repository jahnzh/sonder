// scripts/build-image.sh (#915): a commit's image is built from the commit itself, once, one build at a time, and the
// older commit images are untagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.ts";

const script = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "build-image.sh");

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, ...extra };
}

// A repository with one commit, a file changed after it and one never added; a docker that keeps the build context
// it was given, the images it has (`images`: tag and creation time) and what it removed.
function fixture({ images = [], buildFails = false } = {}) {
  const dir = tempDir("sonder-build-image-");
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(repo, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repo, "committed.txt"), "as committed\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c"]]) {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() });
    assert.equal(r.status, 0, r.stderr);
  }
  writeFileSync(join(repo, "committed.txt"), "changed in the work tree\n");
  writeFileSync(join(repo, "untracked.txt"), "never added\n");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", env: cleanEnv() }).stdout.trim();
  const calls = join(dir, "calls.log");
  const context = join(dir, "context.tar");
  const labelled = join(dir, "labelled");
  const listing = join(dir, "images");
  writeFileSync(listing, images.map(({ tag, created }) => `${created}\tsonder-audiobooks:${tag}`).join("\n") + (images.length ? "\n" : ""));
  const q = JSON.stringify;
  writeFileSync(join(bin, "docker"), [
    "#!/usr/bin/env bash",
    `echo "$*" >> ${q(calls)}`,
    'case "$*" in',
    `  "image inspect "*) [ -e ${q(labelled)} ] && cat ${q(labelled)} ;;`,
    `  "build "*) cat > ${q(context)}; ${buildFails ? 'echo "npm error: lockfile mismatch"; exit 1' : `echo ${head} > ${q(labelled)}`} ;;`,
    `  "images "*) cat ${q(listing)} ;;`,
    "esac",
    "exit 0",
  ].join("\n"));
  chmodSync(join(bin, "docker"), 0o755);
  const env = (extra = {}) => cleanEnv({ PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, SONDER_IMAGE_LOCK: join(dir, "build.lock"), SONDER_IMAGE_KEEP: "3", ...extra });
  const run = (args = ["HEAD"], extra = {}) => spawnSync("bash", [script, ...args], { cwd: repo, encoding: "utf8", env: env(extra) });
  const dockerCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
  const contextFiles = () => spawnSync("tar", ["-tf", context], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
  const contextFile = (name) => spawnSync("tar", ["-xOf", context, name], { encoding: "utf8" }).stdout;
  return { dir, repo, head, run, env, dockerCalls, contextFiles, contextFile };
}

test("the image is built from the commit's own files, labelled and tagged with the commit", () => {
  const f = fixture();
  const r = f.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(f.dockerCalls().includes(`build --progress=plain --label sonder.commit=${f.head} -t sonder-audiobooks:commit-${f.head} -`), f.dockerCalls().join("\n"));
  assert.deepEqual(f.contextFiles(), ["Dockerfile", "committed.txt"]);
  assert.equal(f.contextFile("committed.txt"), "as committed\n");
  assert.match(r.stdout, new RegExp(`image ready: sonder-audiobooks:commit-${f.head} \\(built in \\d+\\.\\ds\\)\\n$`));
});

test("an image that is built already is not built again", () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const r = f.run([f.head.slice(0, 7)]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.stdout, `image ready: sonder-audiobooks:commit-${f.head} (prebuilt)\n`);
  assert.equal(f.dockerCalls().filter((c) => c.startsWith("build ")).length, 1);
});

test("a failed build prints the end of the builder's lines and exits 1", () => {
  const f = fixture({ buildFails: true });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm error: lockfile mismatch\nimage build failed: sonder-audiobooks:commit-[0-9a-f]{40} \(the builder's lines: /);
  assert.doesNotMatch(r.stdout, /image ready/);
});

test("after a build the newest commit images keep their tags and the older ones are untagged", () => {
  const images = ["2026-11-20", "2026-11-24", "2026-11-21", "2026-11-23", "2026-11-22"].map((day) => ({ tag: `commit-${day}`, created: `${day} 10:00:00 +0000 UTC` }));
  const f = fixture({ images });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // SONDER_IMAGE_KEEP=3: the one just built and the two newest before it.
  assert.deepEqual(f.dockerCalls().filter((c) => c.startsWith("rmi ")), ["rmi sonder-audiobooks:commit-2026-11-22", "rmi sonder-audiobooks:commit-2026-11-21", "rmi sonder-audiobooks:commit-2026-11-20"]);
  assert.ok(f.dockerCalls().includes("images --filter reference=sonder-audiobooks:commit-* --format {{.CreatedAt}}\t{{.Repository}}:{{.Tag}}"));
  assert.match(r.stdout, /untagged an older commit image: sonder-audiobooks:commit-2026-11-20\n/);
});

test("a build waits for the one already running, then finds its image", async () => {
  const f = fixture();
  // Another build holds the lock for a moment and makes the image.
  const holder = spawn("flock", [join(f.dir, "build.lock"), "bash", "-c", `sleep 1; echo ${f.head} > ${JSON.stringify(join(f.dir, "labelled"))}`], { env: f.env(), stdio: "ignore" });
  const held = new Promise((resolveWait) => holder.on("close", resolveWait));
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const r = await new Promise((resolveRun) => {
    const child = spawn("bash", [script, "HEAD"], { cwd: f.repo, env: f.env() });
    let stdout = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.on("close", (status) => resolveRun({ status, stdout }));
  });
  await held;
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^another image build is running; waiting for it\nimage ready: sonder-audiobooks:commit-[0-9a-f]{40} \(prebuilt\)\n$/);
  assert.equal(f.dockerCalls().some((c) => c.startsWith("build ")), false);
});

test("an unknown commit exits 1 and a bad call exits 2, building nothing", () => {
  const f = fixture();
  const unknown = f.run(["no-such-commit"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown commit: no-such-commit/);
  for (const args of [[], ["HEAD", "extra"], ["--help"]]) assert.equal(f.run(args).status, 2);
  assert.equal(f.run(["HEAD"], { SONDER_IMAGE_KEEP: "five" }).status, 2);
  assert.equal(f.dockerCalls().some((c) => c.startsWith("build ")), false);
});
