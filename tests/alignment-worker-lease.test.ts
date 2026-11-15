// Which pool host an alignment job or a probe gets, and where its host slot and staged audio go, through an
// in-process fake of the pool hosts (tests/fake-pool-host.ts): no SSH, no network.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerFixture } from "./reader-fixture.ts";
import { fakePoolHosts, type FakePool } from "./fake-pool-host.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-worker-lease-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
process.env.ALIGNMENT_POOL_ENABLED = "1";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
const ebookPath = join(process.env.MEDIA_ROOT, "book.epub");
writeFileSync(ebookPath, await readerFixture({ bodies: ["<p>First sentence. Another sentence.</p>", "<p>Middle sentence. Last sentence.</p>"] }));

const { db, sqlite } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { extractBook } = await import("../server/reader.ts");
const { createAlignment, alignmentJob, putAlignmentJob, processAlignments, stopAlignments, resetAlignmentRunnerForTests,
  alignmentSchedulerForTests } = await import("../server/alignment.ts");
const pool = await import("../server/alignment-pool.ts");
const { getAlignmentPoolCoordinator, resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests, acquireWorkerLease, PoolBusyError } = pool;
const originalFetch = globalThis.fetch;

db.insert(schema.works).values({ id: "lease-work", title: "Book", author: "Author", description: "", genre: "", year: 2026 }).run();
db.insert(schema.ebookEditions).values({ id: "lease-ebook", workId: "lease-work", format: "epub", source: ebookPath }).run();

let fake: FakePool;
let recordings = 0;

function install(specs?: Parameters<typeof fakePoolHosts>[1]) {
  fake = fakePoolHosts(join(temp, `hosts-${++recordings}`), specs);
  resetAlignmentPoolCoordinator(Object.values(fake.hosts).map((host, index) => ({
    id: host.id, sshTarget: host.sshTarget, maxConcurrent: 1, remoteWorkRoot: host.root, workerUrl: host.workerUrl,
    device: host.device, precision: host.precision, rank: index + 1,
  })));
  setAlignmentPoolDepsForTests(fake.deps);
  globalThis.fetch = fake.fetch;
}

