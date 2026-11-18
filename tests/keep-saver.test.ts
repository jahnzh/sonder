// The saver of Keep on this device (#550) against a fake transport, a fake Web Lock and a fake channel: one save
// across two "tabs", a save that resumes at the next trigger after an interruption, `persist()` only after a tap.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceSaveRecord } from "../src/device-saves.ts";
import type { HeldEbook, HeldMap, KeepEntry, KeepSend, KeepWork, NeededMapJob, NeededTrack, ServerKeep } from "../src/keep.ts";
import { KeepSaver, type LockManager, type RecordChange, type SaverDeps, type SaverMessage } from "../src/keep-saver.ts";

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const track = (recordingId: string, index: number): NeededTrack => ({
  id: `${recordingId}-${index}`,
  recordingId,
  title: `Track ${index}`,
  index,
  duration: 60,
  source: "",
  sourceType: "local",
});

/** One browser: its device database, the server and the lock all tabs share. */
function device(options: { tracks?: number; works?: { workId: string; inLibrary: boolean; recordingId: string | null; ebookId?: string }[] } = {}) {
  const count = options.tracks ?? 2;
  const works: KeepWork[] = (options.works ?? [{ workId: "w1", inLibrary: true, recordingId: "r1" }]).map((w) => ({
    workId: w.workId,
    inLibrary: w.inLibrary,
    chosenRecordingId: w.recordingId,
    recordings: w.recordingId ? [{ recordingId: w.recordingId, tracks: Array.from({ length: count }, (_, i) => track(w.recordingId!, i)) }] : [],
    ebooks: w.ebookId ? [{ id: w.ebookId, format: "epub", available: true }] : [],
    chosenEbookId: null,
    readingSync: [],
  }));
  // This device's kept EPUBs and maps (#551), and what the saver fetched of them.
  const heldEbooks: HeldEbook[] = [];
  const maps: Record<string, HeldMap> = {};
  const fileSaves: string[] = [];
  /** The map the server answers for a pair, by job. */
  const serverMaps = new Map<string, HeldMap>();
  const keep = new Map<string, KeepEntry>();
  const downloads: { trackId: string; recordingId: string; size: number }[] = [];
  const parts: { trackId: string; recordingId: string; loaded: number }[] = [];
  const records = new Map<string, DeviceSaveRecord>();
  const server = new Map<string, ServerKeep>();
  const sent: KeepSend[] = [];
  const preferences = new Map<string, unknown>();
  let clock = 1_000;

  // The fake lock: granted to one holder at a time, in the order asked; released when the holder's promise settles.
  const held = new Set<string>();
  const queue = new Map<string, (() => void)[]>();
  const locks: LockManager = {
    request: (name, hold) =>
      new Promise((resolve) => {
        const grant = () => {
          held.add(name);
          void hold().finally(() => {
            held.delete(name);
            resolve(undefined);
            queue.get(name)?.shift()?.();
          });
        };
        if (!held.has(name)) grant();
        else queue.set(name, [...(queue.get(name) ?? []), grant]);
      }),
  };
  // The fake channel: a message reaches every other tab.
  const listeners = new Set<{ tab: number; fn: (message: SaverMessage) => void }>();

  const fetchFails = { value: false };
  const saves: string[] = [];
  /** Tracks whose next save fails as the network does. */
  const failNext = new Set<string>();
  const persists: number[] = [];

  function tab(id: number, extra: Partial<SaverDeps> = {}) {
    const running = new Map<string, AbortController>();
    const saver = new KeepSaver({
      account: 1,
      locks,
      channel: {
        post: (message) => {
          for (const listener of listeners) if (listener.tab !== id) queueMicrotask(() => listener.fn(message));
        },
        listen: (fn) => {
          const entry = { tab: id, fn };
          listeners.add(entry);
          return () => listeners.delete(entry);
        },
      },
      read: async () => ({
        works: structuredClone(works),
        keep: [...keep.values()].map((entry) => ({ ...entry })),
        downloads: downloads.map((d) => ({ ...d })),
        parts: parts.map((p) => ({ ...p })),
        records: [...records.values()],
        ebooks: heldEbooks.map((e) => ({ ...e })),
        maps: { ...maps },
      }),
      writeChoice: async (workId, on) => {
        const previous = keep.get(workId);
        keep.set(workId, { workId, on, at: Math.max(++clock, (previous?.at ?? 0) + 1), completeAt: null, pending: true });
      },
      persist: async () => {
        persists.push(id);
        return true;
      },
      storeKeep: async (entries) => {
        for (const entry of entries) keep.set(entry.workId, { ...entry });
      },
      fetchKeep: async () => {
        if (fetchFails.value) throw new TypeError("Failed to fetch");
        return [...server.values()];
      },
      sendKeep: async (send) => {
        sent.push(send);
        const stored = server.get(send.workId);
        const next: ServerKeep =
          send.kind === "complete"
            ? { ...(stored ?? { workId: send.workId, on: true, at: send.completeAt }), completeAt: send.completeAt }
            : send.kind === "off"
              ? { workId: send.workId, on: false, at: send.at, completeAt: null }
              : { workId: send.workId, on: true, at: send.at, completeAt: send.completeAt ?? stored?.completeAt ?? null };
        server.set(send.workId, next);
        return next;
      },
      rolloutDone: async () => preferences.get("keep-rollout") === true,
      markRolloutDone: async () => void preferences.set("keep-rollout", true),
      saveTrack: async (t, signal, onProgress) => {
        signal.throwIfAborted();
        saves.push(`${id}:${t.id}`);
        if (failNext.delete(t.id)) {
          parts.push({ trackId: t.id, recordingId: t.recordingId, loaded: 4 });
          throw new TypeError("Failed to fetch");
        }
        onProgress(10, 10);
        downloads.push({ trackId: t.id, recordingId: t.recordingId, size: 10 });
      },
      saveEbook: async (ebookId, signal) => {
        signal.throwIfAborted();
        fileSaves.push(`${id}:epub:${ebookId}`);
        if (failNext.delete(ebookId)) throw new TypeError("Failed to fetch");
        const index = heldEbooks.findIndex((e) => e.id === ebookId);
        if (index >= 0) heldEbooks.splice(index, 1);
        heldEbooks.push({ id: ebookId, fingerprint: `fp-${ebookId}`, size: 600 });
      },
      saveMap: async (ebookId, recordingId, signal) => {
        signal.throwIfAborted();
        fileSaves.push(`${id}:map:${ebookId}:${recordingId}`);
        const job = works.flatMap((w) => w.readingSync ?? []).find((j) => j.ebookId === ebookId && j.recordingId === recordingId);
        if (job) maps[`reader-map:${ebookId}:${recordingId}`] = serverMaps.get(job.id) ?? { id: job.id, updatedAt: job.updatedAt, fingerprint: job.fingerprint, audioFingerprint: job.audioFingerprint, intervals: [1] };
      },
      writeRecord: async (recordingId, workId, change: RecordChange) => {
        if (change.state === "off") return;
        const previous = records.get(recordingId);
        records.set(recordingId, {
          recordingId,
          workId,
          startedAt: previous?.startedAt ?? clock,
          state: change.state,
          reason: change.state === "failed" ? change.reason : null,
          finishedAt: change.state === "finished" ? clock : null,
          ...(change.state === "interrupted" ? { how: change.how } : {}),
        });
      },
      online: () => true,
      running,
      onJob: () => {},
      onChanged: () => {},
      now: () => ++clock,
      ...extra,
    });
    return { saver, running };
  }
  return { tab, keep, downloads, parts, records, server, sent, saves, failNext, persists, fetchFails, preferences, works, heldEbooks, maps, fileSaves };
}

