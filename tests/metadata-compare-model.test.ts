// The comparison's pure steps on the client (#719 part b): the default ticks are the server's ('Fill only what's
// missing'), Take all ticks every row the provider gives a different value for, a toggle keeps the fields' order, and
// Apply sends the ticked rows; the lines after Apply and after a series' Match all automatically.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MetadataComparison } from "../src/types.ts";
import { allTicks, appliedLine, applyBody, defaultTicks, seriesMatchLine, toggled, valueText } from "../src/pages/metadata-compare-model.ts";

const row = (current: unknown, found: unknown, ticked: boolean, same = false) => ({ current, found, ticked, same });
const comparison: MetadataComparison = {
  workId: "w",
  provider: "audiobookdb",
  id: "bk",
  title: "Leviathan Wakes",
  fields: {
    title: row("Leviathan Wakes (Unabridged)", "Leviathan Wakes", false),
    subtitle: row("", null, false),
    authors: row(["A"], ["A"], false, true),
    series: row([], [{ id: "sr", name: "The Expanse", position: 1, positionLabel: "1", local: false }], true),
    genres: row([], null, false),
    publisher: row("", "Orbit", true),
    year: row(2011, 2011, false, true),
    language: row("", "English", true),
    isbn: row("", null, false),
    asin: row("", "B004GJ4ZPU", true),
    description: row("Own", "Theirs", false),
    cover: row("/covers/meditations.svg", "https://x/c.jpg", true),
  },
  recordings: [{ recordingId: "r1", label: "Test", current: [], found: ["Jefferson Mays"], ticked: true, same: false }],
};

test("the default ticks are the missing fields; Take all adds the differing ones; same or not given never", () => {
  assert.deepEqual(defaultTicks(comparison), { fields: ["series", "publisher", "language", "asin", "cover"], narrators: ["r1"] });
  assert.deepEqual(allTicks(comparison), { fields: ["title", "series", "publisher", "language", "asin", "description", "cover"], narrators: ["r1"] });
  const ticks = toggled(toggled(defaultTicks(comparison), "field", "title", true), "narrators", "r1", false);
  assert.deepEqual(ticks, { fields: ["title", "series", "publisher", "language", "asin", "cover"], narrators: [] });
  assert.deepEqual(applyBody(comparison, ticks), { provider: "audiobookdb", id: "bk", fields: ticks.fields, narrators: [] });
});

test("the lines: values, Apply's outcome, the series' count", () => {
  assert.equal(valueText("series", comparison.fields.series.found), "The Expanse · Book 1");
  assert.equal(valueText("genres", null, true), "Not given");
  assert.equal(valueText("publisher", ""), "Not set");
  assert.deepEqual(appliedLine({ outcome: "applied", provider: "googlebooks", fields: ["isbn", "publisher"], reason: null, metadata: null }), { text: "2 fields from Google Books", failed: false });
  assert.deepEqual(appliedLine({ outcome: "unsure", provider: null, fields: [], reason: "Several books fit · 2", metadata: null }), { text: "No sure match · Several books fit · 2", failed: false });
  assert.equal(appliedLine({ outcome: "failed", provider: "audiobookdb", fields: [], reason: "AudiobookDB is not answering.", metadata: null }).failed, true);
  assert.equal(seriesMatchLine({ total: 3, waiting: 1, done: 2, unsure: 0, failed: 0 }), "Matching · 2 of 3");
  assert.equal(seriesMatchLine({ total: 3, waiting: 0, done: 1, unsure: 1, failed: 1 }), "1 matched · 1 not sure · 1 failed");
});
