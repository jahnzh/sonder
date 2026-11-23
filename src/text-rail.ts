// The text position rail (#804, step 5 of #799; boards RailParts B, RailB, RailBDrag, RailBZoom, RailTry): a thin
// column of the book's chapters in the text band's right margin, with a thumb for the place in view and a narration
// mark for where the narration is. Plain DOM, no React. Its rules are text-rail-model.ts.
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
  REST_MS,
  dragPlace,
  dragRail,
  pressRail,
  railKey,
  railPicture,
  railReadout,
  railValueText,
  touchIntent,
  type RailDrag,
  type RailPointer,
  type RailSegment,
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
  /** The thumb is held (the readout of its place for the foot) or let go (null). */
  onHeld(readout: { chapter: string; percent: number } | null): void;
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
  let held: { pointer: number; drag: RailDrag } | null = null;
  let touch: { pointer: number; x: number; y: number } | null = null;
  let rest: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const height = () => Math.max(1, rail.clientHeight - 2 * END_ROOM);
  const pointerOf = (event: { clientX: number; clientY: number }): RailPointer => {
    const box = rail.getBoundingClientRect();
    return { y: event.clientY - box.top - END_ROOM, dx: event.clientX - (box.right - CENTRE) };
  };
  const shown = () => (held ? dragPlace(held.drag, height()) : released ?? place);

  const render = () => {
    if (disposed) return;
    const size = height();
    const picture = railPicture(segments, { place: shown(), narrated, following, drag: held?.drag ?? null }, size);
    picture.segments.forEach((box, at) => {
      const element = drawn[at]!;
      element.style.top = px(END_ROOM + box.top);
      element.style.height = px(box.height);
      element.dataset.tone = box.tone;
      element.hidden = box.height <= 0;
    });
    read.hidden = !picture.read;
    if (picture.read) {
      read.style.top = px(END_ROOM + picture.read.top);
      read.style.height = px(picture.read.height);
    }
    thumb.style.top = px(END_ROOM + picture.thumb.top);
    thumb.toggleAttribute("data-held", picture.thumb.held);
    thumb.dataset.tone = picture.thumb.tone;
    grip.style.top = px(END_ROOM + picture.thumb.top + picture.thumb.height / 2 - 22);
    mark.hidden = !picture.mark;
    if (picture.mark) mark.style.top = px(END_ROOM + picture.mark.top);
    overview.hidden = !picture.overview;
    if (picture.overview) {
      overview.style.top = px(END_ROOM);
      overview.style.height = px(size);
      overview.style.opacity = String(picture.overview.opacity);
      overviewLit.style.top = px(picture.overview.lit.top);
      overviewLit.style.height = px(picture.overview.lit.height);
      overviewTick.hidden = !picture.overview.tick;
      if (picture.overview.tick) overviewTick.style.top = px(picture.overview.tick.top);
    }
    rail.toggleAttribute("data-held", !!held);
    rail.toggleAttribute("data-zoomed", !!picture.overview);
    const now = shown();
    rail.setAttribute("aria-valuenow", String(Math.round(now * 100)));
    rail.setAttribute("aria-valuetext", railValueText(segments, now, narrated, following));
    // The thumb's place, for the browser tests.
    rail.setAttribute("data-place", now.toFixed(6));
  };

  const stopRest = () => {
    if (rest) clearTimeout(rest);
    rest = null;
  };
  /** The held thumb moved: the text follows where it is loaded; elsewhere its part is asked for once the thumb rests. */
  const follow = () => {
    if (!held) return;
    const target = dragPlace(held.drag, height());
    stopRest();
    void seam.showPlace(target, false).then((there) => {
      if (there || !held || disposed) return;
      stopRest();
      rest = setTimeout(() => {
        rest = null;
        if (held && dragPlace(held.drag, height()) === target) void seam.showPlace(target, true);
      }, REST_MS);
    });
  };

  const take = (pointer: number, from: { clientX: number; clientY: number }) => {
    held = { pointer, drag: pressRail(pointerOf(from), shown(), height()) };
    released = null;
    try {
      rail.setPointerCapture(pointer);
    } catch {
      // A pointer that is gone already: the release follows.
    }
    seam.hold();
    options.onHeld(railReadout(segments, shown()));
    render();
    if (!held.drag.grabbed) follow();
  };
  const drag = (event: PointerEvent) => {
    if (!held) return;
    held = { ...held, drag: dragRail(held.drag, pointerOf(event), height()) };
    options.onHeld(railReadout(segments, shown()));
    render();
    follow();
  };
  /** The release, a cancel or a lost capture: the place the thumb is let go at is shown and is the last one saved. */
  const letGo = () => {
    if (!held) return;
    const target = dragPlace(held.drag, height());
    const pointer = held.pointer;
    held = null;
    stopRest();
    released = target;
    const release = ++releases;
    try {
      if (rail.hasPointerCapture(pointer)) rail.releasePointerCapture(pointer);
    } catch {
      // Released already.
    }
    void seam.showPlace(target, true).finally(() => {
      if (release !== releases || disposed) return;
      released = null;
      render();
    });
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
    rail.focus({ preventScroll: true });
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
    const asked = railKey(event.key, segments, shown());
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
  rail.addEventListener("lostpointercapture", cancel);
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
    destroy() {
      disposed = true;
      stopRest();
      unwatch();
      observer.disconnect();
      if (held) seam.letGo();
      held = null;
      rail.remove();
    },
  };
}
