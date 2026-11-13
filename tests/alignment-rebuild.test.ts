// Automatic rebuild of maps from an older engine (#277), through the real scheduler against fake CTC workers.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readerFixture } from "./reader-fixture.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-rebuild-"));
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
  createAlignment, alignmentJob, putAlignmentJob, deleteAlignmentJob, processAlignments, stopAlignments,
  resetAlignmentRunnerForTests, alignmentSchedulerForTests, audioFingerprint, queueEngineRebuilds,
  alignmentRebuildScanForTests, autoQueueAlignmentForPair, listServedAlignmentJobs,
} = await import("../server/alignment.ts");
const { setEngineGenerationsForTests } = await import("../server/alignment-rebuild.ts");
const { consensusEbookId, publishProjectedMaps, syncEbookSetConsensus } = await import("../server/ebook-set-consensus.ts");
const { resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests } = await import("../server/alignment-pool.ts");
type AlignmentJob = ReturnType<typeof alignmentJob>;

const engine = "ctc-wav2vec2-base-960h-torchaudio-2.8-v1";
const aeneas = "aeneas-1.7.3";
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

type Held = { url: string; recordingId: string; request: Record<string, any>; resolve: (response: Response) => void };
const held: Held[] = [];
/** Recording of every worker request in the order the server sent them. */
const requests: Held[] = [];
/** When set, worker requests are answered at once instead of held. */
let autoAnswer: ((entry: Held) => Response) | null = null;
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
  const entry = { url, recordingId: String(request.recordingId), request } as Held;
  requests.push(entry);
  if (autoAnswer) return autoAnswer(entry);
  return new Promise<Response>((resolve) => {
    entry.resolve = resolve;
    held.push(entry);
  });
};

/** Chapter windows: every fragment mapped, or only the first one of each section (`first`). */
const mapped = (request: Record<string, any>, { first = false } = {}) =>
  Response.json({ engine, outcome: "mapped", elapsedSeconds: 1, stageTimings: { acousticEncoding: 0.1 },
    intervals: (first ? request.fragments.slice(0, 1) : request.fragments)
      .map((_: string, i: number) => ({ index: i, start: request.start + i * 0.5, end: request.start + i * 0.5 + 0.4 })) });
