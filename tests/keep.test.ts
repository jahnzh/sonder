// Keep on this device's pure rules (#550): the merge with the server, what a book needs, the classification of a
// stopped save, the stall rule with a fake clock, and the rollout's choices. Plain data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEEP_EPUB_FILE,
  classifyStop,
  isRefusal,
  keepStored,
  keptNeeds,
  mapReady,
  mergeKeep,
  rolloutChoices,
  stallGuard,
  STALL_MS,
  type KeepEntry,
  type KeepReading,
  type KeepWork,
  type NeededMapJob,
  type NeededTrack,
  type StallClock,
} from "../src/keep.ts";

const local = (workId: string, on: boolean, at: number, extra: Partial<KeepEntry> = {}): KeepEntry => ({ workId, on, at, completeAt: null, pending: false, ...extra });
const server = (workId: string, on: boolean, at: number, completeAt: number | null = null) => ({ workId, on, at, completeAt });

test("merge: a server record the device lacks is taken over", () => {
  const { records, send } = mergeKeep([], [server("w1", true, 10, 12)]);
  assert.deepEqual(records, [{ workId: "w1", on: true, at: 10, completeAt: 12, pending: false }]);
  assert.deepEqual(send, []);
});

test("merge: a change made offline is sent later, and stays pending until answered", () => {
  const { records, send } = mergeKeep([local("w1", true, 20, { pending: true })], []);
  assert.deepEqual(records, [{ workId: "w1", on: true, at: 20, completeAt: null, pending: true }]);
  assert.deepEqual(send, [{ workId: "w1", kind: "on", at: 20, completeAt: null }]);
  // Off made offline, against an older on of the server.
  const off = mergeKeep([local("w2", false, 30, { pending: true })], [server("w2", true, 10)]);
  assert.deepEqual(off.send, [{ workId: "w2", kind: "off", at: 30 }]);
  assert.equal(off.records[0].on, false);
});

test("merge: newer wins either way", () => {
  // The server's newer off (another device removed the book from the library) beats the device's older on.
  const theirs = mergeKeep([local("w1", true, 10, { pending: true })], [server("w1", false, 20)]);
  assert.deepEqual(theirs.records, [{ workId: "w1", on: false, at: 20, completeAt: null, pending: false }]);
  assert.deepEqual(theirs.send, []);
  // The device's newer choice beats the server's older one and is sent.
  const mine = mergeKeep([local("w1", false, 30)], [server("w1", true, 20)]);
  assert.equal(mine.records[0].on, false);
  assert.deepEqual(mine.send, [{ workId: "w1", kind: "off", at: 30 }]);
});

test("merge: the same choice keeps the later completion, and sends the device's when it is the later", () => {
  const same = mergeKeep([local("w1", true, 10, { completeAt: 50 })], [server("w1", true, 10, 40)]);
  assert.equal(same.records[0].completeAt, 50);
  assert.deepEqual(same.send, [{ workId: "w1", kind: "complete", completeAt: 50 }]);
  const older = mergeKeep([local("w1", true, 10, { completeAt: 30 })], [server("w1", true, 10, 40)]);
  assert.equal(older.records[0].completeAt, 40);
  assert.deepEqual(older.send, []);
  const answered = mergeKeep([local("w1", true, 10, { pending: true })], [server("w1", true, 10)]);
  assert.deepEqual(answered.records, [{ workId: "w1", on: true, at: 10, completeAt: null, pending: false }]);
  assert.deepEqual(answered.send, []);
});

const track = (recordingId: string, index: number): NeededTrack => ({
  id: `${recordingId}-${index}`,
  recordingId,
  title: `Track ${index}`,
  index,
  duration: 60,
  source: "",
  sourceType: "local",
});
const recording = (recordingId: string, count: number) => ({ recordingId, tracks: Array.from({ length: count }, (_, i) => track(recordingId, i)) });
const file = (recordingId: string, index: number, size = 1000) => ({ trackId: `${recordingId}-${index}`, recordingId, size });

