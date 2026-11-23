// The text position rail's rules (#804, step 5 of #799; boards RailParts B, RailB, RailBDrag, RailTry): where a place
// of the book is on the rail, the drag and its zoom, what a touch is, and what is drawn in each state. Pure: no page,
// no view. The rail's page part is text-rail.ts.
//
// A place is a sentence's place among the book's sentences, 0 to 1 (`SentenceIndex.progression`, the number the foot's
// percent uses), fractional while the thumb is held between two sentences. The rail's top is the first sentence and
// its bottom the last; its y is measured from the rail's top, 0 to `height`.
import type { PreparedManifest } from "../server/prepared-text";
import type { SentenceIndex } from "./prepared-book";

/** A chapter on the rail: its label and its run of places, from its first sentence to the next chapter's. */
export type RailSegment = { label: string; start: number; end: number };

/** A press this near the thumb, above or below, picks it up where it is (no jump). */
export const GRAB = 22;
/** No zoom while the finger is this near the rail's centre line, sideways. */
export const DEAD = 32;
/** The sideways distance at which the zoom is whole. */
export const PULL = 100;
/** The zoom at PULL and beyond. */
export const ZOOM = 8;
/** A touch takes the rail once it has moved this far, more up or down than sideways. */
export const TOUCH_SLOP = 8;
/** A place whose part is not loaded is asked for once the thumb has rested this long. */
export const REST_MS = 150;
/** The rail's centre line, from the band's right edge. */
export const CENTRE = 12;
/** The room at the rail's ends, so the thumb with its ring stays inside the band at the book's ends. */
export const END_ROOM = 10;

/**
 * The chapters drawn: the book's own contents (`manifest.chapters`), at the shallowest depth, or one level deeper
 * where that gives the book a single segment (a book whose contents are its title with the chapters under it).
 * Chapters at a shallower depth than the one chosen stay. Text before the first chapter is a segment of its own.
 */
