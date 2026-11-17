// A row whose value opens a short list to choose from (Theme, Font). The Picker and the Choice row of the redesign
// (#490, #529) are not on main yet: this is a dialog named after the row, with one radio row per choice, and choosing
// closes it. Focus moves in and returns; Escape and a tap outside close it without choosing.
import { useState, type ReactNode } from "react";
import { Row } from "../../parts/Row";
import { Dialog } from "../../components/ui/dialog";

function ChevronDown() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export type ChoiceOption<T extends string> = { value: T; label: string };

export function ChoiceList<T extends string>({ label, options, value, onChoose }: { label: string; options: readonly ChoiceOption<T>[]; value: T | null; onChoose: (value: T) => void }) {
  return (
    <ul className="settings-choices" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <li key={option.value}>
          <button
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className="settings-choice type-body"
            data-chosen={option.value === value ? "" : undefined}
            onClick={() => onChoose(option.value)}
          >
            <span>{option.label}</span>
            {option.value === value && (
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l5 5 9-10" />
              </svg>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A Row that shows the chosen value and opens the list. `name` is the row's label, also the list's name. */
export function ChoiceRow<T extends string>({ name, title, options, value, shown, info, onChange }: { name: string; title?: string; options: readonly ChoiceOption<T>[]; value: T | null; shown?: string; info?: ReactNode; onChange: (value: T) => void }) {
  const [open, setOpen] = useState(false);
  const current = shown ?? options.find((option) => option.value === value)?.label ?? "";
  return (
    <>
      {info ? (
        // A row with an info mark is not one button (the mark is a button): the value is the button.
        <Row
          label={name}
          info={info}
          control={
            <button type="button" className="settings-choice-trigger type-label" aria-label={`${title ?? name}: ${current}`} onClick={() => setOpen(true)}>
              {current}
              <ChevronDown />
            </button>
          }
        />
      ) : (
        <Row label={name} value={current} onClick={() => setOpen(true)} />
      )}
      <Dialog open={open} onOpenChange={setOpen} title={title ?? name} className="settings-choice-dialog">
        <ChoiceList
          label={title ?? name}
          options={options}
          value={value}
          onChoose={(next) => {
            setOpen(false);
            if (next !== value) onChange(next);
          }}
        />
      </Dialog>
    </>
  );
}
