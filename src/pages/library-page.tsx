// The Library (#577, spec #572 "The Library"; boards Library.dc.html, LibraryList.dc.html, DesktopLibrary.dc.html):
// the library by work (#528) with this device's newer places, one tile per work. The head (Title, Search, the plus),
// Continue, the chips (the Series chip's list is #567's), the heading named by the chip, and the tiles with the cover
// marks of #556 or the list rows with the Book page's place line. What it shows is in library-filter.ts; the sort
// select, the view toggle and the Hardcover strip stay as they were until the sort-and-view control (ticket 06).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play, Search, Plus, X, Grid2X2, List, SlidersHorizontal, ChevronDown, Loader2 } from "lucide-react";
import { HardcoverLibraryFilters, type HardcoverFilter } from "../components/Hardcover";
import { coverMarks, COVER_MARK_NAMES, type CoverMark, type CoverMarks } from "../cover-marks";
import { Button } from "../parts/Button";
import { Chip } from "../parts/Chip";
import { FileIcon, type FileKind } from "../parts/icons";
import { ProgressBar } from "../parts/ProgressBar";
import { usePlayer } from "../player";
import type { Book, LibraryWork } from "../types";
import { chosenRecording } from "./book-model";
import {
  ALL_CHIP,
  chipLabel,
  continueShown,
  continueWork,
  emptyShelf,
  filterLibrary,
  LIBRARY_CHIPS,
  listLine,
  progressFraction,
  readSort,
  shelfHeading,
  sortLibrary,
  type LibraryChip,
} from "./library-filter";
import { SeriesList } from "./library-series";
import { SERIES_CHIP, type SavedSeriesItem } from "./library-series-model";
import type { Notify, Page } from "./shared";
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
  hardcoverFilter,
  setHardcoverFilter,
  savedSeries,
  openSeries,
  findSeries,
  beside,
  favorites,
  onDevice,
  openWork,
  navigate,
  refresh,
  notify,
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
  view: "grid" | "list";
  setView: (view: "grid" | "list") => void;
  sort: string;
  setSort: (sort: string) => void;
  hardcoverFilter: HardcoverFilter;
  setHardcoverFilter: (filter: HardcoverFilter) => void;
  /** `GET /api/series`, for the Series chip (#567). */
  savedSeries: { items: SavedSeriesItem[] | undefined; error: string };
  openSeries: (id: number) => void;
  findSeries: () => void;
  /** A desktop's `#series/<id>`: the Series chip's list with this series beside it (DesktopSeries.dc.html). */
  beside?: { id: number; page: ReactNode } | null;
  /** The favourites by work. */
  favorites: string[];
  /** Works kept on this device and complete. */
  onDevice: ReadonlySet<string>;
  /** Opens `#book/<workId>`. */
  openWork: (workId: string) => void;
  navigate: (page: Page) => void;
  refresh: () => Promise<void>;
  notify: Notify;
}) {
  // On a phone Search opens a field in place of the Title row; on a desktop the field is always there.
  const [searching, setSearching] = useState(() => query !== "");
  const field = useRef<HTMLInputElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (searching && opened.current) field.current?.focus();
    opened.current = true;
  }, [searching]);
  // The Series chip is chosen, or a desktop shows a series beside its list: the list stands in place of the shelf.
  const chip: LibraryChip = beside ? SERIES_CHIP : filter;
  const seriesShown = chip === SERIES_CHIP;
  const choose = (next: LibraryChip) => {
    setFilter(next);
    // Beside a series the Library is at the series' address: a chip shows the Library again in its place.
    if (beside) navigate("library");
  };
  const input = { chip, query, favorites, onDevice, hardcover: hardcoverFilter };
  const shown = sortLibrary(filterLibrary(works, input), readSort(sort));
  const featured = continueShown(chip, query, hardcoverFilter) ? continueWork(works) : null;
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };
  const clear = () => {
    setFilter(ALL_CHIP);
    closeSearch();
    setHardcoverFilter({ shelf: "all", list: "all" });
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
          <Button className="library-add" icon={<Plus size={20} />} label="Add a book" onClick={() => navigate("discover")}>
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
            <div className="library-shelf-controls">
              <label className="sort-control">
                <SlidersHorizontal size={14} />
                <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort books">
                  <option value="recent">Recently added</option>
                  <option value="title">Title</option>
                  <option value="author">Author</option>
                  <option value="progress">Progress</option>
                </select>
                <ChevronDown size={13} />
              </label>
              <div className="view-toggle">
                <button aria-label="Grid view" aria-pressed={view === "grid"} className={view === "grid" ? "selected" : ""} onClick={() => setView("grid")}>
                  <Grid2X2 size={16} />
                </button>
                <button aria-label="List view" aria-pressed={view === "list"} className={view === "list" ? "selected" : ""} onClick={() => setView("list")}>
                  <List size={18} />
                </button>
              </div>
            </div>
          </div>
          <HardcoverLibraryFilters
            filter={hardcoverFilter}
            onFilter={setHardcoverFilter}
            onSettings={() => navigate("settings")}
            onChanged={refresh}
            notify={notify}
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
              <ul className="library-list" aria-label={shelfHeading(chip)}>
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
                <Button kind="primary" onClick={() => navigate("discover")}>
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
          {work.cover ? <img src={work.cover} alt="" loading="lazy" decoding="async" /> : <span className="library-cover-title">{work.title}</span>}
          <MarksPill marks={marks} />
        </span>
        <span className="library-tile-title type-label">{work.title}</span>
        <span className="library-tile-author">{work.author}</span>
      </button>
    </li>
  );
}

/** A list row: cover, title, the author and the place line (or the download's line), the marks muted on the right. */
function WorkRow({ work, onOpen }: { work: LibraryWork; onOpen: () => void }) {
  const marks = coverMarks(work);
  const line = listLine(work);
  const downloading = marks.kind === "downloading";
  return (
    <li className="library-row" data-work={work.workId}>
      <button type="button" className="library-row-open" onClick={onOpen} aria-label={`About ${work.title}`}>
        <span className="library-row-cover" aria-hidden="true">
          {work.cover && <img src={work.cover} alt="" loading="lazy" decoding="async" />}
        </span>
        <span className="library-row-text">
          <span className="library-row-title type-body">{work.title}</span>
          <span className="library-row-line type-label">{downloading || !work.author ? line : `${work.author} · ${line}`}</span>
        </span>
        <span className="library-row-marks">
          {marks.kind === "downloading" ? (
            <FileIcon kind="audiobook" size={12} name="Audiobook" />
          ) : (
            marks.marks.map((mark) => <FileIcon key={mark} kind={MARK_KIND[mark]} size={12} name={COVER_MARK_NAMES[mark]} />)
          )}
        </span>
      </button>
    </li>
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
          {work.cover ? <img src={work.cover} alt="" /> : <span className="library-cover-title">{work.title}</span>}
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
