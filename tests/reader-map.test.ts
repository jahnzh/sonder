// The reader's narration map (#543): which recording's map it loads, and the lifecycle calls the card made in the
// background before the Reading sync page replaced it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReaderMapLoader, READER_MAP_POLL_MS, readerMapRecording } from "../src/reader-map.ts";
import type { AlignmentJob, AlignmentStatus } from "../src/reading-types.ts";

const audio = (recordingId: string, over: { workId?: string; chapters?: boolean; tracks?: number; faulty?: boolean } = {}) => ({
  recordingId,
  workId: over.workId ?? "work",
  tracks: Array.from({ length: over.tracks ?? 1 }, () => ({ chapters: over.chapters ? [{ title: "One" }] : [] })),
  faults: over.faulty ? { recording: { reason: "broken" } } : null,
});
const book = { workId: "work" };

test("the recording the player plays, when it is of this book's work, wins over everything", () => {
  const books = [audio("saved"), audio("chaptered", { chapters: true }), audio("playing")];
  assert.equal(readerMapRecording(book, books, "saved", { workId: "work", recordingId: "playing" }), "playing");
  // A recording of another work in the player is not this book's.
  assert.equal(readerMapRecording(book, books, "saved", { workId: "other", recordingId: "elsewhere" }), "saved");
  assert.equal(readerMapRecording(book, books, "saved", { workId: "work", recordingId: "" }), "saved");
});

test("then the one saved for this ebook, then one with chapters, then the first; none without tracks or faulty", () => {
  const books = [audio("first"), audio("chaptered", { chapters: true }), audio("saved")];
  assert.equal(readerMapRecording(book, books, "saved", null), "saved");
  assert.equal(readerMapRecording(book, books, "gone", null), "chaptered");
  assert.equal(readerMapRecording(book, [audio("first"), audio("second")], null, null), "first");
  assert.equal(readerMapRecording(book, [audio("empty", { tracks: 0 }), audio("broken", { faulty: true }), audio("ok")], "broken", null), "ok");
  assert.equal(readerMapRecording(book, [audio("other", { workId: "else", chapters: true })], "other", null), "");
  assert.equal(readerMapRecording(book, [], null, null), "");
});

const EBOOK = { id: "ebook", fingerprint: "fp" };
const job = (status: AlignmentStatus, over: Partial<AlignmentJob> = {}) => ({ id: "job", recordingId: "rec", status, ...over }) as AlignmentJob;

/** A loader on a scripted lifecycle and hand-run timers, recording every call. */
function harness(script: { cached?: AlignmentJob; jobs: (AlignmentJob | undefined)[] }) {
  const calls: string[] = [];
  const maps: [string | null, boolean][] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  const pending: { resolve: () => void }[] = [];
  let hold = false;
  const loader = createReaderMapLoader({
    lifecycle: {
      restore: async (ebook, recordingId) => {
        calls.push(`restore ${ebook.id} ${recordingId}`);
        return script.cached;
      },
      refresh: async (target) => {
        calls.push(`refresh ${target.ebook.id} ${target.recordingId}`);
        if (hold) await new Promise<void>((resolve) => pending.push({ resolve }));
        const listed = script.jobs.length > 1 ? script.jobs.shift() : script.jobs[0];
        if (!target.isCurrent()) return;
        target.onMap(listed && listed.status === "ready" ? listed : null, !!listed);
        return listed;
      },
    },
    onMap: (map, confirmed) => maps.push([map?.id ?? null, confirmed]),
    setInterval: (run, ms) => {
      assert.equal(ms, READER_MAP_POLL_MS);
      const id = next++;
      timers.set(id, run);
      return id;
    },
    clearInterval: (id) => void timers.delete(id as number),
  });
  return {
    loader, calls, maps, timers,
    tick: async () => {
      for (const run of [...timers.values()]) run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    hold: (value: boolean) => (hold = value),
    release: async () => {
      for (const entry of pending.splice(0)) entry.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test("a load shows the cached map unconfirmed, then reads the listing and the map, and stops there when nothing runs", async () => {
  const h = harness({ cached: job("ready", { id: "cached" }), jobs: [job("ready")] });
  await h.loader.load(EBOOK, "rec");
  assert.deepEqual(h.calls, ["restore ebook rec", "refresh ebook rec"]);
  assert.deepEqual(h.maps, [["cached", false], ["job", true]]);
  assert.equal(h.timers.size, 0, "a finished job is not polled");
});

test("without a recording nothing is restored; the listing is still read", async () => {
  const h = harness({ jobs: [undefined] });
  await h.loader.load(EBOOK, "");
  assert.deepEqual(h.calls, ["refresh ebook "]);
  assert.deepEqual(h.maps, [[null, false]]);
});

test("a running job, or a running rebuild of the map in use, is polled every 4 seconds until it stops", async () => {
  const h = harness({ jobs: [job("processing"), job("processing"), job("ready")] });
  await h.loader.load(EBOOK, "rec");
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.equal(h.timers.size, 1, "still running");
  await h.tick();
  assert.equal(h.timers.size, 0, "finished: the poll stops");
  assert.deepEqual(h.calls, ["restore ebook rec", "refresh ebook rec", "refresh ebook rec", "refresh ebook rec"]);
  assert.deepEqual(h.maps.at(-1), ["job", true]);

  const rebuild = harness({ jobs: [job("ready", { rebuild: { status: "queued" } as AlignmentJob["rebuild"] })] });
  await rebuild.loader.load(EBOOK, "rec");
  assert.equal(rebuild.timers.size, 1, "the map in use is polled while its Prepare again runs");
});

test("an answer of an earlier load, or after forget or stop, never reaches the reader", async () => {
  const h = harness({ jobs: [job("ready")] });
  h.hold(true);
  const first = h.loader.load(EBOOK, "rec");
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.loader.forget();
  assert.deepEqual(h.maps, [[null, false]], "forget drops the map shown");
  await h.release();
  await first;
  assert.deepEqual(h.maps, [[null, false]], "the earlier answer is dropped");
  const second = h.loader.load(EBOOK, "rec");
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.loader.stop();
  await h.release();
  await second;
  assert.deepEqual(h.maps, [[null, false]]);
  assert.equal(h.timers.size, 0);
});

test("a new load or stop ends the poll of the one before", async () => {
  const h = harness({ jobs: [job("processing")] });
  await h.loader.load(EBOOK, "rec");
  assert.equal(h.timers.size, 1);
  await h.loader.load(EBOOK, "other");
  assert.equal(h.timers.size, 1, "one poll, for the new recording");
  h.loader.stop();
  assert.equal(h.timers.size, 0);
});
