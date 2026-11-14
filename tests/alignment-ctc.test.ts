import { after, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readerFixture } from "./reader-fixture.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-ctc-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
process.env.ALIGNMENT_POOL_ENABLED = "1";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
const audio = join(process.env.MEDIA_ROOT, "audio.wav");
const ebook = join(process.env.MEDIA_ROOT, "book.epub");
writeFileSync(audio, "test audio");
writeFileSync(ebook, await readerFixture({ bodies: ["<p>First sentence. Another sentence.</p>", "<p>Middle sentence. Last sentence.</p>"] }));

const { db, sqlite } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { extractBook } = await import("../server/reader.ts");
const { createAlignment, alignmentJob, putAlignmentJob, processAlignments, stopAlignments, registerAlignment, resetAnchorBatchSupportForTests, resetAlignmentRunnerForTests, setAnchorBatchClockForTests, ANCHOR_BATCH_CHUNK } = await import("../server/alignment.ts");
const { resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests } = await import("../server/alignment-pool.ts");
const originalFetch = globalThis.fetch;
const engine = "ctc-wav2vec2-base-960h-torchaudio-2.8-v2";
resetAlignmentPoolCoordinator([
  { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://ctc-worker.test" },
  { id: "lisa", sshTarget: "lisa", maxConcurrent: 1, remoteWorkRoot: temp, workerUrl: "http://lisa-worker.test" },
]);
const testPoolDeps = {
  async probe() { return true; },
  async exec() { return { code: 0, stdout: "", stderr: "" }; },
  async uploadFile(local: string, remote: string) {
    mkdirSync(dirname(remote), { recursive: true });
    copyFileSync(local, remote);
  },
};
setAlignmentPoolDepsForTests(testPoolDeps);
function mockWorker(handler: typeof fetch, options: {
  down?: string[]; busy?: string[]; wrongDevice?: string[]; anchorReady?: boolean; anchorBatch?: boolean; onHealth?: (host: string) => void;
} = {}) {
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/health")) {
      const lisa = String(input).includes("lisa-worker");
      const host = lisa ? "lisa" : "wsl";
      options.onHealth?.(host);
      if (options.down?.includes(host)) throw new Error(`${host} is unreachable`);
      return Response.json({ ready: true, busy: options.busy?.includes(host) ?? false, stuck: false,
        mediaRoot: join(temp, lisa ? "lisa" : "wsl"),
        ctc: { engine, ready: true, device: lisa || options.wrongDevice?.includes(host) ? "cpu" : "cuda",
          precision: lisa ? "float32" : "float16", anchorReady: options.anchorReady ?? true, passageReady: true,
          ...(options.anchorBatch ? { anchorBatch: true } : {}) } });
    }
    return handler(input, init);
  };
}
db.insert(schema.works).values({ id: "ctc-work", title: "Book", author: "Author", description: "", genre: "", year: 2026 }).run();
db.insert(schema.editions).values({ id: "ctc-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
db.insert(schema.recordings).values({ id: "ctc-recording", editionId: "ctc-edition" }).run();
db.insert(schema.tracks).values({ id: "ctc-track", recordingId: "ctc-recording", title: "Book", index: 0, duration: 400, chapters: [], source: audio, sourceType: "local" }).run();
db.insert(schema.ebookEditions).values({ id: "ctc-ebook", workId: "ctc-work", format: "epub", source: ebook }).run();

after(() => {
  globalThis.fetch = originalFetch;
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  stopAlignments();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

async function settled(id: string) {
  for (let i = 0; i < 200; i++) {
    const job = alignmentJob(id);
    if (["partial", "ready", "error"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Alignment did not settle");
}

test("chapter CTC publishes first and last sentences with worker metadata and rejects a legacy worker", async () => {
  const book = await extractBook("ctc-ebook");
  const pairings = book.sections.map((section, i) => ({ section: section.index, trackId: "ctc-track", start: 10 + i * 100, duration: 80 }));
  const starts: number[] = [];
  mockWorker(async (input, init) => {
    assert.equal(String(input), "http://ctc-worker.test/align");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.engine, "ctc");
    starts.push(request.start);
    return Response.json({ engine, outcome: "mapped", stageTimings: { acousticEncoding: 0.5, ctcPath: 0.25 }, elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i, end: request.start + i + 0.8 })) });
  });
  const created = await createAlignment("ctc-ebook", "ctc-recording", pairings, "chapters");
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.engine, engine);
  assert.equal(job.outcome, "mapped");
  assert.deepEqual(starts, [10, 110]);
  assert.deepEqual(job.stageTimings, { acousticEncoding: 1, ctcPath: 0.5 });
  assert.ok(job.intervals.some((item) => item.paragraphId === book.sections[0].paragraphs[0].id));
  assert.ok(job.intervals.some((item) => item.paragraphId === book.sections.at(-1)!.paragraphs.at(-1)!.id));
  assert.equal(job.intervals.at(-1)!.trackId, "ctc-track");
  const map = JSON.parse(readFileSync(join(temp, "media", "alignment", job.id, "map.json"), "utf8"));
  assert.equal(map.engine, engine);
  assert.deepEqual(map.stageTimings, job.stageTimings);
  assert.equal(map.intervals.length, book.sections.flatMap((section) => section.paragraphs).length);

  // A pre-CTC worker ignores the new request field. Do not publish its aeneas
  // output under the CTC generation or accept its cached result as CTC.
  rmSync(join(temp, "media", "alignment", job.id), { recursive: true, force: true });
  mockWorker(async () => Response.json({ engine: "aeneas-1.7.3", elapsedSeconds: 1,
    intervals: [{ index: 0, start: 10, end: 11 }] }));
  const retried = await createAlignment("ctc-ebook", "ctc-recording", pairings, "chapters");
  const failed = await settled(retried.id);
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /did not use the requested CTC engine/);
  assert.equal(failed.intervals.length, 0);

  // Anchored jobs also default to CTC for their alignment windows.
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  const anchored = await createAlignment("ctc-ebook", "ctc-recording", undefined, "anchored");
  assert.equal(anchored.mode, "anchored");
  assert.equal(anchored.engine, engine);
});

test("an anchored job uses CTC for discovery and alignment with recording cache identity", async () => {
  process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
  const file = join(process.env.MEDIA_ROOT!, "alice.epub");
  writeFileSync(file, await readerFixture());
  db.insert(schema.ebookEditions).values({ id: "ctc-alice-ebook", workId: "ctc-work", format: "epub", source: file }).run();
  const alice = await extractBook("ctc-alice-ebook");
  const paragraphs = alice.sections.flatMap((section) => section.paragraphs);
  // 30 s of credits, five seconds per sentence, 20 s of closing credits.
  const spoken = (index: number) => 30 + index * 5;
  db.insert(schema.editions).values({ id: "ctc-alice-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "ctc-alice-recording", editionId: "ctc-alice-edition" }).run();
  db.insert(schema.tracks).values({ id: "ctc-alice-track", recordingId: "ctc-alice-recording", title: "Alice.m4b", index: 0,
    duration: spoken(paragraphs.length) + 20, chapters: [], source: audio, sourceType: "local" }).run();
  const windowEngines: unknown[] = [];
  mockWorker(async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      assert.equal(String(input), "http://ctc-worker.test/anchor");
      assert.equal(request.engine, "ctc");
      assert.equal(request.recordingId, "ctc-alice-recording");
      assert.equal(request.trackId, "ctc-alice-track");
      assert.ok(request.audioFingerprint.startsWith("audio-v2:"));
      assert.ok(request.audio.startsWith(join(temp, "wsl", "alignment", "pool-jobs")));
      assert.ok(request.output.startsWith(join(temp, "wsl", "alignment", "pool-jobs")));
      const index = Math.max(0, Math.ceil((request.start - 30) / 5));
      if (index >= paragraphs.length || spoken(index) > request.start + request.duration - 3)
        return Response.json({ engine, outcome: "unsynced", stageTimings: { acousticEncoding: 0.25 }, match: null, start: request.start, text: "" });
      return Response.json({ engine, outcome: "mapped", stageTimings: { acousticEncoding: 0.25 },
        match: { index, score: 0.9, text: "" }, start: spoken(index), text: "word ".repeat(40) });
    }
    windowEngines.push(request.engine);
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", stageTimings: { ctcPath: 0.5 }, elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  }, { anchorReady: false });
  const created = await createAlignment("ctc-alice-ebook", "ctc-alice-recording", undefined, "anchored");
  assert.equal(created.mode, "anchored");
  assert.equal(created.engine, engine);
  let job = alignmentJob(created.id);
  for (let i = 0; i < 300 && !(job.anchoring?.stage === "done" || job.status === "error"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = alignmentJob(created.id);
  }
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.engine, engine);
  assert.ok(windowEngines.length > 0 && windowEngines.every((value) => value === "ctc"));
  assert.equal(windowEngines.length, job.anchoring!.segments.length);
  assert.ok(job.stageTimings!.acousticEncoding > 0 && job.stageTimings!.ctcPath > 0);
  assert.ok(["mapped", "partial"].includes(job.outcome!));
  assert.ok(job.intervals.length > 0);

  // A failed window must not be cached before the CPU fallback retries it.
  rmSync(join(temp, "media", "alignment", job.id), { recursive: true, force: true });
  const windowHosts: string[] = [];
  mockWorker(async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      const index = Math.max(0, Math.ceil((request.start - 30) / 5));
      if (index >= paragraphs.length || spoken(index) > request.start + request.duration - 3)
        return Response.json({ engine, match: null, start: request.start, text: "" });
      return Response.json({ engine, match: { index, score: 0.9 }, start: spoken(index), text: "word ".repeat(40) });
    }
    windowHosts.push(String(input));
    if (String(input).includes("ctc-worker"))
      return Response.json({ engine, outcome: "error", elapsedSeconds: 1, intervals: [] });
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  });
  const failedOver = await createAlignment("ctc-alice-ebook", "ctc-alice-recording", undefined, "anchored");
  const cpuJob = await settled(failedOver.id);
  assert.equal(cpuJob.status, "partial", cpuJob.error ?? undefined);
  assert.equal(cpuJob.engine, engine);
  assert.equal(cpuJob.ctcDevice, "cpu");
  assert.equal(windowHosts[0], "http://ctc-worker.test/align");
  assert.ok(windowHosts.slice(1).every((url) => url === "http://lisa-worker.test/align"));

  // A worker that answers a CTC window with another engine is refused, not published.
  rmSync(join(temp, "media", "alignment", job.id), { recursive: true, force: true });
  mockWorker(async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      const index = Math.max(0, Math.ceil((request.start - 30) / 5));
      if (index >= paragraphs.length || spoken(index) > request.start + request.duration - 3)
        return Response.json({ engine, match: null, start: request.start, text: "" });
      return Response.json({ engine, match: { index, score: 0.9, text: "" }, start: spoken(index), text: "word ".repeat(40) });
    }
    return Response.json({ engine: "aeneas-1.7.3", elapsedSeconds: 1, intervals: [{ index: 0, start: request.start, end: request.start + 1 }] });
  });
  const wrong = await createAlignment("ctc-alice-ebook", "ctc-alice-recording", undefined, "anchored");
  let refused = alignmentJob(wrong.id);
  for (let i = 0; i < 300 && refused.status !== "error"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    refused = alignmentJob(wrong.id);
  }
  assert.equal(refused.status, "error");
  assert.match(refused.error ?? "", /did not use the requested CTC engine/);
});

