import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AlignmentPoolCoordinator,
  CTC_ENGINE,
  PoolBusyError,
  POOL_FAILURE_MESSAGE,
  clearPoolStaging,
  defaultPoolHosts,
  dispatchFullAlignmentJob,
  isolatedJobMediaRoot,
  isFullAlignmentJob,
  poolAlignmentFolder,
  poolJobNeedsStaging,
  poolRemoteAlignmentFolder,
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
  assert.deepEqual(job.poolErrors, { wsl: "ssh: probe failed", steamdeck: "staging: stage failed" });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("full alignment preserves SSH diagnostics and tries the next host", async () => {
  resetAlignmentPoolCoordinator(hosts);
  setAlignmentPoolDepsForTests({
    async probe(target) {
      if (target === "wsl-host")
        // Captured from an SSH probe against a closed local port.
        throw Object.assign(new Error("Command failed"), { stderr: "ssh: connect to host 127.0.0.1 port 1: Connection refused\r\n" });
      return true;
    },
    async exec() { return { code: 0, stdout: "", stderr: "" }; },
    async uploadFile() {},
  });
  const job = { id: "full", recordingId: "rec", mode: "anchored" } as AlignmentJob;
  const pool = await dispatchFullAlignmentJob(job, [], () => null);
  assert.equal(pool.hostId, "steamdeck");
  assert.deepEqual(job.poolErrors, { wsl: "ssh: connect to host 127.0.0.1 port 1: Connection refused" });
});

test("pool failure reasons are single-line and bounded", async () => {
  resetAlignmentPoolCoordinator(hosts);
  setAlignmentPoolDepsForTests({
    async probe() { throw new Error(`first line\n${"x".repeat(300)}`); },
    async exec() { throw new Error("staging must not run"); },
    async uploadFile() { throw new Error("staging must not run"); },
  });
  const job = { id: "bounded", recordingId: "rec", mode: "anchored" } as AlignmentJob;
  await assert.rejects(() => dispatchFullAlignmentJob(job, [], () => null), /Remote alignment failed/);
  assert.equal(job.poolErrors?.wsl?.length, 205);
  assert.match(job.poolErrors!.wsl!, /^ssh: first line x+$/);
  assert.equal(job.poolErrors?.steamdeck, job.poolErrors?.wsl);
});

