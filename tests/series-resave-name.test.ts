// The series re-save at the switch compares names without a leading article (#721): Hardcover's "The Culture" is
// AudiobookDB's "Culture" (found on the owner's library in the deploy rehearsal, 19 Nov).
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DATA_DIR ??= (await import("./temp-dir.ts")).tempDir("series-resave-name");
const { seriesName } = await import("../server/series-resave.ts");

test("a series name compares without a leading article, case or accents", () => {
  assert.equal(seriesName("The Culture"), seriesName("Culture"));
  assert.equal(seriesName("Dungeon Crawler Carl"), seriesName("dungeon crawler carl"));
  assert.equal(seriesName("A Song of Ice and Fire"), seriesName("Song of Ice and Fire"));
  assert.notEqual(seriesName("Theory"), seriesName("ory"), "only a whole leading word is an article");
  assert.notEqual(seriesName("The Culture"), seriesName("Re-Educating the Culture"));
});
