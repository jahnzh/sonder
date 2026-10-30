import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeStamp,
  bookPosition,
  hms,
  lowConfidenceWarning,
  mapSourcePosition,
  normalizeTitle,
  replaceNotice,
  resumeLabel,
  savedLabel,
  sourceSwitchOffer,
} from "../src/source-progress.ts";
import type { Progress, Track } from "../src/types.ts";

const track = (
  id: string,
  duration: number,
  chapters?: Track["chapters"],
  title = id,
): Track => ({
  id,
  recordingId: "r",
  title,
  index: 0,
  duration,
  source: "",
  sourceType: "local",
  chapters,
});
const chaptered = (id: string, titles: string[], length: number) =>
  track(
    id,
    titles.length * length,
    titles.map((title, i) => ({ title, start: i * length, end: (i + 1) * length })),
  );
const progress = (recordingId: string, trackId: string, updatedAt: number, position = 10): Progress => ({
  recordingId,
  trackId,
  position,
  duration: 100,
  updatedAt,
});

test("chapters map by index when both recordings have the same number, keeping the offset", () => {
  const from = { tracks: [chaptered("a", ["One", "Two", "Three"], 100)] };
  const to = { tracks: [chaptered("b", ["Intro", "Part", "Outro"], 110)] };
  const mapped = mapSourcePosition(from, { trackId: "a", position: 130 }, to)!;
  assert.equal(mapped.method, "chapter");
  assert.equal(mapped.confidence, "high");
  assert.equal(mapped.chapterTitle, "Part");
  assert.equal(mapped.trackId, "b");
  assert.equal(mapped.position, 140);
  assert.equal(mapped.bookPosition, 140);
  assert.equal(mapped.durationsDiffer, false);
});

