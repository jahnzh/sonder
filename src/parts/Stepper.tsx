// Stepper (spec #480, "Parts"; board Main.dc.html, the Speed row): 44 high, the value between a minus and a plus.
// The value is a spin button named by `label` with its value, smallest and largest (Tab reaches it; Arrow Up and
// Down step, Page Up and Page Down step ten, Home and End go to the ends). The minus and the plus are 44 by 44 for a
// tap and named for what they do; each is disabled at its end. As in the spin button pattern, they are not in the
// Tab order, since the keys do what they do.
import type { KeyboardEvent } from "react";
import { atMax, atMin, clampStep, stepValue, valueForKey, type StepperRange } from "./stepper-value";
import "./stepper.css";

export type StepperProps = StepperRange & {
  /** What the value is: the spin button's name. */
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** How the value is shown and announced ("1.2×"). */
  format?: (value: number) => string;
  /** The minus button's name ("Slower"); "Less <label>" by default. */
  decreaseLabel?: string;
  /** The plus button's name ("Faster"); "More <label>" by default. */
  increaseLabel?: string;
  disabled?: boolean;
};

function Minus() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 12h14" />
    </svg>
  );
}
function Plus() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 12h14M12 5v14" />
    </svg>
  );
}

export function Stepper({ label, value, onChange, format = String, decreaseLabel, increaseLabel, disabled, min, max, step }: StepperProps) {
  const range = { min, max, step };
  const shown = clampStep(value, range);
  const lowest = atMin(shown, range);
  const highest = atMax(shown, range);
  const change = (next: number) => {
    if (next !== shown) onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (disabled) return;
    const next = valueForKey(event.key, shown, range);
    if (next === null) return;
    event.preventDefault();
    change(next);
  };
  return (
    <span className="part-stepper" data-disabled={disabled ? "" : undefined}>
      <button
        type="button"
        className="part-stepper-button"
        aria-label={decreaseLabel ?? `Less ${label}`}
        tabIndex={-1}
        disabled={disabled || lowest}
        onClick={() => change(stepValue(shown, -1, range))}
      >
        <Minus />
      </button>
      <span
        className="part-stepper-value type-label"
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuenow={shown}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={format(shown)}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
      >
        {format(shown)}
      </span>
      <button
        type="button"
        className="part-stepper-button"
        aria-label={increaseLabel ?? `More ${label}`}
        tabIndex={-1}
        disabled={disabled || highest}
        onClick={() => change(stepValue(shown, 1, range))}
      >
        <Plus />
      </button>
    </span>
  );
}
