// Row (spec #480, "Parts"): its label on the left edge, its value or control on the right edge, 16 inset, 52 high.
// Rows sit in a Group, which is a list: a Row is one of its items. A row that does something is a button and is
// reached with Tab; a row that only shows a value is named by its label and value.
import { useId, type ReactNode } from "react";
import "./row.css";

type Common = {
  /** What the row is: its name, on the left edge. */
  label: string;
  /** What it stands at, on the right edge (Label size, muted). */
  value?: string;
};
export type RowProps = Common &
  (
    | {
        /** The row opens something or acts: it is one button, with a chevron when it opens a page. */
        onClick: () => void;
        /** It opens a page (draws the chevron). */
        opens?: boolean;
        disabled?: boolean;
        control?: never;
        info?: never;
      }
    | {
        /** A control of its own on the right edge (a Button, later a Switch or a Stepper), named by itself. */
        control?: ReactNode;
        /** An info mark (Tooltip's InfoMark) after the label. Not on a row that is a button: a mark is a button. */
        info?: ReactNode;
        onClick?: never;
        opens?: never;
        disabled?: never;
      }
  );

function Chevron() {
  return (
    <svg className="part-row-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function Row(props: RowProps) {
  const id = useId();
  const { label, value } = props;
  if (props.onClick) {
    return (
      <li className="part-row-item">
        <button type="button" className="part-row" data-opens={props.opens ? "" : undefined} onClick={props.onClick} disabled={props.disabled}>
          <span className="part-row-label type-body">{label}</span>
          {(value || props.opens) && (
            <span className="part-row-value type-label">
              {value}
              {props.opens && <Chevron />}
            </span>
          )}
        </button>
      </li>
    );
  }
  return (
    <li className="part-row-item" aria-labelledby={value ? `${id}-label ${id}-value` : `${id}-label`}>
      <div className="part-row">
        {props.info ? (
          <span className="part-row-name">
            <span id={`${id}-label`} className="part-row-label type-body">
              {label}
            </span>
            {props.info}
          </span>
        ) : (
          <span id={`${id}-label`} className="part-row-label type-body">
            {label}
          </span>
        )}
        {value && (
          <span id={`${id}-value`} className="part-row-value type-label">
            {value}
          </span>
        )}
        {props.control && <span className="part-row-control">{props.control}</span>}
      </div>
    </li>
  );
}
