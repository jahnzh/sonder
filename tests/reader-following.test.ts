import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReaderFollowing,
  FOLLOW_RETRIES,
  FOLLOW_RETRY_DELAY_MS,
  GESTURE_REPORT_MS,
  LAYOUT_LIMIT_MS,
  MANUAL_SAVE_DELAY_MS,
  NAVIGATION_REPORT_MS,
  OPENING_DISPLAY_MS,
  OWN_LAYOUT_SETTLE_MS,
  type FollowingClock,
  type ReaderFollowing,
} from "../src/reader-following";

// A clock the test moves by hand; timers run when their time is reached.
function fakeClock() {
  let now = 10_000;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: FollowingClock & { advance(ms: number): void; pending(): number } = {
    now: () => now,
    setTimeout(run, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout(handle) { timers.delete(handle as number); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
    pending: () => timers.size,
  };
  return clock;
}

// `map`: the map the reader shows, confirmed by the server unless `confirmed` is false (null: no map).
function setup({ map = "map", confirmed = true }: { map?: string | null; confirmed?: boolean } = {}) {
  const clock = fakeClock();
  const saved: string[] = [];
  let retries = 0;
  let cleared = 0;
  // Whether the player is on a mapped sentence of the open ebook's map: set by each test.
  const narration = { now: false };
  // Each change of "a save of a place chosen by hand is waiting".
  const waiting: boolean[] = [];
  const following = createReaderFollowing<string>({
    clock,
    onManualSave: (locator) => { saved.push(locator); },
    narrationToFollow: () => narration.now,
    onRetry: () => { retries++; },
    onClearFollowError: () => { cleared++; },
    onSaveWaiting: (value) => { waiting.push(value); },
  });
  following.mapShown(map, confirmed);
  return { clock, saved, narration, following, waiting, retries: () => retries, cleared: () => cleared };
}

test("a relocation with no gesture and no layout of ours is shown and keeps following", () => {
  const { following, saved, clock } = setup();
  assert.equal(following.isFollowing(), true);
  assert.equal(following.relocated("a", true), "shown");
  assert.equal(following.isFollowing(), true);
  clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(saved, []);
});

test("a relocation inside the gesture window is the reader navigating; after it, it is epub.js on its own", () => {
  const { following, clock } = setup();
  following.gesture();
  clock.advance(GESTURE_REPORT_MS - 1);
  assert.equal(following.relocated("a", true), "manual");
  assert.equal(following.isFollowing(), false);

  const late = setup();
  late.following.gesture();
  late.clock.advance(GESTURE_REPORT_MS);
  assert.equal(late.following.relocated("a", true), "shown");
  assert.equal(late.following.isFollowing(), true);
});

test("a manual position is saved once after the pause; another manual relocation restarts it and only the last is saved", () => {
  const { following, clock, saved } = setup();
  following.gesture();
  assert.equal(following.relocated("first", true), "manual");
  assert.equal(following.pendingManual(), "first");
  clock.advance(MANUAL_SAVE_DELAY_MS - 1);
  following.gesture();
  assert.equal(following.relocated("second", true), "manual");
  clock.advance(MANUAL_SAVE_DELAY_MS - 1);
  assert.deepEqual(saved, []);
  clock.advance(1);
  assert.deepEqual(saved, ["second"]);
  assert.equal(following.pendingManual(), null);
});

test("while a display of ours is in flight a relocation is ignored, and after it settles for the settle window", () => {
  const { following, clock } = setup();
  following.gesture();
  const settled = following.beginOwnDisplay();
  assert.equal(following.relocated("a", true), "ignored");
  clock.advance(GESTURE_REPORT_MS * 2);
  assert.equal(following.relocated("a", true), "ignored");
  settled();
  following.gesture();
  clock.advance(OWN_LAYOUT_SETTLE_MS);
  assert.equal(following.relocated("a", true), "ignored");
  clock.advance(1);
  // The gesture is still recent: past the settle window, the relocation is the reader's.
  assert.equal(following.relocated("a", true), "manual");
});

test("our own layout's relocation is shown, not ignored, when nothing is shown yet, and never counts as the reader's", () => {
  const { following, clock, saved } = setup();
  following.gesture();
  following.beginOwnDisplay();
  assert.equal(following.relocated("a", false), "shown");
  assert.equal(following.isFollowing(), true);
  clock.advance(MANUAL_SAVE_DELAY_MS * 2);
  assert.deepEqual(saved, []);
});

test("relocations during the opening display window are our own", () => {
  const { following, clock } = setup();
  following.openingDisplay();
  following.gesture();
  clock.advance(OPENING_DISPLAY_MS);
  assert.equal(following.relocated("a", true), "ignored");
  clock.advance(1);
  assert.equal(following.relocated("a", true), "manual");
});

test("a resize or re-theme is our own until its relocation settles it, then for the settle window", () => {
  const { following, clock } = setup();
  let ended = 0;
  const settled = following.beginLayout(() => { ended++; });
  following.gesture();
  assert.equal(following.relocated("a", true), "ignored");
  settled();
  settled();
  assert.equal(ended, 1);
  following.gesture();
  clock.advance(OWN_LAYOUT_SETTLE_MS);
  assert.equal(following.relocated("a", true), "ignored");
  clock.advance(1);
  assert.equal(following.relocated("a", true), "manual");
  // The limit timer was cleared with the settle and does not run onEnd again.
  clock.advance(LAYOUT_LIMIT_MS * 2);
  assert.equal(ended, 1);
});

test("a resize that never reports a relocation stops being our own after the layout limit", () => {
  const { following, clock } = setup();
  let ended = 0;
  following.beginLayout(() => { ended++; });
  clock.advance(LAYOUT_LIMIT_MS - 1);
  following.gesture();
  assert.equal(following.relocated("a", true), "ignored");
  clock.advance(1);
  assert.equal(ended, 1);
  clock.advance(OWN_LAYOUT_SETTLE_MS + 1);
  following.gesture();
  assert.equal(following.relocated("a", true), "manual");
});

test("two layouts in flight: the view stays our own until both settled", () => {
  const { following, clock } = setup();
  const one = following.beginLayout();
  const two = following.beginOwnDisplay();
  one();
  clock.advance(OWN_LAYOUT_SETTLE_MS + 1);
  following.gesture();
  assert.equal(following.relocated("a", true), "ignored");
  two();
  clock.advance(OWN_LAYOUT_SETTLE_MS + 1);
  following.gesture();
  assert.equal(following.relocated("a", true), "manual");
});

test("Contents or a page turn pages away at once, and its relocation wins over a layout of ours in flight", () => {
  const { following, clock, saved } = setup();
  const layout = following.beginOwnDisplay();
  following.navigate();
  assert.equal(following.isFollowing(), false);
  const ended = following.beginNavigation();
  clock.advance(GESTURE_REPORT_MS * 3);
  assert.equal(following.relocated("chapter one", true), "manual");
  ended();
  layout();
  clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(saved, ["chapter one"]);
});

test("a navigation's relocation counts as the reader's until the report window after its display ended", () => {
  const { following, clock } = setup();
  const layout = following.beginOwnDisplay();
  following.navigate();
  const ended = following.beginNavigation();
  clock.advance(GESTURE_REPORT_MS * 2);
  ended();
  clock.advance(NAVIGATION_REPORT_MS);
  assert.equal(following.relocated("a", true), "manual");

  const late = setup();
  late.following.beginOwnDisplay();
  late.following.navigate();
  const lateEnded = late.following.beginNavigation();
  late.clock.advance(GESTURE_REPORT_MS * 2);
  lateEnded();
  late.clock.advance(NAVIGATION_REPORT_MS + 1);
  // Past the window, with our own display still pending, it is our layout.
  assert.equal(late.following.relocated("a", true), "ignored");
  layout();
});

test("a navigation clears the window of an earlier display of ours", () => {
  const { following, clock } = setup();
  following.beginOwnDisplay()();
  clock.advance(1);
  following.navigate();
  // No beginNavigation (no view yet): the navigation's gesture alone makes the next relocation the reader's.
  assert.equal(following.relocated("a", true), "manual");
});

test("a follow jump started after a navigation ends the navigation's window: its relocation is our own", () => {
  const { following, clock, saved } = setup();
  following.navigate();
  const ended = following.beginNavigation();
  ended();
  assert.equal(following.relocated("chapter one", true), "manual");
  following.backToNarration(true);
  const jump = following.startJump();
  const display = following.beginOwnDisplay();
  assert.equal(following.relocated("narrated", true), "ignored");
  display();
  assert.equal(jump.current(), true);
  assert.equal(following.isFollowing(), true);
  clock.advance(MANUAL_SAVE_DELAY_MS * 2);
  assert.deepEqual(saved, []);
});

test("a navigation replaces a follow jump in flight", () => {
  const { following } = setup();
  const jump = following.startJump();
  following.navigate();
  assert.equal(jump.current(), false);
  const newer = following.startJump();
  assert.equal(newer.current(), true);
  following.startJump();
  assert.equal(newer.current(), false);
});

test("a recording change replaces a jump in flight and forgets the followed sentence", () => {
  const { following } = setup();
  assert.equal(following.followTarget("r1:p1"), true);
  const jump = following.startJump();
  following.recordingChanged();
  assert.equal(jump.current(), false);
  assert.equal(following.followed(), "");
  assert.equal(following.followTarget("r1:p1"), true);
});

test("a recording change also ends a navigation's window", () => {
  const { following } = setup();
  const layout = following.beginOwnDisplay();
  following.navigate();
  following.beginNavigation();
  following.recordingChanged();
  assert.equal(following.relocated("a", true), "ignored");
  layout();
});

test("back to narration with a narration to follow drops the waiting manual position and ends the navigation's window", () => {
  const { following, clock, saved } = setup();
  const layout = following.beginOwnDisplay();
  following.navigate();
  following.beginNavigation()();
  assert.equal(following.relocated("chapter one", true), "manual");
  following.backToNarration(true);
  assert.equal(following.pendingManual(), null);
  clock.advance(MANUAL_SAVE_DELAY_MS * 2);
  assert.deepEqual(saved, []);
  clock.advance(GESTURE_REPORT_MS);
  // The navigation no longer counts: with our display pending this relocation is ours.
  assert.equal(following.relocated("late", true), "ignored");
  layout();
});

test("the follow step jumps once per sentence and again after the followed sentence is forgotten", () => {
  const { following } = setup();
  assert.equal(following.followTarget("r:p1"), true);
  assert.equal(following.followTarget("r:p1"), false);
  assert.equal(following.followTarget("r:p2"), true);
  following.forgetFollowed();
  assert.equal(following.followTarget("r:p2"), true);
});

test("a follow jump that did not show its sentence retries after the delay, then fails", () => {
  const { following, clock, retries } = setup();
  for (let attempt = 1; attempt <= FOLLOW_RETRIES; attempt++) {
    assert.equal(following.followTarget("r:p1"), true);
    assert.equal(following.followShown("r:p1", false), "retrying");
    assert.equal(following.followed(), "");
    clock.advance(FOLLOW_RETRY_DELAY_MS - 1);
    assert.equal(retries(), attempt - 1);
    clock.advance(1);
    assert.equal(retries(), attempt);
  }
  assert.equal(following.followTarget("r:p1"), true);
  assert.equal(following.followShown("r:p1", false), "failed");
});

test("a shown follow jump resets the attempts, and a new sentence starts its own count", () => {
  const { following, clock } = setup();
  following.followTarget("r:p1");
  following.followShown("r:p1", false);
  following.followTarget("r:p1");
  following.followShown("r:p1", false);
  following.followTarget("r:p1");
  assert.equal(following.followShown("r:p1", true), "shown");
  for (let attempt = 1; attempt <= FOLLOW_RETRIES; attempt++) {
    following.followTarget("r:p1");
    assert.equal(following.followShown("r:p1", false), "retrying");
  }
  // Another sentence: a fresh count, and the retry timer of the old one is dropped.
  let fired = 0;
  const other = createReaderFollowing<string>({ clock, onManualSave() {}, onRetry: () => { fired++; }, onClearFollowError() {} });
  other.followTarget("r:p1");
  other.followShown("r:p1", false);
  other.followTarget("r:p2");
  clock.advance(FOLLOW_RETRY_DELAY_MS * 2);
  assert.equal(fired, 0);
  for (let attempt = 1; attempt <= FOLLOW_RETRIES; attempt++) {
    other.followTarget("r:p2");
    assert.equal(other.followShown("r:p2", false), "retrying");
  }
});

test("a follow jump that ended after the narration moved on neither retries nor fails", () => {
  const { following, clock, retries } = setup();
  following.followTarget("r:p1");
  following.followTarget("r:p2");
  assert.equal(following.followShown("r:p1", false), "stale");
  assert.equal(following.followed(), "r:p2");
  clock.advance(FOLLOW_RETRY_DELAY_MS * 2);
  assert.equal(retries(), 0);
});

test("back to narration gives a sentence its full count of retries again", () => {
  const { following } = setup();
  for (let attempt = 1; attempt <= FOLLOW_RETRIES; attempt++) {
    following.followTarget("r:p1");
    following.followShown("r:p1", false);
  }
  following.backToNarration();
  following.followTarget("r:p1");
  assert.equal(following.followShown("r:p1", false), "retrying");
});

test("a Read from audio jump marks its sentence followed and holds the follow step off until it ends", () => {
  const { following } = setup();
  following.beginExplicitJump("r:p1");
  assert.equal(following.explicitJump(), true);
  assert.equal(following.followed(), "r:p1");
  assert.equal(following.followTarget("r:p1"), false);
  following.endExplicitJump();
  assert.equal(following.explicitJump(), false);
});

test("each change of following is reported once, and dispose drops the retry timer", () => {
  const clock = fakeClock();
  const heard: boolean[] = [];
  let retries = 0;
  const following = createReaderFollowing<string>({
    clock, onManualSave() {}, onRetry: () => { retries++; }, onClearFollowError() {},
    onFollowingChange: (value) => heard.push(value),
  });
  following.pageAway();
  following.pageAway();
  following.backToNarration();
  following.navigate();
  assert.deepEqual(heard, [false, true, false]);
  following.followTarget("r:p1");
  following.followShown("r:p1", false);
  following.dispose();
  clock.advance(FOLLOW_RETRY_DELAY_MS * 2);
  assert.equal(retries, 0);
});

test("closing the reader hands back a manual save that is still waiting, and its timer no longer runs", () => {
  const { following, clock, saved } = setup();
  assert.equal(following.takeManualSave(), null);
  following.gesture();
  following.relocated("page", true);
  following.dispose();
  assert.equal(following.takeManualSave(), "page");
  assert.equal(following.takeManualSave(), null);
  clock.advance(MANUAL_SAVE_DELAY_MS * 2);
  assert.deepEqual(saved, []);
});

test("a manual save that already ran is not handed back again", () => {
  const { following, clock, saved } = setup();
  following.gesture();
  following.relocated("page", true);
  clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(saved, ["page"]);
  assert.equal(following.takeManualSave(), null);
});

test("the time windows keep their values", () => {
  assert.deepEqual(
    [OWN_LAYOUT_SETTLE_MS, NAVIGATION_REPORT_MS, GESTURE_REPORT_MS, LAYOUT_LIMIT_MS, OPENING_DISPLAY_MS, MANUAL_SAVE_DELAY_MS, FOLLOW_RETRY_DELAY_MS, FOLLOW_RETRIES],
    [500, 1000, 1500, 10000, 1200, 500, 180, 3],
  );
});

// Back to narration and the pending manual saves it owns (#417). The sequences are the issue's; a
// "Reader" step names the call Reader.tsx makes for that user action.

// Every kind of pending manual save, each waiting: a Contents relocation and a search result.
function pendAll(t: ReturnType<typeof setup>) {
  t.following.navigate();
  t.following.beginNavigation()();
  assert.equal(t.following.relocated("chapter", true), "manual");
  return t.following.manualPlace();
}

test("sequence 1: without a narration to follow, back to narration keeps every waiting manual save, and each is still saved", () => {
  const t = setup();
  const search = pendAll(t);
  t.narration.now = false;
  t.following.backToNarration();
  assert.equal(t.following.isFollowing(), true);
  assert.equal(t.following.pendingManual(), "chapter");
  search.save("search result");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved.sort(), ["chapter", "search result"]);
});

test("sequence 1: without a narration to follow, a waiting manual position is still handed back when the reader closes", () => {
  const t = setup();
  t.following.gesture();
  t.following.relocated("page", true);
  t.following.backToNarration();
  assert.equal(t.following.takeManualSave(), "page");
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
});

test("with a narration to follow, back to narration drops every waiting manual save, wherever it waits", () => {
  const t = setup();
  const search = pendAll(t);
  t.narration.now = true;
  t.following.backToNarration();
  assert.equal(t.following.pendingManual(), null);
  search.save("search result");
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 20);
  assert.deepEqual(t.saved, []);
  assert.equal(t.following.takeManualSave(), null);
});

