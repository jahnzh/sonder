// Book row (spec #480, "Parts"; boards LanguageFiles.dc.html, Series.dc.html): a cover of 40 with corner 8, the
// title and one status line, 64 high. With a number in front (its place in a series) it is 56 high: the series row.
// Small marks before the status line say which files the book has; a thin accent bar under the line shows that
// something moves. It is an item of a Group; a row that opens the book is one button with a chevron.
// The status line is a plain string: the functions that make it are in src/status-lines.ts.
import { useId, type ReactNode } from "react";
import { Chevron, FileIcon, fileKindName, type FileKind } from "./icons";
import { ProgressBar } from "./ProgressBar";
import "./book-row.css";

export type BookRowProps = {
  title: string;
  /** One status line. */
  status: string;
  /** A word in front of the status line, in the accent colour ("New · Not in your library" on the Series page). */
  lead?: string | null;
  /** The cover's address; without one the cover is an empty raised square. */
  cover?: string | null;
  /** Its place in a series ("1", "2.5"): drawn in front, and the row is 56 high. */
  number?: string | number | null;
  /** Which files the book has, as 16 px marks before the status line. */
  marks?: FileKind[];
  /** 0 to 1 while something moves; draws the bar under the status line. */
  progress?: number | null;
  /** The row opens the book. */
  onClick?: () => void;
  /**
   * One button on the right edge (Pause, Remove), named by itself. With `onClick` the rest of the row stays the
   * button that opens the book, without its chevron.
   */
  action?: ReactNode;
  /** The status line is in the failed colour (Activity's Now: "Download failed"). */
  failed?: boolean;
  /** A short muted text on the right edge in place of the chevron ("2 h ago" in Now's Finished today). */
  trailing?: string | null;
  /** A 20 px icon in the cover's slot, for a row that is not a book (Now's server rows); drawn when there is no cover. */
  coverIcon?: ReactNode;
  /** The row stands out on the raised fill (the Series page's book to continue). */
  raised?: boolean;
  /**
   * Which files the book has, as muted 12 px marks on the right edge in place of the chevron (the Library's list,
   * LibraryList.dc.html); read out after the status line, by their own name ("Reading sync ready") or the kind's.
   */
  edgeMarks?: { kind: FileKind; name?: string }[];
};

export function BookRow({ title, status, lead, cover, number, marks = [], progress, onClick, action, failed, trailing, coverIcon, raised, edgeMarks }: BookRowProps) {
  const id = useId();
  const numbered = number != null && number !== "";
  const names = [
    numbered && `${id}-number`,
    `${id}-title`,
    ...marks.map((_, index) => `${id}-mark-${index}`),
    `${id}-status`,
    trailing && !action && `${id}-trailing`,
    ...(edgeMarks ?? []).map((_, index) => `${id}-edge-${index}`),
  ]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      {numbered && (
        <span id={`${id}-number`} className="part-book-row-number type-label">
          {number}
        </span>
      )}
      <span className="part-book-row-cover" aria-hidden="true" data-icon={!cover && coverIcon ? "" : undefined}>
        {cover ? <img src={cover} alt="" loading="lazy" decoding="async" /> : coverIcon}
      </span>
      <span className="part-book-row-text">
        <span id={`${id}-title`} className="part-book-row-title type-body">
          {title}
        </span>
        <span className="part-book-row-line type-label">
          {marks.map((kind, index) => (
            <span key={`${kind}-${index}`} id={`${id}-mark-${index}`} className="part-book-row-mark">
              <FileIcon kind={kind} size={16} name={fileKindName[kind]} />
            </span>
          ))}
          <span id={`${id}-status`} className="part-book-row-status">
            {lead && (
              <>
                <span className="part-book-row-lead">{lead}</span>
                {" · "}
              </>
            )}
            {status}
          </span>
        </span>
        {progress != null && <ProgressBar progress={progress} />}
      </span>
      {trailing && !action && (
        <span id={`${id}-trailing`} className="part-book-row-trailing">
          {trailing}
        </span>
      )}
      {edgeMarks && (
        <span className="part-book-row-edge-marks">
          {edgeMarks.map((mark, index) => (
            <span key={`${mark.kind}-${index}`} id={`${id}-edge-${index}`}>
              <FileIcon kind={mark.kind} size={12} name={mark.name ?? fileKindName[mark.kind]} />
            </span>
          ))}
        </span>
      )}
    </>
  );
  const data = {
    "data-numbered": numbered ? "" : undefined,
    "data-moving": progress != null ? "" : undefined,
    "data-failed": failed ? "" : undefined,
  };
  if (action) {
    return (
      <li className="part-book-row-item" data-action="" data-raised={raised ? "" : undefined} aria-labelledby={onClick ? undefined : names}>
        {onClick ? (
          <button type="button" className="part-book-row" {...data} aria-labelledby={names} onClick={onClick}>
            {body}
          </button>
        ) : (
          <div className="part-book-row" {...data}>
            {body}
          </div>
        )}
        <span className="part-book-row-action">{action}</span>
      </li>
    );
  }
  if (onClick) {
    return (
      <li className="part-book-row-item">
        <button type="button" className="part-book-row" {...data} aria-labelledby={names} onClick={onClick}>
          {body}
          {!trailing && !edgeMarks && (
            <span className="part-book-row-end">
              <Chevron />
            </span>
          )}
        </button>
      </li>
    );
  }
  return (
    <li className="part-book-row-item" aria-labelledby={names}>
      <div className="part-book-row" {...data}>
        {body}
      </div>
    </li>
  );
}
