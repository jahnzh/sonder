// File row (spec #480, "Parts"; board LanguageFiles.dc.html): a 20 px icon (headphones, open book or chain link),
// the name, one status line, a thin accent bar under the line while something moves, and room for one button on
// the right edge (Get). 64 high, with or without the bar. It is an item of a Group. A row that opens a page is one
// button with a chevron; a row with a button of its own is named by its name and status line.
// The status line is a plain string: the functions that make it are in src/status-lines.ts.
import { useId, type ReactNode } from "react";
import { Chevron, FileIcon, type FileKind } from "./icons";
import { ProgressBar } from "./ProgressBar";
import "./file-row.css";

type Common = {
  kind: FileKind;
  /** The file's name ("Audiobook", "Ebook", "Reading sync"). */
  name: string;
  /** One status line. */
  status: string;
  /** 0 to 1 while something moves; draws the bar under the status line. Leave out when nothing moves. */
  progress?: number | null;
  /** An info mark (Tooltip's InfoMark) after the name. Not on a row that is a button: a mark is a button. */
  info?: ReactNode;
  /** The row is muted: what it names cannot be used yet (a Reading sync that needs a file). */
  muted?: boolean;
};
export type FileRowProps = Common &
  (
    | {
        /** The row opens the file's page: it is one button with a chevron. */
        onClick: () => void;
        action?: never;
      }
    | {
        /** One button on the right edge (a Button, such as Get), named by itself. */
        action?: ReactNode;
        onClick?: never;
      }
  );

function Body({ id, kind, name, status, progress, info }: Common & { id: string }) {
  return (
    <>
      <span className="part-file-row-icon">
        <FileIcon kind={kind} />
      </span>
      <span className="part-file-row-text">
        {info ? (
          <span className="part-file-row-title">
            <span id={`${id}-name`} className="part-file-row-name type-body">
              {name}
            </span>
            {info}
          </span>
        ) : (
          <span id={`${id}-name`} className="part-file-row-name type-body">
            {name}
          </span>
        )}
        <span id={`${id}-status`} className="part-file-row-status type-label">
          {status}
        </span>
        {progress != null && <ProgressBar progress={progress} />}
      </span>
    </>
  );
}

export function FileRow(props: FileRowProps) {
  const id = useId();
  const moving = props.progress != null ? "" : undefined;
  if (props.onClick) {
    return (
      <li className="part-file-row-item">
        <button type="button" className="part-file-row" data-kind={props.kind} data-moving={moving} aria-labelledby={`${id}-name ${id}-status`} onClick={props.onClick}>
          <Body id={id} {...props} />
          <span className="part-file-row-end">
            <Chevron />
          </span>
        </button>
      </li>
    );
  }
  return (
    <li className="part-file-row-item" aria-labelledby={`${id}-name ${id}-status`}>
      <div className="part-file-row" data-kind={props.kind} data-moving={moving} data-muted={props.muted ? "" : undefined}>
        <Body id={id} {...props} />
        {props.action && <span className="part-file-row-end">{props.action}</span>}
      </div>
    </li>
  );
}
