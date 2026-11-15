// The Reading sync card's Prepare decisions (#405): with whole-book jobs the card has no chapter matching step;
// without them (or from an older server that does not say) it is as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { offersChapterMatching, pairingBlock, prepareBody, prepareHelp } from "../src/reading-sync-prepare.ts";

const pairings = [
  { section: 1, trackId: "t", start: 0, duration: 21.5 },
  { section: 2, trackId: "t", start: 21.5, duration: 1958 },
];
const chaptered = { clips: [{ duration: 21.5 }, { duration: 1958 }], anchored: false };
const longFile = { clips: [{ duration: 30_000 }], anchored: true };

test("whole-book jobs: no matching step, no count or review sentence, and Prepare sends no pairings", () => {
  const options = { ...chaptered, bookJobs: true };
  assert.equal(offersChapterMatching(options), false);
  assert.equal(prepareHelp(options, pairings), "");
  assert.equal(pairingBlock(options, pairings, false), null);
  assert.deepEqual(prepareBody("e", "r", options, pairings), { ebookId: "e", recordingId: "r" });
  // A chaptered release with nothing matched, and one long file, start directly too.
  assert.equal(pairingBlock(options, [], false), null);
  assert.equal(pairingBlock({ ...longFile, bookJobs: true }, [], true), null);
  assert.deepEqual(prepareBody("e", "r", { ...longFile, bookJobs: true }, []), { ebookId: "e", recordingId: "r" });
});

test("whole-book jobs: unknown audio lengths still block Prepare", () => {
  assert.match(pairingBlock({ clips: [{ duration: 0 }], bookJobs: true }, [], true) ?? "", /Audio lengths are unknown/);
});

test("window runner (and a server that does not say): the matching step and its texts are as before", () => {
  for (const options of [chaptered, { ...chaptered, bookJobs: false }]) {
    assert.equal(offersChapterMatching(options), true);
    assert.equal(prepareHelp(options, pairings),
      "2 ebook sections matched to audio. Review the chapter matches, then prepare sentence timings.");
    assert.equal(prepareHelp(options, pairings.slice(0, 1)),
      "1 ebook section matched to audio. Review the chapter matches, then prepare sentence timings.");
    assert.deepEqual(prepareBody("e", "r", options, pairings), { ebookId: "e", recordingId: "r", pairings });
    assert.deepEqual(prepareBody("e", "r", options, pairings, true), { ebookId: "e", recordingId: "r", mode: "anchored" });
    assert.equal(pairingBlock(options, pairings, false), null);
    assert.match(pairingBlock(options, [], false) ?? "", /^No ebook sections matched automatically/);
  }
  assert.equal(offersChapterMatching(null), true);
  assert.match(prepareHelp(longFile, []), /^No chapter markers\. Reading sync samples the narration/);
  assert.deepEqual(prepareBody("e", "r", longFile, []), { ebookId: "e", recordingId: "r", mode: "anchored" });
  assert.equal(pairingBlock(longFile, [], true), null);
  assert.match(pairingBlock({ clips: [{ duration: 30_000 }] }, [], true) ?? "", /^This release is one long audio file/);
  assert.match(pairingBlock({ clips: [{ duration: 0 }, { duration: 0 }] }, [], false) ?? "", /Audio lengths are unknown/);
});
