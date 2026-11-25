// The text position rail's rules (#804, step 5 of #799; boards RailParts B, RailB, RailBDrag, RailTry): where a place
// of the book is on the rail, the drag and its zoom, what a touch is, and what is drawn in each state. Pure: no page,
// no view. The rail's page part is text-rail.ts.
//
// The zoom is by the finger's sideways distance from the rail, the other way round from the RailTry board (the
// owner's change, 2026-11-23): on the rail the held thumb moves finely, zoomed in ZOOM times about its place, and
// pulling the finger away zooms out, to the whole of what the rail shows at FAR.
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
/** The zoom is whole while the finger is this near the rail's centre line, sideways. */
export const NEAR = 32;
/** The sideways distance at which nothing is zoomed any more: the rail is the whole of what it shows. */
export const FAR = 100;
/** The zoom at NEAR and nearer. */
export const ZOOM = 8;
/** A touch takes the rail once it has moved this far, more up or down than sideways. */
export const TOUCH_SLOP = 8;
/** A place whose part is not loaded is asked for once the thumb has rested this long. */
export const REST_MS = 150;
/** The rail's centre line, from the band's right edge. */
export const CENTRE = 12;
/** The room at the rail's ends, so the thumb with its ring stays inside the band at the book's ends. */
export const END_ROOM = 10;
/** A subdivision of the chapter's rail is at least this high; where a sentence is lower, one stands for several. */
export const TICK_MIN = 4;
/** A thumb picked up where it is has moved once its y is this far from there (the least a pointer moves it is far more). */
export const STILL = 0.01;

/** What the rail shows (the reader's "Reading position shows"): the whole book, or the chapter of the place in view. */
export type RailScope = "book" | "chapter";

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
export const clamp01 = (value: number) => clamp(value, 0, 1);

/** The segment that holds a place: the last that starts at or before it. */
export function segmentAt(segments: readonly RailSegment[], place: number): number {
  for (let at = 0; at < segments.length; at++) if (place < segments[at]!.end) return at;
  return Math.max(0, segments.length - 1);
}

/**
 * The stretch of the book the rail shows, in places: all of it, or one chapter. `to` is where the next chapter starts
 * (one sentence past the book's last, for the last chapter), so each of its `sentences` has a slot of its own on the
 * rail; `last` is the place of the stretch's last sentence, the furthest a thumb goes.
 */
export type RailSpan = { scope: RailScope; chapter: number; from: number; to: number; last: number; sentences: number };

/** The span for a scope: the whole book, or the chapter that holds `place`. `sentences` is the book's count. */
export function railSpan(segments: readonly RailSegment[], sentences: number, scope: RailScope, place: number): RailSpan {
  const chapter = segmentAt(segments, place);
  const segment = segments[chapter];
  if (scope === "book" || !segment) return { scope: "book", chapter, from: 0, to: 1, last: 1, sentences };
  const step = 1 / Math.max(1, sentences - 1);
  const to = chapter === segments.length - 1 ? 1 + step : segment.end;
  return { scope: "chapter", chapter, from: segment.start, to, last: Math.max(segment.start, to - step), sentences: Math.max(1, Math.round((to - segment.start) / step)) };
}
/** A place of the book as a share of the span: 0 to 1 inside it, below 0 before it and above 1 after it. */
export const spanShare = (span: RailSpan, place: number) => (place - span.from) / (span.to - span.from);
/** A share of the span as a place of the book, never past the span's last sentence. */
export const spanPlace = (span: RailSpan, share: number) => Math.min(span.last, span.from + clamp01(share) * (span.to - span.from));
/** What the span is cut into, in shares of it: the book's chapters, or the one chapter (cut at its sentences when drawn). */
export const spanSegments = (segments: readonly RailSegment[], span: RailSpan): readonly RailSegment[] =>
  span.scope === "book" ? segments : [{ label: segments[span.chapter]?.label ?? "", start: 0, end: 1 }];
/**
 * How many sentences one subdivision of the chapter's rail stands for: the fewest of 1, 2, 5, 10, 20, 50, … whose
 * height is TICK_MIN or more, for sentences `slot` px high. A short chapter, or a zoomed one, is cut at every sentence.
 */
export function tickStep(slot: number): number {
  if (!(slot > 0)) return 1;
  for (let scale = 1; ; scale *= 10) for (const count of [1, 2, 5]) if (slot * count * scale >= TICK_MIN) return count * scale;
}

