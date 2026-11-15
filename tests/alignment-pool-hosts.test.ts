// Pool hosts come from configuration (ADR 0013): ALIGNMENT_POOL_HOSTS, or today's WSL and lisa built from the
// settings production already has. No code outside the default compares a host id.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWorkerLease,
  checkPoolHostsSetting,
  ctcHealthProblem,
  defaultPoolHosts,
  getAlignmentPoolCoordinator,
  resetAlignmentPoolCoordinator,
  setAlignmentPoolDepsForTests,
  CTC_ENGINE,
} from "../server/alignment-pool.ts";
import { fakePoolHosts } from "./fake-pool-host.ts";

const SETTINGS = [
  "ALIGNMENT_POOL_HOSTS", "ALIGNMENT_POOL_WSL_HOST", "ALIGNMENT_POOL_LISA_HOST",
  "ALIGNMENT_POOL_WSL_WORKER_URL", "ALIGNMENT_POOL_LISA_WORKER_URL", "ALIGNMENT_POOL_REMOTE_ROOT",
];
const saved = Object.fromEntries(SETTINGS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const set = (values: Record<string, string>) => {
  for (const key of SETTINGS) delete process.env[key];
  Object.assign(process.env, values);
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
});

test("the default is today's WSL and lisa, from the settings production already has", () => {
  set({});
  assert.deepEqual(defaultPoolHosts(), [
    { id: "wsl", sshTarget: "192.168.1.119", device: "cuda", precision: "float16", rank: 1, maxConcurrent: 3,
      remoteWorkRoot: "~/sonder-replication/alignment-pool", workerUrl: "http://192.168.1.119:3012" },
    { id: "lisa", sshTarget: "lisa", device: "cpu", precision: "float32", rank: 2, maxConcurrent: 1,
      remoteWorkRoot: "~/sonder-replication/alignment-pool", workerUrl: "http://lisa:3012" },
  ]);
  set({
    ALIGNMENT_POOL_WSL_HOST: "jahn@10.0.0.5",
    ALIGNMENT_POOL_LISA_HOST: "lisa-alias",
    ALIGNMENT_POOL_LISA_WORKER_URL: "https://audiobooks.example/sonder-ctc",
  });
  const [wsl, lisa] = defaultPoolHosts();
  assert.equal(wsl.sshTarget, "jahn@10.0.0.5");
  assert.equal(wsl.workerUrl, "http://10.0.0.5:3012", "the worker URL defaults to port 3012 on the SSH host");
  assert.equal(lisa.sshTarget, "lisa-alias");
  assert.equal(lisa.workerUrl, "https://audiobooks.example/sonder-ctc");
  set({ ALIGNMENT_POOL_WSL_WORKER_URL: "http://wsl.example:4000" });
  assert.equal(defaultPoolHosts()[0].workerUrl, "http://wsl.example:4000");
});

test("ALIGNMENT_POOL_HOSTS replaces the default; hosts are tried in rank order", () => {
  set({
    ALIGNMENT_POOL_WSL_HOST: "ignored-when-hosts-are-configured",
    ALIGNMENT_POOL_HOSTS: JSON.stringify([
      { id: "gpu-b", sshTarget: "gpu-b", workerUrl: "http://gpu-b:3012", device: "cuda", precision: "float16", rank: 2, maxConcurrent: 4 },
      { id: "cpu-c", sshTarget: "cpu-c", workerUrl: "http://cpu-c:3012", device: "cpu", precision: "float32", rank: 1, remoteWorkRoot: "/srv/pool" },
      { id: "cpu-d", sshTarget: "cpu-d", workerUrl: "http://cpu-d:3012", device: "cpu", precision: "float32" },
    ]),
  });
  const hosts = defaultPoolHosts();
  assert.deepEqual(hosts.map((host) => [host.id, host.rank]), [["cpu-c", 1], ["gpu-b", 2], ["cpu-d", 3]]);
  assert.equal(hosts[1].maxConcurrent, 4);
  assert.equal(hosts[2].maxConcurrent, 1);
  assert.equal(hosts[0].remoteWorkRoot, "/srv/pool");
  assert.equal(hosts[1].remoteWorkRoot, "~/sonder-replication/alignment-pool");
  resetAlignmentPoolCoordinator();
  assert.deepEqual(getAlignmentPoolCoordinator().listHosts().map((host) => host.id), ["cpu-c", "gpu-b", "cpu-d"]);
});

