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

test("refuses while a Playwright process is live and removes nothing", () => {
  const root = makeRoot();
  const old = join(root, "sonder-browser-live");
  mkdirSync(old);
  ageMinutesAgo(old, 130);
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root, ORCA_CLEAN_TEMP_PLAYWRIGHT: "true" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing/);
    assert.ok(existsSync(old), "a live Playwright run must keep even stale dirs");
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
  ageMinutesAgo(fresh, 110);
  ageMinutesAgo(other, 130);
  try {
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root, ORCA_CLEAN_TEMP_PLAYWRIGHT: "false" });
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
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root, ORCA_CLEAN_TEMP_PLAYWRIGHT: "false" });
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
    const result = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root, ORCA_CLEAN_TEMP_PLAYWRIGHT: "false" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /nothing to clean/);
    assert.ok(existsSync(fresh));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ORCA_CLEAN_TEMP_MAX_AGE_MIN lowers the age bar", () => {
  const root = makeRoot();
  const stale = join(root, "sonder-local-check-mid");
  mkdirSync(stale);
  ageMinutesAgo(stale, 110);
  try {
    const kept = cleanTemp({ ORCA_CLEAN_TEMP_ROOT: root, ORCA_CLEAN_TEMP_PLAYWRIGHT: "false" });
    assert.equal(kept.status, 0, kept.stdout + kept.stderr);
    assert.match(kept.stdout, /nothing to clean/);
    assert.ok(existsSync(stale));

    const removed = cleanTemp({
      ORCA_CLEAN_TEMP_ROOT: root,
      ORCA_CLEAN_TEMP_MAX_AGE_MIN: "60",
      ORCA_CLEAN_TEMP_PLAYWRIGHT: "false",
    });
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.match(removed.stdout, new RegExp(`removed: ${stale.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(!existsSync(stale));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
