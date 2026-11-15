// The series view offers an audio retry from the media state (issue #395, ADR 0011).
// A hold is returned as stored while the work is playable, so it must not offer a retry then.
import { test } from "node:test";
import assert from "node:assert/strict";
import { workMediaStateOffersRetry, workMediaStateLabel } from "../src/work-media-state.ts";

test("an empty-search hold offers a retry only while the work has no audio", () => {
  for (const state of ["missing", "queued"] as const)
    assert.equal(workMediaStateOffersRetry({ state, holdReason: "empty_search" }), true, state);
  assert.equal(workMediaStateOffersRetry({ state: "available", holdReason: "empty_search" }), false);
  assert.equal(workMediaStateLabel({ state: "available", holdReason: "empty_search" }), "Available");
});

test("a failed acquisition offers a retry; an unreleased hold or no state does not", () => {
  assert.equal(workMediaStateOffersRetry({ state: "failed", holdReason: null }), true);
  assert.equal(workMediaStateOffersRetry({ state: "missing", holdReason: "unreleased" }), false);
  assert.equal(workMediaStateOffersRetry({ state: "available", holdReason: "unreleased" }), false);
  assert.equal(workMediaStateOffersRetry({ state: "missing", holdReason: null }), false);
  assert.equal(workMediaStateOffersRetry(null), false);
});
