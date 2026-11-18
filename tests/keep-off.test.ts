// Turning Keep off and an earlier recording's copy (#553), with plain data: the size of a book on this device
// (recordings, partial sections, earlier copies, the EPUB, the maps), what Off removes, the earlier copies after a
// change of recording, after choosing it again and after its recording left the library; and the saver removing
// the files of a book whose Keep record a merge turned off, against fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceBook, rememberEbook, rememberRecording, turnedOffFromServer, type DeviceBookInput } from "../src/keep-device.ts";
import { mergeKeep, type KeepEntry, type KeepWork, type NeededTrack, type ServerKeep } from "../src/keep.ts";
import { KeepSaver, type SaverDeps } from "../src/keep-saver.ts";

const MB = 1_000_000;

/** A book with two recordings, r1 (Ann) and r2 (Bo), an EPUB e1, and another book w2 beside it. */
function input(change: Partial<DeviceBookInput> = {}): DeviceBookInput {
  return {
    workId: "w1",
    recordings: [
      { recordingId: "r1", narrator: "Ann" },
      { recordingId: "r2", narrator: "Bo" },
    ],
    chosenRecordingId: "r2",
    ebookIds: ["e1"],
    records: [
      { recordingId: "r2", workId: "w1" },
      { recordingId: "o1", workId: "w2" },
    ],
    downloads: [
      { trackId: "r1-0", recordingId: "r1", size: 200 * MB },
      { trackId: "r1-1", recordingId: "r1", size: 212 * MB },
      { trackId: "r2-0", recordingId: "r2", size: 300 * MB },
      { trackId: "o1-0", recordingId: "o1", size: 999 * MB },
    ],
    parts: [
      // A section of r2's second file, and a stale section of a file already complete (not counted twice).
      { trackId: "r2-1", recordingId: "r2", loaded: 40 * MB },
      { trackId: "r2-0", recordingId: "r2", loaded: 300 * MB },
      { trackId: "o1-1", recordingId: "o1", loaded: 5 * MB },
    ],
    ebookCopies: [{ id: "e1", size: 1 * MB }],
    maps: [
      { key: "reader-map:e1:r2", size: 50_000 },
      { key: "reader-map:e1:r1", size: 40_000 },
      // The book's EPUB paired with a recording no longer listed anywhere: still the book's map.
      { key: "reader-map:e1:gone", size: 10_000 },
      { key: "reader-map:e9:o1", size: 70_000 },
    ],
    ...change,
  };
}

test("the size of a book on this device: every recording's files and sections, the EPUB and the maps, nothing of another book", () => {
  const book = deviceBook(input());
  // r1 412 MB (an earlier copy), r2 300 MB plus a 40 MB section, the EPUB 1 MB, the three maps 100 KB.
  assert.equal(book.size, 412 * MB + 340 * MB + 1 * MB + 100_000);
  assert.equal(book.any, true);
});

test("what Off removes: both recordings (complete and partial), the EPUB copy, the maps and the save records; nothing of another book", () => {
  const book = deviceBook(input());
  assert.deepEqual(book.recordingIds, ["r1", "r2"]);
  assert.deepEqual(book.ebookIds, ["e1"]);
  assert.deepEqual(book.mapKeys, ["reader-map:e1:r2", "reader-map:e1:r1", "reader-map:e1:gone"]);
  assert.deepEqual(book.saveIds.sort(), ["ebook:e1", "r1", "r2"]);
  for (const list of [book.recordingIds, book.saveIds, book.mapKeys]) assert.ok(!list.some((id) => id.includes("o1")));
});

test("a recording with only a section here, or only a save record, is removed by Off too", () => {
  const book = deviceBook(
    input({
      downloads: [],
      parts: [{ trackId: "r1-0", recordingId: "r1", loaded: 3 * MB }],
      records: [{ recordingId: "r2", workId: "w1" }],
      ebookCopies: [],
      maps: [],
    }),
  );
  assert.deepEqual(book.recordingIds, ["r1", "r2"]);
  assert.equal(book.size, 3 * MB);
  // The section of r1 is an earlier copy; r2 (only a record) has no file to list.
  assert.deepEqual(book.earlier, [{ recordingId: "r1", narrator: "Ann", size: 3 * MB }]);
});