test("needs: every track present is complete", () => {
  const needs = keptNeeds(recording("r1", 2), [file("r1", 0), file("r1", 1, 500)]);
  assert.equal(needs.complete, true);
  assert.deepEqual(needs.missing, []);
  assert.deepEqual([needs.filesSaved, needs.filesTotal, needs.size], [2, 2, 1500]);
});

test("needs: a missing track is missing, with its saved sections counted", () => {
  const needs = keptNeeds(recording("r1", 3), [file("r1", 0)], [{ trackId: "r1-1", recordingId: "r1", loaded: 4 }]);
  assert.equal(needs.complete, false);
  assert.deepEqual(needs.missing.map((t) => t.id), ["r1-1", "r1-2"]);
  assert.deepEqual([needs.filesSaved, needs.filesTotal, needs.sections], [1, 3, 4]);
  // Another recording's file and a file without a size do not count (today's size check).
  assert.equal(keptNeeds(recording("r1", 1), [file("r2", 0), file("r1", 0, 0)]).complete, false);
});

test("needs: a track a fresh read no longer lists does not count", () => {
  // The device has r1-0 and r1-1; the latest read lists only r1-1 and a new r1-2.
  const fresh = { recordingId: "r1", tracks: [track("r1", 1), track("r1", 2)] };
  const needs = keptNeeds(fresh, [file("r1", 0), file("r1", 1)]);
  assert.deepEqual([needs.filesSaved, needs.filesTotal, needs.size], [1, 2, 1000]);
  assert.deepEqual(needs.missing.map((t) => t.id), ["r1-2"]);
});

test("needs: no recording needs nothing and is not complete", () => {
  const needs = keptNeeds(null, [file("r1", 0)]);
  assert.deepEqual([needs.recordingId, needs.filesTotal, needs.complete], [null, 0, false]);
  assert.equal(keptNeeds({ recordingId: "r1", tracks: [] }, []).complete, false);
});

// What a kept book needs with its ebook and reading sync (#551): the chosen EPUB, never a PDF; the pair's map when the
// read says it is ready or partly ready, complete when the stored map matches that job and the kept EPUB.
const epub = (id: string, extra: Partial<{ available: boolean; format: string }> = {}) => ({ id, format: "epub", available: true, ...extra });
const job = (extra: Partial<NeededMapJob> = {}): NeededMapJob => ({
  id: "job-1",
  ebookId: "e1",
  recordingId: "r1",
  status: "ready",
  updatedAt: 100,
  fingerprint: "fp-e1",
  audioFingerprint: "fp-audio",
  intervalCount: 40,
  ...extra,
});
const storedMap = (extra: Record<string, unknown> = {}) => ({ id: "job-1", updatedAt: 100, fingerprint: "fp-e1", audioFingerprint: "fp-audio", intervals: [{}, {}], ...extra });
/** The work's editions and jobs and what the device holds; the kept EPUBs are added with `withHeld`. */
const reading = (
  extra: { editions?: ReturnType<typeof epub>[]; readingSync?: NeededMapJob[]; deviceChoice?: string | null; maps?: KeepReading["maps"] } = {},
): KeepReading => ({
  work: { ebooks: (extra.editions ?? [epub("e1")]) as never, chosenEbookId: null, readingSync: extra.readingSync ?? [] },
  deviceChoice: extra.deviceChoice ?? null,
  ebooks: [],
  maps: extra.maps ?? {},
});
/** A kept EPUB's prepared text (#805), made from that EPUB's file. */
const textOf = (ebook: { id: string; fingerprint: string }) => ({ id: ebook.id, key: "0123456789abcdef", fingerprint: ebook.fingerprint, size: 50_000 });
/** The kept EPUBs, each with its prepared text kept beside it, as a book kept since #805 holds them. */
const withHeld = (r: KeepReading, held: KeepReading["ebooks"]): KeepReading => ({ ...r, ebooks: held, texts: held.map(textOf) });
const keptEpub = { id: "e1", fingerprint: "fp-e1", size: 600_000 };
const mapKey = "reader-map:e1:r1";

