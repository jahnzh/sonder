// The whole-book runner (#404): with ALIGNMENT_BOOK_JOBS=1 a full alignment is one job on a pool worker under one
// lease. Every test runs against the in-process fake worker (tests/fake-book-worker.ts): real HTTP on 127.0.0.2,
// fake SSH staging, no fetch swapped.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerFixture } from "./reader-fixture.ts";
import { fakeBookWorkers, type FakeBookPool } from "./fake-book-worker.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-book-job-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
process.env.ALIGNMENT_POOL_ENABLED = "1";
process.env.ALIGNMENT_BOOK_JOBS = "1";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
const ebookPath = join(process.env.MEDIA_ROOT, "book.epub");
writeFileSync(ebookPath, await readerFixture({ bodies: ["<p>First sentence. Another sentence.</p>", "<p>Middle sentence. Last sentence.</p>"] }));

const { db, sqlite } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { extractBook } = await import("../server/reader.ts");
const alignment = await import("../server/alignment.ts");
const { createAlignment, alignmentJob, putAlignmentJob, processAlignments, stopAlignments, resetAlignmentRunnerForTests,
  alignmentSchedulerForTests, queueEngineRebuilds, autoQueueAlignmentForPair, autoQueueAlignmentsForWork, runAlignmentBackfill } = alignment;
const transition = await import("../server/alignment-transitions.ts");
const pool = await import("../server/alignment-pool.ts");
const { getAlignmentPoolCoordinator, resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests } = pool;
const { BOOK_ENGINE, CTC_ENGINE, bookJobsEnabled } = await import("../server/alignment-engine.ts");
const { currentAlignmentEngine } = await import("../server/alignment-rebuild.ts");
const bookJob = await import("../server/alignment-book-job.ts");
const { BOOK_POLL_MS, BOOK_WORKER_RESTART_WAIT_MS, bookWorkerJobId, setBookJobClockForTests } = bookJob;
const { createCtcProbeSession } = await import("../server/ebook-set-ctc-session.ts");
const { setBookWorkerTimeoutsForTests } = await import("../server/alignment-book-worker.ts");

db.insert(schema.works).values({ id: "book-work", title: "Book", author: "Author", description: "", genre: "", year: 2026 }).run();
db.insert(schema.ebookEditions).values({ id: "book-ebook", workId: "book-work", format: "epub", source: ebookPath }).run();
const book = await extractBook("book-ebook");
const sentences = book.sections.flatMap((section) => section.paragraphs.map((paragraph) => ({ id: paragraph.id, section: section.index, text: paragraph.text })));

let fake: FakeBookPool;
let n = 0;
/** The fake clock: each poll's sleep advances it by its interval and yields briefly, so bounds take no real time. */
let now = 1_800_000_000_000;
setBookJobClockForTests({
  now: () => now,
  sleep: async (ms) => { now += ms; await new Promise((resolve) => setTimeout(resolve, 2)); },
});

async function install(ids = ["wsl", "lisa"]) {
  await fake?.close();
  fake = await fakeBookWorkers(join(temp, `hosts-${++n}`));
  resetAlignmentPoolCoordinator(fake.poolHosts(ids));
  setAlignmentPoolDepsForTests(fake.deps);
}

