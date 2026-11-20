// The hidden switch of the reading view (src/reader-view-switch.ts, #802): what the address asks for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readerViewFromSearch, withoutReaderView } from "../src/reader-view-switch.ts";

test("the address parameter names one of the two views, and anything else names none", () => {
  assert.equal(readerViewFromSearch("?reader-view=prepared"), "prepared");
  assert.equal(readerViewFromSearch("?a=1&reader-view=epub"), "epub");
  for (const search of ["", "?", "?reader-view", "?reader-view=", "?reader-view=PREPARED", "?reader-view=other", "?view=prepared"])
    assert.equal(readerViewFromSearch(search), null, search);
});

test("the parameter leaves the address and everything else stays", () => {
  assert.equal(withoutReaderView({ pathname: "/", search: "?reader-view=prepared", hash: "#read/work-1" }), "/#read/work-1");
  assert.equal(withoutReaderView({ pathname: "/", search: "?a=1&reader-view=epub&b=2", hash: "" }), "/?a=1&b=2");
  assert.equal(withoutReaderView({ pathname: "/app", search: "", hash: "#library" }), "/app#library");
});