test("needs with an EPUB: the chosen EPUB is one more file, complete when this device keeps it", () => {
  const missing = keptNeeds(recording("r1", 2), [file("r1", 0), file("r1", 1)], [], reading());
  assert.deepEqual(missing.ebook, { id: "e1", complete: false, size: 0 });
  assert.deepEqual(missing.text, { id: "e1", complete: false, size: 0 });
  assert.deepEqual([missing.filesSaved, missing.filesTotal, missing.complete], [2, 4, false]);
  const held = keptNeeds(recording("r1", 2), [file("r1", 0), file("r1", 1)], [], withHeld(reading(), [keptEpub]));
  assert.deepEqual([held.filesSaved, held.filesTotal, held.complete, held.size], [4, 4, true, 652_000]);
  // A book with only an ebook needs its EPUB and its text: "Ebook · 0.7 MB" once kept.
  const only = keptNeeds(null, [], [], withHeld(reading(), [keptEpub]));
  assert.deepEqual([only.recordingId, only.filesSaved, only.filesTotal, only.complete, only.size], [null, 2, 2, true, 650_000]);
  // The Ebook page's rule picks the EPUB: the shared default, then this device's choice, then the first.
  const two = reading({ editions: [epub("e1"), epub("e2")], deviceChoice: "e2" });
  assert.equal(keptNeeds(null, [], [], two).ebook?.id, "e2");
  assert.equal(keptNeeds(null, [], [], { ...two, work: { ...two.work, chosenEbookId: "e1" } }).ebook?.id, "e1");
  // Another edition's copy does not count for the chosen one.
  assert.equal(keptNeeds(null, [], [], withHeld(two, [keptEpub])).ebook?.complete, false);
  // An EPUB whose file is not on the server is not needed.
  assert.equal(keptNeeds(null, [], [], reading({ editions: [epub("e1", { available: false })] })).filesTotal, 0);
});

test("needs with a PDF only: a PDF is never needed", () => {
  const pdf = reading({ editions: [epub("p1", { format: "pdf" })] });
  const needs = keptNeeds(recording("r1", 1), [file("r1", 0)], [], pdf);
  assert.equal(needs.ebook, null);
  assert.deepEqual([needs.filesSaved, needs.filesTotal, needs.complete], [1, 1, true]);
  // A book whose only file is a PDF needs nothing: "Nothing to save yet".
  const nothing = keptNeeds(null, [], [], pdf);
  assert.deepEqual([nothing.filesTotal, nothing.complete], [0, false]);
});

test("needs with a map: not ready needs none; ready and partly ready need it; a stored map matching the job and EPUB is complete", () => {
  const tracks = [file("r1", 0)];
  for (const status of ["queued", "processing", "error", "cancelled"] as const) {
    const needs = keptNeeds(recording("r1", 1), tracks, [], withHeld(reading({ readingSync: [job({ status })] }), [keptEpub]));
    assert.equal(needs.map, null, status);
    assert.deepEqual([needs.filesSaved, needs.filesTotal, needs.complete], [3, 3, true], status);
  }
  // Ready but without sentences: nothing to read with.
  assert.equal(keptNeeds(recording("r1", 1), tracks, [], reading({ readingSync: [job({ intervalCount: 0 })] })).map, null);
  for (const status of ["ready", "partial"] as const) {
    const missing = keptNeeds(recording("r1", 1), tracks, [], withHeld(reading({ readingSync: [job({ status })] }), [keptEpub]));
    assert.deepEqual(missing.map, { ebookId: "e1", recordingId: "r1", jobId: "job-1", complete: false }, status);
    assert.deepEqual([missing.filesSaved, missing.filesTotal, missing.complete], [3, 4, false], status);
    const held = keptNeeds(recording("r1", 1), tracks, [], withHeld(reading({ readingSync: [job({ status })], maps: { [mapKey]: storedMap() } }), [keptEpub]));
    assert.equal(held.map?.complete, true, status);
    assert.deepEqual([held.filesSaved, held.filesTotal, held.complete], [4, 4, true], status);
  }
  assert.equal(mapReady(job({ status: "partial", intervalCount: 3 })), true);
  assert.equal(mapReady(null), false);
  // Another pair's job is not this pair's map.
  assert.equal(keptNeeds(recording("r1", 1), tracks, [], reading({ readingSync: [job({ recordingId: "r2" })] })).map, null);
  // Without a recording there is no pair.
  assert.equal(keptNeeds(null, [], [], reading({ readingSync: [job()] })).map, null);
});