test("a short unmarked recording can align from one CTC sample", async () => {
  process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
  db.insert(schema.recordings).values({ id: "ctc-short-recording", editionId: "ctc-edition" }).run();
  db.insert(schema.tracks).values({ id: "ctc-short-track", recordingId: "ctc-short-recording", title: "Short", index: 0,
    duration: 20, chapters: [], source: audio, sourceType: "local" }).run();
  const book = await extractBook("ctc-ebook");
  const paragraphs = book.sections.flatMap((section) => section.paragraphs);
  mockWorker(async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      const match = { index: 0, lastIndex: request.fragments.length - 1, score: 0.9, start: 0 };
      return Response.json({ engine, outcome: "mapped", text: "word ".repeat(20), match, matches: [match], start: 0 });
    }
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  });
  const created = await createAlignment("ctc-ebook", "ctc-short-recording", undefined, "anchored");
  const job = await settled(created.id);
  assert.equal(job.anchoring?.anchors.length, 1);
  assert.ok(job.intervals.some((interval) => interval.paragraphId === paragraphs[0].id));
  assert.ok(job.intervals.some((interval) => interval.paragraphId === paragraphs.at(-1)!.id));
});

test("an explicit anchored request is accepted on a chaptered release whose chapter pairing is wrong", async () => {
  process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
  db.insert(schema.recordings).values({ id: "ctc-chaptered-recording", editionId: "ctc-edition" }).run();
  db.insert(schema.tracks).values({ id: "ctc-chaptered-track", recordingId: "ctc-chaptered-recording", title: "Chaptered", index: 0,
    duration: 20, chapters: [{ title: "Chapter 1", start: 0 }, { title: "Chapter 2", start: 10 }] as never, source: audio, sourceType: "local" }).run();
  mockWorker(async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      const match = { index: 0, lastIndex: request.fragments.length - 1, score: 0.9, start: 0 };
      return Response.json({ engine, outcome: "mapped", text: "word ".repeat(20), match, matches: [match], start: 0 });
    }
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  });
  const created = await createAlignment("ctc-ebook", "ctc-chaptered-recording", undefined, "anchored");
  assert.equal(created.mode, "anchored");
  const job = await settled(created.id);
  assert.ok(job.anchoring, "the job must run in anchored mode, not chapter pairing");
  assert.ok(job.intervals.length > 0);
});

