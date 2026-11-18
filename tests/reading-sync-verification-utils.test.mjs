import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleSentences, pageExpectations } from "../scripts/reading-sync-verification-utils.mjs";

const text = (name) => `${name} is a synthetic sentence whose many words make it suitable for a search and a listening sample.`;
const section = (index) => ({ index, title: `Chapter ${index}`, paragraphs: [{ id: `p${index}`, text: text(`Chapter ${index}`) }] });
const interval = (index, trackId = `track-${index}`) => ({ section: index, paragraphId: `p${index}`, trackId, start: 2, end: 8 });

test("samples mapped sections in book order without pairings, preserving each interval's track", () => {
  const manifest = { sections: [0, 1, 2, 3, 4, 5, 6].map(section) };
  const samples = sampleSentences({ intervals: [interval(5), interval(1), interval(3), interval(4)] }, manifest);
  assert.deepEqual(samples.map((sample) => sample.section.index), [1, 4, 5]);
  assert.deepEqual(samples.map((sample) => sample.interval.trackId), ["track-1", "track-4", "track-5"]);
});

test("fails instead of silently sampling another section when a mapped section has no suitable sentence", () => {
  const manifest = { sections: [0, 1, 2].map(section) };
  assert.throws(() => sampleSentences({ intervals: [interval(0), { ...interval(1), end: 3 }, interval(2)] }, manifest), /section 1/);
  assert.throws(() => sampleSentences({ intervals: [interval(7)] }, manifest), /unknown section: 7/);
  assert.throws(() => sampleSentences({ intervals: [] }, manifest), /no intervals/);
});

test("with fewer than three mapped sections, the first, middle and last may repeat", () => {
  assert.deepEqual(sampleSentences({ intervals: [interval(0), interval(2)] }, { sections: [0, 1, 2].map(section) }).map((sample) => sample.section.index), [0, 2, 2]);
});

const work = { title: "Synthetic", chosenRecordingId: "rec-b", recordings: [{ recordingId: "rec-a", narrator: "A" }, { recordingId: "rec-b", narrator: "  B  " }], chosenEbookId: "ebook-b", ebooks: [{ id: "ebook-a", format: "epub", available: true, size: 1200 }, { id: "ebook-b", format: "epub", available: true, size: 1_200_000 }] };
const book = { workId: "work", recordingId: "rec-b" };
const job = { status: "partial", progress: 1, coverage: 0.95, unsyncedPassages: [{}, {}] };

test("page expectations follow the chosen pair, the 95% boundary, and the listing's count", () => {
  assert.deepEqual(pageExpectations(work, book, "ebook-b", job), { workId: "work", title: "Synthetic", recording: "B", edition: "EPUB · 1.2 MB", status: "Partly ready", mapped: "95%", unsyncedPassages: 2 });
  assert.equal(pageExpectations(work, book, "ebook-b", { ...job, coverage: 0.96 }).status, "Ready");
  assert.throws(() => pageExpectations(work, book, "ebook-a", job), /chosen pair/);
  assert.throws(() => pageExpectations(work, { ...book, recordingId: "rec-a" }, "ebook-b", job), /chosen pair/);
  assert.throws(() => pageExpectations(work, book, "ebook-b", { ...job, status: "processing" }), /finished usable/);
});
