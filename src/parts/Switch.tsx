// Switch (spec #480, "Parts"; boards Main.dc.html and SettingsPlayback.dc.html): a round track 52 by 32 with a 24
// knob, on the right and on the accent when on, on the left and on the line colour when off. It has the switch
// role and its checked state; the button around the track is 44 high, so the place it is tapped is at least 44.
import type { ButtonHTMLAttributes } from "react";
import "./switch.css";

export type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children" | "onChange" | "role" | "aria-checked"> & {
  /** What it switches: its name. A Row shows the same words as its label. */
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
};

export function Switch({ label, on, onChange, className, onClick, ...rest }: SwitchProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={["part-switch", className].filter(Boolean).join(" ")}
      data-on={on ? "" : undefined}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onChange(!on);
      }}
    >
      <span className="part-switch-track" aria-hidden="true">
        <span className="part-switch-knob" />
      </span>
    </button>
  );
}
