// Row (spec #480, "Parts"): its label on the left edge, its value or control on the right edge, 16 inset, 52 high.
// Rows sit in a Group, which is a list: a Row is one of its items. A row that does something is a button and is
// reached with Tab; a row that only shows a value is named by its label and value.
import { useId, type ReactNode } from "react";
import { ProgressBar } from "./ProgressBar";
import "./row.css";

type Common = {
  /** What the row is: its name, on the left edge. */
  label: string;
  /** What it stands at, on the right edge (Label size, muted). */
  value?: string;
  /** The value is in the failed colour (Library and storage's "Not connected", #580). */
  failed?: boolean;
};
export type RowProps = Common &
  (
    | {
        /** The row opens something or acts: it is one button, with a chevron when it opens a page. */
        onClick: () => void;
        /** It opens a page (draws the chevron). */
        opens?: boolean;
        disabled?: boolean;
        /** The row of the page shown beside its list (a desktop's Settings, #614): marked as the current page. */
        current?: boolean;
        control?: never;
        info?: never;
      }
    | {
        /** A control of its own on the right edge (a Button, later a Switch or a Stepper), named by itself. */
        control?: ReactNode;
        /** An info mark (Tooltip's InfoMark) after the label. Not on a row that is a button: a mark is a button. */
        info?: ReactNode;
        /** 0 to 1: a thin bar under the label (a share, such as the storage in use); the row is then 64 high. */
        progress?: number | null;
        /** A line under the label (Label size, muted), such as when a key works ("While nothing plays", #614). */
        detail?: string;
        onClick?: never;
        opens?: never;
        disabled?: never;
        current?: never;
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
        <button type="button" className="part-row" data-opens={props.opens ? "" : undefined} aria-current={props.current ? "page" : undefined} onClick={props.onClick} disabled={props.disabled}>
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
  const name = props.info ? (
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
  );
  const moving = props.progress != null;
  const detail = props.detail;
  const named = [`${id}-label`, detail && `${id}-detail`, value && `${id}-value`].filter(Boolean).join(" ");
  return (
    <li className="part-row-item" aria-labelledby={named}>
      <div className="part-row" data-moving={moving ? "" : undefined} data-detail={detail ? "" : undefined}>
        {moving ? (
          <span className="part-row-stack">
            {name}
            <ProgressBar progress={props.progress as number} />
          </span>
        ) : detail ? (
          <span className="part-row-stack">
            {name}
            <span id={`${id}-detail`} className="part-row-detail type-label">
              {detail}
            </span>
          </span>
        ) : (
          name
        )}
        {value && (
          <span id={`${id}-value`} className="part-row-value type-label" data-failed={props.failed ? "" : undefined}>
            {value}
          </span>
        )}
        {props.control && <span className="part-row-control">{props.control}</span>}
      </div>
    </li>
  );
}
