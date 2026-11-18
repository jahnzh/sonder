// The Reading sync page's model (#540): every state of the page, every worker stage and count, the older engine's
// line, the 95% rule, someone who is not the administrator, and no connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readingSyncDetails,
  readingSyncPage,
  runPoint,
  shownAfterPrepare,
  stageName,
  syncRequest,
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

const workerOf = (generation: string, state: string, counts: Record<string, unknown> = {}) => ({ ...worker(state, counts), id: bookWorkerJobId({ id: "job-1", generation }) });
const PASSAGES = [{ title: "Title page", excerpt: "E", sentenceCount: 6, section: 0, firstParagraphId: "a", lastParagraphId: "b" }];
const over = (rebuild: NonNullable<ListedJob["rebuild"]>, extra: Partial<ListedJob> = {}) =>
  job("ready", { coverage: 0.96, bookJob: worker("done"), unsyncedPassages: PASSAGES, rebuild, ...extra });

test("Prepare again running over the map in use: the map in use with its line, the Preparing again group with the new run's steps, Pause, Cancel and the note", () => {
  const model = page(over({ status: "processing", progress: 0.2, engine: BOOK_ENGINE, error: null, updatedAt: AT, generation: "g2", elapsedSeconds: 12 * 60, bookJob: workerOf("g2", "encoding", { tracksTotal: 43, tracksDecoded: 43, tracksEncoded: 24 }) }));
  assert.equal(model.state, "preparing-again");
  assert.equal(model.blocks.length, 2);
  assert.equal(model.blocks[0].caption, "Status");
  assert.equal(model.blocks[0].value, "Today 14:02 · 38 min on wsl", "the map in use: when it was made and how long it took");
  assert.deepEqual(model.blocks[0].rows, [{ name: "Ready", line: "In use until the new one is ready", tip: "ready", mark: "ready" }]);
  assert.equal(model.blocks[1].caption, "Preparing again");
  assert.equal(model.blocks[1].tip, "preparing");
  assert.equal(model.blocks[1].value, "On wsl · 12 min", "the new run's worker and time");
  assert.deepEqual(model.blocks[1].steps!.map((s) => s.label), STEPS);
  assert.deepEqual(model.blocks[1].steps!.map((s) => s.state), ["done", "done", "done", "running", "waiting", "waiting", "waiting"]);
  assert.deepEqual(running(model, 1), { label: "Encoding audio", state: "running", value: "24 of 43 files", progress: 24 / 43 });
  assert.deepEqual(model.buttons, ["Pause", "Cancel"]);
  assert.equal(model.note, "Pause stops the worker. Resume starts this book over.");
  assert.equal(model.prepareAgainRow, null);
  assert.equal(model.passages, null);
  // A worker job of the map in use's run is not the new run's: the new one waits for a worker.
  const waiting = page(over({ status: "processing", progress: 0, engine: BOOK_ENGINE, error: null, updatedAt: AT, generation: "g2", bookJob: workerOf("g1", "done") }));
  assert.equal(running(waiting, 1)?.label, "Waiting for a worker");
  // Queued: it waits; a Partly ready map in use reads Partly ready, without the tick.
  const queued = page(over({ status: "queued", progress: 0, engine: BOOK_ENGINE, error: null, updatedAt: AT }, { status: "partial", coverage: 0.6 }));
  assert.equal(queued.state, "preparing-again");
  assert.deepEqual(queued.blocks[0].rows, [{ name: "Partly ready", line: "In use until the new one is ready", tip: "ready", mark: undefined }]);
  assert.equal(running(queued, 1)?.label, "Waiting for a worker");
});

