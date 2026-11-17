// Whether the reader is following the narration or paged away, and which input
// wins when several arrive close together (ADR 0014). No React and no epub.js:
// the reader sends events and renders the answer. It is also the one owner of
// every save of a place the reader chose by hand that is still waiting, so back
// to narration can drop or keep all of them at once.

/** Time and timers, injected so tests can drive them. */
export interface FollowingClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// The time windows are tolerances for epub.js reporting a relocation after its
// cause. Their values are measured behaviour; change one only with a measurement.

/** After a display or layout of our own settles, epub.js can still report a relocation from it for this long. */
export const OWN_LAYOUT_SETTLE_MS = 500;
/** epub.js reports the location a navigation reached just after its display() resolves; until this long after, that relocation is still the reader's choice. */
export const NAVIGATION_REPORT_MS = 1000;
/** A relocation this soon after a gesture on the pages is the reader navigating; epub.js also re-positions by itself seconds later. */
export const GESTURE_REPORT_MS = 1500;
/** A resize or re-theme re-paginates the book, which can take seconds; its relocations are our own until it reports one, at most this long. */
export const LAYOUT_LIMIT_MS = 10000;
/** The first display after the book opens: relocations this long after it starts are our own. */
export const OPENING_DISPLAY_MS = 1200;
/** A manual position is saved after this pause, so turning several pages saves once. */
export const MANUAL_SAVE_DELAY_MS = 500;
/** A follow jump that did not show its sentence is tried again after this wait, at most FOLLOW_RETRIES times. */
export const FOLLOW_RETRY_DELAY_MS = 180;
export const FOLLOW_RETRIES = 3;

/**
 * What a relocation means:
 * - `ignored`: our own layout moved the view; keep the locator as it is.
 * - `shown`: record the new locator.
 * - `manual`: the reader navigated; record it, the reader is paged away and the position is saved after a pause.
 */
export type Relocation = "ignored" | "shown" | "manual";

/** A jump to a sentence, valid until a newer jump or a navigation replaces it. */
export interface FollowJump {
  /** No newer jump, navigation or recording change replaced this one. */
  current(): boolean;
}

/** How a follow jump to `key` ended. */
export type FollowOutcome = "shown" | "stale" | "retrying" | "failed";

/** A place the reader chose by hand whose display is still in flight (a search result, the scrubber). */
export interface ManualPlace<L> {
  /** The display ended: save `locator` unless back to narration dropped this place meanwhile; null saves nothing. */
  save(locator: L | null): void;
}

/** One back to narration, as its caller can still act on it later (Read from audio waits for speech recovery). */
export interface NarrationReturn {
  /** No later back to narration, no paging away, no change of recording and no other map shown since this one. */
  current(): boolean;
  /** A narration to follow was found for this return after all: drop what it kept, as if it had been there. */
  confirm(): void;
}

export interface ReaderFollowingOptions<L> {
  clock?: FollowingClock;
  /**
   * Save a manual position once its pause has passed. Every place the module saves was chosen while reading;
   * the narrated sentence is saved as a listening place by the reader itself (`showFragment`), not here.
   */
  onManualSave: (locator: L) => void;
  /**
   * Whether there is a narration to follow now: a map for the open ebook that matches
   * the recording in the player, with a narrated sentence at the player's position (`narratedSentence`).
   */
  narrationToFollow?: () => boolean;
  /** Run the follow step again (a retry is due). */
  onRetry: () => void;
  /** Clear the follow error if it is shown. */
  onClearFollowError: () => void;
  /** Following started or stopped. */
  onFollowingChange?: (following: boolean) => void;
  /** Whether any save of a place chosen by hand is waiting now; reported when that changes. */
  onSaveWaiting?: (waiting: boolean) => void;
}

/** Back to narration that waits for the narration to reach the place it is moving to. */
export interface DeferredReturn {
  /** The narration is there (or could not get there): back to narration now, unless the reader chose again since. */
  run(narration?: boolean): NarrationReturn | null;
}

/** A sentence of an alignment map, as far as the narrated sentence needs it: where the narration starts it. */
export interface MapSentence {
  trackId: string;
  start: number;
}

/** The alignment map the reader shows for the open ebook edition: the recording it was made for and its sentences. */
export interface NarrationMap<S extends MapSentence> {
  recordingId: string;
  intervals: readonly S[];
}

/** Where the narration is: the recording in the player, its tracks in order, the track and the position in it. */
export interface NarrationPlace {
  recordingId?: string;
  /** The ids of the recording's tracks, in the order they are played. */
  tracks: readonly string[];
  trackId?: string;
  position: number;
}

