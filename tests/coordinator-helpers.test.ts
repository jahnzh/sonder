// The coordinator's helper scripts added after the retro of 2026-11-15: each replaces a long command that
// was typed by hand many times. External commands (ssh, rsync, the production API) are faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = (...parts: string[]) => join(repoRoot, "scripts", ...parts);

function run(file: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [file, ...args], { cwd: repoRoot, env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
}

/** spawnSync would block this process's event loop, and with it the fake API the script calls. */
function runAsync(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn("bash", [file, ...args], { cwd: repoRoot, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

test("stress-spec.sh and worker-done.sh refuse a wrong call with exit 2 before doing anything", () => {
  assert.equal(run(script("stress-spec.sh"), []).status, 2);
  const missing = run(script("stress-spec.sh"), ["tests/e2e/no-such.spec.ts", "--no-build"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /No such spec/);
  assert.equal(run(script("stress-spec.sh"), ["tests/e2e/users.spec.ts", "--runs", "0"]).status, 2);
  const done = run(script("orca", "worker-done.sh"), ["run_x"]);
  assert.equal(done.status, 2);
  assert.match(done.stderr, /usage: worker-done\.sh/);
});

test("admin-curl.sh logs in with the password from the env file, sends the request with the cookie, and leaves no file and no password behind", async () => {
  const dir = tempDir("sonder-admin-test-");
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const envFile = join(dir, ".env");
  writeFileSync(envFile, 'OTHER=1\nAPP_PASSWORD="s3cret pass"\n');
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} cookie=${req.headers.cookie ?? ""} body=${body}`);
      if (req.url === "/api/auth/login") {
        const ok = JSON.parse(body).password === "s3cret pass";
        res.writeHead(ok ? 200 : 401, ok ? { "set-cookie": "session=abc; Path=/" } : {});
        res.end("{}");
      } else {
        res.writeHead(req.headers.cookie === "session=abc" ? 200 : 401);
        res.end(JSON.stringify({ path: req.url }));
      }
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const env = { SONDER_ENV_FILE: envFile, SONDER_ADMIN_URL: base, TMPDIR: tmp };
    const ok = await runAsync(script("admin-curl.sh"), ["/api/activity", "-X", "POST", "--data", '{"a":1}'], env);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, '{"path":"/api/activity"}');
    assert.equal(seen[1], 'POST /api/activity cookie=session=abc body={"a":1}');
    assert.ok(!`${ok.stdout}${ok.stderr}`.includes("s3cret"), "the password is never printed");
    assert.deepEqual(readdirSync(tmp), [], "the login body and the cookie jar are removed");

    writeFileSync(envFile, "APP_PASSWORD=wrong\n");
    const refused = await runAsync(script("admin-curl.sh"), ["/api/activity"], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Login failed \(HTTP 401\)/);
    assert.equal(seen.length, 3, "no request follows a failed login");

    assert.equal((await runAsync(script("admin-curl.sh"), ["api/activity"], env)).status, 2, "the path must start with a slash");
  } finally {
    server.close();
  }
});

test("update-ctc-workers.sh skips a host at the commit or at one with the same worker code and, in a dry run, copies nothing to one that is not", () => {
  const dir = tempDir("sonder-ctc-update-test-");
  // The check runs this suite in a copy without git history, so the script gets a repository of its own.
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "worker"));
  copyFileSync(script("update-ctc-workers.sh"), join(repo, "scripts", "update-ctc-workers.sh"));
  writeFileSync(join(repo, "worker", "align.py"), "# worker\n");
  // Git exports its own paths to hooks; none of that may reach this repository.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const older = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "worker", "align.py"), "# worker, changed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "worker");
  const first = git("rev-parse", "HEAD");
  // A later commit that does not touch worker/: a host at the first commit already runs this worker code.
  writeFileSync(join(repo, "README.md"), "docs only\n");
  git("add", "-A");
  git("commit", "-q", "-m", "docs");
  const head = git("rev-parse", "HEAD");

  const calls = join(dir, "calls.log");
  const ssh = join(dir, "ssh");
  // What each fake host reports as its revision: HEAD, a commit with the same worker/, one with another worker/,
  // and a commit this repository lacks.
  const revisions = { current: head, same: first, older, behind: "0".repeat(40) };
  const cases = Object.entries(revisions).map(([host, revision]) => `${host}) echo '{"ready":true,"revision":"${revision}"}' ;;`).join("\n");
  writeFileSync(ssh, `#!/usr/bin/env bash\necho "ssh $*" >> "${calls}"\ncase $1 in\n${cases}\nesac\n`);
  const rsync = join(dir, "rsync");
  writeFileSync(rsync, `#!/usr/bin/env bash\necho "rsync $*" >> "${calls}"\n`);
  for (const file of [ssh, rsync]) chmodSync(file, 0o755);
  const stage = join(dir, "stage");
  mkdirSync(stage);
  const result = spawnSync("bash", [join(repo, "scripts", "update-ctc-workers.sh"), "HEAD", "--dry-run", ...Object.keys(revisions).flatMap((host) => ["--host", host])], {
    cwd: repo,
    env: { ...gitEnv, SONDER_CTC_SSH: ssh, SONDER_CTC_RSYNC: rsync, TMPDIR: stage },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`== current\\nalready at ${head.slice(0, 7)}\\n== same\\nruns ${first.slice(0, 7)}: worker/ is the same at ${head.slice(0, 7)}\\n== older\\nruns ${older.slice(0, 12)}, wants ${head.slice(0, 7)}\\ndry run: [^\\n]*\\n== behind\\nruns 000000000000, wants ${head.slice(0, 7)}\\ndry run:`));
  const log = readFileSync(calls, "utf8");
  assert.ok(!log.includes("rsync"), "a dry run copies nothing");
  assert.equal(log.trim().split("\n").length, 4, "one health read per host and nothing else");
  assert.deepEqual(readdirSync(stage), [], "the staged copy is removed");
});
