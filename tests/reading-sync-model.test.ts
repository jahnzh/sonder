// The Reading sync page's model (#540): every state of the page, every worker stage and count, the older engine's
// line, the 95% rule, someone who is not the administrator, and no connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readingSyncDetails,
  readingSyncPage,
  runPoint,
  stageName,
  whenLine,
  type ListedJob,
  type SyncPageFacts,
} from "../src/pages/reading-sync-model.ts";
import { BOOK_ENGINE, bookWorkerJobId } from "../src/reading-types.ts";
import type { ReadingSyncSummary } from "../src/types.ts";

const NOW = new Date(2026, 10, 17, 15, 0).getTime();
const AT = new Date(2026, 10, 17, 14, 2).getTime();

function job(status: ListedJob["status"], extra: Partial<ListedJob> = {}): ListedJob {
  return {
    id: "job-1",
    generation: "g1",
    status,
    progress: status === "ready" || status === "partial" ? 1 : 0.4,
    engine: BOOK_ENGINE,
    coverage: 0,
    error: null,
    warning: null,
    updatedAt: AT,
    elapsedSeconds: 38 * 60,
    ...extra,
  };
}
const worker = (state: string, counts: Record<string, unknown> = {}, hostId = "wsl") => ({
  id: bookWorkerJobId({ id: "job-1", generation: "g1" }),
  hostId,
  state,
  startedAt: 1,
  counts,
});
const page = (listed: ListedJob | null | undefined, facts: Partial<SyncPageFacts> = {}) =>
  readingSyncPage({ admin: true, job: listed, offline: false, stored: null, languageMatch: true, pool: null, now: NOW, ...facts });
const running = (model: ReturnType<typeof page>, block = 0) => model.blocks[block].steps?.find((step) => step.state === "running");
const STEPS = ["Waiting for a worker", "Copying audio", "Decoding audio", "Encoding audio", "Anchoring text to audio", "Aligning text", "Saving the map"];

test("preparing: the seven steps of the board, the running one with its count, Pause and Cancel, the caption's worker", () => {
  const model = page(job("processing", { ctcDevice: "cuda", elapsedSeconds: 12 * 60, bookJob: worker("encoding", { tracksTotal: 43, tracksDecoded: 43, tracksEncoded: 24 }) }));
  assert.equal(model.state, "preparing");
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0].caption, "Preparing");
  assert.equal(model.blocks[0].tip, "preparing");
  assert.equal(model.blocks[0].value, "On wsl · GPU · 12 min");
  assert.deepEqual(model.blocks[0].steps!.map((s) => s.label), STEPS);
  assert.deepEqual(model.blocks[0].steps!.map((s) => s.state), ["done", "done", "done", "running", "waiting", "waiting", "waiting"]);
  assert.deepEqual(running(model), { label: "Encoding audio", state: "running", value: "24 of 43 files", progress: 24 / 43 });
  assert.deepEqual(model.buttons, ["Pause", "Cancel"]);
  assert.equal(model.note, "Pause stops the worker. Resume starts this book over.");
  assert.equal(model.details, true);
  assert.equal(model.passages, null, "a running job has no passage list");
  assert.equal(model.prepareAgainRow, null);
});

