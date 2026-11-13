// Bounded alignment scheduler (#276) against fake WSL and lisa CTC workers.
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { readerFixture } from "./reader-fixture.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-scheduler-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
delete process.env.ALIGNMENT_CHAPTER_ENGINE;
process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
process.env.ALIGNMENT_POOL_ENABLED = "1";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });

const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { extractBook } = await import("../server/reader.ts");
const { setPaused } = await import("../server/activity-pause.ts");
const {
  createAlignment, alignmentJob, putAlignmentJob, processAlignments, stopAlignments,
  resetAlignmentRunnerForTests, alignmentSchedulerForTests,
} = await import("../server/alignment.ts");
const { resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests } = await import("../server/alignment-pool.ts");
const { AlignmentScheduler, ALIGNMENT_ADMITTED_BOOKS, StaleAlignmentRun } = await import("../server/alignment-scheduler.ts");
type AlignmentJob = ReturnType<typeof alignmentJob>;

const engine = "ctc-wav2vec2-base-960h-torchaudio-2.8-v1";
const hosts = [
  { id: "wsl" as const, sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://ctc-worker.test" },
  { id: "lisa" as const, sshTarget: "lisa", maxConcurrent: 1, remoteWorkRoot: temp, workerUrl: "http://lisa-worker.test" },
];
resetAlignmentPoolCoordinator(hosts);
setAlignmentPoolDepsForTests({
  async probe() { return true; },
  async exec() { return { code: 0, stdout: "", stderr: "" }; },
  async uploadFile(local: string, remote: string) {
    mkdirSync(dirname(remote), { recursive: true });
    copyFileSync(local, remote);
  },
});

type Held = { host: "wsl" | "lisa"; recordingId: string; request: Record<string, any>; resolve: (response: Response) => void };
const held: Held[] = [];
const requests: Held[] = [];
let inFlight = 0, maxInFlight = 0;
const perRecording = new Map<string, number>();
let maxPerRecording = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!/ctc-worker\.test|lisa-worker\.test/.test(url)) return originalFetch(input, init);
  const host = url.includes("lisa-worker") ? "lisa" : "wsl";
  if (url.endsWith("/health"))
    return Response.json({ ready: true, busy: false, stuck: false, mediaRoot: join(temp, host),
      ctc: { engine, ready: true, device: host === "lisa" ? "cpu" : "cuda", precision: host === "lisa" ? "float32" : "float16",
        anchorReady: true, passageReady: true } });
  const request = JSON.parse(String(init?.body));
  const recordingId = String(request.recordingId);
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  perRecording.set(recordingId, (perRecording.get(recordingId) ?? 0) + 1);
  maxPerRecording = Math.max(maxPerRecording, perRecording.get(recordingId)!);
  try {
    return await new Promise<Response>((resolve) => {
      const entry = { host, recordingId, request, resolve } as Held;
      held.push(entry);
      requests.push(entry);
    });
  } finally {
    inFlight--;
    perRecording.set(recordingId, perRecording.get(recordingId)! - 1);
  }
};

const mapped = (request: Record<string, any>, extra: Record<string, unknown> = {}) =>
  Response.json({ engine, outcome: "mapped", elapsedSeconds: 1, stageTimings: { acousticEncoding: 0.1 },
    intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * 0.5, end: request.start + i * 0.5 + 0.4 })),
    ...extra });

