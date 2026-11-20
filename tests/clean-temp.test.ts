import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "clean-temp.sh");

function cleanTemp(env: Record<string, string>) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

function ageMinutesAgo(path: string, minutes: number) {
  const t = new Date(Date.now() - minutes * 60000);
  utimesSync(path, t, t);
}

/** Sets a directory and what is in it to `minutes` ago, the directory last (writing into it moves its time). */
function makeOld(dir: string, minutes: number, files: string[] = []) {
  mkdirSync(dir, { recursive: true });
  for (const name of files) {
    writeFileSync(join(dir, name), "x");
    ageMinutesAgo(join(dir, name), minutes);
  }
  ageMinutesAgo(dir, minutes);
}

/** A process that lives until `stop()`, started with what the test gives it. */
function liveProcess(command: string, options: { cwd?: string; env?: Record<string, string>; args?: string[] } = {}) {
  const child = spawn("bash", ["-c", command, "bash", ...(options.args ?? [])], { stdio: "ignore", cwd: options.cwd, env: { ...process.env, ...options.env } });
  return { pid: child.pid!, stop: () => { try { child.kill("SIGKILL"); } catch {} } };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function makeRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), "sonder-cleantemp-")));
}

test("exits 2 on bad usage", () => {
  const result = spawnSync("bash", [script, "extra-arg"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: clean-temp\.sh/);
});

test("exits 2 on a non-numeric age", () => {
  const root = makeRoot();
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root, ORCA_CLEAN_TEMP_MAX_AGE_MIN: "lots" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ORCA_CLEAN_TEMP_MAX_AGE_MIN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exits 1 when the root does not exist", () => {
  const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: join(tmpdir(), "sonder-cleantemp-nope") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /clean-temp root not found/);
});

