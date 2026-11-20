// A book's cover (#763): the image of the one cover choice (`src/cover-choice.ts`), or, for a book with no cover of
// its own or of its work, the generated cover: the title and the author on the work's colour (a share of the theme's
// accent, so every preset colours it). Never another book's art. An image that fails to load is drawn as the
// generated cover too. `compact` covers (56 px and less) show the title's first letter only. The generated cover's
// words are decoration, drawn by CSS from `data-text` (`cover.css`): neither DOM text nor in the accessibility tree,
// so the page's own title and author stay the only text with the book's name.
import { useEffect, useState, type CSSProperties } from "react";
import { coverShare } from "../cover-choice";
import "./cover.css";

export type CoverProps = {
  /** The chosen cover's address; "" or null for the generated cover. */
  src: string | null | undefined;
  title: string;
  author?: string | null;
  /** Picks the work's colour; the title stands in for it when absent. */
  workId?: string | null;
  /** The class of the box, given to the image or to the generated cover alike. */
  className?: string;
  compact?: boolean;
  lazy?: boolean;
};

export function Cover({ src, title, author, workId, className, compact, lazy }: CoverProps) {
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setFailed(null), [src]);
  if (src && failed !== src)
    return (
      <img
        className={className}
        src={src}
        alt=""
        loading={lazy ? "lazy" : undefined}
        decoding={lazy ? "async" : undefined}
        onError={() => setFailed(src)}
      />
    );
  const style = { "--cover-share": `${coverShare(workId || title)}%` } as CSSProperties;
  const letter = [...title.trim()][0] ?? "";
  return (
    <span className={`${className ? `${className} ` : ""}part-cover`} data-compact={compact ? "" : undefined} style={style} aria-hidden="true">
      {compact ? (
        <span className="part-cover-letter" data-text={letter} />
      ) : (
        <>
          <span className="part-cover-title" data-text={title} />
          {author && <span className="part-cover-author" data-text={author} />}
        </>
      )}
    </span>
  );
}