/** A recording of its own (one track on the server), so each test has its own job and staging. */
function recording() {
  const i = ++n;
  const audio = join(process.env.MEDIA_ROOT!, `audio-${i}.wav`);
  writeFileSync(audio, `audio ${i}`);
  db.insert(schema.editions).values({ id: `book-edition-${i}`, workId: "book-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: `book-recording-${i}`, editionId: `book-edition-${i}` }).run();
  db.insert(schema.tracks).values({ id: `book-track-${i}`, recordingId: `book-recording-${i}`, title: "Book", index: 0, duration: 400, chapters: [], source: audio, sourceType: "local" }).run();
  return { recordingId: `book-recording-${i}`, trackId: `book-track-${i}` };
}

const anchoredJob = async () => createAlignment("book-ebook", recording().recordingId, undefined, "anchored");

const hostIds = () => getAlignmentPoolCoordinator().listHosts().map((host) => host.id);
const leaseHeld = (id: string) => hostIds().some((host) => getAlignmentPoolCoordinator().hasJobLease(host, id));
const slotsHeld = () => hostIds().reduce((sum, host) => sum + getAlignmentPoolCoordinator().activeOnHost(host), 0);

async function settled(id: string, statuses = ["partial", "ready", "error", "cancelled"]) {
  for (let i = 0; i < 1000; i++) {
    const job = alignmentJob(id);
    if (statuses.includes(job.status) && !leaseHeld(id) && !alignmentSchedulerForTests().running().includes(id)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Alignment did not settle: ${alignmentJob(id).status}`);
}

async function until(condition: () => boolean, label = "condition") {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), `${label} not reached`);
}

/** The whole-book requests a host received, without the status polls. */
const calls = (hostId: string) => fake.hosts[hostId].book.filter((call) => !/^GET \/book-jobs\/[^/]+$/.test(call));
const polls = (hostId: string) => fake.hosts[hostId].book.filter((call) => /^GET \/book-jobs\/[^/]+$/.test(call)).length;

beforeEach(async () => {
  process.env.ALIGNMENT_BOOK_JOBS = "1";
  setBookWorkerTimeoutsForTests?.(null);
  resetAlignmentRunnerForTests();
  await install();
});

after(async () => {
  setBookJobClockForTests(null);
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  stopAlignments();
  await fake?.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

test("the setting is off by default; on, new jobs and rebuilds target the whole-book engine", () => {
  delete process.env.ALIGNMENT_BOOK_JOBS;
  assert.equal(bookJobsEnabled(), false);
  assert.equal(currentAlignmentEngine(), CTC_ENGINE);
  process.env.ALIGNMENT_BOOK_JOBS = "0";
  assert.equal(currentAlignmentEngine(), CTC_ENGINE);
  process.env.ALIGNMENT_BOOK_JOBS = "1";
  assert.equal(bookJobsEnabled(), true);
  assert.equal(currentAlignmentEngine(), BOOK_ENGINE);
});

test("with the setting off a job runs through the window runner and sends no whole-book request", async () => {
  delete process.env.ALIGNMENT_BOOK_JOBS;
  const { recordingId, trackId } = recording();
  const pairings = book.sections.map((section, i) => ({ section: section.index, trackId, start: 10 + i * 100, duration: 80 }));
  const created = await createAlignment("book-ebook", recordingId, pairings, "chapters");
  assert.equal(created.engine, CTC_ENGINE);
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.engine, CTC_ENGINE);
  assert.deepEqual(fake.hosts.wsl.requests, ["/align", "/align"]);
  assert.deepEqual(fake.hosts.wsl.book, []);
  assert.equal(job.bookJob, undefined);
});

test("a first map: one start with the sentences and staged tracks, progress polled into the job, the result published", async () => {
  fake.hosts.wsl.pollsPerStage = 2;
  const seen: number[] = [];
  let created!: Awaited<ReturnType<typeof anchoredJob>>;
  fake.hosts.wsl.onBook = (method, path) => {
    if (method === "GET" && !path.endsWith("/result")) seen.push(alignmentJob(created.id).progress);
  };
  created = await anchoredJob();
  assert.equal(created.engine, BOOK_ENGINE);
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  const workerJobId = bookWorkerJobId(created);

  // One lease: WSL, the tracks staged there, and the start request names them in play order.
  assert.equal(job.pool?.hostId, "wsl");
  assert.deepEqual(job.pool?.triedHosts, ["wsl"]);
  const [start] = fake.hosts.wsl.starts;
  assert.equal(start.jobId, workerJobId);
  assert.equal(start.recordingId, created.recordingId);
  assert.equal(start.audioFingerprint, created.audioFingerprint);
  assert.equal(start.language, "eng");
  assert.deepEqual(start.sentences, sentences);
  assert.deepEqual(start.tracks, [{ id: created.recordingId.replace("recording", "track"), duration: 400,
    audio: join(job.pool!.jobMediaRoot, "tracks", created.recordingId.replace("recording", "track")) }]);
  assert.deepEqual(calls("wsl"), ["POST /book-jobs", `GET /book-jobs/${workerJobId}/result`]);
  assert.ok(polls("wsl") >= 6, "progress is polled through every stage");
  assert.equal(fake.hosts.wsl.jobs.size, 0, "the result fetch ended the worker's job");
  assert.deepEqual(fake.hosts.lisa.book, []);

  // The stored progress rises with the worker's stages.
  assert.ok(seen.some((value) => value > 0 && value < 1), `progress was stored while running: ${seen}`);
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, "progress never falls on one worker job");

  // The map: the window runner's interval shape, the whole-book engine the result names, the columns as today.
  assert.equal(job.engine, BOOK_ENGINE);
  assert.equal(job.outcome, "mapped");
  assert.equal(job.coverage, 1);
  assert.equal(job.progress, 1);
  assert.equal(job.intervals.length, sentences.length);
  assert.deepEqual(Object.keys(job.intervals[0]).sort(), ["confidence", "end", "paragraphId", "section", "start", "trackId"]);
  assert.deepEqual(job.intervals.map((interval) => [interval.paragraphId, interval.section]), sentences.map((s) => [s.id, s.section]));
  assert.deepEqual(job.unsyncedPassages, []);
  assert.equal(job.stageTimings?.decode, 1.5);
  assert.equal(job.gpuUtilization, 93);
  assert.equal(job.bookJob?.id, workerJobId);
  assert.equal(job.bookJob?.hostId, "wsl");
  assert.equal(job.bookJob?.state, "done");
  const row = sqlite.prepare("SELECT engine, outcome, stage_timings, projected_from, published_map FROM alignment_jobs WHERE id=?")
    .get(created.id) as Record<string, string | null>;
  assert.equal(row.engine, BOOK_ENGINE);
  assert.equal(row.outcome, "mapped");
  assert.equal(JSON.parse(row.stage_timings!).decode, 1.5);
  assert.equal(row.projected_from, null);
  assert.equal(row.published_map, null);
  assert.equal(slotsHeld(), 0);
});

/** Keeps only this job's row, so a rebuild scan sees no other test's maps. */
const only = (id: string) => sqlite.prepare("DELETE FROM alignment_jobs WHERE id<>?").run(id);
/** Rewrites a finished map as one the window engine made, mapping the first `share` of the sentences. */
function windowEngineMap(id: string, share: number) {
  const job = alignmentJob(id);
  const intervals = job.intervals.slice(0, Math.round(job.intervals.length * share));
  putAlignmentJob({ ...job, engine: CTC_ENGINE, intervals, coverage: intervals.length / sentences.length,
    outcome: share < 1 ? "partial" : "mapped", bookJob: undefined });
  return alignmentJob(id);
}

test("a rebuild of a window-engine map runs as a whole-book job; the #379 guard keeps a better kept map", async () => {
  const created = await anchoredJob();
  await settled(created.id);
  only(created.id);
  const old = windowEngineMap(created.id, 1);
  fake.hosts.wsl.mapShare = 0.5;
  const scan = await queueEngineRebuilds({ warn: () => {} });
  assert.equal(scan.queued, 1);
  assert.equal(alignmentJob(created.id).engine, BOOK_ENGINE);
  assert.equal(alignmentJob(created.id).rebuildOf?.engine, CTC_ENGINE);
  const rejected = await settled(created.id);
  assert.equal(rejected.status, "error");
  assert.equal(rejected.outcome, "rejected");
  assert.match(rejected.error ?? "", /rejected: it mapped 50% of the text/);
  assert.equal(fake.hosts.wsl.starts.at(-1).jobId, bookWorkerJobId(rejected));
  // The kept window-engine map is still what the reader gets, with the rejected rebuild beside it.
  const served = transition.servedAlignmentJob(created.id);
  assert.equal(served.engine, CTC_ENGINE);
  assert.equal(served.status, "partial");
  assert.deepEqual(served.intervals, old.intervals);
  assert.equal(served.rebuild?.engine, BOOK_ENGINE);
  assert.equal(served.rebuild?.outcome, "rejected");
});

test("a rebuild that maps at least as much replaces the kept map", async () => {
  const created = await anchoredJob();
  await settled(created.id);
  only(created.id);
  windowEngineMap(created.id, 0.5);
  const scan = await queueEngineRebuilds({ warn: () => {} });
  assert.equal(scan.queued, 1);
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.engine, BOOK_ENGINE);
  assert.equal(job.coverage, 1);
  const served = transition.servedAlignmentJob(created.id);
  assert.equal(served.engine, BOOK_ENGINE);
  assert.equal(served.rebuild, undefined);
  assert.equal((sqlite.prepare("SELECT published_map FROM alignment_jobs WHERE id=?").get(created.id) as { published_map: string | null }).published_map, null);
  // A whole-book map is the newest generation: the next scan rebuilds nothing.
  assert.equal((await queueEngineRebuilds({ warn: () => {} })).queued, 0);
});

/** Starts a job and waits until the worker holds it at `stage` and the server has stored that. */
async function heldJob(stage: "encoding" | "aligning" = "encoding", hostId = "wsl") {
  fake.hosts[hostId].holdAt = stage;
  const created = await anchoredJob();
  await until(() => alignmentJob(created.id).bookJob?.state === stage, `${stage} stored`);
  return created;
}

test("pause cancels the worker's job and releases the lease; resume starts a new worker job that runs to the map", async () => {
  const created = await heldJob();
  const firstId = bookWorkerJobId(created);
  assert.ok(alignmentJob(created.id).progress >= 0.2, "encoding progress is stored");
  transition.pause(alignmentJob(created.id));
  const paused = await settled(created.id, ["paused"]);
  await until(() => calls("wsl").includes(`DELETE /book-jobs/${firstId}`) && !fake.hosts.wsl.jobs.size, "worker job cancelled");
  assert.equal(slotsHeld(), 0);
  assert.deepEqual(Object.keys(paused.pool?.stagedHosts ?? {}), ["wsl"], "the staging is kept for the next run");
  const pollsWhilePaused = polls("wsl");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(polls("wsl"), pollsWhilePaused, "a paused job is not polled");

  fake.hosts.wsl.holdAt = null;
  const resumed = transition.resume(alignmentJob(created.id));
  void processAlignments();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  const secondId = bookWorkerJobId(resumed);
  assert.notEqual(secondId, firstId, "the resumed run is a new worker job: the worker's earlier work is lost");
  assert.deepEqual(fake.hosts.wsl.starts.map((start) => start.jobId), [firstId, secondId]);
  assert.equal(job.bookJob?.id, secondId);
});

test("cancel cancels the worker's job and releases the lease", async () => {
  const created = await heldJob("aligning");
  const workerJobId = bookWorkerJobId(created);
  transition.cancel(alignmentJob(created.id));
  const cancelled = await settled(created.id, ["cancelled"]);
  assert.equal(cancelled.status, "cancelled");
  await until(() => calls("wsl").includes(`DELETE /book-jobs/${workerJobId}`) && !fake.hosts.wsl.jobs.size, "worker job cancelled");
  assert.equal(slotsHeld(), 0);
  assert.ok(!calls("wsl").some((call) => call.endsWith("/result")), "nothing was fetched or published");
});

test("a cancel of a job processing on lisa stops it there and is final: no result is fetched, nothing automatic queues it again (#744)", async () => {
  fake.hosts.wsl.down = true;
  const created = await heldJob("aligning", "lisa");
  const workerJobId = bookWorkerJobId(created);
  // What PATCH /api/alignments/<id> {action:'cancel'} does.
  transition.cancel(alignmentJob(created.id));
  await settled(created.id, ["cancelled"]);
  await until(() => calls("lisa").includes(`DELETE /book-jobs/${workerJobId}`) && !fake.hosts.lisa.jobs.size, "lisa's job cancelled");
  // The worker would now finish; the automatic queues of the pair (the work's auto-queue after an import or an
  // ebook-set check, Prepare for all books) leave the cancel standing, and nothing runs.
  fake.hosts.lisa.holdAt = null;
  fake.hosts.wsl.down = false;
  assert.equal(await autoQueueAlignmentForPair("book-ebook", created.recordingId), false);
  await autoQueueAlignmentsForWork("book-work", { ebookId: "book-ebook" });
  await autoQueueAlignmentsForWork("book-work", { recordingId: created.recordingId });
  assert.ok((await runAlignmentBackfill()).skipped.cancelled >= 1);
  await processAlignments();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const job = alignmentJob(created.id);
  assert.equal(job.status, "cancelled");
  assert.equal(job.generation, created.generation, "no new plan of the pair");
  assert.deepEqual(job.intervals, []);
  assert.equal(job.outcome, undefined);
  assert.deepEqual(calls("lisa"), ["POST /book-jobs", `DELETE /book-jobs/${workerJobId}`], "nothing was fetched from lisa");
  assert.deepEqual(calls("wsl"), [], "and nothing started on WSL");
  assert.equal(slotsHeld(), 0);
  // The owner's Resume still runs it again, as a new worker job.
  const resumed = transition.resume(alignmentJob(created.id));
  void processAlignments();
  const again = await settled(created.id);
  assert.equal(again.status, "partial", again.error ?? undefined);
  assert.equal(again.bookJob?.id, bookWorkerJobId(resumed));
});

test("a cancel at any request of a whole-book run is final: the cancelled generation's result is never published (#744)", async () => {
  // A full run's whole-book requests (start, polls, result) on WSL, counted once.
  const full = await settled((await anchoredJob()).id);
  assert.equal(full.status, "partial", full.error ?? undefined);
  const requests = fake.hosts.wsl.book.length;
  assert.ok(requests >= 3, `a full run sent ${requests} requests`);
  for (let k = 1; k <= requests; k++) {
    await install();
    let jobId = "";
    let seen = 0;
    let at = "";
    // The cancel lands while the k-th request is with the worker: after a start, during a poll, during the result fetch.
    fake.hosts.wsl.onBook = (method, path) => {
      if (++seen === k && jobId) {
        at = `${method} ${path}`;
        transition.cancel(alignmentJob(jobId));
      }
    };
    const created = await createAlignment("book-ebook", recording().recordingId, undefined, "anchored");
    jobId = created.id;
    const job = await settled(created.id);
    if (!at) continue;
    assert.equal(job.status, "cancelled", `cancelled at ${at}`);
    assert.deepEqual(job.intervals, [], `nothing published after a cancel at ${at}`);
    assert.equal(job.generation, created.generation, at);
    assert.equal(slotsHeld(), 0, at);
  }
});

/** Stops the server as a clean shutdown does and starts a new one (a new claim owner) on the same database. */
async function restartServer(between = () => {}) {
  stopAlignments();
  await alignmentSchedulerForTests().settled();
  between();
  resetAlignmentRunnerForTests({ restart: true });
  await processAlignments();
}

test("after a server restart the run polls the worker's job it started there and starts no other", async () => {
  const created = await heldJob();
  const workerJobId = bookWorkerJobId(created);
  await restartServer(() => {
    assert.ok(fake.hosts.wsl.jobs.has(workerJobId), "a stopping server leaves the worker's job running");
    assert.ok(!calls("wsl").some((call) => call.startsWith("DELETE")), "and does not cancel it");
    assert.equal(alignmentJob(created.id).status, "processing");
    assert.equal(slotsHeld(), 0);
    fake.hosts.wsl.holdAt = null;
  });
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.deepEqual(calls("wsl"), ["POST /book-jobs", `GET /book-jobs/${workerJobId}/result`]);
  assert.equal(job.bookJob?.id, workerJobId);
  assert.equal(job.pool?.hostId, "wsl");
});

test("after a server restart the job goes back to the host it was started on, not the first by rank", async () => {
  // A book goes to lisa only while WSL cannot be used.
  fake.hosts.wsl.down = true;
  const created = await heldJob("encoding", "lisa");
  assert.equal(alignmentJob(created.id).pool?.hostId, "lisa");
  await restartServer(() => {
    fake.hosts.wsl.down = false;
    fake.hosts.lisa.holdAt = null;
  });
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "lisa");
  assert.equal(fake.hosts.lisa.starts.length, 1);
  assert.deepEqual(fake.hosts.wsl.book, []);
});

test("after a server restart a worker that answers 404 for the job gets it started again, on the same host", async () => {
  const created = await heldJob();
  const workerJobId = bookWorkerJobId(created);
  await restartServer(() => {
    fake.restart("wsl", { keepJobs: false, resumingFor: 0 });
    fake.hosts.wsl.holdAt = null;
  });
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.deepEqual(fake.hosts.wsl.starts.map((start) => start.jobId), [workerJobId, workerJobId]);
  assert.deepEqual(calls("wsl"), ["POST /book-jobs", "POST /book-jobs", `GET /book-jobs/${workerJobId}/result`]);
  assert.deepEqual(fake.hosts.lisa.book, []);
});

test("a worker restart during a job: the server waits through its 503s and the job continues on that host", async () => {
  const created = await heldJob();
  fake.restart("wsl", { resumingFor: 4 });
  fake.hosts.wsl.holdAt = null;
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(fake.hosts.wsl.starts.length, 1, "the resumed worker job is the same one");
  assert.equal(job.bookJob?.resumed, 1);
  assert.deepEqual(job.pool?.triedHosts, ["wsl"]);
  assert.deepEqual(fake.hosts.lisa.book, []);
});

test("a worker that does not answer within the bound has failed for this job: it moves to the other host", async () => {
  const created = await heldJob();
  const since = now;
  let failedOverAt = 0;
  fake.hosts.lisa.onBook = (method) => { if (method === "POST" && !failedOverAt) failedOverAt = now; };
  fake.hosts.wsl.down = true;
  fake.hosts.wsl.holdAt = null;
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.ok(failedOverAt - since >= BOOK_WORKER_RESTART_WAIT_MS, "waited the bound before moving");
  assert.ok(failedOverAt - since < BOOK_WORKER_RESTART_WAIT_MS + 3 * BOOK_POLL_MS, "and not much longer");
  assert.equal(job.pool?.hostId, "lisa");
  assert.deepEqual(job.pool?.triedHosts, ["wsl", "lisa"]);
  assert.deepEqual(Object.keys(job.pool?.stagedHosts ?? {}).sort(), ["lisa", "wsl"]);
  assert.ok(fake.hosts.lisa.starts[0].tracks[0].audio.startsWith(`${fake.hosts.lisa.root}/`), "staged again on lisa");
  assert.equal(job.bookJob?.hostId, "lisa");
});

test("a worker still resuming after the bound counts as failed too", async () => {
  const created = await heldJob();
  fake.restart("wsl", { resumingFor: 1_000_000 });
  fake.hosts.wsl.holdAt = null;
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "lisa");
});

test("fallback: the first host cannot be leased (down, or no whole-book jobs), so the second takes the job", async () => {
  for (const [label, breakWsl] of [
    ["down", () => { fake.hosts.wsl.down = true; }],
    ["no whole-book jobs", () => { fake.hosts.wsl.noBookJobs = true; }],
  ] as const) {
    await install();
    breakWsl();
    const job = await settled((await anchoredJob()).id);
    assert.equal(job.status, "partial", `${label}: ${job.error}`);
    assert.equal(job.pool?.hostId, "lisa", label);
    assert.deepEqual(fake.hosts.wsl.book, [], label);
    if (label === "no whole-book jobs") assert.match(job.poolErrors?.wsl ?? "", /whole-book/);
  }
});

test("fallback: a job that fails on the first host runs on the second; failing on both fails it with the reason", async () => {
  fake.hosts.wsl.failAt = { stage: "aligning", error: "CUDA out of memory" };
  const moved = await settled((await anchoredJob()).id);
  assert.equal(moved.status, "partial", moved.error ?? undefined);
  assert.equal(moved.pool?.hostId, "lisa");
  assert.deepEqual(moved.pool?.triedHosts, ["wsl", "lisa"]);

  await install();
  fake.hosts.wsl.failAt = { stage: "aligning", error: "CUDA out of memory" };
  fake.hosts.lisa.failAt = { stage: "decoding", error: "Track 1 decodes to more audio than its container allows" };
  const failed = await settled((await anchoredJob()).id);
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /lisa failed: Track 1 decodes/);
  assert.deepEqual(failed.pool?.triedHosts, ["wsl", "lisa"]);
  assert.equal(slotsHeld(), 0);
});

test("an ebook-set probe waits for the whole-book job's lease on its recording; another recording's probe takes the free host", async () => {
  const created = await heldJob();
  const trackId = created.recordingId.replace("recording", "track");
  const sample = { fragmentTexts: sentences.map((sentence) => sentence.text), language: "eng", samples: [{ trackId, time: 0, duration: 30 }] };
  let waits = 0;
  const session = createCtcProbeSession(created.recordingId, {
    waitMs: 60_000,
    sleep: async () => {
      waits++;
      // The probe holds nothing while it waits: the job keeps its recording's lease.
      assert.equal(getAlignmentPoolCoordinator().recordingHolder(created.recordingId), created.id);
      if (waits === 2) fake.hosts.wsl.holdAt = null;
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  });
  // Meanwhile a probe of another recording takes lisa, the host the job does not hold.
  const other = recording();
  const otherSession = createCtcProbeSession(other.recordingId, { waitMs: 0 });
  const [otherScore] = await otherSession.score({ ...sample, samples: [{ trackId: other.trackId, time: 0, duration: 30 }] });
  assert.equal(otherScore.match?.fragment, 0);
  assert.deepEqual(fake.hosts.lisa.requests, ["/anchor"]);
  await otherSession.release();

  const [score] = await session.score(sample);
  assert.ok(waits >= 2, "the probe waited for the job");
  assert.equal(score.match?.fragment, 0);
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.deepEqual(fake.hosts.wsl.requests, ["/anchor"], "the probe ran on the host once the job released it");
  await session.release();
  assert.deepEqual(fake.stagedFolders("wsl"), [created.id], "the probe's staging is removed; the job's stays");
  assert.equal(slotsHeld(), 0);
});

test("a probe waiting for its recording's job checks no host until the job releases it, then takes WSL, not lisa", async () => {
  const created = await heldJob();
  const trackId = created.recordingId.replace("recording", "track");
  // The job ends exactly while the waiting probe checks lisa, if the probe checks hosts while the job holds its
  // recording (it then saw WSL held). Otherwise the job ends while the probe waits.
  const release = async () => {
    fake.hosts.wsl.holdAt = null;
    await until(() => !leaseHeld(created.id), "the job's lease released");
  };
  let lisaChecks = 0;
  setAlignmentPoolDepsForTests({
    ...fake.deps,
    async probe(target, options) {
      if (target === fake.hosts.lisa.sshTarget && lisaChecks++ === 0) await release();
      return fake.deps.probe(target, options);
    },
  });
  let waits = 0;
  const session = createCtcProbeSession(created.recordingId, {
    waitMs: 60_000,
    sleep: async () => { if (++waits === 1) await release(); },
  });
  const [score] = await session.score({ fragmentTexts: sentences.map((sentence) => sentence.text), language: "eng",
    samples: [{ trackId, time: 0, duration: 30 }] });
  assert.equal(score.match?.fragment, 0);
  assert.deepEqual(fake.hosts.lisa.requests, [], "the probe did not take lisa while WSL was free");
  assert.deepEqual(fake.hosts.wsl.requests, ["/anchor"]);
  assert.equal(lisaChecks, 0, "no host was checked while the job held the recording");
  assert.equal(waits, 1, "the probe waited for the job");
  await session.release();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(slotsHeld(), 0);
});

test("a result that names another engine is not published: the job moves to the other host", async () => {
  fake.hosts.wsl.resultEngine = CTC_ENGINE;
  const job = await settled((await anchoredJob()).id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.engine, BOOK_ENGINE);
  assert.equal(job.pool?.hostId, "lisa");
});

test("the worker's result becomes the stored map in one function: checked intervals, outcome, passages and flags", () => {
  const { applyBookResult } = bookJob;
  const [first, second, third] = sentences;
  const trackIds = new Set(["track-a"]);
  const base = (): Parameters<typeof applyBookResult>[0] => ({
    id: "unit", ebookId: "book-ebook", recordingId: "unit-recording", status: "processing", progress: 0.5, engine: BOOK_ENGINE,
    error: "an earlier host failed", warning: null, intervals: [], sectionsDone: [], elapsedSeconds: 0, fingerprint: "f",
    audioFingerprint: "a", createdAt: 1, updatedAt: 1, coverage: 0, pairings: [], mode: "anchored",
    anchoring: { stage: "sampling", refinements: 0, samples: [{ trackId: "track-a", time: 0, duration: 30 }], anchors: [], segments: [], rate: 0, flags: [] },
  });
  const interval = (paragraphId: string, start: number, extra: object = {}) =>
    ({ paragraphId, section: 99, trackId: "track-a", start, end: start + 1, confidence: 0.65, ...extra });
  const result = (outcome: string, intervals: object[]) => ({
    jobId: "unit-x", engine: BOOK_ENGINE, outcome, intervals,
    stageTimings: { decode: 1.5, encode: 2, note: "text" }, encode: { gpuUtilization: null },
  }) as Parameters<typeof applyBookResult>[3];

  const job = base();
  const mapped = applyBookResult(job, book, trackIds, result("mapped", [
    interval(third.id, 9), interval(first.id, 1),
    interval(first.id, 50), // a second interval for one sentence: the first one counts
    interval("not-a-sentence", 3), interval(second.id, 5, { trackId: "another-recording" }), interval(second.id, 7, { end: 7 }),
  ]));
  assert.deepEqual(mapped, { status: "partial" });
  assert.deepEqual(job.intervals, [
    { paragraphId: first.id, section: first.section, trackId: "track-a", start: 1, end: 2, confidence: 0.65 },
    { paragraphId: third.id, section: third.section, trackId: "track-a", start: 9, end: 10, confidence: 0.65 },
  ]);
  assert.equal(job.coverage, 2 / sentences.length);
  assert.equal(job.outcome, "partial");
  assert.deepEqual(job.unsyncedPassages?.map((passage) => passage.firstParagraphId), [second.id, sentences[3].id]);
  assert.deepEqual(job.stageTimings, { decode: 1.5, encode: 2 });
  assert.equal(job.elapsedSeconds, 3.5);
  assert.equal(job.gpuUtilization, null);
  assert.equal(job.progress, 1);
  assert.equal(job.error, null);
  assert.match(job.warning ?? "", /estimated/);
  assert.equal(job.anchoring?.stage, "done");
  assert.deepEqual(job.anchoring?.samples, []);

  const mismatch = base();
  assert.deepEqual(applyBookResult(mismatch, book, trackIds, result("text_mismatch", [])), { status: "partial" });
  assert.deepEqual(mismatch.intervals, []);
  assert.equal(mismatch.outcome, "unsynced");
  assert.equal(mismatch.error, null);
  assert.match(mismatch.warning ?? "", /does not match this ebook/);
  assert.equal(mismatch.unsyncedPassages?.reduce((count, passage) => count + passage.sentenceCount, 0), sentences.length);

  const unsynced = base();
  assert.deepEqual(applyBookResult(unsynced, book, trackIds, result("unsynced", [])), { status: "partial" });
  assert.equal(unsynced.outcome, "unsynced");
  assert.equal(unsynced.coverage, 0);
  assert.match(unsynced.warning ?? "", /could not be matched/);

  const language = base();
  assert.deepEqual(applyBookResult(language, book, trackIds, result("language_not_supported", [])),
    { error: "The alignment worker does not support this language.", outcome: "language_not_supported" });
  assert.deepEqual(language.intervals, []);

  assert.deepEqual(applyBookResult(base(), book, trackIds, result("a_later_outcome", [])),
    { error: "The alignment worker returned an outcome this server does not know (a_later_outcome).", outcome: "error" });
});

test("chapter-paired jobs run as whole-book jobs on the pool too; a second book waits for WSL, not lisa", async () => {
  fake.hosts.wsl.holdAt = "encoding";
  const chapterJob = async () => {
    const { recordingId, trackId } = recording();
    const pairings = book.sections.map((section, i) => ({ section: section.index, trackId, start: 10 + i * 100, duration: 80 }));
    return createAlignment("book-ebook", recordingId, pairings, "chapters");
  };
  const one = await chapterJob();
  await until(() => alignmentJob(one.id).bookJob?.state === "encoding", "first encoding");
  // WSL is healthy and at its limit (one slot, held by the first book): the second book waits in the queue.
  const two = await chapterJob();
  const waiting = await settled(two.id, ["queued"]);
  assert.equal(waiting.bookJob, undefined);
  assert.deepEqual(fake.hosts.lisa.book, [], "nothing was started or staged on lisa");
  assert.deepEqual(fake.stagedFolders("lisa"), []);
  assert.match(waiting.poolErrors?.wsl ?? "", /busy/);
  fake.hosts.wsl.holdAt = null;
  assert.equal((await settled(one.id)).status, "partial");
  await processAlignments();
  const second = await settled(two.id);
  assert.equal(second.status, "partial", second.error ?? undefined);
  assert.equal(second.pool?.hostId, "wsl");
  assert.equal(fake.hosts.wsl.starts.length, 2);
  assert.deepEqual(fake.hosts.lisa.book, []);
  assert.deepEqual(fake.hosts.wsl.requests, [], "no window request");
});

test("a whole-book job waits for a busy, healthy WSL and then runs there; with WSL down it runs on lisa", async () => {
  fake.hosts.wsl.busy = true;
  const created = await anchoredJob();
  const waiting = await settled(created.id, ["queued"]);
  assert.deepEqual(fake.hosts.lisa.book, [], "lisa got no book");
  assert.deepEqual(fake.stagedFolders("lisa"), []);
  assert.deepEqual(waiting.pool?.triedHosts ?? [], [], "a busy host is not tried");
  fake.hosts.wsl.busy = false;
  await processAlignments();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "wsl");
  assert.deepEqual(fake.hosts.lisa.book, []);

  await install();
  fake.hosts.wsl.down = true;
  const fallback = await settled((await anchoredJob()).id);
  assert.equal(fallback.status, "partial", fallback.error ?? undefined);
  assert.equal(fallback.pool?.hostId, "lisa");
});

test("which host a lease gives: CPU hosts are a whole-book job's fallback only; window jobs and probes keep rank order", async () => {
  const { recordingId, trackId } = recording();
  const track = db.select().from(schema.tracks).all().find((row) => row.id === trackId)!;
  let leases = 0;
  const lease = (request: Partial<Parameters<typeof pool.acquireWorkerLease>[0]>) => pool.acquireWorkerLease({
    id: `lease-${++leases}`, recordingId, mode: "anchored", tracks: [track], localAudio: (row) => row.source, kind: "job", ...request,
  });
  const hostOf = async (request: Partial<Parameters<typeof pool.acquireWorkerLease>[0]>) => {
    const held = await lease(request);
    const hostId = held.hostId;
    await held.release("finished");
    return hostId;
  };

  // WSL healthy and busy: a book job is refused as busy (it waits); a window job and a probe take lisa as today.
  fake.hosts.wsl.busy = true;
  await assert.rejects(() => lease({ book: true }), pool.PoolBusyError);
  assert.deepEqual(fake.stagedFolders("lisa"), [], "nothing staged on lisa for the book");
  assert.equal(await hostOf({}), "lisa", "window job");
  assert.equal(await hostOf({ kind: "probe" }), "lisa", "probe");
  // WSL's slot held by another lease of this server: the same.
  fake.hosts.wsl.busy = false;
  const other = recording();
  const otherTrack = db.select().from(schema.tracks).all().find((row) => row.id === other.trackId)!;
  const holder = await pool.acquireWorkerLease({ id: "holder", recordingId: other.recordingId, mode: "anchored",
    tracks: [otherTrack], localAudio: (row) => row.source, kind: "job", book: true });
  assert.equal(holder.hostId, "wsl");
  await assert.rejects(() => lease({ book: true }), pool.PoolBusyError);
  await holder.release("finished");

  // WSL cannot be used: down, without whole-book jobs, or it already failed this job. The book goes to lisa.
  fake.hosts.wsl.down = true;
  assert.equal(await hostOf({ book: true }), "lisa", "WSL down");
  fake.hosts.wsl.down = false;
  fake.hosts.wsl.noBookJobs = true;
  assert.equal(await hostOf({ book: true }), "lisa", "WSL without the book engine");
  fake.hosts.wsl.noBookJobs = false;
  fake.hosts.wsl.busy = true;
  fake.hosts.wsl.stuck = true;
  assert.equal(await hostOf({ book: true }), "lisa", "WSL stuck");
  fake.hosts.wsl.stuck = false;
  assert.equal(await hostOf({ book: true, triedHosts: ["wsl"] }), "lisa", "WSL failed this job");
  // The host a book was started on is leased first, also lisa (after a restart the worker's job is there).
  fake.hosts.wsl.busy = false;
  assert.equal(await hostOf({ book: true, firstHost: "lisa" }), "lisa", "started on lisa");
  assert.equal(await hostOf({ book: true }), "wsl", "WSL free");
  assert.equal(slotsHeld(), 0);

  // WSL's slot taken by another lease between its health answer and the slot claim: the book still waits.
  const coord = getAlignmentPoolCoordinator();
  setAlignmentPoolDepsForTests({ ...fake.deps, probe: async (target, options) => {
    if (target === fake.hosts.wsl.sshTarget) assert.ok(coord.tryAcquireCtc("wsl", "racer", other.recordingId, 1));
    return fake.deps.probe(target, options);
  } });
  const stagedOnLisa = fake.stagedFolders("lisa").length;
  try {
    await assert.rejects(() => lease({ book: true }), pool.PoolBusyError);
    assert.equal(fake.stagedFolders("lisa").length, stagedOnLisa, "nothing staged on lisa for the book");
  } finally {
    coord.release("wsl", "racer", other.recordingId);
    setAlignmentPoolDepsForTests(fake.deps);
  }
});

test("the fallback rule follows the configured device and rank, not the host's name", async () => {
  const { recordingId, trackId } = recording();
  const track = db.select().from(schema.tracks).all().find((row) => row.id === trackId)!;
  const hostOf = async (book: boolean) => {
    const held = await pool.acquireWorkerLease({ id: `device-${++n}`, recordingId, mode: "anchored", tracks: [track],
      localAudio: (row) => row.source, kind: "job", book });
    const hostId = held.hostId;
    await held.release("finished");
    return hostId;
  };
  // lisa ranked first: a book still goes to the GPU host, a window job to lisa as ranked.
  resetAlignmentPoolCoordinator(fake.poolHosts(["lisa", "wsl"]));
  assert.equal(await hostOf(true), "wsl");
  assert.equal(await hostOf(false), "lisa");
  // Both hosts GPUs: a book takes the second while the first is busy.
  fake.hosts.lisa.device = "cuda";
  fake.hosts.lisa.precision = "float16";
  resetAlignmentPoolCoordinator(fake.poolHosts(["wsl", "lisa"]));
  fake.hosts.wsl.busy = true;
  assert.equal(await hostOf(true), "lisa");
});

test("the stored job keeps the worker's counts for the stage it is in, which the Reading sync page shows", async () => {
  const { runPoint, readingSyncPage } = await import("../src/pages/reading-sync-model.ts");
  const encoding = await heldJob("encoding");
  assert.deepEqual(alignmentJob(encoding.id).bookJob?.counts, { tracksTotal: 1, tracksDecoded: 1, tracksEncoded: 0, encodeQueuePosition: 0 });
  assert.deepEqual(runPoint(alignmentJob(encoding.id)), { step: "encoding", value: "0 of 1 file", progress: 0 });
  fake.hosts.wsl.holdAt = "aligning";
  await until(() => alignmentJob(encoding.id).bookJob?.state === "aligning", "aligning stored");
  assert.deepEqual(alignmentJob(encoding.id).bookJob?.counts, { tracksTotal: 1, tracksDecoded: 1, tracksEncoded: 1, groupsTotal: 2, groupsDone: 0 });
  assert.deepEqual(runPoint(alignmentJob(encoding.id)), { step: "aligning", value: "0 of 2 parts", progress: 0 });
  fake.hosts.wsl.holdAt = null;
  const done = await settled(encoding.id);
  const page = readingSyncPage({ admin: true, job: done, offline: false, stored: null, languageMatch: true, pool: null, now: Date.now() });
  assert.ok(["ready", "partial", "no-match"].includes(page.state), page.state);
});

test("with the pool off the rebuild scan queues no whole-book rebuild", async () => {
  const created = await anchoredJob();
  await settled(created.id);
  only(created.id);
  windowEngineMap(created.id, 1);
  process.env.ALIGNMENT_POOL_ENABLED = "0";
  try {
    assert.equal((await queueEngineRebuilds({ warn: () => {} })).queued, 0);
    assert.equal(alignmentJob(created.id).engine, CTC_ENGINE);
  } finally {
    process.env.ALIGNMENT_POOL_ENABLED = "1";
  }
});

test("a host that failed the job is not tried first again when the job waited in the queue meanwhile", async () => {
  fake.hosts.wsl.failAt = { stage: "aligning", error: "CUDA out of memory" };
  fake.hosts.lisa.busy = true;
  const created = await anchoredJob();
  const waiting = await settled(created.id, ["queued"]);
  assert.equal(waiting.bookJob, undefined, "the failed host's worker job is no longer the job's");
  assert.deepEqual(waiting.pool?.triedHosts, ["wsl"]);
  fake.hosts.lisa.busy = false;
  await processAlignments();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "lisa");
  assert.equal(fake.hosts.wsl.starts.length, 1, "WSL was not tried again");
});

// Review round 1 (#404): restart, cancel, result fetch, a job the worker may be running, broken bodies.

/** The folder names retired for this job (#421): nothing stages into them again. */
const retiredNames = (id: string) =>
  (sqlite.prepare("SELECT name FROM alignment_pool_retired WHERE job_id=? ORDER BY name").all(id) as { name: string }[]).map((row) => row.name);

test("after a server restart the worker's job is polled without staging: nothing is uploaded while it exists", async () => {
  const created = await heldJob();
  const workerJobId = bookWorkerJobId(created);
  const uploads = fake.hosts.wsl.uploads.length;
  await restartServer(() => { fake.hosts.wsl.holdAt = null; });
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(fake.hosts.wsl.uploads.length, uploads, "the restarted run uploads nothing");
  assert.deepEqual(fake.hosts.wsl.uploadsIntoLiveJobs, []);
  assert.deepEqual(calls("wsl"), ["POST /book-jobs", `GET /book-jobs/${workerJobId}/result`]);
  assert.equal(job.pool?.jobMediaRoot, join(fake.hosts.wsl.root, "alignment", "pool-jobs", created.id), "the staging stays recorded");
});

test("after a server restart a 404 for the worker's job stages the tracks again, after the poll and before the start", async () => {
  const created = await heldJob();
  const uploads = fake.hosts.wsl.uploads.length;
  let atFirstPoll = -1, atStart = -1;
  await restartServer(() => {
    fake.restart("wsl", { keepJobs: false, resumingFor: 0 });
    fake.hosts.wsl.holdAt = null;
    fake.hosts.wsl.onBook = (method, path) => {
      if (method === "GET" && !path.endsWith("/result") && atFirstPoll < 0) atFirstPoll = fake.hosts.wsl.uploads.length;
      if (method === "POST" && atStart < 0) atStart = fake.hosts.wsl.uploads.length;
    };
  });
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(atFirstPoll, uploads, "nothing is uploaded before the worker answers for its job");
  assert.ok(atStart > uploads, "the 404 stages the tracks again before the start");
  assert.deepEqual(fake.hosts.wsl.uploadsIntoLiveJobs, []);
});

test("a start whose reply was lost: after a server restart the worker's job is polled, not staged over or started again", async () => {
  fake.hosts.wsl.loseStartReplies = 1_000_000;
  const created = await anchoredJob();
  const workerJobId = bookWorkerJobId(created);
  await until(() => fake.hosts.wsl.jobs.has(workerJobId), "the worker has the job");
  await restartServer(() => { fake.hosts.wsl.loseStartReplies = 0; });
  const starts = fake.hosts.wsl.starts.length;
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "wsl");
  assert.equal(fake.hosts.wsl.starts.length, starts, "the restarted run starts nothing");
  assert.deepEqual(fake.hosts.wsl.uploadsIntoLiveJobs, []);
  assert.deepEqual(fake.hosts.lisa.book, []);
});

test("pause and cancel wait for the worker's answer to the cancel before the lease is released", async () => {
  for (const action of ["pause", "cancel"] as const) {
    await install();
    const created = await heldJob();
    const workerJobId = bookWorkerJobId(created);
    let answer!: () => void;
    fake.hosts.wsl.holdCancel = new Promise((resolve) => { answer = resolve; });
    transition[action](alignmentJob(created.id));
    await until(() => fake.hosts.wsl.book.includes(`DELETE /book-jobs/${workerJobId}`), `${action}: cancel sent`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(leaseHeld(created.id), `${action}: the lease is held while the worker stops its job`);
    assert.ok(alignmentSchedulerForTests().running().includes(created.id), `${action}: the run has not returned`);
    answer();
    const job = await settled(created.id, [action === "pause" ? "paused" : "cancelled"]);
    assert.equal(fake.hosts.wsl.jobs.size, 0, action);
    assert.equal(slotsHeld(), 0, action);
    assert.deepEqual(retiredNames(created.id), [], `${action}: a cancel that succeeded retires nothing`);
    assert.equal(job.poolErrors?.wsl, undefined, action);
  }
});

test("a cancel answered 404 (the worker no longer has the job) is a success: nothing is retired or recorded", async () => {
  const created = await heldJob();
  const workerJobId = bookWorkerJobId(created);
  fake.hosts.wsl.onBook = (method) => { if (method === "DELETE") fake.hosts.wsl.jobs.clear(); };
  transition.pause(alignmentJob(created.id));
  const paused = await settled(created.id, ["paused"]);
  assert.ok(calls("wsl").includes(`DELETE /book-jobs/${workerJobId}`));
  assert.deepEqual(retiredNames(created.id), []);
  assert.equal(paused.poolErrors?.wsl, undefined);
  fake.hosts.wsl.holdAt = null;
  transition.resume(alignmentJob(created.id));
  void processAlignments();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.jobMediaRoot, join(fake.hosts.wsl.root, "alignment", "pool-jobs", created.id), "the folder is used again");
});

test("a cancel that fails or does not answer in time: the lease is released, the failure recorded, the next run stages under a new name", async () => {
  for (const [label, breakCancel] of [
    ["503", () => { fake.hosts.wsl.cancelFails = 1; }],
    ["timeout", () => { fake.hosts.wsl.holdCancel = new Promise(() => {}); setBookWorkerTimeoutsForTests({ cancel: 50 }); }],
  ] as const) {
    await install();
    const created = await heldJob();
    const firstId = bookWorkerJobId(created);
    breakCancel();
    transition.pause(alignmentJob(created.id));
    const paused = await settled(created.id, ["paused"]);
    setBookWorkerTimeoutsForTests(null);
    assert.equal(slotsHeld(), 0, `${label}: the lease is released`);
    assert.ok(calls("wsl").includes(`DELETE /book-jobs/${firstId}`), label);
    assert.ok(fake.hosts.wsl.jobs.has(firstId), `${label}: the worker's job may still be running`);
    assert.match(paused.poolErrors?.wsl ?? "", /cancel/i, `${label}: recorded with the job's pool state`);
    assert.deepEqual(retiredNames(created.id), [created.id], `${label}: the run's folder name is retired`);

    // Resume: the job still running on the worker reads the old folder, so the new run stages under a new name.
    fake.hosts.wsl.holdAt = null;
    fake.hosts.wsl.holdCancel = null;
    transition.resume(alignmentJob(created.id));
    void processAlignments();
    const job = await settled(created.id);
    assert.equal(job.status, "partial", `${label}: ${job.error}`);
    assert.equal(job.pool?.jobMediaRoot, join(fake.hosts.wsl.root, "alignment", "pool-jobs", `${created.id}.r1`), label);
    assert.deepEqual(fake.hosts.wsl.uploadsIntoLiveJobs, [], `${label}: nothing is uploaded into the old folder`);
  }
});

test("a cancelled job whose cancel fails releases its lease and retires its folder name", async () => {
  const created = await heldJob();
  fake.hosts.wsl.cancelFails = 1;
  transition.cancel(alignmentJob(created.id));
  await settled(created.id, ["cancelled"]);
  assert.equal(slotsHeld(), 0);
  assert.deepEqual(retiredNames(created.id), [created.id]);
});

test("a result that cannot be fetched while the status says done: after the bound the host has failed for this job", async () => {
  for (const status of [503, 409]) {
    await install();
    fake.hosts.wsl.resultAnswer = status;
    let doneAt = 0, failedOverAt = 0;
    fake.hosts.wsl.onBook = (method, path) => { if (method === "GET" && path.endsWith("/result") && !doneAt) doneAt = now; };
    fake.hosts.lisa.onBook = (method) => { if (method === "POST" && !failedOverAt) failedOverAt = now; };
    const job = await settled((await anchoredJob()).id);
    assert.equal(job.status, "partial", `${status}: ${job.error}`);
    assert.equal(job.pool?.hostId, "lisa", String(status));
    assert.ok(failedOverAt - doneAt >= BOOK_WORKER_RESTART_WAIT_MS, `${status}: waited the bound`);
    assert.ok(failedOverAt - doneAt < BOOK_WORKER_RESTART_WAIT_MS + 3 * BOOK_POLL_MS, `${status}: and not much longer`);
    assert.ok(calls("wsl").some((call) => call.startsWith("DELETE")), `${status}: the job on the failed host is cancelled`);
  }
});

test("a start whose reply was lost is cancelled on pause", async () => {
  fake.hosts.wsl.loseStartReplies = 1_000_000;
  const created = await anchoredJob();
  const workerJobId = bookWorkerJobId(created);
  await until(() => fake.hosts.wsl.jobs.has(workerJobId), "the worker has the job");
  transition.pause(alignmentJob(created.id));
  await settled(created.id, ["paused"]);
  assert.ok(calls("wsl").includes(`DELETE /book-jobs/${workerJobId}`));
  assert.equal(fake.hosts.wsl.jobs.size, 0);
});

test("fallback after a lost start reply: the first host's job is cancelled, and answered, before the second host starts", async () => {
  fake.hosts.wsl.loseStartReplies = 1_000_000;
  fake.hosts.wsl.holdCancel = new Promise((resolve) => setTimeout(resolve, 200));
  let cancelAnswered: boolean | null = null;
  fake.hosts.lisa.onBook = (method) => {
    if (method === "POST" && cancelAnswered === null) cancelAnswered = fake.hosts.wsl.answered.some((call) => call.startsWith("DELETE"));
  };
  const job = await settled((await anchoredJob()).id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "lisa");
  assert.equal(cancelAnswered, true, "lisa started only after WSL answered the cancel");
  assert.equal(fake.hosts.wsl.jobs.size, 0);
});

test("a terminal failure on the last host cancels the worker's job before the job fails", async () => {
  await install(["wsl"]);
  const created = await heldJob();
  fake.hosts.wsl.statusAnswer = 400;
  const job = await settled(created.id);
  assert.equal(job.status, "error");
  assert.match(job.error ?? "", /refused/);
  assert.ok(calls("wsl").includes(`DELETE /book-jobs/${bookWorkerJobId(created)}`));
  assert.equal(fake.hosts.wsl.jobs.size, 0, "the worker's job was cancelled before the lease was released");
});

test("after a server restart on another host the first host's job is cancelled before the second starts", async () => {
  const created = await heldJob();
  const workerJobId = bookWorkerJobId(created);
  let cancelAnswered: boolean | null = null;
  fake.hosts.lisa.onBook = (method) => {
    if (method === "POST" && cancelAnswered === null) cancelAnswered = fake.hosts.wsl.answered.includes(`DELETE /book-jobs/${workerJobId}`);
  };
  // WSL now cannot take whole-book jobs (a busy WSL is waited for instead): the job moves to lisa.
  await restartServer(() => { fake.hosts.wsl.noBookJobs = true; });
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "lisa");
  assert.equal(cancelAnswered, true);
  assert.equal(fake.hosts.wsl.jobs.size, 0);
});

test("a status or result body cut after its headers, not JSON or not a progress answer, is a failed answer: the job continues on its host", async () => {
  fake.hosts.wsl.cutStatus = 2;
  fake.hosts.wsl.garbleStatus = 1;
  fake.hosts.wsl.misshapeStatus = 1;
  fake.hosts.wsl.cutResult = 1;
  const job = await settled((await anchoredJob()).id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "wsl");
  // The cut result was consumed: the worker no longer has the job, so it ran again there.
  assert.equal(fake.hosts.wsl.starts.length, 2);
  assert.deepEqual(fake.hosts.lisa.book, []);
});

test("a host whose status bodies stay unreadable has failed for this job after the bound", async () => {
  const created = await heldJob();
  fake.hosts.wsl.cutStatus = 1_000_000;
  fake.hosts.wsl.holdAt = null;
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "lisa");
});

