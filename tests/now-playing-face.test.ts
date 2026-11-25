// The face Now playing opens on (#593, spec #586 "Now playing: one screen, two faces"), with plain data: no
// recording, no EPUB, a PDF-only work, both without a last face, both with each last face.
import { test } from "node:test";
import assert from "node:assert/strict";
import { faceExists, faceFacts, faceKeyName, faceToOpen, prepareOnOpen, readFace } from "../src/now-playing-face.ts";
import { chosenEbook } from "../src/ebook-choice.ts";
import type { LibraryWork, Track, WorkEbook, WorkRecording } from "../src/types.ts";

const track: Track = { id: "t1", title: "Chapter 1", duration: 600 } as Track;
const recording = (id: string, tracks: Track[] = [track]): WorkRecording =>
  ({ recordingId: id, editionId: `e-${id}`, narrator: "", language: null, releaseTitle: null, sourceLabel: "", cover: "", duration: 600, tracks, serverStored: true, faults: {}, progress: null, serverCopy: null }) as WorkRecording;
const ebook = (id: string, format: "epub" | "pdf" = "epub"): WorkEbook => ({ id, format, size: 1, available: true, check: null, place: null }) as WorkEbook;
const work = (recordings: WorkRecording[], ebooks: WorkEbook[]) =>
  ({ recordings, chosenRecordingId: recordings[0]?.recordingId ?? null, ebooks, chosenEbookId: null }) as unknown as LibraryWork;
const facts = (w: LibraryWork) => faceFacts(w, chosenEbook(w, null)?.id ?? null);

test("a work without a recording opens on Read, whatever face was last shown", () => {
  const w = work([], [ebook("b1")]);
  assert.deepEqual(facts(w), { recording: false, epub: true });
  assert.equal(faceToOpen(facts(w), null), "read");
  assert.equal(faceToOpen(facts(w), "listen"), "read");
  assert.equal(faceExists(facts(w), "listen"), false);
});

test("a recording without files counts as no recording", () => {
  const w = work([recording("r1", [])], [ebook("b1")]);
  assert.equal(faceToOpen(facts(w), "listen"), "read");
});

test("a work without an EPUB opens on Listen, whatever face was last shown", () => {
  const w = work([recording("r1")], []);
  assert.deepEqual(facts(w), { recording: true, epub: false });
  assert.equal(faceToOpen(facts(w), null), "listen");
  assert.equal(faceToOpen(facts(w), "read"), "listen");
  assert.equal(faceExists(facts(w), "read"), false);
});

test("a PDF-only work has no EPUB: it opens on Listen and Read does not exist", () => {
  const w = work([recording("r1")], [ebook("p1", "pdf")]);
  assert.equal(facts(w).epub, false);
  assert.equal(faceToOpen(facts(w), "read"), "listen");
  assert.equal(faceExists(facts(w), "read"), false);
});

test("a work with both opens on Listen the first time", () => {
  const w = work([recording("r1")], [ebook("b1")]);
  assert.deepEqual(facts(w), { recording: true, epub: true });
  assert.equal(faceToOpen(facts(w), null), "listen");
});

test("a work with both opens on the face last shown on this device", () => {
  const w = work([recording("r1")], [ebook("b1")]);
  assert.equal(faceToOpen(facts(w), "read"), "read");
  assert.equal(faceToOpen(facts(w), "listen"), "listen");
});

test("a stored value that is not a face counts as none", () => {
  assert.equal(readFace("read"), "read");
  assert.equal(readFace("listen"), "listen");
  assert.equal(readFace(null), null);
  assert.equal(readFace("Read"), null);
  assert.equal(readFace(""), null);
  assert.equal(faceKeyName("w 1"), "face:w 1");
});

test("the rule's order: without a recording comes first, so a work with neither file is Read (its Book page is shown)", () => {
  const w = work([], [ebook("p1", "pdf")]);
  assert.deepEqual(facts(w), { recording: false, epub: false });
  assert.equal(faceToOpen(facts(w), null), "read");
  assert.equal(faceToOpen(facts(w), "listen"), "read");
});

// Opening a face with another book in the player (#862): Read loads its own book, paused, unless the other is playing.
const read = { recordingId: "r-read" };
test("with nothing in the player, either face loads its book", () => {
  assert.equal(prepareOnOpen("read", read, null), true);
  assert.equal(prepareOnOpen("listen", read, null), true);
});

test("Read loads its book in place of another recording that is paused", () => {
  assert.equal(prepareOnOpen("read", read, { recordingId: "r-other", playing: false }), true);
});

test("Read leaves another recording that is playing in the player", () => {
  assert.equal(prepareOnOpen("read", read, { recordingId: "r-other", playing: true }), false);
});

test("Listen never swaps another recording out, paused or playing", () => {
  assert.equal(prepareOnOpen("listen", read, { recordingId: "r-other", playing: false }), false);
  assert.equal(prepareOnOpen("listen", read, { recordingId: "r-other", playing: true }), false);
});

test("the book already in the player, or no book to load, loads nothing", () => {
  assert.equal(prepareOnOpen("read", read, { recordingId: "r-read", playing: false }), false);
  assert.equal(prepareOnOpen("read", null, { recordingId: "r-other", playing: false }), false);
  assert.equal(prepareOnOpen("read", null, null), false);
});
