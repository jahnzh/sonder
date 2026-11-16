// Segmented control (spec #480, "Parts"; board SettingsPlayback.dc.html): 44 high, a raised track with corner 8 and
// its segments side by side, one of them chosen (the ground colour behind it, its text bold). It is a radio group
// named by `label`: Tab reaches the chosen segment, the arrows move to the next one and choose it, Home and End
// choose the first and the last. Each segment is 44 high where it is tapped; the chosen fill is drawn 4 inside.
import { useRef, type KeyboardEvent } from "react";
import { segmentForKey } from "./segment-keys";
import "./segmented.css";

export type SegmentOption<T extends string> = { value: T; label: string; disabled?: boolean };
export type SegmentedProps<T extends string> = {
  /** What is chosen here: the group's name. */
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The whole control can not be changed. */
  disabled?: boolean;
};

export function Segmented<T extends string>({ label, options, value, onChange, disabled }: SegmentedProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = options.findIndex((option) => option.value === value);
  const enabled = options.map((option) => !disabled && !option.disabled);
  // The one segment Tab reaches: the chosen one, or the first that can be chosen when none is.
  const tabStop = chosen >= 0 && enabled[chosen] ? chosen : enabled.indexOf(true);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = segmentForKey(event.key, index, enabled);
    if (next === null) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    if (options[next].value !== value) onChange(options[next].value);
  };
  return (
    <div className="part-segmented" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} data-disabled={disabled ? "" : undefined}>
      {options.map((option, index) => {
        const isChosen = index === chosen;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={isChosen}
            className="part-segment type-label"
            data-chosen={isChosen ? "" : undefined}
            disabled={!enabled[index]}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => {
              if (!isChosen) onChange(option.value);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span className="part-segment-face">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