// Anchored jobs: five seconds per sentence after 30 s of credits.
const spoken = (index: number) => 30 + index * 5;
function anchoredWorker(entry: Held) {
  const { request } = entry;
  if (entry.url.endsWith("/anchor")) {
    const index = Math.max(0, Math.ceil((request.start - 30) / 5));
    if (index >= request.fragments.length || spoken(index) > request.start + request.duration - 3)
      return Response.json({ engine, outcome: "unsynced", stageTimings: { acousticEncoding: 0.25 }, match: null, start: request.start, text: "" });
    return Response.json({ engine, outcome: "mapped", stageTimings: { acousticEncoding: 0.25 },
      match: { index, score: 0.9, text: "" }, start: spoken(index), text: "word ".repeat(40) });
  }
  const step = request.duration / request.fragments.length;
  return Response.json({ engine, outcome: "mapped", stageTimings: { ctcPath: 0.5 }, elapsedSeconds: 1,
    intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
}

async function until(condition: () => boolean, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const take = (filter: (entry: Held) => boolean) => {
  const index = held.findIndex(filter);
  assert.ok(index >= 0, "expected a held worker request");
  return held.splice(index, 1)[0];
};
const active = (id: string) => ["queued", "copying", "processing"].includes(alignmentJob(id).status);
/** Answers held requests (only those passing `filter`) until the jobs leave the active states. */
async function drive(ids: string[], answer = (entry: Held) => mapped(entry.request), filter = (_: Held) => true) {
  const deadline = Date.now() + 8000;
  while (ids.some(active)) {
    if (Date.now() > deadline) throw new Error(`Jobs did not finish: ${ids.map((id) => alignmentJob(id).status)}`);
    const index = held.findIndex(filter);
    if (index >= 0) {
      const [entry] = held.splice(index, 1);
      entry.resolve(answer(entry));
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await until(() => ids.every((id) => !alignmentSchedulerForTests().running().includes(id)), "runs to end");
}

// Four works, one recording and one EPUB each, plus second EPUBs of A and B.
const books = ["a", "b", "c", "d"] as const;
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
for (const name of ["a", "b"]) {
  const file = join(process.env.MEDIA_ROOT, `${name}2.epub`);
  writeFileSync(file, await readerFixture({ bodies: ["<p>Other one. Other two.</p>", "<p>Other three. Other four.</p>"] }));
  db.insert(schema.ebookEditions).values({ id: `ebook-${name}2`, workId: `work-${name}`, format: "epub", source: file }).run();
}

async function pairings(ebookId: string, trackId: string, offset = 10) {
  const book = await extractBook(ebookId);
  return book.sections.map((section, i) => ({ section: section.index, trackId, start: offset + i * 100, duration: 80 }));
}
const create = async (name: string) =>
  createAlignment(`ebook-${name}`, `rec-${name}`, await pairings(`ebook-${name}`, `track-${name}`), "chapters");

let seeded = 0;
/** A finished chapter map of `name` made by `madeBy`, with valid fingerprints so /map serves it. */
async function oldMap(name: string, madeBy: string, status: AlignmentJob["status"], ebookId = `ebook-${name}`) {
  const book = await extractBook(ebookId);
  const usable = status === "ready" || status === "partial";
  const paragraphs = book.sections.flatMap((section) => section.paragraphs.map((p) => ({ section: section.index, id: p.id })));
  const job: AlignmentJob = {
    id: `old-${ebookId}`,
    generation: `old-generation-${++seeded}`,
    ebookId,
    recordingId: `rec-${name}`,
    status,
    progress: usable ? 1 : 0.5,
    engine: madeBy,
    error: status === "error" ? "The old worker failed." : null,
    warning: null,
    intervals: usable
      ? paragraphs.map((p, i) => ({ paragraphId: p.id, section: p.section, trackId: `track-${name}`, start: 10 + i, end: 10.8 + i, confidence: 0.65 }))
      : [],
    sectionsDone: usable ? book.sections.map((section) => section.index) : [],
    elapsedSeconds: 5,
    fingerprint: book.fingerprint,
    audioFingerprint: audioFingerprint(`rec-${name}`),
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    coverage: usable ? 1 : 0,
    pairings: await pairings(ebookId, `track-${name}`),
    mode: "chapters",
  };
  putAlignmentJob(job);
  return alignmentJob(job.id);
}
const keptMap = (id: string) =>
  (sqlite.prepare("SELECT published_map FROM alignment_jobs WHERE id=?").get(id) as { published_map: string | null }).published_map;

const app = await createApp();
after(async () => {
  globalThis.fetch = originalFetch;
  for (const entry of held.splice(0)) entry.resolve(new Response("stopped", { status: 503 }));
  stopAlignments();
  await app.close();
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  setEngineGenerationsForTests(null);
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

async function reset() {
  // Runs left by an earlier (possibly failed) test end on refused requests, also on a retry host.
  autoAnswer = () => new Response("stopped", { status: 503 });
  for (const entry of held.splice(0)) entry.resolve(new Response("stopped", { status: 503 }));
  await Promise.race([alignmentSchedulerForTests().settled(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  autoAnswer = null;
  requests.length = 0;
  resetAlignmentRunnerForTests();
  resetAlignmentPoolCoordinator(hosts);
  setEngineGenerationsForTests(null);
  sqlite.prepare("DELETE FROM alignment_jobs").run();
  rmSync(join(process.env.MEDIA_ROOT!, "alignment"), { recursive: true, force: true });
  // Held: nothing runs until a test lets it.
  setPaused("alignment", true);
}

test("maps of an older engine are queued for rebuild once, also after a restart, and pause holds them", async () => {
  await reset();
  const ready = await oldMap("a", aeneas, "ready");
  const partial = await oldMap("b", aeneas, "partial");
  const failed = await oldMap("c", aeneas, "error");
  const cancelled = await oldMap("d", aeneas, "cancelled");
  const current = await oldMap("a", engine, "partial", "ebook-a2");
  // An identity this server does not know may be a newer engine (after a rollback): never rebuilt.
  const unknown = await oldMap("b", "ctc-from-a-newer-build-v9", "partial", "ebook-b2");

  const first = await queueEngineRebuilds();
  assert.deepEqual(first, { queued: 4, replanned: 0, projections: 0, skipped: 0, failed: 0 });
  for (const old of [ready, partial, failed, cancelled]) {
    const job = alignmentJob(old.id);
    assert.equal(job.status, "queued");
    assert.equal(job.engine, engine);
    assert.notEqual(job.generation, old.generation);
    assert.deepEqual({ engine: job.rebuildOf?.engine, status: job.rebuildOf?.status }, { engine: aeneas, status: old.status });
    assert.deepEqual(job.pairings, old.pairings, "a rebuild keeps the map's chapter plan");
    assert.equal(job.intervals.length, 0);
  }
  // Only a usable old map is kept for serving.
  assert.ok(keptMap(ready.id) && keptMap(partial.id));
  assert.equal(keptMap(failed.id), null);
  assert.equal(keptMap(cancelled.id), null);
  assert.deepEqual(alignmentJob(current.id), current);
  assert.deepEqual(alignmentJob(unknown.id), unknown);
  // The Activity page tells a rebuild from new work.
  const activity = await app.inject("/api/activity");
  assert.equal(activity.statusCode, 200, activity.body);
  const items = JSON.stringify(activity.json());
  assert.match(items, new RegExp(`"id":"alignment:${ready.id}"[^}]*"detail":"Alignment map rebuild"`));

  const generations = () => [ready, partial, failed, cancelled].map((old) => alignmentJob(old.id).generation);
  const queued = generations();
  // A restarted server (a new claim owner) scans again and queues nothing twice.
  resetAlignmentRunnerForTests({ restart: true });
  assert.deepEqual(await queueEngineRebuilds(), { queued: 0, replanned: 0, projections: 0, skipped: 0, failed: 0 });
  assert.deepEqual(generations(), queued);
  // So does the scan a newly started app runs on its own.
  const restarted = await createApp();
  assert.deepEqual(await alignmentRebuildScanForTests(), { queued: 0, replanned: 0, projections: 0, skipped: 0, failed: 0 });
  await restarted.close();
  assert.deepEqual(generations(), queued);

  // The Activity pause switch holds rebuilds like any other admission.
  void processAlignments();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests.length, 0);
  assert.equal(alignmentSchedulerForTests().running().length, 0);
  assert.equal(alignmentJob(ready.id).status, "queued");
});

test("new work goes ahead of rebuilds, rebuilds run oldest engine first, and a running rebuild finishes", async () => {
  await reset();
  setEngineGenerationsForTests(["legacy-engine", aeneas, engine]);
  const newer = await oldMap("b", aeneas, "partial");
  const oldest = await oldMap("c", "legacy-engine", "partial");
  assert.equal((await queueEngineRebuilds()).queued, 2);
  const fresh = await create("a");

  setPaused("alignment", false);
  void processAlignments();
  // Two admitted books: the new recording and the oldest-engine rebuild. The newer rebuild waits.
  await until(() => held.length === 2, "two books on workers");
  assert.deepEqual(new Set(held.map((entry) => entry.recordingId)), new Set(["rec-a", "rec-c"]));
  assert.equal(alignmentJob(newer.id).status, "queued");

  // The running rebuild records progress; a rescan and newly added work leave it running.
  const section = take((entry) => entry.recordingId === "rec-c");
  section.resolve(mapped(section.request));
  await until(() => alignmentJob(oldest.id).sectionsDone.length === 1, "first rebuilt section");
  const running = alignmentJob(oldest.id);
  assert.equal((await queueEngineRebuilds()).queued, 0);
  const later = await create("d");
  assert.equal(alignmentJob(oldest.id).generation, running.generation);
  assert.equal(alignmentJob(oldest.id).status, "processing");

  // When the new recording finishes, the slot goes to the newer new work, not to the waiting rebuild.
  await drive([fresh.id], undefined, (entry) => entry.recordingId === "rec-a");
  await until(() => held.some((entry) => entry.recordingId === "rec-d"), "later new work admitted");
  assert.equal(alignmentJob(newer.id).status, "queued");
  await drive([oldest.id, later.id, newer.id]);

  const firstRequest = (recordingId: string) => requests.findIndex((entry) => entry.recordingId === recordingId);
  assert.ok(firstRequest("rec-c") < firstRequest("rec-d"));
  assert.ok(firstRequest("rec-d") < firstRequest("rec-b"));
  const rebuilt = alignmentJob(oldest.id);
  assert.equal(rebuilt.generation, running.generation, "the running rebuild finished without restarting");
  assert.equal(rebuilt.status, "partial");
  assert.equal(rebuilt.engine, engine);
  assert.equal(alignmentJob(newer.id).status, "partial");
  // Every rebuilt section was asked for once: nothing restarted.
  assert.equal(requests.filter((entry) => entry.recordingId === "rec-c").length, rebuilt.pairings.length);
});

test("the old map stays served until its rebuild publishes, and the new map replaces it even with lower coverage", async () => {
  await reset();
  const old = await oldMap("a", aeneas, "ready");
  await queueEngineRebuilds();
  const listed = async () =>
    (await app.inject(`/api/alignments?ebookId=ebook-a&summary=1`)).json().jobs.find((job: AlignmentJob) => job.id === old.id);
  const map = async () => {
    const response = await app.inject(`/api/alignments/${old.id}/map`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as AlignmentJob;
  };
  let shown = await listed();
  assert.deepEqual(
    { status: shown.status, engine: shown.engine, intervalCount: shown.intervalCount, rebuild: shown.rebuild.status, target: shown.rebuild.engine },
    { status: "ready", engine: aeneas, intervalCount: old.intervals.length, rebuild: "queued", target: engine },
  );
  assert.equal((await map()).engine, aeneas);

  setPaused("alignment", false);
  void processAlignments();
  await until(() => held.length === 1, "rebuild on a worker");
  const section = take(() => true);
  section.resolve(mapped(section.request, { first: true }));
  await until(() => alignmentJob(old.id).sectionsDone.length === 1, "first rebuilt section");
  // Halfway through, the old map is still the one served.
  const halfway = await map();
  assert.equal(halfway.engine, aeneas);
  assert.equal(halfway.intervals.length, old.intervals.length);
  assert.equal((await listed()).rebuild.status, "processing");

  await drive([old.id], (entry) => mapped(entry.request, { first: true }));
  const replaced = await map();
  assert.equal(replaced.engine, engine);
  assert.equal(replaced.status, "partial");
  assert.equal(replaced.intervals.length, 2, "one sentence per section");
  assert.ok(replaced.coverage < old.coverage, "lower coverage still replaces the old map");
  assert.equal(replaced.rebuild, undefined);
  assert.equal(keptMap(old.id), null);
  shown = await listed();
  assert.equal(shown.engine, engine);
  assert.equal(shown.rebuild, undefined);
  const file = JSON.parse(readFileSync(join(process.env.MEDIA_ROOT!, "alignment", old.id, "map.json"), "utf8"));
  assert.equal(file.engine, engine);

  // A rebuild that fails publishes nothing: the old map stays served.
  const kept = await oldMap("b", aeneas, "partial");
  await queueEngineRebuilds();
  void processAlignments();
  await drive([kept.id], () => Response.json({ engine, outcome: "error", elapsedSeconds: 1, stageTimings: {}, intervals: [] }));
  assert.equal(alignmentJob(kept.id).status, "error");
  const stillServed = await app.inject(`/api/alignments/${kept.id}/map`);
  assert.equal(stillServed.statusCode, 200, stillServed.body);
  assert.equal(stillServed.json().engine, aeneas);
  assert.equal(stillServed.json().rebuild.status, "error");

  // "Language not supported" is an explicit outcome: it replaces the old map, which then no longer serves.
  const unsupported = await oldMap("c", aeneas, "partial");
  await queueEngineRebuilds();
  void processAlignments();
  await drive([unsupported.id], () => Response.json({ engine, outcome: "language_not_supported", elapsedSeconds: 1, stageTimings: {}, intervals: [] }));
  assert.equal(alignmentJob(unsupported.id).outcome, "language_not_supported");
  assert.equal(keptMap(unsupported.id), null);
  const gone = await app.inject(`/api/alignments/${unsupported.id}/map`);
  assert.equal(gone.statusCode, 410, gone.body);
  assert.equal(gone.json().code, "alignment_language_not_supported");
});

test("listening and reading positions are untouched by a rebuild", async () => {
  await reset();
  const positionTables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((row) => row.name)
    .filter((name) => /progress|checkpoint|bookmark/.test(name));
  assert.ok(positionTables.includes("progress") && positionTables.includes("ebook_progress"));
  const users = sqlite.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  const now = Date.now() - 1000;
  sqlite.prepare("INSERT INTO progress(recording_id,track_id,position,duration,updated_at) VALUES(?,?,?,?,?)").run("rec-c", "track-c", 123.5, 400, now);
  sqlite.prepare("INSERT INTO ebook_progress(edition_id,cfi,chapter,updated_at) VALUES(?,?,?,?)").run("ebook-c", "epubcfi(/6/4!/4/2)", 1, now);
  sqlite.prepare("INSERT INTO reader_checkpoints(edition_id,data) VALUES(?,?)").run("ebook-c", JSON.stringify({ cfi: "epubcfi(/6/4!/4/2)" }));
  if (users) {
    sqlite.prepare("INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(?,?,?,?,?,?)")
      .run(users.id, "rec-c", "track-c", 123.5, 400, now);
    sqlite.prepare("INSERT INTO user_ebook_progress(user_id,edition_id,cfi,chapter,updated_at) VALUES(?,?,?,?,?)")
      .run(users.id, "ebook-c", "epubcfi(/6/4!/4/2)", 1, now);
  }
  const snapshot = () => Object.fromEntries(positionTables.map((name) => [name, sqlite.prepare(`SELECT * FROM ${name}`).all()]));
  const before = snapshot();
  assert.ok(Object.values(before).some((rows) => rows.length > 0));

  const old = await oldMap("c", aeneas, "partial");
  await queueEngineRebuilds();
  setPaused("alignment", false);
  void processAlignments();
  await drive([old.id]);
  assert.equal(alignmentJob(old.id).engine, engine);
  assert.equal(alignmentJob(old.id).status, "partial");
  assert.deepEqual(snapshot(), before);
});

test("an in-flight job of an older engine is planned again under the current engine in place", async () => {
  await reset();
  const queued = await oldMap("a", aeneas, "partial");
  putAlignmentJob({ ...queued, status: "queued", progress: 0.5 });
  const paused = await oldMap("b", aeneas, "partial");
  putAlignmentJob({ ...paused, status: "paused" });
  assert.deepEqual(await queueEngineRebuilds(), { queued: 0, replanned: 2, projections: 0, skipped: 0, failed: 0 });
  const replanned = alignmentJob(queued.id);
  assert.equal(replanned.engine, engine);
  assert.equal(replanned.status, "queued");
  assert.equal(replanned.rebuildOf, undefined, "it was new work and keeps that priority");
  assert.deepEqual(replanned.sectionsDone, []);
  assert.equal(alignmentJob(paused.id).status, "paused", "a pause is kept");
  assert.equal(alignmentJob(paused.id).engine, engine);
});

test("an ebook-set consensus is rebuilt once and regenerates its projections; an explicit map keeps precedence", async () => {
  await reset();
  const workId = "work-set";
  db.insert(schema.works).values({ id: workId, title: "Set", author: "Author", description: "", genre: "", year: 2026 }).run();
  db.insert(schema.editions).values({ id: "edition-set", workId, cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "rec-set", editionId: "edition-set" }).run();
  const audio = join(process.env.MEDIA_ROOT!, "set.wav");
  writeFileSync(audio, "audio set");
  const members = ["set-1", "set-2", "set-3"];
  for (const ebookId of members) {
    const file = join(process.env.MEDIA_ROOT!, `${ebookId}.epub`);
    writeFileSync(file, await readerFixture());
    db.insert(schema.ebookEditions).values({ id: ebookId, workId, format: "epub", source: file }).run();
    db.insert(schema.workEbookSetMembers).values({
      workId, ebookId, status: "accepted", holdReason: null, sourceTitle: ebookId, sourceAuthor: null, language: "en", byteSize: 1,
      evidence: JSON.stringify({ sharedSentenceCount: 10, uniqueSentenceCount: 0, audioSupportedCoverage: 0.9,
        outlier: { passed: true, reason: "ok", spokenSampleCount: 4, matchedSampleCount: 4, anchorCount: 4, forwardOrder: true, samples: [] },
        language: "en", byteSize: 1 }),
      updatedAt: Date.now(),
    }).run();
  }
  const paragraphs = (await extractBook("set-1")).sections.flatMap((section) => section.paragraphs).length;
  db.insert(schema.tracks).values({ id: "track-set", recordingId: "rec-set", title: "Set.m4b", index: 0,
    duration: spoken(paragraphs) + 20, chapters: [], source: audio, sourceType: "local" }).run();

  // The consensus job the set queued, finished by the old engine, and its projections.
  const presentation = await syncEbookSetConsensus(workId);
  const consensusId = presentation.consensus!.jobId!;
  const consensusBook = await extractBook(consensusEbookId(workId));
  const sentences = consensusBook.sections[0].paragraphs;
  const queuedConsensus = alignmentJob(consensusId);
  const oldConsensus: AlignmentJob = {
    ...queuedConsensus, status: "partial", engine: aeneas, progress: 1, generation: "old-consensus",
    intervals: sentences.slice(0, 4).map((p, i) => ({ paragraphId: p.id, section: 0, trackId: "track-set", start: 30 + i * 5, end: 34 + i * 5, confidence: 0.65 })),
    coverage: 4 / sentences.length, anchoring: { ...queuedConsensus.anchoring!, stage: "done" },
  };
  delete oldConsensus.ctcValidationVersion;
  putAlignmentJob(oldConsensus);
  await publishProjectedMaps(workId, alignmentJob(consensusId));
  const projected = () => allJobs().filter((job) => job.origin === "projected");
  assert.equal(projected().length, 3);
  assert.ok(projected().every((job) => job.engine === aeneas && job.intervals.length === 4));
  // Set 3 has its own prepared map (old engine too), which wins over the projection.
  const projected3 = projected().find((job) => job.ebookId === "set-3")!;
  deleteAlignmentJob(projected3.id);
  const explicitBook = await extractBook("set-3");
  putAlignmentJob({
    ...oldConsensus, id: "explicit-set-3", ebookId: "set-3", generation: "old-explicit", origin: undefined,
    fingerprint: explicitBook.fingerprint, coverage: 0.5,
    intervals: explicitBook.sections.flatMap((section) => section.paragraphs.map((p) => ({ section: section.index, id: p.id })))
      .slice(0, 2).map((p, i) => ({ paragraphId: p.id, section: p.section, trackId: "track-set", start: 30 + i * 5, end: 34 + i * 5, confidence: 0.65 })),
  });

  const scan = await queueEngineRebuilds();
  // The consensus and the explicit map; projections are never rebuilt on their own.
  assert.deepEqual(scan, { queued: 2, replanned: 0, projections: 0, skipped: 0, failed: 0 });
  assert.equal(allJobs().filter((job) => job.ebookId === consensusEbookId(workId)).length, 1);
  assert.equal(alignmentJob(consensusId).rebuildOf?.engine, aeneas);
  assert.equal(alignmentJob(consensusId).mode, "anchored");
  assert.ok(projected().every((job) => job.engine === aeneas), "projections stay until the consensus publishes");

  autoAnswer = anchoredWorker;
  setPaused("alignment", false);
  void processAlignments();
  await until(() => !active(consensusId) && !active("explicit-set-3"), "consensus and explicit rebuilds", 10_000);
  await until(() => projected().every((job) => job.engine === engine), "projections regenerated");
  const consensus = alignmentJob(consensusId);
  assert.equal(consensus.status, "partial", consensus.error ?? undefined);
  assert.equal(consensus.engine, engine);
  const regenerated = projected();
  assert.deepEqual(regenerated.map((job) => job.ebookId).sort(), ["set-1", "set-2"]);
  for (const job of regenerated) {
    assert.equal(job.generation, consensus.generation);
    assert.equal(job.intervals.length, consensus.intervals.length);
    assert.ok(job.intervals.length > 4);
  }
  const explicit = alignmentJob("explicit-set-3");
  assert.notEqual(explicit.origin, "projected");
  assert.equal(explicit.engine, engine, "the explicit map is rebuilt as itself");
  assert.equal(allJobs().filter((job) => job.ebookId === "set-3").length, 1);
  // The consensus audio pass ran for one job only.
  const consensusRequests = requests.filter((entry) => entry.url.endsWith("/anchor") && entry.request.fragments.length === sentences.length);
  assert.ok(consensusRequests.length > 0);
  assert.deepEqual(await queueEngineRebuilds(), { queued: 0, replanned: 0, projections: 0, skipped: 0, failed: 0 });
});

test("projections left on an older engine are regenerated from a consensus that already published", async () => {
  // The server stopped after the rebuilt consensus published but before it projected.
  const projectedRows = allJobs().filter((job) => job.origin === "projected");
  assert.ok(projectedRows.length > 0, "runs after the consensus test");
  for (const job of projectedRows) putAlignmentJob({ ...job, engine: aeneas, generation: "stale-projection" });
  setPaused("alignment", true);
  const scan = await queueEngineRebuilds();
  assert.equal(scan.queued, 0);
  assert.equal(scan.projections, 1);
  assert.ok(allJobs().filter((job) => job.origin === "projected").every((job) => job.engine === engine));
});

test("a new edition or manual prepare supersedes a queued rebuild with a fresh generation", async () => {
  await reset();
  const old = await oldMap("a", aeneas, "ready");
  assert.equal((await queueEngineRebuilds()).queued, 1);
  const queued = alignmentJob(old.id);
  assert.ok(queued.rebuildOf);
  assert.ok(keptMap(old.id));

  // Manual anchored prepare (Reading Sync "Rebuild without chapter matching"): fresh work, no rebuildOf.
  const manual = await createAlignment("ebook-a", "rec-a", undefined, "anchored");
  assert.equal(manual.id, old.id);
  assert.notEqual(manual.generation, queued.generation);
  assert.equal(manual.rebuildOf, undefined);
  assert.equal(manual.mode, "anchored");
  assert.equal(manual.status, "queued");
  assert.equal(keptMap(old.id), null, "a manual prepare replaces the served map at once");

  // Re-queue a rebuild, then a backfill with a new fingerprint (new ebook-set consensus edition).
  putAlignmentJob({ ...alignmentJob(old.id), status: "partial", engine: aeneas, progress: 1, coverage: 1,
    intervals: old.intervals, pairings: old.pairings, mode: "chapters", rebuildOf: undefined });
  assert.equal((await queueEngineRebuilds()).queued, 1);
  const rebuilding = alignmentJob(old.id);
  assert.ok(rebuilding.rebuildOf);
  assert.ok(keptMap(old.id));
  putAlignmentJob({ ...rebuilding, fingerprint: "stale-before-new-edition" });
  const backfill = await createAlignment("ebook-a", "rec-a", undefined, "anchored", "backfill");
  assert.equal(backfill.id, old.id);
  assert.notEqual(backfill.generation, rebuilding.generation);
  assert.equal(backfill.rebuildOf, undefined, "superseding a rebuild clears rebuild priority");
  assert.equal(backfill.fingerprint, (await extractBook("ebook-a")).fingerprint);
  assert.notEqual(backfill.fingerprint, "stale-before-new-edition");
  assert.ok(keptMap(old.id), "a backfill that supersedes a rebuild keeps published_map until it publishes");
});

test("successive fingerprint changes keep published_map until a later failure", async () => {
  await reset();
  const old = await oldMap("a", aeneas, "ready");
  assert.equal((await queueEngineRebuilds()).queued, 1);
  assert.ok(keptMap(old.id));
  const firstEngine = alignmentJob(old.id).engine;

  // First automatic supersession (stale fingerprint → current book): clears rebuildOf.
  putAlignmentJob({ ...alignmentJob(old.id), fingerprint: "stale-first" });
  const first = await createAlignment("ebook-a", "rec-a", undefined, "anchored", "backfill");
  assert.equal(first.rebuildOf, undefined);
  assert.ok(keptMap(old.id), "first backfill supersession retains the published map");
  assert.equal(listServedAlignmentJobs().find((job) => job.id === old.id)?.engine, aeneas);
  assert.equal(listServedAlignmentJobs().find((job) => job.id === old.id)?.status, "ready");

  // Second fingerprint change before the replacement publishes: must not dropKeptMap.
  putAlignmentJob({ ...alignmentJob(old.id), fingerprint: "stale-second" });
  const second = await createAlignment("ebook-a", "rec-a", undefined, "anchored", "backfill");
  assert.notEqual(second.generation, first.generation);
  assert.equal(second.rebuildOf, undefined);
  assert.ok(keptMap(old.id), "a second fingerprint supersession must keep published_map");
  const servedWhileQueued = listServedAlignmentJobs().find((job) => job.id === old.id)!;
  assert.equal(servedWhileQueued.status, "ready");
  assert.equal(servedWhileQueued.engine, aeneas);
  assert.equal(servedWhileQueued.rebuild?.status, "queued");

  putAlignmentJob({
    ...alignmentJob(old.id),
    status: "error",
    coverage: 0,
    intervals: [],
    error: "replacement failed",
    engine: firstEngine,
  });
  assert.ok(keptMap(old.id), "failure after successive supersessions still keeps the map");
  const servedAfterFail = listServedAlignmentJobs().find((job) => job.id === old.id)!;
  assert.equal(servedAfterFail.status, "ready");
  assert.equal(servedAfterFail.engine, aeneas);
  assert.equal(servedAfterFail.rebuild?.status, "error");
  const map = await app.inject(`/api/alignments/${old.id}/map`);
  assert.equal(map.statusCode, 200, map.body);
  assert.equal(map.json().status, "ready");
  assert.equal(map.json().engine, aeneas);
});

test("publishProjectedMaps and backfill leave a failed rebuild's published_map in place", async () => {
  await reset();
  const workId = "work-keep-map";
  db.insert(schema.works).values({ id: workId, title: "Keep", author: "Author", description: "", genre: "", year: 2026 }).run();
  db.insert(schema.editions).values({ id: "edition-keep", workId, cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "rec-keep", editionId: "edition-keep" }).run();
  const audio = join(process.env.MEDIA_ROOT!, "keep.wav");
  writeFileSync(audio, "audio keep");
  for (const ebookId of ["keep-1", "keep-2"]) {
    const file = join(process.env.MEDIA_ROOT!, `${ebookId}.epub`);
    writeFileSync(file, await readerFixture());
    db.insert(schema.ebookEditions).values({ id: ebookId, workId, format: "epub", source: file }).run();
    db.insert(schema.workEbookSetMembers).values({
      workId, ebookId, status: "accepted", holdReason: null, sourceTitle: ebookId, sourceAuthor: null, language: "en", byteSize: 1,
      evidence: JSON.stringify({ sharedSentenceCount: 10, uniqueSentenceCount: 0, audioSupportedCoverage: 0.9,
        outlier: { passed: true, reason: "ok", spokenSampleCount: 4, matchedSampleCount: 4, anchorCount: 4, forwardOrder: true, samples: [] },
        language: "en", byteSize: 1 }),
      updatedAt: Date.now(),
    }).run();
  }
  const paragraphs = (await extractBook("keep-1")).sections.flatMap((section) => section.paragraphs).length;
  db.insert(schema.tracks).values({ id: "track-keep", recordingId: "rec-keep", title: "Keep.m4b", index: 0,
    duration: spoken(paragraphs) + 20, chapters: [], source: audio, sourceType: "local" }).run();

  const presentation = await syncEbookSetConsensus(workId);
  const consensusId = presentation.consensus!.jobId!;
  const consensusBook = await extractBook(consensusEbookId(workId));
  const sentences = consensusBook.sections[0].paragraphs;
  const queuedConsensus = alignmentJob(consensusId);
  putAlignmentJob({
    ...queuedConsensus, status: "partial", engine: engine, progress: 1, generation: "keep-consensus",
    intervals: sentences.slice(0, 4).map((p, i) => ({ paragraphId: p.id, section: 0, trackId: "track-keep", start: 30 + i * 5, end: 34 + i * 5, confidence: 0.65 })),
    coverage: 4 / sentences.length, anchoring: { ...queuedConsensus.anchoring!, stage: "done" },
  });
  await publishProjectedMaps(workId, alignmentJob(consensusId));
  const projectedKeep2 = allJobs().find((job) => job.origin === "projected" && job.ebookId === "keep-2")!;
  deleteAlignmentJob(projectedKeep2.id);
  const explicitBook = await extractBook("keep-2");
  const explicitIntervals = explicitBook.sections.flatMap((section) => section.paragraphs.map((p) => ({ section: section.index, id: p.id })))
    .slice(0, 2).map((p, i) => ({ paragraphId: p.id, section: p.section, trackId: "track-keep", start: 30 + i * 5, end: 34 + i * 5, confidence: 0.65 }));
  putAlignmentJob({
    id: "explicit-keep-2", ebookId: "keep-2", recordingId: "rec-keep", status: "partial", engine: aeneas,
    progress: 1, generation: "old-explicit-keep", origin: undefined, fingerprint: explicitBook.fingerprint,
    audioFingerprint: audioFingerprint("rec-keep"), createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000,
    coverage: 0.5, pairings: [], mode: "anchored", intervals: explicitIntervals, sectionsDone: [0],
    elapsedSeconds: 5, error: null, warning: null,
  });
  assert.equal((await queueEngineRebuilds()).queued, 1);
  assert.ok(keptMap("explicit-keep-2"));
  putAlignmentJob({ ...alignmentJob("explicit-keep-2"), status: "error", coverage: 0, intervals: [], error: "rebuild failed", rebuildOf: { engine: aeneas, status: "partial", requestedAt: Date.now() } });
  assert.ok(keptMap("explicit-keep-2"), "store preserves published_map on a failed rebuild");
  assert.equal(listServedAlignmentJobs().find((job) => job.id === "explicit-keep-2")?.status, "partial");

  await publishProjectedMaps(workId, alignmentJob(consensusId));
  assert.ok(alignmentJob("explicit-keep-2"), "publishProjectedMaps must not delete a kept explicit map");
  assert.ok(keptMap("explicit-keep-2"));
  assert.equal(allJobs().filter((job) => job.ebookId === "keep-2").length, 1);
  assert.equal(allJobs().find((job) => job.ebookId === "keep-2")?.origin, undefined);

  assert.equal(await autoQueueAlignmentForPair("keep-2", "rec-keep"), false);
  assert.ok(keptMap("explicit-keep-2"), "backfillDecision must treat a kept published_map as ready");
});

test("cancelling a rebuild still serves the kept map; empty projections delete the old projected row", async () => {
  await reset();
  const old = await oldMap("a", aeneas, "ready");
  await queueEngineRebuilds();
  assert.ok(keptMap(old.id));
  const cancel = await app.inject({ method: "PATCH", url: `/api/alignments/${old.id}`, payload: { action: "cancel" } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(alignmentJob(old.id).status, "cancelled");
  assert.ok(keptMap(old.id));
  const map = await app.inject(`/api/alignments/${old.id}/map`);
  assert.equal(map.statusCode, 200, map.body);
  assert.equal(map.json().engine, aeneas);
  assert.equal(map.json().status, "ready");
  assert.equal(map.json().rebuild.status, "cancelled");

  const workId = "work-empty-proj";
  db.insert(schema.works).values({ id: workId, title: "Empty", author: "Author", description: "", genre: "", year: 2026 }).run();
  db.insert(schema.editions).values({ id: "edition-empty", workId, cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "rec-empty", editionId: "edition-empty" }).run();
  const audio = join(process.env.MEDIA_ROOT!, "empty.wav");
  writeFileSync(audio, "audio empty");
  // Member 1 matches the consensus; member 2 has unrelated text so projection yields no intervals.
  writeFileSync(join(process.env.MEDIA_ROOT!, "empty-1.epub"), await readerFixture({ bodies: ["<p>Alpha one. Alpha two. Alpha three.</p>", "<p>Alpha four. Alpha five.</p>"] }));
  writeFileSync(join(process.env.MEDIA_ROOT!, "empty-2.epub"), await readerFixture({ bodies: ["<p>Zeta unrelated. Completely different wording here.</p>", "<p>More zeta text that shares nothing.</p>"] }));
  for (const ebookId of ["empty-1", "empty-2"]) {
    db.insert(schema.ebookEditions).values({ id: ebookId, workId, format: "epub", source: join(process.env.MEDIA_ROOT!, `${ebookId}.epub`) }).run();
    db.insert(schema.workEbookSetMembers).values({
      workId, ebookId, status: "accepted", holdReason: null, sourceTitle: ebookId, sourceAuthor: null, language: "en", byteSize: 1,
      evidence: JSON.stringify({ sharedSentenceCount: ebookId === "empty-1" ? 10 : 0, uniqueSentenceCount: ebookId === "empty-1" ? 0 : 10,
        audioSupportedCoverage: 0.9,
        outlier: { passed: true, reason: "ok", spokenSampleCount: 4, matchedSampleCount: 4, anchorCount: 4, forwardOrder: true, samples: [] },
        language: "en", byteSize: 1 }),
      updatedAt: Date.now(),
    }).run();
  }
  const emptyParagraphs = (await extractBook("empty-1")).sections.flatMap((section) => section.paragraphs).length;
  db.insert(schema.tracks).values({ id: "track-empty", recordingId: "rec-empty", title: "Empty.m4b", index: 0,
    duration: spoken(emptyParagraphs) + 20, chapters: [], source: audio, sourceType: "local" }).run();

  const presentation = await syncEbookSetConsensus(workId);
  const consensusId = presentation.consensus!.jobId!;
  const consensusBook = await extractBook(consensusEbookId(workId));
  const sentences = consensusBook.sections[0].paragraphs;
  const queued = alignmentJob(consensusId);
  putAlignmentJob({
    ...queued, status: "partial", engine: aeneas, progress: 1, generation: "old-empty-consensus",
    intervals: sentences.slice(0, 3).map((p, i) => ({ paragraphId: p.id, section: 0, trackId: "track-empty", start: 30 + i * 5, end: 34 + i * 5, confidence: 0.65 })),
    coverage: 3 / sentences.length, anchoring: { ...queued.anchoring!, stage: "done" },
  });
  await publishProjectedMaps(workId, alignmentJob(consensusId));
  const before = allJobs().filter((job) => job.origin === "projected");
  assert.ok(before.some((job) => job.ebookId === "empty-2"));
  // Force empty-2's projection to map nothing (as when a rebuilt consensus no longer covers that edition).
  const stateRow = sqlite.prepare("SELECT projections FROM work_ebook_set WHERE work_id=?").get(workId) as { projections: string };
  const projections = JSON.parse(stateRow.projections) as Record<string, (string | null)[]>;
  projections["empty-2"] = projections["empty-2"].map(() => null);
  sqlite.prepare("UPDATE work_ebook_set SET projections=? WHERE work_id=?").run(JSON.stringify(projections), workId);
  putAlignmentJob({
    ...alignmentJob(consensusId), generation: "new-empty-consensus", engine,
    intervals: sentences.slice(0, 3).map((p, i) => ({ paragraphId: p.id, section: 0, trackId: "track-empty", start: 30 + i * 5, end: 34 + i * 5, confidence: 0.65 })),
  });
  await publishProjectedMaps(workId, alignmentJob(consensusId));
  const after = allJobs().filter((job) => job.origin === "projected");
  assert.ok(after.every((job) => job.ebookId !== "empty-2"), "a member with no projected intervals loses its old projected row");
  assert.ok(after.some((job) => job.ebookId === "empty-1" && job.generation === "new-empty-consensus"));
});

test("an unsynced consensus rebuild still clears stale projected maps", async () => {
  await reset();
  const workId = "work-unsynced";
  db.insert(schema.works).values({ id: workId, title: "Unsynced", author: "Author", description: "", genre: "", year: 2026 }).run();
  db.insert(schema.editions).values({ id: "edition-unsynced", workId, cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "rec-unsynced", editionId: "edition-unsynced" }).run();
  const audio = join(process.env.MEDIA_ROOT!, "unsynced.wav");
  writeFileSync(audio, "audio unsynced");
  writeFileSync(join(process.env.MEDIA_ROOT!, "unsynced-1.epub"), await readerFixture());
  db.insert(schema.ebookEditions).values({ id: "unsynced-1", workId, format: "epub", source: join(process.env.MEDIA_ROOT!, "unsynced-1.epub") }).run();
  db.insert(schema.workEbookSetMembers).values({
    workId, ebookId: "unsynced-1", status: "accepted", holdReason: null, sourceTitle: "unsynced-1", sourceAuthor: null, language: "en", byteSize: 1,
    evidence: JSON.stringify({ sharedSentenceCount: 10, uniqueSentenceCount: 0, audioSupportedCoverage: 0.9,
      outlier: { passed: true, reason: "ok", spokenSampleCount: 4, matchedSampleCount: 4, anchorCount: 4, forwardOrder: true, samples: [] },
      language: "en", byteSize: 1 }),
    updatedAt: Date.now(),
  }).run();
  // Too short for three anchors: CTC early-unsynced path.
  db.insert(schema.tracks).values({ id: "track-unsynced", recordingId: "rec-unsynced", title: "Unsynced.m4b", index: 0,
    duration: 40, chapters: [], source: audio, sourceType: "local" }).run();

  const presentation = await syncEbookSetConsensus(workId);
  const consensusId = presentation.consensus!.jobId!;
  const consensusBook = await extractBook(consensusEbookId(workId));
  const sentences = consensusBook.sections[0].paragraphs;
  putAlignmentJob({
    ...alignmentJob(consensusId), status: "partial", engine: aeneas, progress: 1, generation: "old-unsynced",
    intervals: sentences.slice(0, 2).map((p, i) => ({ paragraphId: p.id, section: 0, trackId: "track-unsynced", start: 5 + i * 5, end: 9 + i * 5, confidence: 0.65 })),
    coverage: 2 / sentences.length, anchoring: { ...alignmentJob(consensusId).anchoring!, stage: "done" },
  });
  await publishProjectedMaps(workId, alignmentJob(consensusId));
  assert.equal(allJobs().filter((job) => job.origin === "projected").length, 1);

  assert.equal((await queueEngineRebuilds()).queued, 1);
  autoAnswer = (entry) => {
    if (entry.url.endsWith("/anchor"))
      return Response.json({ engine, outcome: "unsynced", stageTimings: { acousticEncoding: 0.25 }, match: null, start: entry.request.start, text: "" });
    return anchoredWorker(entry);
  };
  setPaused("alignment", false);
  void processAlignments();
  await until(() => !active(consensusId), "unsynced consensus rebuild", 10_000);
  const consensus = alignmentJob(consensusId);
  assert.equal(consensus.outcome, "unsynced", consensus.error ?? undefined);
  assert.equal(consensus.status, "partial");
  assert.equal(allJobs().filter((job) => job.origin === "projected").length, 0,
    "early unsynced must still run onConsensusAlignmentFinished and drop stale projections");
});

test("manual anchor edits are refused while a kept published_map is served", async () => {
  await reset();
  const old = await oldMap("a", aeneas, "ready");
  await queueEngineRebuilds();
  assert.ok(keptMap(old.id));
  putAlignmentJob({ ...alignmentJob(old.id), status: "error", coverage: 0, intervals: [], error: "rebuild failed" });
  assert.ok(keptMap(old.id));
  const served = await app.inject(`/api/alignments/${old.id}/map`);
  assert.equal(served.statusCode, 200);
  assert.equal(served.json().status, "ready");
  const paragraphId = served.json().intervals[0].paragraphId as string;
  const refused = await app.inject({
    method: "POST",
    url: `/api/alignments/${old.id}/anchors`,
    payload: { paragraphId, trackId: "track-a", start: 12, end: 18 },
  });
  assert.ok([400, 500].includes(refused.statusCode), refused.body);
  assert.match(refused.body, /Finish or rebuild this alignment before correcting sentence timings/);
  assert.equal(alignmentJob(old.id).intervals.length, 0, "the failed rebuild row must not receive the edit");
  assert.equal((await app.inject(`/api/alignments/${old.id}/map`)).json().intervals[0].paragraphId, paragraphId);
});

test("alignmentJobNeedsPolling treats an active rebuild.status as processing", async () => {
  const { alignmentJobNeedsPolling } = await import("../src/alignment-map-lifecycle.ts");
  assert.equal(
    alignmentJobNeedsPolling({
      status: "ready",
      rebuild: { status: "queued", progress: 0, engine, error: null, updatedAt: 1 },
    } as AlignmentJob),
    true,
  );
  assert.equal(
    alignmentJobNeedsPolling({
      status: "ready",
      rebuild: { status: "processing", progress: 0.2, engine, error: null, updatedAt: 1 },
    } as AlignmentJob),
    true,
  );
  assert.equal(alignmentJobNeedsPolling({ status: "ready" } as AlignmentJob), false);
  assert.equal(
    alignmentJobNeedsPolling({
      status: "ready",
      rebuild: { status: "error", progress: 0, engine, error: "x", updatedAt: 1 },
    } as AlignmentJob),
    false,
  );
  assert.equal(alignmentJobNeedsPolling({ status: "processing" } as AlignmentJob), true);
  assert.equal(alignmentJobNeedsPolling(undefined), false);
});

function allJobs() {
  return (sqlite.prepare("SELECT id FROM alignment_jobs").all() as { id: string }[]).map((row) => alignmentJob(row.id));
}
