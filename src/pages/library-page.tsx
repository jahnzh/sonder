// The Library (#577, spec #572 "The Library"; boards Library.dc.html, LibraryList.dc.html, DesktopLibrary.dc.html):
// the library by work (#528) with this device's newer places, one tile per work. The head (Title, Search, the plus),
// Continue, the chips (the Series chip's list is #567's), the heading named by the chip, and the tiles with the cover
// marks of #556 or the list rows with the Book page's place line. One control, "<sort> · <view>", opens the
// sort-and-view Picker (#578; boards LibrarySort.dc.html, LibraryShelf.dc.html, LibraryList.dc.html): Sort, View and
// the Shelf (Want to read, Reading, Finished; #721 part c1, in place of Hardcover's shelf and list); a shelf in use is a
// chip under the heading that clears it.
// What it shows is in library-filter.ts.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Pause, Play, Search, Plus, X, Loader2 } from "lucide-react";
import { coverMarks, COVER_MARK_NAMES, type CoverMark, type CoverMarks } from "../cover-marks";
import { BookRow } from "../parts/BookRow";
import { Button } from "../parts/Button";
import { Chip } from "../parts/Chip";
import { FileIcon, type FileKind } from "../parts/icons";
import { PickerChoices, PickerDialog, PickerGroup, PickerRow, PickerRows } from "../parts/Picker";
import { ProgressBar } from "../parts/ProgressBar";
import { Segmented } from "../parts/Segmented";
import { usePlayer } from "../player";
import { SEARCH_KEY_EVENT } from "../keyboard";
import type { Book, LibraryWork } from "../types";
import { chosenRecording } from "./book-model";
import {
  ALL_CHIP,
  chipLabel,
  continueShown,
  continueWork,
  controlLabel,
  emptyShelf,
  filterLibrary,
  LIBRARY_CHIPS,
  listLine,
  listRowLine,
  NO_SHELF,
  progressFraction,
  SHELF_NAMES,
  shelfChip,
  shelfChoices,
  shelfHeading,
  SORT_NAMES,
  SORT_ORDERS,
  sortLibrary,
  type LibraryChip,
  type LibraryView,
  type ShelfFilter,
  type SortOrder,
} from "./library-filter";
import { SeriesList } from "./library-series";
import { SERIES_CHIP, type SavedSeriesItem } from "./library-series-model";
import type { Page } from "./shared";
import { Cover } from "../parts/Cover";
import "./library-page.css";

export type LibraryAction = "add" | "remove" | "finished" | "unread";

const MARK_KIND: Record<CoverMark, FileKind> = { audiobook: "audiobook", ebook: "ebook", "reading-sync": "sync" };