test("every worker stage and count", () => {
  const at = (state: string, counts: Record<string, unknown> = {}) => running(page(job("processing", { bookJob: worker(state, counts) })));
  assert.deepEqual(at("decoding", { tracksTotal: 43, tracksDecoded: 10 }), { label: "Decoding audio", state: "running", value: "10 of 43 files", progress: 10 / 43 });
  assert.deepEqual(at("decoding", { tracksTotal: 1, tracksDecoded: 0 }), { label: "Decoding audio", state: "running", value: "0 of 1 file", progress: 0 });
  assert.deepEqual(at("decoding"), { label: "Decoding audio", state: "running" }, "no count yet");
  assert.deepEqual(at("encoding", { tracksTotal: 43, tracksEncoded: 24 }), { label: "Encoding audio", state: "running", value: "24 of 43 files", progress: 24 / 43 });
  assert.deepEqual(at("encoding", { tracksTotal: 43, encodeQueuePosition: 2 }), { label: "Encoding audio", state: "running", value: "2 books ahead" }, "a queue position");
  assert.deepEqual(at("encoding", { tracksTotal: 43, encodeQueuePosition: 1 }), { label: "Encoding audio", state: "running", value: "1 book ahead" });
  assert.deepEqual(at("encoding", { tracksTotal: 43, encodeQueuePosition: 0, tracksEncoded: 3 }), { label: "Encoding audio", state: "running", value: "3 of 43 files", progress: 3 / 43 }, "position 0 holds the encoder");
  assert.deepEqual(at("encoding", { waitingForWindowRequests: true }), { label: "Encoding audio", state: "running", value: "Waiting" });
  assert.deepEqual(at("anchoring"), { label: "Anchoring text to audio", state: "running" });
  assert.deepEqual(at("aligning", { groupsTotal: 8, groupsDone: 3 }), { label: "Aligning text", state: "running", value: "3 of 8 parts", progress: 3 / 8 });
  assert.deepEqual(at("finishing"), { label: "Saving the map", state: "running" });
  assert.deepEqual(at("done"), { label: "Saving the map", state: "running" });
  assert.deepEqual(at("queued", { resumeQueuePosition: 2 }), { label: "Waiting for a worker", state: "running", value: "2 in line" });
  assert.deepEqual(at("starting"), { label: "Waiting for a worker", state: "running" });
  // Before the worker: queued, copying.
  assert.deepEqual(running(page(job("queued"))), { label: "Waiting for a worker", state: "running" });
  assert.deepEqual(page(job("queued")).blocks[0].steps!.map((s) => s.state), ["running", "waiting", "waiting", "waiting", "waiting", "waiting", "waiting"]);
  assert.deepEqual(running(page(job("copying"))), { label: "Copying audio", state: "running" });
  assert.deepEqual(page(job("copying")).blocks[0].steps!.map((s) => s.state), ["done", "running", "waiting", "waiting", "waiting", "waiting", "waiting"]);
  // Done steps carry no figure.
  const aligning = page(job("processing", { bookJob: worker("aligning", { tracksTotal: 43, tracksDecoded: 43, groupsTotal: 8, groupsDone: 3 }) }));
  assert.equal(aligning.blocks[0].steps!.filter((s) => s.value).length, 1);
});

test("a worker job of an earlier run (before a Resume) is not this run's: it waits for a worker, the audio copied", () => {
  const earlier = { ...worker("encoding", { tracksTotal: 43, tracksEncoded: 40 }), id: bookWorkerJobId({ id: "job-1", generation: "g0" }) };
  const model = page(job("processing", { bookJob: earlier }));
  assert.deepEqual(running(model), { label: "Waiting for a worker", state: "running" });
  assert.deepEqual(model.blocks[0].steps!.map((s) => s.state), ["running", "done", "waiting", "waiting", "waiting", "waiting", "waiting"]);
  assert.deepEqual(runPoint({ id: "job-1", generation: "g1", status: "processing" }), { step: "waiting" }, "no worker job at all");
  assert.equal(runPoint({ id: "job-1", generation: "g1", status: "processing", bookJob: worker("teleporting") }), null, "a stage outside the vocabulary");
});

test("a stage outside the vocabulary shows the plain progress line", () => {
  const model = page(job("processing", { progress: 0.43, bookJob: worker("teleporting") }));
  assert.equal(model.blocks[0].steps, null);
  assert.equal(model.blocks[0].rows[0].name, "Preparing · 43%");
});