export function railSegments(manifest: Pick<PreparedManifest, "chapters" | "sections">, index: Pick<SentenceIndex, "ordinalOf" | "total">): RailSegment[] {
  const last = Math.max(1, index.total - 1);
  const placed = manifest.chapters
    .map((chapter) => ({ label: chapter.label, depth: chapter.depth, ordinal: index.ordinalOf(chapter.sentence) }))
    .filter((chapter) => chapter.ordinal >= 0);
  const depths = [...new Set(placed.map((chapter) => chapter.depth))].sort((a, b) => a - b);
  const starts = (depth: number) => new Set(placed.filter((chapter) => chapter.depth <= depth).map((chapter) => chapter.ordinal));
  let depth = depths[0] ?? 0;
  for (const deeper of depths) {
    depth = deeper;
    if (starts(deeper).size > 1) break;
  }
  const chosen = placed.filter((chapter) => chapter.depth <= depth).sort((a, b) => a.ordinal - b.ordinal);
  const runs: { label: string; ordinal: number }[] = [];
  for (const chapter of chosen) if (runs.at(-1)?.ordinal !== chapter.ordinal) runs.push(chapter);
  if (!runs.length || runs[0]!.ordinal > 0) runs.unshift({ label: manifest.sections[0]?.title || "Start", ordinal: 0 });
  return runs.map((run, at) => ({ label: run.label, start: run.ordinal / last, end: at + 1 < runs.length ? runs[at + 1]!.ordinal / last : 1 }));
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const clamp01 = (value: number) => clamp(value, 0, 1);

/** The segment that holds a place: the last that starts at or before it. */
export function segmentAt(segments: readonly RailSegment[], place: number): number {
  for (let at = 0; at < segments.length; at++) if (place < segments[at]!.end) return at;
  return Math.max(0, segments.length - 1);
}

/** A place to its y on the rail at rest: the chapters are drawn to scale, so the book's places are too. */
export const placeToY = (place: number, height: number) => clamp01(place) * height;
/** A y on the rail at rest to its place. */
export const yToPlace = (y: number, height: number) => (height > 0 ? clamp01(y / height) : 0);

/** The zoom for the finger's sideways distance from the rail's centre line: 1 within DEAD, then `8 ^ s` to 8 at PULL. */
export function zoomOf(dx: number): number {
  const side = Math.max(10, PULL - DEAD);
  const s = clamp01((Math.abs(dx) - DEAD) / side);
  return Math.exp(Math.log(ZOOM) * s);
}

/**
 * Back on the rail after a zoom: the whole book again, re-anchored so that the finger's spot `y0` is the current
 * place `u0` and the rail's ends are still the book's ends (RailTry's `barMap`).
 */
export function barMap(y: number, y0: number, u0: number, height: number): number {
  if (y <= y0) return y0 > 0.01 ? (u0 * y) / y0 : u0;
  return height - y0 > 0.01 ? u0 + ((height - u0) * (y - y0)) / (height - y0) : u0;
}

/** Where the finger is: its y from the rail's top, and its sideways distance from the centre line. */
export type RailPointer = { y: number; dx: number };
/** A drag in progress (RailTry's `drag`), with `u` the thumb's y at rest scale. */
export type RailDrag = { off: number; lastY: number; u: number; y0: number; u0: number; fine: boolean; zoom: number; grabbed: boolean };

/**
 * A press on the rail: within GRAB of the thumb it picks the thumb up where it is; elsewhere the thumb goes to the
 * finger (at a zoom, by `1 / zoom` of the way from the thumb). `place` is the thumb's place before the press.
 */
export function pressRail(pointer: RailPointer, place: number, height: number): RailDrag {
  const a = placeToY(place, height);
  const grabbed = Math.abs(pointer.y - a) <= GRAB;
  const off = grabbed ? pointer.y - a : 0;
  const ye = clamp(pointer.y - off, 0, height);
  let zoom = zoomOf(pointer.dx);
  let u = ye;
  if (zoom <= 1.001) zoom = 1;
  else if (!grabbed) u = clamp(a + (ye - a) / zoom, 0, height);
  if (grabbed) u = a;
  return { off, lastY: ye, u, y0: clamp(ye, 1, height - 1), u0: u, fine: zoom > 1, zoom, grabbed };
}

/** The finger moved while held (RailTry's `dragTo`): the drag after it. Zoomed, the same travel moves `1 / zoom` of it. */
export function dragRail(drag: RailDrag, pointer: RailPointer, height: number): RailDrag {
  const ye = clamp(pointer.y - drag.off, 0, height);
  let zoom = zoomOf(pointer.dx);
  const next = { ...drag };
  if (zoom <= 1.001) {
    zoom = 1;
    if (next.fine) {
      next.fine = false;
      next.y0 = clamp(ye, 1, height - 1);
      next.u0 = next.u;
    }
    next.u = barMap(ye, next.y0, next.u0, height);
  } else {
    next.fine = true;
    next.u = clamp(next.u + (ye - next.lastY) / zoom, 0, height);
  }
  next.lastY = ye;
  next.zoom = zoom;
  return next;
}

/** The place a drag shows. */
export const dragPlace = (drag: RailDrag, height: number) => yToPlace(drag.u, height);

/** What a touch in the rail's area is so far: not decided, the rail's drag, or the text's (a tap, a swipe). */
export type TouchIntent = "pending" | "rail";
/** A touch takes the rail once it has moved TOUCH_SLOP and more up or down than sideways. */
export function touchIntent(dx: number, dy: number): TouchIntent {
  return Math.hypot(dx, dy) >= TOUCH_SLOP && Math.abs(dy) > Math.abs(dx) ? "rail" : "pending";
}

/** Whether a point is in the rail's touch area: the band's right margin over its height, or the box around the thumb. */
export function inRailArea(x: number, y: number, band: { left: number; top: number; right: number; bottom: number }, margin: number, thumbY: number): boolean {
  if (y < band.top || y > band.bottom || x > band.right || x < band.left) return false;
  if (x >= band.right - margin) return true;
  const centre = band.right - CENTRE;
  return Math.abs(x - centre) <= 22 && Math.abs(y - thumbY) <= 22;
}

/** What the keys ask for: Down and Up one band's height, Page Down and Page Up a chapter, Home and End the ends. */
export type RailKey = { kind: "band"; direction: -1 | 1 } | { kind: "place"; place: number };
export function railKey(key: string, segments: readonly RailSegment[], place: number): RailKey | null {
  if (key === "ArrowDown" || key === "ArrowRight") return { kind: "band", direction: 1 };
  if (key === "ArrowUp" || key === "ArrowLeft") return { kind: "band", direction: -1 };
  if (key === "Home") return { kind: "place", place: 0 };
  if (key === "End") return { kind: "place", place: 1 };
  const at = segmentAt(segments, place);
  if (key === "PageDown") return { kind: "place", place: at + 1 < segments.length ? segments[at + 1]!.start : 1 };
  if (key === "PageUp") {
    // Back to the start of this chapter, or of the one before when the place is at its start already.
    const own = segments[at]!.start;
    return { kind: "place", place: place - own > 1e-9 || at === 0 ? own : segments[at - 1]!.start };
  }
  return null;
}

/** The readout of a place, as the foot shows it while the thumb is held: `<Chapter> · <N>%`. */
export function railReadout(segments: readonly RailSegment[], place: number): { chapter: string; percent: number } {
  return { chapter: segments[segmentAt(segments, place)]?.label ?? "", percent: Math.round(clamp01(place) * 100) };
}

/** The slider's value text: the place, and where the narration is. */
export function railValueText(segments: readonly RailSegment[], place: number, narrated: number | null, following: boolean): string {
  const { chapter, percent } = railReadout(segments, place);
  const here = `${chapter}, ${percent}%.`;
  if (narrated === null) return here;
  if (following) return `${here} Following the narration.`;
  return `${here} The narration is in ${segments[segmentAt(segments, narrated)]?.label ?? ""}.`;
}

/** The rail's state for drawing: the thumb's place, the narrated place, following or away, and a drag. */
export type RailState = {
  place: number;
  narrated: number | null;
  following: boolean;
  drag: Pick<RailDrag, "u" | "zoom"> | null;
};
export type RailBox = { top: number; height: number };
export type RailPicture = {
  segments: (RailBox & { tone: "read" | "line" | "lit" })[];
  /** The chapter in view, filled from its top down to the thumb; null while held. */
  read: RailBox | null;
  thumb: RailBox & { held: boolean; tone: "accent" | "text" };
  /** The narration mark, away from the narration; null when following, without a narrated sentence or off the rail. */
  mark: RailBox | null;
  /** The overview at the band's outer edge while zoomed. */
  overview: { opacity: number; lit: RailBox; tick: RailBox | null } | null;
};

/** What is drawn (RailTry's `renderVals` for "Zoom by distance from the bar"), y from the rail's top. */
export function railPicture(segments: readonly RailSegment[], state: RailState, height: number): RailPicture {
  const held = !!state.drag;
  const zoomed = held && state.drag!.zoom > 1.001;
  const anchor = zoomed ? state.drag!.u : null;
  const zoom = zoomed ? state.drag!.zoom : 1;
  const toY = (place: number) => {
    const y = placeToY(place, height);
    return anchor === null ? y : anchor + (y - anchor) * zoom;
  };
  const place = held ? yToPlace(state.drag!.u, height) : state.place;
  const current = segmentAt(segments, place);
  const drawn = segments.map((segment, at) => {
    const a = toY(segment.start), b = toY(segment.end);
    const top = clamp(a, 0, height), bottom = clamp(b, 0, height);
    const size = b <= 0 || a >= height ? 0 : Math.max(1, bottom - top - 2);
    const tone: "read" | "line" | "lit" = at < current ? "read" : at === current && held ? "lit" : "line";
    return { top, height: size, tone };
  });
  const y = clamp(toY(place), 0, height);
  let read: RailBox | null = null;
  if (!held && segments[current]) {
    const top = clamp(toY(segments[current]!.start), 0, height);
    const size = Math.max(0, Math.min(y, toY(segments[current]!.end) - 2) - top);
    if (size >= 1) read = { top, height: size };
  }
  const thumb = held
    ? { top: y - 2, height: 4, held: true, tone: "text" as const }
    : { top: y - 8, height: 16, held: false, tone: state.following && state.narrated !== null ? ("accent" as const) : ("text" as const) };
  let mark: RailBox | null = null;
  if (!state.following && state.narrated !== null) {
    const at = toY(state.narrated);
    if (at >= 0 && at <= height) mark = { top: at - 1.5, height: 3 };
  }
  let overview: RailPicture["overview"] = null;
  if (zoom > 1.02 && anchor !== null) {
    overview = {
      opacity: Math.round(Math.min(1, (zoom - 1) / 1.5) * 100) / 100,
      lit: { top: anchor - anchor / zoom, height: height / zoom },
      tick: state.narrated === null ? null : { top: placeToY(state.narrated, height) - 1, height: 3 },
    };
  }
  return { segments: drawn, read, thumb, mark, overview };
}
