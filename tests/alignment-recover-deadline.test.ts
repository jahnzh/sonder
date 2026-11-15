// /api/alignments/recover has one deadline over remote staging, scoring and cleanup (#279 review HIGH-1).
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  pool.setProbeCleanupTimeoutForTests?.(null);
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
// A short removal deadline for aborted staging; the base code has no such hook (optional call).
pool.setProbeCleanupTimeoutForTests?.(200);

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
  for (let i = 0; i < 100 && (coord.activeOnHost("wsl") || coord.activeOnHost("lisa")); i++)
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
      if (command.includes("rm -rf")) removals.push({ command, abortedWhenSent: options?.signal?.aborted });
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
  assert.equal(removals.length, 1);
  const removing = removals[0].command.match(/^mv -T -- '([^']+)' '([^']+)' 2>\/dev\/null; rm -rf -- '([^']+)'$/);
  assert.ok(removing, removals[0].command);
  assert.equal(removing[1], probeDir);
  assert.ok(removing[2].startsWith(`${probeDir}.removing-`) && removing[3] === removing[2], removals[0].command);
  // The removal is not tied to the request's deadline, which had already aborted.
  assert.equal(removals[0].abortedWhenSent, false);
});

test("a stalled removal of an aborted probe's staging gives up at its own deadline and frees the lease", async () => {
  const killed: string[] = [];
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    exec(_target, command, options) {
      if (command.includes("rm -rf")) return stalledChild(options?.signal, killed, "rm");
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

test("recovery stalled in remote cleanup answers at its deadline, kills the cleanup and frees the lease", async () => {
  const killed: string[] = [];
  const commands: string[] = [];
  setAlignmentPoolDepsForTests({
    async probe() { return true; },
    async exec(_target, command, options) {
      commands.push(command.split(" ")[0]);
      if (command.includes("rm -rf")) return stalledChild(options?.signal, killed, "rm");
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
  // The removal renames the folder, then deletes it: one command.
  assert.deepEqual(commands, ["mkdir", "mv"]);
  assert.deepEqual(killed, ["rm"]);
  await leaseFreed();
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
