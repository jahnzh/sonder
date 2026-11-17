// The 64-high row of Activity › Server and of the worker's page (#519, #520): a name with its tooltip, a line under
// it, and on the right the attention mark and a control. The Row part has a value but no line, so these two pages
// draw this one (styles in activity-server.css).
import type { ReactNode } from "react";
import { InfoMark } from "../parts/Tooltip";
import { tip, type TipName } from "../tooltip-texts";
import "./activity-server.css";

/** The attention mark: an 8 px dot, announced as "Needs attention". */
export function AttentionMark() {
  return <span className="activity-server-mark" role="img" aria-label="Needs attention" />;
}

/** A row: its name (with its tooltip), its line, and on the right its mark and its control. 64 high. */
export function ServerRow({
  id, name, info, line, failure, result, mark, danger, wrap, muted, control,
}: {
  id: string;
  name: string;
  info: TipName;
  line: string;
  /** Why the row's control did not work, under the line (an alert). */
  failure?: string;
  /** What the row's control did, under the line (a status). */
  result?: string;
  mark?: boolean;
  /** The line in the failed colour without the mark (the mark draws it too). */
  danger?: boolean;
  /** The line wraps instead of being cut, for a reason that must be read whole. */
  wrap?: boolean;
  muted?: boolean;
  control?: ReactNode;
}) {
  return (
    <li className="activity-server-item" data-testid={`server-row-${id}`} data-muted={muted ? "" : undefined} data-attention={mark ? "" : undefined}>
      <div className="activity-server-row">
        <span className="activity-server-text">
          <span className="activity-server-name">
            <span className="activity-server-label type-body">{name}</span>
            <InfoMark name={name} text={tip(info)} />
          </span>
          {line && (
            <span
              className={["activity-server-line", "type-label", wrap ? "activity-server-wrap" : ""].filter(Boolean).join(" ")}
              data-testid="server-row-line"
              data-danger={mark || danger ? "" : undefined}
            >
              {line}
            </span>
          )}
          {result && (
            <span className="activity-server-line activity-server-wrap type-label" role="status" data-testid="server-row-result">
              {result}
            </span>
          )}
          {failure && (
            <span className="activity-server-failure type-label" role="alert">
              {failure}
            </span>
          )}
        </span>
        {(mark || control) && (
          <span className="activity-server-end">
            {mark && <AttentionMark />}
            {control}
          </span>
        )}
      </div>
    </li>
  );
}
