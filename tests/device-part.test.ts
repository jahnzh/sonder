/**
 * Activity's This device as a function (#518, spec #513 "This device"): which rows Saving now and Kept on this device
 * hold for a state of the device, what each line says, what Remove would delete, and the storage lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceSaveEntries, type DeviceSaveInput, type DeviceSaveRecord } from "../src/device-saves.ts";
import { buildDevicePart, protectedLine, usedLine, usedShare } from "../src/device-part.ts";
import { deviceKeptLine } from "../src/status-lines.ts";

const MB = 1e6;
const audioBook = (id: string, workId: string, recordingId: string, files: number) => ({
  id, workId, recordingId, title: `Title ${id}`, cover: `/covers/${id}.jpg`,
  tracks: Array.from({ length: files }, (_, i) => ({ id: `${recordingId}-${i}` })),
});
const files = (recordingId: string, count: number, size = 10 * MB, completedAt = 1_000) =>
  Array.from({ length: count }, (_, i) => ({ trackId: `${recordingId}-${i}`, recordingId, size, completedAt }));
const record = (recordingId: string, workId: string, over: Partial<DeviceSaveRecord>): DeviceSaveRecord =>
  ({ recordingId, workId, startedAt: 500, state: "saving", reason: null, finishedAt: null, ...over });

function part(over: Partial<DeviceSaveInput>, online = true, ebookTitles: { id: string; workId: string; title: string }[] = []) {
  const input: DeviceSaveInput = { books: [], downloads: [], downloadParts: [], running: {}, records: [], ebooks: [], ...over };
  const books = input.books as ReturnType<typeof audioBook>[];
  return buildDevicePart({ entries: deviceSaveEntries(input), books, ebooks: ebookTitles, online });
}

test("a running save is in Saving now with its line and bar, and not in Kept", () => {
  const shown = part({
    books: [audioBook("matter", "w-matter", "r1", 12)],
    downloads: files("r1", 3),
    downloadParts: [{ trackId: "r1-3", recordingId: "r1", loaded: 5 * MB, total: 10 * MB }],
    running: { r1: { chapter: 4, loaded: 5 * MB, size: 10 * MB } },
    records: [record("r1", "w-matter", { state: "saving" })],
  });
  assert.equal(shown.kept.length, 0);
  assert.deepEqual(shown.saving, [{
    workId: "w-matter", title: "Title matter", cover: "/covers/matter.jpg", bookId: "matter", recordingId: "r1", keep: false,
    status: "Saving · 3 of 12 files", progress: 3.5 / 12,
  }]);
  assert.equal(shown.used, 35 * MB);
});

test("Kept: what is kept and its size, one row per work, with what Remove deletes", () => {
  const shown = part({
    books: [audioBook("anti", "w-anti", "r1", 2), audioBook("weapons", "w-weapons", "r2", 3)],
    downloads: [...files("r1", 2, 200 * MB, 2_000), ...files("r2", 3, 234 * MB, 1_000)],
    records: [record("r1", "w-anti", { state: "finished", finishedAt: 2_000 }), record("r2", "w-weapons", { state: "finished", finishedAt: 1_000 })],
    ebooks: [{ id: "e1", workId: "w-anti", size: 14 * MB }, { id: "e2", workId: "w-frank", size: 0.6 * MB }],
  }, true, [{ id: "e2", workId: "w-frank", title: "Frankenstein" }]);
  assert.equal(shown.saving.length, 0);
  assert.deepEqual(shown.kept.map((row) => [row.title, row.status, row.notComplete, row.bookId]), [
    ["Title anti", "Audiobook and ebook · 414 MB", false, "anti"],
    ["Title weapons", "Audiobook · 702 MB", false, "weapons"],
    // An ebook alone: its title from the saved ebook, and no book to open. The app's size format writes 0.6 MB as 600 KB.
    ["Frankenstein", "Ebook · 600 KB", false, null],
  ]);
  assert.deepEqual(shown.kept[0].recordingIds, ["r1"]);
  assert.deepEqual(shown.kept[0].ebookIds, ["e1"]);
  assert.equal(shown.kept[0].size, 414 * MB);
  assert.deepEqual(shown.kept[2].recordingIds, []);
  assert.deepEqual(shown.kept[2].ebookIds, ["e2"]);
  assert.equal(shown.used, (414 + 702 + 0.6) * MB);
});

test("a work with two recordings on this device: one row, its size counts both, Remove deletes both", () => {
  const first = audioBook("b1", "w", "r1", 2);
  const second = audioBook("b2", "w", "r2", 2);
  const shown = part({
    books: [first, second],
    downloads: [...files("r1", 2, 100 * MB, 1_000), ...files("r2", 2, 50 * MB, 3_000)],
    records: [record("r2", "w", { state: "finished", finishedAt: 3_000, startedAt: 2_500 })],
  });
  assert.equal(shown.kept.length, 1);
  assert.equal(shown.kept[0].status, "Audiobook · 300 MB");
  assert.deepEqual([...shown.kept[0].recordingIds].sort(), ["r1", "r2"]);
});

test("an unfinished save is a Kept row with Not complete and the audiobook's mark, before complete ones", () => {
  const shown = part({
    books: [audioBook("anti", "w-anti", "r1", 2), audioBook("matter", "w-matter", "r2", 12)],
    downloads: [...files("r1", 2, 100 * MB, 9_000), ...files("r2", 3, 10 * MB, 1_000)],
    records: [record("r1", "w-anti", { state: "finished", finishedAt: 9_000 }), record("r2", "w-matter", { state: "paused", startedAt: 800 })],
  });
  assert.deepEqual(shown.kept.map((row) => [row.title, row.status, row.notComplete]), [
    ["Title matter", "Not complete · 3 of 12 files", true],
    ["Title anti", "Audiobook · 200 MB", false],
  ]);
});

test("no connection: a running save waits as the first Kept row with Not complete and no bar; Saving now is empty", () => {
  const shown = part({
    books: [audioBook("anti", "w-anti", "r1", 2), audioBook("matter", "w-matter", "r2", 12)],
    downloads: [...files("r1", 2, 100 * MB, 9_000), ...files("r2", 3, 10 * MB, 1_000)],
    running: { r2: { chapter: 4, loaded: 0, size: 0 } },
    records: [record("r1", "w-anti", { state: "finished", finishedAt: 9_000 }), record("r2", "w-matter", { state: "saving", startedAt: 800 })],
  }, false);
  assert.equal(shown.saving.length, 0);
  assert.equal(shown.kept[0].title, "Title matter");
  assert.equal(shown.kept[0].status, "Not complete · 3 of 12 files");
  assert.equal(shown.kept[0].notComplete, true);
  assert.equal("progress" in shown.kept[0], false);
});

test("no connection: a save that runs before its first section is counted still waits in Kept", () => {
  const shown = part({
    books: [audioBook("matter", "w-matter", "r1", 2)],
    running: { r1: { chapter: 1, loaded: 0, size: 0 } },
    records: [record("r1", "w-matter", { state: "saving" })],
  }, false);
  assert.deepEqual(shown.kept.map((row) => [row.title, row.status, row.notComplete]), [["Title matter", "Not complete · 0 of 2 files", true]]);
  assert.deepEqual(shown.kept[0].recordingIds, ["r1"]);
});

test("a failed save that wrote nothing is not kept: nothing of it is on this device", () => {
  const shown = part({
    books: [audioBook("matter", "w-matter", "r1", 12)],
    records: [record("r1", "w-matter", { state: "failed", reason: "The source did not return an audio file." })],
  });
  assert.deepEqual(shown, { saving: [], kept: [], used: 0, fullNote: null });
});

test("empty: nothing saved, nothing used", () => {
  assert.deepEqual(part({}), { saving: [], kept: [], used: 0, fullNote: null });
});

test("the kept line: every form of the spec, and none for a work with nothing here", () => {
  assert.equal(deviceKeptLine({ audio: "complete", filesTotal: 12, filesSaved: 12, ebook: true, size: 414e6 }), "Audiobook and ebook · 414 MB");
  assert.equal(deviceKeptLine({ audio: "complete", filesTotal: 12, filesSaved: 12, ebook: false, size: 702e6 }), "Audiobook · 702 MB");
  assert.equal(deviceKeptLine({ audio: "none", filesTotal: 0, filesSaved: 0, ebook: true, size: 1.6e6 }), "Ebook · 1.6 MB");
  assert.equal(deviceKeptLine({ audio: "partial", filesTotal: 12, filesSaved: 3, ebook: true, size: 30e6 }), "Not complete · 3 of 12 files");
  assert.equal(deviceKeptLine({ audio: "none", filesTotal: 0, filesSaved: 0, ebook: false, size: 0 }), null);
});

test("storage: used out of what the browser allows, the bar's share, and protection", () => {
  assert.equal(usedLine(2.1e9, 12e9), "2.1 GB of 12 GB");
  assert.equal(usedLine(1.9e9, 40e9), "1.9 GB of 40 GB");
  assert.equal(usedLine(414e6, null), "414 MB");
  assert.equal(usedShare(3e9, 12e9), 0.25);
  assert.equal(usedShare(3e9, 0), 0);
  assert.equal(usedShare(20e9, 12e9), 1);
  assert.equal(protectedLine({ persisted: true, refused: false }), "On");
  assert.equal(protectedLine({ persisted: false, refused: false }), "Off");
  assert.equal(protectedLine({ persisted: false, refused: true }), "Off · Refused by the browser");
});

test("a kept book with its prepared text and no EPUB file (#806) is listed as audiobook and ebook, under its recording", () => {
  const needs = (textDone: boolean) => ({
    recordingId: "r1", tracks: [{ id: "r1-0" }, { id: "r1-1" }], ebook: null,
    text: { id: "e1", complete: textDone, size: 50_000, counted: true },
    filesTotal: 3, filesSaved: textDone ? 3 : 2, size: 20 * MB + (textDone ? 50_000 : 0), sections: 0, complete: textDone,
  });
  const shown = part({ books: [audioBook("b1", "w1", "r1", 2)], downloads: files("r1", 2), kept: [{ workId: "w1", needs: needs(true) }] });
  assert.equal(shown.kept[0]?.status, deviceKeptLine({ audio: "complete", filesTotal: 3, filesSaved: 3, ebook: true, size: 20 * MB + 50_000 }));
  assert.match(shown.kept[0]!.status, /^Audiobook and ebook/);
  const before = part({ books: [audioBook("b1", "w1", "r1", 2)], downloads: files("r1", 2), kept: [{ workId: "w1", needs: needs(false) }] });
  assert.match(before.kept[0]!.status, /^Not complete · 2 of 3 files/);
  // A book with only an ebook is saved under its text's edition.
  const only = deviceSaveEntries({ books: [], downloads: [], downloadParts: [], running: {}, records: [], kept: [{ workId: "w2", needs: { ...needs(true), recordingId: null, tracks: [], filesTotal: 1, filesSaved: 1, size: 50_000 } }] });
  assert.equal(only[0]?.saveId, "ebook:e1");
});