test("Prepare again paused: the map in use, the group holds Paused with Resume and Cancel", () => {
  const model = page(over({ status: "paused", progress: 0.2, engine: BOOK_ENGINE, error: null, updatedAt: AT, generation: "g2" }));
  assert.equal(model.state, "again-paused");
  assert.deepEqual(model.blocks[0].rows.map((row) => [row.name, row.line, row.value]), [["Ready", "Timings are estimated", undefined], ["Text mapped", undefined, "96%"]]);
  assert.equal(model.blocks[1].caption, "Preparing again");
  assert.deepEqual(model.blocks[1].rows, [{ name: "Paused", line: "Resume starts this book over" }]);
  assert.equal(model.blocks[1].steps, null);
  assert.deepEqual(model.buttons, ["Resume", "Cancel"]);
  assert.equal(model.prepareAgainRow, null);
  assert.equal(model.details, true);
  assert.deepEqual(model.passages, [{ title: "Title page", line: "E · 6 sentences" }], "the map in use's passages");
  assert.deepEqual(page(over({ status: "paused", progress: 0.2, engine: BOOK_ENGINE, error: null, updatedAt: AT }), { admin: false }).buttons, []);
});

test("Prepare again stopped: the map in use, the group holds Stopped with the reason per worker and Retry", () => {
  const rebuild = { status: "error" as const, progress: 0.2, engine: BOOK_ENGINE, error: "Every worker failed", updatedAt: AT, generation: "g2", bookJob: workerOf("g2", "encoding"), poolErrors: { wsl: "CUDA out of memory", lisa: "Host unreachable" } };
  const model = page(over(rebuild), { pool: { online: 1, total: 2 } });
  assert.equal(model.state, "again-stopped");
  assert.equal(model.blocks[0].rows[0].name, "Ready");
  assert.equal(model.blocks[1].caption, "Preparing again");
  assert.equal(model.blocks[1].tip, "stopped");
  assert.deepEqual(model.blocks[1].rows, [
    { name: "Stopped while encoding audio", line: "Every worker failed", mark: "attention" },
    { name: "wsl", line: "CUDA out of memory" },
    { name: "lisa", line: "Host unreachable" },
  ]);
  assert.deepEqual(model.buttons, ["Retry"]);
  assert.equal(model.note, "Retry starts this book over on the first free worker.");
  assert.equal(model.workers, "1 of 2 online");
  assert.equal(model.prepareAgainRow, null);
  const member = page(over(rebuild), { admin: false, pool: { online: 1, total: 2 } });
  assert.deepEqual(member.blocks[1].rows.map((row) => row.name), ["Stopped while encoding audio"]);
  assert.deepEqual(member.buttons, []);
  assert.equal(member.workers, null);
  assert.doesNotMatch(JSON.stringify(member.blocks), /lisa|CUDA/);
});

test("Prepare again not used: Prepare again stays, with the muted Not used line from the rejected job's coverage and reason", () => {
  // The reasons as server/alignment-rebuild.ts `rebuildRejection` words them.
  const rejected = (coverage: number, error: string) => over({ status: "error", outcome: "rejected", progress: 1, engine: BOOK_ENGINE, error, updatedAt: AT, coverage });
  const less = page(rejected(0.4, "The rebuild was rejected: it mapped 40% of the text, more than 2 points less than the previous map. The previous map (96% of the text mapped) stays published."));
  assert.equal(less.state, "ready");
  assert.equal(less.blocks.length, 1, "no Preparing again group");
  assert.deepEqual(less.blocks[0].rows.map((row) => row.name), ["Ready", "Text mapped"]);
  assert.deepEqual(less.prepareAgainRow, { line: "Not used: it matched 40% of the text" });
  assert.deepEqual(less.buttons, []);
  assert.equal(less.details, true);
  const none = page(rejected(0, "The rebuild was rejected: it mapped none of the text. The previous map (96% of the text mapped) stays published."));
  assert.deepEqual(none.prepareAgainRow, { line: "Not used: it matched none of the text" });
  const language = page(rejected(0, "The rebuild was rejected: the alignment worker does not support this language. The previous map (96% of the text mapped) stays published."));
  assert.deepEqual(language.prepareAgainRow, { line: "Not used: the language is not supported" });
  assert.equal(page(rejected(0.4, "x"), { admin: false }).prepareAgainRow, null);
});