test("removes a dir nothing changed in for 30 minutes, keeps one that changed and names why, leaves other names", () => {
  const root = makeRoot();
  const stale = join(root, "sonder-browser-old");
  const fresh = join(root, "sonder-local-check-fresh");
  const inside = join(root, "sonder-browser-changed-inside");
  const other = join(root, "other-old");
  makeOld(stale, 40, ["file"]);
  makeOld(fresh, 20);
  makeOld(other, 130);
  // The directory is old, a file in it is not: something in it changed.
  makeOld(inside, 130);
  mkdirSync(join(inside, "profile"));
  writeFileSync(join(inside, "profile", "state"), "x");
  ageMinutesAgo(join(inside, "profile"), 130);
  ageMinutesAgo(inside, 130);
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`removed: ${escaped(stale)}`));
    assert.match(result.stdout, new RegExp(`kept: ${escaped(fresh)} \\(changed in the last 30 min\\)`));
    assert.match(result.stdout, new RegExp(`kept: ${escaped(inside)} \\(changed in the last 30 min\\)`));
    assert.match(result.stdout, /freed \d+ MB \(1 of 3 dirs\)/);
    assert.ok(!existsSync(stale), "the stale dir must be removed");
    assert.ok(existsSync(fresh), "a dir made 20 minutes ago must be kept");
    assert.ok(existsSync(inside), "a dir with a file changed just now must be kept");
    assert.ok(existsSync(other), "non-sonder dirs must be untouched");
    assert.doesNotMatch(result.stdout + result.stderr, /other-old/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dir in use by a live process survives, however old: as its working directory, an open file, its command line or its environment", () => {
  const root = makeRoot();
  const dirs = Object.fromEntries(["cwd", "fd", "cmd", "env", "unused"].map((name) => [name, join(root, `sonder-browser-${name}`)]));
  for (const dir of Object.values(dirs)) makeOld(dir, 130, ["file"]);
  const users = [
    liveProcess("sleep 60", { cwd: dirs.cwd }),
    // Holds a file of the directory open for reading (opening it for reading does not change it).
    liveProcess(`exec 9< "${join(dirs.fd, "file")}"; sleep 60`),
    // `; :` keeps the shell itself running, with the path among its arguments.
    liveProcess("sleep 60; :", { args: [`--user-data-dir=${dirs.cmd}/profile`] }),
    liveProcess("sleep 60", { env: { SONDER_BROWSER_TEMP: dirs.env } }),
  ];
  try {
    // The shells need a moment to open their file and change directory.
    const ready = `[ "$(readlink /proc/${users[0].pid}/cwd)" = "${dirs.cwd}" ] && ls -l /proc/${users[1].pid}/fd | grep -qF "${dirs.fd}"`;
    for (let tries = 0; tries < 50 && spawnSync("bash", ["-c", ready]).status !== 0; tries++) spawnSync("sleep", ["0.1"]);
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const name of ["cwd", "fd", "cmd", "env"]) {
      assert.ok(existsSync(dirs[name]), `${name}: a dir a live process uses must survive\n${result.stdout}`);
      assert.match(result.stdout, new RegExp(`kept: ${escaped(dirs[name])} \\(in use by process \\d+\\)`), name);
    }
    assert.ok(!existsSync(dirs.unused), "the dir no process uses is removed");
    assert.match(result.stdout, /freed \d+ MB \(1 of 5 dirs\)/);
    // Once its user is gone, a directory goes too.
    for (const user of users) user.stop();
    // A killed child stays a zombie until the test process reaps it; it has no working directory any more.
    const gone = users.map((user) => `! readlink /proc/${user.pid}/cwd >/dev/null 2>&1`).join(" && ");
    for (let tries = 0; tries < 50 && spawnSync("bash", ["-c", gone]).status !== 0; tries++) spawnSync("sleep", ["0.1"]);
    const after = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.match(after.stdout, /freed \d+ MB \(4 of 4 dirs\)/);
  } finally {
    for (const user of users) user.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a longer name that starts like a dir in use is another dir", () => {
  const root = makeRoot();
  const used = join(root, "sonder-browser-abc");
  const longer = join(root, "sonder-browser-abcdef");
  makeOld(used, 130);
  makeOld(longer, 130);
  const user = liveProcess("sleep 60", { env: { SONDER_BROWSER_TEMP: longer } });
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(longer), "the dir the process names stays");
    assert.ok(!existsSync(used), "a dir whose name only begins another's is not in use");
  } finally {
    user.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running Playwright no longer stops the cleaner: the old probe setting is ignored", () => {
  const root = makeRoot();
  const stale = join(root, "sonder-browser-old");
  makeOld(stale, 130);
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root, ORCA_CLEAN_TEMP_PLAYWRIGHT: "true" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /refusing/);
    assert.ok(!existsSync(stale));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("freed MB is the removed directory size, not a free-space delta", () => {
  const root = makeRoot();
  const stale = join(root, "sonder-browser-sized");
  mkdirSync(stale);
  // 2 MiB payload so du -sk reports at least 2048 KB → 2 MB after integer division.
  writeFileSync(join(stale, "blob"), Buffer.alloc(2 * 1024 * 1024));
  ageMinutesAgo(join(stale, "blob"), 130);
  ageMinutesAgo(stale, 130);
  // Concurrent writer on the same filesystem: a df-based delta can go negative (#285).
  const pressure = join(root, "pressure.bin");
  const writer = spawn(
    "timeout",
    ["60", "bash", "-c", `while true; do dd if=/dev/zero of="${pressure}" bs=1M count=8 status=none 2>/dev/null; done`],
    { stdio: "ignore", detached: true },
  );
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /freed 2 MB \(1 of 1 dirs\)/);
    assert.ok(!existsSync(stale));
  } finally {
    try {
      if (writer.pid) process.kill(-writer.pid, "SIGKILL");
    } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("prints nothing to clean when there is no such dir, or every one is kept", () => {
  const root = makeRoot();
  try {
    const empty = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(empty.status, 0, empty.stdout + empty.stderr);
    assert.match(empty.stdout, /nothing to clean: no sonder-browser-\* or sonder-local-check-\*/);
    const fresh = join(root, "sonder-browser-fresh");
    makeOld(fresh, 10);
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /kept: .*sonder-browser-fresh \(changed in the last 30 min\)/);
    assert.match(result.stdout, /nothing to clean: 1 of 1 dirs kept/);
    assert.ok(existsSync(fresh));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ORCA_CLEAN_TEMP_MAX_AGE_MIN moves the age bar", () => {
  const root = makeRoot();
  const stale = join(root, "sonder-local-check-mid");
  makeOld(stale, 40);
  try {
    const kept = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root, ORCA_CLEAN_TEMP_MAX_AGE_MIN: "60" });
    assert.equal(kept.status, 0, kept.stdout + kept.stderr);
    assert.match(kept.stdout, /changed in the last 60 min/);
    assert.ok(existsSync(stale));

    const removed = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.match(removed.stdout, new RegExp(`removed: ${escaped(stale)}`));
    assert.ok(!existsSync(stale));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
