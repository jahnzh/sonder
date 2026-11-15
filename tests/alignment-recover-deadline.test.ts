// /api/alignments/recover has one deadline over remote staging, scoring and cleanup (#279 review HIGH-1).
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-recover-deadline-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
delete process.env.ALIGNMENT_WORKER_URL;
process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
const { CTC_ENGINE, installCtcTestPool, uninstallCtcTestPool, withCtcPoolFetch } =
  await import("./ctc-test-pool.ts");
const { workerUrl } = installCtcTestPool(temp);
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { readerFixture } = await import("./reader-fixture.ts");
const alignment = await import("../server/alignment.ts");
const pool = await import("../server/alignment-pool.ts");
const { getAlignmentPoolCoordinator, setAlignmentPoolDepsForTests } = pool;
const app = await createApp();
const original = fetch;
after(async () => {
  globalThis.fetch = original;
  alignment.setRecoverDeadlineForTests?.(null);
  pool.setProbeCleanupTimingForTests?.(null);
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  uninstallCtcTestPool();
  alignment.stopAlignments();
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
afterEach(() => {
  globalThis.fetch = original;
  installCtcTestPool(temp);
});
const ebook = "recover-deadline-edition";
const file = join(temp, "media", "ebooks", "recover.epub");
writeFileSync(file, await readerFixture());
db.insert(s.ebookEditions)
  .values({ id: ebook, workId: "work-alice", format: "epub", source: file })
  .run();

const DEADLINE_MS = 300;
// Short waits so a released lease is visible quickly; the base code has no such hook (optional call).
const CLEANUP_MS = 200;
pool.setProbeCleanupTimingForTests?.({ cleanupMs: CLEANUP_MS, slackMs: 100, pollMs: 20 });

/** A child process that never finishes on its own; it ends only when its signal aborts, as execFile's does. */
function stalledChild(signal: AbortSignal | undefined, killed: string[], name: string) {
  return new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => {
      killed.push(name);
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    }, { once: true });
  });
}

async function recover() {
  alignment.setRecoverDeadlineForTests(DEADLINE_MS);
  const started = Date.now();
  // Without a deadline the request never answers; give up well after the deadline so the test fails instead of hanging.
  const response = await Promise.race([
    app.inject({
      method: "POST",
      url: "/api/alignments/recover",
      payload: { ebookId: ebook, recordingId: "recording-alice", trackId: "alice-0", position: 20 },
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), DEADLINE_MS + 3000)),
  ]);
  return { response, elapsed: Date.now() - started };
}

async function leaseFreed() {
  const coord = getAlignmentPoolCoordinator();
  for (let i = 0; i < 300 && (coord.activeOnHost("wsl") || coord.activeOnHost("lisa")); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(coord.activeOnHost("wsl"), 0);
  assert.equal(coord.activeOnHost("lisa"), 0);
  // The recording lease is free too: another job can take this recording.
  assert.equal(coord.tryAcquireCtc("wsl", "after-recover", "recording-alice", 3), true);
  coord.releaseJob("after-recover");
}

function assertTimedOut(result: Awaited<ReturnType<typeof recover>>) {
  assert.ok(result.response, "the recovery request did not answer after its deadline");
  assert.equal(result.response.statusCode, 400, result.response.body);
  assert.equal(result.response.json().error, alignment.RECOVER_TIMEOUT_MESSAGE);
  assert.ok(result.elapsed < DEADLINE_MS + 2000, `answered after ${result.elapsed} ms`);
}

test("the recovery deadline is the old Whisper call's 180 seconds", () => {
  assert.equal(alignment.RECOVER_DEADLINE_MS, 180_000);
});

test("recovery stalled in remote staging answers at its deadline, kills the upload and frees the lease", async () => {
  const killed: string[] = [];
  const staged: string[] = [];
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    async exec() { return { code: 0, stdout: "", stderr: "" }; },
    uploadFile(_local, _remote, target, options) {
      staged.push(target);
      return stalledChild(options?.signal, killed, `scp ${target}`);
    },
  });
  globalThis.fetch = withCtcPoolFetch(temp, async (input) => {
    throw new Error(`unexpected worker request ${String(input)}`);
  });
  assertTimedOut(await recover());
  assert.deepEqual(killed, ["scp wsl"]);
  // Past the deadline no other host is tried.
  assert.deepEqual(staged, ["wsl"]);
  await leaseFreed();
});