test("two tabs: the one holding the lock saves; a tap in the other saves the book once", async () => {
  const d = device();
  const a = d.tab(1);
  const b = d.tab(2);
  a.saver.start();
  b.saver.start();
  await settle();
  assert.equal(a.saver.isLeader, true);
  assert.equal(b.saver.isLeader, false);
  // The switch is turned on in the tab that does not save.
  await b.saver.tap("w1", true);
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-1"], "tab 1 saved each file once; tab 2 saved nothing");
  assert.equal(d.records.get("r1")?.state, "finished");
  // The choice and the completion reached the server.
  assert.equal(d.server.get("w1")?.on, true);
  assert.equal(typeof d.server.get("w1")?.completeAt, "number");
  // Another trigger in either tab saves nothing again.
  await b.saver.trigger("foreground");
  await a.saver.trigger("online");
  await settle();
  assert.equal(d.saves.length, 2);
});

test("a closed leader hands the lock over: the other tab resumes the save at its next run", async () => {
  const d = device({ tracks: 3 });
  const a = d.tab(1);
  const b = d.tab(2);
  d.keep.set("w1", { workId: "w1", on: true, at: 5, completeAt: null, pending: true });
  d.failNext.add("r1-1");
  a.saver.start();
  b.saver.start();
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-1"]);
  assert.deepEqual(d.records.get("r1")?.state, "interrupted");
  assert.equal(d.records.get("r1")?.how, "network");
  a.saver.stop("closed");
  await settle();
  assert.equal(b.saver.isLeader, true);
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-1", "2:r1-1", "2:r1-2"], "the save resumed from the missing file in tab 2");
  assert.equal(d.records.get("r1")?.state, "finished");
});

