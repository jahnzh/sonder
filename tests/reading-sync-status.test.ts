// The Reading sync card's progress line and pause labels (#404 follow-up): a whole-book job is described by the
// worker's stage and the one count that moves in it; a window-runner job keeps its line.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOK_ENGINE, bookWorkerJobId, type AlignmentJob } from "../src/reading-types.ts";
import { pauseLabel, pausedLabel, syncProgressLine } from "../src/reading-sync-status.ts";

// bookJobCounts is the server's reading of the worker's answer; its module chain opens the DB.
const temp = mkdtempSync(join(tmpdir(), "sonder-reading-sync-status-"));
process.env.DATA_DIR = join(temp, "data");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
const { bookJobCounts } = await import("../server/alignment-book-job.ts");
const { CTC_ENGINE } = await import("../server/alignment-engine.ts");
after(() => rmSync(temp, { recursive: true, force: true }));

/** A progress answer of a real worker, as docs/CTC_WORKER_POOL.md "Progress" records it. */
const realAnswer = {
  jobId: "m-lhod-1794710439", engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2",
  state: "encoding", recordingId: "lhod", createdAt: 1794710439.83, updatedAt: 1794710473.52,
  progress: { tracksTotal: 1, tracksDecoded: 1, tracksEncoded: 0, encodeQueuePosition: 0 },
  stageTimings: { identity: 0.39, decode: 33.29, encodeQueue: 0.00004 },
  error: null, resumed: 0,
};

const base = (patch: Partial<AlignmentJob> = {}): AlignmentJob =>
  ({
    id: "job-book", generation: "g-1", ebookId: "ebook", recordingId: "recording", status: "processing", progress: 0.2,
    engine: BOOK_ENGINE, error: null, warning: null, coverage: 0, intervals: [], sectionsDone: [], elapsedSeconds: 0,
    fingerprint: "", audioFingerprint: "", updatedAt: 1, createdAt: 1, mode: "anchored",
    // The plan a book job still carries from its start: the old line read "0 of 115 narration samples" from it.
    anchoring: { stage: "sampling", refinements: 0, anchors: [], segments: [], rate: 0, flags: [],
      samples: Array.from({ length: 115 }, (_, index) => ({ trackId: "t", time: index, duration: 1, done: false })) },
    pairings: Array.from({ length: 31 }, (_, section) => ({ section, trackId: "t", start: section, duration: 1 })),
    ...patch,
  }) as AlignmentJob;

/** A running book job whose worker reported this state and progress answer. */
const running = (state: string, progress: Record<string, unknown>, patch: Partial<AlignmentJob> = {}) => {
  const job = base(patch);
  job.bookJob = { id: bookWorkerJobId(job), hostId: "wsl", state, startedAt: 1,
    counts: bookJobCounts({ progress }) };
  return job;
};

test("a whole-book job's line is the worker's stage and the count that moves in it, for every stage", () => {
  const lines: [string, Record<string, unknown>, string][] = [
    ["queued", {}, "Waiting for other alignment work"],
    ["queued", { resumeQueuePosition: 2 }, "Waiting for other alignment work: 2 in line"],
    ["decoding", { tracksTotal: 43, tracksDecoded: 24, tracksEncoded: 0 }, "Decoding audio: 24 of 43 files"],
    ["encoding", { tracksTotal: 2, tracksDecoded: 2, tracksEncoded: 1, encodeQueuePosition: 0 }, "Encoding audio: 1 of 2 files"],
    ["encoding", { tracksTotal: 2, tracksDecoded: 2, tracksEncoded: 0, encodeQueuePosition: 2 }, "Waiting for other alignment work: 2 books ahead"],
    ["encoding", { tracksTotal: 2, tracksDecoded: 2, tracksEncoded: 0, encodeQueuePosition: 1 }, "Waiting for other alignment work: 1 book ahead"],
    ["encoding", { tracksTotal: 2, tracksEncoded: 1, encodeQueuePosition: 0, waitingForWindowRequests: true, gateWaitSeconds: 4.2 },
      "Waiting for other alignment work"],
    ["encoding", { tracksTotal: 2, tracksEncoded: 1, encodeQueuePosition: 0, waitingForWindowRequests: false }, "Encoding audio: 1 of 2 files"],
    ["anchoring", { tracksTotal: 2, tracksEncoded: 2 }, "Anchoring text to audio"],
    ["aligning", { tracksTotal: 2, tracksEncoded: 2, groupsTotal: 83, groupsDone: 34 }, "Aligning text: 34 of 83 parts"],
    ["finishing", { groupsTotal: 83, groupsDone: 83 }, "Finishing"],
    ["done", { groupsTotal: 83, groupsDone: 83 }, "Saving the map"],
    ["a-later-stage", {}, "Worker stage: a-later-stage"],
  ];
  for (const [state, progress, line] of lines) assert.equal(syncProgressLine(running(state, progress)), line, `${state} ${JSON.stringify(progress)}`);
  assert.equal(syncProgressLine(running(realAnswer.state, realAnswer.progress)), "Encoding audio: 0 of 1 file", "the real answer");
});

