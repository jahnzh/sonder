// What the Get sheets have in common (#604, spec #600 "The sheet"; boards GetAudiobook.dc.html, GetEbook.dc.html):
// the book (cover 56, the title as the sheet's one heading, the author), the search field without a Search button,
// a failing source's line with its Retry, and the marks of the Group's rows. The styles are the Get audiobook sheet's
// (`get-sheet-*` in get-audiobook-sheet.css). Get ebook is built from these; Get audiobook keeps its own copies until
// its language and Load more ticket (#602) has landed, so that ticket's files are not touched here.
import type { FormEvent } from "react";
import { Button } from "../parts/Button";
import type { LibraryWork } from "../types";
import type { SourceLink } from "./get-source-link";
import { Cover } from "../parts/Cover";
import "./get-audiobook-sheet.css";

export function SearchIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export function RowChevron() {
  return (
    <svg className="part-row-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** The leaving-the-app mark of a row that opens another site in a new tab (board GetEbook.dc.html). */
export function LeavingMark() {
  return (
    <svg className="get-sheet-leaving" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5" />
    </svg>
  );
}

/**
 * The footer's line for the link to the chosen candidate's own page, opened in a new tab (#889). The line is always
 * there at the same height, so the Get button above it stays where it is whatever is chosen; without a link it is
 * empty: nothing to focus, nothing announced.
 */
export function SourceLinkLine({ link }: { link: SourceLink | null }) {
  return (
    <div className="get-sheet-source-line">
      {link && (
        <a className="get-sheet-source" href={link.href} target="_blank" rel="noopener noreferrer">
          <span className="type-label">{link.text}</span>
          <LeavingMark />
        </a>
      )}
    </div>
  );
}

/** The book the sheet gets a file for: its cover, the title as the sheet's one heading, the author under it. */
export function GetSheetBook({ work }: { work: (Pick<LibraryWork, "title" | "author" | "cover"> & { workId?: string }) | null }) {
  return (
    <div className="get-sheet-book">
      <Cover className="get-sheet-cover" src={work?.cover} title={work?.title ?? ""} workId={work?.workId} compact />
      <div className="get-sheet-names">
        <h1 className="get-sheet-title type-heading">{work?.title ?? ""}</h1>
        {work?.author && <p className="get-sheet-author type-label">{work.author}</p>}
      </div>
    </div>
  );
}

/** The search field: searched with the keyboard's search key or Enter; there is no Search button. */
export function GetSheetSearch({ name, words, onWords, onSearch }: { name: string; words: string; onWords: (words: string) => void; onSearch: () => void }) {
  return (
    <form
      className="get-sheet-search"
      role="search"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSearch();
      }}
    >
      <label className="get-sheet-field">
        <SearchIcon />
        <input
          type="search"
          className="get-sheet-input"
          aria-label={name}
          enterKeyHint="search"
          maxLength={150}
          value={words}
          onChange={(event) => onWords(event.target.value)}
        />
      </label>
    </form>
  );
}

/** A failing source: "<Source> could not be searched.", the server's sentence, and Retry for that source. */
export function SourceFailureLine({ source, sentence, reason, onRetry }: { source: string; sentence: string; reason: string; onRetry: () => void }) {
  return (
    <div className="get-sheet-failure" role="status">
      <p className="type-label">
        {sentence}
        {reason && <span className="get-sheet-reason"> {reason}</span>}
      </p>
      <Button kind="secondary" aria-label={`Retry ${source}`} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