export function LibraryPage({
  works,
  stored,
  books,
  query,
  setQuery,
  filter,
  setFilter,
  view,
  setView,
  sort,
  setSort,
  shelf,
  setShelf,
  savedSeries,
  openSeries,
  findSeries,
  findBook,
  beside,
  favorites,
  onDevice,
  openWork,
  navigate,
}: {
  /** The works in the library, with this device's newer places (`useStoredWorksWithPlaces`). */
  works: LibraryWork[];
  /** The stored works have been read from the device: until then an empty list is not an empty library. */
  stored: boolean;
  /** `GET /api/books` as the player knows it: Continue's Play plays the chosen recording's entry. */
  books: Book[];
  query: string;
  setQuery: (query: string) => void;
  filter: LibraryChip;
  setFilter: (chip: LibraryChip) => void;
  view: LibraryView;
  setView: (view: LibraryView) => void;
  sort: SortOrder;
  setSort: (sort: SortOrder) => void;
  /** The shelf chosen on this device (Want to read, Reading, Finished), or all. */
  shelf: ShelfFilter;
  setShelf: (shelf: ShelfFilter) => void;
  /** `GET /api/series`, for the Series chip (#567). */
  savedSeries: { items: SavedSeriesItem[] | undefined; error: string };
  openSeries: (id: string) => void;
  findSeries: () => void;
  /** The plus, "Add a book" (#575): Discover with its field focused. */
  findBook: () => void;
  /** A desktop's `#series/<id>`: the Series chip's list with this series beside it (DesktopSeries.dc.html). */
  beside?: { id: string; page: ReactNode } | null;
  /** The favourites by work. */
  favorites: string[];
  /** Works kept on this device and complete. */
  onDevice: ReadonlySet<string>;
  /** Opens `#book/<workId>`. */
  openWork: (workId: string) => void;
  navigate: (page: Page) => void;
}) {
  // On a phone Search opens a field in place of the Title row; on a desktop the field is always there.
  const [searching, setSearching] = useState(() => query !== "");
  const field = useRef<HTMLInputElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (searching && opened.current) field.current?.focus();
    opened.current = true;
  }, [searching]);
  // `/` (src/keyboard.ts) opens the search in place of the Title row before it focuses the field (#614).
  useEffect(() => {
    const input = field.current;
    if (!input) return;
    const open = () => setSearching(true);
    input.addEventListener(SEARCH_KEY_EVENT, open);
    return () => input.removeEventListener(SEARCH_KEY_EVENT, open);
  }, []);
  // The Series chip is chosen, or a desktop shows a series beside its list: the list stands in place of the shelf.
  const chip: LibraryChip = beside ? SERIES_CHIP : filter;
  const seriesShown = chip === SERIES_CHIP;
  const choose = (next: LibraryChip) => {
    setFilter(next);
    // Beside a series the Library is at the series' address: a chip shows the Library again in its place.
    if (beside) navigate("library");
  };
  const input = { chip, query, favorites, onDevice, shelf };
  const shown = sortLibrary(filterLibrary(works, input), sort);
  const featured = continueShown(chip, query, shelf) ? continueWork(works) : null;
  const [picking, setPicking] = useState(false);
  const control = useRef<HTMLButtonElement>(null);
  const label = controlLabel(sort, view);
  const shelfInUse = shelfChip(shelf);
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };
  const clear = () => {
    setFilter(ALL_CHIP);
    closeSearch();
    setShelf(NO_SHELF);
  };
  const empty = emptyShelf(works.length, input);
  return (
    <div className="library-page" data-searching={searching ? "" : undefined}>
      <header className="library-head">
        <h1 className="type-title">Library</h1>
        <label className="library-search">
          <Search size={20} aria-hidden="true" />
          <input
            type="search"
            className="type-body"
            aria-label="Search your library"
            placeholder="Title or author"
            data-search-key=""
            ref={field}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
            }}
          />
        </label>
        <div className="library-head-actions">
          {searching ? (
            <Button className="library-search-toggle" icon={<X size={20} />} label="Close search" onClick={closeSearch} />
          ) : (
            <Button className="library-search-toggle" icon={<Search size={20} />} label="Search your library" onClick={() => setSearching(true)} />
          )}
          <Button className="library-add" icon={<Plus size={20} />} label="Add a book" onClick={findBook}>
            <span className="library-add-text">Add a book</span>
          </Button>
        </div>
      </header>
      {featured && !seriesShown && <ContinueCard work={featured} books={books} onOpen={() => openWork(featured.workId)} />}
      <div className="library-chips" role="group" aria-label="Filter your library">
        {LIBRARY_CHIPS.map((value) => (
          <Chip key={value} selected={chip === value} className={value === SERIES_CHIP ? "library-series-chip" : undefined} onClick={() => choose(value)}>
            {chipLabel(value)}
          </Chip>
        ))}
      </div>
      {seriesShown ? (
        beside ? (
          <div className="library-series-beside">
            <SeriesList {...savedSeries} query={query} current={beside.id} beside onOpen={openSeries} onFind={findSeries} />
            <div className="library-series-shown">{beside.page}</div>
          </div>
        ) : (
          <SeriesList {...savedSeries} query={query} onOpen={openSeries} onFind={findSeries} />
        )
      ) : (
        <section className="library-shelf" aria-labelledby="library-shelf-heading">
          <div className="library-shelf-head">
            <h2 id="library-shelf-heading" className="type-heading">
              {shelfHeading(chip)}
            </h2>
            <button
              type="button"
              ref={control}
              className="library-control type-label"
              aria-label={label.name}
              aria-haspopup="dialog"
              aria-expanded={picking}
              onClick={() => setPicking(true)}
            >
              {label.text}
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>
          {shelfInUse && (
            <div className="library-hardcover-chips">
              <button type="button" className="library-hardcover-chip type-label" aria-label={shelfInUse.name} onClick={() => setShelf(NO_SHELF)}>
                {shelfInUse.text}
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          <SortAndView
            open={picking}
            onClose={() => setPicking(false)}
            anchor={control}
            sort={sort}
            setSort={setSort}
            view={view}
            setView={setView}
            shelf={shelf}
            setShelf={setShelf}
          />
          {!stored && works.length === 0 ? (
            <p className="library-reading type-label" role="status">
              <Loader2 size={16} className="spin" aria-hidden="true" /> Loading
            </p>
          ) : shown.length ? (
            view === "grid" ? (
              <ul className="library-grid" aria-label={shelfHeading(chip)}>
                {shown.map((work) => (
                  <WorkTile key={work.workId} work={work} onOpen={() => openWork(work.workId)} />
                ))}
              </ul>
            ) : (
              <ul className="part-group library-list" aria-label={shelfHeading(chip)}>
                {shown.map((work) => (
                  <WorkRow key={work.workId} work={work} onOpen={() => openWork(work.workId)} />
                ))}
              </ul>
            )
          ) : (
            <div className="library-empty">
              <h3 className="type-heading">{empty.title}</h3>
              {empty.inUse.length > 0 && <p className="type-label">{empty.inUse.join(" · ")}</p>}
              {empty.action === "clear" ? (
                <Button kind="primary" onClick={clear}>
                  Clear filters
                </Button>
              ) : (
                <Button kind="primary" onClick={findBook}>
                  Find a book
                </Button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** The marks pill on a cover: the marks in the boards' order, or the audiobook mark and the percentage while the first file downloads. */
function MarksPill({ marks }: { marks: CoverMarks }) {
  if (marks.kind === "downloading")
    return (
      <span className="library-marks" role="img" aria-label={`Downloading · ${marks.percent}%`}>
        <FileIcon kind="audiobook" size={12} />
        <span aria-hidden="true">{marks.percent}%</span>
      </span>
    );
  if (!marks.marks.length) return null;
  const names = marks.marks.map((mark) => COVER_MARK_NAMES[mark]).join(", ");
  return (
    <span className="library-marks" role="img" aria-label={names} title={names}>
      {marks.marks.map((mark) => (
        <FileIcon key={mark} kind={MARK_KIND[mark]} size={12} />
      ))}
    </span>
  );
}

/** A grid tile: the cover with its marks, the title on one line and the author; it opens the book. */
function WorkTile({ work, onOpen }: { work: LibraryWork; onOpen: () => void }) {
  const marks = coverMarks(work);
  return (
    <li className="library-tile" data-work={work.workId}>
      <button type="button" className="library-tile-open" onClick={onOpen} aria-label={`About ${work.title}`}>
        <span className="library-cover">
          {/* The work's cover by the one cover choice (#763), else the generated cover. */}
          <Cover src={work.cover} title={work.title} author={work.author} workId={work.workId} lazy />
          <MarksPill marks={marks} />
        </span>
        <span className="library-tile-title type-label">{work.title}</span>
        <span className="library-tile-author">{work.author}</span>
      </button>
    </li>
  );
}

/**
 * A list row: a Book row without a chevron: cover, title, the author and the place line (or the download's line),
 * the marks as muted icons on the right edge; it opens the book.
 */
function WorkRow({ work, onOpen }: { work: LibraryWork; onOpen: () => void }) {
  const marks = coverMarks(work);
  const kinds = marks.kind === "downloading" ? [{ kind: "audiobook" as const }] : marks.marks.map((mark) => ({ kind: MARK_KIND[mark], name: COVER_MARK_NAMES[mark] }));
  return <BookRow title={work.title} status={listRowLine(work)} cover={work.cover || null} edgeMarks={kinds} onClick={onOpen} />;
}

/**
 * The sort-and-view Picker: Sort as choice rows, View as a Segmented control and the Shelf group, whose row opens
 * its own short list (All shelves, Want to read, Reading, Finished). Every choice applies at once; Done, Escape or a
 * tap outside closes it.
 */
function SortAndView({
  open,
  onClose,
  anchor,
  sort,
  setSort,
  view,
  setView,
  shelf,
  setShelf,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLButtonElement | null>;
  sort: SortOrder;
  setSort: (sort: SortOrder) => void;
  view: LibraryView;
  setView: (view: LibraryView) => void;
  shelf: ShelfFilter;
  setShelf: (shelf: ShelfFilter) => void;
}) {
  const [second, setSecond] = useState<"shelf" | null>(null);
  useEffect(() => {
    if (!open) setSecond(null);
  }, [open]);
  const sub =
    second === "shelf"
      ? {
          title: "Shelf",
          onBack: () => setSecond(null),
          content: <PickerChoices label="Shelf" options={shelfChoices()} value={shelf} onChoose={(next) => { setShelf(next); setSecond(null); }} />,
        }
      : null;
  return (
    <PickerDialog open={open} title="Sort and view" onClose={onClose} anchor={anchor} sub={sub} className="library-picker">
      <PickerGroup caption="Sort">
        <PickerChoices label="Sort" options={SORT_ORDERS.map((value) => ({ value, label: SORT_NAMES[value] }))} value={sort} onChoose={setSort} />
      </PickerGroup>
      <PickerGroup caption="View">
        <Segmented<LibraryView> label="View" options={[{ value: "grid", label: "Grid" }, { value: "list", label: "List" }]} value={view} onChange={setView} />
      </PickerGroup>
      <PickerGroup caption="Shelf">
        <PickerRows>
          <PickerRow label="Shelf" value={SHELF_NAMES[shelf]} onOpen={() => setSecond("shelf")} />
        </PickerRows>
      </PickerGroup>
    </PickerDialog>
  );
}

/**
 * Continue: the book In progress with the newest place, its place line and how far, and Play for its chosen
 * recording (the player's own Pause while it plays). A book read in the reader opens its Book page.
 */
function ContinueCard({ work, books, onOpen }: { work: LibraryWork; books: Book[]; onOpen: () => void }) {
  const player = usePlayer();
  const recording = chosenRecording(work);
  const book = recording ? books.find((b) => b.recordingId === recording.recordingId && b.tracks.length > 0) ?? null : null;
  const active = !!book && player.book?.id === book.id;
  return (
    <section className="library-continue" aria-label="Continue">
      <button type="button" className="library-continue-open" onClick={onOpen} aria-label={`Continue ${work.title}`}>
        <span className="library-continue-cover" aria-hidden="true">
          <Cover src={work.cover} title={work.title} workId={work.workId} />
        </span>
        <span className="library-continue-text">
          <span className="type-caption library-continue-label">Continue</span>
          <span className="library-continue-title type-body">{work.title}</span>
          <span className="library-continue-line type-label">{listLine(work)}</span>
          <ProgressBar progress={progressFraction(work)} />
        </span>
      </button>
      {book && (
        <button
          type="button"
          className="library-continue-play"
          aria-label={active && player.playing ? "Pause" : "Play"}
          onClick={() => (active ? player.toggle() : void player.play(book))}
        >
          {active && player.loading ? <Loader2 size={20} className="spin" /> : active && player.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
      )}
    </section>
  );
}