test("an invalid ALIGNMENT_POOL_HOSTS is refused with the reason, and no pool is built from it", () => {
  const cases: [string, RegExp][] = [
    ["not json", /ALIGNMENT_POOL_HOSTS is not JSON/],
    ["[]", /non-empty JSON array/],
    [JSON.stringify([{ id: "a", sshTarget: "a", workerUrl: "http://a", precision: "float32" }]), /\[0\]\.device must be a non-empty string/],
    [JSON.stringify([{ id: "a b", sshTarget: "a", workerUrl: "http://a", device: "cpu", precision: "float32" }]), /\[0\]\.id may use only/],
    [JSON.stringify([{ id: "a", sshTarget: "a", workerUrl: "nope", device: "cpu", precision: "float32" }]), /\[0\]\.workerUrl is not a URL/],
    [JSON.stringify([{ id: "a", sshTarget: "a", workerUrl: "http://a", device: "cpu", precision: "float32", slots: 2 }]), /\[0\]\.slots is not a host setting/],
    [JSON.stringify([{ id: "a", sshTarget: "a", workerUrl: "http://a", device: "cpu", precision: "float32", maxConcurrent: 0 }]), /maxConcurrent must be an integer of at least 1/],
    [JSON.stringify([
      { id: "a", sshTarget: "a", workerUrl: "http://a", device: "cpu", precision: "float32" },
      { id: "a", sshTarget: "b", workerUrl: "http://b", device: "cpu", precision: "float32" },
    ]), /host ids must be unique/],
  ];
  for (const [raw, reason] of cases) {
    set({ ALIGNMENT_POOL_HOSTS: raw });
    assert.throws(() => defaultPoolHosts(), reason, raw);
    assert.throws(() => checkPoolHostsSetting(), (error: Error) =>
      reason.test(error.message) && /Fix ALIGNMENT_POOL_HOSTS, or unset it/.test(error.message), raw);
    resetAlignmentPoolCoordinator();
    assert.throws(() => getAlignmentPoolCoordinator(), reason, raw);
  }
});

test("an unset or empty ALIGNMENT_POOL_HOSTS means the default hosts", () => {
  for (const raw of [undefined, "", "   "]) {
    set(raw === undefined ? {} : { ALIGNMENT_POOL_HOSTS: raw });
    checkPoolHostsSetting();
    resetAlignmentPoolCoordinator();
    assert.deepEqual(getAlignmentPoolCoordinator().listHosts().map((host) => host.id), ["wsl", "lisa"], String(raw));
  }
});

test("a worker must report the device and precision its host is configured with", () => {
  const health = (device: string, precision: string) => ({ ready: true, busy: false, stuck: false, mediaRoot: "/media",
    ctc: { engine: CTC_ENGINE, ready: true, device, precision } });
  set({});
  const [wsl, lisa] = defaultPoolHosts();
  assert.equal(ctcHealthProblem(wsl, health("cuda", "float16")), null);
  assert.equal(ctcHealthProblem(lisa, health("cpu", "float32")), null);
  assert.equal(ctcHealthProblem(lisa, health("cuda", "float16")), "worker runs on cuda/float16, expected cpu/float32");
  assert.equal(ctcHealthProblem({ device: "rocm", precision: "bfloat16" }, health("rocm", "bfloat16")), null);
});

test("leases use whatever hosts are configured: first by rank, then the next one on failover", async () => {
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  const temp = mkdtempSync(join(tmpdir(), "sonder-pool-hosts-"));
  try {
    const fake = fakePoolHosts(temp, [
      { id: "gpu-b", device: "rocm", precision: "bfloat16" },
      { id: "cpu-c", device: "cpu", precision: "float32" },
    ]);
    set({ ALIGNMENT_POOL_HOSTS: JSON.stringify(Object.values(fake.hosts).map((host) => ({
      id: host.id, sshTarget: host.sshTarget, workerUrl: host.workerUrl, device: host.device, precision: host.precision,
      rank: host.id === "cpu-c" ? 1 : 2,
    }))) });
    resetAlignmentPoolCoordinator();
    setAlignmentPoolDepsForTests(fake.deps);
    globalThis.fetch = fake.fetch;
    const audio = join(temp, "track.wav");
    writeFileSync(audio, "audio");
    const lease = await acquireWorkerLease({ id: "configured", recordingId: "rec", mode: "chapters",
      tracks: [{ id: "t1" }] as any[], localAudio: () => audio, kind: "job" });
    assert.equal(lease.hostId, "cpu-c");
    assert.equal(lease.workerUrl, "http://cpu-c-worker.test");
    await lease.failover();
    assert.equal(lease.hostId, "gpu-b");
    assert.equal(lease.device, "rocm");
    assert.equal(lease.canFailover, false);
    await lease.release("finished");
    assert.deepEqual([...fake.stagedFolders("cpu-c"), ...fake.stagedFolders("gpu-b")], []);
  } finally {
    delete process.env.ALIGNMENT_POOL_ENABLED;
    rmSync(temp, { recursive: true, force: true });
  }
});
