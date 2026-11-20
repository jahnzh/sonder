// Where a sentence is in a book, from the prepared manifest (src/prepared-book.ts) and from the sentences
// themselves (src/reader-places.ts): the new reading view and today's reader ask the same questions and must get
// the same answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareEpub } from "../server/prepared-text.ts";
import { preparedFixture } from "./prepared-text-fixture.ts";

// lib.ts, which prepared-book.ts takes its transport from, reads the browser's storage as it loads.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) },
  window: Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }),
});
const { sentenceIndex } = await import("../src/prepared-book.ts");
const { sentencePlaces } = await import("../src/reader-places.ts");

/** Sections as extractBook cuts them, from plain sentences per chapter: `<section>:<n>` ids in reading order. */
function sectionsOf(chapters: string[][], indexes: number[]) {
  return chapters.map((sentences, at) => {
    return {
      index: indexes[at]!,
      href: `c${at}.xhtml`,
      title: `Chapter ${at + 1}`,
      paragraphs: sentences.map((text, number) => ({ id: `${indexes[at]}:${number}`, text, blockIndex: number, start: 0, end: text.length })),
    };
  });
}

test("the manifest places every sentence where the sentences themselves do", async () => {
  // Chapters long enough for several parts, and a spine whose second file has no text (its index is skipped).
  const chapters = [0, 1, 2].map((chapter) => Array.from({ length: 900 }, (_unused, number) => `Chapter ${chapter} sentence ${number} is a sentence of some length to fill the parts of this book.`));
  const files: Record<string, string> = {
    "c0.xhtml": chapters[0]!.map((text) => `<p>${text}</p>`).join(""),
    "empty.xhtml": "<div></div>",
    "c1.xhtml": chapters[1]!.map((text) => `<p>${text}</p>`).join(""),
    "c2.xhtml": chapters[2]!.map((text) => `<p>${text}</p>`).join(""),
  };
  const sections = sectionsOf(chapters, [0, 2, 3]);
  const { manifest } = await prepareEpub({
    epub: await preparedFixture({ chapters: files }),
    book: { id: "ed", fingerprint: "f", language: "en", sections },
    base: "/api/reader/ed/prepared/0123456789abcdef",
    key: "0123456789abcdef",
    writePicture: async () => {},
  });
  assert.deepEqual(manifest.problems, []);
  assert.ok(manifest.parts.length > 2, `${manifest.parts.length} parts`);
  const index = sentenceIndex(manifest);
  const places = sentencePlaces(sections);
  assert.equal(index.total, places.total);
  assert.equal(index.total, 2700);
  for (let ordinal = 0; ordinal < places.total; ordinal++) {
    const id = places.idAt(ordinal)!;
    assert.equal(index.idAt(ordinal), id);
    assert.equal(index.ordinalOf(id), ordinal);
    assert.equal(index.sectionOf(id), places.sectionOf(id));
    const part = manifest.parts[index.partOf(id)]!;
    assert.ok(ordinal >= part.ordinal && ordinal < part.ordinal + part.sentences, id);
  }
  for (const section of sections) assert.deepEqual(index.sectionSpan(section.index), places.sectionSpan(section.index));
  assert.equal(index.progression("0:0"), 0);
  assert.equal(index.progression("3:899"), 1);
  // What the book does not have.
  for (const id of ["1:0", "9:0", "0:900", "x", ""]) {
    assert.equal(index.ordinalOf(id), -1, id);
    assert.equal(index.partOf(id), -1, id);
    assert.equal(places.ordinalOf(id), -1, id);
  }
  assert.equal(index.ordinalOf(undefined), -1);
  assert.equal(index.idAt(-1), undefined);
  assert.equal(index.idAt(2700), undefined);
  assert.equal(places.idAt(2700), undefined);
  assert.equal(index.sectionOf("x"), null);
  assert.deepEqual(index.sectionSpan(1), { start: 0, count: 0 });
  assert.deepEqual(places.sectionSpan(1), { start: 0, count: 0 });
});
