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
  const tabStop = chosen >= 0 ? chosen : 0;

  function choose(index: number) {
    rows.current[index]?.focus();
    onChange(options[index].value);
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    const to =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? index === last ? 0 : index + 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? index === 0 ? last : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    choose(to);
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
            aria-labelledby={`${id}-${index}-label ${id}-${index}-detail`}
            tabIndex={index === tabStop ? 0 : -1}
            className="part-choice-row"
            data-chosen={checked ? "" : undefined}
            onClick={() => onChange(option.value)}
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
            {checked && <Tick className="part-choice-row-tick" />}
          </button>
        );
      })}
    </div>
  );
}

export type ChoiceListProps = {
  /** The list's name, read out with each row. */
  label: string;
  options: (Omit<Choice<string>, "value"> & { value: string; chosen: boolean })[];
  onToggle: (value: string, chosen: boolean) => void;
};

/**
 * Choice rows of which several may be chosen (board SeriesAdd.dc.html): each row is a checkbox, reached with Tab;
 * a tap, Space or Enter chooses or unchooses it. The same rows and card as the one-of group.
 */
export function ChoiceList({ label, options, onToggle }: ChoiceListProps) {
  const id = useId();
  return (
    <div className="part-choice-group part-choice-list" role="group" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="checkbox"
          aria-checked={option.chosen}
          aria-labelledby={`${id}-${index}-label ${id}-${index}-detail`}
          className="part-choice-row"
          data-chosen={option.chosen ? "" : undefined}
          onClick={() => onToggle(option.value, !option.chosen)}
        >
          <span className="part-choice-row-text">
            <span id={`${id}-${index}-label`} className="part-choice-row-label type-body">
              {option.label}
            </span>
            <span id={`${id}-${index}-detail`} className="part-choice-row-detail type-label">
              {option.detail}
            </span>
          </span>
          {option.chosen && <Tick className="part-choice-row-tick" />}
        </button>
      ))}
    </div>
  );
}
