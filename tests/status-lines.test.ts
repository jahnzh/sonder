/**
 * The status lines (#494, spec #493 "Status lines"): the spec's table line by line with its figures, and a walk over
 * every status the server can write, taken from the server's own lists. A status with no line fails the walk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOT_IN_LIBRARY_LINE, QUEUE_OFF_LINE, WORKER_OFF_LINE,
  deviceSaveLine, downloadLine, ebookCheckLine, readingSyncLine, serverCopyLine,
  type EbookCheckFacts, type ReadingSyncJobFacts,
} from "../src/status-lines.ts";
import { ALIGNMENT_OUTCOMES, ALIGNMENT_STATUSES } from "../src/reading-types.ts";
import { ACQUISITION_STATUSES } from "../server/acquisition-vocabulary.ts";
import { SERVER_COPY_STATUSES } from "../server/schema.ts";
import { EBOOK_SET_ACTIVITY_STATES, EBOOK_SET_IDLE_HOLDS } from "../server/ebook-set-activity.ts";
import { BOOK_STATES } from "../server/alignment-book-worker.ts";

const reading = (job: ReadingSyncJobFacts | null, over: Record<string, unknown> = {}) =>
  readingSyncLine({ hasEbook: true, hasRecording: true, job, ...over });
const book = (status: ReadingSyncJobFacts["status"], over: Partial<ReadingSyncJobFacts> = {}): ReadingSyncJobFacts =>
  ({ status, wholeBook: true, ...over });

test("a download: every line of the table, with its percentage", () => {
  assert.equal(downloadLine({ status: null }), "Not added");
  assert.equal(downloadLine({ status: "checking" }), "Finding a source");
  assert.equal(downloadLine({ status: "preparing" }), "Preparing the stream");
  assert.equal(downloadLine({ status: "downloading", progress: 0.43 }), "Downloading to server · 43%");
  assert.equal(downloadLine({ status: "paused", progress: 0.43 }), "Paused · 43%");
  assert.equal(downloadLine({ status: "ready", backend: "local" }), "On server");
  assert.equal(downloadLine({ status: "ready", backend: "copy" }), "On server");
  assert.equal(downloadLine({ status: "ready", backend: "torbox" }), "Streams from TorBox");
  assert.equal(downloadLine({ status: "error" }), "Download failed");
});

test("a percentage is a whole number, from 0 to 100, and a missing figure is 0%", () => {
  assert.equal(downloadLine({ status: "downloading", progress: 0.426 }), "Downloading to server · 43%");
  assert.equal(downloadLine({ status: "downloading", progress: 0.004 }), "Downloading to server · 0%");
  assert.equal(downloadLine({ status: "downloading", progress: 1.7 }), "Downloading to server · 100%");
  assert.equal(downloadLine({ status: "downloading", progress: -1 }), "Downloading to server · 0%");
  assert.equal(downloadLine({ status: "downloading", progress: null }), "Downloading to server · 0%");
  assert.equal(downloadLine({ status: "paused", progress: Number.NaN }), "Paused · 0%");
});

test("a copy to the server: every line of the table", () => {
  assert.equal(serverCopyLine({ status: "queued" }), "Waiting to copy to server");
  assert.equal(serverCopyLine({ status: "downloading", progress: 0.43 }), "Copying to server · 43%");
  assert.equal(serverCopyLine({ status: "paused", progress: 0.43 }), "Paused · 43%");
  assert.equal(serverCopyLine({ status: "ready" }), "On server");
  assert.equal(serverCopyLine({ status: "error" }), "Copy to server failed");
});

test("an ebook edition's check against the narration: every line of the table", () => {
  assert.equal(ebookCheckLine({ status: "pending" }), "Checking against the narration");
  assert.equal(ebookCheckLine({ status: "accepted" }), "Matches the narration");
  assert.equal(ebookCheckLine({ status: "rejected" }), "Does not match the narration");
  assert.equal(ebookCheckLine({ status: "held", holdReason: "awaiting_audio" }), "Waiting for the audiobook");
  assert.equal(ebookCheckLine({ status: "held", holdReason: "awaiting_worker" }), "Waiting for a worker");
  assert.equal(ebookCheckLine({ status: "held", holdReason: "language_not_supported" }), "Not checked, English only");
  assert.equal(ebookCheckLine({ status: "held", holdReason: "evaluation_failed" }), "Check failed");
});

test("a reading sync: every line of the table, with its figures", () => {
  assert.equal(readingSyncLine({ hasEbook: false, hasRecording: true, job: null }), "Needs an ebook");
  assert.equal(readingSyncLine({ hasEbook: true, hasRecording: false, job: null }), "Needs an audiobook");
  assert.equal(readingSyncLine({ hasEbook: false, hasRecording: false, job: null }), "Needs an ebook", "the ebook is named first");
  assert.equal(reading(book("queued")), "Waiting for a worker");
  assert.equal(reading(book("copying")), "Copying audio");
  const stages = { queued: "Waiting for a worker", decoding: "Decoding audio", encoding: "Encoding audio", anchoring: "Anchoring text to audio", aligning: "Aligning text", finishing: "Saving the map" };
  for (const [stage, line] of Object.entries(stages)) assert.equal(reading(book("processing", { stage })), line, stage);
  assert.equal(reading(book("processing", { stage: null })), "Waiting for a worker", "a whole-book job the worker has not reported on yet");
  assert.equal(reading(book("processing", { wholeBook: false, progress: 0.5 })), "Preparing · 50%", "the older engine has no stages");
  assert.equal(reading(book("paused")), "Paused");
  assert.equal(reading(book("cancelled")), "Cancelled");
  assert.equal(reading(book("ready", { outcome: "mapped", coverage: 1 })), "Ready · estimated timings");
  assert.equal(reading(book("partial", { outcome: "partial", coverage: 0.61 })), "Partly ready · 61% of the text");
  assert.equal(reading(book("partial", { outcome: "unsynced", coverage: 0 })), "No text matched");
  assert.equal(reading(book("error", { outcome: "language_not_supported" })), "Not available, English only");
  assert.equal(reading(book("error", { outcome: "error" })), "Stopped");
  assert.equal(reading(book("error")), "Stopped");
  assert.equal(reading(book("error", { outcome: "rejected", coverage: 0.4 })), "New reading sync not used", "a new map the server did not use (#539)");
  assert.equal(reading(book("error", { outcome: "rejected", wholeBook: false })), "New reading sync not used", "the older engine's rebuild too");
  assert.equal(reading(book("queued", { outcome: "rejected" })), "Waiting for a worker", "a rejected one prepared again is waiting");
});

test("while a reading sync is rebuilt or prepared again, the line is that of the map in use", () => {
  const inUse = book("partial", { outcome: "partial", coverage: 0.61 });
  for (const status of ALIGNMENT_STATUSES) {
    assert.equal(reading(book(status, { stage: "decoding" }), { mapInUse: inUse }), "Partly ready · 61% of the text", status);
  }
  assert.equal(reading(book("processing", { stage: "decoding" }), { mapInUse: null }), "Decoding audio");
  assert.equal(reading(book("ready", { coverage: 1 }), { mapInUse: book("ready", { coverage: 1 }) }), "Ready · estimated timings");
});

test("a save to this device: every line of the table, with its figures", () => {
  assert.equal(deviceSaveLine({ keep: true, saving: true, filesTotal: 12, filesSaved: 3, size: 0 }), "Saving · 3 of 12 files");
  assert.equal(deviceSaveLine({ keep: false, saving: true, filesTotal: 12, filesSaved: 3, size: 0 }), "Saving · 3 of 12 files");
  assert.equal(deviceSaveLine({ keep: true, saving: false, filesTotal: 12, filesSaved: 12, size: 414_000_000 }), "On this device · 414 MB");
  assert.equal(deviceSaveLine({ keep: false, saving: false, filesTotal: 2, filesSaved: 2, size: 1_500_000_000 }), "On this device · 1.5 GB");
  assert.equal(deviceSaveLine({ keep: true, saving: false, filesTotal: 12, filesSaved: 8, size: 300_000_000 }), "Not complete · 8 of 12 files");
  assert.equal(deviceSaveLine({ keep: true, saving: false, filesTotal: 0, filesSaved: 0, size: 0 }), "Nothing to save yet");
});

test("the fixed lines", () => {
  assert.equal(NOT_IN_LIBRARY_LINE, "Not in your library");
  assert.equal(QUEUE_OFF_LINE, "Paused");
  assert.equal(WORKER_OFF_LINE, "Not in use");
});

// The walk: every status the server can write has a line. The lists are the server's own, not copies.

test("every acquisition status the server can write has a line", () => {
  assert.deepEqual([...ACQUISITION_STATUSES], ["checking", "preparing", "downloading", "paused", "ready", "error"]);
  for (const status of ACQUISITION_STATUSES) {
    for (const backend of ["local", "torbox", "copy"] as const) {
      const line = downloadLine({ status, progress: 0.5, backend });
      assert.ok(line, `${status} (${backend}) has a line`);
    }
  }
  assert.equal(downloadLine({ status: "exploded" as never }), null, "a status outside the vocabulary has no line, never the raw word");
});

test("every server copy status the server can write has a line", () => {
  assert.ok(SERVER_COPY_STATUSES.length > 0);
  for (const status of SERVER_COPY_STATUSES) assert.ok(serverCopyLine({ status, progress: 0.5 }), `${status} has a line`);
});

test("every ebook-set member status and hold reason the server can write has a line", () => {
  // Activity reads a member as its status, or its hold reason when held; the idle holds are the two it does not list.
  const reads = [...Object.keys(EBOOK_SET_ACTIVITY_STATES), ...EBOOK_SET_IDLE_HOLDS];
  const memberStatuses = new Set(["pending", "accepted", "rejected"]);
  assert.ok(reads.length >= 7, "the five Activity reads and the two idle holds");
  const lines = new Set<string>();
  for (const read of reads) {
    const facts = (memberStatuses.has(read) ? { status: read } : { status: "held", holdReason: read }) as EbookCheckFacts;
    const line = ebookCheckLine(facts);
    assert.ok(line, `${read} has a line`);
    lines.add(line);
  }
  assert.equal(lines.size, reads.length, "every state reads differently");
});

test("every alignment status and outcome the server can write has a line, in every pairing", () => {
  assert.equal(ALIGNMENT_STATUSES.length, 8);
  assert.equal(ALIGNMENT_OUTCOMES.length, 6);
  for (const status of ALIGNMENT_STATUSES) {
    for (const wholeBook of [true, false]) {
      assert.ok(reading({ status, wholeBook, stage: "aligning", progress: 0.4, coverage: 0.4 }), `${status}, wholeBook ${wholeBook}`);
      for (const outcome of ALIGNMENT_OUTCOMES) {
        assert.ok(reading({ status, outcome, wholeBook, stage: "aligning", progress: 0.4, coverage: 0.4 }), `${status}, outcome ${outcome}, wholeBook ${wholeBook}`);
      }
    }
  }
  assert.equal(reading({ status: "exploded" as never }), null);
});

test("every stage of the whole-book worker has a line", () => {
  assert.deepEqual([...BOOK_STATES], ["queued", "decoding", "encoding", "anchoring", "aligning", "finishing", "done", "failed", "cancelled"]);
  const lines = new Set<string>();
  for (const stage of BOOK_STATES) {
    const line = reading(book("processing", { stage }));
    assert.ok(line, `${stage} has a line`);
    lines.add(line);
  }
  assert.ok(lines.size >= 6, "the stages read differently");
  assert.equal(reading(book("processing", { stage: "polishing" })), "Preparing · 0%", "a stage this build does not know reads as a preparation");
});

test("the server imports nothing from the status lines, and only files the production image copies", () => {
  const root = join(import.meta.dirname, "..");
  // The image copies `server/` whole and these files of `src/`, as the Dockerfile says.
  const copied = new Set([...readFileSync(join(root, "Dockerfile"), "utf8").matchAll(/\/app\/src\/([\w.-]+) /g)].map((match) => match[1]));
  assert.deepEqual([...copied].sort(), ["appearance.ts", "reading-types.ts", "series-selection.ts", "types.ts"]);
  const imported = new Set<string>();
  for (const name of readdirSync(join(root, "server"))) {
    if (!name.endsWith(".ts")) continue;
    for (const match of readFileSync(join(root, "server", name), "utf8").matchAll(/"\.\.\/src\/([\w.-]+?)(?:\.ts)?"/g)) imported.add(`${match[1]}.ts`);
  }
  assert.ok(imported.size >= 3, "the scan finds the server's imports of src/");
  assert.equal(imported.has("status-lines.ts"), false);
  assert.deepEqual([...imported].filter((file) => !copied.has(file)), [], "every file of src/ the server imports is in the image");
});

test("a size reads as the boards write it: one decimal below ten, none from ten up, no .0", async () => {
  const { bytes } = await import("../src/size-format.ts");
  assert.equal(bytes(414_000_000), "414 MB");
  assert.equal(bytes(600_000), "600 KB");
  assert.equal(bytes(1_600_000), "1.6 MB");
  assert.equal(bytes(2_100_000_000), "2.1 GB");
  assert.equal(bytes(12_000_000_000), "12 GB");
  assert.equal(bytes(1_000_000_000), "1 GB");
  assert.equal(bytes(9_960_000), "10 MB");
  assert.equal(bytes(0), "0 KB");
});

// The lines Now adds (#521): the series search lines and the named finished and failed forms, in one place.
test("Now's lines: a series search, and the finished and failed forms with their figures", async () => {
  const { seriesSearchLine, finishedLine, failedLine, withFileCount, withReason } = await import("../src/status-lines.ts");
  assert.equal(seriesSearchLine({ status: "pending", search: "audiobook" }), "Waiting for series search");
  assert.equal(seriesSearchLine({ status: "pending", search: "ebook" }), "Waiting for series search");
  assert.equal(seriesSearchLine({ status: "searching", search: "audiobook" }), "Searching for the audiobook");
  assert.equal(seriesSearchLine({ status: "searching", search: "ebook" }), "Searching for the ebook");
  assert.equal(seriesSearchLine({ status: "done", search: "audiobook" }), null, "the download it starts takes over the row");
  assert.equal(seriesSearchLine({ status: "done", search: "ebook" }), "Ebook on server");
  assert.equal(seriesSearchLine({ status: "failed", search: "ebook" }), "Ebook search failed");

  assert.equal(finishedLine({ entry: "download", backend: "local" }), "Audiobook on server");
  assert.equal(finishedLine({ entry: "download", backend: "torbox" }), "Audiobook streams from TorBox");
  assert.equal(finishedLine({ entry: "server-copy" }), "Audiobook on server");
  assert.equal(finishedLine({ entry: "series-search", search: "ebook" }), "Ebook on server");
  assert.equal(finishedLine({ entry: "ebook-check", status: "accepted" }), "Ebook matches the narration");
  assert.equal(finishedLine({ entry: "ebook-check", status: "rejected" }), "Ebook does not match the narration");
  assert.equal(finishedLine({ entry: "reading-sync", status: "ready" }), "Reading sync ready");
  assert.equal(finishedLine({ entry: "reading-sync", status: "partial", coverage: 0.61 }), "Reading sync partly ready · 61% of the text");
  assert.equal(finishedLine({ entry: "reading-sync", status: "cancelled" }), "Reading sync cancelled");
  assert.equal(finishedLine({ entry: "device-save", size: 414_000_000 }), "On this device · 414 MB");

  assert.equal(failedLine({ entry: "download" }), "Download failed");
  assert.equal(failedLine({ entry: "server-copy" }), "Copy to server failed");
  assert.equal(failedLine({ entry: "series-search" }), "Series search failed");
  assert.equal(failedLine({ entry: "ebook-check" }), "Check failed");
  assert.equal(failedLine({ entry: "reading-sync" }), "Reading sync stopped");
  assert.equal(failedLine({ entry: "device-save", filesDone: 8, filesTotal: 12 }), "Not complete · 8 of 12 files");

  assert.equal(withFileCount("Encoding audio", { done: 24, total: 43 }), "Encoding audio · 24 of 43 files");
  assert.equal(withFileCount("Aligning text", null), "Aligning text");
  assert.equal(withReason("Downloading to server · 77%", "Blocked by Torrent client"), "Downloading to server · 77% · Blocked by Torrent client");
  assert.equal(withReason("Copying audio", null), "Copying audio");
});

test("Now's own forms: whose a Hardcover line is, and how long ago a finished entry finished (#522)", async () => {
  const { withUser, finishedAgo } = await import("../src/status-lines.ts");
  assert.equal(withUser("We weren't able to find that book", "admin"), "We weren't able to find that book · admin");
  assert.equal(withUser("socket hang up", null), "socket hang up");
  assert.equal(withUser("", "reader"), "reader");
  const at = 1_000_000_000;
  assert.equal(finishedAgo(at, at + 20_000), "Just now");
  assert.equal(finishedAgo(at, at + 5 * 60_000), "5 min ago");
  assert.equal(finishedAgo(at, at + 59 * 60_000), "59 min ago");
  assert.equal(finishedAgo(at, at + 60 * 60_000), "1 h ago");
  assert.equal(finishedAgo(at, at + 89 * 60_000), "1 h ago");
  assert.equal(finishedAgo(at, at + 2 * 3_600_000 + 10 * 60_000), "2 h ago");
  assert.equal(finishedAgo(at, at + 23 * 3_600_000 + 59 * 60_000), "23 h ago");
  // A clock a little behind the server's never reads as the future.
  assert.equal(finishedAgo(at, at - 30_000), "Just now");
});

test("the 95% rule (#540): a finished partial map of more than 95% of the text reads Ready · estimated timings", async () => {
  const { readsAsReady, finishedLine, bookSyncLine } = await import("../src/status-lines.ts");
  assert.equal(reading(book("partial", { outcome: "partial", coverage: 0.951, progress: 1 })), "Ready · estimated timings");
  assert.equal(reading(book("partial", { outcome: "partial", coverage: 0.96 })), "Ready · estimated timings", "partial is an end state");
  assert.equal(reading(book("partial", { outcome: "partial", coverage: 0.95, progress: 1 })), "Partly ready · 95% of the text", "95% exactly");
  assert.equal(reading(book("partial", { outcome: "partial", coverage: 0.99, progress: 0.5 })), "Partly ready · 99% of the text", "not finished");
  assert.equal(reading(book("partial", { outcome: "unsynced", coverage: 0.99 })), "No text matched");
  assert.equal(readsAsReady({ status: "ready", coverage: 1 }), false, "only a partial map is read by the rule");
  // The same rule in the Book page's row and in Now's finished line.
  assert.equal(bookSyncLine({ hasRecording: true, audioComing: false, hasEbook: true, hasEpub: true, job: book("partial", { coverage: 0.97, progress: 1 }) }), "Ready · estimated timings");
  assert.equal(finishedLine({ entry: "reading-sync", status: "partial", coverage: 0.97 }), "Reading sync ready");
  assert.equal(finishedLine({ entry: "reading-sync", status: "partial", coverage: 0.95 }), "Reading sync partly ready · 95% of the text");
});

test("the Reading sync page's lines (#540): states, notes, steps, and the lines with figures", async () => {
  const lines = await import("../src/status-lines.ts");
  assert.deepEqual(Object.values(lines.SYNC_STEP_LINES), [
    "Waiting for a worker", "Copying audio", "Decoding audio", "Encoding audio", "Anchoring text to audio", "Aligning text", "Saving the map",
  ]);
  assert.deepEqual(lines.SYNC_STATE_LINES, {
    preparing: "Preparing", preparingAgain: "Preparing again", ready: "Ready", partial: "Partly ready", noMatch: "No text matched",
    paused: "Paused", cancelled: "Cancelled", stopped: "Stopped", notAvailable: "Not available", notPrepared: "Not prepared",
  });
  assert.deepEqual(lines.SYNC_STATE_NOTES, {
    estimated: "Timings are estimated",
    inUse: "In use until the new one is ready",
    resumeOver: "Resume starts this book over",
    noMatch: "The narration does not match this edition",
    englishOnly: "Reading sync works with English books only",
    languageDiffers: "The recording and the edition are in different languages",
    failedEverywhere: "Reading sync failed on every worker.",
    noConnection: "No connection",
  });
  assert.deepEqual(lines.SYNC_BUTTON_NOTES, {
    pause: "Pause stops the worker. Resume starts this book over.",
    retry: "Retry starts this book over on the first free worker.",
    chooseOther: "Choose another recording or edition above.",
  });
  assert.equal(lines.SYNC_DETAILS_VALUE, "Engine, GPU, stage times");
  assert.equal(lines.TEXT_MAPPED_LINE, "Text mapped");
  assert.equal(lines.stoppedWhileLine("encoding"), "Stopped while encoding audio");
  assert.equal(lines.stoppedWhileLine("saving"), "Stopped while saving the map");
  assert.equal(lines.stoppedWhileLine(null), "Stopped");
  assert.equal(lines.notUsedLine(0.4), "Not used: it matched 40% of the text");
  assert.equal(lines.notUsedLine(0.4, "less"), "Not used: it matched 40% of the text");
  assert.equal(lines.notUsedLine(0, "none"), "Not used: it matched none of the text");
  assert.equal(lines.notUsedLine(0, "language"), "Not used: the language is not supported");
  assert.equal(lines.workersOnlineLine(1, 2), "1 of 2 online");
  assert.equal(lines.passageLine("It was a dark", 6), "It was a dark · 6 sentences");
  assert.equal(lines.passageLine("", 1), "1 sentence");
  assert.equal(lines.mappedShare(0.961), "96%");
  // The step lines are the stage lines a reading sync's row shows elsewhere.
  for (const [stage, step] of [["decoding", "decoding"], ["encoding", "encoding"], ["anchoring", "anchoring"], ["aligning", "aligning"], ["finishing", "saving"]] as const)
    assert.equal(reading(book("processing", { stage })), lines.SYNC_STEP_LINES[step], stage);
});

// #717: a failed series search says which search failed and why; a waiting one says where it is in the queue.
test("a series search's failure names the search and its reason, and a waiting one its place in line (#717)", async () => {
  const { seriesSearchLine, ordinal, searchReason } = await import("../src/status-lines.ts");
  const libgen = "Library Genesis could not be reached. Try another mirror in Settings or open the source website.";
  assert.equal(seriesSearchLine({ status: "failed", search: "ebook", reason: libgen }), "Ebook search failed · Library Genesis could not be reached");
  assert.equal(seriesSearchLine({ status: "failed", search: "audiobook", reason: "No release found" }), "Audiobook search failed · No release found");
  assert.equal(seriesSearchLine({ status: "failed", search: "audiobook", reason: null }), "Audiobook search failed", "no stored reason: the search alone");
  assert.equal(seriesSearchLine({ status: "pending", search: "ebook", place: 2 }), "Waiting · 2nd in line");
  assert.equal(seriesSearchLine({ status: "pending", search: "audiobook", place: 1 }), "Waiting · 1st in line", "next, while no search runs");
  assert.equal(seriesSearchLine({ status: "pending", search: "audiobook", place: 13 }), "Waiting · 13th in line");
  assert.equal(seriesSearchLine({ status: "pending", search: "audiobook", place: null }), "Waiting for series search", "an older server sends no place");
  assert.equal(seriesSearchLine({ status: "pending", search: "ebook", retrying: true, reason: libgen }), "Waiting to try again · Library Genesis could not be reached");
  assert.equal(seriesSearchLine({ status: "searching", search: "ebook", place: 1 }), "Searching for the ebook");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal),
    ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  assert.equal(searchReason("Prowlarr did not answer in time."), "Prowlarr did not answer in time");
  assert.equal(searchReason("  "), "");
  assert.equal(searchReason(undefined), "");
});