test("the older engine: Preparing · N% with its own line and bar, no steps, Pause after section", () => {
  const older = job("processing", { engine: "ctc-window-v1", progress: 0.43, mode: "chapters", sectionsDone: [0, 1], pairings: [{ section: 0, trackId: "t", start: 0, duration: 1 }, { section: 1, trackId: "t", start: 0, duration: 1 }, { section: 2, trackId: "t", start: 0, duration: 1 }] });
  const model = page(older);
  assert.equal(model.state, "preparing");
  assert.equal(model.blocks[0].steps, null);
  assert.deepEqual(model.blocks[0].rows, [{ name: "Preparing · 43%", line: "2 of 3 sections", progress: 0.43 }]);
  assert.deepEqual(model.buttons, ["Pause after section", "Cancel"]);
  assert.equal(model.note, null, "the note is about the whole-book worker");
  assert.equal(readingSyncDetails(older).olderEngine, "2 of 3 sections");
  assert.equal(readingSyncDetails(job("ready")).olderEngine, null, "a whole-book job has no such line");
  const sampling = { ...older, mode: "anchored" as const, anchoring: { stage: "sampling" as const, refinements: 0, samples: [{ trackId: "t", time: 0, duration: 1, done: true }, { trackId: "t", time: 1, duration: 1 }], anchors: [], segments: [], rate: 1, flags: [] } };
  assert.equal(page(sampling).blocks[0].rows[0].line, "Locating text · 1 of 2 narration samples");
});

test("ready: Ready with Timings are estimated and the tick, Text mapped, Prepare again and Details, Unsynced passages last", () => {
  const model = page(job("ready", { coverage: 0.96, outcome: "mapped", bookJob: worker("done"), unsyncedPassages: [
    { title: "Title page", excerpt: "There Is No", sentenceCount: 6, section: 0, firstParagraphId: "a", lastParagraphId: "b" },
    { title: "Acknowledgements", excerpt: "Thanks", sentenceCount: 1, section: 0, firstParagraphId: "c", lastParagraphId: "d" },
  ] }));
  assert.equal(model.state, "ready");
  assert.equal(model.blocks[0].caption, "Status");
  assert.equal(model.blocks[0].value, "Today 14:02 · 38 min on wsl");
  assert.deepEqual(model.blocks[0].rows, [
    { name: "Ready", line: "Timings are estimated", tip: "ready", mark: "ready" },
    { name: "Text mapped", tip: "mapped", value: "96%", progress: 0.96 },
  ]);
  assert.deepEqual(model.prepareAgainRow, { line: null });
  assert.deepEqual(model.buttons, []);
  assert.equal(model.details, true);
  assert.deepEqual(model.passages, [
    { title: "Title page", line: "There Is No · 6 sentences" },
    { title: "Acknowledgements", line: "Thanks · 1 sentence" },
  ]);
});

test("partly ready, and the 95% rule: more than 95% of a finished partial map is Ready; 95% exactly is Partly ready", () => {
  const partial = page(job("partial", { coverage: 0.61, outcome: "partial" }));
  assert.equal(partial.state, "partial");
  assert.deepEqual(partial.blocks[0].rows[0], { name: "Partly ready", line: "Timings are estimated", tip: "ready", mark: undefined });
  assert.equal(partial.blocks[0].rows[1].value, "61%");
  assert.deepEqual(partial.passages, []);
  assert.equal(page(job("partial", { coverage: 0.95, outcome: "partial" })).state, "partial");
  assert.equal(page(job("partial", { coverage: 0.95, outcome: "partial" })).blocks[0].rows[0].name, "Partly ready");
  const over = page(job("partial", { coverage: 0.951, outcome: "partial" }));
  assert.equal(over.state, "ready");
  assert.equal(over.blocks[0].rows[0].name, "Ready");
  assert.equal(over.blocks[0].rows[0].mark, "ready");
  assert.equal(page(job("partial", { coverage: 0.99, outcome: "partial", progress: 0.5 })).state, "partial", "an unfinished partial map is not ready");
});

test("no text matched: its line, the note to choose another pair, Prepare again and Details, no passage list", () => {
  const model = page(job("partial", { coverage: 0, outcome: "unsynced", elapsedSeconds: 52 * 60, bookJob: worker("done") }));
  assert.equal(model.state, "no-match");
  assert.equal(model.blocks[0].value, "Today 14:02 · 52 min on wsl");
  assert.deepEqual(model.blocks[0].rows, [{ name: "No text matched", line: "The narration does not match this edition" }]);
  assert.equal(model.note, "Choose another recording or edition above.");
  assert.deepEqual(model.prepareAgainRow, { line: null });
  assert.equal(model.details, true);
  assert.equal(model.passages, null);
});

