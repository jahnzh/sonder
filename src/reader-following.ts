// Whether the reader is following the narration or paged away, and which input
// wins when several arrive close together (ADR 0014). No React and no epub.js:
// the reader sends events and renders the answer.

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

export interface ReaderFollowingOptions<L> {
  clock?: FollowingClock;
  /** Save a manual position once its pause has passed. */
  onManualSave: (locator: L) => void;
  /** Run the follow step again (a retry is due). */
  onRetry: () => void;
  /** Clear the follow error if it is shown. */
  onClearFollowError: () => void;
}

const systemClock: FollowingClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createReaderFollowing<L>(options: ReaderFollowingOptions<L>) {
  const clock = options.clock ?? systemClock;
  const listeners = new Set<() => void>();
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
  let pendingManual: L | null = null;
  let saveTimer: unknown = null;

  const set = (value: boolean) => {
    if (following === value) return;
    following = value;
    for (const listener of listeners) listener();
  };

  const self = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isFollowing: () => following,
    /** A manual position still waiting for its save. */
    pendingManual: () => pendingManual,
    /** The sentence last followed, or "". */
    followed: () => followed,
    explicitJump: () => explicit,

    /** Start following; the caller handles the rest of back to narration. */
    follow() { set(true); },
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
      followed = "";
    },
    /** The view relocated. `known` says whether a locator is already shown. */
    relocated(locator: L, known: boolean): Relocation {
      const now = clock.now();
      const navigated = navigationEpoch === epoch && (navigating > 0 || now <= navigatedUntil);
      const ownLayout = !navigated && (layoutPending > 0 || now <= automaticUntil);
      if (ownLayout && known) return "ignored";
      const manual = navigated || (!ownLayout && now - lastGesture < GESTURE_REPORT_MS);
      if (!manual) return "shown";
      set(false);
      pendingManual = locator;
      if (saveTimer) clock.clearTimeout(saveTimer);
      saveTimer = clock.setTimeout(() => {
        saveTimer = null;
        pendingManual = null;
        navigatedUntil = 0;
        options.onManualSave(locator);
      }, MANUAL_SAVE_DELAY_MS);
      return "manual";
    },
    /** Drop a manual position waiting for its save, and end the navigation's window. */
    cancelManualSave() {
      if (saveTimer) clock.clearTimeout(saveTimer);
      saveTimer = null;
      pendingManual = null;
      navigatedUntil = 0;
    },
    /** Forget the last followed sentence, so the next narration update moves the view even to the same sentence. */
    forgetFollowed() { followed = ""; },
    resetRetries() { retry.attempts = 0; },
    clearFollowError() { options.onClearFollowError(); },
    /** Read from audio jumps to `key` itself; the follow step stays out of its way until it ends. */
    beginExplicitJump(key: string) {
      followed = key;
      explicit = true;
    },
    endExplicitJump() { explicit = false; },
    /** The narration is on sentence `key`: true when a follow jump to it should start. */
    followTarget(key: string) {
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
    /** The reader unmounts. A manual save still waiting is kept. */
    dispose() {
      if (retry.timer) clock.clearTimeout(retry.timer);
      listeners.clear();
    },
  };
  return self;
}

export type ReaderFollowing<L> = ReturnType<typeof createReaderFollowing<L>>;