test("recovery aborted in staging removes the partly staged probe directory under its own deadline (#279 round 2)", async () => {
  const removals: { command: string; abortedWhenSent: boolean | undefined }[] = [];
  const killed: string[] = [];
  let mkdir = "";
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    async exec(_target, command, options) {
      if (command.startsWith("mkdir")) mkdir = command;
      if (command.startsWith("rm -rf")) removals.push({ command, abortedWhenSent: options?.signal?.aborted });
      return { code: 0, stdout: "", stderr: "" };
    },
    uploadFile(_local, _remote, target, options) {
      return stalledChild(options?.signal, killed, `scp ${target}`);
    },
  });
  globalThis.fetch = withCtcPoolFetch(temp, async (input) => {
    throw new Error(`unexpected worker request ${String(input)}`);
  });
  assertTimedOut(await recover());
  await leaseFreed();
  assert.deepEqual(killed, ["scp wsl"]);
  const probeDir = mkdir.match(/'([^']*\/alignment\/pool-jobs\/ctc-probe-[^/']+)\/tracks'/)?.[1];
  assert.ok(probeDir, `staging made no probe directory: ${mkdir}`);
  assert.deepEqual(removals.map((removal) => removal.command), [`rm -rf '${probeDir}'`]);
  // The removal is not tied to the request's deadline, which had already aborted.
  assert.equal(removals[0].abortedWhenSent, false);
});

test("a stalled removal of an aborted probe's staging gives up at its own deadline and frees the lease", async () => {
  const killed: string[] = [];
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    exec(_target, command, options) {
      if (command.startsWith("rm -rf")) return stalledChild(options?.signal, killed, "rm");
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    uploadFile(_local, _remote, target, options) {
      return stalledChild(options?.signal, killed, `scp ${target}`);
    },
  });
  globalThis.fetch = withCtcPoolFetch(temp, async (input) => {
    throw new Error(`unexpected worker request ${String(input)}`);
  });
  assertTimedOut(await recover());
  const coord = getAlignmentPoolCoordinator();
  // The host stays held while its staging is being removed.
  assert.equal(coord.activeOnHost("wsl"), 1);
  await leaseFreed();
  assert.deepEqual(killed, ["scp wsl", "rm"]);
});

test("the probe cleanup deadline is short and separate from the request's", () => {
  assert.equal(pool.PROBE_CLEANUP_TIMEOUT_MS, 30_000);
});

test("recovery stalled while scoring answers at its deadline and aborts the worker request", async () => {
  const killed: string[] = [];
  globalThis.fetch = withCtcPoolFetch(temp, (input, init) => {
    assert.equal(String(input), `${workerUrl}/anchor`);
    return stalledChild(init?.signal ?? undefined, killed, "anchor");
  });
  assertTimedOut(await recover());
  assert.deepEqual(killed, ["anchor"]);
  await leaseFreed();
});

test("recovery stalled in remote cleanup answers at its deadline, kills the cleanup and frees the lease", async (t) => {
  // The removal's own deadline outlasts the request's here, so the request deadline answers first.
  pool.setProbeCleanupTimingForTests?.({ cleanupMs: 1000, slackMs: 100, pollMs: 20 });
  t.after(() => pool.setProbeCleanupTimingForTests?.({ cleanupMs: CLEANUP_MS, slackMs: 100, pollMs: 20 }));
  const killed: string[] = [];
  const commands: string[] = [];
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    async exec(_target, command, options) {
      commands.push(command.split(" ")[0]);
      if (command.startsWith("rm -rf")) return stalledChild(options?.signal, killed, "rm");
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile(local, remote) {
      mkdirSync(dirname(remote), { recursive: true });
      copyFileSync(local, remote);
    },
  });
  globalThis.fetch = withCtcPoolFetch(temp, async (input, init) => {
    assert.equal(String(input), `${workerUrl}/anchor`);
    const data = JSON.parse(String(init?.body));
    return Response.json({
      engine: CTC_ENGINE, outcome: "mapped", start: 20, text: data.fragments[0], match: { index: 0, score: 0.9 },
    });
  });
  assertTimedOut(await recover());
  assert.deepEqual(commands, ["mkdir", "rm"]);
  // The host and recording stay held while the staged audio is still being removed.
  assert.equal(getAlignmentPoolCoordinator().activeOnHost("wsl"), 1);
  await leaseFreed();
  assert.deepEqual(killed, ["rm"]);
});

test("a recovery that finishes inside its deadline still locates the passage", async () => {
  globalThis.fetch = withCtcPoolFetch(temp, async (_input, init) => {
    const data = JSON.parse(String(init?.body));
    return Response.json({
      engine: CTC_ENGINE, outcome: "mapped", start: 20, text: data.fragments[1], match: { index: 1, score: 0.9 },
    });
  });
  const { response } = await recover();
  assert.ok(response);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().approximate, true);
  await leaseFreed();
});

