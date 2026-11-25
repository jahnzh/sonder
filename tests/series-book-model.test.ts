// A book's search sheet on the Series page (#898): src/pages/series-book-model.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseLine, searchSteering, seriesBookModel, whyLine, type SeriesCandidate, type SeriesWorkSearch } from "../src/pages/series-book-model.ts";
import type { SeriesWorkAcquisition } from "../src/types.ts";

const candidate = (key: string, parts: Partial<SeriesCandidate> = {}): SeriesCandidate => ({
  key, source: "abb", id: key, title: `First volume ${key}`, size: "400 MB", format: "M4B", narrator: "Reader", language: "English",
  url: `https://abb.test/abss/${key}/`, indexer: null, seeders: null, cached: false, kind: "plain", reasons: ["one-book"], ...parts,
});
const state = (parts: Partial<SeriesWorkAcquisition> = {}): SeriesWorkAcquisition =>
  ({ kind: "audio", status: "done", error: null, skipReason: null, ...parts }) as SeriesWorkAcquisition;
const search = (parts: Partial<SeriesWorkSearch> = {}): SeriesWorkSearch => ({
  bookId: "bk-1", workId: "w-1", title: "First volume", audio: state(), ebook: null, choice: null, hasAudio: false, mediaState: null, ...parts,
});

test("the chosen release with what it is, why it was chosen and its page; the others as the Get sheet's rows", () => {
  const french = candidate("aaa", { title: "Premier tome", language: "French", narrator: "Lecteur", cached: true, reasons: ["one-book", "torbox"] });
  const english = candidate("bbb", { seeders: 12 });
  const set = candidate("abb:set", { title: "Books 1-3", kind: "compilation", reasons: ["compilation"] });
  const model = seriesBookModel(search({ choice: { at: 1, chosen: "aaa", by: "queue", candidates: [french, english, set] } }));
  assert.deepEqual(model.audio?.chosen, {
    key: "aaa",
    first: "Premier tome",
    second: "French · Lecteur · M4B · 400 MB",
    why: "Chosen by the queue · one book, not a set · TorBox has it",
    link: { text: "On AudioBookBay", href: "https://abb.test/abss/aaa/" },
  });
  assert.equal(model.audio?.caption, "Other recordings found · 2");
  assert.deepEqual(model.audio?.others.map((row) => [row.id, row.first, row.second, row.edge?.text ?? null]), [
    ["bbb", "First volume bbb", "English · Reader · M4B · 400 MB", "12 seeders"],
    ["abb:set", "Books 1-3", "English · Reader · M4B · 400 MB", null],
  ]);
  // Its download was asked for: no Skip; Search again finds the releases again.
  assert.deepEqual(model.audio?.steering, { now: false, again: true, skip: false });
  assert.equal(model.audio?.line, null);
  assert.equal(whyLine(english, "owner"), "Chosen by you");
});

test("found but none chosen, nothing found, and each search's steering", () => {
  const set = candidate("abb:set", { kind: "compilation", reasons: ["compilation"] });
  const left = seriesBookModel(search({ choice: { at: 1, chosen: null, by: "queue", candidates: [set] } }));
  assert.equal(left.audio?.line, "1 found · choose one");
  assert.equal(left.audio?.chosen, null);
  assert.equal(left.audio?.caption, "Recordings found · 1");
  assert.deepEqual(left.audio?.steering, { now: false, again: true, skip: true });
  assert.equal(seriesBookModel(search()).audio?.line, "Nothing found");
  assert.equal(seriesBookModel(search({ audio: state({ status: "pending", place: 2 }) })).audio?.line, "Waiting · 2nd in line");

  assert.deepEqual(searchSteering(state({ status: "pending" }), false), { now: true, again: false, skip: true });
  assert.deepEqual(searchSteering(state({ status: "searching" }), false), { now: false, again: false, skip: false });
  assert.deepEqual(searchSteering(state({ status: "failed", error: "No release found" }), false), { now: false, again: true, skip: true });
  assert.deepEqual(searchSteering(state({ status: "skipped", skipReason: "owner" }), false), { now: true, again: false, skip: false });
  assert.deepEqual(searchSteering(state({ status: "skipped", skipReason: "stopped" }), false), { now: true, again: false, skip: false });
  assert.deepEqual(searchSteering(state({ status: "skipped", skipReason: "has_audio" }), true), { now: false, again: true, skip: false });
  assert.deepEqual(searchSteering(state({ status: "skipped", skipReason: "no_permission" }), false), { now: false, again: false, skip: false });
  const ebook = seriesBookModel(search({ ebook: { kind: "ebook", status: "failed", error: "Library Genesis could not be reached. Try again.", skipReason: null } }));
  assert.equal(ebook.ebook?.line, "Ebook search failed · Library Genesis could not be reached");
});

test("the line under Choose this one instead", () => {
  const cachedOne = candidate("aaa", { cached: true });
  const other = candidate("bbb");
  assert.equal(chooseLine(cachedOne, { mediaState: null, hasAudio: false })?.text, "Plays from TorBox right away.");
  assert.equal(chooseLine(other, { mediaState: null, hasAudio: false })?.text, "Downloads to your server first.");
  const onItsWay = { state: "queued" as const, holdReason: null, acquisition: { id: "a", status: "downloading", progress: 0.4, error: null } };
  const replacing = chooseLine(other, { mediaState: onItsWay, hasAudio: false });
  assert.equal(replacing?.text, "Replaces the download on its way (Downloading to server · 40%).");
  assert.equal(replacing?.replaceActive, true);
  assert.equal(chooseLine(other, { mediaState: null, hasAudio: true })?.text, "Adds this recording to the book. Downloads to your server first.");
  assert.equal(chooseLine(null, { mediaState: null, hasAudio: false }), null);
});