test("two ebook editions send the same recording identity and publish cache timings", async () => {
  process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
  const otherEbook = join(process.env.MEDIA_ROOT!, "second-edition.epub");
  writeFileSync(otherEbook, await readerFixture({ bodies: ["<p>A different edition.</p>", "<p>Another ending.</p>"] }));
  db.insert(schema.ebookEditions).values({ id: "ctc-second-ebook", workId: "ctc-work", format: "epub", source: otherEbook }).run();
  const requests: { recordingId: string; trackId: string; audioFingerprint: string }[] = [];
  const seen = new Set<string>();
  mockWorker(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    const identity = { recordingId: request.recordingId, trackId: request.trackId, audioFingerprint: request.audioFingerprint };
    requests.push(identity);
    const key = JSON.stringify(identity);
    const hit = seen.has(key);
    seen.add(key);
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      stageTimings: { acousticEncoding: hit ? 0 : 2, acousticCacheRead: 0.01 },
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i, end: request.start + i + 0.8 })) });
  });
  const firstBook = await extractBook("ctc-ebook");
  const secondBook = await extractBook("ctc-second-ebook");
  const first = await createAlignment("ctc-ebook", "ctc-recording", firstBook.sections.map((section) => ({
    section: section.index, trackId: "ctc-track", start: 10, duration: 40,
  })), "chapters");
  const firstJob = await settled(first.id);
  assert.equal(firstJob.status, "partial", firstJob.error ?? undefined);
  const second = await createAlignment("ctc-second-ebook", "ctc-recording", secondBook.sections.map((section) => ({
    section: section.index, trackId: "ctc-track", start: 11, duration: 39,
  })), "chapters");
  const secondJob = await settled(second.id);
  assert.equal(secondJob.status, "partial", secondJob.error ?? undefined);
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((request) => request.recordingId === "ctc-recording" && request.trackId === "ctc-track"));
  assert.ok(requests[0].audioFingerprint.startsWith("audio-v2:"));
  assert.ok(requests.every((request) => request.audioFingerprint === requests[0].audioFingerprint));
  assert.equal(firstJob.stageTimings!.acousticEncoding, 2);
  assert.equal(secondJob.stageTimings!.acousticEncoding, 0);
  assert.ok(secondJob.stageTimings!.acousticCacheRead > 0);
});

test("CTC never reaches the production worker when the pool is disabled", async () => {
  delete process.env.ALIGNMENT_POOL_ENABLED;
  const calls: string[] = [];
  mockWorker(async (input) => { calls.push(String(input)); throw new Error("unexpected request"); });
  const book = await extractBook("ctc-ebook");
  const created = await createAlignment("ctc-ebook", "ctc-recording", [{
    section: book.sections[0].index, trackId: "ctc-track", start: 190, duration: 40,
  }], "chapters");
  const job = await settled(created.id);
  assert.equal(job.status, "error");
  assert.match(job.error ?? "", /requires the remote alignment pool/);
  assert.deepEqual(calls, []);
  process.env.ALIGNMENT_POOL_ENABLED = "1";
});

test("unreachable, busy or incompatible WSL routes chapter CTC to lisa without using the production worker", async () => {
  const book = await extractBook("ctc-ebook");
  delete process.env.ALIGNMENT_WORKER_URL;
  for (const [i, options] of [{ down: ["wsl"] }, { busy: ["wsl"] }, { wrongDevice: ["wsl"] }].entries()) {
    const calls: string[] = [];
    mockWorker(async (input, init) => {
      calls.push(String(input));
      const request = JSON.parse(String(init?.body));
      assert.equal(request.engine, "ctc");
      assert.ok(request.audio.startsWith(join(temp, "lisa", "alignment", "pool-jobs")));
      assert.equal(readFileSync(request.audio, "utf8"), "test audio");
      assert.ok(request.output.startsWith(join(temp, "lisa", "alignment", "pool-jobs")));
      return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
        intervals: request.fragments.map((_: string, index: number) => ({ index, start: request.start + index, end: request.start + index + 0.8 })) });
    }, options);
    const created = await createAlignment("ctc-ebook", "ctc-recording", [{
      section: book.sections[0].index, trackId: "ctc-track", start: 210 + i * 45, duration: 40,
    }], "chapters");
    const job = await settled(created.id);
    assert.equal(job.status, "partial", job.error ?? undefined);
    assert.equal(job.engine, engine);
    assert.equal(job.ctcDevice, "cpu");
    assert.equal(job.ctcPrecision, "float32");
    assert.deepEqual(calls, ["http://lisa-worker.test/align"]);
  }
  process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
});

test("CTC waits while both workers are busy and starts when a worker is free", async () => {
  const book = await extractBook("ctc-ebook");
  const busy = ["wsl", "lisa"];
  const checked: string[] = [];
  const calls: string[] = [];
  mockWorker(async (input, init) => {
    calls.push(String(input));
    const request = JSON.parse(String(init?.body));
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, index: number) => ({ index, start: request.start + index, end: request.start + index + 0.8 })) });
  }, { busy, onHealth: (host) => checked.push(host) });
  const created = await createAlignment("ctc-ebook", "ctc-recording", [{
    section: book.sections[0].index, trackId: "ctc-track", start: 350, duration: 40,
  }], "chapters");
  for (let i = 0; i < 100 && checked.length < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(checked, ["wsl", "lisa"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(alignmentJob(created.id).status, "queued");
  assert.deepEqual(calls, []);
  busy.length = 0;
  const { processAlignments } = await import("../server/alignment.ts");
  await processAlignments();
  const finished = await settled(created.id);
  assert.equal(finished.status, "partial", finished.error ?? undefined);
  assert.deepEqual(calls, ["http://ctc-worker.test/align"]);
});

test("a persisted legacy pool assignment is re-probed instead of sending CTC to the old worker", async () => {
  const book = await extractBook("ctc-ebook");
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  const created = await createAlignment("ctc-ebook", "ctc-recording", [{
    section: book.sections[0].index, trackId: "ctc-track", start: 160, duration: 40,
  }], "chapters");
  const { putAlignmentJob, processAlignments } = await import("../server/alignment.ts");
  const legacy = alignmentJob(created.id);
  legacy.pool = { hostId: "steamdeck", attempt: 1, jobMediaRoot: "/old/media",
    workerUrl: "http://production-worker.test", triedHosts: ["steamdeck"], stagedAudio: {} };
  putAlignmentJob(legacy);
  process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
  const calls: string[] = [];
  mockWorker(async (input, init) => {
    calls.push(String(input));
    const request = JSON.parse(String(init?.body));
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, index: number) => ({ index, start: request.start + index, end: request.start + index + 0.8 })) });
  });
  await processAlignments();
  const finished = await settled(created.id);
  assert.equal(finished.status, "partial", finished.error ?? undefined);
  assert.deepEqual(calls, ["http://ctc-worker.test/align"]);
});

test("after a server restart a job runs again on its own healthy host while the other host is down (#263)", async () => {
  const book = await extractBook("ctc-ebook");
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  const created = await createAlignment("ctc-ebook", "ctc-recording", [{
    section: book.sections[0].index, trackId: "ctc-track", start: 70, duration: 40,
  }], "chapters");
  // The job was running on WSL when the server stopped: the dispatch is persisted but no lease survives.
  const running = alignmentJob(created.id);
  running.pool = { hostId: "wsl", attempt: 1, jobMediaRoot: join(temp, "wsl", "alignment", "pool-jobs", created.id),
    workerUrl: "http://ctc-worker.test", triedHosts: ["wsl"], stagedAudio: {} };
  putAlignmentJob(running);
  process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
  const calls: string[] = [];
  mockWorker(async (input, init) => {
    calls.push(String(input));
    const request = JSON.parse(String(init?.body));
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, index: number) => ({ index, start: request.start + index, end: request.start + index + 0.8 })) });
  }, { down: ["lisa"] });
  await processAlignments();
  const finished = await settled(created.id);
  assert.equal(finished.status, "partial", finished.error ?? undefined);
  assert.deepEqual(calls, ["http://ctc-worker.test/align"]);
  assert.equal(finished.pool?.hostId, "wsl");
  assert.deepEqual(finished.pool?.triedHosts, ["wsl"]);
});