test("needs: a stored map is stale after Prepare again, or when it was built from another EPUB, or the EPUB is not kept", () => {
  const tracks = [file("r1", 0)];
  const stored = { [mapKey]: storedMap() };
  // Prepare again published a new job run: the stored map is of the old one.
  const again = keptNeeds(recording("r1", 1), tracks, [], withHeld(reading({ readingSync: [job({ id: "job-2", updatedAt: 200 })], maps: stored }), [keptEpub]));
  assert.deepEqual([again.map?.complete, again.filesSaved, again.filesTotal, again.complete], [false, 3, 4, false]);
  // The same job, updated after the stored copy.
  assert.equal(keptNeeds(recording("r1", 1), tracks, [], withHeld(reading({ readingSync: [job({ updatedAt: 300 })], maps: stored }), [keptEpub])).map?.complete, false);
  // New audio under the same job.
  assert.equal(keptNeeds(recording("r1", 1), tracks, [], withHeld(reading({ readingSync: [job({ audioFingerprint: "other" })], maps: stored }), [keptEpub])).map?.complete, false);
  // The kept EPUB is another file than the one the map was built from.
  assert.equal(keptNeeds(recording("r1", 1), tracks, [], withHeld(reading({ readingSync: [job()], maps: stored }), [{ ...keptEpub, fingerprint: "fp-new" }])).map?.complete, false);
  // No kept EPUB: the map cannot be matched yet (the EPUB is saved first).
  const noEpub = keptNeeds(recording("r1", 1), tracks, [], reading({ readingSync: [job()], maps: stored }));
  assert.deepEqual([noEpub.ebook?.complete, noEpub.map?.complete, noEpub.filesSaved, noEpub.filesTotal], [false, false, 1, 4]);
  // A stored map without sentences does not count.
  assert.equal(keptNeeds(recording("r1", 1), tracks, [], withHeld(reading({ readingSync: [job()], maps: { [mapKey]: storedMap({ intervals: [] }) } }), [keptEpub])).map?.complete, false);
});

test("needs: the file count is the tracks, the EPUB, its text and the map (12 of 13 files)", () => {
  const all = Array.from({ length: 10 }, (_, i) => file("r1", i, 41_000_000));
  const needs = keptNeeds(recording("r1", 10), all, [], withHeld(reading({ readingSync: [job()] }), [keptEpub]));
  assert.deepEqual([needs.filesSaved, needs.filesTotal], [12, 13]);
  const one = keptNeeds(recording("r1", 10), all.slice(1), [], withHeld(reading({ readingSync: [job()], maps: { [mapKey]: storedMap() } }), [keptEpub]));
  assert.deepEqual([one.filesSaved, one.filesTotal, one.missing.map((t) => t.id)], [12, 13, ["r1-0"]]);
  const complete = keptNeeds(recording("r1", 10), all, [], withHeld(reading({ readingSync: [job()], maps: { [mapKey]: storedMap() } }), [keptEpub]));
  assert.deepEqual([complete.filesSaved, complete.filesTotal, complete.complete, complete.size], [13, 13, true, 410_650_000]);
});