test("CTC dispatch records HTTP health and SSH failures by host", async () => {
  const originalFetch = globalThis.fetch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-health-failure-"));
  resetAlignmentPoolCoordinator([
    hosts[0],
    { ...hosts[1], id: "lisa", sshTarget: "lisa-host", workerUrl: "http://lisa-worker" },
  ]);
  setAlignmentPoolDepsForTests({
    async probe() { throw new Error("Connection refused"); },
    async exec() { throw new Error("staging must not run"); },
    async uploadFile() { throw new Error("staging must not run"); },
  });
  globalThis.fetch = async (input) => String(input).includes("wsl-worker")
    ? new Response(null, { status: 503 })
    : Response.json({ ready: true, busy: false, stuck: false, mediaRoot: temp,
      ctc: { engine: CTC_ENGINE, ready: true, device: "cpu", precision: "float32", passageReady: true } });
  const job = { id: "ctc", recordingId: "rec", engine: CTC_ENGINE } as AlignmentJob;
  try {
    await assert.rejects(() => dispatchFullAlignmentJob(job, [], () => null), /Remote alignment failed/);
    assert.deepEqual(job.poolErrors, {
      wsl: "health: worker returned HTTP 503",
      lisa: "ssh: Connection refused",
    });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("CTC dispatch records SSH and staging exceptions without leaking leases", async () => {
  const originalFetch = globalThis.fetch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-dispatch-failure-"));
  const audio = path.join(temp, "audio.wav");
  fs.writeFileSync(audio, "audio");
  resetAlignmentPoolCoordinator([
    hosts[0],
    { ...hosts[1], id: "lisa", sshTarget: "lisa-host", workerUrl: "http://lisa-worker" },
  ]);
  setAlignmentPoolDepsForTests({
    async probe(target) { if (target === "wsl-host") throw new Error("ssh unavailable"); return true; },
    async exec() { return { code: 0, stdout: "", stderr: "" }; },
    async uploadFile() { throw new Error("disk full\nmore details"); },
  });
  globalThis.fetch = async (input) => {
    const lisa = String(input).includes("lisa-worker");
    return Response.json({ ready: true, busy: false, stuck: false, mediaRoot: temp,
      ctc: { engine: CTC_ENGINE, ready: true, device: lisa ? "cpu" : "cuda",
        precision: lisa ? "float32" : "float16", passageReady: true } });
  };
  const job = { id: "ctc", recordingId: "rec", engine: CTC_ENGINE } as AlignmentJob;
  try {
    await assert.rejects(() => dispatchFullAlignmentJob(job, [{ id: "track" }] as any[], () => audio), /Remote alignment failed/);
    assert.deepEqual(job.poolErrors, { wsl: "ssh: ssh unavailable", lisa: "staging: disk full more details" });
    const coord = (await import("../server/alignment-pool.ts")).getAlignmentPoolCoordinator();
    assert.equal(coord.activeOnHost("lisa"), 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a pool URL that aliases the production worker is never probed for CTC", async () => {
  const previousUrl = process.env.ALIGNMENT_WORKER_URL;
  const originalFetch = globalThis.fetch;
  process.env.ALIGNMENT_WORKER_URL = "http://127.0.0.1:3012";
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("unexpected worker request"); };
  resetAlignmentPoolCoordinator([
    { ...hosts[0], workerUrl: "http://localhost:3012" },
    { ...hosts[1], id: "lisa", workerUrl: "http://127.0.0.1:3012" },
  ]);
  try {
    await assert.rejects(() => dispatchFullAlignmentJob(
      { id: "ctc", recordingId: "rec", engine: CTC_ENGINE } as AlignmentJob, [], () => null,
    ), /Remote alignment failed/);
    delete process.env.ALIGNMENT_WORKER_URL;
    await assert.rejects(() => dispatchFullAlignmentJob(
      { id: "ctc", recordingId: "rec", engine: CTC_ENGINE } as AlignmentJob, [], () => null,
    ), /Remote alignment failed/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.ALIGNMENT_WORKER_URL;
    else process.env.ALIGNMENT_WORKER_URL = previousUrl;
  }
});

test("a staging failure is remembered while the other CTC worker is busy", async () => {
  const originalFetch = globalThis.fetch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-staging-"));
  const audio = path.join(temp, "audio.wav");
  fs.writeFileSync(audio, "audio");
  const staged: string[] = [];
  let lisaBusy = true;
  resetAlignmentPoolCoordinator([
    hosts[0],
    { ...hosts[1], id: "lisa", sshTarget: "lisa-host", workerUrl: "http://lisa-worker" },
  ]);
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    async exec() { return { code: 0, stdout: "", stderr: "" }; },
    async uploadFile(_local, _remote, target) {
      staged.push(target);
      if (target === "wsl-host") throw new Error("staging failed");
    },
  });
  globalThis.fetch = async (input) => {
    const lisa = String(input).includes("lisa-worker");
    return Response.json({ ready: true, busy: lisa && lisaBusy, stuck: false, mediaRoot: temp,
      ctc: { engine: CTC_ENGINE, ready: true, device: lisa ? "cpu" : "cuda",
        precision: lisa ? "float32" : "float16", anchorReady: true, passageReady: true } });
  };
  const job = { id: "ctc", recordingId: "rec", engine: CTC_ENGINE } as AlignmentJob;
  const tracks = [{ id: "track" }] as any[];
  try {
    await assert.rejects(() => dispatchFullAlignmentJob(job, tracks, () => audio, ["steamdeck"]), (error: Error) => {
      assert.ok(error instanceof PoolBusyError);
      assert.deepEqual(error.triedHosts, ["wsl"]);
      return true;
    });
    assert.deepEqual(job.poolErrors, { wsl: "staging: staging failed", lisa: "health: worker is busy" });
    lisaBusy = false;
    const pool = await dispatchFullAlignmentJob(job, tracks, () => audio, ["wsl"]);
    assert.equal(pool.hostId, "lisa");
    assert.deepEqual(pool.triedHosts, ["wsl", "lisa"]);
    assert.deepEqual(job.poolErrors, { wsl: "staging: staging failed" });
    assert.deepEqual(staged, ["wsl-host", "lisa-host"]);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("anchored CTC requires passage discovery but does not require Whisper", async () => {
  const originalFetch = globalThis.fetch;
  const previousUrl = process.env.ALIGNMENT_WORKER_URL;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-passage-"));
  const audio = path.join(temp, "audio.wav");
  fs.writeFileSync(audio, "audio");
  process.env.ALIGNMENT_WORKER_URL = "http://production-worker";
  resetAlignmentPoolCoordinator([hosts[0], { ...hosts[1], id: "lisa", workerUrl: "http://lisa-worker" }]);
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    async exec() { return { code: 0, stdout: "", stderr: "" }; },
    async uploadFile() {},
  });
  globalThis.fetch = async (input) => {
    const lisa = String(input).includes("lisa-worker");
    return Response.json({ ready: true, busy: false, stuck: false, mediaRoot: temp,
      ctc: { engine: CTC_ENGINE, ready: true, device: lisa ? "cpu" : "cuda",
        precision: lisa ? "float32" : "float16", anchorReady: false, passageReady: lisa } });
  };
  try {
    const pool = await dispatchFullAlignmentJob(
      { id: "ctc-passage", recordingId: "rec", engine: CTC_ENGINE, mode: "anchored" } as AlignmentJob,
      [{ id: "track" }] as any[], () => audio,
    );
    assert.equal(pool.hostId, "lisa");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.ALIGNMENT_WORKER_URL;
    else process.env.ALIGNMENT_WORKER_URL = previousUrl;
    fs.rmSync(temp, { recursive: true, force: true });
  }
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

test("default pool worker URLs target remote hosts, not loopback", () => {
  const configured = defaultPoolHosts();
  for (const host of configured) {
    assert.doesNotMatch(host.workerUrl, /127\.0\.0\.1/);
    assert.match(host.workerUrl, /^http:\/\//);
  }
});

test("local full-alignment cap allows only one concurrent local job", () => {
  const coord = new AlignmentPoolCoordinator(hosts);
  assert.ok(coord.tryAcquireLocal("local-a"));
  assert.equal(coord.tryAcquireLocal("local-b"), false);
  coord.releaseLocal("local-a");
  assert.ok(coord.tryAcquireLocal("local-b"));
});

test("poolAlignmentFolder keeps local cache paths for remote jobs", () => {
  const local = "/data/alignment/job-1";
  const job = {
    id: "job-1",
    pool: {
      hostId: "wsl",
      jobMediaRoot: "/pool/jobs/job-1/media",
    },
  } as AlignmentJob;
  assert.equal(poolAlignmentFolder(job, local), local);
  assert.equal(
    poolRemoteAlignmentFolder(job),
    "/pool/jobs/job-1/media/alignment/job-1",
  );
});

test("resume clears staging but keeps triedHosts for failover", () => {
  const prevPool = process.env.ALIGNMENT_POOL_ENABLED;
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  try {
    const job = {
      id: "j1",
      mode: "anchored",
      origin: "backfill",
      pool: {
        hostId: "wsl",
        attempt: 1,
        jobMediaRoot: "/pool/jobs/j1/media",
        workerUrl: "http://wsl-worker",
        triedHosts: ["wsl"],
        stagedAudio: { t1: "/pool/jobs/j1/media/tracks/t1.mp3" },
      },
    } as unknown as AlignmentJob;
    clearPoolStaging(job, job.pool!.triedHosts);
    assert.deepEqual(job.pool?.triedHosts, ["wsl"]);
    assert.equal(job.pool?.jobMediaRoot, "");
    assert.ok(poolJobNeedsStaging(job));
  } finally {
    if (prevPool === undefined) delete process.env.ALIGNMENT_POOL_ENABLED;
    else process.env.ALIGNMENT_POOL_ENABLED = prevPool;
  }
});

test("stageTracksOnHost links shared read-only models into job media root", async () => {
  const commands: string[] = [];
  const deps: PoolSshDeps = {
    async probe() {
      return true;
    },
    async exec(_target, command) {
      commands.push(command);
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile() {},
  };
  setAlignmentPoolDepsForTests(deps);
  resetAlignmentPoolCoordinator(hosts);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pool-audio-"));
  const audio = path.join(tmp, "track.mp3");
  fs.writeFileSync(audio, "audio");
  await dispatchFullAlignmentJob(
    { id: "models-job", recordingId: "rec-m", mode: "anchored" } as AlignmentJob,
    [{ id: "track-1" }] as any[],
    () => audio,
  );
  assert.ok(
    commands.some(
      (command) =>
        command.includes("ln -sfn '/pool/shared/alignment/models'") &&
        command.includes("/alignment/models"),
    ),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});
