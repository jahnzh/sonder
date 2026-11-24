// The text position rail's rules (#804): chapters from a manifest, place and y, the zoom, the re-anchoring after a
// zoom, a grab against a jump, a tap against a drag, the rests of a held thumb, the keys, the words, and what is drawn
// in each state.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  FAR,
  GRAB,
  NEAR,
  REST_MS,
  ZOOM,
  barMap,
  dragPlace,
  dragRail,
  placeToY,
  pressRail,
  railKey,
  railPicture,
  railReadout,
  railRest,
  railSegments,
  railSpan,
  railValueText,
  readoutLine,
  readoutShare,
  segmentAt,
  spanPlace,
  spanSegments,
  spanShare,
  tickStep,
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

test("the zoom is whole (8) within 32 px of the centre line, then 8 ^ (1 - s) down to none at 100 px", () => {
  assert.ok(Math.abs(zoomOf(0) - ZOOM) < 1e-9);
  assert.ok(Math.abs(zoomOf(NEAR) - ZOOM) < 1e-9);
  assert.ok(Math.abs(zoomOf(-NEAR) - ZOOM) < 1e-9);
  assert.equal(zoomOf(FAR), 1);
  assert.equal(zoomOf(400), 1);
  assert.ok(Math.abs(zoomOf(NEAR + (FAR - NEAR) / 2) - Math.sqrt(ZOOM)) < 1e-9);
  assert.equal(zoomOf(-FAR), 1, "either side");
});

test("a press near the thumb picks it up where it is; a press elsewhere moves it to the finger, zoomed or not", () => {
  const height = 600;
  const grab = pressRail({ y: 300 + GRAB, dx: 0 }, 0.5, height);
  assert.equal(grab.grabbed, true);
  assert.equal(dragPlace(grab, height), 0.5);
  // On the rail the drag begins zoomed in; the thumb still goes to the finger, the place the rail at rest shows there.
  const jump = pressRail({ y: 300 + GRAB + 1, dx: 0 }, 0.5, height);
  assert.equal(jump.grabbed, false);
  assert.ok(Math.abs(jump.zoom - ZOOM) < 1e-9);
  assert.ok(Math.abs(dragPlace(jump, height) - 323 / 600) < 1e-9);
  assert.ok(Math.abs(dragPlace(pressRail({ y: 520, dx: -FAR }, 0.5, height), height) - 520 / 600) < 1e-9);
  // Picked up 10 px below its middle and pulled away: the thumb keeps that offset under the finger.
  let moved = dragRail(pressRail({ y: 310, dx: 0 }, 0.5, height), { y: 310, dx: -FAR }, height);
  moved = dragRail(moved, { y: 370, dx: -FAR }, height);
  assert.ok(Math.abs(dragPlace(moved, height) - 360 / 600) < 1e-9);
});

test("on the rail the same travel moves the place by an eighth of what it moves pulled 100 px away", () => {
  const height = 600;
  const near = dragRail(pressRail({ y: 300, dx: 0 }, 0.5, height), { y: 360, dx: 0 }, height);
  const onRail = dragPlace(near, height) - 0.5;
  let far = pressRail({ y: 300, dx: 0 }, 0.5, height);
  far = dragRail(far, { y: 300, dx: -FAR }, height);
  far = dragRail(far, { y: 360, dx: -FAR }, height);
  const away = dragPlace(far, height) - 0.5;
  assert.ok(Math.abs(away - 60 / 600) < 1e-9, "pulled away the finger's travel is the thumb's");
  assert.ok(Math.abs(onRail - away / ZOOM) < 1e-9, `${onRail} against ${away / ZOOM}`);
  // Between the two the zoom eases: halfway out the same travel moves the place by 1 / sqrt(8) of it.
  let half = pressRail({ y: 300, dx: 0 }, 0.5, height);
  half = dragRail(half, { y: 300, dx: NEAR + (FAR - NEAR) / 2 }, height);
  half = dragRail(half, { y: 360, dx: NEAR + (FAR - NEAR) / 2 }, height);
  assert.ok(Math.abs(dragPlace(half, height) - 0.5 - away / Math.sqrt(ZOOM)) < 1e-9);
});