test("back to narration follows, forgets the followed sentence, resets the retries and clears a follow error", () => {
  const t = setup();
  t.following.followTarget("r:p1");
  t.following.pageAway();
  t.following.backToNarration();
  assert.equal(t.following.isFollowing(), true);
  assert.equal(t.following.followed(), "");
  assert.equal(t.cleared(), 1);
});

test("a manual save made after back to narration is the reader's again and is saved", () => {
  const t = setup();
  t.narration.now = true;
  t.following.backToNarration();
  const search = t.following.manualPlace();
  t.following.pageAway();
  search.save("search result");
  t.following.gesture();
  t.following.relocated("page", true);
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["search result", "page"]);
});

test("sequence 4: a page turn whose relocation arrives after back to narration and after the follow jump settled does not page away or arm a save", () => {
  const t = setup();
  t.following.navigate();
  const ended = t.following.beginNavigation();
  t.narration.now = true;
  t.following.backToNarration();
  // The follow jump to the narrated sentence starts and settles.
  const jump = t.following.startJump();
  const display = t.following.beginOwnDisplay();
  display();
  t.clock.advance(OWN_LAYOUT_SETTLE_MS + 1);
  ended();
  // Still inside the page turn's gesture window.
  assert.ok(OWN_LAYOUT_SETTLE_MS + 1 < GESTURE_REPORT_MS);
  assert.notEqual(t.following.relocated("turned page", true), "manual");
  assert.equal(t.following.isFollowing(), true);
  assert.equal(jump.current(), true);
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
});

