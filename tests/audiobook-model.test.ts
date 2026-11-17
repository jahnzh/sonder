// The Audiobook page's words and choices (#530, src/pages/audiobook-model.ts), as plain data.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audiobookRowLine,
  copyRows,
  FAULT_REASONS,
  lengthLine,
  markDetail,
  markName,
  playsFromOptions,
  recordingChoices,
  recordingDetail,
  reportScopes,
  type CopyFacts,
} from "../src/pages/audiobook-model.ts";
import type { WorkRecording } from "../src/types.ts";

const fault = { reason: "wrong-language" as const, note: "", updatedAt: 1 };

test("a recording's length reads as the boards write it", () => {
  assert.equal(lengthLine(9 * 3600 + 12 * 60), "9 h 12 min");
  assert.equal(lengthLine(9 * 3600 + 12 * 60 + 20), "9 h 12 min");
  assert.equal(lengthLine(2 * 3600), "2 h");
  assert.equal(lengthLine(42 * 60), "42 min");
  assert.equal(lengthLine(20), "1 min");
  assert.equal(lengthLine(0), "");
  assert.equal(lengthLine(Number.NaN), "");
});

const recording = (over: Partial<WorkRecording>): WorkRecording => ({
  recordingId: "r1",
  editionId: "e1",
  narrator: "Ray Porter",
  language: "English",
  releaseTitle: null,
  sourceLabel: "TorBox",
  cover: "",
  duration: 9 * 3600 + 12 * 60,
  tracks: [],
  serverStored: false,
  faults: {},
  progress: null,
  serverCopy: null,
  ...over,
});

test("each recording is a choice: narrator, then language and length, and a mark when it is faulty", () => {
  assert.deepEqual(
    recordingChoices([
      recording({}),
      recording({ recordingId: "r2", narrator: " ", language: null, duration: 40 * 60, faults: { recording: fault } }),
    ]),
    [
      { value: "r1", label: "Ray Porter", detail: "English · 9 h 12 min" },
      { value: "r2", label: "Unknown narrator", detail: "40 min · Marked faulty" },
    ],
  );
  assert.equal(recordingDetail({ language: null, duration: 0, faults: {} }), "");
});

test("the book dialog's Audiobook row: narrator, length and where the recording stands", () => {
  const torbox = { sourceType: "torbox" as const };
  assert.equal(audiobookRowLine({ narrator: "Ray Porter", duration: 9 * 3600 + 12 * 60, serverStored: true, tracks: [torbox] }), "Ray Porter · 9 h 12 min · On server");
  assert.equal(audiobookRowLine({ narrator: "Ray Porter", duration: 3600, serverStored: false, tracks: [torbox] }), "Ray Porter · 1 h · Streams from TorBox");
  assert.equal(audiobookRowLine({ narrator: "Ray Porter", duration: 0, serverStored: false, tracks: [{ sourceType: "remote" }] }), "Ray Porter");
});

const facts = (over: Partial<CopyFacts> = {}): CopyFacts => ({
  tracks: [
    { id: "t1", sourceType: "torbox" },
    { id: "t2", sourceType: "torbox" },
  ],
  deviceFiles: [],
  sources: { serverFiles: 0, originalFiles: 2, managedCopies: 0 },
  serverCopy: null,
  faults: {},
  sourceLabel: "TorBox",
  ...over,
});

test("Available from: Device copy, Server copy and Original stream, each with its size or source", () => {
  assert.deepEqual(
    copyRows(facts()).map(({ name, value, present }) => [name, value, present]),
    [
      ["Device copy", "None", false],
      ["Server copy", "None", false],
      ["Original stream", "TorBox", true],
    ],
  );
  const full = copyRows(
    facts({
      deviceFiles: [
        { trackId: "t1", size: 200e6 },
        { trackId: "t2", size: 212e6 },
        { trackId: "elsewhere", size: 5e9 },
      ],
      sources: { serverFiles: 2, originalFiles: 0, managedCopies: 2 },
    }),
  );
  assert.deepEqual(full.map((row) => row.value), ["412 MB", "On server", "None"]);
  const partial = copyRows(facts({ deviceFiles: [{ trackId: "t1", size: 200e6 }], sources: { serverFiles: 1, originalFiles: 2, managedCopies: 1 } }));
  assert.deepEqual(partial.map((row) => row.value), ["1 of 2 files · 200 MB", "1 of 2 files", "TorBox"]);
  // An original stream that is not TorBox is named by its source.
  const remote = copyRows(facts({ tracks: [{ id: "t1", sourceType: "remote" }], sourceLabel: "LibriVox" }));
  assert.equal(remote[2].value, "LibriVox");
  // Before the server answers, the stream is read from the tracks.
  assert.equal(copyRows(facts({ sources: null }))[2].value, "TorBox");
});

test("a copy to the server that is moving shows its line on the Server copy row", () => {
  const rows = copyRows(facts({ serverCopy: { status: "downloading", progress: 0.43, error: null } }));
  assert.equal(rows[1].value, "Copying to server · 43%");
  assert.equal(rows[1].present, true);
});

test("a copy marked faulty says so on its row", () => {
  const rows = copyRows(
    facts({ deviceFiles: [{ trackId: "t1", size: 1e6 }], faults: { device: fault, original: fault, recording: fault } }),
  );
  assert.deepEqual(rows.map((row) => [row.value, row.faulty]), [
    ["Marked faulty", true],
    ["None", false],
    ["Marked faulty", true],
  ]);
  assert.equal(markName("device"), "Device copy marked faulty");
  assert.equal(markName("recording"), "Recording marked faulty");
  assert.equal(markDetail(fault), "Wrong language");
  assert.equal(markDetail({ ...fault, note: "Narrated in German" }), "Wrong language · Narrated in German");
});

test("Plays from: a choice a fault mark rules out is off; a faulty recording rules out every one", () => {
  const all = { faults: {}, deviceHasTrack: true, serverHasTrack: true, originalHasTrack: true, online: true };
  const off = (input: Parameters<typeof playsFromOptions>[0]) =>
    playsFromOptions(input).filter((option) => option.disabled).map((option) => option.value);
  assert.deepEqual(playsFromOptions(all).map((option) => option.label), ["Automatic", "Device copy", "Server copy", "Original stream"]);
  assert.deepEqual(off(all), []);
  assert.deepEqual(off({ ...all, faults: { device: fault } }), ["device"]);
  assert.deepEqual(off({ ...all, faults: { server: fault } }), ["server"]);
  assert.deepEqual(off({ ...all, faults: { original: fault } }), ["original"]);
  assert.deepEqual(off({ ...all, faults: { recording: fault } }), ["auto", "device", "server", "original"]);
  // No file for the place, or no connection for the server and the stream.
  assert.deepEqual(off({ ...all, deviceHasTrack: false, serverHasTrack: false }), ["device", "server"]);
  assert.deepEqual(off({ ...all, online: false }), ["server", "original"]);
});

test("Report a problem marks the recording or a copy that is there, for today's reasons with 'recording'", () => {
  assert.deepEqual(reportScopes({ deviceFiles: 0, serverFiles: 0, originalFiles: 0 }), ["recording"]);
  assert.deepEqual(reportScopes({ deviceFiles: 3, serverFiles: 1, originalFiles: 2 }), ["recording", "device", "server", "original"]);
  assert.deepEqual(Object.values(FAULT_REASONS), [
    "Wrong language",
    "Wrong book or recording",
    "Audio does not play correctly",
    "Missing or incomplete audio",
    "Other problem",
  ]);
});