test("nothing on this device: no size, nothing to ask about", () => {
  const book = deviceBook(input({ downloads: [], parts: [], records: [], ebookCopies: [], maps: [] }));
  assert.equal(book.any, false);
  assert.equal(book.size, 0);
  assert.deepEqual(book.recordingIds, []);
  assert.deepEqual(book.earlier, []);
});

test("after a change of recording the earlier one is an earlier copy with its narrator and size", () => {
  const book = deviceBook(input());
  assert.deepEqual(book.earlier, [{ recordingId: "r1", narrator: "Ann", size: 412 * MB }]);
});

test("choosing it again makes it the kept one: the other recording with files is the earlier copy", () => {
  const book = deviceBook(input({ chosenRecordingId: "r1" }));
  assert.deepEqual(book.earlier, [{ recordingId: "r2", narrator: "Bo", size: 340 * MB }]);
  // With only the chosen one's files here, there is no earlier copy.
  const alone = deviceBook(input({ chosenRecordingId: "r1", downloads: input().downloads.filter((d) => d.recordingId !== "r2"), parts: [] }));
  assert.deepEqual(alone.earlier, []);
});

test("an earlier copy whose recording left the library is named from the Keep record, and Off still removes it", () => {
  const left = input({ recordings: [{ recordingId: "r2", narrator: "Bo" }], remembered: [{ recordingId: "r1", narrator: "Ann" }] });
  const book = deviceBook(left);
  assert.deepEqual(book.earlier, [{ recordingId: "r1", narrator: "Ann", size: 412 * MB }]);
  assert.ok(book.recordingIds.includes("r1"));
  assert.equal(book.size, 412 * MB + 340 * MB + 1 * MB + 100_000);
  // Without the record's name it is found by its save record and listed without a narrator.
  const unnamed = deviceBook({ ...left, remembered: [], records: [...left.records, { recordingId: "r1", workId: "w1" }] });
  assert.deepEqual(unnamed.earlier, [{ recordingId: "r1", narrator: "", size: 412 * MB }]);
});

test("rememberRecording adds a recording once and brings its narrator up to date", () => {
  const one = rememberRecording(undefined, { recordingId: "r1", narrator: "Ann" });
  assert.deepEqual(one, [{ recordingId: "r1", narrator: "Ann" }]);
  assert.equal(rememberRecording(one, { recordingId: "r1", narrator: "Ann" }), one, "unchanged: the same list");
  assert.deepEqual(rememberRecording(one, { recordingId: "r2", narrator: "Bo" }), [one[0], { recordingId: "r2", narrator: "Bo" }]);
  assert.deepEqual(rememberRecording(one, { recordingId: "r1", narrator: "Annie" }), [{ recordingId: "r1", narrator: "Annie" }]);
});

test("rememberEbook adds an EPUB once", () => {
  const one = rememberEbook(undefined, "e1");
  assert.deepEqual(one, ["e1"]);
  assert.equal(rememberEbook(one, "e1"), one);
  assert.deepEqual(rememberEbook(one, "e2"), ["e1", "e2"]);
});

test("turnedOffFromServer: on before the merge and off after it; an off made here or a record never on is not", () => {
  const before = [
    { workId: "a", on: true },
    { workId: "b", on: false },
    { workId: "c", on: true },
  ];
  const after = [
    { workId: "a", on: false },
    { workId: "b", on: false },
    { workId: "c", on: true },
    { workId: "d", on: false },
  ];
  assert.deepEqual(turnedOffFromServer(before, after), ["a"]);
});

test("the merge keeps the recordings this device saved for the book when the server's record wins", () => {
  const local: KeepEntry[] = [{ workId: "w1", on: true, at: 5, completeAt: null, pending: false, recordings: [{ recordingId: "r1", narrator: "Ann" }], ebookIds: ["e1"] }];
  const merged = mergeKeep(local, [{ workId: "w1", on: true, at: 9, completeAt: 10 }]);
  assert.deepEqual(merged.records[0].recordings, [{ recordingId: "r1", narrator: "Ann" }]);
  assert.deepEqual(merged.records[0].ebookIds, ["e1"]);
  // Turned off from the server, the record still names what to remove.
  assert.deepEqual(mergeKeep(local, [{ workId: "w1", on: false, at: 9, completeAt: null }]).records[0].ebookIds, ["e1"]);
});

