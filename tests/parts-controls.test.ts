import { test } from "node:test";
import assert from "node:assert/strict";
import { atMax, atMin, clampStep, stepValue, valueForKey } from "../src/parts/stepper-value.ts";
import { segmentForKey } from "../src/parts/segment-keys.ts";

// The logic behind the Stepper and the Segmented control (#489; spec #480, "Parts"). What a press or a key does to
// the value or the chosen segment; the browser spec tests/e2e/gallery-controls.spec.ts drives the same through the
// rendered parts.

const speed = { min: 0.5, max: 3, step: 0.1 };

test("a stepper moves by whole steps, rounded to the step, without drifting", () => {
  assert.equal(stepValue(1.2, 1, speed), 1.3);
  assert.equal(stepValue(1.2, -1, speed), 1.1);
  let value = 0.5;
  for (let i = 0; i < 25; i++) value = stepValue(value, 1, speed);
  assert.equal(value, 3);
  assert.equal(stepValue(10, -1, { min: 0, max: 60, step: 5 }), 5);
});

test("a stepper holds at its ends and says when it is at one", () => {
  assert.equal(stepValue(3, 1, speed), 3);
  assert.equal(stepValue(0.5, -1, speed), 0.5);
  assert.equal(stepValue(2.95, 1, speed), 3);
  assert.equal(clampStep(7, speed), 3);
  assert.equal(clampStep(-1, speed), 0.5);
  assert.equal(atMin(0.5, speed), true);
  assert.equal(atMin(0.6, speed), false);
  assert.equal(atMax(3, speed), true);
  assert.equal(atMax(2.9, speed), false);
});

test("a stepper's keys: arrows one step, page keys ten, Home and End the ends, others nothing", () => {
  assert.equal(valueForKey("ArrowUp", 1.2, speed), 1.3);
  assert.equal(valueForKey("ArrowDown", 1.2, speed), 1.1);
  assert.equal(valueForKey("PageUp", 1.2, speed), 2.2);
  assert.equal(valueForKey("PageDown", 1.2, speed), 0.5);
  assert.equal(valueForKey("PageUp", 2.5, speed), 3);
  assert.equal(valueForKey("Home", 1.2, speed), 0.5);
  assert.equal(valueForKey("End", 1.2, speed), 3);
  assert.equal(valueForKey("ArrowUp", 3, speed), 3);
  assert.equal(valueForKey("ArrowDown", 0.5, speed), 0.5);
  for (const key of ["Enter", " ", "Tab", "a", "ArrowLeft", "ArrowRight"]) assert.equal(valueForKey(key, 1.2, speed), null, key);
});

test("a segmented control's arrows move to the next and previous segment and wrap at the ends", () => {
  const all = [true, true, true];
  assert.equal(segmentForKey("ArrowRight", 0, all), 1);
  assert.equal(segmentForKey("ArrowDown", 1, all), 2);
  assert.equal(segmentForKey("ArrowRight", 2, all), 0);
  assert.equal(segmentForKey("ArrowLeft", 0, all), 2);
  assert.equal(segmentForKey("ArrowUp", 2, all), 1);
  assert.equal(segmentForKey("Home", 2, all), 0);
  assert.equal(segmentForKey("End", 0, all), 2);
  for (const key of ["Enter", " ", "Tab", "a", "PageUp"]) assert.equal(segmentForKey(key, 1, all), null, key);
});

test("a segmented control passes over a disabled segment, and does nothing when all are", () => {
  const middleOff = [true, false, true];
  assert.equal(segmentForKey("ArrowRight", 0, middleOff), 2);
  assert.equal(segmentForKey("ArrowLeft", 2, middleOff), 0);
  assert.equal(segmentForKey("Home", 2, [false, true, true]), 1);
  assert.equal(segmentForKey("End", 0, [true, true, false]), 1);
  assert.equal(segmentForKey("ArrowRight", 0, [false, false]), null);
});
