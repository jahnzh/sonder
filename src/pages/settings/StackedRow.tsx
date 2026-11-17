// A Group item whose control is too wide for the right edge (a Segmented control): its label, with an info mark,
// on one line and the control under it, as the boards draw Density, Progress bar shows and Reading mode.
import type { ReactNode } from "react";

export function StackedRow({ label, info, children }: { label: string; info?: ReactNode; children: ReactNode }) {
  return (
    <li className="part-row-item settings-stacked">
      <span className="part-row-name">
        <span className="part-row-label type-body">{label}</span>
        {info}
      </span>
      {children}
    </li>
  );
}