test("pausing during remote staging preserves the pause and releases the worker", async () => {
  const book = await extractBook("ctc-ebook");
  let markStarted!: () => void;
  let unblock!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  setAlignmentPoolDepsForTests({ ...testPoolDeps, async uploadFile(local, remote) {
    markStarted();
    await blocked;
    await testPoolDeps.uploadFile(local, remote);
  } });
  const calls: string[] = [];
  mockWorker(async (input) => { calls.push(String(input)); throw new Error("unexpected request"); });
  try {
    const created = await createAlignment("ctc-ebook", "ctc-recording", [{
      section: book.sections[0].index, trackId: "ctc-track", start: 120, duration: 40,
    }], "chapters");
    await started;
    const { putAlignmentJob } = await import("../server/alignment.ts");
    const { getAlignmentPoolCoordinator } = await import("../server/alignment-pool.ts");
    const paused = alignmentJob(created.id);
    paused.status = "paused";
    putAlignmentJob(paused);
    unblock();
    for (let i = 0; i < 100 && getAlignmentPoolCoordinator().activeOnHost("wsl"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(getAlignmentPoolCoordinator().activeOnHost("wsl"), 0);
    assert.equal(alignmentJob(created.id).status, "paused");
    assert.deepEqual(calls, []);
  } finally {
    unblock();
    setAlignmentPoolDepsForTests(testPoolDeps);
  }
});

test("speech-recovery failures do not replace the CTC engine identity", async () => {
  const calls: string[] = [];
  mockWorker(async (input) => {
    calls.push(String(input));
    return Response.json({ detail: { engine: "aeneas-1.7.3", outcome: "error",
      stageTimings: { failedRequest: 0.1 } } }, { status: 500 });
  });
  const created = await createAlignment("ctc-alice-ebook", "ctc-alice-recording", undefined, "anchored");
  const failed = await settled(created.id);
  assert.equal(failed.status, "error");
  assert.equal(failed.engine, engine);
  assert.deepEqual(calls, ["http://ctc-worker.test/anchor", "http://lisa-worker.test/anchor"]);
});

test("CTC retries the other host once, remains failed after both fail, and resume starts a new attempt", async () => {
  const book = await extractBook("ctc-ebook");
  const calls: string[] = [];
  mockWorker(async (input) => {
    calls.push(String(input));
    return new Response("worker failed", { status: 500 });
  });
  const created = await createAlignment("ctc-ebook", "ctc-recording", [{
    section: book.sections[0].index, trackId: "ctc-track", start: 320, duration: 40,
  }], "chapters");
  const failed = await settled(created.id);
  assert.equal(failed.status, "error");
  assert.deepEqual(calls, ["http://ctc-worker.test/align", "http://lisa-worker.test/align"]);
  assert.deepEqual(failed.pool?.triedHosts, ["wsl", "lisa"]);

  mockWorker(async (input, init) => {
    calls.push(String(input));
    const request = JSON.parse(String(init?.body));
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, index: number) => ({ index, start: request.start + index, end: request.start + index + 0.8 })) });
  });
  const Fastify = (await import("fastify")).default;
  const { registerAlignment } = await import("../server/alignment.ts");
  const app = Fastify();
  registerAlignment(app);
  const response = await app.inject({ method: "PATCH", url: `/api/alignments/${created.id}`, payload: { action: "resume" } });
  assert.equal(response.statusCode, 200);
  const retried = await settled(created.id);
  assert.equal(retried.status, "partial", retried.error ?? undefined);
  assert.equal(retried.engine, engine);
  assert.equal(retried.ctcDevice, "cuda");
  assert.equal(retried.ctcPrecision, "float16");
  assert.equal(calls.at(-1), "http://ctc-worker.test/align");
  await app.close();
});
test("unsynced passages and unsupported-language outcomes survive storage and API responses", async () => {
  const { default: Fastify } = await import("fastify");
  const app = Fastify();
  registerAlignment(app);
  try {
    const book = await extractBook("ctc-ebook");
    const pairings = book.sections.map((section, i) => ({ section: section.index, trackId: "ctc-track", start: 10 + i * 100, duration: 80 }));
    const previous = sqlite.prepare("SELECT id FROM alignment_jobs WHERE ebook_id=? AND recording_id=?").get("ctc-ebook", "ctc-recording") as { id: string } | undefined;
    if (previous) rmSync(join(temp, "media", "alignment", previous.id), { recursive: true, force: true });
    let calls = 0;
    mockWorker(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      calls++;
      return Response.json({ engine, outcome: calls === 1 ? "mapped" : "unsynced", elapsedSeconds: 1,
        intervals: calls === 1 ? [{ index: 0, start: request.start, end: request.start + 1 }] : [] });
    });
    const created = await createAlignment("ctc-ebook", "ctc-recording", pairings, "chapters");
    const job = await settled(created.id);
    assert.equal(job.outcome, "partial");
    assert.ok(job.unsyncedPassages?.length);
    const mapped = new Set(job.intervals.map((item) => item.paragraphId));
    assert.ok(job.unsyncedPassages.every((passage) => !mapped.has(passage.firstParagraphId)));
    const stored = JSON.parse((sqlite.prepare("SELECT data FROM alignment_jobs WHERE id=?").get(job.id) as { data: string }).data);
    assert.deepEqual(stored.unsyncedPassages, job.unsyncedPassages);
    const summary = await app.inject({ method: "GET", url: "/api/alignments?ebookId=ctc-ebook&summary=1" });
    assert.equal(summary.statusCode, 200, summary.body);
    assert.deepEqual(summary.json().jobs.find((entry: { id: string }) => entry.id === job.id).unsyncedPassages, job.unsyncedPassages);

    rmSync(join(temp, "media", "alignment", job.id), { recursive: true, force: true });
    calls = 0;
    mockWorker(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      calls++;
      return Response.json({ engine, outcome: calls === 1 ? "mapped" : "language_not_supported", elapsedSeconds: 1,
        intervals: calls === 1 ? [{ index: 0, start: request.start, end: request.start + 1 }] : [] });
    });
    const retried = await createAlignment("ctc-ebook", "ctc-recording", pairings, "chapters");
    const unsupported = await settled(retried.id);
    assert.equal(unsupported.outcome, "language_not_supported");
    assert.deepEqual(unsupported.intervals, []);
    assert.equal(unsupported.coverage, 0);
    const response = await app.inject({ method: "GET", url: "/api/alignments?ebookId=ctc-ebook&summary=1" });
    assert.equal(response.json().jobs.find((entry: { id: string }) => entry.id === retried.id).outcome, "language_not_supported");
    const map = await app.inject({ method: "GET", url: `/api/alignments/${retried.id}/map` });
    assert.equal(map.statusCode, 410, map.body);

    const french = join(process.env.MEDIA_ROOT!, "french.epub");
    writeFileSync(french, await readerFixture({ language: "fr" }));
    db.insert(schema.editions).values({ id: "fr-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "fr" }).run();
    db.insert(schema.recordings).values({ id: "fr-recording", editionId: "fr-edition" }).run();
    db.insert(schema.tracks).values({ id: "fr-track", recordingId: "fr-recording", title: "French", index: 0, duration: 400, chapters: [], source: audio, sourceType: "local" }).run();
    db.insert(schema.ebookEditions).values({ id: "fr-ebook", workId: "ctc-work", format: "epub", source: french }).run();
    calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("unsupported languages must not reach the worker"); };
    // The retired aeneas switch (#279) is ignored.
    process.env.ALIGNMENT_CHAPTER_ENGINE = "aeneas";
    const fr = await createAlignment("fr-ebook", "fr-recording", undefined, "anchored");
    delete process.env.ALIGNMENT_CHAPTER_ENGINE;
    assert.equal(fr.engine, engine);
    const frJob = await settled(fr.id);
    assert.equal(frJob.outcome, "language_not_supported");
    assert.equal(calls, 0);
    assert.deepEqual(frJob.intervals, []);
    assert.equal((await app.inject({ method: "GET", url: `/api/alignments/${fr.id}/map` })).statusCode, 410);

    // An EPUB that declares no usable language (dc:language "und") is tried as English.
    const und = join(process.env.MEDIA_ROOT!, "und.epub");
    writeFileSync(und, await readerFixture({ language: "und" }));
    db.insert(schema.ebookEditions).values({ id: "und-ebook", workId: "ctc-work", format: "epub", source: und }).run();
    let undCalls = 0;
    mockWorker(async () => { undCalls++; return Response.json({ engine, outcome: "unsynced", match: null, text: "unrelated narration ".repeat(10) }); });
    const undJob = await settled((await createAlignment("und-ebook", "ctc-alice-recording", undefined, "anchored")).id);
    assert.notEqual(undJob.outcome, "language_not_supported");
    assert.ok(undCalls > 0, "an undetermined language must reach the CTC worker");

    mockWorker(async () => Response.json({ engine, outcome: "unsynced", match: null, text: "unrelated narration ".repeat(10) }));
    const mismatch = await createAlignment("ctc-alice-ebook", "ctc-alice-recording", undefined, "anchored");
    const unsynced = await settled(mismatch.id);
    assert.equal(unsynced.outcome, "unsynced");
    assert.equal(unsynced.coverage, 0);
    assert.deepEqual(unsynced.intervals, []);
    assert.ok(unsynced.unsyncedPassages?.length);

    delete process.env.ALIGNMENT_WORKER_TOKEN;
    const old = await createAlignment("ctc-ebook", "ctc-recording", pairings, "chapters");
    putAlignmentJob({ ...old, ctcValidationVersion: undefined, status: "queued",
      intervals: [{ paragraphId: book.sections[0].paragraphs[0].id, section: book.sections[0].index,
        trackId: "ctc-track", start: 10, end: 11, confidence: 0.65 }],
      sectionsDone: pairings.map((pair) => pair.section), coverage: 1 });
    calls = 0;
    process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
    rmSync(join(temp, "media", "alignment", old.id), { recursive: true, force: true });
    mockWorker(async () => {
      calls++;
      return Response.json({ engine, outcome: "unsynced", elapsedSeconds: 1, intervals: [] });
    });
    await processAlignments();
    const rebuilt = alignmentJob(old.id);
    assert.equal(calls, pairings.length);
    assert.equal(rebuilt.ctcValidationVersion, 1);
    assert.deepEqual(rebuilt.intervals, []);
    assert.equal(rebuilt.outcome, "unsynced");
  } finally {
    await app.close();
  }
});

