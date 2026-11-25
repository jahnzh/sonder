// The pages of AudiobookDB's own site (#902).
import { test } from "node:test";
import assert from "node:assert/strict";
import { audiobookDbPageUrl } from "../server/audiobookdb.ts";

test("a book, a series and a release each have their own page on AudiobookDB", () => {
  assert.equal(audiobookDbPageUrl("book", "967YEWWzRTUN"), "https://audiobookdb.org/books/967YEWWzRTUN");
  assert.equal(audiobookDbPageUrl("series", "sr-1"), "https://audiobookdb.org/series/sr-1");
  assert.equal(audiobookDbPageUrl("release", "rl-1"), "https://audiobookdb.org/releases/rl-1");
  assert.equal(audiobookDbPageUrl("book", "a/b c"), "https://audiobookdb.org/books/a%2Fb%20c");
});
