// The text position rail (#804, step 5 of #799; boards RailParts B, RailB, RailBDrag, RailBZoom, RailTry): a thin
// column of the book's chapters in the text band's right margin, with a thumb for the place in view and a narration
// mark for where the narration is. Plain DOM, no React. Its rules are text-rail-model.ts.
//
// It shows the whole book, cut at its chapters, or the chapter of the place in view, cut at its sentences (the
// reader's "Reading position shows", as the listening bar shows the whole audiobook or the current chapter).
//
// It knows the reading view through `RailSeam` alone, in places of the book (0 to 1 by sentence): the place in view,
// "show this place", and the text's own tap rule for a touch it did not take. The new view's scroll mode gives the
// seam (prepared-view.ts `railSeam`); pages mode gives the same seam and the rail is unchanged.
//
// Nothing is drawn over the text (ADR 0019): every drawn box is inside the band's right margin. The box around the
// thumb that a finger can take reaches over the line ends beside it and is not drawn.
// The audio is never touched: the rail has no way to the player. A move by the rail is a move by hand.
import {
  CENTRE,
  END_ROOM,
  STILL,
  clamp01,
  dragPlace,
  dragRail,
  pressRail,
  railKey,
  railPicture,
  railReadout,
  railRest,
  railSpan,
  railValueText,
  spanPlace,
  spanSegments,
  spanShare,
  touchIntent,
  type RailDrag,
  type RailPointer,
  type RailReadout,
  type RailScope,
  type RailSegment,
  type RailSpan,
} from "./text-rail-model";

export type RailSeam = {
  /** The text band: the rail stands in its right margin. */
  band: HTMLElement;
  /** Tells the place of the first sentence in view, now and whenever it changes, whoever moved the text. */
  watch(listener: (place: number) => void): () => void;
  /**
   * Shows a place as a move by hand shows it: following pauses as it does for a scroll by hand and the place is
   * saved as one. With `load` false only a place whose text is loaded is shown and nothing is asked of the server
   * (false otherwise); with `load` true its part is loaded first. True once shown.
   */
  showPlace(place: number, load: boolean): Promise<boolean>;
  /** One band's height further (1) or back (-1), as a move by hand. */
  turn(direction: -1 | 1): void;
  /** The thumb is held: the view asks for no more of the book until `letGo`. */
  hold(): void;
  letGo(): void;
  /** The text's own rule for a press (a tap, a swipe), for a touch the rail did not take. */
  tap: { down(event: PointerEvent): void; move(event: PointerEvent): void; up(event: PointerEvent): void; cancel(): void };
  /** A wheel over the rail scrolls the text. */
  wheel(event: WheelEvent): void;
};

export type RailOptions = {
  segments: RailSegment[];
  /** The book's sentences: the chapter's rail is cut at them. */
  sentences: number;
  /** What the rail shows: the whole book in its chapters, or the chapter of the place in view in its sentences. */
  scope: RailScope;
  /** The thumb is held (the readout of its place for the foot) or let go (null). */
  onHeld(readout: RailReadout | null): void;
};

export type TextRail = ReturnType<typeof createTextRail>;

const px = (value: number) => `${Math.round(value * 10) / 10}px`;