test("sequence 4: a page turn whose relocation arrives after back to narration but before the follow jump started does not page away or arm a save", () => {
  const t = setup();
  t.following.navigate();
  t.following.beginNavigation();
  t.narration.now = true;
  t.following.backToNarration();
  assert.notEqual(t.following.relocated("turned page", true), "manual");
  assert.equal(t.following.isFollowing(), true);
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
});

test("sequence 1 and 4: without a narration to follow, a page turn reported after back to narration keeps following and its place is still saved", () => {
  const t = setup();
  t.following.navigate();
  const ended = t.following.beginNavigation();
  t.narration.now = false;
  t.following.backToNarration();
  ended();
  assert.equal(t.following.relocated("turned page", true), "shown");
  assert.equal(t.following.isFollowing(), true);
  assert.equal(t.following.pendingManual(), "turned page");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["turned page"]);
});

test("sequence 1: without a narration, a second relocation of a Contents choice after the switch is on keeps following and saves the last place", () => {
  const t = setup();
  t.following.navigate();
  const ended = t.following.beginNavigation();
  assert.equal(t.following.relocated("chapter", true), "manual");
  t.following.backToNarration();
  ended();
  t.clock.advance(200);
  assert.equal(t.following.relocated("chapter, settled", true), "shown");
  assert.equal(t.following.isFollowing(), true);
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["chapter, settled"]);
  // Once following works, a save it queued is dropped like the others.
  const later = setup();
  later.following.navigate();
  const done = later.following.beginNavigation();
  later.following.backToNarration();
  done();
  later.following.relocated("chapter", true);
  later.narration.now = true;
  later.following.followTarget("r:p1");
  later.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(later.saved, []);
});