test("an interrupted save resumes by itself at the next trigger, from the files it lacks", async () => {
  const d = device({ tracks: 3 });
  const a = d.tab(1);
  a.saver.start();
  await settle();
  d.failNext.add("r1-1");
  await a.saver.tap("w1", true);
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-1"]);
  assert.equal(d.records.get("r1")?.state, "interrupted");
  assert.equal(d.server.get("w1")?.completeAt, null);
  // Back in the foreground (no tap): the save carries on.
  await a.saver.trigger("foreground");
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-1", "1:r1-1", "1:r1-2"]);
  assert.equal(d.records.get("r1")?.state, "finished");
  assert.equal(typeof d.server.get("w1")?.completeAt, "number");
});

test("a paused or failed save waits for a tap; the tap saves it", async () => {
  const d = device();
  const a = d.tab(1);
  d.keep.set("w1", { workId: "w1", on: true, at: 5, completeAt: null, pending: false });
  d.server.set("w1", { workId: "w1", on: true, at: 5, completeAt: null });
  d.records.set("r1", { recordingId: "r1", workId: "w1", startedAt: 1, state: "paused" });
  d.preferences.set("keep-rollout", true);
  a.saver.start();
  await settle();
  await a.saver.trigger("foreground");
  await settle();
  assert.deepEqual(d.saves, []);
  await a.saver.trigger("retry", "w1");
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-1"]);
});

test("persist() is asked only after a tap on: not when Sonder opens, not by the rollout, not by Off", async () => {
  const d = device({ works: [{ workId: "w1", inLibrary: true, recordingId: "r1" }, { workId: "w2", inLibrary: true, recordingId: "r2" }] });
  d.downloads.push({ trackId: "r1-0", recordingId: "r1", size: 10 });
  const a = d.tab(1);
  a.saver.start();
  await settle();
  await a.saver.trigger("foreground");
  await a.saver.trigger("library");
  await settle();
  // The rollout turned Keep on for w1 (sent to the server) and saved its missing file, without persist().
  assert.equal(d.server.get("w1")?.on, true);
  assert.ok(d.saves.includes("1:r1-1"));
  assert.deepEqual(d.persists, []);
  await a.saver.tap("w2", true);
  await settle();
  assert.deepEqual(d.persists, [1]);
  await a.saver.tap("w2", false);
  await settle();
  assert.deepEqual(d.persists, [1]);
  assert.equal(d.server.get("w2")?.on, false);
});