export function createTextRail(seam: RailSeam, options: RailOptions) {
  const { band } = seam;
  const doc = band.ownerDocument;
  const { segments } = options;
  const span = (name: string) => {
    const element = doc.createElement("span");
    element.className = name;
    element.setAttribute("aria-hidden", "true");
    return element;
  };
  const rail = doc.createElement("div");
  rail.className = "text-rail";
  rail.tabIndex = 0;
  rail.setAttribute("role", "slider");
  rail.setAttribute("aria-label", "Reading position");
  rail.setAttribute("aria-orientation", "vertical");
  rail.setAttribute("aria-valuemin", "0");
  rail.setAttribute("aria-valuemax", "100");
  const drawn = segments.map(() => span("text-rail-segment"));
  const read = span("text-rail-read");
  const overview = span("text-rail-overview");
  const overviewLit = span("text-rail-overview-lit");
  const overviewTick = span("text-rail-overview-tick");
  overview.append(overviewLit, overviewTick);
  const mark = span("text-rail-mark");
  const thumb = span("text-rail-thumb");
  // The box around the thumb a finger can take; nothing of it is drawn.
  const grip = span("text-rail-grip");
  rail.append(...drawn, read, overview, mark, thumb, grip);
  band.append(rail);

  let place = 0;
  let narrated: number | null = null;
  let following = false;
  /** The place the rail let go at, shown until the view has shown it. */
  let released: number | null = null;
  let releases = 0;
  /**
   * The thumb held, with what the rail showed when it was taken (a drag stays in that chapter). `picked` is its y
   * while it is still where it was picked up (null once it has moved, or when the press put it elsewhere): until it
   * moves, the text stays as it is.
   */
  let held: { pointer: number; drag: RailDrag; span: RailSpan; picked: number | null } | null = null;
  let scope = options.scope;
  let touch: { pointer: number; x: number; y: number } | null = null;
  let disposed = false;

  const height = () => Math.max(1, rail.clientHeight - 2 * END_ROOM);
  const pointerOf = (event: { clientX: number; clientY: number }): RailPointer => {
    const box = rail.getBoundingClientRect();
    return { y: event.clientY - box.top - END_ROOM, dx: event.clientX - (box.right - CENTRE) };
  };
  /** What the rail shows: the whole book, or the chapter of the place in view (the one it was taken in, while held). */
  const spanNow = () => held?.span ?? railSpan(segments, options.sentences, scope, released ?? place);
  /** The thumb's place in the book. */
  const shown = () => (held ? spanPlace(held.span, dragPlace(held.drag, height())) : released ?? place);

  const render = () => {
    if (disposed) return;
    const size = height();
    const showing = spanNow();
    const now = shown();
    const picture = railPicture(
      spanSegments(segments, showing),
      { place: clamp01(spanShare(showing, now)), narrated: narrated === null ? null : spanShare(showing, narrated), following, drag: held?.drag ?? null, scope: showing.scope, sentences: showing.sentences },
      size,
    );
    rail.dataset.scope = showing.scope;
    // The chapter's rail is one column cut at its sentences: the cuts are drawn from where the chapter begins.
    const cut = (element: HTMLElement, top: number) => {
      if (!picture.ticks) return;
      element.style.setProperty("--rail-origin", px(picture.ticks.origin - top));
      element.style.setProperty("--rail-pitch", px(picture.ticks.pitch));
      element.style.setProperty("--rail-gap", px(picture.ticks.gap));
    };
    if (picture.ticks) rail.dataset.step = String(picture.ticks.step);
    else delete rail.dataset.step;
    /**
     * A box that begins at the rail's top or ends at its bottom is drawn on to the band's edge: the room at the ends
     * keeps the thumb inside the band, and the column runs the band's whole height (the owner's check, #804).
     */
    const reach = (element: HTMLElement, box: { top: number; height: number }) => {
      const top = box.top <= 0.5 ? -END_ROOM : box.top;
      const bottom = box.top + box.height >= size - 2.5 ? size + END_ROOM : box.top + box.height;
      element.style.top = px(END_ROOM + top);
      element.style.height = px(bottom - top);
      cut(element, top);
    };
    drawn.forEach((element, at) => {
      const box = picture.segments[at];
      element.hidden = !box || box.height <= 0;
      if (!box || box.height <= 0) return;
      reach(element, box);
      element.dataset.tone = box.tone;
    });
    read.hidden = !picture.read;
    if (picture.read) reach(read, picture.read);
    thumb.style.top = px(END_ROOM + picture.thumb.top);
    thumb.toggleAttribute("data-held", picture.thumb.held);
    thumb.dataset.tone = picture.thumb.tone;
    grip.style.top = px(END_ROOM + picture.thumb.top + picture.thumb.height / 2 - 22);
    mark.hidden = !picture.mark;
    if (picture.mark) mark.style.top = px(END_ROOM + picture.mark.top);
    overview.hidden = !picture.overview;
    if (picture.overview) {
      // The whole book from the band's top to its bottom, the rail's places at the same heights as on the rail.
      overview.style.top = "0px";
      overview.style.height = px(size + 2 * END_ROOM);
      overview.style.opacity = String(picture.overview.opacity);
      overviewLit.style.top = px(END_ROOM + picture.overview.lit.top);
      overviewLit.style.height = px(picture.overview.lit.height);
      overviewTick.hidden = !picture.overview.tick;
      if (picture.overview.tick) overviewTick.style.top = px(END_ROOM + picture.overview.tick.top);
    }
    rail.toggleAttribute("data-held", !!held);
    rail.toggleAttribute("data-zoomed", !!picture.overview);
    rail.setAttribute("aria-valuenow", String(railReadout(segments, now, showing).percent));
    rail.setAttribute("aria-valuetext", railValueText(segments, now, narrated, following, showing));
    // The thumb's place, for the browser tests.
    rail.setAttribute("data-place", now.toFixed(6));
  };

  /** The held thumb moved: the text follows where it is loaded; elsewhere its part is asked for once the thumb rests. */
  const rest = railRest((at, load) => seam.showPlace(at, load));
  const follow = () => {
    if (held) rest.moved(shown());
  };

  const take = (pointer: number, from: { clientX: number; clientY: number }) => {
    const showing = spanNow();
    const pressed = pressRail(pointerOf(from), clamp01(spanShare(showing, shown())), height());
    held = { pointer, drag: pressed, span: showing, picked: pressed.grabbed ? pressed.u : null };
    released = null;
    try {
      rail.setPointerCapture(pointer);
    } catch {
      // A pointer that is gone already: the release follows.
    }
    seam.hold();
    options.onHeld(railReadout(segments, shown(), showing));
    render();
    if (!held.drag.grabbed) follow();
  };
  const drag = (event: PointerEvent) => {
    if (!held) return;
    const taken = held.span;
    const next = dragRail(held.drag, pointerOf(event), height());
    held = { ...held, drag: next, picked: held.picked !== null && Math.abs(next.u - held.picked) < STILL ? held.picked : null };
    options.onHeld(railReadout(segments, shown(), taken));
    render();
    if (held.picked === null) follow();
  };
  /**
   * The release, a cancel or a lost capture: the place the thumb is let go at is shown and is the last one saved. A
   * thumb let go where it was picked up shows nothing: the text is there already, and showing its place again would
   * put the first sentence's first line at the band's top.
   */
  const letGo = () => {
    if (!held) return;
    const target = shown();
    const { pointer, picked } = held;
    held = null;
    rest.stop();
    try {
      if (rail.hasPointerCapture(pointer)) rail.releasePointerCapture(pointer);
    } catch {
      // Released already.
    }
    if (picked === null) {
      released = target;
      const release = ++releases;
      void seam.showPlace(target, true).finally(() => {
        if (release !== releases || disposed) return;
        released = null;
        render();
      });
    }
    seam.letGo();
    options.onHeld(null);
    render();
  };

  const down = (event: PointerEvent) => {
    if (event.button !== 0 || held || touch) return;
    if (event.pointerType === "touch") {
      // A touch is the text's until it moves up or down: a tap here does what a tap on the text does.
      touch = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
      seam.tap.down(event);
      return;
    }
    event.preventDefault();
    take(event.pointerId, event);
  };
  const move = (event: PointerEvent) => {
    if (held && event.pointerId === held.pointer) return drag(event);
    if (!touch || event.pointerId !== touch.pointer) return;
    if (touchIntent(event.clientX - touch.x, event.clientY - touch.y) === "rail") {
      const start = { clientX: touch.x, clientY: touch.y };
      touch = null;
      seam.tap.cancel();
      take(event.pointerId, start);
      drag(event);
    } else seam.tap.move(event);
  };
  const up = (event: PointerEvent) => {
    if (held && event.pointerId === held.pointer) return letGo();
    if (!touch || event.pointerId !== touch.pointer) return;
    touch = null;
    seam.tap.up(event);
  };
  const cancel = (event: PointerEvent) => {
    if (held && event.pointerId === held.pointer) return letGo();
    if (!touch || event.pointerId !== touch.pointer) return;
    touch = null;
    seam.tap.cancel();
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    seam.wheel(event);
  };
  const key = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const asked = railKey(event.key, segments, shown(), spanNow());
    if (!asked) return;
    event.preventDefault();
    if (asked.kind === "band") seam.turn(asked.direction);
    else {
      released = asked.place;
      const release = ++releases;
      render();
      void seam.showPlace(asked.place, true).finally(() => {
        if (release !== releases || disposed) return;
        released = null;
        render();
      });
    }
  };
  rail.addEventListener("pointerdown", down);
  rail.addEventListener("pointermove", move);
  rail.addEventListener("pointerup", up);
  rail.addEventListener("pointercancel", cancel);
  // Only the rail's own capture: a touch is captured by the element it began on (the grip) until the rail takes it.
  rail.addEventListener("lostpointercapture", (event) => {
    if (event.target === rail) cancel(event);
  });
  rail.addEventListener("wheel", wheel, { passive: false });
  rail.addEventListener("keydown", key);
  rail.addEventListener("contextmenu", (event) => event.preventDefault());

  const unwatch = seam.watch((next) => {
    place = next;
    if (!held) render();
  });
  const observer = new ResizeObserver(() => render());
  observer.observe(rail);
  render();

  return {
    /** The narrated sentence's place (null for none) and whether the page follows the narration (ADR 0014). */
    narration(next: number | null, follows: boolean) {
      if (next === narrated && follows === following) return;
      narrated = next;
      following = follows;
      render();
    },
    /** What the rail shows from now on; a thumb that is held keeps its chapter until it is let go. */
    scope(next: RailScope) {
      if (next === scope) return;
      scope = next;
      render();
    },
    destroy() {
      disposed = true;
      rest.stop();
      unwatch();
      observer.disconnect();
      if (held) seam.letGo();
      held = null;
      rail.remove();
    },
  };
}
