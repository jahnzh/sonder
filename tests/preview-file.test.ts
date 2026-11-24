// The file a preview of a release cached on TorBox plays (#889, A1): `previewFile` in server/preview-file.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { previewFile, PREVIEW_MIN_BYTES } from "../server/preview-file.ts";

const MB = 1024 * 1024;
const file = (id: number, name: string, size: number) => ({ id, name, size });

test("one large file is the one played", () => {
  assert.equal(previewFile([file(7, "Book/The Whole Book.m4b", 480 * MB)])?.id, 7);
});

test("numbered chapters with a short credits file first: the first chapter", () => {
  const files = [
    file(1, "Book/00 - Opening Credits.mp3", 1 * MB),
    file(2, "Book/01 - Chapter One.mp3", 40 * MB),
    file(3, "Book/02 - Chapter Two.mp3", 40 * MB),
  ];
  assert.equal(previewFile(files)?.id, 2);
});

test("a long credits, intro or foreword file is passed over by its name", () => {
  const files = [
    file(1, "Book/01 Credits.mp3", 20 * MB),
    file(2, "Book/02 Introduction.mp3", 20 * MB),
    file(3, "Book/03 Foreword.mp3", 20 * MB),
    file(4, "Book/04 Preface.mp3", 20 * MB),
    file(5, "Book/05 Chapter 1.mp3", 20 * MB),
    file(6, "Book/99 Epilogue.mp3", 20 * MB),
  ];
  assert.equal(previewFile(files)?.id, 5);
});

test("names that sort wrongly without numeric order: 2 comes before 10", () => {
  const files = [file(10, "Book/Part 10.mp3", 30 * MB), file(2, "Book/Part 2.mp3", 30 * MB), file(1, "Book/Part 1.mp3", 2 * MB)];
  // Part 1 is under 3 MB; by text order Part 10 would come before Part 2.
  assert.equal(previewFile(files)?.id, 2);
});

test("everything under 3 MB: the largest audio file", () => {
  const files = [file(1, "a/01.mp3", 1 * MB), file(2, "a/02.mp3", 2.5 * MB), file(3, "a/03.mp3", 2 * MB)];
  assert.equal(previewFile(files)?.id, 2);
  assert.ok(2.5 * MB < PREVIEW_MIN_BYTES);
});

test("only files named as not the reading: the largest", () => {
  const files = [file(1, "a/Intro.mp3", 10 * MB), file(2, "a/Outro.mp3", 12 * MB), file(3, "a/Sample.mp3", 4 * MB)];
  assert.equal(previewFile(files)?.id, 2);
});

test("non-audio files beside the audio are never chosen, however large or first", () => {
  const files = [
    file(1, "Book/00 cover.jpg", 50 * MB),
    file(2, "Book/01 info.nfo", 10 * MB),
    file(3, "Book/Book.pdf", 90 * MB),
    file(4, "Book/Chapter 01.M4A", 30 * MB),
  ];
  assert.equal(previewFile(files)?.id, 4);
});

test("no audio file at all: nothing to preview", () => {
  assert.equal(previewFile([file(1, "a/cover.jpg", 1 * MB), file(2, "a/readme.txt", 1)]), null);
  assert.equal(previewFile([]), null);
});

test("a folder named Sample does not exclude the files in it; a size TorBox does not give is not small", () => {
  assert.equal(previewFile([{ id: 1, name: "Sample Reader/Chapter 1.mp3" }])?.id, 1);
});

test("the names are whole words: Introvert is a reading, Sample Chapter and 01 - Intro.mp3 are not", () => {
  const reading = file(3, "Book/03 - The Introvert.mp3", 30 * MB);
  assert.equal(previewFile([file(1, "Book/01 - Intro.mp3", 30 * MB), file(2, "Book/02 - Sample Chapter.mp3", 30 * MB), reading])?.id, 3);
  assert.equal(previewFile([file(1, "Book/Introvert Diaries 01.mp3", 30 * MB)])?.id, 1, "Introvert alone is a reading");
  assert.equal(previewFile([file(1, "Book/Sample Chapter.mp3", 30 * MB), file(2, "Book/Chapter 1.mp3", 30 * MB)])?.id, 2);
  assert.equal(previewFile([file(1, "Book/01 - Intro.mp3", 30 * MB), file(2, "Book/02 - Chapter One.mp3", 30 * MB)])?.id, 2);
  assert.equal(previewFile([file(1, "Book/00_INTRODUCTION.mp3", 30 * MB), file(2, "Book/01_Chapter.mp3", 30 * MB)])?.id, 2, "case and underscores");
  assert.equal(previewFile([file(1, "Book/Outrovert Credits-free 01.mp3", 30 * MB), file(2, "Book/02.mp3", 30 * MB)])?.id, 2, "credits as a word");
});
