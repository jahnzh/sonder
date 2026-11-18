// The reader's pages (#590, spec #586 "Chapters, Bookmarks and Search as pages"; boards Chapters.dc.html,
// ReaderBookmarks.dc.html, ReaderSearch.dc.html): `#book/<workId>/chapters`, `/bookmarks` and `/search`, each a
// Page with one Title, "Back to the book" and the book's title under it. Chapters and Bookmarks are one page with a
// segmented control that replaces the entry. A row opens the reader there, paged away (ADR 0014), with an entry of
// its own, so Back from the reader shows the page again as it was left.
//
// Opened from a reader, a page lists that reader's book (src/reader-pages.ts), which stays mounted under it; reached
// by a link or a reload, it reads the work's chosen EPUB itself and a row opens the reader on its own.
import { useEffect, useMemo, useRef, useState } from "react";
import { useAddress, pageData, setPageData } from "../navigation";
import { PageHeader } from "../parts/PageHeader";
import { Segmented } from "../parts/Segmented";
import { Button } from "../parts/Button";
import { chosenEbook } from "../ebook-choice";
import { deviceEbookChoice } from "../ebook-device-copy";
import { useWork } from "../library-works-store";
import { localDB } from "../lib";
import { loadReader, queueBookmark } from "../reading";
import { minutesLeft } from "../reader-bands";
import { noSentenceLine, searchBook, searchWords, sentenceCount } from "../reader-search";
import {
  type Bookmark,
  type ReaderPage,
  type ReaderPlace,
  bookmarkLine,
  narratedLine,
  openerOf,
  requestPlace,
  sectionOfSentence,
  takeListenOpener,
  useOpener,
} from "../reader-pages";
import { useBookSpeed, usePlayer } from "../player";
import { chapterRowTime, currentChapter, listeningChapters } from "../chapters";
import { clock } from "../lib";
import { chosenRecording } from "./book-model";
import type { Book } from "../types";
import type { ReaderBook, ReaderSection } from "../reading-types";
import "./reader-pages.css";

/** What a page keeps in its own entry: the ebook it lists, on Search the words, and whether Listen opened it (#593). */
type PageData = { ebookId?: string; words?: string; listen?: boolean };
const readData = (): PageData => {
  const data = pageData();
  return data && typeof data === "object" ? (data as PageData) : {};
};
const writeData = (patch: PageData) => setPageData({ ...readData(), ...patch });

const EMPTY_BOOKMARKS = "No bookmarks. The bookmark button at the top saves the sentence in view.";

function HeadphonesIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <path d="M4 14h3v6H6a2 2 0 0 1-2-2zM20 14h-3v6h1a2 2 0 0 0 2-2z" />
    </svg>
  );
}
function RemoveIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * The book a page lists: its opener's, or one it reads itself. `ebookId` is the edition the entry names (written
 * when it was opened from a reader), else the work's chosen EPUB.
 */