test("not available: English only, no buttons, no Details, no passage list; a language that differs before any job", () => {
  const model = page(job("error", { outcome: "language_not_supported" }));
  assert.equal(model.state, "not-available");
  assert.equal(model.blocks[0].value, "Today 14:02");
  assert.deepEqual(model.blocks[0].rows, [{ name: "Not available", line: "Reading sync works with English books only" }]);
  assert.deepEqual(model.buttons, []);
  assert.equal(model.details, false);
  assert.equal(model.passages, null);
  assert.equal(model.prepareAgainRow, null);
  const differs = page(null, { languageMatch: false });
  assert.equal(differs.state, "not-prepared");
  assert.deepEqual(differs.blocks[0].rows, [{ name: "Not prepared", line: "The recording and the edition are in different languages" }]);
  assert.deepEqual(differs.buttons, []);
});

test("paused: Resume starts this book over, Resume and Cancel, Details", () => {
  const model = page(job("paused"));
  assert.equal(model.state, "paused");
  assert.equal(model.blocks[0].value, "Today 14:02");
  assert.deepEqual(model.blocks[0].rows, [{ name: "Paused", line: "Resume starts this book over" }]);
  assert.deepEqual(model.buttons, ["Resume", "Cancel"]);
  assert.equal(model.details, true);
  assert.equal(model.passages, null);
  assert.equal(page(job("paused", { engine: "ctc-window-v1" })).blocks[0].rows[0].line, undefined, "the older engine carries on");
});

test("cancelled: Cancelled and Prepare again, nothing else", () => {
  const model = page(job("cancelled"));
  assert.equal(model.state, "cancelled");
  assert.deepEqual(model.blocks[0].rows, [{ name: "Cancelled" }]);
  assert.deepEqual(model.buttons, ["Prepare again"]);
  assert.equal(model.details, false);
  assert.equal(model.passages, null);
});

test("stopped: the step it stopped in, the reason for each worker, Retry, the Workers row with the pool's count, Details", () => {
  const stopped = job("error", { error: "Reading sync failed on every worker.", bookJob: worker("encoding", { tracksTotal: 43 }), poolErrors: { wsl: "Did not answer for 12 minutes", lisa: "Out of memory" } });
  const model = page(stopped, { pool: { online: 1, total: 2 } });
  assert.equal(model.state, "stopped");
  assert.equal(model.blocks[0].caption, "Stopped");
  assert.equal(model.blocks[0].tip, "stopped");
  assert.deepEqual(model.blocks[0].rows, [
    { name: "Stopped while encoding audio", line: "Reading sync failed on every worker.", mark: "attention" },
    { name: "wsl", line: "Did not answer for 12 minutes" },
    { name: "lisa", line: "Out of memory" },
  ]);
  assert.deepEqual(model.buttons, ["Retry"]);
  assert.equal(model.note, "Retry starts this book over on the first free worker.");
  assert.equal(model.workers, "1 of 2 online");
  assert.equal(model.details, true);
  assert.equal(model.passages, null);
  assert.equal(page(stopped).workers, null, "until the pool has answered");
  // Before a worker step: plain Stopped and the server's line.
  const early = page(job("error", { error: null }));
  assert.deepEqual(early.blocks[0].rows[0], { name: "Stopped", line: "Reading sync failed on every worker.", mark: "attention" });
  assert.equal(page(job("error", { bookJob: worker("aligning") })).blocks[0].rows[0].name, "Stopped while aligning text");
});

test("not prepared: the pair has no job; the administrator gets Prepare", () => {
  const model = page(null);
  assert.equal(model.state, "not-prepared");
  assert.deepEqual(model.blocks[0].rows, [{ name: "Not prepared" }]);
  assert.deepEqual(model.buttons, ["Prepare"]);
  assert.deepEqual(page(null, { admin: false }).buttons, []);
});

