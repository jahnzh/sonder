// A load's seek is confirmed where the element lands (#593 fix round): Firefox lands a seek on a device copy's
// multi-part Blob at the end of what it has read, so the player holds the target, waits for the bytes and seeks again.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  heldPosition,
  landingSought,
  landingStep,
  pendingSought,
  LANDING_TOLERANCE,
  LANDING_TRIES,
  LANDING_WAIT_MS,
  type Landing,
  type LandingRead,
} from "../src/seek-landing";

const landing = (over: Partial<Landing> = {}): Landing => ({ generation: 4, target: 160, tries: 0, since: 1_000, ...over });
const read = (over: Partial<LandingRead> = {}): LandingRead => ({
  generation: 4,
  seeking: false,
  currentTime: 160,
  covers: () => true,
  now: 2_000,
  ...over,
});

test("a seek that landed on its target, or within the tolerance, is done", () => {
  assert.deepEqual(landingStep(landing(), read()), { action: "done" });
  assert.deepEqual(landingStep(landing(), read({ currentTime: 160 + LANDING_TOLERANCE })), { action: "done" });
  assert.deepEqual(landingStep(landing(), read({ currentTime: 160 - LANDING_TOLERANCE })), { action: "done" });
});

test("nothing is held without a landing or for an older load", () => {
  assert.deepEqual(landingStep(null, read()), { action: "none" });
  assert.deepEqual(landingStep(landing({ generation: 3 }), read({ currentTime: 8 })), { action: "none" });
});

test("a seek still running waits without looking again on its own", () => {
  assert.deepEqual(landingStep(landing(), read({ seeking: true, currentTime: 8 })), { action: "wait", recheck: false });
  assert.deepEqual(landingStep(landing(), read({ currentTime: Number.NaN })), { action: "wait", recheck: false });
});

test("Firefox's short landing before the target is read: wait and look again, never seek into the same buffered end", () => {
  const short = read({ currentTime: 8.688, covers: (target) => target <= 8.688 });
  assert.deepEqual(landingStep(landing(), short), { action: "wait", recheck: true });
  // After a minute it stops looking on its own; the target stays held all the same.
  assert.deepEqual(landingStep(landing(), { ...short, now: 1_000 + LANDING_WAIT_MS }), { action: "wait", recheck: false });
  assert.equal(heldPosition(landing(), 4, 8.688), 160);
});

test("once the target is read, a landing away from it seeks again, at most LANDING_TRIES times", () => {
  const off = read({ currentTime: 8.688 });
  assert.deepEqual(landingStep(landing(), off), { action: "reseek", target: 160 });
  assert.deepEqual(landingStep(landing({ tries: LANDING_TRIES - 1 }), off), { action: "reseek", target: 160 });
  assert.deepEqual(landingStep(landing({ tries: LANDING_TRIES }), off), { action: "done" });
  // Past the target too (a landing too far on).
  assert.deepEqual(landingStep(landing(), read({ currentTime: 200 })), { action: "reseek", target: 160 });
});

test("the held place is the target only for the current load's landing", () => {
  assert.equal(heldPosition(landing(), 4, 4.08), 160);
  assert.equal(heldPosition(landing(), 5, 4.08), 4.08);
  assert.equal(heldPosition(null, 4, 4.08), 4.08);
});

// #730: a seek made while a load's seek is held, backwards or forwards, paused, is the place from then on.
test("a seek away from a held target replaces it, with tries and the wait of its own", () => {
  const held = landing({ tries: 2 });
  // Backwards (11:3 before 12:4 on the live check) and forwards.
  assert.deepEqual(landingSought(held, 4, 95, 9_000), { generation: 4, target: 95, tries: 0, since: 9_000 });
  assert.deepEqual(landingSought(held, 4, 240, 9_000), { generation: 4, target: 240, tries: 0, since: 9_000 });
  // The held place follows it, and once the element is there the landing is done.
  const sought = landingSought(held, 4, 95, 9_000);
  assert.equal(heldPosition(sought, 4, 41.448), 95);
  assert.deepEqual(landingStep(sought, read({ currentTime: 95 })), { action: "done" });
  // It is never sought back to the old target.
  assert.deepEqual(landingStep(sought, read({ currentTime: 95.4, now: 9_100 })), { action: "done" });
});

test("the landing's own reseek, or a seek within the tolerance, keeps the landing as it is", () => {
  const held = landing({ tries: 2 });
  assert.equal(landingSought(held, 4, 160, 9_000), held);
  assert.equal(landingSought(held, 4, 160 + LANDING_TOLERANCE, 9_000), held);
  assert.equal(landingSought(held, 4, 160 - LANDING_TOLERANCE, 9_000), held);
});

test("a seek with no landing held, an older load's landing, or no number holds nothing new", () => {
  assert.equal(landingSought(null, 4, 95, 9_000), null);
  const older = landing({ generation: 3 });
  assert.equal(landingSought(older, 4, 95, 9_000), older);
  const held = landing();
  assert.equal(landingSought(held, 4, Number.NaN, 9_000), held);
});

test("a seek made before a load's metadata arrives is the place the load seeks to (#730 second round)", () => {
  assert.equal(pendingSought(160, 40), 40);
  assert.equal(pendingSought(40, 160), 160);
  assert.equal(pendingSought(160, -3), 0);
  assert.equal(pendingSought(160, Number.NaN), 160);
  // No load waiting: the element's own seek is the place, nothing is pending.
  assert.equal(pendingSought(null, 40), null);
});
