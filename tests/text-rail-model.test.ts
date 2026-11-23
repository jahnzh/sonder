// The text position rail's rules (#804): chapters from a manifest, place and y, the zoom, the re-anchoring after a
// zoom, a grab against a jump, a tap against a drag, the keys, the words, and what is drawn in each state.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEAD,
  GRAB,
  PULL,
  ZOOM,
  barMap,
  dragPlace,
  dragRail,
  placeToY,
  pressRail,
  railKey,
  railPicture,
  railReadout,
  railSegments,
  railValueText,
  segmentAt,
  touchIntent,
  yToPlace,
  zoomOf,
} from "../src/text-rail-model";

/** A manifest of chapter files of `count` sentences each, and the index of their places (`SentenceIndex`'s rule). */
function manifestOf(count: number[], chapters: { label: string; depth: number; section: number; at?: number }[]) {
  const total = count.reduce((sum, n) => sum + n, 0);
  const starts = count.map((_, section) => count.slice(0, section).reduce((sum, n) => sum + n, 0));
  const manifest = {
    sections: count.map((_, section) => ({ title: `File ${section}` })),
    chapters: chapters.map((chapter) => ({ label: chapter.label, depth: chapter.depth, section: chapter.section, part: 0, sentence: `${chapter.section}:${chapter.at ?? 0}` as string | null })),
  };
  const ordinalOf = (id: string | null | undefined) => {
    const found = id ? /^(\d+):(\d+)$/.exec(id) : null;
    return found ? starts[Number(found[1])]! + Number(found[2]) : -1;
  };
  return { manifest: manifest as any, index: { total, ordinalOf } };
}

test("chapters are the contents' top level, each from its first sentence to the next chapter's, to scale", () => {
  const { manifest, index } = manifestOf([100, 300, 101], [
    { label: "One", depth: 0, section: 0 },
    { label: "One, a", depth: 1, section: 0, at: 50 },
    { label: "Two", depth: 0, section: 1 },
    { label: "Three", depth: 0, section: 2 },
  ]);
  const segments = railSegments(manifest, index);
  assert.deepEqual(segments.map((segment) => segment.label), ["One", "Two", "Three"]);
  assert.equal(segments[0]!.start, 0);
  assert.equal(segments[1]!.start, 100 / 500);
  assert.equal(segments[2]!.start, 400 / 500);
  assert.equal(segments[2]!.end, 1);
  for (let at = 1; at < segments.length; at++) assert.equal(segments[at]!.start, segments[at - 1]!.end);
});

test("a top level of one entry (the book's title) gives way to the level under it", () => {
  const { manifest, index } = manifestOf([10, 50, 50], [
    { label: "The Book", depth: 0, section: 0 },
    { label: "Introduction", depth: 1, section: 0, at: 2 },
    { label: "1", depth: 1, section: 1 },
    { label: "2", depth: 1, section: 2 },
  ]);
  assert.deepEqual(railSegments(manifest, index).map((segment) => segment.label), ["The Book", "Introduction", "1", "2"]);
});

test("text before the first chapter is a segment of its own; chapters listed out of order are put in order", () => {
  const { manifest, index } = manifestOf([20, 40, 40], [
    { label: "Epilogue", depth: 0, section: 2 },
    { label: "Prologue", depth: 0, section: 1 },
  ]);
  const segments = railSegments(manifest, index);
  assert.deepEqual(segments.map((segment) => segment.label), ["File 0", "Prologue", "Epilogue"]);
  assert.equal(segments[1]!.start, 20 / 99);
});

test("a book with one chapter is one segment, and a chapter without a sentence is left out", () => {
  const { manifest, index } = manifestOf([30], [{ label: "Start", depth: 0, section: 0 }]);
  manifest.chapters.push({ label: "Nothing", depth: 0, section: 0, part: 0, sentence: null });
  assert.deepEqual(railSegments(manifest, index), [{ label: "Start", start: 0, end: 1 }]);
});

test("a place and its y are one measure, and the ends of the rail are the book's ends", () => {
  assert.equal(placeToY(0, 600), 0);
  assert.equal(placeToY(1, 600), 600);
  assert.equal(placeToY(0.25, 600), 150);
  assert.equal(yToPlace(150, 600), 0.25);
  assert.equal(yToPlace(-20, 600), 0);
  assert.equal(yToPlace(900, 600), 1);
  for (const place of [0, 0.1, 0.5, 0.999]) assert.ok(Math.abs(yToPlace(placeToY(place, 696), 696) - place) < 1e-12);
});

