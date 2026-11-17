// Button (spec #480, "Parts"): primary (accent fill, dark text; one main action per screen), secondary (raised
// fill) and quiet (text only). 44 high, corner 8, Label text. An icon-only button is named by `label`.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./button.css";

export type ButtonKind = "primary" | "secondary" | "quiet";
export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> & {
  kind?: ButtonKind;
  /** The text on the button; also its name. */
  children?: ReactNode;
  /** A 20 px icon before the text, or alone. */
  icon?: ReactNode;
  /** The name of a button that shows only its icon. */
  label?: string;
  type?: "button" | "submit";
};

export function Button({ kind = "secondary", children, icon, label, type = "button", className, ...rest }: ButtonProps) {
  const iconOnly = !children;
  return (
    <button
      {...rest}
      type={type}
      aria-label={iconOnly ? label : rest["aria-label"]}
      className={["part-button", "type-label", className].filter(Boolean).join(" ")}
      data-kind={kind}
      data-icon-only={iconOnly ? "" : undefined}
    >
      {icon && <span className="part-button-icon" aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
}