async function until(condition: () => boolean, what: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const take = (filter: (entry: Held) => boolean = () => true) => {
  const index = held.findIndex(filter);
  assert.ok(index >= 0, "expected a held worker request");
  return held.splice(index, 1)[0];
};
const finished = (id: string) => !["queued", "copying", "processing"].includes(alignmentJob(id).status);
/** Answers every worker request until the jobs leave the active states. */
async function drive(ids: string[], answer = (entry: Held) => mapped(entry.request), paceMs = 2) {
  const deadline = Date.now() + 5000;
  while (!ids.every(finished)) {
    if (Date.now() > deadline) throw new Error(`Jobs did not finish: ${ids.map((id) => alignmentJob(id).status)}`);
    if (held.length) {
      const entry = held.shift()!;
      entry.resolve(answer(entry));
    }
    await new Promise((resolve) => setTimeout(resolve, paceMs));
  }
  await until(() => ids.every((id) => !alignmentSchedulerForTests().running().includes(id)), "runs to end");
}

// Three works, one recording and one EPUB each, plus a second EPUB of book A.
const books = ["a", "b", "c"] as const;
for (const name of books) {
  const audio = join(process.env.MEDIA_ROOT, `${name}.wav`);
  const ebook = join(process.env.MEDIA_ROOT, `${name}.epub`);
  writeFileSync(audio, `audio ${name}`);
  writeFileSync(ebook, await readerFixture({ bodies: [`<p>${name} one. ${name} two. ${name} three.</p>`, `<p>${name} four. ${name} five. ${name} six.</p>`] }));
  db.insert(schema.works).values({ id: `work-${name}`, title: `Book ${name}`, author: "Author", description: "", genre: "", year: 2026 }).run();
  db.insert(schema.editions).values({ id: `edition-${name}`, workId: `work-${name}`, cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: `rec-${name}`, editionId: `edition-${name}` }).run();
  db.insert(schema.tracks).values({ id: `track-${name}`, recordingId: `rec-${name}`, title: name, index: 0, duration: 400, chapters: [], source: audio, sourceType: "local" }).run();
  db.insert(schema.ebookEditions).values({ id: `ebook-${name}`, workId: `work-${name}`, format: "epub", source: ebook }).run();
}
const secondEbook = join(process.env.MEDIA_ROOT, "a2.epub");
writeFileSync(secondEbook, await readerFixture({ bodies: ["<p>Other one. Other two.</p>", "<p>Other three. Other four.</p>"] }));
db.insert(schema.ebookEditions).values({ id: "ebook-a2", workId: "work-a", format: "epub", source: secondEbook }).run();

async function pairings(ebookId: string, trackId: string, offset = 10) {
  const book = await extractBook(ebookId);
  return book.sections.map((section, i) => ({ section: section.index, trackId, start: offset + i * 100, duration: 80 }));
}
const create = async (name: string, ebookId = `ebook-${name}`, offset = 10) =>
  createAlignment(ebookId, `rec-${name}`, await pairings(ebookId, `track-${name}`, offset), "chapters");
const mapPath = (id: string) => join(process.env.MEDIA_ROOT!, "alignment", id, "map.json");
const claim = (id: string) =>
  sqlite.prepare("SELECT claim_owner, claim_generation, claimed_at FROM alignment_jobs WHERE id=?").get(id) as
    { claim_owner: string | null; claim_generation: string | null; claimed_at: number | null };

const app = await createApp();
after(async () => {
  globalThis.fetch = originalFetch;
  for (const entry of held.splice(0)) entry.resolve(new Response("stopped", { status: 503 }));
  stopAlignments();
  await app.close();
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

function reset() {
  for (const entry of held.splice(0)) entry.resolve(new Response("stopped", { status: 503 }));
  requests.length = 0;
  maxInFlight = 0;
  maxPerRecording = 0;
  resetAlignmentRunnerForTests();
  resetAlignmentPoolCoordinator(hosts);
  setPaused("alignment", false);
  // Section results are cached per job and pairing; every test talks to the workers itself.
  rmSync(join(process.env.MEDIA_ROOT!, "alignment"), { recursive: true, force: true });
}

async function latency(t: TestContext, label: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)], max = sorted.at(-1)!;
  t.diagnostic(`${label}: GET /api/health n=${sorted.length} p50=${p50.toFixed(2)} ms max=${max.toFixed(2)} ms`);
  return { p50, max };
}

test("two books progress at once on WSL and lisa while the API keeps answering", async (t) => {
  reset();
  const a = await create("a"), b = await create("b");
  await until(() => held.length === 2, "both books on a worker");
  assert.deepEqual(new Set(held.map((entry) => entry.host)), new Set(["wsl", "lisa"]));
  assert.deepEqual(new Set(held.map((entry) => entry.recordingId)), new Set(["rec-a", "rec-b"]));
  assert.equal(alignmentJob(a.id).status, "processing");
  assert.equal(alignmentJob(b.id).status, "processing");

  // An unrelated request while both alignments hold a worker.
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    samples.push(performance.now() - started);
    assert.equal(response.statusCode, 200);
  }
  const held2 = await latency(t, "both books waiting on workers", samples);

  // First section of each book: both record progress before either finishes.
  for (const entry of held.splice(0)) entry.resolve(mapped(entry.request));
  await until(() => alignmentJob(a.id).sectionsDone.length === 1 && alignmentJob(b.id).sectionsDone.length === 1, "first sections");
  assert.equal(alignmentJob(a.id).status, "processing");
  assert.equal(alignmentJob(b.id).status, "processing");

  // Keep probing the API while the workers answer and the server stores results.
  const busy: number[] = [];
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const started = performance.now();
      await app.inject({ method: "GET", url: "/api/health" });
      busy.push(performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  // Workers answer every 20 ms, as if each section took that long on the GPU.
  await drive([a.id, b.id], undefined, 20);
  probing = false;
  await probe;
  const running = await latency(t, "while two books store results", busy);
  assert.ok(held2.max < 250 && running.max < 250, `API latency too high: ${held2.max} / ${running.max} ms`);
  assert.equal(maxInFlight, 2);
  assert.equal(alignmentJob(a.id).status, "partial");
  assert.equal(alignmentJob(b.id).status, "partial");
  assert.equal(alignmentJob(a.id).pool?.hostId === alignmentJob(b.id).pool?.hostId, false);
  assert.equal(claim(a.id).claim_owner, null, "a finished job releases its claim");
});

test("a third book is admitted as soon as one of the two running books finishes", async () => {
  reset();
  const a = await create("a"), b = await create("b"), c = await create("c");
  await until(() => held.length === 2, "two admitted books");
  assert.equal(alignmentSchedulerForTests().running().length, ALIGNMENT_ADMITTED_BOOKS);
  assert.equal(alignmentJob(c.id).status, "queued");
  const first = held[0].recordingId === "rec-a" ? a : b;
  // Finish one book without any other processAlignments() call or timer tick.
  await drive([first.id]);
  await until(() => held.some((entry) => entry.recordingId === "rec-c"), "book c admitted");
  await drive([a.id, b.id, c.id]);
  assert.equal(maxInFlight, 2);
  for (const job of [a, b, c]) assert.equal(alignmentJob(job.id).status, "partial");
});

test("two editions of one recording never encode it at the same time", async () => {
  reset();
  const first = await create("a"), second = await create("a", "ebook-a2");
  await until(() => held.length === 1, "one run for the recording");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(held.length, 1, "lisa stays free rather than encoding rec-a twice");
  await drive([first.id, second.id]);
  assert.equal(maxPerRecording, 1);
  assert.equal(alignmentJob(first.id).status, "partial");
  assert.equal(alignmentJob(second.id).status, "partial");
});

test("a job cancelled mid-request never publishes", async () => {
  reset();
  const job = await create("b");
  await until(() => held.length === 1, "worker request");
  const response = await app.inject({ method: "PATCH", url: `/api/alignments/${job.id}`, payload: { action: "cancel" } });
  assert.equal(response.statusCode, 200);
  take().resolve(mapped(requests.at(-1)!.request));
  await alignmentSchedulerForTests().settled();
  const after = alignmentJob(job.id);
  assert.equal(after.status, "cancelled");
  assert.deepEqual(after.intervals, []);
  assert.deepEqual(after.sectionsDone, []);
  assert.equal(existsSync(mapPath(job.id)), false);
  assert.equal(requests.length, 1, "no further section was sent");
});

test("a superseded generation never publishes; the rebuild runs once the old run stops", async () => {
  reset();
  const old = await create("a", "ebook-a", 10);
  await until(() => held.length === 1, "old generation request");
  // An explicit prepare with new pairings rebuilds the same job under a new generation.
  const rebuilt = await create("a", "ebook-a", 30);
  assert.equal(rebuilt.id, old.id);
  assert.notEqual(rebuilt.generation, old.generation);
  void processAlignments();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(held.length, 1, "the rebuild waits for the old run of the same job");
  // The old generation's late answer arrives.
  const late = take();
  assert.equal(late.request.start, 10);
  late.resolve(mapped(late.request));
  await until(() => held.length === 1 && held[0].request.start === 30, "rebuild request");
  await drive([old.id]);
  const job = alignmentJob(old.id);
  assert.equal(job.generation, rebuilt.generation);
  assert.equal(job.status, "partial");
  assert.ok(job.intervals.length > 0);
  assert.ok(job.intervals.every((interval) => interval.start >= 30), "no interval of the old generation");
  const map = JSON.parse(readFileSync(mapPath(old.id), "utf8"));
  assert.equal(map.generation, rebuilt.generation);
  assert.ok(requests.filter((entry) => entry.request.start < 30).length === 1, "the old run sent nothing after it was superseded");
});

test("a run's stale write is refused after a rebuild, a cancel or a takeover", async () => {
  reset();
  const id = (await create("c")).id;
  await drive([id]);
  // The server's own scheduler stays out of the way; these fake runs ignore the pause.
  setPaused("alignment", true);
  const writes: { status: string; error?: unknown }[] = [];
  let release!: () => void;
  let gate = Promise.resolve();
  let planned = "";
  // Offers only the generation each case prepared, so a rebuilt generation is not run by this fake.
  const scheduler = new AlignmentScheduler({
    candidates: () => alignmentJob(id).generation === planned ? [{ id, generation: planned, recordingId: "rec-c", local: false }] : [],
    held: () => false,
    stillActive: () => false,
    run: async () => {
      const snapshot = alignmentJob(id);
      await gate;
      try {
        putAlignmentJob({ ...snapshot, status: "partial", intervals: [], warning: "stale" });
        writes.push({ status: "written" });
      } catch (error) {
        writes.push({ status: "refused", error });
      }
    },
  });
  const cases: [string, () => void][] = [
    ["rebuild", () => putAlignmentJob({ ...alignmentJob(id), generation: "newer" })],
    ["cancel", () => putAlignmentJob({ ...alignmentJob(id), status: "cancelled" })],
    ["takeover", () => sqlite.prepare("UPDATE alignment_jobs SET claim_owner='other-server' WHERE id=?").run(id)],
  ];
  for (const [label, interfere] of cases) {
    planned = `g-${label}`;
    putAlignmentJob({ ...alignmentJob(id), status: "queued", generation: planned, warning: null });
    writes.length = 0;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const pumped = scheduler.pump();
    assert.equal(claim(id).claim_generation, `g-${label}`, label);
    interfere();
    const before = alignmentJob(id);
    release();
    await pumped;
    assert.equal(writes[0]?.status, "refused", label);
    assert.ok(writes[0].error instanceof StaleAlignmentRun, label);
    assert.equal(alignmentJob(id).warning, before.warning, `${label}: nothing published`);
    assert.equal(alignmentJob(id).status, before.status, label);
  }
  // A write that keeps a pause in place is the run's own finished work and is kept.
  putAlignmentJob({ ...alignmentJob(id), status: "processing", generation: "g-pause" });
  sqlite.prepare("UPDATE alignment_jobs SET claim_owner=NULL WHERE id=?").run(id);
  const paused = new AlignmentScheduler({
    candidates: () => [{ id, generation: "g-pause", recordingId: "rec-c", local: false }],
    held: () => false,
    stillActive: () => false,
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      putAlignmentJob({ ...alignmentJob(id), progress: 0.5 });
    },
  });
  const pumped = paused.pump();
  putAlignmentJob({ ...alignmentJob(id), status: "paused" });
  await pumped;
  assert.equal(alignmentJob(id).status, "paused");
  assert.equal(alignmentJob(id).progress, 0.5);
});