test("the zoom is none within 32 px of the centre line, then 8 ^ s up to 8 at 100 px", () => {
  assert.equal(zoomOf(0), 1);
  assert.equal(zoomOf(DEAD), 1);
  assert.equal(zoomOf(-DEAD), 1);
  assert.ok(Math.abs(zoomOf(PULL) - ZOOM) < 1e-9);
  assert.ok(Math.abs(zoomOf(400) - ZOOM) < 1e-9);
  assert.ok(Math.abs(zoomOf(DEAD + (PULL - DEAD) / 2) - Math.sqrt(ZOOM)) < 1e-9);
  assert.ok(Math.abs(zoomOf(-PULL) - ZOOM) < 1e-9, "either side");
});

test("a press near the thumb picks it up where it is; a press elsewhere moves it to the finger", () => {
  const height = 600;
  const grab = pressRail({ y: 300 + GRAB, dx: 0 }, 0.5, height);
  assert.equal(grab.grabbed, true);
  assert.equal(dragPlace(grab, height), 0.5);
  const jump = pressRail({ y: 300 + GRAB + 1, dx: 0 }, 0.5, height);
  assert.equal(jump.grabbed, false);
  assert.ok(Math.abs(dragPlace(jump, height) - (323 / 600)) < 1e-9);
  // Picked up 10 px below its middle, the thumb keeps that offset under the finger.
  const moved = dragRail(pressRail({ y: 310, dx: 0 }, 0.5, height), { y: 370, dx: 0 }, height);
  assert.ok(Math.abs(dragPlace(moved, height) - 360 / 600) < 1e-9);
});

test("pulled 100 px away the same travel moves the place by an eighth of what it moves on the rail", () => {
  const height = 600;
  const near = dragRail(pressRail({ y: 300, dx: 0 }, 0.5, height), { y: 360, dx: 0 }, height);
  const onRail = dragPlace(near, height) - 0.5;
  let far = pressRail({ y: 300, dx: 0 }, 0.5, height);
  far = dragRail(far, { y: 300, dx: -PULL }, height);
  far = dragRail(far, { y: 360, dx: -PULL }, height);
  const zoomed = dragPlace(far, height) - 0.5;
  assert.ok(Math.abs(zoomed - onRail / ZOOM) < 1e-9, `${zoomed} against ${onRail / ZOOM}`);
});

test("back on the rail after a zoom, the finger's spot is the current place and the rail's ends are the book's ends", () => {
  const height = 600;
  let drag = pressRail({ y: 300, dx: 0 }, 0.5, height);
  drag = dragRail(drag, { y: 300, dx: PULL }, height);
  drag = dragRail(drag, { y: 380, dx: PULL }, height);
  const current = dragPlace(drag, height);
  assert.ok(Math.abs(current - (300 + 80 / ZOOM) / 600) < 1e-9);
  // Back on the rail at the same y: the place stays.
  drag = dragRail(drag, { y: 380, dx: 0 }, height);
  assert.ok(Math.abs(dragPlace(drag, height) - current) < 1e-9);
  // From there the top of the rail is the book's start and the bottom its end.
  assert.equal(dragPlace(dragRail(drag, { y: 0, dx: 0 }, height), height), 0);
  assert.equal(dragPlace(dragRail(drag, { y: height, dx: 0 }, height), height), 1);
  // Halfway to the bottom from the finger's spot is halfway from the current place to the end.
  const half = dragPlace(dragRail(drag, { y: 380 + (height - 380) / 2, dx: 0 }, height), height);
  assert.ok(Math.abs(half - (current + (1 - current) / 2)) < 1e-9);
  assert.equal(barMap(0, 380, 300, height), 0);
  assert.equal(barMap(height, 380, 300, height), height);
  assert.equal(barMap(380, 380, 300, height), 300);
});

test("a touch is the text's until it has moved 8 px, more up or down than sideways", () => {
  assert.equal(touchIntent(0, 0), "pending");
  assert.equal(touchIntent(0, 7), "pending");
  assert.equal(touchIntent(0, 8), "rail");
  assert.equal(touchIntent(2, -9), "rail");
  assert.equal(touchIntent(9, 9), "pending", "as far sideways as up or down");
  assert.equal(touchIntent(40, 10), "pending", "a sideways swipe stays the text's");
});