test("the rollout runs once, after the server's records are read, and leaves a server choice and a book outside the library alone", async () => {
  const d = device({
    works: [
      { workId: "kept", inLibrary: true, recordingId: "r1" },
      { workId: "offOnServer", inLibrary: true, recordingId: "r2" },
      { workId: "outside", inLibrary: false, recordingId: "r3" },
    ],
  });
  d.downloads.push({ trackId: "r1-0", recordingId: "r1", size: 10 }, { trackId: "r2-0", recordingId: "r2", size: 10 }, { trackId: "r3-0", recordingId: "r3", size: 10 });
  d.server.set("offOnServer", { workId: "offOnServer", on: false, at: 3, completeAt: null });
  // Without a connection the rollout waits.
  d.fetchFails.value = true;
  const a = d.tab(1);
  a.saver.start();
  await settle();
  assert.equal(d.preferences.get("keep-rollout"), undefined);
  assert.equal(d.keep.size, 0);
  d.fetchFails.value = false;
  await a.saver.trigger("online");
  await settle();
  assert.equal(d.preferences.get("keep-rollout"), true);
  assert.equal(d.keep.get("kept")?.on, true);
  assert.equal(d.keep.get("offOnServer")?.on, false);
  assert.equal(d.keep.has("outside"), false);
  assert.ok(!d.saves.some((s) => s.includes("r3")), "the files of a book outside the library are left as they are");
  // Turned off later, the rollout does not turn it on again.
  await a.saver.tap("kept", false);
  await settle();
  await a.saver.trigger("open");
  await settle();
  assert.equal(d.keep.get("kept")?.on, false);
});

test("a choice made offline is sent at the next run with a connection", async () => {
  const d = device();
  let online = false;
  const a = d.tab(1, { online: () => online });
  a.saver.start();
  await settle();
  await a.saver.tap("w1", true);
  await settle();
  assert.equal(d.server.size, 0);
  assert.deepEqual(d.saves, []);
  assert.equal(d.keep.get("w1")?.pending, true);
  online = true;
  await a.saver.trigger("online");
  await settle();
  assert.equal(d.server.get("w1")?.on, true);
  assert.equal(d.keep.get("w1")?.pending, false);
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-1"]);
});

// #551: a kept book also keeps its chosen EPUB and the pair's map, after the recording, and whatever of them arrives later.
const readyJob = (extra: Partial<NeededMapJob> = {}): NeededMapJob => ({
  id: "job-1",
  ebookId: "e1",
  recordingId: "r1",
  status: "ready",
  updatedAt: 100,
  fingerprint: "fp-e1",
  audioFingerprint: "fp-audio",
  intervalCount: 12,
  ...extra,
});
const keptOn = (d: ReturnType<typeof device>, workId = "w1") => {
  d.keep.set(workId, { workId, on: true, at: 5, completeAt: null, pending: false });
  d.server.set(workId, { workId, on: true, at: 5, completeAt: null });
  d.preferences.set("keep-rollout", true);
};

