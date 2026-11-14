import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AlignmentPoolCoordinator,
  CTC_ENGINE,
  PoolBusyError,
  POOL_FAILURE_MESSAGE,
  clearPoolStaging,
  defaultPoolHosts,
  dispatchFullAlignmentJob,
  getAlignmentPoolCoordinator,
  getAlignmentPoolStatus,
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
import { AlignmentPoolStatusView } from "../src/components/AlignmentPoolStatusView.tsx";
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
    id: "lisa",
    sshTarget: "lisa-host",
    maxConcurrent: 1,
    remoteWorkRoot: "/pool",
    workerUrl: "http://lisa-worker",
  },
];

/** Both CTC workers healthy, with their media root in `mediaRoot`. */
function healthyCtcWorkers(mediaRoot: string): typeof fetch {
  return async (input) => {
    const lisa = String(input).includes("lisa-worker");
    return Response.json({ ready: true, busy: false, stuck: false, mediaRoot,
      ctc: { engine: CTC_ENGINE, ready: true, device: lisa ? "cpu" : "cuda",
        precision: lisa ? "float32" : "float16", anchorReady: true, passageReady: true } });
  };
}

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

test("a CTC host takes up to its reported slots and one job per recording", () => {
  const coord = new AlignmentPoolCoordinator(hosts);
  assert.ok(coord.tryAcquireCtc("wsl", "j1", "rec-1", 2));
  assert.ok(coord.tryAcquireCtc("wsl", "j2", "rec-2", 2));
  assert.equal(coord.tryAcquireCtc("wsl", "j3", "rec-3", 2), false);
  assert.equal(coord.tryAcquireCtc("lisa", "j4", "rec-1"), false);
  assert.ok(coord.tryAcquireCtc("lisa", "j4", "rec-4"));
  assert.equal(coord.tryAcquireCtc("lisa", "j5", "rec-5"), false);
});

