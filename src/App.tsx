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
  Headphones,
  Check,
  List,
  Upload,
  Cloud,
  WifiOff,
  X,
  Heart,
  CheckCheck,
  BookOpen,
  Loader2,
  FolderOpen,
  Link2,
  ExternalLink,
  RefreshCw,
  Volume2,
  Music2,
  HardDrive,
  Menu,
} from "lucide-react";
import { PlayerProvider, usePlayer } from "./player";
import { SeriesDialog, type SeriesTarget } from "./components/Series";
import { useActivityAttention } from "./components/Activity";
import { MediaManager } from "./components/MediaManager";
import {ReaderShortcut} from "./components/ReaderShortcut";
import { ReaderHost } from "./components/Reader";
import {
  api,
  loadBooks,
  localDB,
  authDB,
  selectUserStorage,
  duration,
  bytes,
  percent,
  downloadTrack,
  getDownloadedBlob,
  clock,
  listOfflineEbookEditionIds,
  listDeviceSaveRecords,
  writeDeviceSaveRecord,
} from "./lib";
import type { DeviceSaveRecord } from "./device-saves";
import type {
  Book,
  Download as DownloadRecord,
  Progress,
  Settings as SettingsData,
  Acquisition,
  DownloadPart,
  SavedEbook,
} from "./types";
import { Dialog } from "./components/ui/dialog";
import { SignIn, type Account } from "./components/SignIn";
import { Join } from "./components/Join";
import { PlayerDock } from "./components/Player";
import { AppUpdate } from "./components/AppUpdate";
import { Chapters } from "./components/Chapters";
import {
  HardcoverBookTools,
  type HardcoverFilter,
} from "./components/Hardcover";
import { listeningChapters } from "./chapters";
import { type Page, Mark, ListenButton, Empty } from "./pages/shared";
import { LibraryPage } from "./pages/library-page";
import { DiscoverPage } from "./pages/discover-page";
import { DownloadsPage } from "./pages/downloads-page";
import { ActivityPage } from "./pages/activity-page";
import { SettingsPage } from "./pages/settings-page";
import { firstPage, writeAddress, type Place, type Route } from "./routes";
import { onPageLeftByHistory, startNavigation, useAddress } from "./navigation";
import { Gallery, isGalleryRoute } from "./gallery/Gallery";
import { refreshLibraryWorks, startLibraryWorks } from "./library-works-store";
type Notice = { text: string; error?: boolean };
const nav = [
  { id: "library", label: "My library", icon: Library },
  { id: "discover", label: "Discover", icon: Compass },
  { id: "downloads", label: "Downloads", icon: Download },
] as const;
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
  // The invite activation page is its own route: a signed-out applicant lands
  // here from the emailed link, so it renders before the auth state resolves.
  if (location.pathname.replace(/\/+$/, "") === "/join")
    return (
      <Join
        onActivated={(account) => {
          setUser(account);
          setAuth(true);
          // Claiming leaves the invite URL behind: the app's home is "/", and
          // the library hash makes the bookshelf the landing page.
          history.replaceState(null, "", `/${writeAddress({ name: "library" })}`);
        }}
      />
    );
  if (auth === null)
    return (
      <div className="app-loading">
        <Mark />
        <span>Loading…</span>
      </div>
    );
  if (!auth) return <SignIn needsPassword={needsPassword} onLogin={(account) => { setUser(account); setAuth(true); }} />;
  return (
    <SignedIn user={user || { id: 1, username: "admin", role: "admin" }} needsPassword={needsPassword} onLogout={() => setAuth(false)} />
  );
}
/**
 * The address (src/routes.ts) and the history (src/navigation.ts), read once the user is known, so an
 * administrator's address survives the sign-in. The parts gallery is shown in place of the shell.
 */
