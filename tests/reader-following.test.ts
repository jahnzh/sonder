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

function setup() {
  const clock = fakeClock();
  const saved: string[] = [];
  let retries = 0;
  let cleared = 0;
  const following = createReaderFollowing<string>({
    clock,
    onManualSave: (locator) => saved.push(locator),
    onRetry: () => { retries++; },
    onClearFollowError: () => { cleared++; },
  });
  return { clock, saved, following, retries: () => retries, cleared: () => cleared };
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
  following.cancelManualSave();
  following.follow();
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

test("a Word mode step leaves a jump current but marks it stepped", () => {
  const { following } = setup();
  const jump = following.startJump();
  following.wordStep(true);
  assert.equal(jump.current(), true);
  assert.equal(jump.stepped(), true);
  assert.equal(following.startJump().stepped(), false);
});

test("a Word mode step pages away unless it moved the narration along", () => {
  const moved = setup();
  moved.following.wordStep(true);
  assert.equal(moved.following.isFollowing(), true);
  const stayed = setup();
  stayed.following.wordStep(false);
  assert.equal(stayed.following.isFollowing(), false);
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

test("a Lyrics page turn pages away, ends the window of our last display and counts as a gesture", () => {
  const { following } = setup();
  following.beginOwnDisplay()();
  following.manualStep();
  assert.equal(following.isFollowing(), false);
  assert.equal(following.relocated("a", true), "manual");
});

test("dropping the waiting manual position cancels its save and ends the navigation's window", () => {
  const { following, clock, saved } = setup();
  const layout = following.beginOwnDisplay();
  following.navigate();
  following.beginNavigation()();
  assert.equal(following.relocated("chapter one", true), "manual");
  following.cancelManualSave();
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

test("resetting the retries gives a sentence its full count again", () => {
  const { following } = setup();
  for (let attempt = 1; attempt <= FOLLOW_RETRIES; attempt++) {
    following.followTarget("r:p1");
    following.followShown("r:p1", false);
  }
  following.resetRetries();
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
  following.follow();
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
