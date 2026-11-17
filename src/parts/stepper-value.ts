// The Stepper's arithmetic (src/parts/Stepper.tsx), apart from React so it can be tested on its own. A value moves
// by whole steps between its two ends and never past them; the result is rounded to the step's decimals, so 0.1
// steps from 1.2 land on 1.3 and not on 1.2999999999999998.

export type StepperRange = { min: number; max: number; step: number };

function decimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** `value` kept inside the range and rounded to the step's decimals. */
export function clampStep(value: number, { min, max, step }: StepperRange): number {
  const places = decimals(step);
  const rounded = Number(value.toFixed(places));
  return Math.min(max, Math.max(min, rounded));
}

/** The value one step down (-1) or up (+1), held at the ends. */
export function stepValue(value: number, direction: -1 | 1, range: StepperRange): number {
  return clampStep(value + direction * range.step, range);
}

export function atMin(value: number, range: StepperRange): boolean {
  return clampStep(value, range) <= range.min;
}

export function atMax(value: number, range: StepperRange): boolean {
  return clampStep(value, range) >= range.max;
}

/**
 * The value a key gives the stepper (the spin button pattern): Arrow Up and Down one step, Page Up and Page Down
 * ten steps, Home the smallest value and End the largest. Null for a key the stepper does not handle.
 */
export function valueForKey(key: string, value: number, range: StepperRange): number | null {
  switch (key) {
    case "ArrowUp":
      return stepValue(value, 1, range);
    case "ArrowDown":
      return stepValue(value, -1, range);
    case "PageUp":
      return clampStep(value + 10 * range.step, range);
    case "PageDown":
      return clampStep(value - 10 * range.step, range);
    case "Home":
      return range.min;
    case "End":
      return range.max;
    default:
      return null;
  }
}