test("pulled away after a zoom, the finger's spot is the current place and the rail's ends are the book's ends", () => {
  const height = 600;
  let drag = pressRail({ y: 300, dx: 0 }, 0.5, height);
  drag = dragRail(drag, { y: 380, dx: 0 }, height);
  const current = dragPlace(drag, height);
  assert.ok(Math.abs(current - (300 + 80 / ZOOM) / 600) < 1e-9);
  // Pulled away at the same y: the place stays.
  drag = dragRail(drag, { y: 380, dx: FAR }, height);
  assert.equal(drag.zoom, 1);
  assert.ok(Math.abs(dragPlace(drag, height) - current) < 1e-9);
  // From there the top of the rail is the book's start and the bottom its end.
  assert.equal(dragPlace(dragRail(drag, { y: 0, dx: FAR }, height), height), 0);
  assert.equal(dragPlace(dragRail(drag, { y: height, dx: FAR }, height), height), 1);
  // Halfway to the bottom from the finger's spot is halfway from the current place to the end.
  const half = dragPlace(dragRail(drag, { y: 380 + (height - 380) / 2, dx: FAR }, height), height);
  assert.ok(Math.abs(half - (current + (1 - current) / 2)) < 1e-9);
  // Back on the rail the thumb moves finely again from where it is.
  const fine = dragRail(dragRail(drag, { y: 380, dx: 0 }, height), { y: 388, dx: 0 }, height);
  assert.ok(Math.abs(dragPlace(fine, height) - current - 1 / 600) < 1e-9);
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
  // Left and Right stay the app's keys (30 seconds back and on, or a page), also with the focus on the rail.
  assert.equal(railKey("ArrowLeft", segments, 0.3), null);
  assert.equal(railKey("ArrowRight", segments, 0.3), null);
});

/** A seam's `showPlace` whose answers the test gives: every call is listed, and `answer` settles the call at `at`. */
function shows() {
  const calls: { place: number; load: boolean }[] = [];
  const open: ((there: boolean) => void)[] = [];
  const show = (place: number, load: boolean) => {
    calls.push({ place, load });
    return new Promise<boolean>((resolve) => open.push(resolve));
  };
  const answer = async (at: number, there: boolean) => {
    open[at]!(there);
    await new Promise((done) => setImmediate(done));
  };
  const asked = () => calls.filter((call) => call.load).map((call) => call.place);
  return { calls, show, answer, asked };
}

test("a held thumb's rests: a part is asked for once the thumb has rested on its place, and not while it moves", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { calls, show, answer, asked } = shows();
  const rest = railRest(show);
  // Loaded text follows every move and nothing is asked for.
  rest.moved(0.1);
  await answer(0, true);
  mock.timers.tick(REST_MS * 2);
  assert.deepEqual(calls, [{ place: 0.1, load: false }]);
  // A place that is not loaded: asked for after the rest, once.
  rest.moved(0.5);
  await answer(1, false);
  mock.timers.tick(REST_MS - 1);
  assert.deepEqual(asked(), []);
  mock.timers.tick(1);
  assert.deepEqual(asked(), [0.5]);
  mock.timers.tick(REST_MS * 2);
  assert.deepEqual(asked(), [0.5]);
  // A move before the rest is over: the place left is not asked for, the new one after its own rest.
  rest.moved(0.6);
  await answer(3, false);
  mock.timers.tick(REST_MS - 1);
  rest.moved(0.7);
  await answer(4, false);
  mock.timers.tick(REST_MS - 1);
  assert.deepEqual(asked(), [0.5]);
  mock.timers.tick(1);
  assert.deepEqual(asked(), [0.5, 0.7]);
  // Let go during a rest: nothing more is asked for.
  rest.moved(0.8);
  await answer(6, false);
  rest.stop();
  mock.timers.tick(REST_MS * 2);
  assert.deepEqual(asked(), [0.5, 0.7]);
});

test("a held thumb's rests: the late answer for a place the thumb has left does not end the rest of the place it is on", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { calls, show, answer, asked } = shows();
  const rest = railRest(show);
  // The last two moves of a drag, a frame apart: from loaded text into text that is not loaded.
  rest.moved(0.4);
  rest.moved(0.9);
  assert.deepEqual(calls, [{ place: 0.4, load: false }, { place: 0.9, load: false }]);
  // The view answers the second at once (not loaded), and the first two frames later: "not shown", as the second
  // move replaced it.
  await answer(1, false);
  await answer(0, false);
  mock.timers.tick(REST_MS);
  assert.deepEqual(asked(), [0.9], "the thumb rests on 0.9: its part is asked for");
});