test("pool failure reasons survive storage and summary responses, and resume starts fresh", async () => {
  const { default: Fastify } = await import("fastify");
  const app = Fastify();
  registerAlignment(app);
  try {
    const book = await extractBook("ctc-ebook");
    const previous = sqlite.prepare("SELECT id FROM alignment_jobs WHERE ebook_id=? AND recording_id=?")
      .get("ctc-ebook", "ctc-recording") as { id: string } | undefined;
    if (previous) rmSync(join(temp, "media", "alignment", previous.id), { recursive: true, force: true });
    mockWorker(async () => { throw new Error("worker request must not run"); }, { down: ["wsl", "lisa"] });
    const created = await createAlignment("ctc-ebook", "ctc-recording", [{
      section: book.sections[0].index, trackId: "ctc-track", start: 0, duration: 40,
    }], "chapters");
    const failed = await settled(created.id);
    assert.equal(failed.status, "error");
    assert.deepEqual(failed.poolErrors, { wsl: "health: wsl is unreachable", lisa: "health: lisa is unreachable" });
    const stored = JSON.parse((sqlite.prepare("SELECT data FROM alignment_jobs WHERE id=?").get(created.id) as { data: string }).data);
    assert.deepEqual(stored.poolErrors, failed.poolErrors);
    const summary = await app.inject({ method: "GET", url: "/api/alignments?ebookId=ctc-ebook&summary=1" });
    assert.equal(summary.statusCode, 200);
    assert.deepEqual(summary.json().jobs.find((job: { id: string }) => job.id === created.id).poolErrors, failed.poolErrors);

    mockWorker(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
        intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i, end: request.start + i + 0.8 })) });
    }, { down: ["wsl"] });
    const response = await app.inject({ method: "PATCH", url: `/api/alignments/${created.id}`, payload: { action: "resume" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().poolErrors, undefined);
    const retried = await settled(created.id);
    assert.equal(retried.status, "partial", retried.error ?? undefined);
    assert.equal(retried.pool?.hostId, "lisa");
    assert.deepEqual(retried.poolErrors, { wsl: "health: wsl is unreachable" });
  } finally {
    await app.close();
  }
});

