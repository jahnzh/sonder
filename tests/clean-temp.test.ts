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

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), "sonder-cleantemp-")));
}

test("exits 2 on bad usage", () => {
  const result = spawnSync("bash", [script, "extra-arg"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: clean-temp\.sh \[--dry-run\]/);
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

test("keeps directories a running test server uses and removes the rest while it runs", () => {
  const root = makeRoot();
  const live = join(root, "sonder-browser-live");
  const dead = join(root, "sonder-browser-dead");
  const open = join(root, "sonder-local-check-open");
  for (const dir of [live, dead, open]) mkdirSync(dir);
  // This test process stands in for a live browser server; a PID that cannot exist stands in for a
  // server that is gone. A process with a file open inside a directory also marks it as in use.
  writeFileSync(join(live, ".sonder-pid"), `${process.pid}\n`);
  writeFileSync(join(dead, ".sonder-pid"), "2147483646\n");
  writeFileSync(join(open, "held"), "x");
  const holder = spawn("bash", ["-c", 'exec 3<"$1"; echo ready; sleep 30', "holder", join(open, "held")], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  for (const dir of [live, dead, open]) ageMinutesAgo(dir, 130);
  try {
    const ready = spawnSync("bash", ["-c", `for i in $(seq 100); do [ -e /proc/${holder.pid}/fd/3 ] && exit 0; sleep 0.05; done; exit 1`]);
    assert.equal(ready.status, 0, "the holder opened its file");
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(live), "a directory whose marker names a live process is kept");
    assert.ok(existsSync(open), "a directory a process has a file open in is kept");
    assert.ok(!existsSync(dead), "a directory whose server is gone is removed");
    assert.match(result.stdout, new RegExp(`in use, kept: ${escape(live)}`));
    assert.match(result.stdout, new RegExp(`in use, kept: ${escape(open)}`));
    assert.match(result.stdout, new RegExp(`removed: ${escape(dead)}`));
    assert.match(result.stdout, /freed \d+ MB \(1 of 3 dirs\)/);
  } finally {
    holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a process working inside a directory keeps it", () => {
  const root = makeRoot();
  const busy = join(root, "sonder-local-check-busy");
  mkdirSync(busy);
  const worker = spawn("sleep", ["30"], { cwd: busy, stdio: "ignore" });
  ageMinutesAgo(busy, 130);
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(busy));
    assert.match(result.stdout, /freed 0 MB \(0 of 1 dirs\)/);
  } finally {
    worker.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run lists what it would remove and removes nothing", () => {
  const root = makeRoot();
  const stale = join(root, "sonder-browser-old");
  mkdirSync(stale);
  writeFileSync(join(stale, "blob"), Buffer.alloc(2 * 1024 * 1024));
  ageMinutesAgo(stale, 130);
  try {
    const result = spawnSync("bash", [script, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, ORCA_CLEAN_TEMP_ROOT: root },
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`would remove: ${escape(stale)}`));
    assert.match(result.stdout, /would free 2 MB \(1 of 1 dirs\)/);
    assert.ok(existsSync(stale), "a dry run removes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes stale sonder temp dirs, keeps fresh ones and untouched names", () => {
  const root = makeRoot();
  const stale = join(root, "sonder-browser-old");
  const fresh = join(root, "sonder-local-check-fresh");
  const other = join(root, "other-old");
  for (const dir of [stale, fresh, other]) mkdirSync(dir);
  ageMinutesAgo(stale, 130);
  ageMinutesAgo(fresh, 10);
  ageMinutesAgo(other, 130);
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`removed: ${stale.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.stdout, /freed \d+ MB/);
    assert.ok(!existsSync(stale), "stale dir must be removed");
    assert.ok(existsSync(fresh), "a fresh dir must be kept");
    assert.ok(existsSync(other), "non-sonder dirs must be untouched");
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

test("prints nothing to clean when only fresh dirs exist", () => {
  const root = makeRoot();
  const fresh = join(root, "sonder-browser-fresh");
  mkdirSync(fresh);
  ageMinutesAgo(fresh, 10);
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /nothing to clean/);
    assert.ok(existsSync(fresh));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ORCA_CLEAN_TEMP_MAX_AGE_MIN sets the age bar (default 15 minutes)", () => {
  const root = makeRoot();
  const stale = join(root, "sonder-local-check-mid");
  mkdirSync(stale);
  ageMinutesAgo(stale, 30);
  try {
    const kept = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root, ORCA_CLEAN_TEMP_MAX_AGE_MIN: "60" });
    assert.equal(kept.status, 0, kept.stdout + kept.stderr);
    assert.match(kept.stdout, /nothing to clean/);
    assert.ok(existsSync(stale));

    const removed = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root });
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.match(removed.stdout, new RegExp(`removed: ${stale.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(!existsSync(stale));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
