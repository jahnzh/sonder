import { useState } from "react";
import {
  Search,
  Plus,
  ArrowRight,
  ChevronDown,
  Play,
  Pause,
  Check,
  Grid2X2,
  List,
  SlidersHorizontal,
  WifiOff,
  MoreHorizontal,
  Heart,
  CheckCheck,
  BookOpen,
  Trash2,
  Loader2,
  ArrowDownToLine,
} from "lucide-react";
import { usePlayer } from "../player";
import { SeriesLibrary, type SeriesTarget } from "../components/Series";
import {
  HardcoverLibraryFilters,
  type HardcoverFilter,
} from "../components/Hardcover";
import { listeningChapters } from "../chapters";
import { isAdmin, duration, percent } from "../lib";
import type { Book } from "../types";
import { type Page, type Notify, ListenButton, Empty } from "./shared";

export type LibraryAction = "add" | "remove" | "finished" | "unread";

export function LibraryPage({
  admin,
  visible,
  featured,
  listening,
  query,
  showFavorites,
  filter,
  setFilter,
  view,
  setView,
  sort,
  setSort,
  hardcoverFilter,
  setHardcoverFilter,
  loading,
  setLoading,
  loadError,
  seriesRevision,
  setSeriesTarget,
  setDetail,
  setImportOpen,
  favorites,
  toggleFavorite,
  downloaded,
  findAudio,
  mutateLibrary,
  refresh,
  navigate,
  notify,
}: {
  admin: boolean;
  visible: Book[];
  featured: Book | undefined;
  listening: Book[];
  query: string;
  showFavorites: boolean;
  filter: string;
  setFilter: (filter: string) => void;
  view: "grid" | "list";
  setView: (view: "grid" | "list") => void;
  sort: string;
  setSort: (sort: string) => void;
  hardcoverFilter: HardcoverFilter;
  setHardcoverFilter: (filter: HardcoverFilter) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  loadError: string;
  seriesRevision: number;
  setSeriesTarget: (target: SeriesTarget) => void;
  setDetail: (b: Book) => void;
  setImportOpen: (open: boolean) => void;
  favorites: string[];
  toggleFavorite: (id: string) => void;
  downloaded: (b: Book) => boolean;
  findAudio: (b: Book) => void;
  mutateLibrary: (b: Book, action: LibraryAction) => Promise<void>;
  refresh: () => Promise<void>;
  navigate: (p: Page) => void;
  notify: Notify;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            {showFavorites ? "Your favorites" : "Your library"}
            <span className="heading-dot">.</span>
          </h1>
        </div>
        {admin && <button
          className="button primary"
          onClick={() => setImportOpen(true)}
        >
          <Plus size={17} /> Add audiobook
        </button>}
      </div>
      {!query && !showFavorites && <SeriesLibrary revision={seriesRevision} onOpen={(id) => setSeriesTarget({ id, mode: "saved" })} />}
      {!query &&
        !showFavorites &&
        filter === "All books" &&
        featured && (
          <Feature
            book={featured}
            onDetail={() => setDetail(featured)}
            downloaded={downloaded(featured)}
          />
        )}
      <section className="library-section">
        <div className="section-heading">
          <h2>
            {query
              ? "Search results"
              : showFavorites
                ? "Saved for a reason"
                : "On your bookshelf"}
            <span>{visible.length}</span>
          </h2>
          <div className="view-toggle">
            <button
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              className={view === "grid" ? "selected" : ""}
              onClick={() => setView("grid")}
            >
              <Grid2X2 size={16} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={view === "list"}
              className={view === "list" ? "selected" : ""}
              onClick={() => setView("list")}
            >
              <List size={18} />
            </button>
          </div>
        </div>
        <div className="library-toolbar">
          <div
            className="filter-tabs"
            role="tablist"
            aria-label="Filter your library"
          >
            {[
              "All books",
              "Listening",
              "Not started",
              "Finished",
              "Downloaded",
            ].map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                className={filter === f ? "selected" : ""}
                onClick={() => setFilter(f)}
              >
                {f}
                {f === "Listening" && listening.length > 0 && (
                  <span>{listening.length}</span>
                )}
              </button>
            ))}
          </div>
          <label className="sort-control">
            <SlidersHorizontal size={14} />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              aria-label="Sort books"
            >
              <option value="recent">Recently added</option>
              <option value="title">Title A–Z</option>
              <option value="author">Author A–Z</option>
              <option value="progress">Listening progress</option>
            </select>
            <ChevronDown size={13} />
          </label>
        </div>
        <HardcoverLibraryFilters
          filter={hardcoverFilter}
          onFilter={setHardcoverFilter}
          onSettings={() => navigate("settings")}
          onChanged={refresh}
          notify={notify}
        />
        {loading ? (
          <LoadingBooks />
        ) : loadError ? (
          <Empty
            icon={WifiOff}
            title="Your library is taking a moment"
            text={loadError}
            action={
              <button
                className="button primary"
                onClick={() => {
                  setLoading(true);
                  void refresh();
                }}
              >
                Try again
              </button>
            }
          />
        ) : visible.length ? (
          <div className={`books-${view}`}>
            {visible.map((b) => (
              <BookCard
                key={b.id}
                book={b}
                onDetail={() => setDetail(b)}
                onFindAudio={() => findAudio(b)}
                favorite={favorites.includes(b.id)}
                onFavorite={() => toggleFavorite(b.id)}
                downloaded={downloaded(b)}
                onAction={(action) => void mutateLibrary(b, action)}
              />
            ))}
          </div>
        ) : (
          <Empty
            icon={showFavorites ? Heart : Search}
            title={
              query
                ? "No books found"
                : showFavorites
                  ? "No favorites"
                  : "No books"
            }
            text={
              query
                ? "Try another title, author, or genre."
                : showFavorites
                  ? "Tap the heart on any book to save it here."
                  : "Add an audiobook or browse available titles."
            }
            action={
              !query &&
              !showFavorites && (
                <button
                  className="button primary"
                  onClick={() => navigate("discover")}
                >
                  Browse audiobooks <ArrowRight size={16} />
                </button>
              )
            }
          />
        )}
      </section>
    </>
  );
}
function Feature({
  book,
  onDetail,
  downloaded,
}: {
  book: Book;
  onDetail: () => void;
  downloaded: boolean;
}) {
  const progress = percent(book);
  return (
    <section className="feature">
      <div className="feature-copy">
        <button className="feature-title" onClick={onDetail}>
          <h2>{book.title}</h2>
        </button>
        <p className="feature-author">
          {book.author} <span>·</span> Narrated by {book.narrator}
        </p>
        <div className="feature-progress-info">
          {book.progress ? (
            <>
              <span>{progress}% complete</span>
              <span>
                {duration(book.duration * (1 - progress / 100))} remaining
              </span>
            </>
          ) : (
            <span>
              {listeningChapters(book).length} chapters <i />{" "}
              {duration(book.duration)}
            </span>
          )}
        </div>
        {book.progress && (
          <div className="feature-progress">
            <i style={{ width: `${progress}%` }} />
          </div>
        )}
        <div className="feature-actions">
          <ListenButton book={book} />
          <button className="feature-details" onClick={onDetail}>
            About this book <ArrowRight size={16} />
          </button>
        </div>
        {downloaded && <span className="feature-source"><Check size={12} /> Available offline</span>}
      </div>
      <div className="feature-art">
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <div className="orbit orbit-three" />
        <span className="spark spark-one">✦</span>
        <span className="spark spark-two">✧</span>
        <span className="spark spark-three">✦</span>
        <button className="hero-book" onClick={onDetail}>
          <img src={book.cover} alt={book.title} />
          <span />
        </button>
      </div>
    </section>
  );
}
function BookCard({
  book: b,
  onDetail,
  favorite,
  onFavorite,
  downloaded,
  onAction,
  onFindAudio,
}: {
  onFindAudio: () => void;
  book: Book;
  onDetail: () => void;
  favorite: boolean;
  onFavorite: () => void;
  downloaded: boolean;
  onAction: (action: "finished" | "remove" | "unread") => void;
}) {
  const p = usePlayer();
  const [menu, setMenu] = useState(false);
  const progress = percent(b);
  const active = p.book?.id === b.id;
  return (
    <article className="book-card">
      <div className="book-cover-container">
        <button
          className="book-cover"
          onClick={onDetail}
          aria-label={`About ${b.title}`}
        >
          <img src={b.cover} alt={b.title} loading="lazy" />
        </button>
        {downloaded && (
          <span className="offline-badge" title="Available offline">
            <ArrowDownToLine size={12} />
          </span>
        )}
        <button
          className={`book-heart ${favorite ? "favorited" : ""}`}
          onClick={onFavorite}
          aria-label={`${favorite ? "Remove" : "Add"} ${b.title} ${favorite ? "from" : "to"} favorites`}
        >
          <Heart size={16} fill={favorite ? "currentColor" : "none"} />
        </button>
        {(b.tracks.length > 0 || isAdmin()) &&         <button
          className={`card-play ${active && p.playing ? "playing" : ""}`}
          aria-label={`${!b.tracks.length ? "Find audio for" : active && p.playing ? "Pause" : "Play"} ${b.title}`}
          onClick={() =>
            !b.tracks.length
              ? onFindAudio()
              : active
                ? p.toggle()
                : void p.play(b)
          }
        >
          {!b.tracks.length ? (
            <Search size={17} />
          ) : active && p.loading ? (
            <Loader2 size={20} className="spin" />
          ) : active && p.playing ? (
            <Pause size={18} fill="currentColor" />
          ) : (
            <Play size={18} fill="currentColor" />
          )}
        </button>}
        {b.status === "finished" && (
          <span className="finished-badge">
            <Check size={12} /> Finished
          </span>
        )}
      </div>
      <div className="book-card-content">
        <div className="book-title-row">
          <button className="book-title" onClick={onDetail}>
            {b.title}
          </button>
          <div className="book-menu-wrap">
            <button
              className="book-more icon-button"
              aria-label={`More options for ${b.title}`}
              onClick={() => setMenu(!menu)}
              aria-expanded={menu}
            >
              <MoreHorizontal size={17} />
            </button>
            {menu && (
              <>
                <button
                  className="menu-backdrop"
                  onClick={() => setMenu(false)}
                  aria-label="Close book options"
                />
                <div className="book-menu">
                  <button
                    onClick={() => {
                      onDetail();
                      setMenu(false);
                    }}
                  >
                    <BookOpen size={14} /> Book details
                  </button>
                  <button
                    onClick={() => {
                      onAction(b.status === "finished" ? "unread" : "finished");
                      setMenu(false);
                    }}
                  >
                    <CheckCheck size={14} />
                    {b.status === "finished"
                      ? "Mark not started"
                      : "Mark finished"}
                  </button>
                  <button
                    onClick={() => {
                      onAction("remove");
                      setMenu(false);
                    }}
                  >
                    <Trash2 size={14} /> Remove from library
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <p className="book-author">{b.author}</p>
        <div className="book-meta">
          <span>{b.tracks.length ? duration(b.duration) : "No audio yet"}</span>
          <i />
          <span>{b.genre}</span>
          {b.language && (
            <>
              <i />
              <span>{b.language}</span>
            </>
          )}
        </div>
        {b.hardcover?.series[0] && (
          <div className="hardcover-series-label">
            {b.hardcover.series[0].name}
            {b.hardcover.series[0].position !== null
              ? ` · #${b.hardcover.series[0].position}`
              : ""}
          </div>
        )}
        {b.hardcover && (
          <div className="hardcover-book-label">
            <BookOpen size={10} />
            {b.hardcover.statusId === 4
              ? "Paused"
              : b.hardcover.statusId === 5
                ? "Did not finish"
                : "Hardcover"}
            {b.hardcover.pending || b.hardcover.progressPending
              ? " · queued"
              : ""}
          </div>
        )}
        {b.status === "listening" ? (
          <div className="book-progress">
            <div>
              <i style={{ width: `${Math.max(1, progress)}%` }} />
            </div>
            <span>{progress}%</span>
          </div>
        ) : (
          <div
            className={`book-status ${b.status === "finished" ? "finished" : ""}`}
          >
            <span className="small-dot" />
            {b.status === "finished" ? "Finished" : "Not started yet"}
          </div>
        )}
      </div>
    </article>
  );
}
function LoadingBooks() {
  return (
    <div className="books-grid">
      {Array.from({ length: 6 }, (_, i) => (
        <div className="book-skeleton" key={i}>
          <div />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
