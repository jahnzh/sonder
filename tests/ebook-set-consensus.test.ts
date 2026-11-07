import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AlignmentInterval, ReaderBook } from "../src/reading-types.ts";

// Env before any server import: storage.ts / db.ts capture MEDIA_ROOT and DATA_DIR at load (#214).
const temp = mkdtempSync(join(tmpdir(), "sonder-ebook-set-consensus-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const {
  buildConsensusRows,
  consensusEbookId,
  consensusFingerprint,
  consensusIndexFromParagraphId,
  consensusParagraphId,
  MIN_CONSENSUS_SENTENCE_WORDS,
  pickDefaultEbookId,
  projectIntervals,
  publishProjectedMaps,
  syncEbookSetConsensus,
} = await import("../server/ebook-set-consensus.ts");
const { createAlignment } = await import("../server/alignment.ts");
const { listEbooks } = await import("../server/ebooks.ts");
const { createApp } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { evaluateEbookSetMember, setEbookSetDeps, resetEbookSetDeps } =
  await import("../server/ebook-set.ts");
const { putAlignmentJob } = await import("../server/alignment.ts");
const { readerFixture } = await import("./reader-fixture.ts");

const app = await createApp();

after(() => {
  resetEbookSetDeps();
  rmSync(temp, { recursive: true, force: true });
});

test("buildConsensusRows keeps short sentences and merges editions", () => {
  assert.equal(MIN_CONSENSUS_SENTENCE_WORDS, 1);
  const rows = buildConsensusRows([
    [
      { norm: "i see.", text: "I see.", paragraphId: "0:0", section: 0 },
      { norm: "then we go.", text: "Then we go.", paragraphId: "0:1", section: 0 },
    ],
    [
      { norm: "i see.", text: "I see!", paragraphId: "0:0", section: 0 },
      { norm: "then we go.", text: "Then we go.", paragraphId: "0:1", section: 0 },
    ],
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].norm, "i see.");
  assert.equal(rows[0].memberParagraphIds.join(","), "0:0,0:0");
});

test("buildConsensusRows aligns long parallel lists without quadratic traceback cost", () => {
  const sentence = (index: number) => ({
    norm: `word ${index}.`,
    text: `Word ${index}.`,
    paragraphId: `0:${index}`,
    section: 0,
  });
  const size = 6000;
  const left = Array.from({ length: size }, (_, index) => sentence(index));
  const right = Array.from({ length: size }, (_, index) => sentence(index));
  const started = performance.now();
  const rows = buildConsensusRows([left, right]);
  assert.equal(rows.length, size);
  assert.ok(performance.now() - started < 8000);
  assert.equal(rows[0].memberParagraphIds.join(","), "0:0,0:0");
});

test("pickDefaultEbookId prefers coverage then shared-sentence fraction", () => {
  const members = [
    {
      ebookId: "a",
      status: "accepted" as const,
      evidence: {
        sharedSentenceCount: 80,
        uniqueSentenceCount: 5,
        audioSupportedCoverage: 0.6,
        outlier: { passed: true, reason: "ok" as const, spokenSampleCount: 4, matchedSampleCount: 4, anchorCount: 4, forwardOrder: true, samples: [] },
        language: "eng",
        byteSize: 1,
      },
    },
    {
      ebookId: "b",
      status: "accepted" as const,
      evidence: {
        sharedSentenceCount: 95,
        uniqueSentenceCount: 2,
        audioSupportedCoverage: 0.6,
        outlier: { passed: true, reason: "ok" as const, spokenSampleCount: 4, matchedSampleCount: 4, anchorCount: 4, forwardOrder: true, samples: [] },
        language: "eng",
        byteSize: 1,
      },
    },
  ];
  assert.equal(
    pickDefaultEbookId({ members, consensusSentenceCount: 100, override: null }),
    "b",
  );
  assert.equal(
    pickDefaultEbookId({ members, consensusSentenceCount: 100, override: "a" }),
    "a",
  );
});

test("projectIntervals maps consensus timings onto a member paragraph", () => {
  const memberBook = {
    sections: [
      {
        index: 0,
        paragraphs: [{ id: "0:1", text: "Then we go.", blockIndex: 0, start: 0, end: 12 }],
      },
    ],
  } as ReaderBook;
  const consensus: AlignmentInterval[] = [
    {
      paragraphId: consensusParagraphId(1),
      section: 0,
      trackId: "t1",
      start: 12,
      end: 15,
      confidence: 0.7,
    },
  ];
  const projected = projectIntervals(
    consensus,
    [null, "0:1"],
    memberBook,
  );
  assert.equal(projected.length, 1);
  assert.equal(projected[0].paragraphId, "0:1");
  assert.equal(projected[0].start, 12);
  assert.equal(consensusIndexFromParagraphId("0:5"), 5);
  assert.equal(
    consensusFingerprint(["I see.", "Then we go."]),
    consensusFingerprint(["I see.", "Then we go."]),
  );
});
function seedWork(title: string, author: string) {
  const workId = `work-${randomUUID()}`;
  db.insert(schema.works)
    .values({
      id: workId,
      title,
      author,
      description: "",
      genre: "Fiction",
      year: 2020,
    })
    .run();
  return workId;
}

async function seedEpub(workId: string, ebookId: string) {
  const dir = join(temp, "media", "ebooks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${ebookId}.epub`);
  writeFileSync(path, await readerFixture({ script: true }));
  db.insert(schema.ebookEditions)
    .values({ id: ebookId, workId, format: "epub", source: path })
    .run();
  return path;
}

function seedRecording(workId: string, recordingId: string, audioPath: string) {
  const editionId = `edition-${workId}`;
  db.insert(schema.editions)
    .values({
      id: editionId,
      workId,
      cover: "/covers/meditations.svg",
      narrator: "Narrator",
      rating: 0,
      sourceLabel: "Test",
    })
    .run();
  db.insert(schema.recordings)
    .values({ id: recordingId, editionId })
    .run();
  db.insert(schema.tracks)
    .values({
      id: randomUUID(),
      recordingId,
      title: "Chapter",
      index: 0,
      duration: 3600,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
}

function seedChapteredRecording(
  workId: string,
  recordingId: string,
  audioPath: string,
) {
  const editionId = `edition-ch-${workId}`;
  db.insert(schema.editions)
    .values({
      id: editionId,
      workId,
      cover: "/covers/meditations.svg",
      narrator: "Narrator",
      rating: 0,
      sourceLabel: "Test",
    })
    .run();
  db.insert(schema.recordings)
    .values({ id: recordingId, editionId })
    .run();
  db.insert(schema.tracks)
    .values({
      id: randomUUID(),
      recordingId,
      title: "Full book",
      index: 0,
      duration: 7200,
      chapters: [{ title: "Chapter 1", start: 0, end: 3600 }],
      source: audioPath,
      sourceType: "local",
    })
    .run();
}

test("createAlignment anchored mode accepts chaptered recordings for consensus ebook", async () => {
  const workId = seedWork("Chaptered Audio", "Ada Author");
  const ebookId = `ebook-${randomUUID()}`;
  await seedEpub(workId, ebookId);
  const audio = join(temp, "media", "chaptered-audio.mp3");
  writeFileSync(audio, "audio");
  const recordingId = `rec-ch-${randomUUID()}`;
  seedChapteredRecording(workId, recordingId, audio);
  let fragment = 0;
  setEbookSetDeps({
    anchorSample: async ({ start }) => {
      const step = fragment;
      fragment += 4;
      return {
        spokenWords: 40,
        match: { fragment: step, score: 0.85, start: start + 1 },
      };
    },
  });
  await evaluateEbookSetMember(workId, ebookId);
  await syncEbookSetConsensus(workId);
  const job = await createAlignment(
    consensusEbookId(workId),
    recordingId,
    undefined,
    "anchored",
    "backfill",
  );
  assert.equal(job.mode, "anchored");
  assert.equal(job.ebookId, consensusEbookId(workId));
});

test("consensus ebook ids are omitted from library listing and file download", async () => {
  const workId = seedWork("Hidden Consensus", "Bob Author");
  const ebookId = `ebook-${randomUUID()}`;
  await seedEpub(workId, ebookId);
  const audio = join(temp, "media", "hidden-consensus-audio.mp3");
  writeFileSync(audio, "audio");
  seedRecording(workId, `rec-${randomUUID()}`, audio);
  let fragment = 0;
  setEbookSetDeps({
    anchorSample: async ({ start }) => {
      const step = fragment;
      fragment += 4;
      return {
        spokenWords: 40,
        match: { fragment: step, score: 0.85, start: start + 1 },
      };
    },
  });
  await evaluateEbookSetMember(workId, ebookId);
  const consensusId = consensusEbookId(workId);
  assert.ok(!listEbooks().some((row) => row.id === consensusId));
  const row = db
    .select()
    .from(schema.ebookEditions)
    .where(eq(schema.ebookEditions.id, consensusId))
    .get();
  assert.ok(row);
  assert.equal(row.source, `consensus:${workId}`);
  const file = await app.inject(`/api/ebooks/${encodeURIComponent(consensusId)}/file`);
  assert.equal(file.statusCode, 404);
});

test("accepted members get projected maps and default EPUB via API", async () => {
  const workId = seedWork("Consensus Book", "Eve Author");
  const ebookA = `ebook-a-${randomUUID()}`;
  const ebookB = `ebook-b-${randomUUID()}`;
  await seedEpub(workId, ebookA);
  await seedEpub(workId, ebookB);
  const audio = join(temp, "media", "consensus-audio.mp3");
  mkdirSync(join(temp, "media"), { recursive: true });
  writeFileSync(audio, "audio");
  const recordingId = `rec-${randomUUID()}`;
  seedRecording(workId, recordingId, audio);
  let fragment = 0;
  setEbookSetDeps({
    anchorSample: async ({ start }) => {
      const step = fragment;
      fragment += 4;
      return {
        spokenWords: 40,
        match: { fragment: step, score: 0.85, start: start + 1 },
      };
    },
  });
  await evaluateEbookSetMember(workId, ebookA, { sourceTitle: "Edition A" });
  await evaluateEbookSetMember(workId, ebookB, { sourceTitle: "Edition B" });
  const view = await app.inject(`/api/works/${workId}/ebook-set`);
  assert.equal(view.statusCode, 200, view.body);
  const payload = view.json();
  assert.equal(payload.members.filter((m: { status: string }) => m.status === "accepted").length, 2);
  assert.ok(payload.defaultEbookId);
  assert.ok(payload.consensus?.sentenceCount > 0);

  const consensusJobId = payload.consensus.jobId as string;
  assert.ok(consensusJobId);
  const trackId = (
    db.select().from(schema.tracks).all()[0] as { id: string }
  ).id;
  const consensusJob = {
    id: consensusJobId,
    generation: "gen-test",
    ebookId: `set-consensus:${workId}`,
    recordingId,
    status: "partial" as const,
    progress: 1,
    engine: "test",
    outcome: "partial" as const,
    stageTimings: { alignment: 2.5 },
    error: null,
    warning: null,
    intervals: [
      {
        paragraphId: consensusParagraphId(0),
        section: 0,
        trackId,
        start: 1,
        end: 4,
        confidence: 0.7,
      },
    ],
    sectionsDone: [],
    elapsedSeconds: 1,
    fingerprint: payload.consensus.fingerprint,
    audioFingerprint: "audio-test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    coverage: 0.5,
    pairings: [],
    mode: "anchored" as const,
  };
  putAlignmentJob(consensusJob);
  await publishProjectedMaps(workId, consensusJob);

  const maps = await app.inject(
    `/api/alignments?ebookId=${encodeURIComponent(ebookA)}&summary=1`,
  );
  assert.equal(maps.statusCode, 200, maps.body);
  const jobs = maps.json().jobs.filter(
    (job: { recordingId: string; origin?: string }) =>
      job.recordingId === recordingId && job.origin === "projected",
  );
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].intervalCount > 0);
  assert.equal(jobs[0].engine, "test");
  assert.equal(jobs[0].outcome, "partial");
  assert.deepEqual(jobs[0].stageTimings, { alignment: 2.5 });
  assert.deepEqual(jobs[0].sectionsDone, [0]);

  const override = await app.inject({
    method: "PATCH",
    url: `/api/works/${workId}/ebook-set/default`,
    payload: { ebookId: ebookB },
  });
  assert.equal(override.statusCode, 200, override.body);
  assert.equal(override.json().defaultEbookId, ebookB);
  assert.equal(override.json().defaultEbookOverride, ebookB);
});

test("a projected map replaces a cancelled prepare of the same ebook instead of failing silently", async () => {
  const workId = seedWork("Cancelled Slot", "Hana Author");
  const ebookA = `ebook-a-${randomUUID()}`;
  const ebookB = `ebook-b-${randomUUID()}`;
  await seedEpub(workId, ebookA);
  await seedEpub(workId, ebookB);
  const audio = join(temp, "media", "cancelled-slot-audio.mp3");
  mkdirSync(join(temp, "media"), { recursive: true });
  writeFileSync(audio, "audio");
  const recordingId = `rec-${randomUUID()}`;
  seedRecording(workId, recordingId, audio);
  let fragment = 0;
  setEbookSetDeps({
    anchorSample: async ({ start }) => {
      const step = fragment;
      fragment += 4;
      return { spokenWords: 40, match: { fragment: step, score: 0.85, start: start + 1 } };
    },
  });
  await evaluateEbookSetMember(workId, ebookA, { sourceTitle: "Edition A" });
  await evaluateEbookSetMember(workId, ebookB, { sourceTitle: "Edition B" });
  const payload = (await app.inject(`/api/works/${workId}/ebook-set`)).json();
  const trackId = (db.select().from(schema.tracks).all()[0] as { id: string }).id;
  const base = {
    generation: "gen-test",
    recordingId,
    progress: 1,
    engine: "test",
    error: null,
    warning: null,
    sectionsDone: [] as number[],
    elapsedSeconds: 1,
    fingerprint: "fp",
    audioFingerprint: "audio-test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    coverage: 0.5,
    pairings: [],
    mode: "anchored" as const,
  };
  // The member's own prepare was cancelled before the consensus finished.
  putAlignmentJob({ ...base, id: `cancelled-${randomUUID()}`, ebookId: ebookA, status: "cancelled" as const, intervals: [] });
  const consensusJob = {
    ...base,
    id: payload.consensus.jobId as string,
    ebookId: `set-consensus:${workId}`,
    status: "partial" as const,
    outcome: "partial" as const,
    fingerprint: payload.consensus.fingerprint,
    intervals: [
      { paragraphId: consensusParagraphId(0), section: 0, trackId, start: 1, end: 4, confidence: 0.7 },
    ],
  };
  putAlignmentJob(consensusJob);
  await publishProjectedMaps(workId, consensusJob);

  const maps = await app.inject(`/api/alignments?ebookId=${encodeURIComponent(ebookA)}&summary=1`);
  const jobs = maps.json().jobs.filter((job: { recordingId: string }) => job.recordingId === recordingId);
  assert.equal(jobs.length, 1, JSON.stringify(jobs.map((job: { status: string; origin?: string }) => [job.status, job.origin])));
  assert.equal(jobs[0].origin, "projected");
  assert.ok(jobs[0].intervalCount > 0);
});

test("explicit pairings supersede an in-flight backfill and stay ahead of projections", async () => {
  const workId = seedWork("Prepare Wins", "Grace Author");
  const ebookId = `ebook-prep-${randomUUID()}`;
  await seedEpub(workId, ebookId);
  const audio = join(temp, "media", "prepare-wins.mp3");
  writeFileSync(audio, "audio");
  const recordingId = `rec-prep-${randomUUID()}`;
  seedRecording(workId, recordingId, audio);
  const trackId = (
    db.select().from(schema.tracks).all().find((row: { recordingId: string }) => row.recordingId === recordingId) as {
      id: string;
    }
  ).id;

  const backfill = await createAlignment(
    ebookId,
    recordingId,
    undefined,
    "anchored",
    "backfill",
  );
  assert.equal(backfill.status, "queued");
  assert.equal(backfill.mode, "anchored");
  const backfillGeneration = backfill.generation;

  const prepared = await createAlignment(ebookId, recordingId, [
    { section: 0, trackId, start: 0, duration: 95 },
  ]);
  assert.equal(prepared.id, backfill.id);
  assert.notEqual(prepared.generation, backfillGeneration);
  assert.equal(prepared.pairings.length, 1);
  assert.equal(prepared.mode, undefined);
  assert.equal(prepared.origin, undefined);

  // Install a real consensus projection so the prepared-map guard is exercised.
  db.insert(schema.workEbookSetMembers).values({workId, ebookId, status: "accepted", updatedAt: Date.now()}).run();
  db.insert(schema.workEbookSet).values({workId, consensusFingerprint: "fp", consensusSentences: '["first"]', projections: JSON.stringify({[ebookId]: ["0:0"]}), recordingId, consensusJobId: "consensus-unused", updatedAt: Date.now()}).run();
  // Projected publish must not replace a prepared map for the same pair.
  await publishProjectedMaps(workId, {
    id: "consensus-unused",
    generation: "g",
    ebookId: `set-consensus:${workId}`,
    recordingId,
    status: "ready",
    progress: 1,
    engine: "test",
    error: null,
    warning: null,
    intervals: [
      {
        paragraphId: consensusParagraphId(0),
        section: 0,
        trackId,
        start: 1,
        end: 2,
        confidence: 1,
      },
    ],
    sectionsDone: [],
    elapsedSeconds: 1,
    fingerprint: "fp",
    audioFingerprint: "audio",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    coverage: 1,
    pairings: [],
    mode: "anchored",
  });

  const listed = await app.inject(
    `/api/alignments?ebookId=${encodeURIComponent(ebookId)}`,
  );
  assert.equal(listed.statusCode, 200, listed.body);
  const jobs = listed.json().jobs.filter(
    (job: { recordingId: string }) => job.recordingId === recordingId,
  );
  assert.equal(jobs.length, 1);
  assert.notEqual(jobs[0].origin, "projected");
  assert.equal(jobs[0].pairings.length, 1);
});

test("syncEbookSetConsensus skips audio realign when consensus text is unchanged", async () => {
  const workId = seedWork("Stable Book", "Finn Author");
  const ebookId = `ebook-${randomUUID()}`;
  await seedEpub(workId, ebookId);
  const audio = join(temp, "media", "stable-audio.mp3");
  writeFileSync(audio, "audio");
  seedRecording(workId, `rec-${randomUUID()}`, audio);
  setEbookSetDeps({
    anchorSample: async ({ start }) => ({
      spokenWords: 40,
      match: { fragment: 0, score: 0.85, start: start + 1 },
    }),
  });
  await evaluateEbookSetMember(workId, ebookId);
  const first = await syncEbookSetConsensus(workId);
  const second = await syncEbookSetConsensus(workId);
  assert.equal(first.consensus?.fingerprint, second.consensus?.fingerprint);
  assert.equal(first.consensus?.jobId, second.consensus?.jobId);
});

test("server handles another request during a build and rejects changed members", async () => {
  const { monitorEventLoopDelay } = await import("node:perf_hooks");
  const { extractBook } = await import("../server/reader.ts");
  const workId = seedWork("Concurrent build", "Test Author");
  const bodies: [string, string] = [Array.from({length: 6000}, (_, i) => `<p>Sentence ${i} ends here.</p>`).join(""), "<p>Last sentence.</p>"];
  const content = await readerFixture({ bodies });
  const ids = [randomUUID(), randomUUID()];
  const dir = join(temp, "media", "ebooks");
  mkdirSync(dir, {recursive: true});
  for (const id of ids) {
    const path = join(dir, `${id}.epub`);
    writeFileSync(path, content);
    db.insert(schema.ebookEditions).values({id, workId, format: "epub", source: path}).run();
    db.insert(schema.workEbookSetMembers).values({workId, ebookId: id, status: "accepted", evidence: JSON.stringify({sharedSentenceCount: 1, audioSupportedCoverage: null}), updatedAt: Date.now()}).run();
    await extractBook(id);
  }
  const audio = join(temp, "media", `${workId}.mp3`);
  writeFileSync(audio, "audio");
  seedRecording(workId, `rec-${workId}`, audio);
  db.insert(schema.workEbookSet).values({workId, consensusFingerprint: "old", consensusSentences: '["old"]', projections: '{}', updatedAt: Date.now()}).run();
  const delay = monitorEventLoopDelay({resolution: 10});
  delay.enable();
  let finished = false;
  const started = performance.now();
  const building = syncEbookSetConsensus(workId).finally(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const requestStarted = performance.now();
  const response = await app.inject(`/api/works/${workId}/ebook-set`);
  const latency = performance.now() - requestStarted;
  assert.equal(response.statusCode, 200);
  assert.equal(finished, false, "request should finish before the worker build");
  db.update(schema.workEbookSetMembers).set({status: "rejected"}).where(eq(schema.workEbookSetMembers.ebookId, ids[1])).run();
  await building;
  delay.disable();
  const state = db.select().from(schema.workEbookSet).where(eq(schema.workEbookSet.workId, workId)).get();
  assert.equal(state?.consensusFingerprint, "old");
  db.update(schema.workEbookSetMembers).set({status: "accepted"}).where(eq(schema.workEbookSetMembers.ebookId, ids[1])).run();
  const audioBuild = syncEbookSetConsensus(workId);
  await new Promise<void>(resolve => setImmediate(resolve));
  writeFileSync(audio, "changed audio");
  await audioBuild;
  assert.equal(db.select().from(schema.workEbookSet).where(eq(schema.workEbookSet.workId, workId)).get()?.consensusFingerprint, "old");
  console.log(`consensus server probe: total=${(performance.now()-started).toFixed(1)}ms request=${latency.toFixed(1)}ms event-loop-max=${(delay.max/1e6).toFixed(1)}ms`);
});