test("the saver saves the recording, then the EPUB, then the map; the save counts all of them", async () => {
  const d = device({ works: [{ workId: "w1", inLibrary: true, recordingId: "r1", ebookId: "e1" }] });
  d.works[0].readingSync = [readyJob()];
  const jobs: { chapter: number; total: number }[] = [];
  const a = d.tab(1, { onJob: (_id, job) => job && jobs.push({ chapter: job.chapter, total: job.total }) });
  a.saver.start();
  await settle();
  await a.saver.tap("w1", true);
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-1"]);
  assert.deepEqual(d.fileSaves, ["1:epub:e1", "1:map:e1:r1"]);
  // Two tracks, the EPUB and the map: four files, the last one being saved as the fourth.
  assert.deepEqual([...new Set(jobs.map((j) => j.total))], [4]);
  assert.equal(Math.max(...jobs.map((j) => j.chapter)), 4);
  assert.equal(d.records.get("r1")?.state, "finished");
  assert.equal(typeof d.server.get("w1")?.completeAt, "number", "complete with all three");
  // Nothing is saved twice.
  await a.saver.trigger("foreground");
  await settle();
  assert.deepEqual(d.fileSaves, ["1:epub:e1", "1:map:e1:r1"]);
});

test("a book that is complete except for its map is not reported complete; the map is fetched when it becomes ready", async () => {
  const d = device({ works: [{ workId: "w1", inLibrary: true, recordingId: "r1", ebookId: "e1" }] });
  keptOn(d);
  d.downloads.push({ trackId: "r1-0", recordingId: "r1", size: 10 }, { trackId: "r1-1", recordingId: "r1", size: 10 });
  d.heldEbooks.push({ id: "e1", fingerprint: "fp-e1", size: 600 });
  // The map is still being prepared: not needed yet, the book is complete without it.
  d.works[0].readingSync = [readyJob({ status: "processing", intervalCount: 0 })];
  const a = d.tab(1);
  a.saver.start();
  await settle();
  assert.deepEqual(d.fileSaves, []);
  const first = d.server.get("w1")?.completeAt;
  assert.equal(typeof first, "number");
  // A library read says the map is ready: the next run saves it, with no tap.
  d.works[0].readingSync = [readyJob()];
  await a.saver.trigger("library");
  await settle();
  assert.deepEqual(d.fileSaves, ["1:map:e1:r1"]);
  assert.deepEqual(d.saves, [], "the tracks are not fetched again");
  // Prepare again published a new run: the stored map is stale and saved again, with no tap.
  d.works[0].readingSync = [readyJob({ id: "job-2", updatedAt: 200 })];
  await a.saver.trigger("library");
  await settle();
  assert.deepEqual(d.fileSaves, ["1:map:e1:r1", "1:map:e1:r1"]);
  assert.equal(d.maps["reader-map:e1:r1"]?.id, "job-2");
});

test("an ebook arriving for a kept audiobook is saved without a tap; a new chosen EPUB too", async () => {
  const d = device();
  keptOn(d);
  d.downloads.push({ trackId: "r1-0", recordingId: "r1", size: 10 }, { trackId: "r1-1", recordingId: "r1", size: 10 });
  const a = d.tab(1);
  a.saver.start();
  await settle();
  assert.deepEqual(d.fileSaves, []);
  d.works[0].ebooks = [{ id: "e1", format: "epub", available: true }];
  await a.saver.trigger("library");
  await settle();
  assert.deepEqual(d.fileSaves, ["1:epub:e1"]);
  // The shared default moves to another edition: that one is saved; the earlier copy stays.
  d.works[0].ebooks = [...d.works[0].ebooks!, { id: "e2", format: "epub", available: true }];
  d.works[0].chosenEbookId = "e2";
  await a.saver.trigger("library");
  await settle();
  assert.deepEqual(d.fileSaves, ["1:epub:e1", "1:epub:e2"]);
  assert.deepEqual(d.heldEbooks.map((e) => e.id), ["e1", "e2"]);
  // A PDF arriving is never saved.
  d.works[0].ebooks = [...d.works[0].ebooks!, { id: "p1", format: "pdf", available: true }];
  await a.saver.trigger("library");
  await settle();
  assert.deepEqual(d.fileSaves, ["1:epub:e1", "1:epub:e2"]);
});