function SignedIn(props: { user: Account; needsPassword: boolean; onLogout: () => void }) {
  useState(() => startNavigation({ admin: props.user.role === "admin" }));
  useEffect(() => startLibraryWorks(), []);
  const { route } = useAddress();
  if (isGalleryRoute(route.name)) return <Gallery />;
  return <LibraryApp {...props} />;
}
const routeOf = (p: Page): Route => firstPage(p);
/** The page the shell shows for a route. The reader covers the page it was opened over (the Library after a link). */
function shownPage(route: Route, under: { current: Page }): Page {
  if (route.name === "library" || route.name === "discover" || route.name === "downloads" || route.name === "settings" || route.name === "activity")
    under.current = route.name;
  return under.current;
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
  // The address, read by SignedIn once the user is known. The page modules in
  // src/pages never read or write it themselves.
  const address = useAddress();
  const page = shownPage(address.route, useRef<Page>("library"));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const activityAttention = useActivityAttention(user.role === "admin");
  // The search field searches the page it is on. The Library's search is one of its filters and is remembered
  // with them (#455); Discover's goes with its results when the page is left.
  const [queries, setQueries] = useState({ library: "", discover: "", other: "" });
  const queryOf = page === "library" || page === "discover" ? page : "other";
  const query = queries[queryOf];
  const setQuery = (value: string) => setQueries((q) => ({ ...q, [queryOf]: value }));
  const setDiscoverQuery = (value: string) => setQueries((q) => ({ ...q, discover: value }));
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
  const [seriesTarget, setSeriesTarget] = useState<SeriesTarget | null>(null);
  const [seriesRevision, setSeriesRevision] = useState(0);
  const [mediaTarget,setMediaTarget]=useState<Book|null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [savedEbooks, setSavedEbooks] = useState<SavedEbook[]>([]);
  const [offlineEbookEditionIds, setOfflineEbookEditionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [downloadParts, setDownloadParts] = useState<DownloadPart[]>([]);
  const [downloadJobs, setDownloadJobs] = useState<
    Record<string, { progress: number; chapter: number; total: number; loaded?: number; size?: number }>
  >({});
  const [saveRecords, setSaveRecords] = useState<DeviceSaveRecord[]>([]);
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
    setSaveRecords(await listDeviceSaveRecords().catch(() => []));
  }, []);
  const refreshOfflineEbooks = useCallback(async () => {
    setOfflineEbookEditionIds(new Set(await listOfflineEbookEditionIds()));
  }, []);
  const refreshSavedEbooks = useCallback(async () => {
    try {
      const value = await api<SavedEbook[]>("/ebooks");
      await localDB.preferences.put({ key: "ebooks", value });
      setSavedEbooks(value);
    } catch {
      const cached = await localDB.preferences.get("ebooks");
      setSavedEbooks((cached?.value as SavedEbook[] | undefined) ?? []);
    }
  }, []);
  const refresh = useCallback(async () => {
    try {
      setLoadError("");
      setBooks(await loadBooks());
      void refreshLibraryWorks();
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
    void refreshSavedEbooks();
    void refreshOfflineEbooks();
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
        void refreshSavedEbooks();
      }
    };
    const install = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as Event & { prompt: () => Promise<void> });
    };
    window.addEventListener("online", status);
    window.addEventListener("offline", status);
    window.addEventListener("sonder:library-changed", changed);
    window.addEventListener("sonder:hardcover-changed", changed);
    window.addEventListener("sonder:downloads-changed", downloadsChanged);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("beforeinstallprompt", install);
    return () => {
      window.removeEventListener("online", status);
      window.removeEventListener("offline", status);
      window.removeEventListener("sonder:library-changed", changed);
      window.removeEventListener("sonder:hardcover-changed", changed);
      window.removeEventListener("sonder:downloads-changed", downloadsChanged);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("beforeinstallprompt", install);
    };
  }, [refresh, refreshDownloads, refreshSavedEbooks, refreshSettings]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  // The Library's shelf, list, Favorites, status filter and search are remembered when it is left (#455), so the
  // list Back returns to is the one its scroll position belongs to.
  const leavePage = (p: Page) => {
    setEbookTarget(null);
    setAudioTarget(null);
    setQueries((q) => ({ library: q.library, discover: "", other: "" }));
    setSidebarOpen(false);
    if (p === "library" || p === "discover") void refresh();
  };
  // Back (or any traversal) that changes the page closes the shell's dialogs and confirms nothing: they belonged
  // to the page that was left. A task they started that ends later does not move the user from the page now shown.
  const leftByHistory = useRef(0);
  useEffect(
    () =>
      onPageLeftByHistory(() => {
        leftByHistory.current++;
        setDetail(null);
        setMediaTarget(null);
        setSeriesTarget(null);
        setImportOpen(false);
        setSidebarOpen(false);
      }),
    [],
  );
  // Opening a page from a flow (a link, a finished task): adds an entry.
  const navigate = (p: Page) => {
    leavePage(p);
    address.navigate(routeOf(p));
  };
  // The tab bar and the rail: another place adds an entry, the current one returns to its first page.
  const switchPlace = (p: Place) => {
    leavePage(p);
    address.goPlace(p);
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
    options: { byWork?: boolean } = {},
  ) => {
    try {
      // The book dialog adds and removes the whole work (#527); the cards keep the routes by edition.
      if (options.byWork && (action === "add" || action === "remove")) {
        await api(`/works/${encodeURIComponent(b.workId)}/library`, {
          method: action === "add" ? "PUT" : "DELETE",
        });
        if (action === "remove")
          await localDB.positionHistory.bulkDelete([
            ...new Set([
              b.recordingId,
              ...books
                .filter((entry) => entry.workId === b.workId)
                .map((entry) => entry.recordingId),
            ]),
          ]);
      } else if (action === "add")
        await api("/library", {
          method: "POST",
          body: JSON.stringify({ bookId: b.id }),
        });
      else if (action === "remove") {
        await api(`/library/${b.id}`, { method: "DELETE" });
        await localDB.positionHistory.delete(b.recordingId);
      } else
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
      await writeDeviceSaveRecord(b.recordingId, b.workId, { state: "saving" }).catch(() => {});
      await navigator.storage?.persist?.().catch(() => false);
      for (let i = 0; i < b.tracks.length; i++) {
        setDownloadJobs((j) => ({
          ...j,
          [b.recordingId]: {
            progress: (i / b.tracks.length) * 100,
            chapter: i + 1,
            total: b.tracks.length,
            loaded: 0,
            size: 0,
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
              loaded,
              size: total,
            },
          })),
        );
        await refreshDownloads();
      }
      await writeDeviceSaveRecord(b.recordingId, b.workId, { state: "finished" }).catch(() => {});
      notify(`“${b.title}” is ready for wherever you go.`);
    } catch (e) {
      await writeDeviceSaveRecord(
        b.recordingId,
        b.workId,
        ctrl.signal.aborted ? { state: "paused" } : { state: "failed", reason: (e as Error).message },
      ).catch(() => {});
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
    .filter((b) => page !== "library" || !showFavorites || favorites.includes(b.id))
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
    setDiscoverQuery(b.title);
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
            onClick={() => switchPlace("library")}
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
                  // Like the tab of the current place: on the Library, its own item shows every book again.
                  if (n.id === "library" && page === "library") {
                    setShowFavorites(false);
                    setFilter("All books");
                  }
                  switchPlace(n.id);
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
                switchPlace("library");
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
                switchPlace("library");
                setShowFavorites(false);
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
              className={`settings-nav ${page === "settings" || page === "activity" ? "selected" : ""}`}
              onClick={() => switchPlace("settings")}
              // The tab keeps its name while work needs attention (voice control and "Settings" by name); the dot
              // describes it instead of renaming it.
              aria-label="Settings"
              aria-describedby={activityAttention > 0 ? "settings-attention-sidebar" : undefined}
            >
              <Settings size={19} />
              <span>Settings</span>
              {activityAttention > 0 && <span id="settings-attention-sidebar" className="attention-dot" role="img" aria-label="Background work needs attention" data-testid="activity-indicator" />}
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
              <LibraryPage
                admin={user.role === "admin"}
                visible={visible}
                featured={featured}
                listening={listening}
                query={query}
                showFavorites={showFavorites}
                filter={filter}
                setFilter={setFilter}
                view={view}
                setView={setView}
                sort={sort}
                setSort={setSort}
                hardcoverFilter={hardcoverFilter}
                setHardcoverFilter={setHardcoverFilter}
                loading={loading}
                setLoading={setLoading}
                loadError={loadError}
                seriesRevision={seriesRevision}
                setSeriesTarget={setSeriesTarget}
                setDetail={setDetail}
                setImportOpen={setImportOpen}
                favorites={favorites}
                toggleFavorite={toggleFavorite}
                downloaded={downloaded}
                findAudio={findAudio}
                mutateLibrary={mutateLibrary}
                refresh={refresh}
                navigate={navigate}
                notify={notify}
              />
            )}
            {page === "discover" && (
              <DiscoverPage
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
                onSeries={(id) => setSeriesTarget({ id, mode: "preview" })}
                refresh={refresh}
              />
            )}
            {page === "downloads" && (
              <DownloadsPage
                admin={user.role === "admin"}
                books={books}
                downloads={downloads}
                downloadParts={downloadParts}
                downloadJobs={downloadJobs}
                saveRecords={saveRecords}
                ebooks={savedEbooks.filter((e) => offlineEbookEditionIds.has(e.id))}
                refresh={refresh}
                refreshDownloads={refreshDownloads}
                startDownload={startDownload}
                onPauseDownload={(book) =>
                  controllers.current.get(book.recordingId)?.abort()
                }
                setDetail={setDetail}
                setMediaTarget={setMediaTarget}
                navigate={navigate}
                notify={notify}
              />
            )}
            {page === "activity" && user.role === "admin" && <ActivityPage />}
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
                onOpenActivity={() => address.navigate(firstPage("activity"))}
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
                onClick={() => switchPlace(n.id as Place)}
                aria-label={n.label}
                aria-describedby={n.id === "settings" && activityAttention > 0 ? "settings-attention-mobile" : undefined}
              >
                <n.icon size={20} />
                <span>{n.label}</span>
                {n.id === "settings" && activityAttention > 0 && <span id="settings-attention-mobile" className="attention-dot" role="img" aria-label="Background work needs attention" />}
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
          onOpenSeries={(id) => { setDetail(null); setSeriesTarget({ id, mode: "preview" }); }}
          onSettings={() => {
            setDetail(null);
            navigate("settings");
          }}
          notify={notify}
          onKeepServer={() => {
            const left = leftByHistory.current;
            if (detail)
              void api(`/books/${detail.id}/keep`, { method: "POST" })
                .then(() => {
                  notify("Saving the audio to your server’s HDD.");
                  setDetail(null);
                  if (left === leftByHistory.current) navigate("downloads");
                })
                .catch((e) => notify(e.message, true));
          }}
          onFindEbook={() => {
            if (detail) {
              const target = detail;
              setDetail(null);
              navigate("discover");
              setEbookTarget(target);
              setDiscoverQuery(`${target.title} ${target.author}`);
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
          onAdd={() => detail && void mutateLibrary(detail, "add", { byWork: true })}
          onRemove={() => detail && void mutateLibrary(detail, "remove", { byWork: true })}
          downloads={downloads}
        />
        <SeriesDialog target={seriesTarget} onClose={() => setSeriesTarget(null)} downloads={downloads} savedEbooks={savedEbooks}
          offlineEbookEditionIds={offlineEbookEditionIds}
          canAcquire={user.role === "admin"}
          onSaved={() => { setSeriesRevision((value) => value + 1); void refresh(); notify("Series saved."); }} />
        <ImportDialog
          onQueued={(shown) => {
            void refresh();
            if (!shown) return;
            setImportOpen(false);
            navigate("downloads");
          }}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={(shown) => {
            void refresh();
            if (shown) setImportOpen(false);
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
function BookDetail({
  admin,
  releases,
  onManageSources,
  onRelease,
  onFindAudio,
  onChanged,
  onOpenSeries,
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
  onOpenSeries: (id: number) => void;
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
            onOpenSeries={onOpenSeries}
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
function ImportDialog({
  onQueued,
  open,
  onClose,
  onImported,
  notify,
  torboxConfigured,
  onConnect,
}: {
  /** `shown`: the dialog the request was made in is still open; one closed by Back or opened anew is left alone. */
  onQueued: (shown: boolean) => void;
  open: boolean;
  onClose: () => void;
  onImported: (shown: boolean) => void;
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
  // Each opening of the dialog. A request that ends after its opening was closed (Back closes it even while busy)
  // must not clear, close or move away from a dialog opened again meanwhile.
  const opening = useRef(0);
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => {
    if (open) opening.current++;
  }, [open]);
  const stillShown = (asked: number) => openNow.current && opening.current === asked;
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
    const asked = opening.current;
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
      onImported(stillShown(asked));
    } catch (e) {
      if (stillShown(asked)) setError((e as Error).message);
      else notify((e as Error).message, true);
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };
  const importTorrent = async (id: number) => {
    const asked = opening.current;
    setBusy(true);
    setError("");
    try {
      await api("/torbox/import", {
        method: "POST",
        body: JSON.stringify({ torrentId: id }),
      });
      onImported(stillShown(asked));
    } catch (e) {
      if (stillShown(asked)) setError((e as Error).message);
      else notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const addMagnet = async (e: FormEvent) => {
    e.preventDefault();
    const asked = opening.current;
    setBusy(true);
    setError("");
    try {
      const job = await api<Acquisition>("/acquire", {
        method: "POST",
        body: JSON.stringify({ magnet }),
      });
      const shown = stillShown(asked);
      // A draft typed into the dialog opened again is not this request's to clear.
      if (shown) setMagnet("");
      notify(
        job.status === "ready"
          ? "Your audiobook is ready."
          : job.backend === "torbox"
            ? "Preparing your cached stream."
            : "Downloading to your home server’s HDD.",
      );
      onQueued(shown);
    } catch (e) {
      if (stillShown(asked)) setError((e as Error).message);
      else notify((e as Error).message, true);
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