test("Prepare again cancelled: nothing; the page reads as before Prepare again", () => {
  const before = page(job("ready", { coverage: 0.96, bookJob: worker("done"), unsyncedPassages: PASSAGES }));
  const cancelled = page(over({ status: "cancelled", progress: 0.2, engine: BOOK_ENGINE, error: null, updatedAt: AT, generation: "g2" }));
  assert.deepEqual(cancelled, before);
  assert.deepEqual(cancelled.prepareAgainRow, { line: null });
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

// #541: what each button sends, and how the page shows the server's answer before the listing does.
test("Pause, Cancel, Resume and Retry send PATCH with the action; Prepare and Prepare again send the ebook and the recording only", () => {
  const pair = { ebookId: "ebook-1", recordingId: "recording-1" };
  assert.deepEqual(syncRequest("Pause", pair, "job-1"), { method: "PATCH", path: "/alignments/job-1", body: { action: "pause" } });
  assert.deepEqual(syncRequest("Pause after section", pair, "job-1"), { method: "PATCH", path: "/alignments/job-1", body: { action: "pause" } });
  assert.deepEqual(syncRequest("Cancel", pair, "job-1"), { method: "PATCH", path: "/alignments/job-1", body: { action: "cancel" } });
  assert.deepEqual(syncRequest("Resume", pair, "job-1"), { method: "PATCH", path: "/alignments/job-1", body: { action: "resume" } });
  assert.deepEqual(syncRequest("Retry", pair, "job-1"), { method: "PATCH", path: "/alignments/job-1", body: { action: "resume" } });
  for (const button of ["Prepare", "Prepare again"] as const) {
    const sent = syncRequest(button, pair, "job-1");
    assert.deepEqual(sent, { method: "POST", path: "/alignments", body: { ebookId: "ebook-1", recordingId: "recording-1" } });
    assert.deepEqual(Object.keys(sent!.body).sort(), ["ebookId", "recordingId"], "never pairings or a mode");
    assert.deepEqual(syncRequest(button, pair, undefined)?.method, "POST", "a prepare needs no listed job");
  }
  // No listed job to act on: nothing is sent (the page says why).
  assert.equal(syncRequest("Retry", pair, undefined), null);
  assert.equal(syncRequest("Pause", pair, undefined), null);
  assert.equal(syncRequest("Cancel", pair, "a/b")?.path, "/alignments/a%2Fb");
});

test("a Prepare's answer shows at once: under rebuild over a map in use, as it is otherwise", () => {
  const answer = { ...job("queued", { progress: 0, generation: "g2", coverage: 0, createdAt: AT }), ebookId: "e", recordingId: "r", intervals: [], pairings: [], sectionsDone: [] } as never;
  // Nothing listed, a cancelled, stopped or no-text job: the answer as it is.
  assert.equal(shownAfterPrepare(null, answer).status, "queued");
  assert.equal(shownAfterPrepare(undefined, answer).status, "queued");
  assert.equal(shownAfterPrepare(job("cancelled"), answer).status, "queued");
  assert.equal(shownAfterPrepare(job("error"), answer).status, "queued");
  assert.equal(shownAfterPrepare(job("partial", { outcome: "unsynced", coverage: 0 }), answer).status, "queued");
  // A finished map with text mapped is kept in use: the page reads "Preparing again" over it.
  const kept = shownAfterPrepare(job("partial", { coverage: 0.96, outcome: "partial" }), answer);
  assert.equal(kept.status, "partial");
  assert.equal(kept.rebuild?.status, "queued");
  assert.equal(kept.rebuild?.generation, "g2");
  assert.equal(page(kept).state, "preparing-again");
  // A row that already keeps a map: the new job replaces the one under rebuild.
  const over = shownAfterPrepare(job("ready", { coverage: 1, rebuild: { status: "error", outcome: "rejected", progress: 1, engine: BOOK_ENGINE, error: "worse", updatedAt: AT } }), answer);
  assert.equal(over.rebuild?.status, "queued");
  assert.equal(over.rebuild?.outcome, undefined);
  // An answer for another row (a superseding job) is shown as it is.
  assert.equal(shownAfterPrepare(job("ready", { id: "other", coverage: 1 }), answer).status, "queued");
});