test("without a narration, a gesture or navigation after back to narration pages away again as usual", () => {
  const t = setup();
  t.following.backToNarration();
  t.clock.advance(10);
  t.following.gesture();
  assert.equal(t.following.relocated("scrolled", true), "manual");
  assert.equal(t.following.isFollowing(), false);
  const nav = setup();
  nav.following.backToNarration();
  nav.following.navigate();
  nav.following.beginNavigation()();
  assert.equal(nav.following.relocated("chapter", true), "manual");
});

test("sequence 5: back to narration before the map arrived, then the map arrives inside the save pause: the kept saves are dropped when following starts to work", () => {
  const t = setup();
  const search = pendAll(t);
  t.narration.now = false;
  t.following.backToNarration();
  assert.equal(t.following.pendingManual(), "chapter");
  t.clock.advance(MANUAL_SAVE_DELAY_MS - 100);
  // Reader: the map arrived and the player is on a mapped sentence; the follow step runs.
  t.narration.now = true;
  assert.equal(t.following.followTarget("r:p1"), true);
  assert.equal(t.following.pendingManual(), null);
  search.save("search result");
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 20);
  assert.deepEqual(t.saved, []);
});

test("sequence 5: a page turn reported after following started to work is not the reader's either", () => {
  const t = setup();
  t.following.navigate();
  t.following.beginNavigation();
  t.following.backToNarration();
  t.narration.now = true;
  t.following.followTarget("r:p1");
  assert.notEqual(t.following.relocated("turned page", true), "manual");
  assert.equal(t.following.isFollowing(), true);
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
});

test("a save kept by back to narration that ran before following started to work stays saved", () => {
  const t = setup();
  t.following.gesture();
  t.following.relocated("chapter", true);
  t.following.backToNarration();
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  t.narration.now = true;
  t.following.followTarget("r:p1");
  assert.deepEqual(t.saved, ["chapter"]);
});

test("a manual move after back to narration without a narration is not dropped when following later works", () => {
  const t = setup();
  t.following.backToNarration();
  t.following.gesture();
  assert.equal(t.following.relocated("new page", true), "manual");
  // Following stopped with the move; a follow step that still ran from an older render drops nothing.
  t.following.followTarget("r:p1");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["new page"]);
});

test("sequence 6: the audio scrubber dragged from a mapped sentence into a gap keeps the waiting manual position", () => {
  const t = setup();
  t.following.gesture();
  t.following.relocated("chapter", true);
  // The drag starts on a mapped sentence; Reader asks for back to narration when it is released and
  // runs it once the player reports the place it went to: a gap.
  t.narration.now = true;
  const back = t.following.deferredReturn();
  t.clock.advance(100);
  t.narration.now = false;
  assert.notEqual(back.run(), null);
  assert.equal(t.following.isFollowing(), true);
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["chapter"]);
});

test("sequence 6: the audio scrubber dragged from a gap onto a mapped sentence drops the waiting manual position", () => {
  const t = setup();
  t.following.gesture();
  t.following.relocated("chapter", true);
  t.narration.now = false;
  const back = t.following.deferredReturn();
  // The player reports the place it went to: a mapped sentence, inside the save pause.
  t.narration.now = true;
  back.run();
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
});

test("sequence 6: released on another track, nothing changes until the player is there, and the decision is for that place", () => {
  // Into a gap on the other track. While the player still reports the mapped sentence of the track
  // left, following stays off: the follow step does not run, so nothing is dropped.
  const gap = setup();
  gap.following.navigate();
  gap.following.beginNavigation()();
  assert.equal(gap.following.relocated("chapter", true), "manual");
  gap.narration.now = true;
  const intoGap = gap.following.deferredReturn();
  assert.equal(gap.following.isFollowing(), false);
  assert.equal(gap.following.pendingManual(), "chapter");
  gap.clock.advance(100);
  // The other track loaded, in a gap.
  gap.narration.now = false;
  intoGap.run();
  assert.equal(gap.following.isFollowing(), true);
  gap.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(gap.saved, ["chapter"]);

  // Onto a mapped sentence of the other track: dropped once the player is there.
  const mapped = setup();
  mapped.following.navigate();
  mapped.following.beginNavigation()();
  mapped.following.relocated("chapter", true);
  mapped.narration.now = false;
  const ontoMapped = mapped.following.deferredReturn();
  mapped.clock.advance(100);
  mapped.narration.now = true;
  ontoMapped.run();
  mapped.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(mapped.saved, []);
});

