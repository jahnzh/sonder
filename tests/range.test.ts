import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../server/range.ts";
test("byte ranges handle bounded, open, suffix, and unsatisfiable requests", () => {
  assert.deepEqual(parseRange("bytes=0-0", 100), { start: 0, end: 0 });
  assert.deepEqual(parseRange("bytes=10-", 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=20-200", 100), { start: 20, end: 99 });
  assert.deepEqual(parseRange("bytes=-200", 100), { start: 0, end: 99 });
  for (const header of [
    "bytes=100-",
    "bytes=50-20",
    "bytes=-0",
    "bytes=",
    "bytes=0-2,6-9",
    "items=0-2",
    "bytes=999999999999999999999-",
  ])
    assert.equal(parseRange(header, 100), "invalid", header);
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange("bytes=0-", 0), "invalid");
});