test("a book with only an ebook keeps its EPUB; an interrupted EPUB save resumes at the next run", async () => {
  const d = device({ works: [{ workId: "w1", inLibrary: true, recordingId: null, ebookId: "e1" }] });
  keptOn(d);
  d.failNext.add("e1");
  const a = d.tab(1);
  a.saver.start();
  await settle();
  assert.deepEqual(d.fileSaves, ["1:epub:e1"]);
  assert.equal(d.server.get("w1")?.completeAt, null);
  await a.saver.trigger("online");
  await settle();
  assert.deepEqual(d.fileSaves, ["1:epub:e1", "1:epub:e1"]);
  assert.equal(typeof d.server.get("w1")?.completeAt, "number");
  // A book without a recording keeps its save record under its EPUB's save id (#552: a failure there waits for Retry).
  assert.deepEqual([...d.records.keys()], ["ebook:e1"]);
  assert.equal(d.records.get("ebook:e1")?.state, "finished");
});

/** A refusal as `downloadInChunks` throws it: the source refused, the account is signed out, or the device is full. */
const refusedBy = (failure: "source" | "signed-out" | "full") =>
  Object.assign(new Error(failure === "full" ? "This device has run out of storage." : "Refused"), { name: "DownloadRefused", refused: true, failure });

test("a failed save waits for Retry; it is tried again by itself only after a library read that changed (#552)", async () => {
  const d = device();
  let refuse = true;
  const failures: string[] = [];
  const a = d.tab(1, {
    saveTrack: async (t, signal, onProgress) => {
      signal.throwIfAborted();
      d.saves.push(`1:${t.id}`);
      if (refuse) throw refusedBy("source");
      onProgress(10, 10);
      d.downloads.push({ trackId: t.id, recordingId: t.recordingId, size: 10 });
    },
    writeRecord: async (recordingId, workId, change) => {
      if (change.state === "off") return;
      if (change.state === "failed") failures.push(change.failure);
      d.records.set(recordingId, { recordingId, workId, startedAt: 1, state: change.state, reason: change.state === "failed" ? change.reason : null });
    },
  });
  a.saver.start();
  await settle();
  await a.saver.tap("w1", true);
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0"]);
  assert.equal(d.records.get("r1")?.state, "failed");
  assert.deepEqual(failures, ["source"]);
  // Foreground, online and a reopened Sonder do not try it again.
  for (const reason of ["foreground", "online", "open"] as const) await a.saver.trigger(reason);
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0"], "a failed save waits");
  // A library read that changed tries it once more by itself.
  await a.saver.trigger("library");
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-0"]);
  // Retry saves it.
  refuse = false;
  await a.saver.trigger("retry", "w1");
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-0", "1:r1-0", "1:r1-1"]);
  assert.equal(d.records.get("r1")?.state, "finished");
});