test("a deferred back to narration does nothing once the reader chose again, another return ran, or a newer one replaced it", () => {
  for (const choose of ["gesture", "navigate", "pageAway", "backToNarration", "newer"] as const) {
    const t = setup();
    t.following.gesture();
    t.following.relocated("chapter", true);
    t.narration.now = true;
    const back = t.following.deferredReturn();
    // Each on its own: following stays as that left it, and nothing the return would drop is dropped.
    let newer: ReturnType<typeof t.following.deferredReturn> | null = null;
    if (choose === "newer") newer = t.following.deferredReturn();
    else if (choose === "backToNarration") t.following.backToNarration(false);
    else t.following[choose]();
    const following = t.following.isFollowing();
    assert.equal(back.run(), null, choose);
    assert.equal(t.following.isFollowing(), following, choose);
    t.clock.advance(MANUAL_SAVE_DELAY_MS);
    if (newer) {
      // The newer return waits for its player: the save that came due is held for its decision, here a gap.
      assert.deepEqual(t.saved, [], choose);
      t.narration.now = false;
      newer.run();
    }
    assert.deepEqual(t.saved, ["chapter"], choose);
  }
  // A late relocation from before (not a choice) does not cancel it, and it runs once.
  const t = setup();
  t.following.navigate();
  const ended = t.following.beginNavigation();
  t.following.relocated("chapter", true);
  const back = t.following.deferredReturn();
  ended();
  t.following.relocated("chapter, settled", true);
  t.narration.now = true;
  assert.notEqual(back.run(), null);
  assert.equal(back.run(), null);
  assert.equal(t.following.isFollowing(), true);
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
});

test("sequence 7: a Read from audio answer after a newer manual position neither drops it nor counts as current", () => {
  const t = setup();
  const search = t.following.manualPlace();
  // Read from audio in a gap: no narration, so the search result is kept while speech recovery runs.
  const recovery = t.following.backToNarration();
  assert.equal(recovery.current(), true);
  // The reader chooses Contents while the request runs.
  t.following.navigate();
  t.following.beginNavigation()();
  assert.equal(t.following.relocated("chosen chapter", true), "manual");
  assert.equal(recovery.current(), false);
  recovery.confirm();
  search.save("search result");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved.sort(), ["chosen chapter", "search result"]);
});

test("sequence 7: a Read from audio answer after the player switched to another recording is not current and drops nothing", () => {
  const t = setup();
  t.following.gesture();
  t.following.relocated("page", true);
  const recovery = t.following.backToNarration();
  t.following.recordingChanged();
  assert.equal(recovery.current(), false);
  recovery.confirm();
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["page"]);
});

test("a Read from audio answer that is still current confirms the narration and drops what the return kept", () => {
  const t = setup();
  t.following.gesture();
  t.following.relocated("page", true);
  const recovery = t.following.backToNarration();
  t.clock.advance(MANUAL_SAVE_DELAY_MS - 100);
  assert.equal(recovery.current(), true);
  recovery.confirm();
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
  // A later back to narration makes the answer stale too.
  const older = t.following.backToNarration();
  t.following.backToNarration();
  assert.equal(older.current(), false);
});

test("sequence 8: after back to narration a scroll gesture during an earlier navigation's display is a manual move", () => {
  for (const layout of ["resize", "display"] as const) {
    const t = setup();
    // A layout of ours is in flight when the reader chooses Contents.
    const settled = layout === "resize" ? t.following.beginLayout() : t.following.beginOwnDisplay();
    t.following.navigate();
    t.following.beginNavigation();
    t.narration.now = true;
    t.following.backToNarration();
    // Wheel or touch scrolling calls gesture(), not navigate().
    t.following.gesture();
    assert.equal(t.following.relocated("scrolled", true), "manual", layout);
    assert.equal(t.following.isFollowing(), false);
    t.clock.advance(MANUAL_SAVE_DELAY_MS);
    assert.deepEqual(t.saved, ["scrolled"], layout);
    settled();
  }
});

test("a display of a place chosen by hand saves once and only through its own answer", () => {
  const t = setup();
  const place = t.following.manualPlace();
  place.save("one");
  place.save("two");
  assert.deepEqual(t.saved, ["one"]);
});

test("a gesture made after a back to narration without a narration still counts once following starts to work", () => {
  const t = setup();
  t.following.navigate();
  t.following.beginNavigation()();
  t.following.backToNarration();
  t.clock.advance(100);
  // A wheel turn after the return, then the map arrives and following works.
  t.following.gesture();
  t.narration.now = true;
  t.following.followTarget("r:p1");
  assert.equal(t.following.relocated("scrolled", true), "manual");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["scrolled"]);
});

// Review round 1 of #417.

test("an unconfirmed map: back to narration keeps every waiting save, though the map has a sentence at the player's position", () => {
  // A map restored from the cache, shown before the map endpoint answered for the current audio.
  const t = setup({ confirmed: false });
  const search = pendAll(t);
  t.narration.now = true;
  t.following.backToNarration();
  // Following the narration on screen from the cached map is unchanged.
  assert.equal(t.following.isFollowing(), true);
  assert.equal(t.following.followTarget("r:p1"), true);
  assert.equal(t.following.pendingManual(), "chapter");
  search.save("search result");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved.sort(), ["chapter", "search result"]);
});

test("an unconfirmed map: an entry point that moves the narration to a mapped sentence keeps the waiting saves too", () => {
  const t = setup({ confirmed: false });
  // A page turn by hand: its place waits out the save pause.
  t.following.navigate();
  t.following.beginNavigation()();
  assert.equal(t.following.relocated("1:1", true), "manual");
  // Listen from here passes true for the mapped sentence it moves to.
  t.following.backToNarration(true);
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["1:1"]);
});

test("an unconfirmed map, then the map endpoint confirms it inside the save pause: following that works drops what the return kept", () => {
  const t = setup({ map: "map", confirmed: false });
  // A page turn by hand: its place waits out the save pause.
  t.following.navigate();
  t.following.beginNavigation()();
  assert.equal(t.following.relocated("1:1", true), "manual");
  t.narration.now = true;
  t.following.backToNarration();
  assert.equal(t.following.followTarget("r:p1"), true);
  t.clock.advance(MANUAL_SAVE_DELAY_MS - 100);
  // The server's answer is the same map, now confirmed; the follow step runs again.
  t.following.mapShown("map", true);
  t.following.followTarget("r:p1");
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
});

test("an unconfirmed map, then the map endpoint refuses it: nothing was dropped and the waiting save lands", () => {
  const t = setup({ map: "map", confirmed: false });
  // A page turn by hand: its place waits out the save pause.
  t.following.navigate();
  t.following.beginNavigation()();
  assert.equal(t.following.relocated("1:1", true), "manual");
  t.narration.now = true;
  t.following.backToNarration();
  t.following.followTarget("r:p1");
  t.clock.advance(100);
  // The audio changed in place: the server refuses the map, the reader shows none.
  t.following.mapShown(null, true);
  t.narration.now = false;
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["1:1"]);
});

