import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dirBytes,
  staleFamilySize,
  readLocalFreeKb,
  commandExists,
  buildLowDiskWarning,
  warnLocalDisk,
} from "../scripts/check-local.mjs";

const GB = 1024 * 1024 * 1024;

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-local-disk-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// Create a sparse file of the given size: it reports the full st.size without consuming real
// disk space, so the test neither fills the disk nor builds a multi-gigabyte string in memory.
function makeSparseFile(p, bytes) {
  const fd = fs.openSync(p, "w");
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

// Populate a temp dir with the three stale families at known sizes (sparse) and a non-matching dir.
function makeFamilies(dir) {
  const browser = path.join(dir, "sonder-browser-abc");
  const check = path.join(dir, "sonder-local-check-xyz");
  const profile = path.join(dir, "playwright_chromiumdev_profile-qqq");
  fs.mkdirSync(browser, { recursive: true });
  fs.mkdirSync(check, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  makeSparseFile(path.join(browser, "db"), 2 * GB);
  makeSparseFile(path.join(check, "log"), 1 * GB);
  makeSparseFile(path.join(profile, "state"), 512 * 1024 * 1024); // 512 MB
  // A non-matching directory must be ignored.
  fs.mkdirSync(path.join(dir, "unrelated-dir"), { recursive: true });
  return { browser, check, profile };
}

test("dirBytes sums a directory tree", () =>
  withTempDir((dir) => {
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(dir, "a"), "x".repeat(100));
    fs.writeFileSync(path.join(sub, "b"), "x".repeat(250));
    assert.equal(dirBytes(dir), 350);
    assert.equal(dirBytes(path.join(dir, "missing")), 0);
  }));

test("staleFamilySize finds only the matching family and sums its size", () =>
  withTempDir((dir) => {
    makeFamilies(dir);
    const browser = staleFamilySize(dir, "sonder-browser-");
    assert.equal(browser.count, 1);
    assert.equal(browser.bytes, 2 * GB);
    const check = staleFamilySize(dir, "sonder-local-check-");
    assert.equal(check.bytes, 1 * GB);
    const profile = staleFamilySize(dir, "playwright_chromiumdev_profile-");
    assert.equal(profile.bytes, 512 * 1024 * 1024);
    const none = staleFamilySize(dir, "no-such-family-");
    assert.deepEqual(none, { count: 0, bytes: 0 });
  }));

test("readLocalFreeKb parses the 4th field of the 2nd line of an injected df", () =>
  withTempDir((dir) => {
    const fakeDf = path.join(dir, "df");
    fs.writeFileSync(
      fakeDf,
      "#!/bin/sh\nprintf 'Filesystem     1K-blocks     Used Available Use%% Mounted on\\nfake              10000000   9000000   1000000   90%% /\\n'\n",
      { mode: 0o755 },
    );
    assert.equal(readLocalFreeKb(fakeDf), 1_000_000);
  }));

test("readLocalFreeKb returns null when df is missing", () => {
  assert.equal(readLocalFreeKb(path.join(os.tmpdir(), "no-such-df-binary-xyz")), null);
});

test("commandExists reports PATH lookups without a child process", () => {
  assert.equal(commandExists("definitely-not-a-real-command-xyz"), false);
  assert.equal(commandExists("sh"), true);
});

test("buildLowDiskWarning is null when the disk is not low", () => {
  assert.equal(
    buildLowDiskWarning({ minFreeGb: 10, freeKb: 20 * 1024 * 1024, families: [], docker: false }),
    null,
  );
  // Exactly at the threshold is not low (only strictly below is).
  assert.equal(
    buildLowDiskWarning({ minFreeGb: 10, freeKb: 10 * 1024 * 1024, families: [], docker: false }),
    null,
  );
});

test("buildLowDiskWarning names the families, their sizes, and the docker hint", () => {
  const families = [
    { label: "/tmp/sonder-browser-*", bytes: 2 * GB },
    { label: "/tmp/sonder-local-check-*", bytes: 1 * GB },
    { label: "/tmp/playwright_chromiumdev_profile-*", bytes: 512 * 1024 * 1024 },
  ];
  const msg = buildLowDiskWarning({ minFreeGb: 10, freeKb: 3 * 1024 * 1024, families, docker: true });
  assert.match(msg, /low disk: \/ has 3\.0 GB free, below SONDER_LOCAL_MIN_FREE_GB=10/);
  assert.match(msg, /\/tmp\/sonder-browser-\* \(2\.0 GB\)/);
  assert.match(msg, /\/tmp\/sonder-local-check-\* \(1\.0 GB\)/);
  assert.match(msg, /\/tmp\/playwright_chromiumdev_profile-\* \(512\.0 MB\)/);
  assert.match(msg, /3\.5 GB total/);
  assert.match(msg, /docker builder prune/);
  // Without docker, no prune hint.
  const noDocker = buildLowDiskWarning({ minFreeGb: 10, freeKb: 3 * 1024 * 1024, families, docker: false });
  assert.doesNotMatch(noDocker, /docker builder prune/);
});

test("warnLocalDisk warns (hermetically) when the injected disk is low", () =>
  withTempDir((dir) => {
    makeFamilies(dir);
    const message = warnLocalDisk({
      minFreeGb: 10,
      freeKb: 3 * 1024 * 1024, // 3 GB free (injected, not the host disk)
      tmpDir: dir,
      docker: false,
      write: false,
    });
    assert.match(message, /low disk: \/ has 3\.0 GB free, below SONDER_LOCAL_MIN_FREE_GB=10/);
    assert.match(message, /sonder-browser-\* \(2\.0 GB\)/);
    assert.match(message, /sonder-local-check-\* \(1\.0 GB\)/);
    assert.match(message, /playwright_chromiumdev_profile-\* \(512\.0 MB\)/);
    assert.match(message, /3\.5 GB total/);
  }));

test("warnLocalDisk returns null when the injected disk has enough free space", () =>
  withTempDir((dir) => {
    makeFamilies(dir);
    const message = warnLocalDisk({
      minFreeGb: 10,
      freeKb: 40 * 1024 * 1024, // 40 GB free
      tmpDir: dir,
      docker: false,
      write: false,
    });
    assert.equal(message, null);
  }));

test("warnLocalDisk honours an injected df reading via readFreeKb", () =>
  withTempDir((dir) => {
    makeFamilies(dir);
    // Simulate a df that reports 2 GB free, without touching the host disk.
    const message = warnLocalDisk({
      minFreeGb: 10,
      readFreeKb: () => 2 * 1024 * 1024,
      tmpDir: dir,
      docker: true,
      write: false,
    });
    assert.match(message, /has 2\.0 GB free/);
    assert.match(message, /docker builder prune/);
  }));
