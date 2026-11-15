// Whether the reader is following the narration or paged away, and which input
// wins when several arrive close together (ADR 0014). No React and no epub.js:
// the reader sends events and renders the answer. It is also the one owner of
// every save of a place the reader chose by hand that is still waiting, so back
// to narration can drop or keep all of them at once.

import { createCheckpointSaver } from "./word-timing";

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
  /** A Word mode step happened since this jump started, so it must not pull the display back. */
  stepped(): boolean;
}

/** How a follow jump to `key` ended. */
export type FollowOutcome = "shown" | "stale" | "retrying" | "failed";

/** Where a saved reading place came from: chosen while reading, or the narrated sentence. */
export type SaveOrigin = "reading" | "listening";

/** A place the reader chose by hand whose display is still in flight (a Lyrics turn, a search result, the scrubber). */
export interface ManualPlace<L> {
  /** The display ended: save `locator` unless back to narration dropped this place meanwhile. */
  save(locator: L): void;
}

/** One back to narration, as its caller can still act on it later (Read from audio waits for speech recovery). */
export interface NarrationReturn {
  /** No later back to narration, no paging away and no change of recording or map since this one. */
  current(): boolean;
  /** A narration to follow was found for this return after all: drop what it kept, as if it had been there. */
  confirm(): void;
}

export interface ReaderFollowingOptions<L> {
  clock?: FollowingClock;
  /** Save a manual position once its pause has passed. */
  onManualSave: (locator: L, origin: SaveOrigin) => void;
  /**
   * Whether there is a narration to follow now: a map for the open ebook that matches
   * the recording in the player, with an interval at the player's position.
   */
  narrationToFollow?: () => boolean;
  /** Run the follow step again (a retry is due). */
  onRetry: () => void;
  /** Clear the follow error if it is shown. */
  onClearFollowError: () => void;
  /** Following started or stopped. */
  onFollowingChange?: (following: boolean) => void;
}