// The map's sentences in narration order: by track (the recording's order), then by start. Equal places
// keep the map's order, so of two sentences that start together the later one in the book is narrated.
function narrationOrder<S extends MapSentence>(sentences: readonly S[], tracks: readonly string[]) {
  const rank = new Map(tracks.map((id, index) => [id, index]));
  const ordered = sentences
    .map((sentence, index) => ({ sentence, index, track: rank.get(sentence.trackId) }))
    // A sentence on a track the recording does not have cannot be placed; it is never narrated.
    .filter((entry): entry is { sentence: S; index: number; track: number } => entry.track !== undefined)
    .sort((a, b) => a.track - b.track || a.sentence.start - b.sentence.start || a.index - b.index);
  return { rank, ordered };
}

const systemClock: FollowingClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createReaderFollowing<L>(options: ReaderFollowingOptions<L>) {
  const clock = options.clock ?? systemClock;
  let following = true;
  // Each jump of ours (follow, search, progress) and each navigation takes a new epoch.
  let epoch = 0;
  // The epoch of the latest navigation (Contents, page turns): a jump started after it ends its window.
  let navigationEpoch = 0;
  // The section a Contents choice goes to (null for a page turn), and the gestures counted when it was made.
  let navigationTarget: number | null = null;
  let navigationGestures = 0;
  // Navigation in flight, and until when its relocation still counts as the reader's own choice.
  let navigating = 0;
  let navigatedUntil = 0;
  // Layout work of our own in flight (displays, resizes, re-theming), and until when its relocations are still ours.
  let layoutPending = 0;
  let automaticUntil = 0;
  // Last navigation-like input on the pages.
  let lastGesture = Number.NEGATIVE_INFINITY;
  // Gestures counted, so a back to narration can tell whether one came after it.
  let gestures = 0;
  const gestureNow = () => {
    lastGesture = clock.now();
    gestures++;
    chosen++;
  };
  // The sentence last followed (`recording:paragraph`), so the same sentence is not jumped to twice.
  let followed = "";
  // A Read from audio jump is in flight; the follow step leaves the view to it.
  let explicit = false;
  let retry: { key: string; attempts: number; timer: unknown } = { key: "", attempts: 0, timer: null };
  // Follow jumps started (each followTarget that answered true), so one a newer follow jump replaced is told apart.
  let follows = 0;
  // The pending saves of places chosen by hand, all owned here so back to narration can drop
  // them together. The page debounce: a relocation the reader caused, saved after a pause.
  let pendingManual: L | null = null;
  let saveTimer: unknown = null;
  // The page debounce came due while a scrubber return waited for the player: `pendingManual` is held
  // for that return's decision, which is made for where the scrub ended.
  let held = false;
  // Displays of a place chosen by hand that save once they end (a search result, the scrubber).
  const places = new Set<{ dropped: boolean }>();
  // A back to narration that found no narration to follow kept the saves waiting. Once following
  // starts to work they are dropped after all; paging away (the reader chose again) ends this.
  // `gesture` counts the gestures at that return (a navigation counts as one).
  let armed: { gesture: number } | null = null;
  // Back to narration calls, pagings away and changes of recording, so a back to narration
  // can tell whether another one, the reader or the narration moved on since.
  let returns = 0;
  let away = 0;
  let recordings = 0;
  // The navigation a back to narration ended: a relocation it reports late is not the reader's.
  let returnedFromNavigation = -1;
  // The map the reader shows (its identity, null for none), and whether the server confirmed it for
  // the current audio in this reader. A map restored from the cache, or kept after a failed check,
  // is not confirmed: following it works, but it is no reason to drop a save. `maps` counts the
  // changes, so a back to narration can tell that another map replaced the one it was made with.
  let mapIdentity: string | null = null;
  let mapConfirmed = false;
  let maps = 0;
  // Choices of the reader (gestures, navigations, paging away) and deferred returns,
  // so a deferred return can tell whether it is still wanted.
  let chosen = 0;
  let deferrals = 0;
  // The deferred return still to run, as it was made: it holds a page save that comes due only while
  // nothing made it stale (another return, a choice of the reader); a newer one takes its place.
  let deferral: { at: number; returns: number; chosen: number } | null = null;
  const holding = () => !!deferral && deferral.at === deferrals && deferral.returns === returns && deferral.chosen === chosen;
  let waiting = false;
  const report = () => {
    const now = saveTimer !== null || held || places.size > 0;
    if (now === waiting) return;
    waiting = now;
    options.onSaveWaiting?.(now);
  };

  const set = (value: boolean) => {
    if (!value) away++;
    if (following === value) return;
    following = value;
    options.onFollowingChange?.(value);
  };
  // Drop every save of a place chosen by hand that is still waiting. Anything queued since the
  // return was queued while following (paging away ends the return), so all of it goes. A
  // navigation or gesture from before the return stops counting, so a relocation it reports
  // late is not the reader's; `gesture` counts the gestures at the return, one made since counts.
  const drop = (gesture: number) => {
    if (saveTimer) clock.clearTimeout(saveTimer);
    saveTimer = null;
    held = false;
    pendingManual = null;
    navigatedUntil = 0;
    for (const place of places) place.dropped = true;
    places.clear();
    returnedFromNavigation = navigationEpoch;
    if (gestures === gesture) lastGesture = Number.NEGATIVE_INFINITY;
    report();
  };
  // A held page save that nothing dropped: it was due, so it is saved now.
  const saveHeld = () => {
    if (!held) return;
    held = false;
    const locator = pendingManual;
    pendingManual = null;
    report();
    if (locator !== null) options.onManualSave(locator);
  };

  // The map's sentences in narration order, kept while the map and the order of its tracks stay the same:
  // the narrated sentence is asked for at every position update.
  let order: { sentences: readonly MapSentence[]; tracks: string; ordered: ReturnType<typeof narrationOrder<MapSentence>> } | null = null;
  const orderOf = (sentences: readonly MapSentence[], tracks: readonly string[]) => {
    const key = tracks.join("\n");
    if (order?.sentences !== sentences || order.tracks !== key)
      order = { sentences, tracks: key, ordered: narrationOrder(sentences, tracks) };
    return order.ordered;
  };

  const self = {
    isFollowing: () => following,
    /**
     * The narrated sentence (glossary): the sentence of the map with the latest start at or before
     * the narration's position, taking the recording's tracks in order. It stays with no time limit
     * through a silence, music or narration the ebook does not have, and across the start of the next
     * track, until the next sentence begins. None without a map, with a map made for another recording
     * than the one in the player, or before the map's first sentence.
     */
    narratedSentence<S extends MapSentence>(map: NarrationMap<S> | null | undefined, place: NarrationPlace): S | null {
      if (!map || !place.recordingId || place.recordingId !== map.recordingId || place.trackId === undefined) return null;
      const { rank, ordered } = orderOf(map.intervals, place.tracks) as ReturnType<typeof narrationOrder<S>>;
      const track = rank.get(place.trackId);
      if (track === undefined) return null;
      // The last sentence that starts at or before the place: an earlier track, or this one up to the position.
      let low = 0, high = ordered.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const entry = ordered[middle]!;
        if (entry.track < track || (entry.track === track && entry.sentence.start <= place.position)) low = middle + 1;
        else high = middle;
      }
      return low > 0 ? ordered[low - 1]!.sentence : null;
    },
    /**
     * The sentence the narration highlight marks: the narrated sentence while following. None with
     * "Follow the narration" off (paged away), and none whenever there is no narrated sentence.
     */
    highlightedSentence<S extends MapSentence>(map: NarrationMap<S> | null | undefined, place: NarrationPlace): S | null {
      return following ? self.narratedSentence(map, place) : null;
    },
    /** A manual position still waiting for its save. */
    pendingManual: () => pendingManual,
    /** The sentence last followed, or "". */
    followed: () => followed,
    explicitJump: () => explicit,

    /**
     * Back to narration, the one operation behind every way of asking for it (the player-bar
     * button, `F`, Read from audio, Listen from here and its Undo, the audio scrubber,
     * switching on "Follow the narration"). Following starts, the next narration update moves
     * the view even to the same sentence, the retries are reset and a follow error is cleared.
     *
     * With a narration to follow, every save of a place chosen by hand that is still waiting
     * is dropped (the page debounce, a search result, the scrubber), or it would land after the
     * listening place and overwrite it.
     * Without one they are kept and still saved, unless following starts to work before they
     * are (the map arrives, the audio reaches a mapped sentence): then they are dropped at that
     * moment. `narration` defaults to `narrationToFollow()`; an entry point that moves the
     * narration itself passes what it knows about the place it moves to. A narration counts only
     * on a map the server confirmed (`mapShown`); on any other map the saves are kept as without
     * one, and dropped once the confirmation arrives while following works.
     */
    backToNarration(narration = options.narrationToFollow?.() ?? false): NarrationReturn {
      const at = ++returns;
      const gesture = gestures;
      armed = null;
      set(true);
      if (narration && mapConfirmed) drop(gesture);
      else {
        armed = { gesture };
        saveHeld();
      }
      followed = "";
      retry.attempts = 0;
      options.onClearFollowError();
      const awayThen = away, recordingThen = recordings, mapsThen = maps;
      const current = () => returns === at && away === awayThen && recordings === recordingThen && maps === mapsThen;
      return {
        current,
        confirm() {
          if (!current()) return;
          armed = null;
          drop(gesture);
        },
      };
    },
    /**
     * Back to narration once the narration reached the place it is moving to: the audio scrubber
     * released on another track, which the player loads first. Until `run()` nothing changes, so
     * every save still waiting is kept. `run()` decides for where the narration is then; it does
     * nothing once the reader chose again (a gesture, a navigation, paging away), after
     * another back to narration or when a newer deferred return replaced this one.
     */
    deferredReturn(): DeferredReturn {
      const at = ++deferrals, returnsThen = returns, chosenThen = chosen;
      deferral = { at, returns: returnsThen, chosen: chosenThen };
      return {
        // Running it is a back to narration, so it runs once. A page save held for it is decided by it,
        // or saved when it no longer runs; a newer return holds it in its place.
        run(narration) {
          if (deferrals !== at) return null;
          deferral = null;
          if (returns !== returnsThen || chosen !== chosenThen) {
            saveHeld();
            return null;
          }
          return narration === undefined ? self.backToNarration() : self.backToNarration(narration);
        },
      };
    },
    /**
     * The reader shows another map (`identity`, null for none), or the same one confirmed. `confirmed`:
     * the server confirmed this map for the current audio in this reader. Once it is, following that
     * starts to work drops what a back to narration kept.
     */
    mapShown(identity: string | null, confirmed: boolean) {
      if (identity !== mapIdentity) maps++;
      mapIdentity = identity;
      mapConfirmed = identity !== null && confirmed;
    },
    /** Stop following (a search result, a bookmark, the scrubber, the checkbox). */
    pageAway() {
      chosen++;
      set(false);
    },
    /** A wheel, key, swipe or link tap on the pages. */
    gesture() { gestureNow(); },
    /** The first display after the book opened. */
    openingDisplay() { automaticUntil = clock.now() + OPENING_DISPLAY_MS; },
    /** A display of our own; call the returned function when it settled. */
    beginOwnDisplay() {
      layoutPending++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        layoutPending--;
        automaticUntil = clock.now() + OWN_LAYOUT_SETTLE_MS;
      };
    },
    /**
     * A resize or re-theme of our own. Call the returned function on the relocation
     * it ends with; it also settles by itself after LAYOUT_LIMIT_MS. `onEnd` runs once
     * either way, to remove the relocation listener.
     */
    beginLayout(onEnd?: () => void) {
      layoutPending++;
      let done = false;
      const settled = () => {
        if (done) return;
        done = true;
        clock.clearTimeout(limit);
        onEnd?.();
        layoutPending--;
        automaticUntil = clock.now() + OWN_LAYOUT_SETTLE_MS;
      };
      const limit = clock.setTimeout(settled, LAYOUT_LIMIT_MS);
      return settled;
    },
    /** Contents (`section`: the section it goes to) or a page turn: replaces a jump in flight and pages away. */
    navigate(section?: number) {
      navigationEpoch = ++epoch;
      set(false);
      automaticUntil = 0;
      gestureNow();
      navigationTarget = section ?? null;
      navigationGestures = gestures;
    },
    /** The display of a navigation is in flight; call the returned function when it ended. */
    beginNavigation() {
      navigating++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        navigating--;
        navigatedUntil = clock.now() + NAVIGATION_REPORT_MS;
      };
    },
    /** A jump of ours to a sentence. */
    startJump(): FollowJump {
      const request = ++epoch;
      return { current: () => request === epoch };
    },
    /** The narration switched to another recording, or the map did. */
    recordingChanged() {
      ++epoch;
      recordings++;
      followed = "";
    },
    /**
     * A display of ours back to the place shown, due later (a re-theme re-paginated the book).
     * `due()` is false once the reader chose a place since (Contents, a page turn, a gesture, paging
     * away): the place shown may still be the one from before that choice, while the
     * choice's relocation is not reported yet. Displaying it would undo the choice, and its relocation,
     * inside the navigation's window, would be saved as the reader's.
     */
    restoreLater() {
      const chosenThen = chosen;
      return { due: () => chosen === chosenThen };
    },
    /**
     * The view relocated. `known` says whether a locator is already shown; `section` is the section it
     * shows. While a Contents choice displays, epub.js can report the place it leaves once more: a
     * section other than the one chosen, with no gesture since, is not the choice's relocation, so it
     * neither pages away nor arms a save.
     */
    relocated(locator: L, known: boolean, section?: number): Relocation {
      const now = clock.now();
      const gestured = now - lastGesture < GESTURE_REPORT_MS;
      // A navigation from before a back to narration counts only with a gesture made since.
      const navigated = navigationEpoch === epoch && (navigating > 0 || now <= navigatedUntil) &&
        (navigationEpoch !== returnedFromNavigation || gestured);
      const ownLayout = !navigated && (layoutPending > 0 || now <= automaticUntil);
      if (ownLayout && known) return "ignored";
      const manual = navigated || (!ownLayout && gestured);
      if (!manual) return "shown";
      const stray = navigated && navigationTarget !== null && section !== undefined &&
        section !== navigationTarget && gestures === navigationGestures;
      if (stray) return "shown";
      // Caused by a navigation or gesture from before a back to narration that found nothing to
      // follow: not a manual move, so following stays on; nothing replaces its place, so it is saved.
      const beforeReturn = !!armed && gestures === armed.gesture;
      if (!beforeReturn) set(false);
      pendingManual = locator;
      held = false;
      if (saveTimer) clock.clearTimeout(saveTimer);
      saveTimer = clock.setTimeout(() => {
        saveTimer = null;
        if (holding()) {
          held = true;
          navigatedUntil = 0;
          report();
          return;
        }
        pendingManual = null;
        navigatedUntil = 0;
        report();
        options.onManualSave(locator);
      }, MANUAL_SAVE_DELAY_MS);
      report();
      return beforeReturn ? "shown" : "manual";
    },
    /** A display of a place chosen by hand starts; save it through the answer once it ended. */
    manualPlace(): ManualPlace<L> {
      const place = { dropped: false };
      places.add(place);
      report();
      return {
        save(locator) {
          if (place.dropped || !places.delete(place)) return;
          report();
          if (locator !== null) options.onManualSave(locator);
        },
      };
    },
    /** The reader closes: a manual position still waiting is handed back to be saved now, and its timer is dropped. */
    takeManualSave(): L | null {
      if (!saveTimer && !held) return null;
      if (saveTimer) clock.clearTimeout(saveTimer);
      saveTimer = null;
      held = false;
      const locator = pendingManual;
      pendingManual = null;
      report();
      return locator;
    },
    /** Forget the last followed sentence, so the next narration update moves the view even to the same sentence. */
    forgetFollowed() { followed = ""; },
    /** Read from audio jumps to `key` itself; the follow step stays out of its way until it ends. */
    beginExplicitJump(key: string) {
      followed = key;
      explicit = true;
    },
    endExplicitJump() { explicit = false; },
    /** The narration is on sentence `key`: true when a follow jump to it should start. */
    followTarget(key: string) {
      // Following works now: a back to narration that found nothing to follow drops what it kept.
      // Paged away since (the reader chose again), following is off and nothing is dropped; it
      // comes back on only through another back to narration, which starts its own wait. On a map
      // the server has not confirmed, following works but drops nothing until it is confirmed.
      if (armed && following && mapConfirmed) {
        const { gesture } = armed;
        armed = null;
        drop(gesture);
      }
      if (key === followed) return false;
      if (retry.key !== key) {
        if (retry.timer) clock.clearTimeout(retry.timer);
        retry = { key, attempts: 0, timer: null };
      }
      followed = key;
      follows++;
      return true;
    },
    /** The follow jump that followTarget just started, to hand back to followShown. */
    followRequest() { return follows; },
    /**
     * The follow jump to `key` ended; `shown` says whether the sentence is on screen. `request` (from
     * followRequest) is the jump's own: one that a newer follow jump replaced while it was in flight (the
     * fonts loaded, a resize, a new layout) is stale, not a failure, since the newer one reports (#509).
     * Counted, each replaced jump started a retry that replaced the next, until the sentence failed.
     */
    followShown(key: string, shown: boolean, request?: number): FollowOutcome {
      if (shown) {
        retry.attempts = 0;
        return "shown";
      }
      if (request !== undefined && request !== follows) return "stale";
      if (followed !== key) return "stale";
      followed = "";
      if (++retry.attempts <= FOLLOW_RETRIES) {
        retry.timer = clock.setTimeout(() => options.onRetry(), FOLLOW_RETRY_DELAY_MS);
        return "retrying";
      }
      return "failed";
    },
    /** The reader unmounts. A manual save still waiting is left to takeManualSave. */
    dispose() {
      if (retry.timer) clock.clearTimeout(retry.timer);
    },
  };
  return self;
}

export type ReaderFollowing<L> = ReturnType<typeof createReaderFollowing<L>>;