test("chapters map by normalised title when the counts differ", () => {
  const from = {
    tracks: [chaptered("a", ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"], 100)],
  };
  const to = {
    tracks: [
      track("b", 420, [
        { title: "Opening Credits", start: 0, end: 20 },
        { title: "CHAPTER 1!", start: 20, end: 120 },
        { title: "Chapter 2", start: 120, end: 220 },
        { title: "Chapter 3", start: 220, end: 320 },
        { title: "Chapter 4", start: 320, end: 400 },
      ]),
    ],
  };
  const mapped = mapSourcePosition(from, { trackId: "a", position: 250 }, to)!;
  assert.equal(mapped.method, "title");
  assert.equal(mapped.chapterTitle, "Chapter 3");
  assert.equal(mapped.position, 220 + 50);
  assert.equal(mapped.confidence, "high");
  // Index matching would have landed in "Chapter 2": the counts do differ.
  assert.notEqual(mapped.chapterTitle, "Chapter 2");
});

test("repeated titles match in order", () => {
  const from = { tracks: [chaptered("a", ["Part", "Part", "Part"], 100)] };
  const to = {
    tracks: [chaptered("b", ["Start", "Part", "Part", "Part", "End"], 60)],
  };
  const mapped = mapSourcePosition(from, { trackId: "a", position: 210 }, to)!;
  assert.equal(mapped.method, "title");
  assert.equal(mapped.position, 3 * 60 + 10);
});

test("a count mismatch with no shared title falls back to the duration fraction", () => {
  const from = { tracks: [chaptered("a", ["Alpha", "Beta"], 100)] };
  const to = { tracks: [chaptered("b", ["One", "Two", "Three", "Four"], 50)] };
  const mapped = mapSourcePosition(from, { trackId: "a", position: 100 }, to)!;
  assert.equal(mapped.method, "fraction");
  assert.equal(mapped.confidence, "low");
  assert.equal(mapped.chapterTitle, null);
  assert.equal(mapped.position, 100);
  assert.equal(mapped.percent, 50);
});

test("the chapter offset is clamped to the target chapter's length", () => {
  const from = { tracks: [chaptered("a", ["One", "Two"], 300)] };
  const to = { tracks: [chaptered("b", ["Uno", "Dos"], 100)] };
  const mapped = mapSourcePosition(from, { trackId: "a", position: 250 }, to)!;
  assert.equal(mapped.position, 100);
  assert.equal(mapped.chapterTitle, "Uno");
  // An offset past the source chapter's end (a gap after it) is clamped too.
  const gap = { tracks: [track("a", 1000, [{ title: "One", start: 0, end: 100 }, { title: "Two", start: 600, end: 1000 }])] };
  const next = { tracks: [track("b", 1000, [{ title: "Uno", start: 0, end: 500 }, { title: "Dos", start: 500, end: 1000 }])] };
  assert.equal(mapSourcePosition(gap, { trackId: "a", position: 400 }, next)!.position, 100);
});

test("chapters in different file layouts map across tracks", () => {
  const single = { tracks: [chaptered("m4b", ["One", "Two", "Three"], 100)] };
  const files = {
    tracks: [track("f1", 100, undefined, "One"), track("f2", 100, undefined, "Two"), track("f3", 100, undefined, "Three")],
  };
  const mapped = mapSourcePosition(single, { trackId: "m4b", position: 150 }, files)!;
  assert.equal(mapped.trackId, "f2");
  assert.equal(mapped.position, 50);
  assert.equal(mapped.bookPosition, 150);
  const back = mapSourcePosition(files, { trackId: "f3", position: 20 }, single)!;
  assert.equal(back.trackId, "m4b");
  assert.equal(back.position, 220);
});

test("without chapters the position scales by the fraction of the whole book", () => {
  const from = { tracks: [track("a", 1000)] };
  const to = { tracks: [track("b1", 600), track("b2", 600)] };
  const mapped = mapSourcePosition(from, { trackId: "a", position: 750 }, to)!;
  assert.equal(mapped.method, "fraction");
  assert.equal(mapped.trackId, "b2");
  assert.equal(mapped.position, 300);
  assert.equal(mapped.bookPosition, 900);
  assert.equal(mapped.percent, 75);
  assert.equal(mapped.confidence, "low");
  assert.equal(mapped.durationsDiffer, true);
});

test("confidence is low when durations differ by more than 10% even with matching chapters", () => {
  const from = { tracks: [chaptered("a", ["One", "Two"], 100)] };
  const close = { tracks: [chaptered("b", ["One", "Two"], 109)] };
  const far = { tracks: [chaptered("c", ["One", "Two"], 120)] };
  assert.equal(mapSourcePosition(from, { trackId: "a", position: 5 }, close)!.confidence, "high");
  const mapped = mapSourcePosition(from, { trackId: "a", position: 5 }, far)!;
  assert.equal(mapped.method, "chapter");
  assert.equal(mapped.confidence, "low");
  assert.equal(lowConfidenceWarning(mapped), "Durations differ; the position may be off");
  assert.equal(lowConfidenceWarning(mapSourcePosition(from, { trackId: "a", position: 5 }, close)!), null);
});

test("a fraction match with similar durations is low confidence with its own warning", () => {
  const from = { tracks: [track("a", 1000)] };
  const to = { tracks: [track("b", 1020)] };
  const mapped = mapSourcePosition(from, { trackId: "a", position: 500 }, to)!;
  assert.equal(mapped.confidence, "low");
  assert.equal(mapped.durationsDiffer, false);
  assert.equal(lowConfidenceWarning(mapped), "Position estimated from the book length; it may be off");
});

test("zero or unknown durations never produce a made-up position", () => {
  const unknown = { tracks: [track("a", 0)] };
  const known = { tracks: [track("b", 1000)] };
  assert.equal(mapSourcePosition(unknown, { trackId: "a", position: 50 }, known), null);
  assert.equal(mapSourcePosition(known, { trackId: "b", position: 50 }, unknown), null);
  assert.equal(mapSourcePosition({ tracks: [track("a", NaN)] }, { trackId: "a", position: 50 }, known), null);
  assert.equal(mapSourcePosition(known, { trackId: "missing", position: 50 }, known), null);
  assert.equal(mapSourcePosition(known, { trackId: "b", position: 50 }, { tracks: [] }), null);
  // Chapters still map without a known total, but are never called high confidence.
  const noTotal = { tracks: [track("a", 0, [{ title: "One", start: 0, end: 100 }, { title: "Two", start: 100, end: 200 }])] };
  const target = { tracks: [chaptered("c", ["Uno", "Dos"], 100)] };
  const mapped = mapSourcePosition(noTotal, { trackId: "a", position: 150 }, target)!;
  assert.equal(mapped.method, "chapter");
  assert.equal(mapped.position, 150);
  assert.equal(mapped.confidence, "low");
});

test("a position past the end maps to the end", () => {
  const from = { tracks: [track("a", 100)] };
  const to = { tracks: [track("b", 200)] };
  const mapped = mapSourcePosition(from, { trackId: "a", position: 500 }, to)!;
  assert.equal(mapped.position, 200);
  assert.equal(mapped.percent, 100);
});

test("titles normalise case, accents and punctuation", () => {
  assert.equal(normalizeTitle("  Chapitre 1 : L’été! "), "chapitre 1 l ete");
  assert.equal(normalizeTitle("---"), "");
});

test("book position and labels", () => {
  const book = { tracks: [track("a", 3600), track("b", 3600)] };
  assert.equal(bookPosition(book, "b", 125), 3725);
  assert.equal(bookPosition(book, "missing", 1), null);
  assert.equal(hms(3725), "01:02:05");
  assert.equal(hms(NaN), "00:00:00");
  const chapter = mapSourcePosition(
    { tracks: [chaptered("x", ["One", "Two"], 100)] },
    { trackId: "x", position: 120 },
    { tracks: [chaptered("y", ["Uno", "Dos"], 100)] },
  )!;
  assert.equal(resumeLabel(chapter), "Resume at Dos (00:02:00)");
  const fraction = mapSourcePosition({ tracks: [track("a", 100)] }, { trackId: "a", position: 25 }, { tracks: [track("b", 200)] })!;
  assert.equal(resumeLabel(fraction), "Resume at 25% (00:00:50)");
  assert.equal(savedLabel(book, progress("r", "b", 1, 125)), "Resume saved position (01:02:05)");
});

test("the offer appears for a target with no checkpoint or an older one, never for a newer one", () => {
  const activeBook = { tracks: [track("a", 1000)] };
  const targetBook = { tracks: [track("b", 2000)] };
  const active = { recordingId: "ra", book: activeBook, trackId: "a", position: 500, updatedAt: 1000 };
  const none = sourceSwitchOffer({ active, target: { recordingId: "rb", book: targetBook } })!;
  assert.equal(none.mapping.position, 1000);
  assert.equal(none.saved, null);
  const older = progress("rb", "b", 999);
  const offer = sourceSwitchOffer({ active, target: { recordingId: "rb", book: targetBook, progress: older } })!;
  assert.equal(offer.saved, older);
  assert.equal(
    sourceSwitchOffer({ active, target: { recordingId: "rb", book: targetBook, progress: progress("rb", "b", 1001) } }),
    null,
  );
  assert.equal(
    sourceSwitchOffer({ active, target: { recordingId: "rb", book: targetBook, progress: progress("rb", "b", 1000) } }),
    null,
  );
});

test("no offer without a place to carry over, for the same recording, or without a usable mapping", () => {
  const book = { tracks: [track("a", 1000)] };
  const target = { recordingId: "rb", book: { tracks: [track("b", 1000)] } };
  assert.equal(sourceSwitchOffer({ active: null, target }), null);
  const active = { recordingId: "ra", book, trackId: "a", position: 0, updatedAt: 5 };
  assert.equal(sourceSwitchOffer({ active, target }), null);
  assert.equal(sourceSwitchOffer({ active: { ...active, position: 300 }, target: { ...target, recordingId: "ra" } }), null);
  const unknown = { recordingId: "rb", book: { tracks: [track("b", 0)] } };
  assert.equal(sourceSwitchOffer({ active: { ...active, position: 300 }, target: unknown }), null);
});

test("a paused recording holding a place counts as listened to now, not at its last save", () => {
  const activeBook = { tracks: [track("a", 1500)] };
  const targetBook = { tracks: [track("b", 1500)] };
  const lastSave = 1000;
  const now = 5000;
  // The target was saved after the active recording's last save, but before it was paused.
  const target = { recordingId: "rb", book: targetBook, progress: progress("rb", "b", 3000) };
  const stamped = (position: number) => ({
    recordingId: "ra",
    book: activeBook,
    trackId: "a",
    position,
    updatedAt: activeStamp(activeBook, "a", position, lastSave, now),
  });
  const offer = sourceSwitchOffer({ active: stamped(600), target })!;
  assert.equal(offer.mapping.position, 600);
  assert.equal(offer.saved, target.progress);
  // Without a place of at least a second there is nothing live, so the last save stands.
  assert.equal(activeStamp(activeBook, "a", 0.5, lastSave, now), lastSave);
  assert.equal(activeStamp(activeBook, "missing", 600, lastSave, now), lastSave);
  // A target saved after the pause still wins.
  assert.equal(
    sourceSwitchOffer({ active: stamped(600), target: { ...target, progress: progress("rb", "b", 6000) } }),
    null,
  );
});

test("Start from beginning names the saved position it replaces", () => {
  const book = { tracks: [track("a", 100), track("b", 100)] };
  assert.equal(
    replaceNotice(book, progress("rb", "b", 1, 42)),
    "Start from beginning replaces your saved position at 00:02:22",
  );
});

test("the share of the book still works when only some tracks have a known duration", () => {
  const from = { tracks: [track("a", 400)] };
  const to = { tracks: [track("x", 100), track("y", 0), track("z", 100)] };
  const mapped = mapSourcePosition(from, { trackId: "a", position: 300 }, to)!;
  // 75% of the 200 s that are known, skipping the unknown track.
  assert.equal(mapped.method, "fraction");
  assert.equal(mapped.trackId, "z");
  assert.equal(mapped.position, 50);
  assert.equal(mapped.bookPosition, 150);
  assert.equal(mapped.confidence, "low");
  assert.equal(mapped.durationsDiffer, true);
  assert.equal(
    mapSourcePosition(from, { trackId: "a", position: 300 }, { tracks: [track("y", 0), track("w", 0)] }),
    null,
  );
});