test("no map shown: back to narration keeps every waiting save, whatever the narration check answers", () => {
  const t = setup({ map: null });
  t.following.gesture();
  t.following.relocated("page", true);
  t.narration.now = true;
  t.following.backToNarration(true);
  t.following.followTarget("r:p1");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["page"]);
});

test("a confirmed map that is then shown unconfirmed (a rebuilt map from the cache) is no reason to drop a save until confirmed again", () => {
  const t = setup();
  t.following.mapShown("rebuilt", false);
  t.following.gesture();
  t.following.relocated("page", true);
  t.narration.now = true;
  t.following.backToNarration();
  t.following.followTarget("r:p1");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["page"]);
});

test("a Read from audio answer is not current once another map replaced the one it was made with, even for the same recording", () => {
  for (const change of ["rebuilt", "corrected", "none"] as const) {
    const t = setup({ map: "kept" });
    t.following.gesture();
    t.following.relocated("page", true);
    // Read from audio in a gap: speech recovery runs.
    const recovery = t.following.backToNarration();
    assert.equal(recovery.current(), true);
    // A rebuilt map replaces the kept one, a corrected map the shown one, or the map is gone.
    t.following.mapShown(change === "none" ? null : change, true);
    assert.equal(recovery.current(), false, change);
    recovery.confirm();
    t.clock.advance(MANUAL_SAVE_DELAY_MS);
    assert.deepEqual(t.saved, ["page"], change);
  }
});

test("a Read from audio answer stays current when the same map is only confirmed (cached copy, then the server's answer)", () => {
  const t = setup({ map: "map", confirmed: false });
  t.following.gesture();
  t.following.relocated("page", true);
  const recovery = t.following.backToNarration();
  t.following.mapShown("map", true);
  assert.equal(recovery.current(), true);
  recovery.confirm();
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
});

test("the waiting signal is on while a save of a place chosen by hand waits, and off once it ran or was dropped", () => {
  const t = setup();
  t.following.gesture();
  t.following.relocated("page", true);
  assert.deepEqual(t.waiting, [true]);
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.waiting, [true, false]);
  assert.deepEqual(t.saved, ["page"]);
  // A page turn and a display, dropped by back to narration.
  t.following.gesture();
  t.following.relocated("next page", true);
  const search = t.following.manualPlace();
  assert.deepEqual(t.waiting, [true, false, true]);
  t.narration.now = true;
  t.following.backToNarration();
  assert.deepEqual(t.waiting, [true, false, true, false]);
  search.save("search result");
  // A display that ended without a place saves nothing and stops waiting.
  const failed = t.following.manualPlace();
  failed.save(null);
  assert.deepEqual(t.waiting, [true, false, true, false, true, false]);
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, ["page"]);
});

test("after back to narration a fresh gesture whose relocation arrives while a follow jump is displaying is our own layout, as without the return", () => {
  // The reviewer's ordering: gesture, then a follow jump starts, then the gesture's relocation.
  for (const returned of [false, true]) {
    const t = setup();
    t.following.navigate();
    t.following.beginNavigation()();
    t.following.relocated("chapter", true);
    if (returned) {
      t.narration.now = true;
      t.following.backToNarration();
    } else t.following.pageAway();
    t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
    t.following.gesture();
    t.following.startJump();
    const settled = t.following.beginOwnDisplay();
    assert.equal(t.following.relocated("scrolled", true), "ignored", String(returned));
    settled();
    // Once the jump settled, a relocation inside the gesture window is the reader's again.
    t.clock.advance(OWN_LAYOUT_SETTLE_MS + 1);
    t.following.gesture();
    assert.equal(t.following.relocated("scrolled again", true), "manual", String(returned));
  }
});

// #417 flake (flake-b2n-165): a re-theme schedules a display back to the place shown. Contents chosen before
// that display is due, whose relocation is not reported yet, leaves the place shown as the one before the choice.
// Displaying it then undid the choice, and its relocation, inside the navigation's window, was saved as the reader's.
test("a restore of the place shown is not due once the reader chose a place since, so the chosen chapter is saved", () => {
  const t = setup({ map: null });
  // The reader shows the opening place, then re-themes: the restore is due 80 ms later.
  t.following.relocated("chapter zero", false);
  const restore = t.following.restoreLater();
  t.following.navigate();
  const ended = t.following.beginNavigation();
  t.clock.advance(30);
  ended();
  // The restore comes due before the navigation's relocation is reported.
  assert.equal(restore.due(), false);
  assert.equal(t.following.relocated("chapter one", true), "manual");
  t.following.backToNarration();
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["chapter one"]);
});

test("a restore of the place shown stays due through our own displays, follow jumps and back to narration", () => {
  const t = setup();
  const restore = t.following.restoreLater();
  t.following.beginOwnDisplay()();
  t.following.startJump();
  t.following.backToNarration();
  t.following.recordingChanged();
  assert.equal(restore.due(), true);
  // Each reader's choice makes it stale: a gesture, Contents or a page turn, paging away.
  for (const choose of [
    () => t.following.gesture(),
    () => t.following.navigate(),
    () => t.following.pageAway(),
  ]) {
    const later = t.following.restoreLater();
    choose();
    assert.equal(later.due(), false);
  }
});

// #417 flake (flake-b2n-165), sequence 6 under load: the scrubber was released inside the pause after a Contents
// choice, but the player took longer than the rest of the pause to reach the place. The decision is made where the
// scrub ends, so a save that comes due while it waits is held for that decision, not run before it.
test("sequence 6: a manual save that comes due while a scrubber return waits for the player is held for its decision", () => {
  // Onto a mapped sentence: dropped once the player is there, although the pause ran out meanwhile.
  const mapped = setup();
  mapped.following.navigate();
  mapped.following.beginNavigation()();
  assert.equal(mapped.following.relocated("chapter", true), "manual");
  mapped.clock.advance(400);
  const ontoMapped = mapped.following.deferredReturn();
  mapped.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(mapped.saved, []);
  assert.equal(mapped.following.pendingManual(), "chapter");
  assert.equal(mapped.waiting.at(-1), true);
  mapped.narration.now = true;
  ontoMapped.run();
  mapped.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(mapped.saved, []);
  assert.equal(mapped.waiting.at(-1), false);

  // Into a gap: nothing replaces the chapter, so it is saved as soon as the decision is made.
  const gap = setup();
  gap.following.navigate();
  gap.following.beginNavigation()();
  gap.following.relocated("chapter", true);
  const intoGap = gap.following.deferredReturn();
  gap.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(gap.saved, []);
  gap.narration.now = false;
  intoGap.run();
  assert.deepEqual(gap.saved, ["chapter"]);
  assert.equal(gap.waiting.at(-1), false);
});