test("before the worker has the job, the line says where it waits, not samples or sections", () => {
  assert.equal(syncProgressLine(base({ status: "queued" })), "Waiting for an alignment worker");
  assert.equal(syncProgressLine(base({ status: "queued", mode: "chapters" })), "Waiting for an alignment worker", "chapter-paired");
  assert.equal(syncProgressLine(base({ status: "copying" })), "Copying audio");
  assert.equal(syncProgressLine(base()), "Starting on the alignment worker", "leasing and staging");
  const starting = base();
  starting.bookJob = { id: bookWorkerJobId(starting), hostId: "wsl", state: "starting", startedAt: 1 };
  assert.equal(syncProgressLine(starting), "Starting on the alignment worker");
  // After a Resume the stored worker job is the earlier generation's: it does not describe this run.
  const resumed = running("aligning", { groupsTotal: 83, groupsDone: 34 });
  resumed.generation = "g-2";
  assert.equal(syncProgressLine(resumed), "Starting on the alignment worker");
});

test("a stored book job of older code (no counts) shows its stage without numbers", () => {
  const job = base();
  job.bookJob = { id: bookWorkerJobId(job), hostId: "wsl", state: "decoding", startedAt: 1 };
  assert.equal(syncProgressLine(job), "Decoding audio");
  job.bookJob.state = "aligning";
  assert.equal(syncProgressLine(job), "Aligning text");
});

test("a whole-book job that stopped shows the share of text mapped", () => {
  assert.equal(syncProgressLine(base({ status: "partial", coverage: 0.874, anchoring: undefined })), "87% of text mapped");
  assert.equal(syncProgressLine(base({ status: "paused" })), "0% of text mapped");
});

test("a window-runner job keeps its line: sections, narration samples, passages", () => {
  assert.equal(syncProgressLine(base({ engine: CTC_ENGINE, status: "queued" })), "Locating text: 0 of 115 narration samples · 0% of text mapped");
  assert.equal(syncProgressLine(base({ engine: CTC_ENGINE, mode: "chapters", sectionsDone: [0, 1], coverage: 0.05 })),
    "2 of 31 sections · 5% of text mapped");
  const aligned = base({ engine: CTC_ENGINE, coverage: 0.5 });
  aligned.anchoring = { ...aligned.anchoring!, stage: "aligning", anchors: [{} as never, {} as never],
    segments: [{ done: true } as never, { done: false } as never] };
  assert.equal(syncProgressLine(aligned), "2 anchors · 1 of 2 passages aligned · 50% of text mapped");
});

test("the pause button and the paused heading name a whole-book job's immediate pause", () => {
  assert.equal(pauseLabel(base()), "Pause");
  assert.equal(pauseLabel(base({ engine: CTC_ENGINE })), "Pause after section");
  assert.equal(pauseLabel(undefined), "Pause after section");
  // A rebuild runs in the row of a kept map: the button acts on the rebuild, so its engine decides.
  const kept = base({ engine: CTC_ENGINE, status: "ready" });
  assert.equal(pauseLabel({ ...kept, rebuild: { status: "processing", progress: 0.1, engine: BOOK_ENGINE, error: null, updatedAt: 1 } }), "Pause");
  assert.equal(pauseLabel({ ...kept, rebuild: { status: "processing", progress: 0.1, engine: CTC_ENGINE, error: null, updatedAt: 1 } }), "Pause after section");
  assert.equal(pausedLabel(base({ status: "paused" })), "Paused");
  assert.equal(pausedLabel(base({ engine: CTC_ENGINE, status: "paused" })), "Paused after current section");
});

test("the server keeps only the counts the card shows, and only well-formed ones", () => {
  assert.deepEqual(bookJobCounts(realAnswer), { tracksTotal: 1, tracksDecoded: 1, tracksEncoded: 0, encodeQueuePosition: 0 });
  assert.deepEqual(bookJobCounts({ progress: { tracksTotal: 2, tracksDecoded: -1, groupsDone: 1.5, groupsTotal: "3",
    diskReservedBytes: 10, gateWaitSeconds: 3.5, waitingForWindowRequests: true } }), { tracksTotal: 2, waitingForWindowRequests: true });
  assert.deepEqual(bookJobCounts({ progress: null }), {});
});