function useListedBook(workId: string, page: ReaderPage) {
  const opener = useOpener(workId);
  const { work, status } = useWork(workId);
  const [kept] = useState(() => readData().ebookId);
  const ebookId = opener?.ebookId ?? kept ?? (work ? chosenEbook(work, deviceEbookChoice(workId))?.id : undefined);
  const [own, setOwn] = useState<{ id: string; book: ReaderBook | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (opener || !ebookId) return;
    let live = true;
    setOwn({ id: ebookId, book: null, failed: false });
    loadReader(ebookId).then(
      (book) => live && setOwn({ id: ebookId, book, failed: false }),
      () => live && setOwn({ id: ebookId, book: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [!!opener, ebookId]);
  // The entry names the edition it lists, so a reload lists the same one (the segment's entry too).
  useEffect(() => {
    if (ebookId && readData().ebookId !== ebookId) writeData({ ebookId });
  }, [ebookId, page]);
  const ownBook = own && own.id === ebookId ? own.book : null;
  const removeOwn = (entry: Bookmark) => {
    if (!ownBook || !ebookId) return;
    const updated = { ...ownBook, bookmarks: ownBook.bookmarks.filter((bookmark) => bookmark.id !== entry.id) };
    setOwn({ id: ebookId, book: updated, failed: false });
    void localDB.preferences.put({ key: `reader-book:${ebookId}`, value: updated });
    void queueBookmark(ebookId, "DELETE", entry);
  };
  const missing = !opener && (status === "missing" || status === "offline" || (status === "ready" && !ebookId) || !!own?.failed);
  return {
    ebookId: ebookId ?? null,
    title: opener?.title ?? ownBook?.title ?? work?.title ?? "",
    sections: (opener?.sections ?? ownBook?.sections ?? null) as readonly ReaderSection[] | null,
    bookmarks: (opener?.bookmarks ?? ownBook?.bookmarks ?? []) as readonly Bookmark[],
    narrated: opener?.narrated ?? null,
    missing,
    removeBookmark: (entry: Bookmark) => (opener ? opener.removeBookmark(entry) : removeOwn(entry)),
  };
}

/** A row's tap: the reader that opened the page shows the place, or the reader on its own opens there. */
function useOpenAt(workId: string, ebookId: string | null) {
  const { navigate } = useAddress();
  return (place: ReaderPlace) => {
    const opener = openerOf(workId);
    if (opener) {
      requestPlace(opener.ebookId, opener.host, place);
      opener.show();
    } else if (ebookId) {
      requestPlace(ebookId, "reader", place);
      navigate({ name: "reader", ebookId });
    }
  };
}

export function ReaderPages({ workId, page, books = [] }: { workId: string; page: ReaderPage; books?: Book[] }) {
  // Opened from Now playing's Listen face, Chapters lists the recording's chapters (#593); the entry keeps it.
  const [fromListen] = useState(() => {
    const listen = page === "chapters" && (takeListenOpener(workId) || readData().listen === true);
    if (listen && readData().listen !== true) writeData({ listen: true });
    return listen;
  });
  if (fromListen) return <ListenChapters workId={workId} books={books} />;
  return <ReaderPagesOf workId={workId} page={page} />;
}

/**
 * Chapters opened from Listen (#593, spec #586; board Chapters.dc.html): the recording's chapters with their lengths,
 * the current one marked with the headphones and its time left; a row moves the narration there (today's chapter
 * jump, recorded in Position history) and goes back to Listen.
 */
function ListenChapters({ workId, books }: { workId: string; books: Book[] }) {
  const p = usePlayer();
  const { goBack } = useAddress();
  const { work } = useWork(workId);
  const recordingId = work ? chosenRecording(work)?.recordingId : undefined;
  const book: Book | null =
    (p.book?.workId === workId ? p.book : null) ??
    books.find((entry) => entry.recordingId === recordingId) ??
    books.find((entry) => entry.workId === workId) ??
    null;
  const speed = useBookSpeed(book);
  const playing = !!book && p.book?.recordingId === book.recordingId;
  const current = playing && p.track ? currentChapter(book, p.track.id, p.position) : undefined;
  return (
    <div className="reader-pages" data-page="chapters" data-from="listen">
      <PageHeader title="Chapters" back parent={{ name: "listen", workId }} named={() => "the book"} />
      <p className="reader-pages-book type-label">{book?.title ?? work?.title ?? ""}</p>
      {!book ? (
        <Waiting missing={false} />
      ) : (
        <ul className="reader-pages-card reader-pages-chapters" role="list" aria-label="Chapters">
          {listeningChapters(book).map((chapter) => {
            const now = !!current && current.track.id === chapter.track.id && current.start === chapter.start;
            const time = chapterRowTime(chapter, now ? p.position : null, speed);
            return (
              <li key={`${chapter.track.id}-${chapter.start}`}>
                <button
                  type="button"
                  className="reader-pages-chapter"
                  aria-current={now ? "true" : undefined}
                  data-narrated={now ? "" : undefined}
                  onClick={() => {
                    void p.play(book, chapter.track, chapter.start, { kind: "chapter" });
                    goBack({ name: "listen", workId });
                  }}
                >
                  {now && (
                    <span className="reader-pages-chapter-mark">
                      <HeadphonesIcon />
                    </span>
                  )}
                  <span className="reader-pages-chapter-title type-body">{chapter.title}</span>
                  <span className="reader-pages-chapter-value type-label" title={time.title}>
                    {time.left ? `${clock(time.seconds)} left` : clock(time.seconds)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ReaderPagesOf({ workId, page }: { workId: string; page: ReaderPage }) {
  const book = useListedBook(workId, page);
  const openAt = useOpenAt(workId, book.ebookId);
  const title = page === "search" ? "Search" : page === "bookmarks" ? "Bookmarks" : "Chapters";
  return (
    <div className="reader-pages" data-page={page}>
      <PageHeader title={title} back parent={{ name: "book", workId }} named={() => "the book"} />
      <p className="reader-pages-book type-label">{book.title}</p>
      {page === "search" ? (
        <SearchList sections={book.sections} missing={book.missing} openAt={openAt} />
      ) : (
        <>
          <ChaptersSwitch workId={workId} page={page} />
          {page === "chapters" ? (
            <ChapterList sections={book.sections} narrated={book.narrated} missing={book.missing} openAt={openAt} />
          ) : (
            <BookmarkList sections={book.sections} bookmarks={book.bookmarks} missing={book.missing} openAt={openAt} remove={book.removeBookmark} />
          )}
        </>
      )}
    </div>
  );
}

function ChaptersSwitch({ workId, page }: { workId: string; page: "chapters" | "bookmarks" }) {
  const { navigate } = useAddress();
  return (
    <Segmented
      label="Chapters or bookmarks"
      options={[
        { value: "chapters", label: "Chapters" },
        { value: "bookmarks", label: "Bookmarks" },
      ]}
      value={page}
      // The segment replaces the entry (routes.ts, step).
      onChange={(value) => navigate({ name: "book-page", workId, page: value })}
    />
  );
}

function Waiting({ missing }: { missing: boolean }) {
  return (
    <p className="reader-pages-note type-label" role="status">
      {missing ? "That ebook is no longer in your library." : "Loading…"}
    </p>
  );
}

function ChapterList({
  sections,
  narrated,
  missing,
  openAt,
}: {
  sections: readonly ReaderSection[] | null;
  narrated: { section: number; secondsLeft: number } | null;
  missing: boolean;
  openAt: (place: ReaderPlace) => void;
}) {
  if (!sections) return <Waiting missing={missing} />;
  return (
    <ul className="reader-pages-card reader-pages-chapters" role="list" aria-label="Chapters">
      {sections.map((section) => {
        const now = narrated?.section === section.index;
        return (
          <li key={section.index}>
            <button
              type="button"
              className="reader-pages-chapter"
              aria-current={now ? "true" : undefined}
              data-narrated={now ? "" : undefined}
              onClick={() => openAt({ kind: "section", section: section.index, href: section.href })}
            >
              {now && (
                <span className="reader-pages-chapter-mark">
                  <HeadphonesIcon />
                </span>
              )}
              <span className="reader-pages-chapter-title type-body">{section.title}</span>
              {now && <span className="reader-pages-chapter-value type-label">{narratedLine(minutesLeft(narrated.secondsLeft))}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function BookmarkList({
  sections,
  bookmarks,
  missing,
  openAt,
  remove,
}: {
  sections: readonly ReaderSection[] | null;
  bookmarks: readonly Bookmark[];
  missing: boolean;
  openAt: (place: ReaderPlace) => void;
  remove: (bookmark: Bookmark) => void;
}) {
  if (!sections) return <Waiting missing={missing} />;
  if (!bookmarks.length) return <p className="reader-pages-note type-body">{EMPTY_BOOKMARKS}</p>;
  return (
    <ul className="reader-pages-card reader-pages-bookmarks" role="list" aria-label="Bookmarks">
      {bookmarks.map((entry) => {
        const section = sectionOfSentence(sections, entry.locator.paragraphId) ?? sections.find((item) => item.index === entry.locator.section);
        // The saved sentence in full: the book's own text, or the label it was saved with when the sentence is gone.
        const sentence = section?.paragraphs.find((fragment) => fragment.id === entry.locator.paragraphId)?.text ?? entry.locator.quote ?? entry.label;
        const line = bookmarkLine(section?.title, entry.createdAt);
        return (
          <li key={entry.id} className="reader-pages-bookmark">
            <button
              type="button"
              className="reader-pages-bookmark-open"
              onClick={() => openAt({ kind: "sentence", paragraphId: entry.locator.paragraphId, from: "bookmark" })}
            >
              <span className="type-body">{sentence}</span>
              {line && <span className="reader-pages-line type-label">{line}</span>}
            </button>
            <Button kind="quiet" icon={<RemoveIcon />} label={`Remove bookmark: ${line || sentence.slice(0, 60)}`} onClick={() => remove(entry)} />
          </li>
        );
      })}
    </ul>
  );
}

function SearchList({
  sections,
  missing,
  openAt,
}: {
  sections: readonly ReaderSection[] | null;
  missing: boolean;
  openAt: (place: ReaderPlace) => void;
}) {
  // The words come back with the entry: Back from the reader, or a reload, shows them and searches again.
  const [words, setWords] = useState(() => readData().words ?? "");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);
  const results = useMemo(() => (sections ? searchBook(sections, words) : []), [sections, words]);
  const searched = !!searchWords(words);
  return (
    <>
      <input
        ref={field}
        className="reader-pages-search"
        type="search"
        aria-label="Search this book"
        enterKeyHint="search"
        value={words}
        onChange={(event) => {
          setWords(event.target.value);
          writeData({ words: event.target.value });
        }}
      />
      {!searched ? null : !sections ? (
        <Waiting missing={missing} />
      ) : results.length ? (
        <section className="reader-pages-results" aria-labelledby="reader-pages-count">
          <h2 id="reader-pages-count" className="reader-pages-count type-caption" role="status">
            {sentenceCount(results.length)}
          </h2>
          <ul className="reader-pages-card" role="list" aria-label="Sentences">
            {results.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  className="reader-pages-result"
                  onClick={() => openAt({ kind: "sentence", paragraphId: result.id, from: "search" })}
                >
                  <span className="reader-pages-line type-label">{result.title}</span>
                  <span className="type-body">
                    {result.before}
                    <strong className="reader-pages-match">{result.match}</strong>
                    {result.after}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="reader-pages-note type-body" role="status">
          {noSentenceLine(words)}
        </p>
      )}
    </>
  );
}