test("a manual save held for a scrubber return is saved once the return no longer runs, and handed back when the reader closes", () => {
  // The reader chose again before the player got there: the return does nothing, and the held save runs.
  const chose = setup();
  chose.following.gesture();
  chose.following.relocated("chapter", true);
  const back = chose.following.deferredReturn();
  chose.clock.advance(MANUAL_SAVE_DELAY_MS);
  chose.following.pageAway();
  assert.deepEqual(chose.saved, []);
  assert.equal(back.run(), null);
  assert.deepEqual(chose.saved, ["chapter"]);
  // Paged away, a later save is not held for that return any more.
  chose.following.gesture();
  chose.following.relocated("page", true);
  chose.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(chose.saved, ["chapter", "page"]);

  // Another back to narration decides for it: without a narration it is saved at once.
  const other = setup();
  other.following.gesture();
  other.following.relocated("chapter", true);
  other.following.deferredReturn();
  other.clock.advance(MANUAL_SAVE_DELAY_MS);
  other.narration.now = false;
  other.following.backToNarration();
  assert.deepEqual(other.saved, ["chapter"]);

  // The reader closes while the return still waits: the held save is handed back to be saved now.
  const closed = setup();
  closed.following.gesture();
  closed.following.relocated("chapter", true);
  closed.following.deferredReturn();
  closed.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.equal(closed.following.takeManualSave(), "chapter");
  assert.equal(closed.following.takeManualSave(), null);
  assert.deepEqual(closed.saved, []);
});

// #417 flake (flake-b2n-165), sequence 6 under load: while a Contents choice was displaying, epub.js reported the
// section it was leaving once more, and that report was saved as the reader's move after the pause.
test("while a Contents choice displays, a report of another section is not its relocation: it pages nothing and arms no save", () => {
  const t = setup();
  t.following.relocated("listening place", false, 1);
  t.following.navigate(0);
  const ended = t.following.beginNavigation();
  assert.equal(t.following.relocated("listening place", true, 1), "shown");
  assert.equal(t.following.pendingManual(), null);
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 2);
  assert.deepEqual(t.saved, []);
  ended();
  // The chapter chosen is the reader's, as before.
  assert.equal(t.following.relocated("chapter", true, 0), "manual");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved, ["chapter"]);
});

test("a Contents choice of the section shown, a page turn into another section, and a gesture after a choice are still the reader's", () => {
  // The chapter shown chosen again (integrated-reader: Contents during a follow jump wins and is saved).
  const same = setup();
  same.following.relocated("chapter start", false, 0);
  same.following.navigate(0);
  same.following.beginNavigation()();
  assert.equal(same.following.relocated("chapter start", true, 0), "manual");
  same.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(same.saved, ["chapter start"]);
  // A page turn has no section to go to: its relocation in the next section is the reader's.
  const turn = setup();
  turn.following.navigate();
  turn.following.beginNavigation()();
  assert.equal(turn.following.relocated("next chapter", true, 1), "manual");
  // A swipe after a Contents choice into a neighbouring section is the reader's too.
  const swipe = setup();
  swipe.following.navigate(0);
  swipe.following.beginNavigation()();
  swipe.following.gesture();
  assert.equal(swipe.following.relocated("next chapter", true, 1), "manual");
});

// The narrated sentence and the narration highlight (#502): the sentence of the map with the latest start at or
// before the narration's position, taking the recording's tracks in order, with no time limit.

// A scripted map of recording "rec" on two tracks, "t1" then "t2". On t1 the first sentence starts at 10 s (an
// introduction the ebook does not have before it), a silence follows a1, and between a2 and a3 the narrator
// reads 60 s the ebook does not have. t2 starts with 5 s of music before b1. The map lists t2 first and a3
// before a2, so its own order is not the narration's.
const sentence = (paragraphId: string, trackId: string, start: number, end: number) => ({ paragraphId, trackId, start, end });
const narrated = {
  recordingId: "rec",
  intervals: [
    sentence("b1", "t2", 5, 9),
    sentence("b2", "t2", 9, 14),
    sentence("a1", "t1", 10, 14),
    sentence("a3", "t1", 80, 85),
    sentence("a2", "t1", 16, 20),
  ],
};
const tracks = ["t1", "t2"];
const at = (trackId: string, position: number, recordingId = "rec") => ({ recordingId, tracks, trackId, position });
const narratedAt = (following: ReturnType<typeof setup>["following"], trackId: string, position: number) =>
  following.narratedSentence(narrated, at(trackId, position))?.paragraphId ?? null;

test("narrated sentence: inside a sentence it is that sentence, from its first moment", () => {
  const { following } = setup();
  assert.equal(narratedAt(following, "t1", 10), "a1");
  assert.equal(narratedAt(following, "t1", 12.5), "a1");
  assert.equal(narratedAt(following, "t1", 17), "a2");
  assert.equal(narratedAt(following, "t2", 10), "b2");
  assert.equal(following.highlightedSentence(narrated, at("t1", 12.5))?.paragraphId, "a1");
});

test("narrated sentence: in the silence after a sentence it stays on that sentence until the next one begins", () => {
  const { following } = setup();
  // a1 ends at 14, a2 starts at 16.
  assert.equal(narratedAt(following, "t1", 14), "a1");
  assert.equal(narratedAt(following, "t1", 15.99), "a1");
  assert.equal(following.highlightedSentence(narrated, at("t1", 15))?.paragraphId, "a1");
  assert.equal(narratedAt(following, "t1", 16), "a2");
});

test("narrated sentence: through a passage the ebook does not have it stays, with no time limit", () => {
  const { following } = setup();
  // a2 ends at 20; the narrator reads 60 s the ebook does not have before a3 at 80.
  for (const position of [20, 21, 45, 79.9]) assert.equal(narratedAt(following, "t1", position), "a2", `at ${position}`);
  assert.equal(narratedAt(following, "t1", 80), "a3");
  // After the last sentence of the file, to its very end.
  assert.equal(narratedAt(following, "t1", 3600), "a3");
});

test("narrated sentence: a jump into a gap marks the last sentence that started before the new position", () => {
  const { following } = setup();
  assert.equal(narratedAt(following, "t1", 11), "a1");
  // Forward into the passage the ebook does not have, past a2 which the narration never played.
  assert.equal(narratedAt(following, "t1", 50), "a2");
  // Back into the silence after a1.
  assert.equal(narratedAt(following, "t1", 15), "a1");
});

