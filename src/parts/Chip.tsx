// Chip (spec #480, "Parts"; board Library.dc.html, the filter row): round, 44 high, Label text. Selected it has the
// text colour as its fill and the ground colour as its text; not selected the raised fill. It is a toggle button,
// so a screen reader announces its name and whether it is pressed.
import type { ButtonHTMLAttributes } from "react";
import "./chip.css";

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children" | "aria-pressed"> & {
  /** The chip's text; also its name. */
  children: string;
  selected: boolean;
};

export function Chip({ children, selected, className, ...rest }: ChipProps) {
  return (
    <button
      {...rest}
      type="button"
      aria-pressed={selected}
      className={["part-chip", "type-label", className].filter(Boolean).join(" ")}
      data-selected={selected ? "" : undefined}
    >
      {children}
    </button>
  );
}