test("full alignment preserves SSH diagnostics and tries the next host", async () => {
  const originalFetch = globalThis.fetch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-ssh-diagnostics-"));
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
  globalThis.fetch = healthyCtcWorkers(temp);
  try {
    const job = { id: "full", recordingId: "rec", mode: "anchored", engine: CTC_ENGINE } as AlignmentJob;
    const pool = await dispatchFullAlignmentJob(job, [], () => null);
    assert.equal(pool.hostId, "lisa");
    assert.deepEqual(job.poolErrors, { wsl: "ssh: connect to host 127.0.0.1 port 1: Connection refused" });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("pool failure reasons are single-line and bounded", async () => {
  const originalFetch = globalThis.fetch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-bounded-"));
  resetAlignmentPoolCoordinator(hosts);
  setAlignmentPoolDepsForTests({
    async probe() { throw new Error(`first line\n${"x".repeat(300)}`); },
    async exec() { throw new Error("staging must not run"); },
    async uploadFile() { throw new Error("staging must not run"); },
  });
  globalThis.fetch = healthyCtcWorkers(temp);
  try {
    const job = { id: "bounded", recordingId: "rec", mode: "anchored", engine: CTC_ENGINE } as AlignmentJob;
    await assert.rejects(() => dispatchFullAlignmentJob(job, [], () => null), /Remote alignment failed/);
    assert.equal(job.poolErrors?.wsl?.length, 205);
    assert.match(job.poolErrors!.wsl!, /^ssh: first line x+$/);
    assert.equal(job.poolErrors?.lisa, job.poolErrors?.wsl);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
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
  const originalFetch = globalThis.fetch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-isolated-"));
  const staged: string[] = [];
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    async exec(_target, command) {
      staged.push(command);
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile(_local, remote) { staged.push(`upload:${remote}`); },
  });
  resetAlignmentPoolCoordinator(hosts);
  globalThis.fetch = healthyCtcWorkers(temp);
  const audio = path.join(temp, "track.mp3");
  fs.writeFileSync(audio, "audio");
  try {
    const job = { id: "job-99", recordingId: "rec-99", mode: "anchored", engine: CTC_ENGINE } as AlignmentJob;
    const pool = await dispatchFullAlignmentJob(job, [{ id: "track-1" }] as any[], () => audio);
    assert.equal(pool.hostId, "wsl");
    assert.equal(pool.jobMediaRoot, path.join(temp, "alignment", "pool-jobs", "job-99"));
    assert.equal(pool.stagedAudio["track-1"], path.join(pool.jobMediaRoot, "tracks", "track-1"));
    assert.ok(staged.some((line) => line.includes("pool-jobs/job-99/alignment/job-99")));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
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

test("the default pool is WSL and lisa; the Steam Deck is no longer a host", () => {
  const previous = process.env.ALIGNMENT_POOL_DECK_HOST;
  process.env.ALIGNMENT_POOL_DECK_HOST = "deck@steamdeck";
  try {
    assert.deepEqual(defaultPoolHosts().map((host) => host.id), ["wsl", "lisa"]);
  } finally {
    if (previous === undefined) delete process.env.ALIGNMENT_POOL_DECK_HOST;
    else process.env.ALIGNMENT_POOL_DECK_HOST = previous;
  }
});

test("default pool worker URLs target remote hosts, not loopback", () => {
  const configured = defaultPoolHosts();
  for (const host of configured) {
    assert.doesNotMatch(host.workerUrl, /127\.0\.0\.1/);
    assert.match(host.workerUrl, /^http:\/\//);
  }
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

test("getAlignmentPoolStatus makes no HTTP or SSH requests when pool is disabled", async () => {
  const prevPool = process.env.ALIGNMENT_POOL_ENABLED;
  const originalFetch = globalThis.fetch;
  delete process.env.ALIGNMENT_POOL_ENABLED;
  globalThis.fetch = async () => {
    throw new Error("unexpected fetch while pool is disabled");
  };
  setAlignmentPoolDepsForTests({
    async probe() {
      throw new Error("unexpected ssh probe while pool is disabled");
    },
    async exec() {
      throw new Error("unexpected ssh exec");
    },
    async uploadFile() {
      throw new Error("unexpected scp upload");
    },
  });
  resetAlignmentPoolCoordinator([
    hosts[0],
    { ...hosts[1], id: "lisa", sshTarget: "lisa-host", workerUrl: "http://user:secret@lisa-worker:3012" },
  ]);
  try {
    const status = await getAlignmentPoolStatus({ fresh: true });
    assert.equal(status.enabled, false);
    assert.equal(status.engine, "ctc");
    assert.deepEqual(
      status.hosts.map((host) => ({ id: host.id, reachable: host.reachable, device: host.device, workerUrl: host.workerUrl })),
      [
        { id: "wsl", reachable: false, device: null, workerUrl: "http://wsl-worker" },
        { id: "lisa", reachable: false, device: null, workerUrl: "http://lisa-worker:3012" },
      ],
    );
    const markup = renderToStaticMarkup(createElement(AlignmentPoolStatusView, { pool: status }));
    assert.match(markup, /Remote alignment pool is disabled\./);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevPool === undefined) delete process.env.ALIGNMENT_POOL_ENABLED;
    else process.env.ALIGNMENT_POOL_ENABLED = prevPool;
  }
});

test("getAlignmentPoolStatus and AlignmentPoolStatusView show why a host was skipped and clear after recovery", async () => {
  const prevPool = process.env.ALIGNMENT_POOL_ENABLED;
  const originalFetch = globalThis.fetch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pool-admin-status-"));
  const audio = path.join(temp, "audio.wav");
  fs.writeFileSync(audio, "audio");
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  let failWslStaging = true;
  resetAlignmentPoolCoordinator([
    hosts[0],
    { ...hosts[1], id: "lisa", sshTarget: "lisa-host", workerUrl: "http://lisa-worker:3012" },
  ]);
  setAlignmentPoolDepsForTests({
    async probe() {
      return true;
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile(_local, _remote, target) {
      if (target === "wsl-host" && failWslStaging) throw new Error("No space left on device");
    },
  });
  globalThis.fetch = async (input) => {
    const isLisa = String(input).includes("lisa-worker");
    return Response.json({
      ready: true,
      engine: "aeneas-1.7.3",
      busy: false,
      stuck: false,
      busySeconds: null,
      lastTimeout: null,
      mediaRoot: temp,
      ctc: {
        engine: CTC_ENGINE,
        ready: true,
        device: isLisa ? "cpu" : "cuda",
        precision: isLisa ? "float32" : "float16",
        anchorReady: true,
        passageReady: true,
      },
    });
  };
  try {
    const firstJob = { id: "job-skip-wsl", recordingId: "rec-1", engine: CTC_ENGINE } as AlignmentJob;
    const pool = await dispatchFullAlignmentJob(firstJob, [{ id: "t1" }] as any[], () => audio);
    assert.equal(pool.hostId, "lisa");

    const status = await getAlignmentPoolStatus({ fresh: true });
    assert.equal(status.enabled, true);
    const wsl = status.hosts.find((host) => host.id === "wsl")!;
    const lisa = status.hosts.find((host) => host.id === "lisa")!;
    assert.equal(wsl.reachable, true);
    assert.equal(wsl.device, "cuda");
    assert.equal(wsl.precision, "float16");
    assert.equal(wsl.busy, false);
    assert.equal(wsl.lastError, "staging: No space left on device");
    assert.equal(lisa.reachable, true);
    assert.equal(lisa.device, "cpu");
    assert.equal(lisa.busy, true);
    assert.equal(lisa.activeJobs, 1);
    assert.equal(lisa.lastError, null);

    const markup = renderToStaticMarkup(createElement(AlignmentPoolStatusView, { pool: status }));
    assert.match(markup, /wsl/);
    assert.match(markup, /Reachable/);
    assert.match(markup, /cuda · float16/);
    assert.match(markup, /Last error: staging: No space left on device/);
    assert.match(markup, /lisa/);
    assert.match(markup, /cpu · float32/);
    assert.match(markup, /Busy/);

    getAlignmentPoolCoordinator().release("lisa", firstJob.id, firstJob.recordingId);
    failWslStaging = false;
    const recoveredJob = { id: "job-recover-wsl", recordingId: "rec-2", engine: CTC_ENGINE } as AlignmentJob;
    const recovered = await dispatchFullAlignmentJob(recoveredJob, [{ id: "t1" }] as any[], () => audio);
    assert.equal(recovered.hostId, "wsl");
    const afterRecovery = await getAlignmentPoolStatus();
    const wslRecovered = afterRecovery.hosts.find((host) => host.id === "wsl")!;
    assert.equal(wslRecovered.lastError, null);
    assert.equal(wslRecovered.busy, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevPool === undefined) delete process.env.ALIGNMENT_POOL_ENABLED;
    else process.env.ALIGNMENT_POOL_ENABLED = prevPool;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("getAlignmentPoolStatus surfaces incompatible device and SSH probe errors and caches probes until fresh", async () => {
  const prevPool = process.env.ALIGNMENT_POOL_ENABLED;
  const originalFetch = globalThis.fetch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pool-probe-cache-"));
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  let httpCalls = 0;
  let sshCalls = 0;
  resetAlignmentPoolCoordinator([
    hosts[0],
    { ...hosts[1], id: "lisa", sshTarget: "lisa-host", workerUrl: "http://lisa-worker:3012" },
  ]);
  setAlignmentPoolDepsForTests({
    async probe(target) {
      sshCalls++;
      if (target === "lisa-host") throw new Error("Permission denied (publickey)");
      return true;
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile() {},
  });
  globalThis.fetch = async (input) => {
    httpCalls++;
    const isLisa = String(input).includes("lisa-worker");
    // WSL mistakenly running on CPU instead of CUDA; Lisa healthy on CPU.
    return Response.json({
      ready: true,
      engine: "aeneas-1.7.3",
      busy: false,
      stuck: false,
      mediaRoot: temp,
      ctc: {
        engine: CTC_ENGINE,
        ready: true,
        device: "cpu",
        precision: "float32",
        passageReady: true,
      },
      host: isLisa ? "lisa" : "wsl",
    });
  };
  try {
    const first = await getAlignmentPoolStatus({ fresh: true });
    assert.equal(httpCalls, 2);
    assert.equal(sshCalls, 2);
    const wsl = first.hosts.find((host) => host.id === "wsl")!;
    const lisa = first.hosts.find((host) => host.id === "lisa")!;
    assert.equal(wsl.reachable, false);
    assert.equal(wsl.device, "cpu");
    assert.equal(wsl.lastError, "health: worker is not ready or has incompatible CTC settings");
    assert.equal(lisa.reachable, false);
    assert.equal(lisa.device, "cpu");
    assert.equal(lisa.lastError, "ssh: Permission denied (publickey)");

    const cached = await getAlignmentPoolStatus();
    assert.equal(httpCalls, 2);
    assert.equal(sshCalls, 2);
    assert.equal(cached.checkedAt, first.checkedAt);

    await getAlignmentPoolStatus({ fresh: true });
    assert.equal(httpCalls, 4);
    assert.equal(sshCalls, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevPool === undefined) delete process.env.ALIGNMENT_POOL_ENABLED;
    else process.env.ALIGNMENT_POOL_ENABLED = prevPool;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a transient health failure does not exclude the host from a later alignment dispatch", async () => {
  const originalFetch = globalThis.fetch;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-health-"));
  const audio = path.join(temp, "audio.wav");
  fs.writeFileSync(audio, "audio");
  resetAlignmentPoolCoordinator([
    hosts[0],
    { ...hosts[1], id: "lisa", sshTarget: "lisa-host", workerUrl: "http://lisa-worker" },
  ]);
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    async exec() { return { code: 0, stdout: "", stderr: "" }; },
    async uploadFile() {},
  });
  let wslDown = true;
  globalThis.fetch = async (input) => {
    const lisa = String(input).includes("lisa-worker");
    if (!lisa && wslDown) throw new Error("connect ECONNREFUSED");
    return Response.json({ ready: true, busy: lisa, stuck: false, mediaRoot: temp,
      ctc: { engine: CTC_ENGINE, ready: true, device: lisa ? "cpu" : "cuda",
        precision: lisa ? "float32" : "float16", anchorReady: true, passageReady: true } });
  };
  const job = { id: "ctc-health", recordingId: "rec-health", engine: CTC_ENGINE } as AlignmentJob;
  const tracks = [{ id: "track" }] as any[];
  try {
    await assert.rejects(() => dispatchFullAlignmentJob(job, tracks, () => audio, []), (error: Error) => {
      assert.ok(error instanceof PoolBusyError);
      // WSL was unreachable, not tried: the job must try it again on the next tick.
      assert.deepEqual(error.triedHosts, []);
      return true;
    });
    wslDown = false;
    const pool = await dispatchFullAlignmentJob(job, tracks, () => audio, []);
    assert.equal(pool.hostId, "wsl");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
