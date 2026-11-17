import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSleep, SLEEP_CHOICES, SLEEP_MAX, SLEEP_OFF, sleepFromStepper, sleepShown, sleepStep } from "../src/sleep-stepper";
// The sleep timer's stepper in the reader's foot (#589): Off, 5, 15, 30, 45, 60 minutes; a running timer shows its
// minutes left rounded up, and − and + step to the neighbouring choice from there.

test("the choices are today's: Off, 5, 15, 30, 45 and 60 minutes", () => {
  assert.deepEqual([...SLEEP_CHOICES], [5, 15, 30, 45, 60]);
  assert.equal(SLEEP_OFF, 0);
  assert.equal(SLEEP_MAX, 60);
  assert.equal(formatSleep(0), "Off");
  assert.equal(formatSleep(14), "14 min");
});

test("from Off + goes to 5 and − stays Off", () => {
  assert.equal(sleepShown(null), SLEEP_OFF);
  assert.equal(sleepStep(SLEEP_OFF, 1), 5);
  assert.equal(sleepStep(SLEEP_OFF, -1), null);
});

test("from each step + goes to the next and − to the one before, down to Off", () => {
  const ladder = [null, 5, 15, 30, 45, 60];
  for (let index = 1; index < ladder.length; index++) {
    const shown = ladder[index]!;
    assert.equal(sleepStep(shown, -1), ladder[index - 1], `− from ${shown}`);
    assert.equal(sleepStep(shown, 1), ladder[Math.min(index + 1, ladder.length - 1)], `+ from ${shown}`);
  }
});

test("a running timer shows its time left in whole minutes, rounded up", () => {
  assert.equal(sleepShown(15 * 60), 15);
  assert.equal(sleepShown(15 * 60 - 1), 15);
  assert.equal(sleepShown(14 * 60), 14);
  assert.equal(sleepShown(14 * 60 + 1), 15);
  assert.equal(sleepShown(61), 2);
  assert.equal(sleepShown(60), 1);
  assert.equal(sleepShown(1), 1);
  assert.equal(sleepShown(0), SLEEP_OFF);
  assert.equal(sleepShown(-3), SLEEP_OFF);
  assert.equal(sleepShown(Number.NaN), SLEEP_OFF);
});

test("− and + from a running value step to the neighbouring choice", () => {
  // 14 minutes left of a 15-minute timer.
  assert.equal(sleepStep(sleepShown(14 * 60 - 20), -1), 5);
  assert.equal(sleepStep(sleepShown(14 * 60 - 20), 1), 15);
  // Between 30 and 45.
  assert.equal(sleepStep(31, -1), 30);
  assert.equal(sleepStep(31, 1), 45);
  // Under five minutes: − is Off, + is 5.
  assert.equal(sleepStep(sleepShown(30), -1), null);
  assert.equal(sleepStep(sleepShown(30), 1), 5);
  assert.equal(sleepStep(4, 1), 5);
  // Just under the top: + is 60, − is 45.
  assert.equal(sleepStep(sleepShown(59 * 60 + 1), 1), 60);
  assert.equal(sleepStep(59, -1), 45);
});

test("the ends: Off and 60 hold, and the stepper's Home and End reach them", () => {
  assert.equal(sleepStep(SLEEP_MAX, 1), SLEEP_MAX);
  assert.equal(sleepStep(SLEEP_OFF, -1), null);
  assert.equal(sleepShown(90 * 60), SLEEP_MAX);
  // The Stepper part counts whole minutes from Off to 60: Home asks for 0, End for 60.
  assert.equal(sleepFromStepper(14, SLEEP_OFF), null);
  assert.equal(sleepFromStepper(14, SLEEP_MAX), SLEEP_MAX);
  assert.equal(sleepFromStepper(SLEEP_OFF, SLEEP_MAX), SLEEP_MAX);
  // Nothing asked, nothing changed.
  assert.equal(sleepFromStepper(14, 14), undefined);
});

test("the Stepper part's buttons, arrow keys and page keys step one neighbouring choice", () => {
  // − and + and the arrow keys ask for one minute down or up.
  assert.equal(sleepFromStepper(SLEEP_OFF, 1), 5);
  assert.equal(sleepFromStepper(14, 13), 5);
  assert.equal(sleepFromStepper(14, 15), 15);
  assert.equal(sleepFromStepper(15, 16), 30);
  assert.equal(sleepFromStepper(5, 4), null);
  // Page Up and Page Down ask for ten: still one choice.
  assert.equal(sleepFromStepper(SLEEP_OFF, 10), 5);
  assert.equal(sleepFromStepper(30, 40), 45);
  assert.equal(sleepFromStepper(30, 20), 15);
});