// The prepared text of a kept book (#805, step 6 of #799): what the new reading view reads offline.
test("needs with prepared text: the chosen EPUB's text is one more file; a stale one or one of another file is missing", () => {
  const tracks = [file("r1", 0)];
  // A book kept before #805: the EPUB and no text. Its text is missing, so the next run saves it.
  const before = keptNeeds(recording("r1", 1), tracks, [], { ...reading(), ebooks: [keptEpub] });
  assert.deepEqual(before.text, { id: "e1", complete: false, size: 0 });
  assert.deepEqual([before.ebook?.complete, before.filesSaved, before.filesTotal, before.complete], [true, 2, 3, false]);
  // Kept whole: the text counts, its bytes too.
  const whole = keptNeeds(recording("r1", 1), tracks, [], withHeld(reading(), [keptEpub]));
  assert.deepEqual([whole.text?.complete, whole.complete, whole.size], [true, true, 1_000 + 600_000 + 50_000]);
  // The reader saw the server answer another output: the kept one still reads, and the next run replaces it.
  const stale = keptNeeds(recording("r1", 1), tracks, [], { ...reading(), ebooks: [keptEpub], texts: [{ ...textOf(keptEpub), stale: true }] });
  assert.deepEqual([stale.text?.complete, stale.complete, stale.size], [false, false, 601_000]);
  // A kept EPUB of another file than the text's (the server's file changed and the text was saved anew) does not hold
  // the text back: a changed file is seen by the stale mark, not by the EPUB copy, which Keep does not fetch again.
  const other = keptNeeds(recording("r1", 1), tracks, [], { ...reading(), ebooks: [keptEpub], texts: [{ ...textOf(keptEpub), fingerprint: "fp-new" }] });
  assert.deepEqual([other.text?.complete, other.complete], [true, true]);
  // Another edition's text does not count for the chosen one; a PDF has none.
  assert.equal(keptNeeds(null, [], [], { ...reading({ editions: [epub("e1"), epub("e2")], deviceChoice: "e2" }), texts: [textOf(keptEpub)] }).text?.complete, false);
  assert.equal(keptNeeds(null, [], [], reading({ editions: [epub("p1", { format: "pdf" })] })).text, null);
  // While Keep keeps EPUB files, none is dropped.
  assert.equal(whole.dropEpub, null);
});

test("replacing old kept EPUBs: without EPUB files a book needs its text only, and a kept EPUB goes once its text is complete", () => {
  assert.equal(KEEP_EPUB_FILE, true, "epub.js still reads the kept EPUB until step 7 (#806) turns this off");
  const tracks = [file("r1", 0)];
  const off = { keepEpub: false };
  // An old kept book: the EPUB file and no text. The text is missing; the EPUB is not needed, and stays until it is.
  const old = keptNeeds(recording("r1", 1), tracks, [], { ...reading(), ebooks: [keptEpub] }, off);
  assert.deepEqual([old.ebook, old.text?.complete, old.dropEpub, old.filesSaved, old.filesTotal], [null, false, null, 1, 2]);
  // Its text is saved: the EPUB file is dropped, and the book is complete with its text.
  const replaced = keptNeeds(recording("r1", 1), tracks, [], withHeld(reading(), [keptEpub]), off);
  assert.deepEqual([replaced.dropEpub, replaced.complete, replaced.size], ["e1", true, 51_000]);
  // Once the file is gone: complete, nothing to drop.
  const after = keptNeeds(recording("r1", 1), tracks, [], { ...reading(), texts: [textOf(keptEpub)] }, off);
  assert.deepEqual([after.dropEpub, after.complete, after.filesTotal], [null, true, 2]);
  // A stale text does not replace the file yet.
  assert.equal(keptNeeds(recording("r1", 1), tracks, [], { ...reading(), ebooks: [keptEpub], texts: [{ ...textOf(keptEpub), stale: true }] }, off).dropEpub, null);
  // The map is matched against the kept text's file where no EPUB file is kept.
  const map = keptNeeds(recording("r1", 1), tracks, [], { ...reading({ readingSync: [job()], maps: { [mapKey]: storedMap() } }), texts: [textOf(keptEpub)] }, off);
  assert.deepEqual([map.map?.complete, map.complete], [true, true]);
});