test("Pause writes pausedAt on the Keep record from any tab; the save waits for Resume, also after a reload (#552)", async () => {
  const d = device({ tracks: 3 });
  const pause = {
    writePause: async (workId: string, pausedAt: number | null) => {
      const entry = d.keep.get(workId);
      if (entry) d.keep.set(workId, { ...entry, pausedAt });
    },
    isPaused: async (workId: string) => !!d.keep.get(workId)?.pausedAt,
  };
  let release: () => void = () => {};
  let hold = true;
  const saveTrack: SaverDeps["saveTrack"] = async (t, signal, onProgress) => {
    signal.throwIfAborted();
    d.saves.push(t.id);
    if (hold && t.id === "r1-1")
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    onProgress(10, 10);
    d.downloads.push({ trackId: t.id, recordingId: t.recordingId, size: 10 });
  };
  const a = d.tab(1, { ...pause, saveTrack });
  const b = d.tab(2, { ...pause, saveTrack });
  a.saver.start();
  b.saver.start();
  await settle();
  await a.saver.tap("w1", true);
  await settle();
  assert.deepEqual(d.saves, ["r1-0", "r1-1"]);
  // Pause in the tab that does not save: the Keep record says so and the saving tab stops.
  await b.saver.pauseWork("w1", "r1");
  await settle();
  assert.equal(typeof d.keep.get("w1")?.pausedAt, "number");
  assert.equal(d.records.get("r1")?.state, "paused");
  assert.equal(a.running.size, 0);
  // A reload: the records stay, a new tab takes over; nothing is saved while the pause stands.
  a.saver.stop("closed");
  b.saver.stop("closed");
  d.records.set("r1", { ...d.records.get("r1")!, state: "interrupted" });
  const c = d.tab(3, { ...pause, saveTrack });
  c.saver.start();
  await settle();
  await c.saver.trigger("foreground");
  await c.saver.trigger("library");
  await settle();
  assert.deepEqual(d.saves, ["r1-0", "r1-1"], "a paused save waits for Resume");
  // Nothing even starts: the save record stays as the reload left it.
  assert.equal(d.records.get("r1")?.state, "interrupted");
  // Resume clears the pause and saves the rest.
  hold = false;
  await c.saver.resumeWork("w1");
  await settle();
  assert.ok(!d.keep.get("w1")?.pausedAt, "the pause is gone");
  assert.deepEqual(d.saves, ["r1-0", "r1-1", "r1-1", "r1-2"]);
  assert.equal(d.records.get("r1")?.state, "finished");
  void release;
});

test("a pause written in another tab whose message is lost stops the save before its next file (#552)", async () => {
  const d = device({ tracks: 3 });
  const a = d.tab(1, {
    channel: null,
    isPaused: async (workId) => !!d.keep.get(workId)?.pausedAt,
    saveTrack: async (t, signal, onProgress) => {
      signal.throwIfAborted();
      d.saves.push(t.id);
      // Another tab pauses while the first file is saved; no channel carries it here.
      if (t.id === "r1-0") d.keep.set("w1", { ...d.keep.get("w1")!, pausedAt: 7 });
      onProgress(10, 10);
      d.downloads.push({ trackId: t.id, recordingId: t.recordingId, size: 10 });
    },
  });
  a.saver.start();
  await settle();
  await a.saver.tap("w1", true);
  await settle();
  assert.deepEqual(d.saves, ["r1-0"]);
  assert.equal(d.records.get("r1")?.state, "paused");
});

/** A tab whose saver remembers a cleared device (#554) in the fake device database, and what it saw while saving. */
function clearedTab(d: ReturnType<typeof device>, id = 1) {
  const noticedWhileSaving: unknown[] = [];
  const tab = d.tab(id, {
    clearedAt: async () => (d.preferences.get("keep-cleared-at") as number | undefined) ?? null,
    setClearedAt: async (at) => void (at === null ? d.preferences.delete("keep-cleared-at") : d.preferences.set("keep-cleared-at", at)),
    saveTrack: async (t, signal, onProgress) => {
      signal.throwIfAborted();
      d.saves.push(`${id}:${t.id}`);
      noticedWhileSaving.push(d.preferences.get("keep-cleared-at") ?? null);
      if (d.failNext.delete(t.id)) {
        d.parts.push({ trackId: t.id, recordingId: t.recordingId, loaded: 4 });
        throw new TypeError("Failed to fetch");
      }
      onProgress(10, 10);
      d.downloads.push({ trackId: t.id, recordingId: t.recordingId, size: 10 });
    },
  });
  return { ...tab, noticedWhileSaving };
}