// The saver against fakes: a merge that turns a kept book off removes its files; a change of recording saves the
// new one and leaves the earlier one's files.
const track = (recordingId: string, index: number): NeededTrack => ({ id: `${recordingId}-${index}`, recordingId, title: "", index, duration: 60, source: "", sourceType: "local" });

function saverWith(options: { server: ServerKeep[]; keep: KeepEntry[]; chosen?: string }) {
  const works: KeepWork[] = [
    {
      workId: "w1",
      inLibrary: true,
      chosenRecordingId: options.chosen ?? "r1",
      recordings: [
        { recordingId: "r1", narrator: "Ann", tracks: [track("r1", 0)] },
        { recordingId: "r2", narrator: "Bo", tracks: [track("r2", 0)] },
      ],
    },
  ];
  const keep = new Map(options.keep.map((e) => [e.workId, { ...e }]));
  const downloads = [{ trackId: "r1-0", recordingId: "r1", size: 10 }];
  const removed: string[] = [];
  const saved: string[] = [];
  const remembered: unknown[] = [];
  let clock = 100;
  const deps: SaverDeps = {
    account: 1,
    locks: null,
    channel: null,
    read: async () => ({ works, keep: [...keep.values()].map((e) => ({ ...e })), downloads: downloads.map((d) => ({ ...d })), parts: [], records: [] }),
    writeChoice: async () => {},
    persist: async () => true,
    storeKeep: async (records) => {
      for (const r of records) keep.set(r.workId, { ...keep.get(r.workId), ...r });
    },
    fetchKeep: async () => options.server,
    sendKeep: async (send) => ({ workId: send.workId, on: send.kind !== "off", at: "at" in send ? send.at : clock, completeAt: null }),
    rolloutDone: async () => true,
    markRolloutDone: async () => {},
    saveTrack: async (t) => {
      saved.push(t.id);
      downloads.push({ trackId: t.id, recordingId: t.recordingId, size: 10 });
    },
    writeRecord: async () => {},
    removeWork: async (workId) => {
      removed.push(workId);
      downloads.splice(0);
    },
    remember: async (workId, recordings) => {
      remembered.push([workId, recordings]);
    },
    online: () => true,
    running: new Map(),
    onJob: () => {},
    onChanged: () => {},
    now: () => ++clock,
  };
  return { saver: new KeepSaver(deps), removed, saved, downloads, remembered, keep };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("a Keep record that turns off from the server (Remove from library on any device) removes the files at the next run", async () => {
  const s = saverWith({
    keep: [{ workId: "w1", on: true, at: 5, completeAt: 6, pending: false }],
    server: [{ workId: "w1", on: false, at: 9, completeAt: null }],
  });
  s.saver.start();
  await settle();
  assert.deepEqual(s.removed, ["w1"]);
  assert.equal(s.downloads.length, 0);
  assert.deepEqual(s.saved, [], "nothing is saved again");
  // The next run removes nothing more: the record was already off.
  await s.saver.trigger("foreground");
  await settle();
  assert.deepEqual(s.removed, ["w1"]);
});

test("an off made on this device is not removed again by the saver (Off removed the files itself)", async () => {
  const s = saverWith({
    keep: [{ workId: "w1", on: false, at: 9, completeAt: null, pending: true }],
    server: [{ workId: "w1", on: true, at: 5, completeAt: 6 }],
  });
  s.saver.start();
  await settle();
  assert.deepEqual(s.removed, []);
  assert.equal(s.downloads.length, 1);
});

test("a change of recording saves the new one and leaves the earlier one's files; the kept one is remembered with its narrator", async () => {
  const s = saverWith({
    chosen: "r2",
    keep: [{ workId: "w1", on: true, at: 5, completeAt: 6, pending: false, recordings: [{ recordingId: "r1", narrator: "Ann" }] }],
    server: [{ workId: "w1", on: true, at: 5, completeAt: 6 }],
  });
  s.saver.start();
  await settle();
  assert.deepEqual(s.saved, ["r2-0"]);
  assert.deepEqual(s.removed, []);
  assert.ok(s.downloads.some((d) => d.recordingId === "r1"), "the earlier copy stays");
  assert.deepEqual(s.remembered, [["w1", { recordings: [{ recordingId: "r1", narrator: "Ann" }, { recordingId: "r2", narrator: "Bo" }], ebookIds: [] }]]);
});