/** A recording of its own (one audio track on the server) so each test has its own job id and staging. */
function recording() {
  const n = ++recordings;
  const audio = join(process.env.MEDIA_ROOT!, `audio-${n}.wav`);
  writeFileSync(audio, `audio ${n}`);
  db.insert(schema.editions).values({ id: `lease-edition-${n}`, workId: "lease-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: `lease-recording-${n}`, editionId: `lease-edition-${n}` }).run();
  db.insert(schema.tracks).values({ id: `lease-track-${n}`, recordingId: `lease-recording-${n}`, title: "Book", index: 0, duration: 400, chapters: [], source: audio, sourceType: "local" }).run();
  return { recordingId: `lease-recording-${n}`, trackId: `lease-track-${n}` };
}

/** A chapter job over both sections of the book: two /align requests. */
async function chapterJob() {
  const { recordingId, trackId } = recording();
  const book = await extractBook("lease-ebook");
  const pairings = book.sections.map((section, i) => ({ section: section.index, trackId, start: 10 + i * 100, duration: 80 }));
  return createAlignment("lease-ebook", recordingId, pairings, "chapters");
}

async function settled(id: string, statuses = ["partial", "ready", "error", "cancelled"]) {
  for (let i = 0; i < 300; i++) {
    const job = alignmentJob(id);
    // The run has ended, its release (and any removal of staged audio) included.
    if (statuses.includes(job.status) && !leaseHeld(id) && !alignmentSchedulerForTests().running().includes(id)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Alignment did not settle: ${alignmentJob(id).status}`);
}

/** Lets the runner reach its next await (a worker request or a release). */
async function until(condition: () => boolean) {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "condition not reached");
}

const leaseHeld = (id: string) => ["wsl", "lisa"].some((host) => getAlignmentPoolCoordinator().hasJobLease(host, id));
/** A job a test left paused or interrupted must not run again in a later test. */
function endInterrupted(id: string) {
  sqlite.prepare("UPDATE alignment_jobs SET claim_owner=NULL WHERE id=?").run(id);
  putAlignmentJob({ ...alignmentJob(id), status: "cancelled" });
}
type Track = typeof schema.tracks.$inferSelect;
/** A probe's lease, as the ebook-set probe session takes it. */
const probeLease = (recordingId: string, track: Track, id = `ctc-probe-${++recordings}`) =>
  acquireWorkerLease({ id, recordingId, mode: "anchored", tracks: [track], localAudio: (row) => row.source, kind: "probe" });
const slotsHeld = () => getAlignmentPoolCoordinator().activeOnHost("wsl") + getAlignmentPoolCoordinator().activeOnHost("lisa");

beforeEach(() => {
  resetAlignmentRunnerForTests();
  install();
});

after(() => {
  globalThis.fetch = originalFetch;
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  stopAlignments();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

test("a job takes the first healthy host, stages its tracks there and calls that worker", async () => {
  const created = await chapterJob();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "wsl");
  assert.equal(job.pool?.workerUrl, "http://wsl-worker.test");
  assert.deepEqual(job.pool?.triedHosts, ["wsl"]);
  assert.equal(job.ctcDevice, "cuda");
  assert.deepEqual(fake.hosts.wsl.requests, ["/align", "/align"]);
  assert.deepEqual(fake.hosts.lisa.requests, []);
  assert.equal(job.pool?.jobMediaRoot, join(fake.hosts.wsl.root, "alignment", "pool-jobs", job.id));
  assert.equal(slotsHeld(), 0);
});

test("a job falls back to the next host when the first is down, its SSH is down or it is full", async () => {
  const cases: [string, () => void][] = [
    ["health down", () => { fake.hosts.wsl.down = true; }],
    ["ssh down", () => { fake.hosts.wsl.sshDown = true; }],
    ["worker busy", () => { fake.hosts.wsl.busy = true; }],
    ["every slot taken", () => { assert.ok(getAlignmentPoolCoordinator().tryAcquireCtc("wsl", "other-job", "other-recording", 1)); }],
  ];
  for (const [label, breakWsl] of cases) {
    install();
    breakWsl();
    const created = await chapterJob();
    const job = await settled(created.id);
    assert.equal(job.status, "partial", `${label}: ${job.error}`);
    assert.equal(job.pool?.hostId, "lisa", label);
    assert.equal(job.ctcDevice, "cpu", label);
    assert.deepEqual(fake.hosts.wsl.requests, [], label);
    assert.deepEqual(fake.hosts.lisa.requests, ["/align", "/align"], label);
    assert.ok(job.poolErrors?.wsl, `${label}: the reason WSL was skipped is kept`);
    getAlignmentPoolCoordinator().releaseJob("other-job");
  }
});

test("a job waits in the queue while every host is full and holds no slot, then runs on a freed host", async () => {
  fake.hosts.wsl.busy = true;
  fake.hosts.lisa.busy = true;
  const created = await chapterJob();
  await until(() => alignmentJob(created.id).status === "queued" && fake.hosts.lisa.requests.length === 0 &&
    !!alignmentJob(created.id).poolErrors?.lisa);
  assert.equal(slotsHeld(), 0);
  assert.equal(fake.stagedFolders("wsl").length + fake.stagedFolders("lisa").length, 0);
  fake.hosts.wsl.busy = false;
  await processAlignments();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "wsl");
});

test("a worker that restarts mid-job sends the job to the other host, staged again, with finished sections kept", async () => {
  // The second request finds the WSL worker restarting.
  fake.hosts.wsl.onRequest = (n) => { if (n === 2) fake.hosts.wsl.failRequests = 1; };
  const created = await chapterJob();
  {
    const job = await settled(created.id);
    assert.equal(job.status, "partial", job.error ?? undefined);
    assert.deepEqual(fake.hosts.wsl.requests, ["/align", "/align"]);
    assert.deepEqual(fake.hosts.lisa.requests, ["/align"], "only the unfinished section runs again");
    assert.deepEqual(job.pool?.triedHosts, ["wsl", "lisa"]);
    assert.equal(job.pool?.hostId, "lisa");
    assert.equal(slotsHeld(), 0);
  }
});

test("after a server restart a job's persisted staging, which has no lease, is staged again", async () => {
  const created = await chapterJob();
  await settled(created.id);
  // As a server that stopped mid-job left it: staged on WSL, no lease in this process, sections to do.
  const job = alignmentJob(created.id);
  job.status = "queued";
  job.sectionsDone = [];
  job.intervals = [];
  job.generation = "after-restart";
  putAlignmentJob(job);
  rmSync(join(fake.hosts.wsl.root, "alignment"), { recursive: true, force: true });
  // The server's own cache of finished sections goes too, so every section asks a worker again.
  rmSync(join(process.env.MEDIA_ROOT!, "alignment", job.id), { recursive: true, force: true });
  fake.hosts.wsl.requests.length = 0;
  resetAlignmentRunnerForTests({ restart: true });
  await processAlignments();
  const resumed = await settled(created.id);
  assert.equal(resumed.status, "partial", resumed.error ?? undefined);
  // The host it was staged on counts as tried, so the restaged job goes to the other one.
  assert.equal(resumed.pool?.hostId, "lisa");
  assert.deepEqual(resumed.pool?.triedHosts, ["wsl", "lisa"]);
  assert.deepEqual(fake.hosts.lisa.requests, ["/align", "/align"]);
});

test("a job releases its host slot on every exit: published, failed on both hosts, paused, cancelled, stale", async () => {
  // Published (above), and failed on both hosts:
  fake.hosts.wsl.failRequests = 1;
  fake.hosts.lisa.failRequests = 1;
  const failed = await settled((await chapterJob()).id);
  assert.equal(failed.status, "error");
  assert.deepEqual(failed.pool?.triedHosts, ["wsl", "lisa"]);
  assert.equal(slotsHeld(), 0);

  for (const [label, interrupt, status] of [
    ["paused", (id: string) => putAlignmentJob({ ...alignmentJob(id), status: "paused" }), "paused"],
    ["cancelled", (id: string) => putAlignmentJob({ ...alignmentJob(id), status: "cancelled" }), "cancelled"],
    // Another server took the claim: the run's next write throws StaleAlignmentRun.
    ["stale", (id: string) => sqlite.prepare("UPDATE alignment_jobs SET claim_owner='other-server' WHERE id=?").run(id), "processing"],
  ] as const) {
    install();
    let interrupted = false;
    let created!: Awaited<ReturnType<typeof chapterJob>>;
    fake.hosts.wsl.onRequest = (n) => { if (n === 1) { interrupted = true; interrupt(created.id); } };
    try {
      created = await chapterJob();
      await until(() => interrupted && slotsHeld() === 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(alignmentJob(created.id).status, status, label);
      assert.equal(slotsHeld(), 0, label);
      assert.ok(fake.hosts.wsl.requests.length <= 2, label);
    } finally {
      endInterrupted(created.id);
    }
  }
});

test("a finished job removes its staged tracks from every host it staged on", async () => {
  // Published after moving to lisa: staged on both hosts.
  fake.hosts.wsl.onRequest = (n) => { if (n === 2) fake.hosts.wsl.failRequests = 1; };
  const moved = await settled((await chapterJob()).id);
  assert.equal(moved.status, "partial", moved.error ?? undefined);
  assert.deepEqual(moved.pool?.triedHosts, ["wsl", "lisa"]);
  assert.deepEqual(fake.stagedFolders("wsl"), []);
  assert.deepEqual(fake.stagedFolders("lisa"), []);
  assert.ok(fake.hosts.wsl.commands.some((command) => command.startsWith("rm -rf ") && command.includes(moved.id)));

  // Failed for good on both hosts, and cancelled mid-request.
  install();
  fake.hosts.wsl.failRequests = 1;
  fake.hosts.lisa.failRequests = 1;
  const failed = await settled((await chapterJob()).id);
  assert.equal(failed.status, "error");
  assert.deepEqual([...fake.stagedFolders("wsl"), ...fake.stagedFolders("lisa")], []);

  install();
  let cancelled!: Awaited<ReturnType<typeof chapterJob>>;
  fake.hosts.wsl.onRequest = (n) => { if (n === 1) putAlignmentJob({ ...alignmentJob(cancelled.id), status: "cancelled" }); };
  cancelled = await chapterJob();
  assert.equal((await settled(cancelled.id)).status, "cancelled");
  assert.deepEqual(fake.stagedFolders("wsl"), []);
});

test("a paused, requeued or interrupted job keeps its staged tracks for the next run", async () => {
  let paused!: Awaited<ReturnType<typeof chapterJob>>;
  fake.hosts.wsl.onRequest = (n) => { if (n === 1) putAlignmentJob({ ...alignmentJob(paused.id), status: "paused" }); };
  paused = await chapterJob();
  assert.equal((await settled(paused.id, ["paused"])).status, "paused");
  assert.deepEqual(fake.stagedFolders("wsl"), [paused.id]);

  // The request fails and the next host is busy: the job waits in the queue, its staging kept.
  install();
  fake.hosts.wsl.failRequests = 1;
  fake.hosts.lisa.busy = true;
  const requeued = await chapterJob();
  const waiting = await settled(requeued.id, ["queued"]);
  assert.deepEqual(waiting.pool?.triedHosts, ["wsl"]);
  assert.equal(waiting.pool?.jobMediaRoot, "");
  assert.deepEqual(fake.stagedFolders("wsl"), [requeued.id]);
  // Its next run skips the host it tried and is staged on the freed one; the finished run removes both copies.
  fake.hosts.lisa.busy = false;
  await processAlignments();
  const finished = await settled(requeued.id);
  assert.equal(finished.status, "partial", finished.error ?? undefined);
  assert.equal(finished.pool?.hostId, "lisa");
  assert.deepEqual(fake.stagedFolders("lisa"), []);

  // Another server took the claim mid-request: this run stops, the job is not finished, the audio stays.
  install();
  let stale!: Awaited<ReturnType<typeof chapterJob>>;
  fake.hosts.wsl.onRequest = (n) => {
    if (n === 1) sqlite.prepare("UPDATE alignment_jobs SET claim_owner='other-server' WHERE id=?").run(stale.id);
  };
  stale = await chapterJob();
  try {
    await settled(stale.id, ["processing"]);
    assert.deepEqual(fake.stagedFolders("wsl"), [stale.id]);
  } finally {
    endInterrupted(stale.id);
  }
});

test("acquire gives a healthy host with the tracks staged and its worker address; release frees it", async () => {
  const { recordingId, trackId } = recording();
  const track = db.select().from(schema.tracks).all().find((row) => row.id === trackId)!;
  const job = { id: "lease-unit", poolErrors: undefined as Record<string, string> | undefined };
  fake.hosts.wsl.down = true;
  const lease = await acquireWorkerLease({ id: job.id, recordingId, mode: "chapters", tracks: [track],
    localAudio: (row) => row.source, kind: "job", diagnostics: job });
  assert.equal(lease.hostId, "lisa");
  assert.equal(lease.workerUrl, "http://lisa-worker.test");
  assert.equal(lease.device, "cpu");
  assert.equal(lease.stagedAudio[trackId], join(fake.hosts.lisa.root, "alignment", "pool-jobs", job.id, "tracks", trackId));
  assert.ok(existsSync(lease.stagedAudio[trackId]));
  assert.equal(lease.outputDir, join(fake.hosts.lisa.root, "alignment", "pool-jobs", job.id, "alignment", job.id));
  assert.deepEqual(lease.assignment.triedHosts, ["lisa"], "a host that is down does not count as tried for a job");
  assert.match(job.poolErrors?.wsl ?? "", /^health: /);
  assert.equal(lease.canFailover, true);
  assert.equal(getAlignmentPoolCoordinator().activeOnHost("lisa"), 1);

  await lease.release("retryable");
  assert.equal(slotsHeld(), 0);
  assert.deepEqual(fake.stagedFolders("lisa"), [job.id], "retryable keeps the staged tracks");
  await lease.release("finished");
  assert.deepEqual(fake.stagedFolders("lisa"), [job.id], "a second release does nothing");

  const again = await acquireWorkerLease({ id: job.id, recordingId, mode: "chapters", tracks: [track],
    localAudio: (row) => row.source, kind: "job" });
  await again.release("finished");
  assert.deepEqual(fake.stagedFolders("lisa"), [], "finished removes them");
  assert.equal(slotsHeld(), 0);
});

test("failover takes the next untried host and stages again; past the last host it throws and holds nothing", async () => {
  const { recordingId, trackId } = recording();
  const track = db.select().from(schema.tracks).all().find((row) => row.id === trackId)!;
  const lease = await acquireWorkerLease({ id: "lease-failover", recordingId, mode: "chapters", tracks: [track],
    localAudio: (row) => row.source, kind: "job" });
  assert.equal(lease.hostId, "wsl");
  await lease.failover();
  assert.equal(lease.hostId, "lisa");
  assert.deepEqual(lease.triedHosts, ["wsl", "lisa"]);
  assert.equal(lease.canFailover, false);
  assert.equal(getAlignmentPoolCoordinator().activeOnHost("wsl"), 0);
  assert.equal(getAlignmentPoolCoordinator().activeOnHost("lisa"), 1);
  assert.ok(existsSync(lease.stagedAudio[trackId]));
  assert.deepEqual(fake.stagedFolders("wsl"), ["lease-failover"], "the first host's copy stays until the release");
  await assert.rejects(() => lease.failover(), /Remote alignment failed on all pool hosts/);
  assert.equal(slotsHeld(), 0);
  assert.equal(lease.assignment.jobMediaRoot, "");
  assert.deepEqual(lease.assignment.triedHosts, ["wsl", "lisa"]);
  await lease.release("finished");
  assert.deepEqual([...fake.stagedFolders("wsl"), ...fake.stagedFolders("lisa")], []);
});

test("a release as finished gives up on a removal that hangs at its own deadline and keeps the slot freed", async () => {
  pool.setProbeCleanupTimeoutForTests(30);
  const exec = fake.deps.exec;
  fake.deps.exec = async (target, command, options) => command.startsWith("rm -rf ")
    ? new Promise(() => undefined) : exec(target, command, options);
  try {
    const { recordingId, trackId } = recording();
    const track = db.select().from(schema.tracks).all().find((row) => row.id === trackId)!;
    const lease = await acquireWorkerLease({ id: "lease-hang", recordingId, mode: "chapters", tracks: [track],
      localAudio: (row) => row.source, kind: "job" });
    const started = Date.now();
    await lease.release("finished");
    assert.ok(Date.now() - started < 2000);
    assert.equal(slotsHeld(), 0);
    assert.deepEqual(fake.stagedFolders("wsl"), ["lease-hang"], "the sweep removes what a failed removal left");
  } finally {
    fake.deps.exec = exec;
    pool.setProbeCleanupTimeoutForTests(null);
  }
});

test("a probe lease takes the first healthy host and its release frees the slot and removes the staging", async () => {
  const { recordingId, trackId } = recording();
  const track = db.select().from(schema.tracks).all().find((row) => row.id === trackId)!;
  const lease = await probeLease(recordingId, track);
  assert.equal(lease.hostId, "wsl");
  assert.equal(lease.workerUrl, "http://wsl-worker.test");
  assert.equal(fake.stagedFolders("wsl").length, 1);
  assert.ok(existsSync(lease.stagedAudio[trackId]));
  assert.ok(lease.outputDir.startsWith(join(fake.hosts.wsl.root, "alignment", "pool-jobs")));
  assert.equal(slotsHeld(), 1);
  await lease.release("finished");
  await lease.release("finished");
  assert.equal(slotsHeld(), 0);
  assert.deepEqual(fake.stagedFolders("wsl"), []);
});

test("a probe lease falls back when the first host is down or busy, and is refused while every host is busy", async () => {
  const { recordingId, trackId } = recording();
  const track = db.select().from(schema.tracks).all().find((row) => row.id === trackId)!;
  fake.hosts.wsl.down = true;
  const down = await probeLease(recordingId, track);
  assert.equal(down.hostId, "lisa");
  // An unreachable host stays excluded for the probe's retries.
  assert.deepEqual(down.triedHosts, ["wsl", "lisa"]);
  await down.release("finished");

  fake.hosts.wsl.down = false;
  fake.hosts.wsl.busy = true;
  const busy = await probeLease(recordingId, track);
  assert.equal(busy.hostId, "lisa");
  assert.deepEqual(busy.triedHosts, ["lisa"]);
  await busy.release("finished");

  fake.hosts.lisa.busy = true;
  await assert.rejects(() => probeLease(recordingId, track), PoolBusyError);
  assert.equal(slotsHeld(), 0);
  assert.deepEqual(fake.stagedFolders("lisa"), []);
});
