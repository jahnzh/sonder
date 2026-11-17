import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type FormEvent,
} from "react";
import {
  Library,
  Compass,
  Download,
  Activity as ActivityIcon,
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
  RefreshCw,
  Volume2,
  Music2,
  HardDrive,
  Menu,
} from "lucide-react";
import { PlayerProvider, usePlayer } from "./player";
import { SeriesDialog, type SeriesTarget } from "./components/Series";
import {ReaderShortcut} from "./components/ReaderShortcut";
import { ReaderHost } from "./components/Reader";
import {
  ApiError,
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
  deleteDownloads,
  removeOfflineEbook,
} from "./lib";
import { deviceSaveEntries, type DeviceSaveRecord } from "./device-saves";
import { buildNow } from "./activity-now";
import type {
  Book,
  Download as DownloadRecord,
  Progress,
  Settings as SettingsData,
  Acquisition,
  ActivityResponse,
  DownloadPart,
  SavedEbook,
} from "./types";
import { Dialog } from "./components/ui/dialog";
import { SignIn, type Account } from "./components/SignIn";
import { Join } from "./components/Join";
import { PlayerDock } from "./components/Player";
import { AppUpdate } from "./components/AppUpdate";
import { Chapters } from "./components/Chapters";
import { type HardcoverFilter } from "./components/Hardcover";
import { listeningChapters } from "./chapters";
import { type Page, Mark, ListenButton, Empty } from "./pages/shared";
import { LibraryPage } from "./pages/library-page";
import { DiscoverPage } from "./pages/discover-page";
import { ActivityServer } from "./pages/activity-server";
import { ActivityNow } from "./pages/activity-now";
import { ActivityPlace } from "./pages/activity-place";
import { useSideBySide } from "./pages/side-by-side";
import { ActivityDevice } from "./pages/activity-device";
import { SettingsPage } from "./pages/settings-page";
import { AudiobookPage } from "./pages/audiobook-page";
import { audiobookRowLine } from "./pages/audiobook-model";
import { FileRow } from "./parts/FileRow";
import { Group } from "./parts/Group";
import { HardcoverPage } from "./pages/hardcover-page";
import { HardcoverRow } from "./pages/hardcover-row";
import { EbookFileRow, EbookPage, ebookSearchTarget } from "./pages/ebook-page";
import { ReaderPages } from "./pages/reader-pages";
import { isReaderPage } from "./reader-pages";
import { firstPage, writeAddress, type Place, type Route } from "./routes";
import { onPageLeftByHistory, shownSheet, startNavigation, useAddress } from "./navigation";
import { Gallery, isGalleryRoute } from "./gallery/Gallery";
import { refreshLibraryWorks, startLibraryWorks, useStoredWorksWithPlaces } from "./library-works-store";
import { bookStatus, readingPercent, workProgress } from "./work-progress";
type Notice = { text: string; error?: boolean };
const nav = [
  { id: "library", label: "My library", icon: Library },
  { id: "discover", label: "Discover", icon: Compass },
  // Activity took the Downloads slot, for everyone (#516).
  { id: "activity", label: "Activity", icon: ActivityIcon },
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
const ATTENTION_POLL_MS = 60_000;
/** Now reads the server's answer this often while it is visible (spec #513 "Now", as today's Activity page did). */
const NOW_POLL_MS = 15_000;

export type ServerActivity = {
  activity: ActivityResponse | null;
  /** False while the last read got no answer at all: there is no connection. */
  reached: boolean;
  /** The server's message when the last read was answered with an error; null once a read succeeds. */
  error: string | null;
  /** Reads the server again now (after an action on a row). */
  reload: () => void;
};

/**
 * The server's Activity answer for the shell's attention dot and for Now (#521, #522; it was `useActivityAttention` in
 * `components/Activity.tsx`): read every minute while the app is visible, every 15 seconds while Now is shown, for
 * the administrator only, and again when the browser is back online or the app visible again. `reached` is false
 * while the last read got no answer at all; a read answered with an error keeps the last answer and its message.
 */
function useServerActivity(enabled: boolean, nowShown: boolean): ServerActivity {
  const [state, setState] = useState<Omit<ServerActivity, "reload">>({ activity: null, reached: true, error: null });
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) {
      setState({ activity: null, reached: true, error: null });
      loadRef.current = () => {};
      return;
    }
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      api<ActivityResponse>("/activity")
        .then((activity) => !cancelled && setState({ activity, reached: true, error: null }))
        .catch((error) => {
          if (cancelled) return;
          const reached = error instanceof ApiError;
          const message = reached ? (error as Error).message : null;
          setState((current) =>
            current.reached === reached && current.error === message ? current : { ...current, reached, error: message },
          );
        });
    };
    loadRef.current = load;
    load();
    const timer = setInterval(load, nowShown ? NOW_POLL_MS : ATTENTION_POLL_MS);
    const visible = () => document.visibilityState === "visible" && load();
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("online", load);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, nowShown]);
  const reload = useCallback(() => loadRef.current(), []);
  return useMemo(() => ({ ...state, reload }), [state, reload]);
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
  if (route.name === "library" || route.name === "discover" || route.name === "settings" || route.name === "activity")
    under.current = route.name;
  else if (route.name === "settings-page") under.current = "settings";
  // A worker's page (#520) is a page of Activity's Server.
  else if (route.name === "worker") under.current = "activity";
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
  // The library by work with this device's places (#528): the Library's Listening, Not started and Finished
  // follow the work of each entry, so a book read in the reader is In progress (#556).
  const deviceWorks = useStoredWorksWithPlaces();
  const [ebookTarget, setEbookTarget] = useState<Book | null>(null);
  // The address, read by SignedIn once the user is known. The page modules in
  // src/pages never read or write it themselves.
  const address = useAddress();
  const page = shownPage(address.route, useRef<Page>("library"));
  // The Ebook page (#531) is shown in place of the page under it.
  const ebookPage = address.route.name === "book-page" && address.route.page === "ebook" ? address.route.workId : null;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const admin = user.role === "admin";
  // Now is shown: the Activity place on its first part (an address of Server is Now for someone else, #516).
  const nowShown = address.route.name === "activity" && (address.route.part === "now" || (!admin && address.route.part === "server"));
  const serverActivity = useServerActivity(admin, nowShown);
  const sideBySide = useSideBySide();
  // An address of a worker the server does not report shows Server, in the address too (#520).
  const showServer = useCallback(() => address.navigate({ name: "activity", part: "server" }, { replace: true }), [address.navigate]);
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
  // Now and the attention dot on Activity (#521, #522): one result of Now's builder, from the server's answer
  // (administrator) and this device's saves (anyone), so the dot and Now cannot disagree. The clock moves "2 h ago".
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const nowState = useMemo(
    () =>
      buildNow({
        activity: serverActivity.activity,
        saves: deviceSaveEntries({ books, downloads, downloadParts, running: downloadJobs, records: saveRecords }),
        books,
        admin,
        // No connection: the browser says so, or the last read of the server got no answer at all.
        online: online && serverActivity.reached,
        now: Date.now(),
      }),
    [serverActivity, books, downloads, downloadParts, downloadJobs, saveRecords, admin, online, clockNow],
  );
  const attentionDot = nowState.dot;
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
  // A download or a copy to the server that finishes joins the library: read it again, as the Downloads page did.
  const finishedOnServer = useRef<Set<string> | null>(null);
  useEffect(() => {
    const items = serverActivity.activity?.items;
    if (!items) return;
    const done = new Set(items.filter((item) => item.state === "done" && (item.kind === "acquisition" || item.kind === "server-copy")).map((item) => item.id));
    const seen = finishedOnServer.current;
    finishedOnServer.current = done;
    if (seen && [...done].some((id) => !seen.has(id))) void refresh();
  }, [serverActivity.activity, refresh]);
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
  // A "Connect …" link: Settings › Connections, where TorBox and Hardcover are connected.
  const openConnections = () => {
    leavePage("settings");
    address.navigate({ name: "settings-page", page: "connections" });
  };
  // The tab bar and the rail: another place adds an entry, the current one returns to its first page.
  // This device's part of Activity (#518): where the device's saves are listed.
  const openDevice = () => {
    leavePage("activity");
    address.navigate({ name: "activity", part: "device" });
  };
  // A row of Now opens its work: today's book dialog, until the Book page exists (#522). A work that is not in the
  // list yet (a download that just finished) is read again first.
  const openWork = (workId: string, bookId: string | null) => {
    const book = (bookId ? books.find((b) => b.id === bookId) : undefined) ?? books.find((b) => b.workId === workId);
    if (book) return setDetail(book);
    void refresh();
    notify("Your book is joining the library. Open it in a moment.");
  };
  const switchPlace = (p: Place) => {
    leftAudiobookByTab.current = true;
    leavePage(p);
    address.goPlace(p);
  };
  // The Audiobook page of a book (#530): from the player's "Audiobook", the book dialog's Audiobook row and Activity.
  const audiobookWorkId =
    address.route.name === "book-page" && address.route.page === "audiobook" ? address.route.workId : null;
  const openAudiobook = (book: Book) => {
    setDetail(null);
    address.navigate({ name: "book-page", workId: book.workId, page: "audiobook" });
  };
  // Its back button is "Back to the book": until the Book page (#532) the book is today's dialog, so landing on the
  // Library from the page (Back, or the parent of a page opened by a link) opens the dialog again for that work.
  const leftAudiobookByTab = useRef(false);
  const lastAudiobook = useRef<string | null>(null);
  useEffect(() => {
    const left = lastAudiobook.current;
    lastAudiobook.current = audiobookWorkId;
    const byTab = leftAudiobookByTab.current;
    leftAudiobookByTab.current = false;
    setReopenBook(!left || audiobookWorkId || byTab || address.route.name !== "library" || shownSheet() ? null : left);
  }, [address.route]);
  // The book's entries may still be loading after a link straight to the page: the dialog opens once they are in.
  const [reopenBook, setReopenBook] = useState<string | null>(null);
  useEffect(() => {
    if (!reopenBook) return;
    const ofWork = books.filter((b) => b.workId === reopenBook && b.inLibrary && b.tracks.length > 0);
    if (!ofWork.length) return;
    setReopenBook(null);
    // The dialog shows the chosen recording, the one the page ticked.
    const chosen = deviceWorks.get(reopenBook)?.chosenRecordingId;
    setDetail(ofWork.find((b) => b.recordingId === chosen) ?? ofWork[0]);
  }, [reopenBook, books]);
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
      // The Library's states come from the works (#556): read them before the books, so a mark shows at once.
      await refreshLibraryWorks().catch(() => {});
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
  // Each entry's status is its work's (`workProgress`), while the work is stored; otherwise `GET /api/books`' own.
  const libraryBooks = books
    .filter((b) => b.inLibrary)
    .map((b) => {
      const work = deviceWorks.get(b.workId);
      if (!work) return b;
      const status = bookStatus(workProgress(work));
      return status === b.status ? b : { ...b, status };
    });
  // A book without audio shows its ebook's place; a book with audio its listening percentage, as before.
  const readingPercentOf = (b: Book) => {
    const work = b.tracks.length ? undefined : deviceWorks.get(b.workId);
    return work ? readingPercent(work) : null;
  };
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
  // Today's ebook search for a work (Discover's ebooks, linked to the work), until slice "Get" (S8).
  const findEbook = (target: Book) => {
    setDetail(null);
    navigate("discover");
    setEbookTarget(target);
    setDiscoverQuery(`${target.title} ${target.author}`);
  };
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
                // Activity keeps its name while work needs attention; the dot describes it instead of renaming it.
                aria-label={n.id === "activity" ? n.label : undefined}
                aria-describedby={n.id === "activity" && attentionDot ? "activity-attention-sidebar" : undefined}
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
                {n.id === "activity" &&
                  Object.keys(downloadJobs).length > 0 && (
                    <span className="activity-dot" />
                  )}
                {/* The attention dot (#516), lit by Now's builder (#521): the server's work for the administrator, this device's saves for anyone. */}
                {n.id === "activity" && attentionDot && <span id="activity-attention-sidebar" className="attention-dot" role="img" aria-label="Background work needs attention" data-testid="activity-indicator" />}
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
              className={`settings-nav ${page === "settings" ? "selected" : ""}`}
              onClick={() => switchPlace("settings")}
              aria-label="Settings"
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
                <button onClick={openDevice}>
                  View downloads <ArrowRight size={14} />
                </button>
              </div>
            )}
            {audiobookWorkId && (
              <AudiobookPage
                workId={audiobookWorkId}
                books={books}
                downloads={downloads}
                admin={user.role === "admin"}
                online={online}
                onFindAudio={findAudio}
                onChanged={() => {
                  void refresh();
                  void refreshDownloads();
                }}
              />
            )}
            {/* A book's Hardcover page (#529) and its Ebook page (#531) stand in place of the place's page; the Book page (#532) joins the book's pages. */}
            {/* The reader's Chapters, Bookmarks and Search (#590) are pages too. */}
            {address.route.name === "book-page" && isReaderPage(address.route.page) ? <ReaderPages key={`${address.route.workId}:${address.route.page === "search" ? "search" : "chapters"}`} workId={address.route.workId} page={address.route.page} /> : address.route.name === "book-page" && address.route.page === "hardcover" ? <HardcoverPage key={address.route.workId} workId={address.route.workId} admin={user.role === "admin"} books={books} onChanged={() => void refresh()} /> : ebookPage ? (
              <EbookPage
                key={ebookPage}
                workId={ebookPage}
                admin={user.role === "admin"}
                onGetEdition={(work) => findEbook(books.find((b) => b.workId === work.workId) ?? ebookSearchTarget(work))}
              />
            ) : <>
            {page === "library" && !audiobookWorkId && (
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
                readingPercentOf={readingPercentOf}
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
                  navigate("activity");
                }}
                books={visible}
                query={query}
                onQuery={setQuery}
                onDetail={setDetail}
                onAdd={(b) => void mutateLibrary(b, "add")}
                notify={notify}
                torboxConfigured={!!settings?.torboxConfigured}
                onConnect={openConnections}
                onSeries={(id) => setSeriesTarget({ id, mode: "preview" })}
                refresh={refresh}
              />
            )}
            {page === "activity" && (
              <ActivityPlace
                admin={user.role === "admin"}
                part={address.route.name === "activity" ? address.route.part : address.route.name === "worker" ? "server" : "now"}
                onPart={(part) => address.navigate({ name: "activity", part })}
                alone={address.route.name === "worker" && !sideBySide}
                server={<ActivityServer
                  online={online}
                  worker={address.route.name === "worker" ? address.route.worker : null}
                  beside={sideBySide}
                  // On a desktop the page sits beside the list: choosing a worker replaces the address (#520).
                  onWorker={(worker) => address.navigate({ name: "worker", worker }, { replace: sideBySide })}
                  onUnknownWorker={showServer}
                  notify={notify}
                />}
                now={<ActivityNow
                  now={nowState}
                  serverError={admin ? serverActivity.error : null}
                  open={{
                    book: openWork,
                    worker: (worker) => address.navigate({ name: "worker", worker }),
                    server: () => address.navigate({ name: "activity", part: "server" }),
                  }}
                  onServer={async (action, id) => {
                    try {
                      await api(`/activity/items/${action}`, { method: "POST", body: JSON.stringify({ id }) });
                    } finally {
                      serverActivity.reload();
                    }
                  }}
                  onDevice={(action, recordingId, bookId) => {
                    if (action === "pause") return controllers.current.get(recordingId)?.abort();
                    // Resume and Retry carry on from the files and sections already saved.
                    const book = books.find((b) => b.recordingId === recordingId) ?? books.find((b) => b.id === bookId);
                    if (book) void startDownload(book);
                  }}
                />}
                device={<ActivityDevice
                  books={books}
                  downloads={downloads}
                  downloadParts={downloadParts}
                  running={downloadJobs}
                  records={saveRecords}
                  ebooks={savedEbooks.filter((e) => offlineEbookEditionIds.has(e.id))}
                  online={online}
                  onPause={(recordingId) => controllers.current.get(recordingId)?.abort()}
                  onOpen={setDetail}
                  onRemove={async (row) => {
                    // Every file of the book on this device: its recordings' audio and its EPUB. The place, the
                    // bookmarks and the library entry stay (ADR 0018).
                    try {
                      for (const recordingId of row.recordingIds) await deleteDownloads(recordingId);
                      for (const editionId of row.ebookIds) await removeOfflineEbook(editionId);
                    } finally {
                      await refreshDownloads();
                      await refreshOfflineEbooks();
                    }
                  }}
                />}
              />
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
            </>}
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
                // The tab keeps its name while work needs attention; the dot describes it instead of renaming it.
                aria-describedby={n.id === "activity" && attentionDot ? "activity-attention-mobile" : undefined}
              >
                <n.icon size={20} />
                <span>{n.label}</span>
                {n.id === "activity" && attentionDot && <span id="activity-attention-mobile" className="attention-dot" role="img" aria-label="Background work needs attention" />}
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
          onViewDownloads={openDevice}
          onBookDetails={setDetail}
          onManageSources={openAudiobook}
        />
        <ReaderHost books={books} notify={notify} />
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
          onOpenAudiobook={() => detail && openAudiobook(detail)}
          onFindAudio={() => detail && findAudio(detail)}
          onHardcover={() => {
            if (!detail) return;
            const workId = detail.workId;
            setDetail(null);
            address.navigate({ name: "book-page", workId, page: "hardcover" });
          }}
          onKeepServer={() => {
            const left = leftByHistory.current;
            if (detail)
              void api(`/books/${detail.id}/keep`, { method: "POST" })
                .then(() => {
                  notify("Saving the audio to your server’s HDD.");
                  setDetail(null);
                  if (left === leftByHistory.current) navigate("activity");
                })
                .catch((e) => notify(e.message, true));
          }}
          onFindEbook={() => detail && findEbook(detail)}
          onOpenEbook={() => {
            if (!detail) return;
            const workId = detail.workId;
            setDetail(null);
            address.navigate({ name: "book-page", workId, page: "ebook" });
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
            navigate("activity");
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
            openConnections();
          }}
        />
      </div>
    </PlayerProvider>
  );
}
function BookDetail({
  admin,
  onOpenAudiobook,
  onFindAudio,
  onHardcover,
  onKeepServer,
  onFindEbook,
  onOpenEbook,
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
  /** The Audiobook row: opens the Audiobook page (#530). */
  onOpenAudiobook: () => void;
  onFindAudio: () => void;
  /** Opens the book's Hardcover page (#529). */
  onHardcover: () => void;
  onKeepServer: () => void;
  onFindEbook: () => void;
  onOpenEbook: () => void;
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
            <div className="detail-audiobook">
              <Group label="Files">
                <FileRow kind="audiobook" name="Audiobook" status={audiobookRowLine({ narrator: b.narrator, duration: b.duration, serverStored: b.serverStored, tracks: b.tracks })} onClick={onOpenAudiobook} />
              </Group>
            </div>
          )}
          <HardcoverRow match={b.hardcover} onOpen={onHardcover} />
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
          <EbookFileRow workId={b.workId} admin={admin} onOpen={onOpenEbook} onGet={onFindEbook} />
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