test("the words: the readout and the slider's value text as the boards' labels read", () => {
  const segments = [
    { label: "Chapter 5", start: 0, end: 0.3 },
    { label: "Chapter 9", start: 0.3, end: 1 },
  ];
  assert.deepEqual(railReadout(segments, 0.35), { chapter: "Chapter 9", percent: 35, of: "book" });
  assert.equal(readoutLine(railReadout(segments, 0.35)), "Chapter 9 · 35%");
  assert.equal(readoutShare(railReadout(segments, 0.35)), "35%");
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

// A book of 101 sentences (places in hundredths): A is sentences 0 to 19, B 20 to 69, C 70 to 100.
const hundred = [
  { label: "A", start: 0, end: 0.2 },
  { label: "B", start: 0.2, end: 0.7 },
  { label: "C", start: 0.7, end: 1 },
];
const near = (actual: number, expected: number, what?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what ?? ""} ${actual} is not ${expected}`);

test("what the rail shows: the whole book, or the chapter of the place in view with a slot for each of its sentences", () => {
  assert.deepEqual(railSpan(hundred, 101, "book", 0.3), { scope: "book", chapter: 1, from: 0, to: 1, last: 1, sentences: 101 });
  const chapter = railSpan(hundred, 101, "chapter", 0.3);
  assert.equal(chapter.scope, "chapter");
  assert.equal(chapter.chapter, 1);
  assert.equal(chapter.from, 0.2);
  assert.equal(chapter.to, 0.7);
  near(chapter.last, 0.69, "the chapter's last sentence");
  assert.equal(chapter.sentences, 50);
  // A place where the next chapter starts is that chapter's.
  assert.equal(railSpan(hundred, 101, "chapter", 0.7).chapter, 2);
  // The book's last chapter has a slot for the last sentence too.
  const final = railSpan(hundred, 101, "chapter", 1);
  assert.equal(final.sentences, 31);
  assert.equal(final.last, 1);
  near(final.to, 1.01);
  // The shares of a span and back: its first sentence at 0, never past its last.
  near(spanShare(chapter, 0.2), 0);
  near(spanShare(chapter, 0.45), 0.5);
  assert.ok(spanShare(chapter, 0.1) < 0 && spanShare(chapter, 0.9) > 1, "a place outside the chapter is off its rail");
  near(spanPlace(chapter, 0.5), 0.45);
  near(spanPlace(chapter, 1), 0.69, "the foot of the chapter's rail is its last sentence, not the next chapter");
  near(spanPlace(chapter, -1), 0.2);
  assert.equal(spanPlace(railSpan(hundred, 101, "book", 0.3), 0.42), 0.42);
  assert.deepEqual(spanSegments(hundred, chapter), [{ label: "B", start: 0, end: 1 }]);
  assert.equal(spanSegments(hundred, railSpan(hundred, 101, "book", 0.3)), hundred);
});

test("the chapter's rail is cut at its sentences; where they are under 4 px a cut stands for 2, 5, 10 … of them", () => {
  assert.equal(tickStep(12), 1);
  assert.equal(tickStep(4), 1);
  assert.equal(tickStep(3.9), 2);
  assert.equal(tickStep(1.75), 5);
  assert.equal(tickStep(0.5), 10);
  assert.equal(tickStep(0.25), 20);
  assert.equal(tickStep(0.05), 100);
  assert.equal(tickStep(0), 1);
  // 50 sentences on 400 px are 8 px each: a cut at every sentence, 2 px high.
  const rest = railPicture([{ label: "B", start: 0, end: 1 }], { place: 0.5, narrated: 0.5, following: true, drag: null, scope: "chapter", sentences: 50 }, 400);
  assert.deepEqual(rest.ticks, { origin: 0, pitch: 8, gap: 2, step: 1 });
  assert.deepEqual(rest.segments.map((segment) => [segment.top, segment.height, segment.tone]), [[0, 398, "line"]]);
  assert.deepEqual(rest.read, { top: 0, height: 200 });
  assert.deepEqual(rest.thumb, { top: 192, height: 16, held: false, tone: "accent" });
  // 400 sentences on 400 px are 1 px each: a cut every 5 sentences, 1 px high.
  const long = railPicture([{ label: "B", start: 0, end: 1 }], { place: 0.5, narrated: null, following: false, drag: null, scope: "chapter", sentences: 400 }, 400);
  assert.deepEqual(long.ticks, { origin: 0, pitch: 5, gap: 1, step: 5 });
  // Zoomed 8 times about the thumb at 200 they are 8 px each: every sentence, from where the chapter begins.
  const zoomed = railPicture([{ label: "B", start: 0, end: 1 }], { place: 0.5, narrated: null, following: false, drag: { u: 200, zoom: ZOOM }, scope: "chapter", sentences: 400 }, 400);
  assert.deepEqual(zoomed.ticks, { origin: 200 - 200 * ZOOM, pitch: 8, gap: 2, step: 1 });
  // The whole book's rail has no such cuts.
  assert.equal(railPicture(book, { place: 0.375, narrated: 0.375, following: true, drag: null }, 400).ticks, null);
});

test("the chapter's rail: held it keeps what is read above the thumb, and the narration outside the chapter has no mark", () => {
  const one = [{ label: "B", start: 0, end: 1 }];
  const held = railPicture(one, { place: 0.2, narrated: 0.2, following: false, drag: { u: 100, zoom: 1 }, scope: "chapter", sentences: 50 }, 400);
  assert.deepEqual(held.segments.map((segment) => segment.tone), ["line"]);
  assert.deepEqual(held.read, { top: 0, height: 100 });
  assert.deepEqual(held.thumb, { top: 98, height: 4, held: true, tone: "text" });
  const before = railPicture(one, { place: 0.5, narrated: -0.4, following: false, drag: null, scope: "chapter", sentences: 50 }, 400);
  assert.equal(before.mark, null);
  const after = railPicture(one, { place: 0.5, narrated: 1.3, following: false, drag: null, scope: "chapter", sentences: 50 }, 400);
  assert.equal(after.mark, null);
  const inside = railPicture(one, { place: 0.5, narrated: 0.25, following: false, drag: null, scope: "chapter", sentences: 50 }, 400);
  assert.deepEqual(inside.mark, { top: 98.5, height: 3 });
  // Following across a chapter's end, the narrated sentence is in the next chapter: the thumb keeps the accent.
  assert.equal(railPicture(one, { place: 0.98, narrated: 1.02, following: true, drag: null, scope: "chapter", sentences: 50 }, 400).thumb.tone, "accent");
});

test("the chapter's rail: Home and End are the chapter's ends, and the words give the percentage of the chapter", () => {
  const chapter = railSpan(hundred, 101, "chapter", 0.3);
  assert.deepEqual(railKey("Home", hundred, 0.3, chapter), { kind: "place", place: 0.2 });
  near((railKey("End", hundred, 0.3, chapter) as { place: number }).place, 0.69);
  assert.deepEqual(railKey("PageDown", hundred, 0.3, chapter), { kind: "place", place: 0.7 });
  const book = railSpan(hundred, 101, "book", 0.3);
  assert.deepEqual(railKey("Home", hundred, 0.3, book), { kind: "place", place: 0 });
  assert.deepEqual(railKey("End", hundred, 0.3, book), { kind: "place", place: 1 });
  // Sentence 45 of 20 to 69: 25 of 49 steps.
  assert.deepEqual(railReadout(hundred, 0.45, chapter), { chapter: "B", percent: 51, of: "chapter" });
  assert.equal(railReadout(hundred, 0.2, chapter).percent, 0);
  assert.equal(railReadout(hundred, chapter.last, chapter).percent, 100);
  assert.equal(readoutLine(railReadout(hundred, 0.45, chapter)), "B · 51% of the chapter");
  assert.equal(readoutShare(railReadout(hundred, 0.45, chapter)), "51% of the chapter");
  assert.deepEqual(railReadout(hundred, 0.45, book), { chapter: "B", percent: 45, of: "book" });
  assert.equal(railValueText(hundred, 0.45, 0.1, false, chapter), "B, 51% of the chapter. The narration is in A.");
  assert.equal(railValueText(hundred, 0.45, 0.45, true, chapter), "B, 51% of the chapter. Following the narration.");
});
