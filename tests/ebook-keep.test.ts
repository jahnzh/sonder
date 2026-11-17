import test from "node:test";
import assert from "node:assert/strict";
import { isKeptReaderFile, writesAsCache } from "../src/ebook-keep";

// #671: the reader's own copy of an EPUB is a reading cache, not kept; only an explicit save keeps an edition.

test("a reading cache is not kept; an explicit save and a record from before #671 are", () => {
  assert.equal(isKeptReaderFile({ fingerprint: "a", opfs: true, cache: true }), false);
  assert.equal(isKeptReaderFile({ fingerprint: "a", opfs: true }), true);
  // An older build wrote the same record for both; it stays kept, so nothing the user saved disappears.
  assert.equal(isKeptReaderFile({ fingerprint: "a", blob: new Blob(["epub"]) }), true);
  assert.equal(isKeptReaderFile(undefined), false);
  assert.equal(isKeptReaderFile(null), false);
});

test("the reader's own copy is written as a cache when nothing is kept", () => {
  assert.equal(writesAsCache(undefined, { cache: true }), true);
  assert.equal(writesAsCache({ fingerprint: "old", opfs: true, cache: true }, { cache: true }), true);
});

test("the reader's own copy never turns a kept edition back into a cache", () => {
  assert.equal(writesAsCache({ fingerprint: "old", opfs: true }, { cache: true }), false);
});

test("an explicit save keeps the edition, over a cache or nothing", () => {
  assert.equal(writesAsCache(undefined, { cache: false }), false);
  assert.equal(writesAsCache({ fingerprint: "a", opfs: true, cache: true }, { cache: false }), false);
});
