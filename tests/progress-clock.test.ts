import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgressClock } from "../src/progress-clock.ts";

test("playback saves stay ordered after a clock rollback and reload", () => {
  const clock = createProgressClock();
  assert.equal(clock("recording", 1000), 1000);
  assert.equal(clock("recording", 500), 1001);
  assert.equal(clock("other", 500), 500);
  const reloaded = createProgressClock();
  assert.equal(reloaded("recording", 600, 1001), 1002);
  assert.equal(reloaded("recording", 2000, 1001), 2000);
});