/** A place to its y on the rail at rest: the chapters are drawn to scale, so the book's places are too. */
export const placeToY = (place: number, height: number) => clamp01(place) * height;
/** A y on the rail at rest to its place. */
export const yToPlace = (y: number, height: number) => (height > 0 ? clamp01(y / height) : 0);

/**
 * The zoom for the finger's sideways distance from the rail's centre line: ZOOM within NEAR, then `8 ^ (1 - s)` down
 * to 1 at FAR and beyond.
 */
export function zoomOf(dx: number): number {
  const side = Math.max(10, FAR - NEAR);
  const s = clamp01((Math.abs(dx) - NEAR) / side);
  return Math.exp(Math.log(ZOOM) * (1 - s));
}

/**
 * Pulled away to FAR after a zoom: the whole book again, re-anchored so that the finger's spot `y0` is the current
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
 * finger, whatever the zoom: the rail at rest shows the whole of its span, so the finger is on the place it asks for.
 * The drag begins at the zoom of the finger's distance (on the rail: zoomed in). `place` is the thumb's place before
 * the press.
 */
export function pressRail(pointer: RailPointer, place: number, height: number): RailDrag {
  const a = placeToY(place, height);
  const grabbed = Math.abs(pointer.y - a) <= GRAB;
  const off = grabbed ? pointer.y - a : 0;
  const ye = clamp(pointer.y - off, 0, height);
  let zoom = zoomOf(pointer.dx);
  if (zoom <= 1.001) zoom = 1;
  const u = grabbed ? a : ye;
  return { off, lastY: ye, u, y0: clamp(ye, 1, height - 1), u0: u, fine: zoom > 1, zoom, grabbed };
}

/**
 * The finger moved while held (RailTry's `dragTo`): the drag after it. Zoomed, the same travel moves `1 / zoom` of
 * it; at FAR the finger's y is a place of the whole rail again (`barMap`).
 */
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

/**
 * The text under a held thumb: each move shows its place where the text is loaded, and a place whose part is not
 * loaded is asked for once the thumb has rested on it REST_MS. `show` is the seam's `showPlace`. An answer for a place
 * the thumb has left since starts no rest and ends none: the newer move has its own.
 */
export function railRest(show: (place: number, load: boolean) => Promise<boolean>) {
  let at: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    /** The held thumb moved to `place`. */
    moved(place: number) {
      at = place;
      clear();
      void show(place, false).then((there) => {
        if (there || at !== place) return;
        clear();
        timer = setTimeout(() => {
          timer = null;
          if (at === place) void show(place, true);
        }, REST_MS);
      });
    },
    /** The thumb was let go: nothing more is asked for. */
    stop() {
      at = null;
      clear();
    },
  };
}

/** What a touch in the rail's area is so far: not decided (the text's, if it ends so: a tap, a swipe), or the rail's drag. */
export type TouchIntent = "pending" | "rail";
/** A touch takes the rail once it has moved TOUCH_SLOP and more up or down than sideways. */
export function touchIntent(dx: number, dy: number): TouchIntent {
  return Math.hypot(dx, dy) >= TOUCH_SLOP && Math.abs(dy) > Math.abs(dx) ? "rail" : "pending";
}

/**
 * What the keys ask for: Down and Up one band's height, Page Down and Page Up a chapter, Home and End the ends of what
 * the rail shows. Left and Right are not the rail's: they stay the app's keys (30 seconds back and on, or a page).
 */
export type RailKey = { kind: "band"; direction: -1 | 1 } | { kind: "place"; place: number };
export function railKey(key: string, segments: readonly RailSegment[], place: number, span?: RailSpan): RailKey | null {
  if (key === "ArrowDown") return { kind: "band", direction: 1 };
  if (key === "ArrowUp") return { kind: "band", direction: -1 };
  // The ends of what the rail shows: the book's, or the chapter's.
  if (key === "Home") return { kind: "place", place: span?.from ?? 0 };
  if (key === "End") return { kind: "place", place: span?.last ?? 1 };
  const at = segmentAt(segments, place);
  if (key === "PageDown") return { kind: "place", place: at + 1 < segments.length ? segments[at + 1]!.start : 1 };
  if (key === "PageUp") {
    // Back to the start of this chapter, or of the one before when the place is at its start already.
    const own = segments[at]!.start;
    return { kind: "place", place: place - own > 1e-9 || at === 0 ? own : segments[at - 1]!.start };
  }
  return null;
}

