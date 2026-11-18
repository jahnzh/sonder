// Chip (spec #480, "Parts"; board Library.dc.html, the filter row): round, 44 high, Label text. Selected it has the
// text colour as its fill and the ground colour as its text; not selected the raised fill. It is a toggle button,
// so a screen reader announces its name and whether it is pressed. In a row that is still a tablist (the Library's
// filter row until its slice, #567) it is one of its tabs and announces whether it is selected.
import type { ButtonHTMLAttributes } from "react";
import "./chip.css";

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children" | "aria-pressed" | "aria-selected" | "role"> & {
  /** The chip's text; also its name. */
  children: string;
  selected: boolean;
  /** It stands in a tablist: a tab, selected or not, in place of a toggle button. */
  tab?: boolean;
};

export function Chip({ children, selected, tab, className, ...rest }: ChipProps) {
  return (
    <button
      {...rest}
      type="button"
      role={tab ? "tab" : undefined}
      aria-pressed={tab ? undefined : selected}
      aria-selected={tab ? selected : undefined}
      className={["part-chip", "type-label", className].filter(Boolean).join(" ")}
      data-selected={selected ? "" : undefined}
    >
      {children}
    </button>
  );
}
