import { test } from "node:test";
import assert from "node:assert/strict";
import { playbackTimeline, absoluteSeekTarget } from "../src/chapters.ts";
import { scrubPosition, seekSensitivity, seekSecond } from "../src/scrubbing.ts";
import { appearanceSchema } from "../src/appearance.ts";
import type { Book } from "../src/types.ts";
const book = {
  tracks: [
    {
      id: "one",
      title: "M4B",
      duration: 600,
      chapters: [
        { title: "Opening", start: 0, end: 30 },
        { title: "First", start: 30, end: 240 },
        { title: "Second", start: 240, end: 600 },
      ],
    },
    { id: "two", title: "Next file", duration: 120 },
  ],
} as Book;
test("chapter progress is relative to embedded chapter bounds and resets at chapter boundaries", () => {
  const range = playbackTimeline(book, "one", 90, 600, "chapter")!;
  assert.equal(range.start, 30);
  assert.equal(range.position, 60);
  assert.equal(range.duration, 210);
  assert.equal(range.title, "First");
  assert.equal(playbackTimeline(book, "one", 240, 600, "chapter")!.position, 0);
  assert.equal(playbackTimeline(book, "two", 45, 120, "chapter")!.position, 45);
});
test("whole-book progress accumulates physical files and maps a seek back to the correct file", () => {
  const range = playbackTimeline(book, "two", 45, 120, "book")!;
  assert.equal(range.position, 645);
  assert.equal(range.duration, 720);
  assert.deepEqual(absoluteSeekTarget(book.tracks, 645), {
    track: book.tracks[1],
    position: 45,
  });
  assert.equal(absoluteSeekTarget([{ id: "unknown", duration: 0 }], 45), null);
  const unknown = {
    tracks: [book.tracks[0], { ...book.tracks[1], duration: 0 }],
  } as Book;
  assert.equal(
    playbackTimeline(unknown, "one", 45, 600, "book")!.scope,
    "track",
  );
});
test("precision scrubbing slows horizontal movement continuously with perpendicular distance and never moves on a vertical-only drag", () => {
  assert.equal(seekSensitivity(0), 1);
  assert.equal(seekSensitivity(48), 0.5);
  assert.equal(seekSensitivity(144), 0.25);
  assert.equal(scrubPosition(100, 80, 0, 600, 400), 220);
  assert.equal(scrubPosition(100, 80, 144, 600, 400), 130);
  assert.equal(scrubPosition(100, 0, 144, 600, 400), 100);
  assert.equal(scrubPosition(590, 80, 0, 600, 400), 600);
  assert.equal(scrubPosition(10, -80, 0, 600, 400), 0);
  assert.equal(appearanceSchema.parse({}).playback.progressScope, "book");
  assert.equal(
    appearanceSchema.parse({ playback: { progressScope: "chapter" } }).playback
      .progressScope,
    "chapter",
  );
});
test("fractional chapter offsets retain the previewed second after media timestamp rounding", () => {
  const start = 120.12345678;
  const mediaPosition = Math.floor((start + 75) * 1e6) / 1e6;
  assert.equal(seekSecond(mediaPosition - start, 180), 75);
  assert.equal(seekSecond(74.9, 180), 74);
  assert.equal(seekSecond(-1, 180), 0);
  assert.equal(seekSecond(999, 180.5), 180);
});
