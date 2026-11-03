import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AlignmentPoolCoordinator,
  POOL_FAILURE_MESSAGE,
  defaultPoolHosts,
  dispatchFullAlignmentJob,
  isolatedJobMediaRoot,
  isFullAlignmentJob,
  resetAlignmentPoolCoordinator,
  setAlignmentPoolDepsForTests,
  stageTracksLocally,
  type PoolHost,
  type PoolSshDeps,
} from "../server/alignment-pool.ts";
import type { AlignmentJob } from "../src/reading-types.ts";

const hosts: PoolHost[] = [
  {
    id: "wsl",
    sshTarget: "wsl-host",
    maxConcurrent: 3,
    remoteWorkRoot: "/pool",
    workerUrl: "http://wsl-worker",
  },
  {
    id: "steamdeck",
    sshTarget: "deck-host",
    maxConcurrent: 1,
    remoteWorkRoot: "/pool",
    workerUrl: "http://deck-worker",
  },
];

afterEach(() => {
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator(hosts);
});

test("isFullAlignmentJob excludes projected maps", () => {
  assert.equal(
    isFullAlignmentJob({ mode: "anchored", origin: "projected" } as AlignmentJob),
    false,
  );
  assert.equal(
    isFullAlignmentJob({ mode: "anchored", origin: "backfill" } as AlignmentJob),
    true,
  );
});

test("isolated staging paths are per job", () => {
  const host = hosts[0];
  const a = isolatedJobMediaRoot(host, "job-a");
  const b = isolatedJobMediaRoot(host, "job-b");
  assert.notEqual(a, b);
  assert.match(a, /\/jobs\/job-a\/media$/);
});

test("host caps block a fourth WSL slot and a second deck slot", () => {
  const coord = new AlignmentPoolCoordinator(hosts);
  assert.ok(coord.tryAcquire("wsl", "j1", "rec-1"));
  assert.ok(coord.tryAcquire("wsl", "j2", "rec-2"));
  assert.ok(coord.tryAcquire("wsl", "j3", "rec-3"));
  assert.equal(coord.tryAcquire("wsl", "j4", "rec-4"), false);
  assert.ok(coord.tryAcquire("steamdeck", "d1", "rec-d1"));
  assert.equal(coord.tryAcquire("steamdeck", "d2", "rec-d2"), false);
});

test("the same recording cannot run locally while a remote lease is held", () => {
  const coord = new AlignmentPoolCoordinator(hosts);
  assert.ok(coord.tryAcquire("wsl", "remote-job", "rec-x"));
  assert.throws(
    () => coord.localFullAlignmentStarting("rec-x", "local-job"),
    /remote pool host/,
  );
  assert.ok(coord.canUseLocalWorker("rec-y"));
});

test("dispatch retries on another host then surfaces POOL_FAILURE_MESSAGE", async () => {
  const log: string[] = [];
  const deps: PoolSshDeps = {
    async probe(target) {
      log.push(`probe:${target}`);
      return target !== "wsl-host";
    },
    async exec(target, command) {
      log.push(`exec:${target}:${command}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile(localPath, remotePath, target) {
      log.push(`upload:${target}:${remotePath}`);
      if (target === "deck-host") throw new Error("stage failed");
    },
  };
  setAlignmentPoolDepsForTests(deps);
  resetAlignmentPoolCoordinator(hosts);
  const job = {
    id: "align-1",
    recordingId: "rec-1",
    mode: "anchored",
    origin: "backfill",
  } as AlignmentJob;
  const tracks = [{ id: "t0" }] as any[];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pool-audio-"));
  const audio = path.join(tmp, "t0.mp3");
  fs.writeFileSync(audio, "x");
  await assert.rejects(
    () =>
      dispatchFullAlignmentJob(job, tracks, () => audio),
    (error: Error) => error.message === POOL_FAILURE_MESSAGE,
  );
  assert.ok(log.some((line) => line.includes("probe:deck-host")));
  assert.ok(log.some((line) => line.includes("upload:deck-host")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("dispatch stages audio under an isolated job media root", async () => {
  const staged: string[] = [];
  const deps: PoolSshDeps = {
    async probe() {
      return true;
    },
    async exec(_target, command) {
      staged.push(command);
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile(_local, remote) {
      staged.push(`upload:${remote}`);
    },
  };
  setAlignmentPoolDepsForTests(deps);
  resetAlignmentPoolCoordinator(hosts);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pool-audio-"));
  const audio = path.join(tmp, "track.mp3");
  fs.writeFileSync(audio, "audio");
  const job = {
    id: "job-99",
    recordingId: "rec-99",
    mode: "anchored",
  } as AlignmentJob;
  const pool = await dispatchFullAlignmentJob(
    job,
    [{ id: "track-1" }] as any[],
    () => audio,
  );
  assert.equal(pool.hostId, "wsl");
  assert.match(pool.jobMediaRoot, /\/jobs\/job-99\/media$/);
  assert.equal(pool.stagedAudio["track-1"], `${pool.jobMediaRoot}/tracks/track-1.mp3`);
  assert.ok(staged.some((line) => line.includes("jobs/job-99/media")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("stageTracksLocally mirrors isolated layout for fixtures", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pool-local-"));
  const audio = path.join(base, "audio.bin");
  fs.writeFileSync(audio, "data");
  const staged = await stageTracksLocally(
    base,
    "fixture-job",
    [{ id: "trk" }] as any[],
    () => audio,
  );
  assert.match(staged.jobMediaRoot, /jobs\/fixture-job\/media$/);
  assert.equal(staged.stagedAudio.trk, path.join(staged.jobMediaRoot, "tracks", "trk"));
  fs.rmSync(base, { recursive: true, force: true });
});

test("default pool host caps match v1 WSL 3 and deck 1", () => {
  const configured = defaultPoolHosts();
  assert.equal(configured.find((h) => h.id === "wsl")?.maxConcurrent, 3);
  assert.equal(configured.find((h) => h.id === "steamdeck")?.maxConcurrent, 1);
});