/**
 * The readout of a place, as the foot shows it while the thumb is held: `<Chapter> · <N>%`, the percentage of what the
 * rail shows (`of`): the book, or the chapter from its first sentence to its last.
 */
export type RailReadout = { chapter: string; percent: number; of: RailScope };
export function railReadout(segments: readonly RailSegment[], place: number, span?: RailSpan): RailReadout {
  const share = span && span.scope === "chapter" ? (span.last > span.from ? (place - span.from) / (span.last - span.from) : 0) : place;
  return { chapter: segments[segmentAt(segments, place)]?.label ?? "", percent: Math.round(clamp01(share) * 100), of: span?.scope ?? "book" };
}
/** A readout's share in words: "35%", and "35% of the chapter" where the rail shows the chapter. */
export const readoutShare = (readout: RailReadout) => `${readout.percent}%${readout.of === "chapter" ? " of the chapter" : ""}`;
/** The foot's words for a readout: "Chapter 9 · 35%", and "Chapter 9 · 35% of the chapter" where the rail shows the chapter. */
export const readoutLine = (readout: RailReadout) => `${readout.chapter} · ${readoutShare(readout)}`;

/** The slider's value text: the place, and where the narration is. */
export function railValueText(segments: readonly RailSegment[], place: number, narrated: number | null, following: boolean, span?: RailSpan): string {
  const readout = railReadout(segments, place, span);
  const here = `${readout.chapter}, ${readoutShare(readout)}.`;
  if (narrated === null) return here;
  if (following) return `${here} Following the narration.`;
  return `${here} The narration is in ${segments[segmentAt(segments, narrated)]?.label ?? ""}.`;
}

/** The rail's state for drawing: the thumb's place, the narrated place, following or away, and a drag. */
export type RailState = {
  place: number;
  /** The narrated place as a share of what the rail shows: below 0 or above 1 when it is outside the chapter shown. */
  narrated: number | null;
  following: boolean;
  drag: Pick<RailDrag, "u" | "zoom"> | null;
  /** The chapter's rail: one column for the chapter (`segments` is that one), cut at its `sentences`. */
  scope?: RailScope;
  sentences?: number;
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
  /**
   * The chapter's rail only: where its subdivisions are cut. `origin` is the y of the chapter's first sentence, `pitch`
   * the height of one subdivision (`step` sentences) and `gap` the cut at its foot.
   */
  ticks: { origin: number; pitch: number; gap: number; step: number } | null;
};

/** What is drawn (RailTry's `renderVals` for "Zoom by distance from the bar"), y from the rail's top. */
export function railPicture(segments: readonly RailSegment[], state: RailState, height: number): RailPicture {
  const held = !!state.drag;
  // The chapter's rail is one column: held, it keeps the part read above the thumb instead of lighting the chapter.
  const chapter = state.scope === "chapter";
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
    const tone: "read" | "line" | "lit" = at < current ? "read" : at === current && held && !chapter ? "lit" : "line";
    return { top, height: size, tone };
  });
  const y = clamp(toY(place), 0, height);
  let read: RailBox | null = null;
  if ((!held || chapter) && segments[current]) {
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
    if (state.narrated >= 0 && state.narrated <= 1 && at >= 0 && at <= height) mark = { top: at - 1.5, height: 3 };
  }
  let overview: RailPicture["overview"] = null;
  if (zoom > 1.02 && anchor !== null) {
    overview = {
      opacity: Math.round(Math.min(1, (zoom - 1) / 1.5) * 100) / 100,
      lit: { top: anchor - anchor / zoom, height: height / zoom },
      tick: state.narrated === null || state.narrated < 0 || state.narrated > 1 ? null : { top: placeToY(state.narrated, height) - 1, height: 3 },
    };
  }
  let ticks: RailPicture["ticks"] = null;
  if (chapter && state.sentences) {
    const slot = (height * zoom) / state.sentences;
    const step = tickStep(slot);
    const pitch = slot * step;
    ticks = { origin: toY(0), pitch, gap: pitch >= 2 * TICK_MIN ? 2 : 1, step };
  }
  return { segments: drawn, read, thumb, mark, overview, ticks };
}