test("narrated sentence: at the start of a new audio file the last sentence of the file before stays until the new file's first sentence", () => {
  const { following } = setup();
  assert.equal(narratedAt(following, "t2", 0), "a3");
  assert.equal(narratedAt(following, "t2", 4.99), "a3");
  assert.equal(narratedAt(following, "t2", 5), "b1");
  // The order is the recording's: given the other way round, t2 comes first and t1 starts after b2.
  assert.equal(following.narratedSentence(narrated, { recordingId: "rec", tracks: ["t2", "t1"], trackId: "t1", position: 2 })?.paragraphId, "b2");
});

test("narrated sentence: before the map's first sentence there is none", () => {
  const { following } = setup();
  assert.equal(narratedAt(following, "t1", 0), null);
  assert.equal(narratedAt(following, "t1", 9.99), null);
  assert.equal(following.highlightedSentence(narrated, at("t1", 5)), null);
  // A track the recording does not list, and a place without a track, have none either.
  assert.equal(narratedAt(following, "t9", 50), null);
  assert.equal(following.narratedSentence(narrated, { recordingId: "rec", tracks, position: 50 }), null);
});

test("narrated sentence: there is none with a map for another recording than the one in the player, or without a map", () => {
  const { following } = setup();
  assert.equal(following.narratedSentence(narrated, at("t1", 12, "other")), null);
  assert.equal(following.highlightedSentence(narrated, at("t1", 12, "other")), null);
  assert.equal(following.narratedSentence(narrated, { tracks, trackId: "t1", position: 12 }), null);
  assert.equal(following.narratedSentence(null, at("t1", 12)), null);
  assert.equal(following.highlightedSentence(undefined, at("t1", 12)), null);
});

test("narration highlight: with Follow the narration off there is none, and it comes back with following", () => {
  const { following } = setup();
  following.pageAway();
  assert.equal(following.highlightedSentence(narrated, at("t1", 12)), null);
  assert.equal(following.highlightedSentence(narrated, at("t1", 50)), null);
  // The narration itself still has its sentence: Back to narration can return to it.
  assert.equal(narratedAt(following, "t1", 50), "a2");
  following.backToNarration();
  assert.equal(following.highlightedSentence(narrated, at("t1", 50))?.paragraphId, "a2");
});

test("narration highlight: in a gap the followed sentence does not change, so the view does not move", () => {
  const { following } = setup();
  const key = (position: number) => `rec:${following.highlightedSentence(narrated, at("t1", position))!.paragraphId}`;
  assert.equal(following.followTarget(key(17)), true);
  for (const position of [20, 30, 79]) assert.equal(following.followTarget(key(position)), false, `at ${position}`);
  assert.equal(following.followTarget(key(80)), true);
});

test("narrated sentence: a rebuilt map with the same tracks is read afresh", () => {
  const { following } = setup();
  assert.equal(narratedAt(following, "t1", 50), "a2");
  const rebuilt = { recordingId: "rec", intervals: [sentence("c1", "t1", 40, 45)] };
  assert.equal(following.narratedSentence(rebuilt, at("t1", 50))?.paragraphId, "c1");
  assert.equal(following.narratedSentence(rebuilt, at("t1", 30)), null);
});

// The sequences for back to narration, the gap case: "a narration to follow" now means there is a narrated
// sentence, as Reader.tsx asks it through the module's rule, so back to narration works during a gap.
function gapSetup(position: { trackId: string; position: number }) {
  const t = setup();
  const place = { ...position };
  const following: ReaderFollowing<string> = createReaderFollowing<string>({
    clock: t.clock,
    onManualSave: (locator) => { t.saved.push(locator); },
    narrationToFollow: (): boolean => !!following.narratedSentence(narrated, at(place.trackId, place.position)),
    onRetry: () => {},
    onClearFollowError: () => {},
  });
  following.mapShown("map", true);
  return { ...t, following, place };
}

test("gap case: back to narration in a gap drops every waiting manual save and follows the last narrated sentence", () => {
  const t = gapSetup({ trackId: "t1", position: 50 });
  const search = pendAll(t);
  assert.equal(t.following.isFollowing(), false);
  t.following.backToNarration();
  assert.equal(t.following.isFollowing(), true);
  assert.equal(t.following.pendingManual(), null);
  search.save("search result");
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 20);
  assert.deepEqual(t.saved, []);
  assert.equal(t.following.highlightedSentence(narrated, at("t1", 50))?.paragraphId, "a2");
});

test("gap case: before the map's first sentence back to narration still keeps the waiting saves, and each is saved", () => {
  const t = gapSetup({ trackId: "t1", position: 5 });
  const search = pendAll(t);
  t.following.backToNarration();
  assert.equal(t.following.pendingManual(), "chapter");
  search.save("search result");
  t.clock.advance(MANUAL_SAVE_DELAY_MS);
  assert.deepEqual(t.saved.sort(), ["chapter", "search result"]);
});

test("gap case: the audio scrubber released in a gap, or at the start of the next file, drops the waiting manual position", () => {
  for (const target of [{ trackId: "t1", position: 50 }, { trackId: "t2", position: 2 }]) {
    const t = gapSetup({ trackId: "t1", position: 5 });
    t.following.gesture();
    t.following.relocated("chapter", true);
    const back = t.following.deferredReturn();
    Object.assign(t.place, target);
    assert.notEqual(back.run(), null);
    t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
    assert.deepEqual(t.saved, [], `${target.trackId} ${target.position}`);
  }
});

test("gap case: a back to narration before the first sentence drops what it kept once the narration reaches the first sentence", () => {
  const t = gapSetup({ trackId: "t1", position: 5 });
  t.following.navigate();
  t.following.beginNavigation()();
  t.following.relocated("chapter", true);
  t.following.backToNarration();
  assert.equal(t.following.pendingManual(), "chapter");
  // The narration reaches a1 inside the save pause; the follow step runs for it.
  t.place.position = 12;
  t.clock.advance(100);
  const sentence = t.following.highlightedSentence(narrated, at("t1", 12))!;
  t.following.followTarget(`rec:${sentence.paragraphId}`);
  t.clock.advance(MANUAL_SAVE_DELAY_MS * 4);
  assert.deepEqual(t.saved, []);
});
