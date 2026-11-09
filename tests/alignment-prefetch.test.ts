import test from "node:test";
import assert from "node:assert/strict";
import { prefetchSectionCount, upcomingPrefetchWindows } from "../server/alignment-prefetch.ts";

const pairings = [0, 1, 2, 3, 4, 5].map((section) => ({ section, start: section * 100, duration: 90 }));

test("names the next sections after the current one", () => {
  const windows = upcomingPrefetchWindows(pairings, 1, 3, () => false, (pair) => `/audio/${pair.section}.mp3`);
  assert.deepEqual(windows, [
    { audio: "/audio/2.mp3", start: 200, duration: 90 },
    { audio: "/audio/3.mp3", start: 300, duration: 90 },
    { audio: "/audio/4.mp3", start: 400, duration: 90 },
  ]);
});

test("skips finished sections and sections without audio, and stops at the end", () => {
  const windows = upcomingPrefetchWindows(
    pairings, 2, 5,
    (pair) => pair.section === 3,
    (pair) => (pair.section === 4 ? null : `/audio/${pair.section}.mp3`),
  );
  assert.deepEqual(windows.map((w) => w.audio), ["/audio/5.mp3"]);
});

test("the last section prefetches nothing, and a zero count turns it off", () => {
  assert.deepEqual(upcomingPrefetchWindows(pairings, 5, 6, () => false, () => "/a"), []);
  assert.deepEqual(upcomingPrefetchWindows(pairings, 0, 0, () => false, () => "/a"), []);
});

test("section count comes from ALIGNMENT_PREFETCH_SECTIONS within 0 to 16", () => {
  assert.equal(prefetchSectionCount({}), 6);
  assert.equal(prefetchSectionCount({ ALIGNMENT_PREFETCH_SECTIONS: "0" }), 0);
  assert.equal(prefetchSectionCount({ ALIGNMENT_PREFETCH_SECTIONS: "12" }), 12);
  assert.equal(prefetchSectionCount({ ALIGNMENT_PREFETCH_SECTIONS: "99" }), 6);
  assert.equal(prefetchSectionCount({ ALIGNMENT_PREFETCH_SECTIONS: "x" }), 6);
});
