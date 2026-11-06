import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerFixture } from "./reader-fixture.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-ctc-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.ALIGNMENT_CHAPTER_ENGINE; // CTC is the default chapter engine
process.env.ALIGNMENT_WORKER_URL = "http://ctc-worker.test";
process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
const audio = join(process.env.MEDIA_ROOT, "audio.wav");
const ebook = join(process.env.MEDIA_ROOT, "book.epub");
writeFileSync(audio, "test audio");
writeFileSync(ebook, await readerFixture({ bodies: ["<p>First sentence. Another sentence.</p>", "<p>Middle sentence. Last sentence.</p>"] }));

const { db, sqlite } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { extractBook } = await import("../server/reader.ts");
const { createAlignment, alignmentJob, stopAlignments } = await import("../server/alignment.ts");
const originalFetch = globalThis.fetch;
const engine = "ctc-wav2vec2-base-960h-torchaudio-2.8-v1";
db.insert(schema.works).values({ id: "ctc-work", title: "Book", author: "Author", description: "", genre: "", year: 2026 }).run();
db.insert(schema.editions).values({ id: "ctc-edition", workId: "ctc-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
db.insert(schema.recordings).values({ id: "ctc-recording", editionId: "ctc-edition" }).run();
db.insert(schema.tracks).values({ id: "ctc-track", recordingId: "ctc-recording", title: "Book", index: 0, duration: 400, chapters: [], source: audio, sourceType: "local" }).run();
db.insert(schema.ebookEditions).values({ id: "ctc-ebook", workId: "ctc-work", format: "epub", source: ebook }).run();

after(() => {
  globalThis.fetch = originalFetch;
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
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://ctc-worker.test/align");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.engine, "ctc");
    starts.push(request.start);
    return Response.json({ engine, outcome: "mapped", stageTimings: { acousticEncoding: 0.5, ctcPath: 0.25 }, elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i, end: request.start + i + 0.8 })) });
  };
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
  globalThis.fetch = async () => Response.json({ engine: "aeneas-1.7.3", elapsedSeconds: 1,
    intervals: [{ index: 0, start: 10, end: 11 }] });
  const retried = await createAlignment("ctc-ebook", "ctc-recording", pairings, "chapters");
  const failed = await settled(retried.id);
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /did not use the requested CTC engine/);
  assert.equal(failed.intervals.length, 0);

  // The rollback switch sends new chapter jobs back to aeneas, and the worker is then asked for aeneas.
  process.env.ALIGNMENT_CHAPTER_ENGINE = "aeneas";
  const requested: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    requested.push(request.engine);
    return Response.json({ engine: "aeneas-1.7.3", elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i, end: request.start + i + 0.8 })) });
  };
  const rolledBack = await createAlignment("ctc-ebook", "ctc-recording", pairings, "chapters");
  assert.equal(rolledBack.engine, "aeneas-1.7.3");
  const rolledBackJob = await settled(rolledBack.id);
  assert.equal(rolledBackJob.status, "partial", rolledBackJob.error ?? undefined);
  assert.ok(requested.length > 0 && requested.every((engine) => engine === undefined));
  delete process.env.ALIGNMENT_CHAPTER_ENGINE;

  // Anchored jobs also default to CTC for their alignment windows.
  delete process.env.ALIGNMENT_WORKER_URL;
  const anchored = await createAlignment("ctc-ebook", "ctc-recording", undefined, "anchored");
  assert.equal(anchored.mode, "anchored");
  assert.equal(anchored.engine, engine);
});

test("an anchored job aligns its windows with CTC and keeps its CTC identity through speech recovery", async () => {
  process.env.ALIGNMENT_WORKER_URL = "http://ctc-worker.test";
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
  globalThis.fetch = async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      const index = Math.max(0, Math.ceil((request.start - 30) / 5));
      if (index >= paragraphs.length || spoken(index) > request.start + request.duration - 3)
        return Response.json({ engine: "aeneas-1.7.3", outcome: "unsynced", stageTimings: { speechRecovery: 0.25 }, match: null, start: request.start, text: "" });
      return Response.json({ engine: "aeneas-1.7.3", outcome: "mapped", stageTimings: { speechRecovery: 0.25 },
        match: { index, score: 0.9, text: "" }, start: spoken(index), text: "word ".repeat(40) });
    }
    windowEngines.push(request.engine);
    const step = request.duration / request.fragments.length;
    return Response.json({ engine, outcome: "mapped", stageTimings: { ctcPath: 0.5 }, elapsedSeconds: 1,
      intervals: request.fragments.map((_: string, i: number) => ({ index: i, start: request.start + i * step, end: request.start + (i + 1) * step })) });
  };
  const created = await createAlignment("ctc-alice-ebook", "ctc-alice-recording", undefined, "anchored");
  assert.equal(created.mode, "anchored");
  assert.equal(created.engine, engine);
  let job = alignmentJob(created.id);
  for (let i = 0; i < 300 && !(job.anchoring?.stage === "done" || job.status === "error"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = alignmentJob(created.id);
  }
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.engine, engine, "speech-recovery replies must not rename a CTC job");
  assert.ok(windowEngines.length > 0 && windowEngines.every((value) => value === "ctc"));
  assert.equal(windowEngines.length, job.anchoring!.segments.length);
  assert.ok(job.stageTimings!.speechRecovery > 0 && job.stageTimings!.ctcPath > 0);
  assert.ok(["mapped", "partial"].includes(job.outcome!));
  assert.ok(job.intervals.length > 0);

  // A worker that answers a CTC window with another engine is refused, not published.
  globalThis.fetch = async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      const index = Math.max(0, Math.ceil((request.start - 30) / 5));
      if (index >= paragraphs.length || spoken(index) > request.start + request.duration - 3)
        return Response.json({ match: null, start: request.start, text: "" });
      return Response.json({ match: { index, score: 0.9, text: "" }, start: spoken(index), text: "word ".repeat(40) });
    }
    return Response.json({ engine: "aeneas-1.7.3", elapsedSeconds: 1, intervals: [{ index: 0, start: request.start, end: request.start + 1 }] });
  };
  const wrong = await createAlignment("ctc-alice-ebook", "ctc-alice-recording", undefined, "anchored");
  let refused = alignmentJob(wrong.id);
  for (let i = 0; i < 300 && refused.status !== "error"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    refused = alignmentJob(wrong.id);
  }
  assert.equal(refused.status, "error");
  assert.match(refused.error ?? "", /did not use the requested CTC engine/);
});
