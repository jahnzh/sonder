// A recording's chapters on the Edit page (#719 part c), the client's pure steps: starts typed and shown, the draft
// checked, Shift all by seconds, Add a chapter; and the player taking a recording's edited chapters (the chapter list,
// Media Session's chapter title) without moving its place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addChapter, chaptersLine, chaptersOfDraft, draftOfChapters, formatStart, parseStart, shiftChapters } from "../src/chapter-edit.ts";
import { currentChapter, listeningChapters, sessionChapterTitle, withFreshChapters } from "../src/chapters.ts";
import type { Book, RecordingChapters } from "../src/types.ts";

test("starts are shown as h:mm:ss and typed as h:mm:ss, m:ss or seconds", () => {
  assert.equal(formatStart(0), "0:00:00");
  assert.equal(formatStart(3723), "1:02:03");
  assert.equal(formatStart(3723.25), "1:02:03.3");
  assert.equal(parseStart("1:02:03"), 3723);
  assert.equal(parseStart("62:03"), 3723);
  assert.equal(parseStart("3723"), 3723);
  assert.equal(parseStart("0:00:01.5"), 1.5);
  assert.equal(parseStart("1,5"), 1.5);
  for (const bad of ["", "abc", "1:60", "1:2:3:4", "-5"]) assert.equal(parseStart(bad), null, bad);
  assert.deepEqual(draftOfChapters([{ title: "A", start: 61 }]), [{ title: "A", start: "0:01:01" }]);
});

test("the draft is checked: a title for each, a start in the recording, no two at the same time; sorted", () => {
  assert.deepEqual(chaptersOfDraft([{ title: " B ", start: "0:10" }, { title: "A", start: "0" }], 100), { chapters: [{ title: "A", start: 0 }, { title: "B", start: 10 }] });
  assert.deepEqual(chaptersOfDraft([{ title: "", start: "0" }], 100), { problem: "Name chapter 1." });
  assert.deepEqual(chaptersOfDraft([{ title: "A", start: "soon" }], 100), { problem: '"A": type its start as h:mm:ss.' });
  assert.deepEqual(chaptersOfDraft([{ title: "A", start: "100" }], 100), { problem: '"A" starts after the recording ends.' });
  assert.deepEqual(chaptersOfDraft([{ title: "A", start: "5" }, { title: "B", start: "0:05" }], 100), { problem: '"A" and "B" start at the same time.' });
  // A length not known yet (0) does not limit the starts.
  assert.ok("chapters" in chaptersOfDraft([{ title: "A", start: "9:00:00" }], 0));
});

test("Shift all by seconds moves every chapter but one at the very start, either way", () => {
  const list = [{ title: "One", start: 0 }, { title: "Two", start: 100 }, { title: "Three", start: 200 }];
  assert.deepEqual(shiftChapters(list, 2.5, 300), { chapters: [{ title: "One", start: 0 }, { title: "Two", start: 102.5 }, { title: "Three", start: 202.5 }] });
  assert.deepEqual(shiftChapters(list, -1, 300), { chapters: [{ title: "One", start: 0 }, { title: "Two", start: 99 }, { title: "Three", start: 199 }] });
  // A first chapter that does not begin at 0 moves too.
  assert.deepEqual(shiftChapters([{ title: "Late", start: 10 }], -4, 300), { chapters: [{ title: "Late", start: 6 }] });
});

test("Shift is refused, with the reason, when a chapter would leave the recording or meet another", () => {
  const list = [{ title: "One", start: 0 }, { title: "Two", start: 100 }, { title: "Three", start: 200 }];
  assert.deepEqual(shiftChapters(list, 100, 300), { problem: '"Three" would start after the recording ends.' });
  assert.deepEqual(shiftChapters([{ title: "Late", start: 10 }], -11, 300), { problem: '"Late" would start before the recording begins.' });
  assert.deepEqual(shiftChapters(list, -100, 300), { problem: '"Two" would start with or before "One".' });
  assert.deepEqual(shiftChapters(list, 0, 300), { problem: "Type the seconds to shift by, such as 2 or -1.5." });
  assert.ok("problem" in shiftChapters(list, Number.NaN, 300));
  // Unknown length (0): no end to leave.
  assert.ok("chapters" in shiftChapters(list, 1000, 0));
});

test("Add a chapter goes after the last, halfway to the recording's end; the first starts at 0", () => {
  assert.deepEqual(addChapter([], -1, 600), [{ title: "Chapter 1", start: "0:00:00" }]);
  assert.deepEqual(addChapter([{ title: "A", start: "0:00:00" }], 0, 600), [{ title: "A", start: "0:00:00" }, { title: "Chapter 2", start: "0:05:00" }]);
  assert.deepEqual(addChapter([{ title: "A", start: "0" }, { title: "B", start: "0:10:00" }], 0, 1200)[1], { title: "Chapter 3", start: "0:05:00" });
});

test("the Chapters row says how many and where from", () => {
  const answer = (edited: boolean, from: "audiobookdb" | null) => ({ chapters: [{ title: "A", start: 0 }, { title: "B", start: 1 }], edited, from }) as unknown as RecordingChapters;
  assert.equal(chaptersLine(answer(false, null)), "2 chapters · From the files");
  assert.equal(chaptersLine(answer(true, null)), "2 chapters · Edited");
  assert.equal(chaptersLine(answer(true, "audiobookdb")), "2 chapters · From AudiobookDB");
});

const track = (id: string, chapters: { title: string; start: number; end?: number }[]) => ({ id, recordingId: "r", title: `File ${id}`, index: 0, duration: 100, source: "", sourceType: "local" as const, chapters });
const playing = { recordingId: "r", tracks: [track("a", [{ title: "Old", start: 0, end: 100 }]), track("b", [])] } as unknown as Book;

test("the book playing takes the recording's edited chapters; nothing else of it changes", () => {
  const fresh = { recordingId: "r", tracks: [track("a", [{ title: "New", start: 0, end: 40 }, { title: "Newer", start: 40, end: 100 }]), track("b", [{ title: "Newer", start: 0, end: 100 }])] } as unknown as Book;
  const taken = withFreshChapters(playing, fresh);
  assert.notEqual(taken, playing);
  assert.deepEqual(listeningChapters(taken).map((chapter) => [chapter.track.id, chapter.title, chapter.start]), [["a", "New", 0], ["a", "Newer", 40], ["b", "Newer", 0]]);
  assert.equal(currentChapter(taken, "a", 50)?.title, "Newer");
  // The same chapters, another recording, or other files: the book as it was.
  assert.equal(withFreshChapters(playing, playing), playing);
  assert.equal(withFreshChapters(playing, { ...fresh, recordingId: "other" }), playing);
  assert.equal(withFreshChapters(playing, { ...fresh, tracks: [fresh.tracks[0]] }), playing);
  assert.equal(withFreshChapters(playing, undefined), playing);
});

test("Media Session names the chapter playing, or the file when it has no chapters", () => {
  const book = { tracks: [track("a", [{ title: "One", start: 0, end: 40 }, { title: "Two", start: 40, end: 100 }]), track("b", [])] } as unknown as Book;
  assert.equal(sessionChapterTitle(book, book.tracks[0], 10), "One");
  assert.equal(sessionChapterTitle(book, book.tracks[0], 45), "Two");
  assert.equal(sessionChapterTitle(book, book.tracks[1], 5), "File b");
});