test("anchored CTC sampling uses /anchor-batch when the worker advertises it and records GPU util", async () => {
  resetAnchorBatchSupportForTests();
  resetAlignmentPoolCoordinator([
    { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://ctc-worker.test" },
    { id: "lisa", sshTarget: "lisa", maxConcurrent: 1, remoteWorkRoot: temp, workerUrl: "http://lisa-worker.test" },
  ]);
  setAlignmentPoolDepsForTests(testPoolDeps);
  resetAlignmentRunnerForTests();
  process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  const file = join(process.env.MEDIA_ROOT!, "batch-alice.epub");
  writeFileSync(file, await readerFixture());
  db.insert(schema.ebookEditions).values({ id: "ctc-batch-ebook", workId: "ctc-work", format: "epub", source: file }).run();
  const alice = await extractBook("ctc-batch-ebook");
  const paragraphs = alice.sections.flatMap((section) => section.paragraphs);
  const spoken = (index: number) => 30 + index * 5;
  db.insert(schema.editions).values({ id: "ctc-batch-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "ctc-batch-recording", editionId: "ctc-batch-edition" }).run();
  db.insert(schema.tracks).values({ id: "ctc-batch-track", recordingId: "ctc-batch-recording", title: "Alice.m4b", index: 0,
    duration: spoken(paragraphs.length) + 20, chapters: [], source: audio, sourceType: "local" }).run();
  const batchCalls: unknown[] = [];
  const singleCalls: string[] = [];
  mockWorker(async (input, init) => {
    const url = String(input);
    const request = JSON.parse(String(init?.body));
    if (url.endsWith("/anchor-batch")) {
      batchCalls.push(request);
      assert.equal(request.engine, "ctc");
      assert.ok(Array.isArray(request.windows) && request.windows.length > 1);
      assert.equal(request.trackId, "ctc-batch-track");
      return Response.json({
        engine,
        outcome: "mapped",
        gpuUtilization: 55,
        stageTimings: { audioExtraction: 0.5, acousticEncoding: 0.4, fragmentIndex: 0.1 },
        results: request.windows.map((window: { start: number; duration: number }) => {
          const index = Math.max(0, Math.ceil((window.start - 30) / 5));
          if (index >= paragraphs.length || spoken(index) > window.start + window.duration - 3)
            return { engine, outcome: "unsynced", match: null, start: window.start, text: "" };
          return { engine, outcome: "mapped", match: { index, score: 0.9 }, start: spoken(index), text: "word ".repeat(40) };
        }),
      });
    }
    if (url.endsWith("/anchor")) {
      singleCalls.push(url);
      throw new Error("single-window /anchor must not run when batch is available");
    }
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", stageTimings: { ctcPath: 0.5 }, elapsedSeconds: 1, gpuUtilization: 10,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  }, { anchorReady: false, anchorBatch: true });
  const created = await createAlignment("ctc-batch-ebook", "ctc-batch-recording", undefined, "anchored");
  let job = alignmentJob(created.id);
  for (let i = 0; i < 600 && !(job.anchoring?.stage === "done" || ["partial", "ready", "error"].includes(job.status)); i++) {
    if (job.status === "queued") void processAlignments();
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = alignmentJob(created.id);
  }
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.ok(batchCalls.length >= 1, "expected at least one /anchor-batch call");
  assert.equal(singleCalls.length, 0);
  assert.ok(job.anchoring!.anchors.length >= 3, "batch samples must proceed to anchor selection");
  assert.ok(job.intervals.length > 0, "batch samples must proceed to alignment");
  assert.ok(job.gpuUtilization! > 0);
  assert.ok(job.stageTimings!.fragmentIndex! > 0);
  resetAnchorBatchSupportForTests();
});

test("anchored CTC sampling falls back to /anchor when the worker lacks batch support", async () => {
  resetAnchorBatchSupportForTests();
  resetAlignmentPoolCoordinator([
    { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://ctc-worker.test" },
    { id: "lisa", sshTarget: "lisa", maxConcurrent: 1, remoteWorkRoot: temp, workerUrl: "http://lisa-worker.test" },
  ]);
  setAlignmentPoolDepsForTests(testPoolDeps);
  resetAlignmentRunnerForTests();
  process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  const file = join(process.env.MEDIA_ROOT!, "fallback-alice.epub");
  writeFileSync(file, await readerFixture());
  db.insert(schema.ebookEditions).values({ id: "ctc-fallback-ebook", workId: "ctc-work", format: "epub", source: file }).run();
  const alice = await extractBook("ctc-fallback-ebook");
  const paragraphs = alice.sections.flatMap((section) => section.paragraphs);
  const spoken = (index: number) => 30 + index * 5;
  db.insert(schema.editions).values({ id: "ctc-fallback-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "ctc-fallback-recording", editionId: "ctc-fallback-edition" }).run();
  db.insert(schema.tracks).values({ id: "ctc-fallback-track", recordingId: "ctc-fallback-recording", title: "Alice.m4b", index: 0,
    duration: spoken(paragraphs.length) + 20, chapters: [], source: audio, sourceType: "local" }).run();
  let batchHits = 0;
  let anchorHits = 0;
  mockWorker(async (input, init) => {
    const url = String(input);
    const request = JSON.parse(String(init?.body));
    if (url.endsWith("/anchor-batch")) {
      batchHits++;
      return new Response("missing", { status: 404 });
    }
    if (url.endsWith("/anchor")) {
      anchorHits++;
      const index = Math.max(0, Math.ceil((request.start - 30) / 5));
      if (index >= paragraphs.length || spoken(index) > request.start + request.duration - 3)
        return Response.json({ engine, outcome: "unsynced", stageTimings: { acousticEncoding: 0.1 }, match: null, start: request.start, text: "", gpuUtilization: null });
      return Response.json({ engine, outcome: "mapped", stageTimings: { acousticEncoding: 0.1 },
        match: { index, score: 0.9 }, start: spoken(index), text: "word ".repeat(40), gpuUtilization: null });
    }
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", stageTimings: { ctcPath: 0.5 }, elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  }, { anchorReady: false, anchorBatch: true });
  const created = await createAlignment("ctc-fallback-ebook", "ctc-fallback-recording", undefined, "anchored");
  let job = alignmentJob(created.id);
  for (let i = 0; i < 600 && !["partial", "ready", "error"].includes(job.status); i++) {
    if (job.status === "queued") void processAlignments();
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = alignmentJob(created.id);
  }
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(batchHits, 1);
  assert.ok(anchorHits > 1);
  assert.equal(job.gpuUtilization, null);
  resetAnchorBatchSupportForTests();
});

test("anchored CTC sampling chunks /anchor-batch to at most 128 windows per request", async () => {
  resetAnchorBatchSupportForTests();
  resetAlignmentPoolCoordinator([
    { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://ctc-worker.test" },
    { id: "lisa", sshTarget: "lisa", maxConcurrent: 1, remoteWorkRoot: temp, workerUrl: "http://lisa-worker.test" },
  ]);
  setAlignmentPoolDepsForTests(testPoolDeps);
  resetAlignmentRunnerForTests();
  process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  const file = join(process.env.MEDIA_ROOT!, "chunk-alice.epub");
  writeFileSync(file, await readerFixture());
  db.insert(schema.ebookEditions).values({ id: "ctc-chunk-ebook", workId: "ctc-work", format: "epub", source: file }).run();
  db.insert(schema.editions).values({ id: "ctc-chunk-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "ctc-chunk-recording", editionId: "ctc-chunk-edition" }).run();
  db.insert(schema.tracks).values({ id: "ctc-chunk-track", recordingId: "ctc-chunk-recording", title: "Long.m4b", index: 0,
    duration: 200_000, chapters: [], source: audio, sourceType: "local" }).run();
  const windowCounts: number[] = [];
  let midJob404 = false;
  mockWorker(async (input, init) => {
    const url = String(input);
    const request = JSON.parse(String(init?.body));
    if (url.endsWith("/anchor-batch")) {
      windowCounts.push(request.windows.length);
      assert.ok(request.windows.length <= ANCHOR_BATCH_CHUNK, `chunk too large: ${request.windows.length}`);
      // Mid-job 404 after the first chunk must still fall back to /anchor for the rest.
      if (windowCounts.length === 2) {
        midJob404 = true;
        return new Response("missing", { status: 404 });
      }
      return Response.json({
        engine,
        outcome: "mapped",
        gpuUtilization: 40,
        stageTimings: { acousticEncoding: 0.1 },
        results: request.windows.map((window: { start: number }) => ({
          engine, outcome: "unsynced", match: null, start: window.start, text: "",
        })),
      });
    }
    if (url.endsWith("/anchor")) {
      return Response.json({ engine, outcome: "unsynced", match: null, start: request.start, text: "",
        stageTimings: { acousticEncoding: 0.05 }, gpuUtilization: null });
    }
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", stageTimings: { ctcPath: 0.5 }, elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  }, { anchorReady: false, anchorBatch: true });
  const created = await createAlignment("ctc-chunk-ebook", "ctc-chunk-recording", undefined, "anchored");
  let job = alignmentJob(created.id);
  // Force 300 pending windows on one track so chunking is required.
  job.anchoring!.samples = Array.from({ length: 300 }, (_, i) => ({
    trackId: "ctc-chunk-track", time: i * 40, duration: 30,
  }));
  putAlignmentJob(job);
  for (let i = 0; i < 800 && !["partial", "ready", "error"].includes(job.status); i++) {
    if (job.status === "queued") void processAlignments();
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = alignmentJob(created.id);
  }
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.ok(windowCounts.length >= 2, `expected multiple chunks, got ${windowCounts.join(",")}`);
  assert.equal(windowCounts[0], ANCHOR_BATCH_CHUNK);
  assert.ok(midJob404, "expected a mid-job 404 to exercise fallback");
  assert.ok(job.anchoring!.samples.every((sample) => sample.done), "all samples must finish via batch or /anchor");
  resetAnchorBatchSupportForTests();
});

test("anchorBatchSupport negative cache expires after TTL while true stays sticky", async () => {
  resetAnchorBatchSupportForTests();
  let now = 1_000_000;
  setAnchorBatchClockForTests(() => now);
  resetAlignmentPoolCoordinator([
    { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://ctc-worker.test" },
    { id: "lisa", sshTarget: "lisa", maxConcurrent: 1, remoteWorkRoot: temp, workerUrl: "http://lisa-worker.test" },
  ]);
  setAlignmentPoolDepsForTests(testPoolDeps);
  resetAlignmentRunnerForTests();
  const file = join(process.env.MEDIA_ROOT!, "ttl-alice.epub");
  writeFileSync(file, await readerFixture());
  db.insert(schema.ebookEditions).values({ id: "ctc-ttl-ebook", workId: "ctc-work", format: "epub", source: file }).run();
  db.insert(schema.editions).values({ id: "ctc-ttl-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "ctc-ttl-recording", editionId: "ctc-ttl-edition" }).run();
  db.insert(schema.tracks).values({ id: "ctc-ttl-track", recordingId: "ctc-ttl-recording", title: "T.m4b", index: 0,
    duration: 120, chapters: [], source: audio, sourceType: "local" }).run();
  let batchHits = 0;
  let refuseBatch = true;
  mockWorker(async (input, init) => {
    const url = String(input);
    const request = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/anchor-batch")) {
      batchHits++;
      if (refuseBatch) return new Response("missing", { status: 404 });
      return Response.json({ engine, outcome: "mapped", results: request.windows.map((window: { start: number }) => ({
        engine, outcome: "unsynced", match: null, start: window.start, text: "",
      })), stageTimings: {}, gpuUtilization: null });
    }
    if (url.endsWith("/anchor")) {
      return Response.json({ engine, outcome: "unsynced", match: null, start: request.start, text: "",
        stageTimings: {}, gpuUtilization: null });
    }
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", stageTimings: { ctcPath: 0.5 }, elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  }, { anchorReady: false, anchorBatch: true });

  async function runOne() {
    const created = await createAlignment("ctc-ttl-ebook", "ctc-ttl-recording", undefined, "anchored");
    let job = alignmentJob(created.id);
    for (let i = 0; i < 400 && !["partial", "ready", "error"].includes(job.status); i++) {
      if (job.status === "queued") void processAlignments();
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = alignmentJob(created.id);
    }
    assert.equal(job.status, "partial", job.error ?? undefined);
    return job;
  }

  await runOne();
  assert.equal(batchHits, 1, "first job probes /anchor-batch once then falls back");
  await runOne();
  assert.equal(batchHits, 1, "negative cache must suppress /anchor-batch within TTL");
  now += 10 * 60 * 1000 + 1;
  refuseBatch = false;
  await runOne();
  assert.ok(batchHits >= 2, "after TTL the server must try /anchor-batch again");
  const afterTrue = batchHits;
  await runOne();
  assert.ok(batchHits > afterTrue, "cached true must keep using /anchor-batch");
  setAnchorBatchClockForTests(null);
  resetAnchorBatchSupportForTests();
});

test("historical Earth Awakens batch samples advance to anchored alignment", async () => {
  resetAnchorBatchSupportForTests();
  resetAlignmentPoolCoordinator([
    { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://ctc-worker.test" },
  ]);
  setAlignmentPoolDepsForTests(testPoolDeps);
  resetAlignmentRunnerForTests();
  const fixture = JSON.parse(readFileSync(new URL("./earth-awakens-ctc-samples.json", import.meta.url), "utf8")) as {
    tracks: { id: string; duration: number }[];
    samples: { trackId: string; time: number; duration: number; spokenWords?: number; match: { fragment: number; score: number; start: number } | null }[];
  };
  assert.equal(fixture.samples.length, 103);
  assert.equal(fixture.samples.filter((sample) => sample.match).length, 98);
  const file = join(process.env.MEDIA_ROOT!, "earth-sample-book.epub");
  writeFileSync(file, await readerFixture());
  db.insert(schema.ebookEditions).values({ id: "ctc-earth-ebook", workId: "ctc-work", format: "epub", source: file }).run();
  const book = await extractBook("ctc-earth-ebook");
  const count = book.sections.flatMap((section) => section.paragraphs).length;
  const maxFragment = Math.max(...fixture.samples.flatMap((sample) => sample.match ? [sample.match.fragment] : []));
  db.insert(schema.editions).values({ id: "ctc-earth-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "ctc-earth-recording", editionId: "ctc-earth-edition" }).run();
  for (const [index, track] of fixture.tracks.entries())
    db.insert(schema.tracks).values({ id: track.id, recordingId: "ctc-earth-recording", title: track.id, index,
      duration: track.duration, chapters: [], source: audio, sourceType: "local" }).run();
  let batchSamples = 0;
  mockWorker(async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor-batch")) {
      batchSamples += request.windows.length;
      return Response.json({ engine, outcome: "mapped", results: request.windows.map((window: { start: number }) => {
        const sample = fixture.samples.find((item) => item.trackId === request.trackId && item.time === window.start);
        const match = sample?.match;
        // Compress the historical paragraph indices to fit the generated test EPUB.
        return { engine, outcome: match ? "mapped" : "unsynced", start: match?.start ?? window.start,
          match: match ? { index: Math.floor(match.fragment * (count - 1) / maxFragment), score: match.score } : null,
          text: "word ".repeat(sample?.spokenWords ?? 0) };
      }) });
    }
    assert.ok(String(input).endsWith("/align"));
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  }, { anchorReady: false, anchorBatch: true });
  const created = await createAlignment("ctc-earth-ebook", "ctc-earth-recording", undefined, "anchored");
  let job = alignmentJob(created.id);
  for (let i = 0; i < 1000 && !["partial", "ready", "error"].includes(job.status); i++) {
    if (job.status === "queued") void processAlignments();
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = alignmentJob(created.id);
  }
  assert.ok(batchSamples >= 103);
  assert.ok(job.anchoring!.anchors.length >= 30, `selected ${job.anchoring!.anchors.length} anchors`);
  assert.ok(job.intervals.length > 0, job.error ?? "expected aligned intervals");
});

test("file lengths learned after an anchored job starts are used to choose anchors", async () => {
  // Streamed releases start with zero-length tracks; each length is only known
  // once its server copy finishes, which may be after the job has started.
  resetAnchorBatchSupportForTests();
  resetAlignmentPoolCoordinator([
    { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://ctc-worker.test" },
  ]);
  setAlignmentPoolDepsForTests(testPoolDeps);
  resetAlignmentRunnerForTests();
  const pause = await import("../server/activity-pause.ts");
  const perTrack = 40, trackCount = 8;
  const sentence = (i: number) => `<p>Sentence ${i} tells part ${i} of the story.</p>`;
  const half = (perTrack * trackCount) / 2;
  const file = join(process.env.MEDIA_ROOT!, "late-lengths.epub");
  writeFileSync(file, await readerFixture({ bodies: [
    Array.from({ length: half }, (_, i) => sentence(i)).join(""),
    Array.from({ length: half }, (_, i) => sentence(half + i)).join(""),
  ] }));
  db.insert(schema.ebookEditions).values({ id: "ctc-late-ebook", workId: "ctc-work", format: "epub", source: file }).run();
  const book = await extractBook("ctc-late-ebook");
  const paragraphs = book.sections.flatMap((section) => section.paragraphs);
  const first = paragraphs.findIndex((paragraph) => paragraph.text.startsWith("Sentence 0 "));
  const spoken = (local: number) => 30 + local * 5;
  const duration = spoken(perTrack) + 20;
  db.insert(schema.editions).values({ id: "ctc-late-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "ctc-late-recording", editionId: "ctc-late-edition" }).run();
  const ids = Array.from({ length: trackCount }, (_, i) => `ctc-late-track-${i}`);
  for (const [index, id] of ids.entries())
    db.insert(schema.tracks).values({ id, recordingId: "ctc-late-recording", title: id, index,
      duration, chapters: [], source: audio, sourceType: "local" }).run();
  const setLengths = (value: number) => {
    for (const id of ids.slice(1))
      db.update(schema.tracks).set({ duration: value }).where(eq(schema.tracks.id, id)).run();
  };
  let restored = false;
  mockWorker(async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      if (!restored) {
        restored = true;
        setLengths(duration); // the server copies finish while sampling runs
      }
      const track = ids.indexOf(request.trackId);
      const local = Math.max(0, Math.ceil((request.start - 30) / 5));
      if (local >= perTrack || spoken(local) > request.start + request.duration - 3)
        return Response.json({ engine, outcome: "unsynced", match: null, start: request.start, text: "" });
      return Response.json({ engine, outcome: "mapped", start: spoken(local),
        match: { index: first + track * perTrack + local, score: 0.9 }, text: "word ".repeat(40) });
    }
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  }, { anchorReady: false });
  pause.setPaused("alignment", true);
  const created = await createAlignment("ctc-late-ebook", "ctc-late-recording", undefined, "anchored");
  assert.ok(created.anchoring!.samples.length >= trackCount * 3, "samples cover every file");
  setLengths(0); // when the job starts, only the first file's length is known
  pause.setPaused("alignment", false);
  let job = alignmentJob(created.id);
  for (let i = 0; i < 1000 && !(job.anchoring?.stage === "done" || job.status === "error"); i++) {
    if (job.status === "queued") void processAlignments();
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = alignmentJob(created.id);
  }
  assert.ok(restored);
  assert.notEqual(job.outcome, "unsynced", job.warning ?? undefined);
  const anchoredTracks = new Set(job.anchoring!.anchors.map((anchor) => anchor.trackId));
  assert.equal(anchoredTracks.size, trackCount, `anchors in ${anchoredTracks.size} of ${trackCount} files`);
  assert.ok(job.intervals.length > 0);
});

test("files with no length when an anchored job is created are sampled once their length is known", async () => {
  resetAnchorBatchSupportForTests();
  resetAlignmentPoolCoordinator([
    { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://ctc-worker.test" },
  ]);
  setAlignmentPoolDepsForTests(testPoolDeps);
  resetAlignmentRunnerForTests();
  const pause = await import("../server/activity-pause.ts");
  const perTrack = 40, trackCount = 4;
  const sentence = (i: number) => `<p>Line ${i} carries part ${i} of the tale.</p>`;
  const half = (perTrack * trackCount) / 2;
  const file = join(process.env.MEDIA_ROOT!, "unknown-lengths.epub");
  writeFileSync(file, await readerFixture({ bodies: [
    Array.from({ length: half }, (_, i) => sentence(i)).join(""),
    Array.from({ length: half }, (_, i) => sentence(half + i)).join(""),
  ] }));
  db.insert(schema.ebookEditions).values({ id: "ctc-unknown-ebook", workId: "ctc-work", format: "epub", source: file }).run();
  const book = await extractBook("ctc-unknown-ebook");
  const first = book.sections.flatMap((section) => section.paragraphs)
    .findIndex((paragraph) => paragraph.text.startsWith("Line 0 "));
  const spoken = (local: number) => 30 + local * 5;
  const duration = spoken(perTrack) + 20;
  db.insert(schema.editions).values({ id: "ctc-unknown-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: "ctc-unknown-recording", editionId: "ctc-unknown-edition" }).run();
  const ids = Array.from({ length: trackCount }, (_, i) => `ctc-unknown-track-${i}`);
  for (const [index, id] of ids.entries())
    db.insert(schema.tracks).values({ id, recordingId: "ctc-unknown-recording", title: id, index,
      duration: index === 0 ? duration : 0, chapters: [], source: audio, sourceType: "local" }).run();
  mockWorker(async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      const track = ids.indexOf(request.trackId);
      const local = Math.max(0, Math.ceil((request.start - 30) / 5));
      if (local >= perTrack || spoken(local) > request.start + request.duration - 3)
        return Response.json({ engine, outcome: "unsynced", match: null, start: request.start, text: "" });
      return Response.json({ engine, outcome: "mapped", start: spoken(local),
        match: { index: first + track * perTrack + local, score: 0.9 }, text: "word ".repeat(40) });
    }
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  }, { anchorReady: false });
  pause.setPaused("alignment", true);
  const created = await createAlignment("ctc-unknown-ebook", "ctc-unknown-recording", undefined, "anchored");
  assert.deepEqual(new Set(created.anchoring!.samples.map((sample) => sample.trackId)), new Set([ids[0]]));
  for (const id of ids) // the server copies finish before the job runs
    db.update(schema.tracks).set({ duration }).where(eq(schema.tracks.id, id)).run();
  pause.setPaused("alignment", false);
  let job = alignmentJob(created.id);
  for (let i = 0; i < 1000 && !(job.anchoring?.stage === "done" || job.status === "error"); i++) {
    if (job.status === "queued") void processAlignments();
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = alignmentJob(created.id);
  }
  const anchoredTracks = new Set(job.anchoring!.anchors.map((anchor) => anchor.trackId));
  assert.equal(anchoredTracks.size, trackCount, `anchors in ${anchoredTracks.size} of ${trackCount} files`);
  assert.ok(job.intervals.length > 0);
});
