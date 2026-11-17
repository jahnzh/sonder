// Group (spec #480, "Parts"): rows on a surface card with corner 14 and a 1 px line between them, under an optional
// caption that names it. It is a list named by its caption (or by `label` when it shows none); the role is set
// outright because Safari drops it from a list drawn without bullets.
import { useId, type ReactNode } from "react";
import "./group.css";

export type GroupProps = {
  /** The group's name, shown above the card in the Caption style. */
  caption?: string;
  /** The name for a group shown without a caption. */
  label?: string;
  /** An info mark (Tooltip's InfoMark) after the caption. */
  info?: ReactNode;
  /** A note under the card (Caption size, not uppercase, muted). */
  note?: string;
  /** Rows. */
  children: ReactNode;
};

export function Group({ caption, label, info, note, children }: GroupProps) {
  const id = useId();
  return (
    <div className="part-group-block">
      {caption &&
        (info ? (
          <div className="part-group-caption-line">
            <h2 id={`${id}-caption`} className="part-group-caption type-caption">
              {caption}
            </h2>
            {info}
          </div>
        ) : (
          <h2 id={`${id}-caption`} className="part-group-caption type-caption">
            {caption}
          </h2>
        ))}
      <ul className="part-group" role="list" aria-labelledby={caption ? `${id}-caption` : undefined} aria-label={caption ? undefined : label}>
        {children}
      </ul>
      {note && <p className="part-group-note">{note}</p>}
    </div>
  );
}
