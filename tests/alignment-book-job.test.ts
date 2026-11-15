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
  alignmentSchedulerForTests, queueEngineRebuilds } = alignment;
const transition = await import("../server/alignment-transitions.ts");
const pool = await import("../server/alignment-pool.ts");
const { getAlignmentPoolCoordinator, resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests } = pool;
const { BOOK_ENGINE, CTC_ENGINE, bookJobsEnabled } = await import("../server/alignment-engine.ts");
const { currentAlignmentEngine } = await import("../server/alignment-rebuild.ts");
const bookJob = await import("../server/alignment-book-job.ts");
const { BOOK_POLL_MS, BOOK_WORKER_RESTART_WAIT_MS, bookWorkerJobId, setBookJobClockForTests } = bookJob;
const { createCtcProbeSession } = await import("../server/ebook-set-ctc-session.ts");

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
  fake.hosts.wsl.busy = true;
  const created = await heldJob("encoding", "lisa");
  assert.equal(alignmentJob(created.id).pool?.hostId, "lisa");
  await restartServer(() => {
    fake.hosts.wsl.busy = false;
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
