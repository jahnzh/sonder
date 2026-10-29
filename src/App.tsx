import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
} from "react";
import {
  Library,
  Compass,
  Download,
  Settings,
  Search,
  Plus,
  ArrowUpRight,
  ArrowRight,
  ChevronRight,
  ChevronDown,
  Headphones,
  Play,
  Pause,
  Check,
  Grid2X2,
  List,
  SlidersHorizontal,
  Upload,
  Cloud,
  Wifi,
  WifiOff,
  ShieldCheck,
  MoreHorizontal,
  X,
  Heart,
  CheckCheck,
  BookOpen,
  Trash2,
  Loader2,
  ArrowDownToLine,
  FolderOpen,
  Link2,
  ExternalLink,
  LogOut,
  RefreshCw,
  Volume2,
  Music2,
  HardDrive,
  Menu,
  CircleUserRound,
  KeyRound,
  UsersRound,
} from "lucide-react";
import { PlayerProvider, usePlayer } from "./player";
import { ReleasePicker } from "./components/ReleasePicker";
import { ProwlarrSettings } from "./components/ProwlarrSettings";
import { AppearanceSettings } from "./components/Appearance";
import { KeyboardHelpButton } from "./components/KeyboardHelp";
import { PlaybackSettings } from "./components/PlaybackSettings";
import { MediaManager } from "./components/MediaManager";
import {ReaderShortcut} from "./components/ReaderShortcut";
import { ReaderHost } from "./components/Reader";
import {
  api,
  loadBooks,
  localDB,
  authDB,
  selectUserStorage,
  isAdmin,
  duration,
  bytes,
  percent,
  downloadTrack,
  deleteDownloads,
  getDownloadedBlob,
  clock,
} from "./lib";
import type {
  Book,
  Download as DownloadRecord,
  Progress,
  Settings as SettingsData,
  Acquisition,
  DownloadPart,
} from "./types";
import { Dialog } from "./components/ui/dialog";
import { SignIn, type Account } from "./components/SignIn";
import { PlayerDock } from "./components/Player";
import { AppUpdate } from "./components/AppUpdate";
import { DeviceReset } from "./components/DeviceReset";
import { Chapters } from "./components/Chapters";
import {
  HardcoverBookTools,
  HardcoverSyncSettings,
  HardcoverLibraryFilters,
  hardcoverChanged,
  type HardcoverFilter,
} from "./components/Hardcover";
import { listeningChapters } from "./chapters";
import {
  AcquisitionQueue,
  EbookDiscovery,
  SourceSettings,
} from "./components/SourceWorkflow";
type Page = "library" | "discover" | "downloads" | "settings";
type Notice = { text: string; error?: boolean };
const nav = [
  { id: "library", label: "My library", icon: Library },
  { id: "discover", label: "Discover", icon: Compass },
  { id: "downloads", label: "Downloads", icon: Download },
] as const;
function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
function App() {
  const [user, setUser] = useState<Account | null>(null);
  const [auth, setAuth] = useState<boolean | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  useEffect(() => {
    void api<{ authenticated: boolean; required: boolean; user: Account | null }>("/auth/status")
      .then((r) => {
        if (r.user) selectUserStorage(r.user.id, r.user.role);
        if (r.user) window.dispatchEvent(new Event("sonder:authenticated"));
        setUser(r.user);
        setAuth(r.authenticated);
        setNeedsPassword(r.required);
        void authDB.preferences.put({ key: "auth", value: r });
      })
      .catch(() => {
        void authDB.preferences.get("auth").then((row) => {
          const state = row?.value as
            | { required?: boolean; authenticated?: boolean; user?: Account }
            | undefined;
          if (state?.user) { selectUserStorage(state.user.id, state.user.role); setUser(state.user); }
          setAuth(state?.authenticated === true);
          setNeedsPassword(state?.required !== false);
        });
      });
    const unauthorized = () => {
      setAuth(false);
      setNeedsPassword(true);
      void authDB.preferences.put({
        key: "auth",
        value: { required: true, authenticated: false },
      });
    };
    window.addEventListener("sonder:unauthorized", unauthorized);
    return () =>
      window.removeEventListener("sonder:unauthorized", unauthorized);
  }, []);
  if (auth === null)
    return (
      <div className="app-loading">
        <Mark />
        <span>Loading…</span>
      </div>
    );
  if (!auth) return <SignIn onLogin={(account) => { setUser(account); setAuth(true); }} />;
  return (
    <LibraryApp user={user || { id: 1, username: "admin", role: "admin" }} needsPassword={needsPassword} onLogout={() => setAuth(false)} />
  );
}
function LibraryApp({
  user,
  needsPassword,
  onLogout,
}: {
  user: Account;
  needsPassword: boolean;
  onLogout: () => void;
}) {
  const [books, setBooks] = useState<Book[]>([]);
  const [ebookTarget, setEbookTarget] = useState<Book | null>(null);
  const [page, setPage] = useState<Page>(() => {
    const hash = location.hash.slice(1);
    return ["library", "discover", "downloads", "settings"].includes(hash)
      ? (hash as Page)
      : "library";
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All books");
  const [hardcoverFilter, setHardcoverFilter] = useState<HardcoverFilter>({
    shelf: "all",
    list: "all",
  });
  const [audioTarget, setAudioTarget] = useState<Book | null>(null);
  const [sort, setSort] = useState("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [showFavorites, setShowFavorites] = useState(false);
  const [detail, setDetail] = useState<Book | null>(null);
  const [mediaTarget,setMediaTarget]=useState<Book|null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [downloadParts, setDownloadParts] = useState<DownloadPart[]>([]);
  const [downloadJobs, setDownloadJobs] = useState<
    Record<string, { progress: number; chapter: number; total: number }>
  >({});
  const [online, setOnline] = useState(navigator.onLine);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [installPrompt, setInstallPrompt] = useState<
    (Event & { prompt: () => Promise<void> }) | null
  >(null);
  const controllers = useRef(new Map<string, AbortController>());
  const notify = useCallback(
    (text: string, error = false) => setNotice({ text, error }),
    [],
  );
  const refreshDownloads = useCallback(async () => {
    const items = await localDB.downloads.toArray();
    const valid: DownloadRecord[] = [];
    for (const item of items) {
      if (await getDownloadedBlob(item.trackId)) {
        const { blob, ...metadata } = item;
        valid.push(metadata);
      }
    }
    setDownloads(valid);
    setDownloadParts(await localDB.downloadParts.toArray());
  }, []);
  const refresh = useCallback(async () => {
    try {
      setLoadError("");
      setBooks(await loadBooks());
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  const refreshSettings = useCallback(
    () =>
      void api<SettingsData>("/settings")
        .then(setSettings)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void refresh();
    void refreshDownloads();
    refreshSettings();
    void localDB.preferences.get("favorites").then((p) => {
      if (Array.isArray(p?.value)) setFavorites(p.value);
    });
    const status = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) {
        void refresh();
        refreshSettings();
      }
    };
    const changed = () => void refresh();
    const downloadsChanged = () => void refreshDownloads();
    const visible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        void refreshDownloads();
      }
    };
    const hash = () => {
      const p = location.hash.slice(1);
      if (["library", "discover", "downloads", "settings"].includes(p))
        setPage(p as Page);
    };
    const install = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as Event & { prompt: () => Promise<void> });
    };
    window.addEventListener("online", status);
    window.addEventListener("offline", status);
    window.addEventListener("hashchange", hash);
    window.addEventListener("sonder:library-changed", changed);
    window.addEventListener("sonder:hardcover-changed", changed);
    window.addEventListener("sonder:downloads-changed", downloadsChanged);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("beforeinstallprompt", install);
    return () => {
      window.removeEventListener("online", status);
      window.removeEventListener("offline", status);
      window.removeEventListener("hashchange", hash);
      window.removeEventListener("sonder:library-changed", changed);
      window.removeEventListener("sonder:hardcover-changed", changed);
      window.removeEventListener("sonder:downloads-changed", downloadsChanged);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("beforeinstallprompt", install);
    };
  }, [refresh, refreshDownloads, refreshSettings]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const navigate = (p: Page) => {
    setEbookTarget(null);
    setAudioTarget(null);
    setHardcoverFilter({ shelf: "all", list: "all" });
    setPage(p);
    location.hash = p;
    setQuery("");
    setSidebarOpen(false);
    setShowFavorites(false);
    if (p === "library" || p === "discover") void refresh();
  };
  const onProgress = useCallback(
    (p: Progress) =>
      setBooks((current) =>
        current.map((b) =>
          b.recordingId === p.recordingId
            ? {
                ...b,
                progress: p,
                status: b.status === "unread" ? "listening" : b.status,
              }
            : b,
        ),
      ),
    [],
  );
  const mutateLibrary = async (
    b: Book,
    action: "add" | "remove" | "finished" | "unread",
  ) => {
    try {
      if (action === "add")
        await api("/library", {
          method: "POST",
          body: JSON.stringify({ bookId: b.id }),
        });
      else if (action === "remove")
        await api(`/library/${b.id}`, { method: "DELETE" });
      else
        await api(`/library/${b.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: action }),
        });
      await refresh();
      setDetail((d) =>
        d?.id === b.id
          ? {
              ...d,
              inLibrary: action !== "remove",
              status:
                action === "finished"
                  ? "finished"
                  : action === "unread"
                    ? "unread"
                    : d.status,
            }
          : d,
      );
      notify(
        action === "add"
          ? "Added to library."
          : action === "remove"
            ? "Book removed from your library."
            : action === "finished"
              ? "Marked as finished."
              : "Marked as not started.",
      );
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const toggleFavorite = (id: string) => {
    setFavorites((current) => {
      const next = current.includes(id)
        ? current.filter((v) => v !== id)
        : [...current, id];
      void localDB.preferences.put({ key: "favorites", value: next });
      return next;
    });
  };
  const startDownload = async (b: Book) => {
    if (controllers.current.has(b.recordingId)) return;
    if (!b.tracks.length) {
      notify("This book has no audio to download yet.", true);
      return;
    }
    const ctrl = new AbortController();
    controllers.current.set(b.recordingId, ctrl);
    try {
      await navigator.storage?.persist?.().catch(() => false);
      for (let i = 0; i < b.tracks.length; i++) {
        setDownloadJobs((j) => ({
          ...j,
          [b.recordingId]: {
            progress: (i / b.tracks.length) * 100,
            chapter: i + 1,
            total: b.tracks.length,
          },
        }));
        await downloadTrack(b.tracks[i], ctrl.signal, (loaded, total) =>
          setDownloadJobs((j) => ({
            ...j,
            [b.recordingId]: {
              progress:
                ((i + (total ? loaded / total : 0)) / b.tracks.length) * 100,
              chapter: i + 1,
              total: b.tracks.length,
            },
          })),
        );
        await refreshDownloads();
      }
      notify(`“${b.title}” is ready for wherever you go.`);
    } catch (e) {
      notify(
        ctrl.signal.aborted
          ? "Download paused. Downloaded sections are kept; resume whenever you’re ready."
          : (e as Error).message,
        !ctrl.signal.aborted,
      );
      await refreshDownloads();
    } finally {
      controllers.current.delete(b.recordingId);
      setDownloadJobs((j) => {
        const next = { ...j };
        delete next[b.recordingId];
        return next;
      });
    }
  };
  const libraryBooks = books.filter((b) => b.inLibrary);
  const downloaded = (b: Book) =>
    b.tracks.length > 0 &&
    b.tracks.every((t) => downloads.some((d) => d.trackId === t.id));
  let visible = (page === "discover" ? books : libraryBooks)
    .filter((b) => !showFavorites || favorites.includes(b.id))
    .filter(
      (b) =>
        !query ||
        `${b.title} ${b.author} ${b.genre}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  if (page === "library")
    visible = visible.filter(
      (b) =>
        filter === "All books" ||
        (filter === "Listening" && b.status === "listening") ||
        (filter === "Not started" && b.status === "unread") ||
        (filter === "Finished" && b.status === "finished") ||
        (filter === "Downloaded" && downloaded(b)),
    );
  if (page === "library")
    visible = visible.filter(
      (b) =>
        (hardcoverFilter.shelf === "all" ||
          (hardcoverFilter.shelf === "linked"
            ? !!b.hardcover
            : b.hardcover?.statusId === Number(hardcoverFilter.shelf))) &&
        (hardcoverFilter.list === "all" ||
          b.hardcover?.listIds.includes(Number(hardcoverFilter.list))),
    );
  const findAudio = (b: Book) => {
    setDetail(null);
    navigate("discover");
    setAudioTarget(b);
    setQuery(b.title);
  };
  visible.sort((a, b) =>
    sort === "title"
      ? a.title.localeCompare(b.title)
      : sort === "author"
        ? a.author.localeCompare(b.author)
        : sort === "progress"
          ? percent(b) - percent(a)
          : b.addedAt - a.addedAt,
  );
  const listening = libraryBooks
    .filter((b) => b.status === "listening")
    .sort(
      (a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0),
    );
  const featured =
    listening.find((b) => b.tracks.length > 0 && !b.faults?.recording) ||
    libraryBooks.find((b) => b.tracks.length > 0 && !b.faults?.recording);
  const downloadBooks = books.filter(
    (b) =>
      downloads.some((d) => d.recordingId === b.recordingId) ||
      downloadParts.some(
        (d) => d.recordingId === b.recordingId && d.loaded > 0,
      ) ||
      downloadJobs[b.recordingId],
  );
  return (
    <PlayerProvider
      onProgress={onProgress}
      fallback={detail?.tracks.length ? detail : featured}
      notify={notify}
    >
      <div className="app-shell">
        {sidebarOpen && (
          <button
            className="sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          />
        )}
        <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
          <button
            className="brand"
            onClick={() => navigate("library")}
            aria-label="Sonder home"
          >
            <Mark />
            sonder<span>®</span>
          </button>
          <nav className="main-nav" aria-label="Main navigation">
            {nav.map((n) => (
              <button
                key={n.id}
                className={page === n.id ? "selected" : ""}
                onClick={() => {
                  navigate(n.id);
                  setFilter("All books");
                }}
              >
                <n.icon size={20} strokeWidth={1.65} />
                <span>{n.label}</span>
                {n.id === "library" && <small>{libraryBooks.length}</small>}
                {n.id === "downloads" &&
                  Object.keys(downloadJobs).length > 0 && (
                    <span className="activity-dot" />
                  )}
              </button>
            ))}
          </nav>
          <div className="sidebar-section-label">
            YOUR SHELVES <BookOpen size={13} />
          </div>
          <nav className="shelf-nav" aria-label="Your shelves">
            <button
              className={showFavorites ? "selected" : ""}
              onClick={() => {
                navigate("library");
                setShowFavorites(true);
                setFilter("All books");
              }}
            >
              <Heart size={17} />
              <span>Favorites</span>
              <small>
                {libraryBooks.filter((b) => favorites.includes(b.id)).length}
              </small>
            </button>
            <button
              className={
                page === "library" && filter === "Finished" ? "selected" : ""
              }
              onClick={() => {
                navigate("library");
                setFilter("Finished");
              }}
            >
              <CheckCheck size={18} />
              <span>Finished books</span>
              <small>
                {libraryBooks.filter((b) => b.status === "finished").length}
              </small>
            </button>
          </nav>
          {user.role === "admin" && <button className="sidebar-add" onClick={() => setImportOpen(true)}>
            <Plus size={17} /> Add an audiobook
          </button>}
          <div className="sidebar-bottom">
            <button
              className={`settings-nav ${page === "settings" ? "selected" : ""}`}
              onClick={() => navigate("settings")}
            >
              <Settings size={19} />
              <span>Settings</span>
            </button>
            <div className="sidebar-footer">
              <span className={`status-dot ${online ? "" : "offline"}`} />
              {online ? "Online" : "Offline"}
              <span>v0.1</span>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="topbar-start">
              <button
                className="icon-button mobile-menu"
                aria-label="Open navigation"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu size={22} />
              </button>
              <span className="breadcrumb">
                <strong>
                  {page === "library"
                    ? "Library"
                    : page.charAt(0).toUpperCase() + page.slice(1)}
                </strong>
              </span>
            </div>
            <div className="topbar-end">
              {page !== "settings" && (
                <label className="search-input">
                  <Search size={17} />
                  <input
                    placeholder={
                      page === "discover"
                        ? "Search books…"
                        : "Search your library…"
                    }
                    aria-label={
                      page === "discover"
                        ? "Search audiobooks"
                        : "Search your library"
                    }
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query ? (
                    <button
                      className="icon-button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                    >
                      <X size={15} />
                    </button>
                  ) : (
                    <kbd>/</kbd>
                  )}
                </label>
              )}
              <span className="topbar-divider" />
              <button
                className="profile-button"
                onClick={() => navigate("settings")}
                aria-label="Open your settings"
              >
                {needsPassword ? user.username.charAt(0).toUpperCase() : "J"}<span />
              </button>
            </div>
          </header>
          <main className={`main-content page-${page}`}>
            {!online && (
              <div className="offline-banner">
                <WifiOff size={17} />
                <span>
                  You’re offline. Downloaded books are available.
                </span>
                <button onClick={() => navigate("downloads")}>
                  View downloads <ArrowRight size={14} />
                </button>
              </div>
            )}
            {page === "library" && (
              <>
                <div className="page-heading">
                  <div>
                    <h1>
                      {showFavorites ? "Your favorites" : "Your library"}
                      <span className="heading-dot">.</span>
                    </h1>
                  </div>
                  {user.role === "admin" && <button
                    className="button primary"
                    onClick={() => setImportOpen(true)}
                  >
                    <Plus size={17} /> Add audiobook
                  </button>}
                </div>
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
            )}
            {page === "discover" && (
              <Discover
                admin={user.role === "admin"}
                audioTarget={audioTarget}
                settings={settings}
                ebookTarget={ebookTarget}
                onQueued={() => {
                  void refresh();
                  navigate("downloads");
                }}
                books={visible}
                query={query}
                onQuery={setQuery}
                onDetail={setDetail}
                onAdd={(b) => void mutateLibrary(b, "add")}
                notify={notify}
                torboxConfigured={!!settings?.torboxConfigured}
                onConnect={() => navigate("settings")}
                refresh={refresh}
              />
            )}
            {page === "downloads" && (
              <>
                <div className="page-heading">
                  <div>
                    <h1>Downloads</h1>
                  </div>
                  <div className="quiet-tag">
                    <HardDrive size={15} />
                    {bytes(downloads.reduce((a, d) => a + d.size, 0))} stored
                  </div>
                </div>
                {user.role === "admin" && <AcquisitionQueue
                  onReady={refresh}
                  onOpenBook={(id) => {
                    const b = books.find((v) => v.id === id);
                    if (b) setDetail(b);
                    else {
                      void refresh();
                      notify(
                        "Your book is joining the library. Open it in a moment.",
                      );
                    }
                  }}
                  onBrowse={() => navigate("discover")}
                  notify={notify}
                />}
                <div className="section-heading download-device-heading">
                  <div>
                    <h2>On this device</h2>
                    <p className="queue-location">
                      <Download size={14} /> Saved here for listening without an
                      internet connection.
                    </p>
                  </div>
                </div>
                <StorageInfo downloads={downloads} />
                <section className="download-section">
                  <div className="section-heading">
                    <h2>
                      Your downloads <span>{downloadBooks.length}</span>
                    </h2>
                    <span className="muted small">Stored on this device</span>
                  </div>
                  {downloadBooks.length ? (
                    <div className="download-list">
                      {downloadBooks.map((b) => {
                        const files = downloads.filter(
                          (d) => d.recordingId === b.recordingId,
                        );
                        const job = downloadJobs[b.recordingId];
                        return (
                          <div className="download-row" key={b.id}>
                            <button
                              className="download-cover"
                              onClick={() => setDetail(b)}
                            >
                              <img src={b.cover} alt="" />
                            </button>
                            <div className="download-info">
                              <button
                                className="text-link"
                                onClick={() => setDetail(b)}
                              >
                                {b.title}
                              </button>
                              <p>{b.author}</p>
                              {job ? (
                                <>
                                  <div className="download-progress">
                                    <i style={{ width: `${job.progress}%` }} />
                                  </div>
                                  <small>
                                    Downloading chapter {job.chapter} of{" "}
                                    {job.total} · {Math.round(job.progress)}%
                                  </small>
                                </>
                              ) : (
                                <small
                                  className={
                                    downloaded(b) ? "download-complete" : ""
                                  }
                                >
                                  {downloaded(b) ? (
                                    <>
                                      <Check size={13} /> Ready for offline
                                      listening
                                    </>
                                  ) : (
                                    `${files.length} of ${b.tracks.length} chapters downloaded`
                                  )}{" "}
                                  <span>
                                    ·{" "}
                                    {bytes(
                                      files.reduce((a, d) => a + d.size, 0) +
                                        downloadParts
                                          .filter(
                                            (part) =>
                                              part.recordingId ===
                                              b.recordingId,
                                          )
                                          .reduce(
                                            (total, part) =>
                                              total + part.loaded,
                                            0,
                                          ),
                                    )}
                                  </span>
                                </small>
                              )}
                            </div>
                            <div className="download-actions">
                              <button className="button subtle" aria-label={`Manage versions and sources for ${b.title}`} onClick={()=>setMediaTarget(b)}>Manage versions</button>
                              {job ? (
                                <button
                                  className="button subtle"
                                  onClick={() =>
                                    controllers.current
                                      .get(b.recordingId)
                                      ?.abort()
                                  }
                                >
                                  <X size={15} /> Pause
                                </button>
                              ) : (
                                <>
                                  {downloaded(b) ? (
                                    <ListenButton book={b} compact />
                                  ) : (
                                    <button
                                      className="button subtle"
                                      onClick={() => void startDownload(b)}
                                    >
                                      <Download size={16} /> Finish download
                                    </button>
                                  )}
                                  <button
                                    className="icon-button delete-download"
                                    onClick={() => {
                                      void deleteDownloads(b.recordingId).then(
                                        () => {
                                          void refreshDownloads();
                                          notify(
                                            "Download removed from this device.",
                                          );
                                        },
                                      );
                                    }}
                                    aria-label={`Remove download of ${b.title}`}
                                  >
                                    <Trash2 size={17} />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <Empty
                      icon={Download}
                      title="No device downloads"
                      text="Download a book from your library for offline playback. Keep this tab open while downloading."
                      action={
                        <button
                          className="button primary"
                          onClick={() => navigate("library")}
                        >
                          Choose a book <ArrowRight size={16} />
                        </button>
                      }
                    />
                  )}
                </section>
                <div className="download-note">
                  <ShieldCheck size={20} />
                  <div>
                    <p>
                      Only complete chapters are marked as downloaded. Downloads
                      stay on this device; your listening progress syncs when
                      you’re back online.
                    </p>
                  </div>
                </div>
              </>
            )}
            {page === "settings" && (
              <SettingsPage
                user={user}
                settings={settings}
                onSaved={() => {
                  refreshSettings();
                  notify("Your settings are saved.");
                }}
                notify={notify}
                needsPassword={needsPassword}
                onLogout={onLogout}
                installPrompt={installPrompt}
                onInstall={() => {
                  if (installPrompt)
                    void installPrompt
                      .prompt()
                      .then(() => setInstallPrompt(null));
                }}
              />
            )}
          </main>
        </div>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {[...nav, { id: "settings", label: "Settings", icon: Settings }].map(
            (n) => (
              <button
                key={n.id}
                className={page === n.id ? "selected" : ""}
                onClick={() => navigate(n.id as Page)}
              >
                <n.icon size={20} />
                <span>{n.label}</span>
              </button>
            ),
          )}
        </nav>
        <AppUpdate />
        <PlayerDock
          books={books}
          notify={notify}
          fallback={featured}
          isDownloaded={downloaded}
          hasPartialDownload={(book) =>
            downloadParts.some(
              (part) =>
                part.recordingId === book.recordingId && part.loaded > 0,
            )
          }
          downloadJobs={downloadJobs}
          onDownload={(book) => void startDownload(book)}
          onPauseDownload={(book) =>
            controllers.current.get(book.recordingId)?.abort()
          }
          onViewDownloads={() => navigate("downloads")}
          onBookDetails={setDetail}
          onManageSources={setMediaTarget}
        />
        <ReaderHost books={books} notify={notify} />
        <MediaManager book={mediaTarget} books={books} onClose={()=>setMediaTarget(null)} onChanged={()=>{void refresh();void refreshDownloads();}} onDownload={book=>void startDownload(book)} onBookDetails={setDetail} notify={notify}/>
        {notice && (
          <div className={`toast ${notice.error ? "error" : ""}`} role="status">
            {notice.error ? <X size={18} /> : <Check size={18} />}
            <span>{notice.text}</span>
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setNotice(null)}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <BookDetail
          admin={user.role === "admin"}
          releases={
            detail
              ? books.filter(
                  (book) =>
                    book.workId === detail.workId &&
                    book.tracks.length > 0 &&
                    book.inLibrary,
                )
              : []
          }
          onRelease={setDetail}
          onManageSources={()=>{if(detail){setMediaTarget(detail);setDetail(null);}}}
          onFindAudio={() => detail && findAudio(detail)}
          onChanged={refresh}
          onSettings={() => {
            setDetail(null);
            navigate("settings");
          }}
          notify={notify}
          onKeepServer={() => {
            if (detail)
              void api(`/books/${detail.id}/keep`, { method: "POST" })
                .then(() => {
                  notify("Saving the audio to your server’s HDD.");
                  setDetail(null);
                  navigate("downloads");
                })
                .catch((e) => notify(e.message, true));
          }}
          onFindEbook={() => {
            if (detail) {
              const target = detail;
              setDetail(null);
              navigate("discover");
              setEbookTarget(target);
              setQuery(`${target.title} ${target.author}`);
            }
          }}
          book={
            detail && { ...detail, ...books.find((b) => b.id === detail.id) }
          }
          onClose={() => setDetail(null)}
          downloaded={detail ? downloaded(detail) : false}
          downloadJob={detail ? downloadJobs[detail.recordingId] : undefined}
          onDownload={() => detail && void startDownload(detail)}
          favorite={detail ? favorites.includes(detail.id) : false}
          onFavorite={() => detail && toggleFavorite(detail.id)}
          onAdd={() => detail && void mutateLibrary(detail, "add")}
          onRemove={() => detail && void mutateLibrary(detail, "remove")}
          downloads={downloads}
        />
        <ImportDialog
          onQueued={() => {
            setImportOpen(false);
            void refresh();
            navigate("downloads");
          }}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            void refresh();
            setImportOpen(false);
            notify("Audiobook imported.");
          }}
          notify={notify}
          torboxConfigured={!!settings?.torboxConfigured}
          onConnect={() => {
            setImportOpen(false);
            navigate("settings");
          }}
        />
      </div>
    </PlayerProvider>
  );
}
function ListenButton({
  onFindAudio,
  book,
  compact = false,
}: {
  book: Book;
  compact?: boolean;
  onFindAudio?: () => void;
}) {
  const p = usePlayer();
  const active = p.book?.id === book.id;
  if (!book.tracks.length && !isAdmin()) return null;
  if (!book.tracks.length)
    return (
      <button
        className={`button ${compact ? "subtle" : "primary"}`}
        onClick={onFindAudio}
      >
        <Search size={15} /> Find audio
      </button>
    );
  return (
    <button
      className={`button ${compact ? "subtle" : "primary"}`}
      onClick={() => (active ? p.toggle() : void p.play(book))}
    >
      {active && p.loading ? (
        <Loader2 size={16} className="spin" />
      ) : active && p.playing ? (
        <Pause size={16} fill="currentColor" />
      ) : (
        <Play size={15} fill="currentColor" />
      )}
      {active && p.playing
        ? "Pause"
        : book.progress
          ? "Continue listening"
          : "Start listening"}
    </button>
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
function BookDetail({
  admin,
  releases,
  onManageSources,
  onRelease,
  onFindAudio,
  onChanged,
  onSettings,
  notify,
  onKeepServer,
  onFindEbook,
  book: b,
  onClose,
  downloaded,
  downloadJob,
  onDownload,
  favorite,
  onFavorite,
  onAdd,
  onRemove,
  downloads,
}: {
  admin: boolean;
  releases: Book[];
  onManageSources:()=>void;
  onRelease: (book: Book) => void;
  onFindAudio: () => void;
  onChanged: () => void;
  onSettings: () => void;
  notify: (s: string, error?: boolean) => void;
  onKeepServer: () => void;
  onFindEbook: () => void;
  book: Book | null;
  onClose: () => void;
  downloaded: boolean;
  downloadJob?: { progress: number; chapter: number; total: number };
  onDownload: () => void;
  favorite: boolean;
  onFavorite: () => void;
  onAdd: () => void;
  onRemove: () => void;
  downloads: DownloadRecord[];
}) {
  const p = usePlayer();
  return (
    <Dialog
      open={!!b}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Book details"
      className="book-detail-dialog"
    >
      {b && (
        <>
          <div className="book-detail-intro">
            <img className="detail-cover" src={b.cover} alt={b.title} />
            <div>
              <span className="eyebrow">
                {b.genre} <span>·</span>{" "}
                {b.year > 0 ? b.year : `${Math.abs(b.year)} BC`}
              </span>
              <h2>{b.title}</h2>
              <p className="detail-author">{b.author}</p>
              <p className="detail-narrator">
                {b.tracks.length
                  ? `Narrated by ${b.narrator}`
                  : "No audiobook recording added yet."}
              </p>
              <div className="detail-stats">
                {b.tracks.length ? (
                  <>
                    <span>
                      <Headphones size={15} />
                      {duration(b.duration)}
                    </span>
                    <span>
                      <List size={15} />
                      {listeningChapters(b).length} chapters
                    </span>
                    {b.rating > 0 && (
                      <span className="rating">★ {b.rating}</span>
                    )}
                  </>
                ) : (
                  <span>No audio yet</span>
                )}
              </div>
              <div className="detail-actions">
                <ReaderShortcut book={b} onOpen={onClose} onMissing={onFindEbook}/>
                {b.hardcover?.slug && (
                  <a className="button subtle" href={`https://hardcover.app/books/${encodeURIComponent(b.hardcover.slug)}`} target="_blank" rel="noopener noreferrer">
                    Hardcover <ExternalLink size={16}/>
                  </a>
                )}
                {b.inLibrary ? (
                  <ListenButton book={b} onFindAudio={onFindAudio} />
                ) : (
                  <button className="button primary" onClick={onAdd}>
                    <Plus size={16} /> Add to library
                  </button>
                )}
                <button
                  className={`button square ${favorite ? "is-favorite" : ""}`}
                  onClick={onFavorite}
                  aria-label={
                    favorite ? "Remove from favorites" : "Add to favorites"
                  }
                >
                  <Heart size={18} fill={favorite ? "currentColor" : "none"} />
                </button>
              </div>
            </div>
          </div>
          <div className="detail-description">
            <h3>Description</h3>
            <p>{b.description}</p>
          </div>
          {b.tracks.length > 0 && (
            <section className="detail-release">
              <h3>Your audiobook release</h3>
              <p>
                {b.releaseTitle || b.title} · {b.language || "Language unknown"}{" "}
                · {b.narrator}
              </p>
              {releases.length > 1 && (
                <label>
                  Available recordings
                  <select
                    aria-label="Audiobook release"
                    value={b.id}
                    onChange={(event) => {
                      const release = releases.find(
                        (book) => book.id === event.target.value,
                      );
                      if (release) onRelease(release);
                    }}
                  >
                    {releases.map((book) => (
                      <option key={book.id} value={book.id}>
                        {book.language || "Language unknown"} · {book.narrator}{" "}
                        · {book.releaseTitle || book.sourceLabel}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button className="button subtle" onClick={onManageSources}>Versions & sources</button>
              {admin && <button className="button subtle" onClick={onFindAudio}>
                <Search size={15} /> Find another release
              </button>}
            </section>
          )}
          <HardcoverBookTools
            book={b}
            onChanged={onChanged}
            onSettings={onSettings}
            notify={notify}
          />
          {!b.tracks.length && (
            <div className="metadata-book-note">
              This book is on your reading shelf. Find an audiobook recording to
              listen here; its files and progress will stay linked to this work.
            </div>
          )}
          {b.inLibrary && b.tracks.length > 0 && (
            <div className="offline-detail">
              <div>
                <Download size={19} />
                <span>
                  <strong>
                    {downloaded
                      ? "Ready for offline listening"
                      : downloadJob
                        ? "Downloading"
                        : "Save on this device"}
                  </strong>
                  <small>
                    {downloaded
                      ? "All chapters are saved on this device."
                      : downloadJob
                        ? `Chapter ${downloadJob.chapter} of ${downloadJob.total} · ${Math.round(downloadJob.progress)}%`
                        : "A complete copy for listening without a connection."}
                  </small>
                </span>
              </div>
              <button
                className="button subtle"
                onClick={onDownload}
                disabled={downloaded || !!downloadJob}
              >
                {downloaded ? (
                  <>
                    <Check size={15} /> Downloaded
                  </>
                ) : downloadJob ? (
                  <>
                    <Loader2 className="spin" size={15} /> Downloading
                  </>
                ) : (
                  <>
                    <Download size={15} /> Save offline
                  </>
                )}
              </button>
            </div>
          )}
          {admin && b.tracks.length > 0 && (
            <div className="detail-ebook-action">
              <span>
                <HardDrive size={18} />
                {b.serverStored
                  ? "Saved on your server’s HDD"
                  : "Keep a copy on your home server"}
              </span>
              <button
                className="button subtle"
                disabled={b.serverStored}
                onClick={onKeepServer}
              >
                {b.serverStored ? (
                  <>
                    <Check size={14} /> Saved
                  </>
                ) : (
                  <>
                    <HardDrive size={14} /> Save to server
                  </>
                )}
              </button>
            </div>
          )}
          {admin && <div className="detail-ebook-action">
            <span>
              <BookOpen size={18} /> Ebook edition
            </span>
            <button className="button subtle" onClick={onFindEbook}>
              Find ebook <ArrowRight size={14} />
            </button>
          </div>}
          {b.tracks.length > 0 && (
            <div className="detail-chapters">
              <h3>
                Inside this audiobook{" "}
                <span>{listeningChapters(b).length} chapters</span>
              </h3>
              <Chapters book={b} downloads={downloads} />
            </div>
          )}
          <div className="detail-source">
            <span>{b.sourceLabel}</span>
            {b.inLibrary && (
              <button onClick={onRemove}>Remove from library</button>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: typeof Library;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={27} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
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
function StorageInfo({ downloads }: { downloads: DownloadRecord[] }) {
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [persistent, setPersistent] = useState(false);
  useEffect(() => {
    void navigator.storage?.estimate().then(setEstimate);
    void navigator.storage?.persisted?.().then(setPersistent);
  }, [downloads]);
  const size = downloads.reduce((a, d) => a + d.size, 0);
  return (
    <div className="storage-card">
      <div className="storage-icon">
        <HardDrive size={23} />
      </div>
      <div className="storage-main">
        <div>
          <strong>Device storage</strong>
          <span>
            {bytes(size)}{" "}
            {estimate?.quota
              ? `of ${bytes(estimate.quota)} available`
              : "on this device"}
          </span>
        </div>
        <div className="storage-bar">
          <i
            style={{
              width: `${size ? Math.max(1, Math.min(100, (size / (estimate?.quota || size)) * 100)) : 0}%`,
            }}
          />
        </div>
        <small>
          {persistent
            ? "Persistent storage is enabled."
            : "Your browser may clear downloads when storage is low."}{" "}
          Keep this tab open until your download finishes.
        </small>
      </div>
      <span className="quiet-tag">
        <ShieldCheck size={15} />
        {persistent ? "Protected storage" : "Browser storage"}
      </span>
    </div>
  );
}
function Discover({
  admin,
  audioTarget,
  settings,
  ebookTarget,
  onQueued,
  books,
  query,
  onQuery,
  onDetail,
  onAdd,
  notify,
  torboxConfigured,
  onConnect,
  refresh,
}: {
  admin: boolean;
  audioTarget: Book | null;
  settings: SettingsData | null;
  ebookTarget: Book | null;
  onQueued: () => void;
  books: Book[];
  query: string;
  onQuery: (q: string) => void;
  onDetail: (b: Book) => void;
  onAdd: (b: Book) => void;
  notify: (text: string, error?: boolean) => void;
  torboxConfigured: boolean;
  onConnect: () => void;
  refresh: () => Promise<void>;
}) {
  const [genre, setGenre] = useState("All genres");
  const [source, setSource] = useState<
    "curated" | "abb" | "hardcover" | "ebooks"
  >("curated");
  const [busy, setBusy] = useState(false);
  const [external, setExternal] = useState<
    {
      id: string;
      title: string;
      author: string;
      cover?: string;
      description?: string;
      genre?: string;
      url?: string;
    }[]
  >([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (ebookTarget) setSource("ebooks");
    else if (audioTarget) setSource("abb");
  }, [ebookTarget, audioTarget]);
  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length < 2) {
      setError("Enter at least two characters to search.");
      return;
    }
    setBusy(true);
    setError("");
    setExternal([]);
    try {
      if (source === "abb")
        setExternal(await api("/discover/abb?q=" + encodeURIComponent(query)));
      else {
        const result = await api<
          | {
              hits?: {
                document: {
                  id: string;
                  title: string;
                  author_names?: string[];
                  image?: { url: string };
                  description?: string;
                  url?: string;
                };
              }[];
            }
          | string
        >("/discover/hardcover?q=" + encodeURIComponent(query));
        const data = typeof result === "string" ? JSON.parse(result) : result;
        setExternal(
          (data.hits || []).map(
            (h: {
              document: {
                id: string;
                title: string;
                author_names?: string[];
                image?: { url: string };
                description?: string;
                url?: string;
              };
            }) => ({
              ...h.document,
              author: h.document.author_names?.join(", ") || "Unknown author",
              cover: h.document.image?.url,
              url: h.document.url,
            }),
          ),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addCatalog = async (id: string) => {
    setBusy(true);
    try {
      await api("/hardcover/books", {
        method: "POST",
        body: JSON.stringify({ id: Number(id) }),
      });
      hardcoverChanged();
      await refresh();
      notify(
        "Added to your library. Match or find audio whenever you’re ready.",
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const visible = books
    .filter((b) => admin ? b.sourceLabel.startsWith("LibriVox") : !b.inLibrary)
    .filter((b) => genre === "All genres" || b.genre === genre);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Discover</h1>
        </div>
      </div>
      <div className="discovery-sources">
        <button
          className={source === "curated" ? "selected" : ""}
          onClick={() => {
            setSource("curated");
            setError("");
          }}
        >
          Classics
        </button>
        {admin && (
        <button
          className={source === "abb" ? "selected" : ""}
          onClick={() => {
            setSource("abb");
            setError("");
            setExternal([]);
          }}
        >
          Audiobooks <ArrowUpRight size={13} />
        </button>
        )}
        <button
          className={source === "hardcover" ? "selected" : ""}
          onClick={() => {
            setSource("hardcover");
            setError("");
            setExternal([]);
          }}
        >
          Hardcover <ArrowUpRight size={13} />
        </button>
        {admin && (
        <button
          className={source === "ebooks" ? "selected" : ""}
          onClick={() => {
            setSource("ebooks");
            setError("");
          }}
        >
          Ebooks <BookOpen size={13} />
        </button>
        )}
      </div>
      {source === "ebooks" ? (
        <EbookDiscovery
          query={query}
          onQuery={onQuery}
          settings={settings}
          target={ebookTarget}
          notify={notify}
        />
      ) : source === "abb" ? (
        <ReleasePicker
          query={query}
          onQuery={onQuery}
          target={audioTarget}
          prowlarrConfigured={!!settings?.prowlarrConfigured}
          onQueued={onQueued}
          refresh={refresh}
          notify={notify}
        />
      ) : source === "curated" ? (
        <section id="discover-books">
          <div className="section-heading">
            <h2>{admin ? "Classics" : "Shared catalogue"}</h2>
            <span className="muted small">
              Public-domain recordings · LibriVox
            </span>
          </div>
          <div className="genre-chips">
            {[
              "All genres",
              "Fiction",
              "Fantasy",
              "Mystery",
              "Science fiction",
              "Mind & life",
            ].map((g) => (
              <button
                key={g}
                className={genre === g ? "selected" : ""}
                onClick={() => setGenre(g)}
              >
                {g}
              </button>
            ))}
          </div>
          {visible.length ? (
            <div className="books-grid discover-grid">
              {visible.map((b) => (
                <article className="discover-book" key={b.id}>
                  <button className="book-cover" onClick={() => onDetail(b)}>
                    <img src={b.cover} alt={b.title} />
                  </button>
                  <span className="discovery-genre">{b.genre}</span>
                  <button className="book-title" onClick={() => onDetail(b)}>
                    {b.title}
                  </button>
                  <p className="book-author">{b.author}</p>
                  <div className="discovery-book-footer">
                    <span>{duration(b.duration)}</span>
                    <button
                      onClick={() => (b.inLibrary ? onDetail(b) : onAdd(b))}
                      className={b.inLibrary ? "saved" : ""}
                      aria-label={
                        b.inLibrary
                          ? `View ${b.title}`
                          : `Add ${b.title} to library`
                      }
                    >
                      {b.inLibrary ? <Check size={16} /> : <Plus size={18} />}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              icon={Search}
              title="Try a different trail"
              text="No books match this search and genre. Try another title or choose All genres."
            />
          )}
          {admin && (
          <div className="discover-ebook-callout">
            <div>
              <BookOpen size={23} />
              <span>
                <strong>Prefer turning pages?</strong>
                <p>
                  Find ebook editions on Library Genesis.
                </p>
              </span>
            </div>
            <button
              className="button subtle"
              onClick={() => setSource("ebooks")}
            >
              Explore ebooks <ArrowRight size={14} />
            </button>
          </div>
          )}
        </section>
      ) : (
        <section className="external-search">
          <div className="section-heading">
            <h2>Search Hardcover</h2>
          </div>
          {!settings?.hardcoverConfigured && <p>Add your Hardcover token in Settings to search books.</p>}
          <form onSubmit={(e) => void search(e)}>
            <label className="search-input">
              <Search size={18} />
              <input
                aria-label="Search Hardcover"
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                placeholder="Book title or author"
                minLength={2}
              />
            </label>
            <button className="button primary" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={17} />
              ) : (
                <Search size={17} />
              )}{" "}
              Search
            </button>
          </form>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {busy && !external.length ? (
            <div className="external-loading">
              <Loader2 className="spin" /> Searching…
            </div>
          ) : external.length ? (
            <div className="external-results">
              {external.map((b) => (
                <article key={b.id}>
                  <img
                    src={b.cover || "/covers/time.svg"}
                    alt=""
                    onError={(e) => {
                      e.currentTarget.src = "/covers/time.svg";
                    }}
                  />
                  <div>
                    <h3>{b.title}</h3>
                    <p>{b.author}</p>
                    {b.description && (
                      <small>{b.description.slice(0, 180)}</small>
                    )}
                  </div>
                  <div className="discovery-actions">
                    {b.url && (
                      <a
                        className="button subtle"
                        href={b.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View book <ExternalLink size={14} />
                      </a>
                    )}
                    <button
                      className="button subtle"
                      disabled={busy}
                      onClick={() => void addCatalog(b.id)}
                    >
                      <Plus size={15} /> Add to library
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            !error && (
              <Empty
                icon={Compass}
                title="Search books"
                text="Enter a book title or author."
              />
            )
          )}
        </section>
      )}
    </>
  );
}
function AccountSettings({ user, needsPassword, onLogout, notify }: { user: Account; needsPassword: boolean; onLogout: () => void; notify: (s: string, error?: boolean) => void }) {
  const [users, setUsers] = useState<Account[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetting, setResetting] = useState<Account | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [removing, setRemoving] = useState<Account | null>(null);
  const refresh = () => api<Account[]>("/users").then(setUsers).catch((e) => notify(e.message, true));
  useEffect(() => { if (user.role === "admin") void refresh(); }, [user.id]);
  const action = async (fn: () => Promise<unknown>) => { try { await fn(); notify("Saved."); if (user.role === "admin") await refresh(); } catch (e) { notify((e as Error).message, true); } };
  const roleLabel = (account: Account) => account.role === "admin" ? "Admin" : "User";
  return <>
    <section className="settings-section account-section">
      <div className="settings-section-heading">
        <span className="settings-section-icon"><CircleUserRound size={20} /></span>
        <div><h2>Account</h2><p>{user.username} · {roleLabel(user)}</p></div>
      </div>
      {needsPassword && <button className="button subtle" onClick={() => void action(async () => { await api("/auth/logout", { method: "POST" }); await authDB.preferences.put({ key: "auth", value: { required: true, authenticated: false } }); navigator.serviceWorker?.controller?.postMessage("clear-stream-cache"); onLogout(); window.location.reload(); })}><LogOut size={16} /> Sign out</button>}
    </section>
    {user.id !== 1 && <section className="settings-section account-section">
      <div className="settings-section-heading">
        <span className="settings-section-icon"><KeyRound size={20} /></span>
        <div><h2>Change password</h2></div>
      </div>
      <form className="account-form" onSubmit={(e) => { e.preventDefault(); void action(async () => { await api("/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }); setCurrentPassword(""); setNewPassword(""); }); }}>
        <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></label>
        <label>New password<input type="password" autoComplete="new-password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} /></label>
        <button className="button subtle">Change password</button>
      </form>
    </section>}
    {user.role === "admin" && <section className="settings-section account-section">
      <div className="settings-section-heading">
        <span className="settings-section-icon"><UsersRound size={20} /></span>
        <div><h2>Users</h2></div>
      </div>
      <ul className="user-list">
        {users.map(account => <li key={account.id} className="user-row">
          <div className="user-row-name"><strong>{account.username}</strong><span className="quiet-tag">{roleLabel(account)}</span></div>
          {account.id !== 1 && <div className="user-row-actions">
            <button type="button" className="button subtle" onClick={() => { setResetPassword(""); setResetting(account); }}><KeyRound size={15} /> Reset password</button>
            <button type="button" className="button subtle user-remove" onClick={() => setRemoving(account)}><Trash2 size={15} /> Remove user</button>
          </div>}
        </li>)}
      </ul>
      <form className="account-form user-add" onSubmit={e => { e.preventDefault(); void action(async () => { await api("/users", { method: "POST", body: JSON.stringify({ username, password, role: "user" }) }); setUsername(""); setPassword(""); }); }}>
        <h3>Add user</h3>
        <label>Username<input required value={username} onChange={e => setUsername(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button className="button primary"><Plus size={16} /> Add user</button>
      </form>
      <Dialog open={!!resetting} onOpenChange={(open) => { if (!open) setResetting(null); }} title={`Reset password for ${resetting?.username ?? ""}`} className="account-dialog">
        <form className="account-form" onSubmit={e => { e.preventDefault(); const account = resetting!; setResetting(null); void action(() => api(`/users/${account.id}`, { method: "PATCH", body: JSON.stringify({ password: resetPassword }) })); }}>
          <label>New password<input type="password" autoComplete="new-password" required autoFocus value={resetPassword} onChange={e => setResetPassword(e.target.value)} /></label>
          <div className="account-dialog-actions">
            <button type="button" className="button subtle" onClick={() => setResetting(null)}>Cancel</button>
            <button className="button primary">Reset password</button>
          </div>
        </form>
      </Dialog>
      <Dialog open={!!removing} onOpenChange={(open) => { if (!open) setRemoving(null); }} title={`Remove ${removing?.username ?? ""}?`} className="account-dialog">
        <div className="account-dialog-actions">
          <button type="button" className="button subtle" onClick={() => setRemoving(null)}>Cancel</button>
          <button type="button" className="button subtle user-remove" onClick={() => { const account = removing!; setRemoving(null); void action(() => api(`/users/${account.id}`, { method: "DELETE" })); }}><Trash2 size={15} /> Remove user</button>
        </div>
      </Dialog>
    </section>}
  </>;
}
function SettingsPage({
  user,
  settings,
  onSaved,
  notify,
  needsPassword,
  onLogout,
  installPrompt,
  onInstall,
}: {
  user: Account;
  settings: SettingsData | null;
  onSaved: () => void;
  notify: (s: string, error?: boolean) => void;
  needsPassword: boolean;
  onLogout: () => void;
  installPrompt: Event | null;
  onInstall: () => void;
}) {
  const [name, setName] = useState("");
  const [torbox, setTorbox] = useState("");
  const [hardcover, setHardcover] = useState("");
  const [abbUrl, setAbbUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (settings) {
      setName(settings.name);
      setAbbUrl(settings.abbUrl);
    }
  }, [settings]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify(user.role === "admin" ? { name, abbUrl, ...(torbox ? { torbox } : {}), ...(hardcover ? { hardcover } : {}) } : (hardcover ? { hardcover } : {})),
      });
      setTorbox("");
      setHardcover("");
      onSaved();
      hardcoverChanged();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async (key: "torbox" | "hardcover") => {
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: "" }),
      });
      onSaved();
      notify("Connection removed.");
      if (key === "hardcover") hardcoverChanged();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      await api("/torbox/test", { method: "POST" });
      notify("TorBox is connected and ready to play.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
        </div>
      </div>
      <AccountSettings user={user} needsPassword={needsPassword} onLogout={onLogout} notify={notify} />
      <AppearanceSettings notify={notify} />
      <PlaybackSettings notify={notify} />
      <section className="settings-section" aria-label="Keyboard">
        <KeyboardHelpButton />
      </section>
      <DeviceReset notify={notify} />
      <form className="settings-form" onSubmit={(e) => void save(e)}>
        {user.role === "admin" && (
        <section className="settings-section">
          <div className="settings-section-heading">
            <span className="settings-section-icon">
              <Headphones size={20} />
            </span>
            <div>
              <h2>Library</h2>
            </div>
          </div>
          <label>
            Library name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={60}
              placeholder="Library name"
            />
          </label>
        </section>
        )}
        {user.role === "admin" && (
        <section className="settings-section">
          <div className="settings-section-heading">
            <span className="settings-section-icon green">
              <Cloud size={20} />
            </span>
            <div>
              <h2>TorBox</h2>
            </div>
            <span
              className={`connection-tag ${settings?.torboxConfigured ? "connected" : ""}`}
            >
              <span />
              {settings?.torboxConfigured ? "Connected" : "Not connected"}
            </span>
          </div>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={torbox}
              onChange={(e) => setTorbox(e.target.value)}
              placeholder={
                settings?.torboxConfigured
                  ? "••••••••••••••••  ·  Saved securely"
                  : "Paste your TorBox API key"
              }
            />
            <small>
              Find your key in{" "}
              <a
                href="https://torbox.app/settings"
                target="_blank"
                rel="noreferrer"
              >
                TorBox → Settings → API <ArrowUpRight size={12} />
              </a>
              . Save changes before testing.
            </small>
          </label>
          {settings?.torboxConfigured && (
            <div className="settings-inline-actions">
              <button
                type="button"
                className="button subtle"
                disabled={testing}
                onClick={() => void test()}
              >
                {testing ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <Wifi size={14} />
                )}{" "}
                Test connection
              </button>
              <button
                type="button"
                className="text-danger"
                onClick={() => void disconnect("torbox")}
              >
                Disconnect
              </button>
            </div>
          )}
        </section>
        )}
        <section className="settings-section">
          <div className="settings-section-heading">
            <span className="settings-section-icon lilac">
              <BookOpen size={20} />
            </span>
            <div>
              <h2>
                Hardcover <span className="optional-label">Optional</span>
              </h2>
              <p>
                Book metadata, reading shelves, lists, and reading progress.
              </p>
            </div>
            {settings?.hardcoverConfigured && (
              <span className="connection-tag connected">
                <span /> Connected
              </span>
            )}
          </div>
          <label>
            API token
            <input
              type="password"
              autoComplete="off"
              value={hardcover}
              onChange={(e) => setHardcover(e.target.value)}
              placeholder={
                settings?.hardcoverConfigured
                  ? "••••••••••••••••  ·  Saved securely"
                  : "Paste your Hardcover API token"
              }
            />
            <small>
              Get your token from{" "}
              <a
                href="https://hardcover.app/account/api"
                target="_blank"
                rel="noreferrer"
              >
                Hardcover API settings <ArrowUpRight size={12} />
              </a>
              .
            </small>
          </label>
          {settings?.hardcoverConfigured && (
            <button
              className="text-danger"
              type="button"
              onClick={() => void disconnect("hardcover")}
            >
              Disconnect Hardcover
            </button>
          )}
        </section>
        {user.role === "admin" && (
        <section className="settings-section">
          <div className="settings-section-heading">
            <span className="settings-section-icon">
              <Compass size={20} />
            </span>
            <div>
              <h2>Discovery</h2>
            </div>
          </div>
          <label>
            AudioBookBay mirror
            <input
              type="url"
              value={abbUrl}
              onChange={(e) => setAbbUrl(e.target.value)}
              required
              placeholder="https://audiobookbay.lu"
            />
            <small>
              Use an HTTPS AudioBookBay mirror that is accessible from your
              server.
            </small>
          </label>
        </section>
        )}
        <div className="settings-save">
          <span>
            <ShieldCheck size={15} /> Connection keys are encrypted on your
            server.
          </span>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}{" "}
            Save changes
          </button>
        </div>
      </form>
      <HardcoverSyncSettings
        configured={!!settings?.hardcoverConfigured}
        notify={notify}
      />
      {user.role === "admin" && <><SourceSettings settings={settings} onSaved={onSaved} notify={notify} /><ProwlarrSettings settings={settings} onSaved={onSaved} notify={notify} /></>}
      <section className="install-card">
        <div className="install-brand">
          <Mark />
        </div>
        <div>
          <h3>Install Sonder</h3>
          <p>
            {installPrompt
              ? "Install Sonder on this device."
              : "Use your browser’s “Install app” or “Add to Home Screen” menu. Installation and offline playback require HTTPS, or localhost."}
          </p>
        </div>
        {installPrompt && (
          <button className="button subtle" onClick={onInstall}>
            <Download size={16} /> Install Sonder
          </button>
        )}
      </section>

    </>
  );
}
function ImportDialog({
  onQueued,
  open,
  onClose,
  onImported,
  notify,
  torboxConfigured,
  onConnect,
}: {
  onQueued: () => void;
  open: boolean;
  onClose: () => void;
  onImported: () => void;
  notify: (s: string, error?: boolean) => void;
  torboxConfigured: boolean;
  onConnect: () => void;
}) {
  const [tab, setTab] = useState<"files" | "torbox" | "magnet">("files");
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [magnet, setMagnet] = useState("");
  const [torrents, setTorrents] = useState<
    { id: number; name: string; files: { name: string; size: number }[] }[]
  >([]);
  const [loadingTorrents, setLoadingTorrents] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  useEffect(() => {
    if (open) {
      setError("");
      setUploadProgress(null);
    } else if (!busy) {
      setFiles([]);
      setTitle("");
      setAuthor("");
      setMagnet("");
    }
  }, [open, busy]);
  const choose = (list: File[]) => {
    setFiles(
      [...list].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      ),
    );
    if (list.length && !title) setTitle(list[0].name.replace(/\.[^.]+$/, ""));
    setError("");
  };
  const fetchTorrents = async () => {
    setLoadingTorrents(true);
    setError("");
    try {
      setTorrents(await api("/torbox/files"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingTorrents(false);
    }
  };
  useEffect(() => {
    if (open && tab === "torbox" && torboxConfigured) void fetchTorrents();
  }, [open, tab, torboxConfigured]);
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!files.length) {
      setError("Choose an audio file to get started.");
      return;
    }
    setBusy(true);
    setError("");
    setUploadProgress(0);
    const form = new FormData();
    form.set("title", title);
    form.set("author", author || "Unknown author");
    files.forEach((f) => form.append("files", f));
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/import");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable)
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else
              reject(
                new Error(
                  data.error || "Your audiobook could not be imported.",
                ),
              );
          } catch {
            reject(new Error("Your audiobook could not be imported."));
          }
        };
        xhr.onerror = () =>
          reject(new Error("The upload was interrupted. Please try again."));
        xhr.send(form);
      });
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };
  const importTorrent = async (id: number) => {
    setBusy(true);
    setError("");
    try {
      await api("/torbox/import", {
        method: "POST",
        body: JSON.stringify({ torrentId: id }),
      });
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addMagnet = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const job = await api<Acquisition>("/acquire", {
        method: "POST",
        body: JSON.stringify({ magnet }),
      });
      setMagnet("");
      notify(
        job.status === "ready"
          ? "Your audiobook is ready."
          : job.backend === "torbox"
            ? "Preparing your cached stream."
            : "Downloading to your home server’s HDD.",
      );
      onQueued();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title="Add audiobook"
      className="import-dialog"
    >
      <div className="import-tabs">
        {[
          { id: "files", label: "Your files", icon: FolderOpen },
          { id: "torbox", label: "TorBox library", icon: Cloud },
          { id: "magnet", label: "Magnet link", icon: Link2 },
        ].map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "selected" : ""}
            onClick={() => {
              setTab(t.id as typeof tab);
              setError("");
            }}
            disabled={busy}
          >
            <t.icon size={16} />
            {t.label}
          </button>
        ))}
      </div>
      {tab === "files" ? (
        <form onSubmit={(e) => void upload(e)}>
          <div
            className={`file-drop ${dragging ? "dragging" : ""} ${files.length ? "has-files" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!busy) choose(Array.from(e.dataTransfer.files));
            }}
          >
            <input
              ref={input}
              type="file"
              multiple
              accept=".mp3,.m4b,.m4a,.ogg,.opus,.flac,.wav,audio/*"
              onChange={(e) => choose(Array.from(e.target.files || []))}
              hidden
            />
            <span className="upload-icon">
              {files.length ? <Music2 size={27} /> : <Upload size={27} />}
            </span>
            <strong>
              {files.length
                ? `${files.length} audio ${files.length === 1 ? "file" : "files"} selected`
                : "Drop audio files here"}
            </strong>
            <p>
              {files.length
                ? `${files[0].name}${files.length > 1 ? ` + ${files.length - 1} more` : ""} · ${bytes(files.reduce((n, f) => n + f.size, 0))}`
                : "MP3, M4B, M4A, OGG, Opus, FLAC, or WAV"}
            </p>
            <button
              type="button"
              className="button subtle"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {files.length ? "Choose different files" : "Browse files"}{" "}
              <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="import-fields">
            <label>
              Book title
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Book title"
                required
                maxLength={200}
                disabled={busy}
              />
            </label>
            <label>
              Author
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Author"
                maxLength={200}
                disabled={busy}
              />
            </label>
          </div>
          <p className="import-hint">
            Multiple files become chapters in filename order. Your originals are
            saved on your server.
          </p>
          {uploadProgress !== null && (
            <div className="upload-status">
              <div className="download-progress">
                <i style={{ width: `${uploadProgress}%` }} />
              </div>
              <span>
                {uploadProgress === 100
                  ? "Processing audio…"
                  : `Uploading… ${uploadProgress}%`}
              </span>
            </div>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-footer">
            <button
              type="button"
              className="button ghost"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="button primary" disabled={busy || !files.length}>
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Plus size={16} />
              )}{" "}
              {busy ? "Adding audiobook…" : "Add to my library"}
            </button>
          </div>
        </form>
      ) : tab === "torbox" && !torboxConfigured ? (
        <Empty
          icon={Cloud}
          title="TorBox not connected"
          text="Connect your TorBox account to stream and import audiobooks."
          action={
            <button className="button primary" onClick={onConnect}>
              Connect TorBox <ArrowUpRight size={16} />
            </button>
          }
        />
      ) : tab === "magnet" ? (
        <form className="magnet-form" onSubmit={(e) => void addMagnet(e)}>
          <label>
            Magnet link
            <textarea
              value={magnet}
              onChange={(e) => setMagnet(e.target.value)}
              placeholder="magnet:?xt=urn:btih:…"
              required
              rows={4}
            />
          </label>
          <p className="import-hint">
            We check TorBox’s cache first. If it’s ready, you can stream it;
            otherwise your home server downloads it to the 4 TB drive. Progress
            is saved, and downloads keep going when you close this app.
          </p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary"
            disabled={busy || !magnet.startsWith("magnet:?")}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}{" "}
            Add audiobook
          </button>
        </form>
      ) : (
        <div className="torbox-browser">
          <div className="torbox-browser-heading">
            <span>Your ready-to-play audio</span>
            <button
              className="icon-button"
              onClick={() => void fetchTorrents()}
              aria-label="Refresh TorBox library"
              disabled={loadingTorrents || busy}
            >
              <RefreshCw size={16} className={loadingTorrents ? "spin" : ""} />
            </button>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {loadingTorrents ? (
            <div className="external-loading">
              <Loader2 className="spin" /> Loading TorBox audiobooks…
            </div>
          ) : torrents.length ? (
            <div className="torbox-items">
              {torrents.map((t) => (
                <div key={t.id}>
                  <span className="torbox-file-icon">
                    <Headphones size={21} />
                  </span>
                  <span>
                    <strong>{t.name}</strong>
                    <small>
                      {t.files.length} audio files ·{" "}
                      {bytes(t.files.reduce((n, f) => n + f.size, 0))}
                    </small>
                  </span>
                  <button
                    className="button subtle"
                    disabled={busy}
                    onClick={() => void importTorrent(t.id)}
                  >
                    {busy ? (
                      <Loader2 size={15} className="spin" />
                    ) : (
                      <Plus size={15} />
                    )}{" "}
                    Add
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              icon={Cloud}
              title="No completed audiobooks"
              text="No completed audiobooks were found. Add a magnet link or wait for your TorBox download to finish."
            />
          )}
        </div>
      )}
    </Dialog>
  );
}
export default App;