test("Prepare again over the map in use: the map is in use until the new one is ready; the new run's steps", () => {
  const listed = job("ready", { coverage: 0.96, rebuild: { status: "processing", progress: 0.2, engine: BOOK_ENGINE, error: null, updatedAt: AT, generation: "g2", bookJob: { ...worker("decoding", { tracksTotal: 43, tracksDecoded: 5 }), id: bookWorkerJobId({ id: "job-1", generation: "g2" }) } } });
  const model = page(listed);
  assert.equal(model.state, "preparing-again");
  assert.deepEqual(model.blocks[0].rows, [{ name: "Ready", line: "In use until the new one is ready", mark: "ready" }]);
  assert.equal(model.blocks[1].caption, "Preparing again");
  assert.equal(model.blocks[1].value, "On wsl", "the new run's worker");
  assert.deepEqual(running(model, 1), { label: "Decoding audio", state: "running", value: "5 of 43 files", progress: 5 / 43 });
  assert.deepEqual(model.buttons, ["Pause", "Cancel"]);
  assert.equal(model.passages, null);
  // Not used: the new map matched less (#539).
  const kept = page(job("ready", { coverage: 0.96, rebuild: { status: "error", outcome: "rejected", progress: 1, engine: BOOK_ENGINE, error: "worse", updatedAt: AT, coverage: 0.4 } }));
  assert.equal(kept.state, "ready");
  assert.deepEqual(kept.prepareAgainRow, { line: "Not used: it matched 40% of the text" });
  assert.deepEqual(kept.buttons, []);
  // A paused or stopped one is named under Prepare again, with its button.
  const paused = page(job("ready", { coverage: 1, rebuild: { status: "paused", progress: 0.2, engine: BOOK_ENGINE, error: null, updatedAt: AT } }));
  assert.deepEqual(paused.prepareAgainRow, { line: "Preparing again · Paused" });
  assert.deepEqual(paused.buttons, ["Resume"]);
  const failed = page(job("ready", { coverage: 1, rebuild: { status: "error", progress: 0.2, engine: BOOK_ENGINE, error: "x", updatedAt: AT } }));
  assert.deepEqual(failed.prepareAgainRow, { line: "Preparing again · Stopped" });
  assert.deepEqual(failed.buttons, ["Retry"]);
});

test("someone who is not the administrator: no buttons, no worker names, no Prepare again, no Workers row", () => {
  const facts = { admin: false, pool: { online: 1, total: 2 } };
  const preparing = page(job("processing", { ctcDevice: "cuda", elapsedSeconds: 12 * 60, bookJob: worker("encoding", { tracksTotal: 43, tracksEncoded: 24 }), pool: { hostId: "wsl", attempt: 1, jobMediaRoot: "", workerUrl: "", triedHosts: [], stagedAudio: {} } }), facts);
  assert.deepEqual(preparing.buttons, []);
  assert.equal(preparing.note, null);
  assert.equal(preparing.blocks[0].value, "GPU · 12 min");
  assert.ok(running(preparing), "the steps are everyone's");
  const stopped = page(job("error", { bookJob: worker("encoding"), poolErrors: { wsl: "x", lisa: "y" } }), facts);
  assert.deepEqual(stopped.blocks[0].rows.map((row) => row.name), ["Stopped while encoding audio"]);
  assert.deepEqual(stopped.buttons, []);
  assert.equal(stopped.workers, null);
  assert.equal(stopped.note, null);
  const ready = page(job("ready", { coverage: 1, bookJob: worker("done") }), facts);
  assert.equal(ready.blocks[0].value, "Today 14:02 · 38 min");
  assert.equal(ready.prepareAgainRow, null);
  assert.deepEqual(ready.buttons, []);
  for (const status of ["paused", "cancelled"] as const) assert.deepEqual(page(job(status), facts).buttons, [], status);
  assert.equal(page(job("partial", { outcome: "unsynced" }), facts).prepareAgainRow, null);
  const again = page(job("ready", { coverage: 1, rebuild: { status: "processing", progress: 0, engine: BOOK_ENGINE, error: null, updatedAt: AT } }), facts);
  assert.deepEqual(again.buttons, []);
  // Not one worker's name anywhere in what the page shows.
  for (const model of [preparing, stopped, ready, again]) assert.doesNotMatch(JSON.stringify(model), /wsl|lisa/);
});