test("the keys: Down and Up a band, Page Down and Page Up a chapter, Home and End the book's ends", () => {
  const segments = [
    { label: "A", start: 0, end: 0.2 },
    { label: "B", start: 0.2, end: 0.7 },
    { label: "C", start: 0.7, end: 1 },
  ];
  assert.deepEqual(railKey("ArrowDown", segments, 0.3), { kind: "band", direction: 1 });
  assert.deepEqual(railKey("ArrowUp", segments, 0.3), { kind: "band", direction: -1 });
  assert.deepEqual(railKey("PageDown", segments, 0.3), { kind: "place", place: 0.7 });
  assert.deepEqual(railKey("PageDown", segments, 0.8), { kind: "place", place: 1 });
  assert.deepEqual(railKey("PageUp", segments, 0.3), { kind: "place", place: 0.2 });
  assert.deepEqual(railKey("PageUp", segments, 0.2), { kind: "place", place: 0 });
  assert.deepEqual(railKey("Home", segments, 0.3), { kind: "place", place: 0 });
  assert.deepEqual(railKey("End", segments, 0.3), { kind: "place", place: 1 });
  assert.equal(railKey("a", segments, 0.3), null);
});

test("the words: the readout and the slider's value text as the boards' labels read", () => {
  const segments = [
    { label: "Chapter 5", start: 0, end: 0.3 },
    { label: "Chapter 9", start: 0.3, end: 1 },
  ];
  assert.deepEqual(railReadout(segments, 0.35), { chapter: "Chapter 9", percent: 35 });
  assert.equal(railValueText(segments, 0.19, 0.19, true), "Chapter 5, 19%. Following the narration.");
  assert.equal(railValueText(segments, 0.35, 0.2, false), "Chapter 9, 35%. The narration is in Chapter 5.");
  assert.equal(railValueText(segments, 0.35, null, false), "Chapter 9, 35%.");
  assert.equal(segmentAt(segments, 0.3), 1);
  assert.equal(segmentAt(segments, 1), 1);
});

const book = [
  { label: "A", start: 0, end: 0.25 },
  { label: "B", start: 0.25, end: 0.5 },
  { label: "C", start: 0.5, end: 1 },
];

test("at rest, following: earlier chapters read, the one in view filled to the accent thumb, no mark", () => {
  const picture = railPicture(book, { place: 0.375, narrated: 0.375, following: true, drag: null }, 400);
  assert.deepEqual(picture.segments.map((segment) => segment.tone), ["read", "line", "line"]);
  assert.deepEqual(picture.segments.map((segment) => [segment.top, segment.height]), [[0, 98], [100, 98], [200, 198]]);
  assert.deepEqual(picture.read, { top: 100, height: 50 });
  assert.deepEqual(picture.thumb, { top: 142, height: 16, held: false, tone: "accent" });
  assert.equal(picture.mark, null);
  assert.equal(picture.overview, null);
});

test("away: a text-coloured thumb and the narration mark; without a narrated sentence no mark and no accent", () => {
  const away = railPicture(book, { place: 0.75, narrated: 0.375, following: false, drag: null }, 400);
  assert.equal(away.thumb.tone, "text");
  assert.deepEqual(away.mark, { top: 148.5, height: 3 });
  const none = railPicture(book, { place: 0.75, narrated: null, following: true, drag: null }, 400);
  assert.equal(none.thumb.tone, "text");
  assert.equal(none.mark, null);
});

test("held: a bar of 4, the chapter under it lit, no partial fill; zoomed: magnified about the thumb with the overview", () => {
  const held = railPicture(book, { place: 0.1, narrated: 0.1, following: false, drag: { u: 150, zoom: 1 } }, 400);
  assert.deepEqual(held.thumb, { top: 148, height: 4, held: true, tone: "text" });
  assert.deepEqual(held.segments.map((segment) => segment.tone), ["read", "lit", "line"]);
  assert.equal(held.read, null);
  assert.equal(held.overview, null);
  const zoomed = railPicture(book, { place: 0.1, narrated: 0.1, following: false, drag: { u: 150, zoom: ZOOM } }, 400);
  // Chapter B (100 to 200 at rest) is drawn 8 times as tall about the thumb at 150: from -250 to 550, cut to the rail.
  assert.deepEqual([zoomed.segments[1]!.top, zoomed.segments[1]!.height], [0, 398]);
  assert.equal(zoomed.segments[0]!.height, 0);
  assert.equal(zoomed.thumb.top, 148);
  assert.equal(zoomed.overview!.opacity, 1);
  assert.deepEqual(zoomed.overview!.lit, { top: 150 - 150 / ZOOM, height: 400 / ZOOM });
  assert.deepEqual(zoomed.overview!.tick, { top: 39, height: 3 });
  // The mark of the narration (at 40 at rest) is magnified off the rail.
  assert.equal(zoomed.mark, null);
});
