import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeChapters } from "../server/chapters.ts";
import {
  listeningChapters,
  currentChapter,
  relativeSeekTarget,
} from "../src/chapters.ts";
import type { Book } from "../src/types.ts";
test("embedded QuickTime/Nero chapter timestamps become seconds and invalid markers are discarded", () => {
  assert.deepEqual(
    normalizeChapters(
      [
        { title: "Two", start: 200000000, timeScale: 10000000 },
        { title: "One", start: 0, timeScale: 10000000 },
        { title: "Bad", start: -2 },
        { title: "Out of bounds", start: 120 },
      ],
      60,
    ),
    [
      { title: "One", start: 0, end: 20 },
      { title: "Two", start: 20, end: 60 },
    ],
  );
});
test("30-second seeks cross physical file boundaries, retain offsets and clamp only at book boundaries", () => {
  const tracks = [
    { id: "first", duration: 60 },
    { id: "second", duration: 90 },
    { id: "third", duration: 30 },
  ];
  assert.deepEqual(relativeSeekTarget(tracks, "first", 20, 30), {
    track: tracks[0],
    position: 50,
  });
  assert.deepEqual(relativeSeekTarget(tracks, "first", 50, 30), {
    track: tracks[1],
    position: 20,
  });
  assert.deepEqual(relativeSeekTarget(tracks, "second", 10, -30), {
    track: tracks[0],
    position: 40,
  });
  assert.deepEqual(relativeSeekTarget(tracks, "first", 10, -30), {
    track: tracks[0],
    position: 0,
  });
  assert.deepEqual(relativeSeekTarget(tracks, "third", 15, 30), {
    track: tracks[2],
    position: 30,
  });
  assert.deepEqual(relativeSeekTarget(tracks, "first", 50, 30, 70), {
    track: tracks[1],
    position: 10,
  });
  assert.equal(relativeSeekTarget(tracks, "missing", 10, 30), null);
  assert.deepEqual(
    relativeSeekTarget(
      [{ id: "unknown", duration: 0 }, tracks[1]],
      "second",
      10,
      -30,
    ),
    { track: tracks[1], position: 0 },
  );
});
test("chapter navigation retains physical track identity and selects boundary offsets correctly", () => {
  const book = {
    tracks: [
      {
        id: "one-file",
        recordingId: "edition-one",
        title: "An M4B",
        index: 0,
        duration: 60,
        source: "",
        sourceType: "local",
        chapters: [
          { title: "First", start: 0, end: 20 },
          { title: "Second", start: 20, end: 60 },
        ],
      },
      {
        id: "next-file",
        recordingId: "edition-one",
        title: "A bonus chapter",
        index: 1,
        duration: 10,
        source: "",
        sourceType: "local",
      },
    ],
  } as Book;
  const chapters = listeningChapters(book);
  assert.equal(chapters.length, 3);
  assert.equal(chapters[0].track.id, chapters[1].track.id);
  assert.equal(currentChapter(book, "one-file", 19)?.title, "First");
  assert.equal(currentChapter(book, "one-file", 20)?.title, "Second");
  assert.equal(currentChapter(book, "next-file", 0)?.title, "A bonus chapter");
});
