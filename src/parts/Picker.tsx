// Picker (glossary "Picker"; built by #529 inside the Hardcover page, moved here by #602 for Get audiobook's
// language): a short list of choices over the page, named after what it chooses, one radio row per choice with a
// tick on the chosen one. It has no address. A choice applies at once and closes it; Escape, Close and a tap outside
// close it without choosing. Focus moves in and returns.
import { useRef } from "react";
import { Dialog } from "../components/ui/dialog";
import { Tick } from "./icons";
import "./picker.css";

export type PickerOption<T extends string> = { value: T; label: string };

export type PickerProps<T extends string> = {
  open: boolean;
  /** What the picker chooses: the dialog's name and its list's. */
  title: string;
  options: readonly PickerOption<T>[];
  value: T | null;
  onClose: () => void;
  /** A choice other than the one shown. */
  onChoose: (value: T) => void;
};

export function Picker<T extends string>({ open, title, options, value, onClose, onChoose }: PickerProps<T>) {
  // The control that opened it gets the focus back when it closes (it opens without a Radix trigger).
  // Read while rendering the opening: the dialog's own effects move the focus in before an effect here would run.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  wasOpen.current = open;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={title}
      className="part-picker"
      onCloseAutoFocus={(event) => {
        const back = opener.current;
        opener.current = null;
        if (back?.isConnected) {
          event.preventDefault();
          back.focus({ preventScroll: true });
        }
      }}
    >
      <ul className="part-picker-list" role="radiogroup" aria-label={title}>
        {options.map((option) => {
          const chosen = option.value === value;
          return (
            <li key={option.value}>
              <button
                type="button"
                role="radio"
                aria-checked={chosen}
                className="part-picker-choice type-body"
                data-chosen={chosen ? "" : undefined}
                onClick={() => {
                  onClose();
                  if (!chosen) onChoose(option.value);
                }}
              >
                <span className="part-picker-label">{option.label}</span>
                {chosen && <Tick className="part-picker-tick" />}
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