const systemClock: FollowingClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createReaderFollowing<L>(options: ReaderFollowingOptions<L>) {
  const clock = options.clock ?? systemClock;
  let following = true;
  // Each jump of ours (follow, Lyrics, progress) and each navigation takes a new epoch.
  let epoch = 0;
  // The epoch of the latest navigation (Contents, page turns): a jump started after it ends its window.
  let navigationEpoch = 0;
  // Navigation in flight, and until when its relocation still counts as the reader's own choice.
  let navigating = 0;
  let navigatedUntil = 0;
  // Layout work of our own in flight (displays, resizes, re-theming), and until when its relocations are still ours.
  let layoutPending = 0;
  let automaticUntil = 0;
  // Last navigation-like input on the pages.
  let lastGesture = Number.NEGATIVE_INFINITY;
  // Word mode steps, so a follow jump still waiting for the page when the reader stepped on does not pull the display back.
  let wordSteps = 0;
  // The sentence last followed (`recording:paragraph`), so the same sentence is not jumped to twice.
  let followed = "";
  // A Read from audio jump is in flight; the follow step leaves the view to it.
  let explicit = false;
  let retry: { key: string; attempts: number; timer: unknown } = { key: "", attempts: 0, timer: null };
  // The pending saves of places chosen by hand, all owned here so back to narration can drop
  // them together. The page debounce: a relocation the reader caused, saved after a pause.
  let pendingManual: L | null = null;
  let saveTimer: unknown = null;
  // Word mode's checkpoint (a step by hand or the words advancing at a set speed).
  let wordOrigin: SaveOrigin | null = null;
  const wordSaver = createCheckpointSaver<{ locator: L; origin: SaveOrigin }>(({ locator, origin }) => {
    wordOrigin = null;
    options.onManualSave(locator, origin);
  }, {}, clock);
  // Displays of a place chosen by hand that save once they end (a Lyrics turn, a search result, the scrubber).
  const places = new Set<{ dropped: boolean }>();
  // A back to narration that found no narration to follow kept the saves waiting. Once following
  // starts to work they are dropped after all; paging away (the reader chose again) ends this.
  // `gesture` is the last gesture at that return.
  let armed: { gesture: number } | null = null;
  // Back to narration calls, pagings away and changes of recording, so a back to narration
  // can tell whether another one, the reader or the narration moved on since.
  let returns = 0;
  let away = 0;
  let recordings = 0;
  // The navigation a back to narration ended: a relocation it reports late is not the reader's.
  let returnedFromNavigation = -1;

  const set = (value: boolean) => {
    if (!value) away++;
    if (following === value) return;
    following = value;
    options.onFollowingChange?.(value);
  };
  // Drop every save of a place chosen by hand that is still waiting. Anything queued since the
  // return was queued while following (paging away ends the return), so all of it goes. A
  // navigation or gesture from before the return stops counting, so a relocation it reports
  // late is not the reader's; `gesture` is the last gesture at the return, one made since counts.
  const drop = (gesture: number) => {
    if (saveTimer) clock.clearTimeout(saveTimer);
    saveTimer = null;
    pendingManual = null;
    navigatedUntil = 0;
    // A listening checkpoint is the narrated sentence a step moved the audio to; it is kept.
    if (wordOrigin === "reading") {
      wordSaver.cancel();
      wordOrigin = null;
    }
    for (const place of places) place.dropped = true;
    places.clear();
    returnedFromNavigation = navigationEpoch;
    if (lastGesture === gesture) lastGesture = Number.NEGATIVE_INFINITY;
  };

  const self = {
    isFollowing: () => following,
    /** A manual position still waiting for its save. */
    pendingManual: () => pendingManual,
    /** The sentence last followed, or "". */
    followed: () => followed,
    explicitJump: () => explicit,

    /**
     * Back to narration, the one operation behind every way of asking for it (the player-bar
     * button, `F`, Read from audio, Listen from here and its Undo, the audio scrubber, a seek
     * in Lyrics mode, switching on "Follow the narration"). Following starts, the next
     * narration update moves the view even to the same sentence, the retries are reset and a
     * follow error is cleared.
     *
     * With a narration to follow, every save of a place chosen by hand that is still waiting
     * is dropped (the page debounce, Word mode's reading checkpoint, a Lyrics turn, a search
     * result, the scrubber), or it would land after the listening place and overwrite it.
     * Without one they are kept and still saved, unless following starts to work before they
     * are (the map arrives, the audio reaches a mapped sentence): then they are dropped at that
     * moment. `narration` defaults to `narrationToFollow()`; an entry point that moves the
     * narration itself passes what it knows about the place it moves to.
     */
    backToNarration(narration = options.narrationToFollow?.() ?? false): NarrationReturn {
      const at = ++returns;
      const gesture = lastGesture;
      armed = null;
      set(true);
      if (narration) drop(gesture);
      else armed = { gesture };
      followed = "";
      retry.attempts = 0;
      options.onClearFollowError();
      const awayThen = away, recordingThen = recordings;
      const current = () => returns === at && away === awayThen && recordings === recordingThen;
      return {
        current,
        confirm() {
          if (!current()) return;
          armed = null;
          drop(gesture);
        },
      };
    },
    /** Stop following (a search result, a bookmark, the scrubber, scrolling Lyrics, the checkbox). */
    pageAway() { set(false); },
    /** A wheel, key, swipe or link tap on the pages. */
    gesture() { lastGesture = clock.now(); },
    /** A page turn in Lyrics mode: pages away and counts as a gesture, not as our own layout. */
    manualStep() {
      set(false);
      automaticUntil = 0;
      lastGesture = clock.now();
    },
    /** A Word mode step (a sentence or a word chosen by the reader). It pages away unless it moved the narration along. */
    wordStep(movedAudio: boolean) {
      wordSteps++;
      if (following && !movedAudio) set(false);
    },
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
    /** Contents or a page turn: replaces a jump in flight and pages away. */
    navigate() {
      navigationEpoch = ++epoch;
      set(false);
      automaticUntil = 0;
      lastGesture = clock.now();
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
      const steps = wordSteps;
      return {
        current: () => request === epoch,
        stepped: () => steps !== wordSteps,
      };
    },
    /** The narration switched to another recording, or the map did. */
    recordingChanged() {
      ++epoch;
      recordings++;
      followed = "";
    },
    /** The view relocated. `known` says whether a locator is already shown. */
    relocated(locator: L, known: boolean): Relocation {
      const now = clock.now();
      const gestured = now - lastGesture < GESTURE_REPORT_MS;
      // A navigation from before a back to narration counts only with a gesture made since.
      const navigated = navigationEpoch === epoch && (navigating > 0 || now <= navigatedUntil) &&
        (navigationEpoch !== returnedFromNavigation || gestured);
      const ownLayout = !navigated && (layoutPending > 0 || now <= automaticUntil);
      if (ownLayout && known) return "ignored";
      const manual = navigated || (!ownLayout && gestured);
      if (!manual) return "shown";
      set(false);
      pendingManual = locator;
      if (saveTimer) clock.clearTimeout(saveTimer);
      saveTimer = clock.setTimeout(() => {
        saveTimer = null;
        pendingManual = null;
        navigatedUntil = 0;
        options.onManualSave(locator, "reading");
      }, MANUAL_SAVE_DELAY_MS);
      return "manual";
    },
    /**
     * A Word mode checkpoint: a sentence or word stepped to by hand is saved after a pause;
     * while the words advance by themselves (`auto`), saves are also spaced out. Each request
     * replaces the one still waiting. `listening` is a step that moved the narration along.
     */
    wordCheckpoint(locator: L, origin: SaveOrigin, auto = false) {
      wordOrigin = origin;
      wordSaver.request({ locator, origin }, auto);
    },
    /** Save the Word mode checkpoint still waiting now (page hidden, reader closed, display changed). */
    flushWordCheckpoint() { wordSaver.flush(); },
    /** A display of a place chosen by hand starts; save it through the answer once it ended. */
    manualPlace(): ManualPlace<L> {
      const place = { dropped: false };
      places.add(place);
      return {
        save(locator) {
          if (place.dropped || !places.delete(place)) return;
          options.onManualSave(locator, "reading");
        },
      };
    },
    /** The reader closes: a manual position still waiting is handed back to be saved now, and its timer is dropped. */
    takeManualSave(): L | null {
      if (!saveTimer) return null;
      clock.clearTimeout(saveTimer);
      saveTimer = null;
      const locator = pendingManual;
      pendingManual = null;
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
      // comes back on only through another back to narration, which starts its own wait.
      if (armed && following) {
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
      return true;
    },
    /** The follow jump to `key` ended; `shown` says whether the sentence is on screen. */
    followShown(key: string, shown: boolean): FollowOutcome {
      if (shown) {
        retry.attempts = 0;
        return "shown";
      }
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