/**
 * A worker on a real HTTP socket that behaves like worker/align.py: /anchor is synchronous, keeps running after the
 * client disconnects, and /health reports `activeRequests` and `busySeconds` (the oldest running request's age).
 * The health body is the shape of a live WSL worker's (`curl http://192.168.1.119:3012/health`, 2026-11-15).
 */
async function stubbornWorker(runMs: number) {
  const running = new Map<number, number>();
  const log = { received: 0, clientGoneWhileRunning: 0, finished: 0 };
  let next = 0;
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const oldest = Math.min(...running.values());
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ready: true, engine: CTC_ENGINE, busy: false, stuck: false,
        busySeconds: running.size ? Math.round((Date.now() - oldest) / 100) / 10 : null,
        lastTimeout: null, slots: 8, activeRequests: running.size, mediaRoot: join(temp, "wsl"),
        ctc: { engine: CTC_ENGINE, ready: true, device: "cuda", precision: "float16",
          anchorReady: true, passageReady: true, anchorBatch: true },
      }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const id = next++;
      log.received++;
      running.set(id, Date.now());
      let gone = false;
      res.on("close", () => { if (running.has(id)) { gone = true; log.clientGoneWhileRunning++; } });
      setTimeout(() => {
        running.delete(id);
        log.finished++;
        if (gone) return;
        const data = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ engine: CTC_ENGINE, outcome: "mapped", start: 20, text: data.fragments[0],
          match: { index: 0, score: 0.9 } }));
      }, runMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The pool host keeps its non-loopback URL; only the transport is pointed at the local socket.
  const routed: typeof fetch = (input, init) => {
    const url = String(input);
    return url.startsWith(workerUrl) ? original(base + url.slice(workerUrl.length), init) : original(input, init);
  };
  return { log, routed, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("a recovery abandoned at its deadline keeps the host and recording until the worker has ended the request (#279 round 2)", async (t) => {
  const RUN_MS = 1500;
  const worker = await stubbornWorker(RUN_MS);
  t.after(worker.close);
  const commands: string[] = [];
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    async exec(_target, command) {
      commands.push(command.split(" ")[0]);
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile(local, remote) {
      mkdirSync(dirname(remote), { recursive: true });
      copyFileSync(local, remote);
    },
  });
  globalThis.fetch = worker.routed;
  const sent = Date.now();
  assertTimedOut(await recover());
  // The client gave up; the worker is still running the request.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(worker.log.received, 1);
  assert.equal(worker.log.clientGoneWhileRunning, 1);
  assert.equal(worker.log.finished, 0);
  const coord = getAlignmentPoolCoordinator();
  // Its host slot and recording stay taken, and its staged audio stays where the worker reads it.
  assert.equal(coord.activeOnHost("wsl"), 1);
  assert.equal(coord.tryAcquireCtc("lisa", "other-job", "recording-alice", 3), false);
  assert.deepEqual(commands, ["mkdir"]);
  await new Promise((resolve) => setTimeout(resolve, RUN_MS / 2));
  assert.equal(worker.log.finished, 0);
  assert.equal(coord.activeOnHost("wsl"), 1, "the lease was freed while the worker still ran the request");
  await leaseFreed();
  // Freed only after the worker ended the request, and the staged copy was removed before that.
  assert.equal(worker.log.finished, 1);
  assert.ok(Date.now() - sent >= RUN_MS, `freed ${Date.now() - sent} ms after the request`);
  assert.deepEqual(commands, ["mkdir", "rm"]);
});

test("an abandoned request the worker cannot prove ended is held at most the worker's own longest limit for it", () => {
  // worker/deadline.py: min(MAX, BASE + PER_AUDIO_SECOND * duration) at the top of each range, plus the kill path.
  const deadline = readFileSync(new URL("../worker/deadline.py", import.meta.url), "utf8");
  assert.match(deadline, /"ALIGNMENT_TIMEOUT_BASE_SECONDS": \(0\.0, 1500\.0\)/);
  assert.match(deadline, /"ALIGNMENT_TIMEOUT_PER_AUDIO_SECOND": \(0\.0, 1\.0\)/);
  assert.match(deadline, /"ALIGNMENT_TIMEOUT_MAX_SECONDS": \(1\.0, 1700\.0\)/);
  assert.match(deadline, /KILL_WAIT_SECONDS = 5\.0/);
  assert.match(deadline, /REAP_SECONDS = 2\.0/);
  assert.equal(pool.workerRequestLimitMs(30), 1537_000);
  assert.equal(pool.workerRequestLimitMs(600), 1707_000);
});
