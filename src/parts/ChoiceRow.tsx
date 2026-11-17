// Choice row (spec #480, "Parts"; boards LanguageFiles.dc.html, GetAudiobook.dc.html): two lines, the chosen one
// with the raised fill and a tick on the right edge. Choice rows come as a group, one of which is chosen: a radio
// group on a surface card with a 1 px line between rows. Tab reaches the chosen row; the arrow keys, Home and End
// move to another row and choose it (as radio buttons do); a tap, Space or Enter chooses the row.
import { useId, useRef, type KeyboardEvent } from "react";
import { Tick } from "./icons";
import "./choice-row.css";

export type Choice<T extends string> = {
  value: T;
  /** The first line: what the choice is. */
  label: string;
  /** The second line (Label size, muted). */
  detail: string;
  /** What the right edge says before the tick (Caption size, muted; `now` in the accent's green), as Get's "Plays now". */
  edge?: { text: string; now?: boolean } | null;
  /** Off: shown but not chosen by a tap or the arrow keys (Get ebook's "Already added"). */
  disabled?: boolean;
};

export type ChoiceGroupProps<T extends string> = {
  /** The group's name, read out with the chosen row. */
  label: string;
  options: Choice<T>[];
  /** The chosen value; none is chosen while it matches no option. */
  value: T | null;
  onChange: (value: T) => void;
};

export function ChoiceGroup<T extends string>({ label, options, value, onChange }: ChoiceGroupProps<T>) {
  const id = useId();
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = options.findIndex((option) => option.value === value);
  // The row Tab reaches: the chosen one, or the first while none is.
  const tabStop = chosen >= 0 ? chosen : Math.max(0, options.findIndex((option) => !option.disabled));

  function choose(index: number) {
    rows.current[index]?.focus();
    onChange(options[index].value);
  }
  // The rows a tap or a key can choose: every row but those that are off.
  const open = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!open.length) return;
    const at = open.indexOf(index);
    const last = open.length - 1;
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? at < 0 || at === last ? 0 : at + 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? at <= 0 ? last : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (step === null) return;
    event.preventDefault();
    choose(open[step]);
  }

  return (
    <div className="part-choice-group" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const checked = index === chosen;
        return (
          <button
            key={option.value}
            ref={(element) => {
              rows.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-labelledby={`${id}-${index}-label ${id}-${index}-detail${option.edge ? ` ${id}-${index}-edge` : ""}`}
            tabIndex={index === tabStop ? 0 : -1}
            className="part-choice-row"
            data-chosen={checked ? "" : undefined}
            disabled={option.disabled || undefined}
            onClick={() => option.disabled || onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span className="part-choice-row-text">
              <span id={`${id}-${index}-label`} className="part-choice-row-label type-body">
                {option.label}
              </span>
              <span id={`${id}-${index}-detail`} className="part-choice-row-detail type-label">
                {option.detail}
              </span>
            </span>
            {option.edge && (
              <span id={`${id}-${index}-edge`} className="part-choice-row-edge type-caption" data-now={option.edge.now ? "" : undefined}>
                {option.edge.text}
              </span>
            )}
            {checked && <Tick className="part-choice-row-tick" />}
          </button>
        );
      })}
    </div>
  );
}