test("a cleared device notices once its library is read, takes the server's record over and saves the book again without a tap (#554)", async () => {
  const d = device({ tracks: 2 });
  // The server says this device completed w1; the device database and the files are empty, its library too.
  d.server.set("w1", { workId: "w1", on: true, at: 5, completeAt: 6 });
  const stored = d.works.splice(0);
  const a = clearedTab(d);
  a.saver.start();
  await settle();
  assert.equal(d.preferences.get("keep-cleared-at"), undefined, "nothing noticed before the library is read");
  assert.equal(d.keep.has("w1"), false, "the completed record waits for the library");
  assert.deepEqual(d.saves, []);
  // The library read stores the works: the device notices, takes the record over and saves the book.
  d.works.push(...stored);
  await a.saver.trigger("library");
  await settle();
  assert.deepEqual(d.saves, ["1:r1-0", "1:r1-1"], "saved again by itself");
  assert.deepEqual(d.persists, [], "no persist() without a tap");
  assert.equal(d.keep.get("w1")?.on, true, "the server's record taken over");
  assert.equal(a.noticedWhileSaving.every((at) => typeof at === "number"), true, "the note shows while the book saves");
  assert.equal(d.preferences.get("keep-cleared-at"), undefined, "the note ends once the kept book is complete again");
  assert.ok((d.server.get("w1")?.completeAt ?? 0) > 6, "the completion is reported again");
  // Saved again, the device holds the book: a later run notices nothing.
  await a.saver.trigger("foreground");
  await settle();
  assert.equal(d.preferences.get("keep-cleared-at"), undefined);
  assert.equal(d.saves.length, 2);
});

test("a cleared device's note stays while a kept book is not complete, and keeps the day it was first noticed (#554)", async () => {
  const d = device({ tracks: 3 });
  d.server.set("w1", { workId: "w1", on: true, at: 5, completeAt: 6 });
  d.failNext.add("r1-1");
  const a = clearedTab(d);
  a.saver.start();
  await settle();
  const noticed = d.preferences.get("keep-cleared-at");
  assert.equal(typeof noticed, "number", "noticed at the first run");
  assert.equal(d.records.get("r1")?.state, "interrupted");
  // The next trigger resumes; the day stays the first one until the note ends.
  d.failNext.add("r1-2");
  await a.saver.trigger("online");
  await settle();
  assert.equal(d.preferences.get("keep-cleared-at"), noticed);
  await a.saver.trigger("foreground");
  await settle();
  assert.equal(d.records.get("r1")?.state, "finished");
  assert.equal(d.preferences.get("keep-cleared-at"), undefined);
});

test("a device that already shows the note keeps its day when it notices another cleared book (#554)", async () => {
  const d = device({ tracks: 1 });
  // Noticed on an earlier day; the device database lost the book's record and files again before it was complete.
  d.preferences.set("keep-cleared-at", 7);
  d.server.set("w1", { workId: "w1", on: true, at: 5, completeAt: 6 });
  d.failNext.add("r1-0");
  const a = clearedTab(d);
  a.saver.start();
  await settle();
  assert.equal(d.keep.get("w1")?.on, true);
  assert.equal(d.preferences.get("keep-cleared-at"), 7);
});

test("no cleared note for a work never completed here, a record turned off, or a device that kept its record (#554)", async () => {
  const d = device({ works: [{ workId: "never", inLibrary: true, recordingId: "rn" }, { workId: "off", inLibrary: true, recordingId: "ro" }, { workId: "kept", inLibrary: true, recordingId: "rk" }] });
  d.server.set("never", { workId: "never", on: true, at: 5, completeAt: null });
  d.server.set("off", { workId: "off", on: false, at: 5, completeAt: null });
  d.server.set("kept", { workId: "kept", on: true, at: 5, completeAt: 6 });
  d.keep.set("kept", { workId: "kept", on: true, at: 5, completeAt: 6, pending: false });
  const a = clearedTab(d);
  a.saver.start();
  await settle();
  assert.equal(d.preferences.get("keep-cleared-at"), undefined);
  assert.deepEqual(a.noticedWhileSaving.filter((at) => at !== null), []);
  // The books themselves are saved as Keep says (#550): the record never completed here and the kept one.
  assert.deepEqual(d.saves.sort(), ["1:rk-0", "1:rk-1", "1:rn-0", "1:rn-1"]);
});