test("no connection: the line from the stored work, No connection, nothing to act on", () => {
  const stored = { ...job("ready", { coverage: 1, outcome: "mapped", unsyncedPassages: [{ title: "Title page", excerpt: "E", sentenceCount: 2, section: 0, firstParagraphId: "a", lastParagraphId: "b" }] }), ebookId: "e", recordingId: "r", fingerprint: "", audioFingerprint: "", intervalCount: 3, createdAt: 1 } as unknown as ReadingSyncSummary;
  const model = page(undefined, { offline: true, stored });
  assert.equal(model.state, "offline");
  assert.deepEqual(model.blocks[0].rows, [{ name: "Ready · estimated timings", line: "No connection" }]);
  assert.deepEqual(model.buttons, []);
  assert.equal(model.details, false);
  assert.deepEqual(model.passages, [{ title: "Title page", line: "E · 2 sentences" }]);
  // The stored listing may be older than the answer: no connection wins over a listed job.
  assert.equal(page(job("processing"), { offline: true, stored }).state, "offline");
  const partial = { ...stored, status: "partial", coverage: 0.97 } as ReadingSyncSummary;
  assert.equal(page(undefined, { offline: true, stored: partial }).blocks[0].rows[0].name, "Ready · estimated timings", "the 95% rule");
  const runningStored = { ...stored, status: "processing", progress: 0.43 } as ReadingSyncSummary;
  assert.deepEqual(page(undefined, { offline: true, stored: runningStored }).blocks[0].rows[0], { name: "Preparing · 43%", line: "No connection" }, "the summary has no stage");
  assert.equal(page(undefined, { offline: true, stored: runningStored }).passages, null);
  assert.deepEqual(page(undefined, { offline: true, stored: null }).blocks[0].rows[0], { name: "Not prepared", line: "No connection" });
  assert.equal(page(undefined).state, "loading", "online, not answered yet");
});

test("Details: engine, GPU use, processing time, the stage times, the warning and the older engine's flags", () => {
  const details = readingSyncDetails(job("ready", {
    gpuUtilization: 71.6,
    elapsedSeconds: 38 * 60,
    stageTimings: { requestValidation: 0.42, ctcEncode: 1200, decodedTrackHit: 1 },
    warning: "Chapter 3 was skipped.",
  }));
  assert.deepEqual(details.rows, [
    { label: "Engine", value: BOOK_ENGINE },
    { label: "GPU use", value: "72%" },
    { label: "Processing time", value: "38 min" },
  ]);
  assert.deepEqual(details.stages, [
    { label: "Request validation", value: "0.4 s" },
    { label: "Ctc encode", value: "20 min" },
  ]);
  assert.equal(details.warning, "Chapter 3 was skipped.");
  assert.deepEqual(readingSyncDetails(job("ready", { gpuUtilization: null })).rows[1], { label: "GPU use", value: "None" });
  const older = readingSyncDetails(job("partial", { engine: "ctc-window-v1", anchoring: { stage: "done", refinements: 0, samples: [], anchors: [], segments: [], rate: 1, flags: [{ kind: "intro", start: 0, end: 42 }, { kind: "unmatched-text", title: "Preface" }] } }));
  assert.deepEqual(older.flags, ["Introduction or credits not in the ebook: 0:00–0:42", "Not found in the narration: Preface"]);
  assert.deepEqual(readingSyncDetails(null), { rows: [], stages: [], warning: null, olderEngine: null, flags: [] });
  assert.equal(stageName("locateWorkers"), "Locate workers");
});

test("the time of a state: today, yesterday, a date this year and another", () => {
  assert.equal(whenLine(AT, NOW), "Today 14:02");
  assert.equal(whenLine(new Date(2026, 10, 16, 9, 5).getTime(), NOW), "Yesterday 09:05");
  assert.equal(whenLine(new Date(2026, 10, 2, 9, 5).getTime(), NOW), "2 Nov 09:05");
  assert.equal(whenLine(new Date(2025, 10, 2, 9, 5).getTime(), NOW), "2 Nov 2025");
  assert.equal(whenLine(0, NOW), "");
});