/** A recording of its own whose one track has chapter markers: a 20 s introduction, then one chapter per section. */
function chapteredRecording(titles: string[]) {
  const { recordingId, trackId } = recording();
  const starts = [0, 20, ...book.sections.slice(1).map((_, i) => 200 + i * 100)].slice(0, titles.length);
  const chapters = titles.map((title, i) => ({ title, start: starts[i], ...(i + 1 < titles.length ? { end: starts[i + 1] } : {}) }));
  sqlite.prepare("UPDATE tracks SET chapters=? WHERE id=?").run(JSON.stringify(chapters), trackId);
  return { recordingId, trackId, chapters };
}

test("pairings change nothing in a whole-book job (#405, #348): a shifted pairing, the right one and anchored send the same request and store the same map", async () => {
  const { recordingId, trackId, chapters } = chapteredRecording(["Introduction", ...book.sections.map((_, i) => `Chapter ${i + 1}`)]);
  const clip = (i: number) => ({ trackId, start: chapters[i].start, duration: (chapters[i].end ?? 400) - chapters[i].start });
  // #348: ebook section 1 paired with the 20 s introduction, and so on, one chapter early.
  const shifted = book.sections.map((section, i) => ({ section: section.index, ...clip(i) }));
  const right = book.sections.map((section, i) => ({ section: section.index, ...clip(i + 1) }));
  assert.ok(book.sections.length >= 2);
  assert.notDeepEqual(shifted, right);
  const maps = [];
  for (const [pairings, mode] of [[shifted, "chapters"], [right, "chapters"], [undefined, "anchored"]] as const) {
    const created = await createAlignment("book-ebook", recordingId, pairings ? [...pairings] : undefined, mode);
    assert.equal(created.engine, BOOK_ENGINE);
    const job = await settled(created.id);
    assert.equal(job.status, "partial", job.error ?? undefined);
    assert.deepEqual(job.pairings, pairings ?? [], "the job stores the pairing it was given");
    maps.push({ intervals: job.intervals, coverage: job.coverage, outcome: job.outcome, warning: job.warning,
      unsyncedPassages: job.unsyncedPassages, flags: job.anchoring?.flags ?? [] });
  }
  const requests = fake.hosts.wsl.starts.map(({ jobId: _, tracks, ...request }) =>
    ({ ...request, tracks: tracks.map(({ id, duration }: { id: string; duration: number }) => ({ id, duration })) }));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.deepEqual(Object.keys(requests[0]).sort(), ["audioFingerprint", "language", "recordingId", "sentences", "tracks"]);
  assert.deepEqual(requests[0].sentences, sentences, "every sentence of the book, whatever was paired");
  assert.deepEqual(maps[1], maps[0]);
  assert.deepEqual(maps[2], maps[0]);
});

test("the options say which runner a Prepare starts; with whole-book jobs a chaptered release with no matched section is planned anchored, not refused", async () => {
  const { alignmentOptions } = alignment;
  // The fixture's sections are too short to be matched by title, so nothing pairs automatically.
  const { recordingId } = chapteredRecording(["Opening credits", "Part the first", "Part the second"]);
  const options = await alignmentOptions("book-ebook", recordingId);
  assert.equal(options.bookJobs, true);
  assert.equal(options.anchored, false);
  assert.deepEqual(options.pairings, []);
  const created = await createAlignment("book-ebook", recordingId);
  assert.equal(created.engine, BOOK_ENGINE);
  assert.equal(created.mode, "anchored");
  assert.deepEqual(created.pairings, []);
  assert.equal((await settled(created.id)).status, "partial");

  delete process.env.ALIGNMENT_BOOK_JOBS;
  const off = chapteredRecording(["Opening credits", "Part the first", "Part the second"]);
  assert.equal((await alignmentOptions("book-ebook", off.recordingId)).bookJobs, false);
  await assert.rejects(createAlignment("book-ebook", off.recordingId), /Match ebook sections to audio chapters before preparing sync/);
});