test("a stopped save: network failures and a closed tab interrupt; a refusal fails; a pause pauses", () => {
  assert.deepEqual(classifyStop({ cause: null, error: new TypeError("Failed to fetch") }), { state: "interrupted", how: "network" });
  assert.deepEqual(classifyStop({ cause: null, error: new Error("The connection was interrupted.") }), { state: "interrupted", how: "network" });
  const stalled = Object.assign(new Error("No audio arrived for 30 seconds."), { name: "RangeStalled" });
  assert.deepEqual(classifyStop({ cause: null, error: stalled }), { state: "interrupted", how: "network" });
  assert.deepEqual(classifyStop({ cause: "closed", error: new DOMException("aborted", "AbortError") }), { state: "interrupted", how: "closed" });
  assert.deepEqual(classifyStop({ cause: "pause", error: null }), { state: "paused" });
  assert.deepEqual(classifyStop({ cause: "off", error: null }), { state: "off" });
  const refused = Object.assign(new Error("The source did not return an audio file."), { refused: true });
  assert.deepEqual(classifyStop({ cause: null, error: refused }), { state: "failed", reason: "The source did not return an audio file.", failure: "source" });
  const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
  assert.equal(isRefusal(quota), true);
  assert.equal(classifyStop({ cause: null, error: quota }).state, "failed");
});

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: StallClock = {
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) {
      timers.delete(id);
      timer.fn();
    }
  };
  return { clock, advance, pending: () => timers.size };
}

test("stall: a range that delivers nothing for 30 seconds is aborted, once", () => {
  const { clock, advance } = fakeClock();
  let stalls = 0;
  stallGuard(clock, () => stalls++);
  advance(STALL_MS - 1);
  assert.equal(stalls, 0);
  advance(1);
  assert.equal(stalls, 1);
  advance(STALL_MS * 3);
  assert.equal(stalls, 1);
});

test("stall: bytes arriving keep the range alive; a stopped watch never fires", () => {
  const { clock, advance, pending } = fakeClock();
  let stalls = 0;
  const guard = stallGuard(clock, () => stalls++);
  for (let i = 0; i < 10; i++) {
    advance(STALL_MS - 1000);
    guard.touch();
  }
  assert.equal(stalls, 0);
  guard.stop();
  assert.equal(pending(), 0);
  advance(STALL_MS * 2);
  assert.equal(stalls, 0);
});

const work = (workId: string, inLibrary: boolean, recordingIds: string[], chosen?: string): KeepWork => ({
  workId,
  inLibrary,
  chosenRecordingId: chosen ?? recordingIds[0] ?? null,
  recordings: recordingIds.map((id) => recording(id, 2)),
});

test("rollout: a complete or partial save of a work in the library turns Keep on", () => {
  const works = [work("complete", true, ["r1"]), work("partial", true, ["r2"]), work("nothing", true, ["r3"])];
  const choices = rolloutChoices({
    works,
    keep: [],
    downloads: [file("r1", 0), file("r1", 1)],
    parts: [{ trackId: "r2-0", recordingId: "r2", loaded: 10 }, { trackId: "r3-0", recordingId: "r3", loaded: 0 }],
  });
  assert.deepEqual(choices, ["complete", "partial"]);
});

test("rollout: a save of a recording that is not the chosen one turns Keep on (the chosen one is then saved)", () => {
  const choices = rolloutChoices({ works: [work("w", true, ["chosen", "earlier"], "chosen")], keep: [], downloads: [file("earlier", 0)], parts: [] });
  assert.deepEqual(choices, ["w"]);
});

test("rollout: a work not in the library keeps its files without Keep; a work with a record keeps its choice", () => {
  assert.deepEqual(rolloutChoices({ works: [work("w", false, ["r1"])], keep: [], downloads: [file("r1", 0)], parts: [] }), []);
  assert.deepEqual(rolloutChoices({ works: [work("w", true, ["r1"])], keep: [local("w", false, 5)], downloads: [file("r1", 0)], parts: [] }), []);
});

test("stored: a choice this device wrote after the run read its records stays; otherwise the merge's record (#707)", () => {
  // Off tapped while the run waited for the server: the merge's On (read before) does not undo it.
  const off = local("w1", false, 9, { pending: true });
  assert.equal(keepStored(local("w1", true, 5), off), off);
  // The record the merge answers is as new or newer: it is stored.
  const merged = local("w1", true, 9, { completeAt: 12 });
  assert.equal(keepStored(merged, local("w1", true, 9)), merged);
  assert.equal(keepStored(merged, local("w1", false, 7)), merged);
  assert.equal(keepStored(merged, undefined), merged);
});
