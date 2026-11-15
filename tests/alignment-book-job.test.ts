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