test("a restart resumes a running job once, after its old claim goes stale, and the old run never publishes", async () => {
  reset();
  const job = await create("b");
  await until(() => held.length === 1, "first run on a worker");
  const firstOwner = alignmentSchedulerForTests().owner;
  assert.equal(claim(job.id).claim_owner, firstOwner);
  const oldRequest = take();

  // New server process: new claim owner, no leases. The old claim is still being renewed.
  resetAlignmentRunnerForTests({ restart: true });
  resetAlignmentPoolCoordinator(hosts);
  await processAlignments();
  await processAlignments();
  assert.equal(held.length, 0, "a live claim is not taken");
  assert.equal(alignmentSchedulerForTests().running().length, 0);
  assert.equal(claim(job.id).claim_owner, firstOwner);

  // The old process died: its claim stops being renewed.
  sqlite.prepare("UPDATE alignment_jobs SET claimed_at=0 WHERE id=?").run(job.id);
  void processAlignments();
  void processAlignments();
  await until(() => held.length === 1, "resumed run");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(held.length, 1, "the job runs once");
  assert.equal(claim(job.id).claim_owner, alignmentSchedulerForTests().owner);
  await drive([job.id]);
  const resumed = alignmentJob(job.id);
  assert.equal(resumed.status, "partial");
  const sectionRequests = requests.filter((entry) => entry !== oldRequest);
  assert.equal(sectionRequests.length, resumed.pairings.length, "each section once in the resumed run");

  // The dead process's request answers late; nothing it does reaches the job.
  oldRequest.resolve(mapped(oldRequest.request, { intervals: [] }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(alignmentJob(job.id), resumed);
  const rows = sqlite.prepare("SELECT COUNT(*) AS n FROM alignment_jobs WHERE ebook_id='ebook-b' AND recording_id='rec-b'").get() as { n: number };
  assert.equal(rows.n, 1);
});

test("a restart picks up a previous instance's claimed jobs before newer queued work", async () => {
  reset();
  setPaused("alignment", true);
  const interrupted = await create("c"), b = await create("b"), a = await create("a");
  // c was running in a process that crashed; it is the oldest row, so plain recency would start it last.
  sqlite.prepare("UPDATE alignment_jobs SET updated_at=0, data=json_set(data,'$.status','processing'), claim_owner='crashed', claim_generation=?, claimed_at=0 WHERE id=?")
    .run(interrupted.generation, interrupted.id);
  setPaused("alignment", false);
  const pumped = processAlignments();
  assert.equal(alignmentSchedulerForTests().running()[0], interrupted.id, "the interrupted job is admitted first");
  assert.equal(alignmentSchedulerForTests().running().length, 2);
  await drive([interrupted.id, a.id, b.id]);
  await pumped;
});

test("pausing alignment admits nothing new; running books finish", async () => {
  reset();
  const a = await create("a"), b = await create("b"), c = await create("c");
  await until(() => held.length === 2, "two running books");
  setPaused("alignment", true);
  await drive([a.id, b.id]);
  await processAlignments();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(alignmentJob(c.id).status, "queued");
  assert.equal(held.length, 0);
  setPaused("alignment", false);
  void processAlignments();
  await drive([c.id]);
  assert.equal(alignmentJob(c.id).status, "partial");
});

test("out-of-memory halving and the run configuration are stored on the job and sent back", async () => {
  reset();
  const job = await create("a");
  const halvedOnce = { acousticMicrobatch: 4, acousticMicrobatchUsed: 2, oomHalvings: 1, decodeWorkers: 2, extractWorkers: 6, residentModelsPerDevice: 1 };
  await until(() => held.length === 1, "first section");
  const first = take();
  assert.equal(first.request.microbatch, undefined, "a fresh job uses the worker's configured microbatch");
  first.resolve(mapped(first.request, { runConfig: halvedOnce }));
  await until(() => held.length === 1, "second section");
  const second = take();
  assert.equal(second.request.microbatch, 2, "the halved microbatch carries over to the next request");
  second.resolve(mapped(second.request, { runConfig: { ...halvedOnce, acousticMicrobatch: 4, oomHalvings: 0 } }));
  await drive([job.id]);
  const stored = alignmentJob(job.id);
  const expected = { admittedBooks: 2, residentModelsPerDevice: 1, acousticMicrobatch: 4, acousticMicrobatchUsed: 2,
    oomHalvings: 1, decodeWorkers: 2, extractWorkers: 6 };
  assert.deepEqual(stored.runConfig, expected);
  assert.deepEqual(JSON.parse(readFileSync(mapPath(job.id), "utf8")).runConfig, expected);
  const summary = await app.inject({ method: "GET", url: "/api/alignments?ebookId=ebook-a&summary=1" });
  assert.deepEqual(summary.json().jobs.find((row: AlignmentJob) => row.id === job.id).runConfig, expected);
});
