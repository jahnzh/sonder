import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { PlayerProvider } from "./player";
import { OfflineLine, PlaceNav, Toast, useConnection } from "./shell";
import { offlineLineShown } from "./connection";
import { SeriesPage } from "./pages/series-page";
import { placeShown } from "./place-shown";
import { REMOVED_TOAST as SERIES_REMOVED_TOAST } from "./pages/series-remove-model";
import { useSavedSeries } from "./pages/library-series";
import { isSavedSeries, SERIES_CHIP } from "./pages/library-series-model";
import { EditionLinkFollower } from "./edition-link";
import { EBOOK_DEVICE_EVENT } from "./reading";
import {
  ApiError,
  api,
  loadBooks,
  localDB,
  authDB,
  selectUserStorage,
  userStorageKey,
  bytes,
  downloadTrack,
  getDownloadedBlob,
  clock,
  listOfflineEbookCopies,
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
import { SignIn, type Account } from "./components/SignIn";
import { Join } from "./components/Join";
import { PlayerDock } from "./components/Player";
import { publishCoverBooks } from "./cover-choice";
import { NowPlaying } from "./pages/now-playing";
import { AppUpdate } from "./components/AppUpdate";
import { type Page, Mark } from "./pages/shared";
import { LibraryPage } from "./pages/library-page";
import { askDiscoverSearch, DiscoverPage } from "./pages/discover-page";
import { ActivityServer } from "./pages/activity-server";
import { ActivityNow } from "./pages/activity-now";
import { ActivityPlace } from "./pages/activity-place";
import { useSideBySide } from "./pages/side-by-side";
import { ActivityDevice } from "./pages/activity-device";
import { SettingsPage } from "./pages/settings-page";
import { AudiobookPage } from "./pages/audiobook-page";
import { MatchPage } from "./pages/match-page";
import { EditPage } from "./pages/edit-page";
import { EbookPage } from "./pages/ebook-page";
import { BookPage } from "./pages/book-page";
import { ReadingSyncDetailsPage, ReadingSyncPage } from "./pages/reading-sync-page";
import { ReaderPages } from "./pages/reader-pages";
import { isReaderPage } from "./reader-pages";
import { firstPage, parentOf, writeAddress, type Place, type Route } from "./routes";
import { coveredPage, onPageLeftByHistory, startNavigation, useAddress } from "./navigation";
import { GetAudiobookSheet } from "./pages/get-audiobook-sheet";
import { GetMagnetSheet } from "./pages/get-magnet-sheet";
import { GetEbookSheet } from "./pages/get-ebook-sheet";
import { deviceImports } from "./device-import";
import { Gallery, isGalleryRoute } from "./gallery/Gallery";
import { refreshLibraryWorks, startLibraryWorks, useLibraryDecided, useStoredWorksWithPlaces } from "./library-works-store";
import { toggleFavoriteWork, WORK_FAVORITES_KEY } from "./favorites-by-work";
import { ALL_CHIP, readChip, readShelf, readSort, readView, type LibraryChip, type LibraryView, type ShelfFilter, type SortOrder } from "./pages/library-filter";

/** The Library's chip on this device (#577), per account through `userStorageKey`. */
const LIBRARY_CHIP_KEY = "sonder-library-chip";
// The sort-and-view control's choices (#578), remembered on this device for this account like the chip.
const LIBRARY_SORT_KEY = "sonder-library-sort";
const LIBRARY_VIEW_KEY = "sonder-library-view";
// The Hardcover shelf and list an earlier build kept; read once as the shelf it stood for (#721 part c1).
const LIBRARY_HARDCOVER_KEY = "sonder-library-hardcover";
const LIBRARY_SHELF_KEY = "sonder-library-shelf";
import { bookStatus, workProgress } from "./work-progress";
import { classifyStop, type StopCause } from "./keep";
import { activeSaves, claimRecording, keepSaver, pauseKeep, resumeKeep, keepOffAndRemove, onKeepJob, savesInOtherTabs, startKeepSaver, stopKeepSaver, useKeptWorks } from "./keep-runtime";
type Notice = { text: string; error?: boolean };
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
  // The recording search without a book (#575) is a sheet over Discover.
  else if (route.name === "discover-get") under.current = "discover";
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
  // The rows the one cover choice reads for an edition without its own cover (#763).
  useEffect(() => publishCoverBooks(books), [books]);
  // The library by work with this device's places (#528): the Library's Listening, Not started and Finished
  // follow the work of each entry, so a book read in the reader is In progress (#556).
  const deviceWorks = useStoredWorksWithPlaces();
  const libraryDecided = useLibraryDecided();
  // The Library's shelf (#577): one entry per work in the library, never `GET /api/books`.
  const libraryWorks = useMemo(() => [...deviceWorks.values()].filter((work) => work.inLibrary), [deviceWorks]);
  // The address, read by SignedIn once the user is known. The page modules in
  // src/pages never read or write it themselves.
  const address = useAddress();
  const page = shownPage(address.route, useRef<Page>("library"));
  // The Get audiobook sheet (#601) covers the page it was opened over; opened by a link, its Book page.
  // Paste a magnet link (#606) is a sheet over it: Get stays mounted under it, so Back shows Get as it was left.
  const magnetSheet = address.route.name === "get-magnet" ? address.route.workId : null;
  const getSheet = address.route.name === "get" && address.route.kind === "audiobook" ? address.route.workId : magnetSheet;
  // The Get ebook sheet (#604) likewise.
  const getEbookSheet = address.route.name === "get" && address.route.kind === "ebook" ? address.route.workId : null;
  // Discover's "Search for a recording" (#575): a sheet over Discover.
  const recordingQuery = address.route.name === "discover-get" ? address.route.query : null;
  // Now playing (#593) covers the page it was opened over too; opened by a link, its Book page.
  const nowPlaying = address.route.name === "listen" || address.route.name === "read";
  const pageRoute: Route =
    getSheet || getEbookSheet || recordingQuery !== null || nowPlaying
      ? (coveredPage() ?? (magnetSheet ? { name: "book", workId: magnetSheet } : parentOf(address.route)) ?? address.route)
      : address.route;
  // The offline line (#581): while there is no connection, on a place or page that does not say so itself.
  const offlineLine = offlineLineShown(useConnection(), pageRoute);
  // The Ebook page (#531) is shown in place of the page under it.
  const ebookPage = pageRoute.name === "book-page" && pageRoute.page === "ebook" ? pageRoute.workId : null;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const admin = user.role === "admin";
  // Now is shown: the Activity place on its first part (an address of Server is Now for someone else, #516).
  const nowShown = address.route.name === "activity" && (address.route.part === "now" || (!admin && address.route.part === "server"));
  const serverActivity = useServerActivity(admin, nowShown);
  const sideBySide = useSideBySide();
  // An address of a worker the server does not report shows Server, in the address too (#520).
  const showServer = useCallback(() => address.navigate({ name: "activity", part: "server" }, { replace: true }), [address.navigate]);
  // The Library's search is one of its filters and is remembered with them (#455); Discover keeps its own query in
  // its history entry (#575). The top bar's search field that searched the page it was on is gone (#581).
  const [libraryQuery, setLibraryQuery] = useState("");
  // The Library's chip, remembered on this device for this account (#577; #455: not in the address).
  const chipKey = () => userStorageKey(LIBRARY_CHIP_KEY);
  const [filter, setFilter] = useState<LibraryChip>(() => readChip(localStorage.getItem(chipKey())));
  useEffect(() => {
    localStorage.setItem(chipKey(), filter);
  }, [filter]);
  // Sort, view and the shelf, remembered on this device for this account (#578; #455; #721 part c1).
  const [shelf, setShelf] = useState<ShelfFilter>(() =>
    readShelf(localStorage.getItem(userStorageKey(LIBRARY_SHELF_KEY)), localStorage.getItem(userStorageKey(LIBRARY_HARDCOVER_KEY))),
  );
  const [sort, setSort] = useState<SortOrder>(() => readSort(localStorage.getItem(userStorageKey(LIBRARY_SORT_KEY))));
  const [view, setView] = useState<LibraryView>(() => readView(localStorage.getItem(userStorageKey(LIBRARY_VIEW_KEY))));
  useEffect(() => {
    localStorage.setItem(userStorageKey(LIBRARY_SORT_KEY), sort);
    localStorage.setItem(userStorageKey(LIBRARY_VIEW_KEY), view);
    localStorage.setItem(userStorageKey(LIBRARY_SHELF_KEY), shelf);
  }, [sort, view, shelf]);
  // The favourites by work (#577): work ids, read from this account's device database.
  const [favorites, setFavorites] = useState<string[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [seriesRevision, setSeriesRevision] = useState(0);
  // The Library's Series chip (#567): the saved series, read again whenever the Library or a series is shown.
  const savedSeries = useSavedSeries(
    seriesRevision,
    address.route.name === "library" ? "library" : address.route.name === "series" || address.route.name === "series-add" ? `series` : "other",
    online,
  );
  const seriesRouteId = pageRoute.name === "series" || pageRoute.name === "series-add" ? pageRoute.id : null;
  // A desktop shows a saved series beside the chip's list (DesktopSeries.dc.html); a series that is not saved stays one
  // column. Until the list is read the series is taken as saved: the page itself sends one that is not to the Library.
  const seriesBeside = seriesRouteId !== null && sideBySide && (savedSeries.items === undefined || isSavedSeries(savedSeries.items, seriesRouteId));
  // The place rendered: beside a saved series it is the Library alone, never the place shown before it (#713).
  const shownPlace = placeShown(page, seriesBeside);
  // On a desktop choosing a series replaces the entry, as choosing a worker beside the Server list does (ADR 0020).
  const openSeries = (id: string) => address.navigate({ name: "series", id }, { replace: sideBySide });
  const findSeries = () => {
    askDiscoverSearch("series");
    navigate("discover");
  };
  // The Library's plus (spec #572, "The Library"): Discover with its field focused.
  const findBook = () => {
    askDiscoverSearch("books");
    navigate("discover");
  };
  const [notice, setNotice] = useState<Notice | null>(null);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [savedEbooks, setSavedEbooks] = useState<SavedEbook[]>([]);
  const [offlineEbookEditionIds, setOfflineEbookEditionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The copies the user chose to keep; the reader's own reading cache is on the device but not kept (#671).
  const [keptEbookEditionIds, setKeptEbookEditionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [downloadParts, setDownloadParts] = useState<DownloadPart[]>([]);
  const [downloadJobs, setDownloadJobs] = useState<
    Record<string, { progress: number; chapter: number; total: number; loaded?: number; size?: number }>
  >({});
  const [saveRecords, setSaveRecords] = useState<DeviceSaveRecord[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [installPrompt, setInstallPrompt] = useState<
    (Event & { prompt: () => Promise<void> }) | null
  >(null);
  // The saves running in this tab, Keep's and the save buttons' own, in one map so they never overlap (#550).
  const controllers = useRef(activeSaves);
  // Keep on this device (#550): the saver of this account; its saves show here as the save buttons' did.
  useEffect(() => {
    const unsubscribe = onKeepJob((recordingId, job) =>
      setDownloadJobs((jobs) => {
        const next = { ...jobs };
        if (job) next[recordingId] = job;
        else delete next[recordingId];
        return next;
      }),
    );
    startKeepSaver(user.id);
    return () => {
      unsubscribe();
      stopKeepSaver();
    };
  }, [user.id]);
  // Stops a running save, in whichever tab of this account runs it.
  const pauseSave = (recordingId: string) => {
    const saver = keepSaver();
    if (saver) saver.pause(recordingId);
    else controllers.current.get(recordingId)?.abort();
  };
  // Now and the attention dot on Activity (#521, #522): one result of Now's builder, from the server's answer
  // (administrator) and this device's saves (anyone), so the dot and Now cannot disagree. The clock moves "2 h ago".
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Keep on this device (#552): every kept work with what it needs; Now, This device, the Book page and the On device
  // filter read the same. A save running in another tab of this account shows as running here too.
  const keptWorks = useKeptWorks(deviceWorks, downloads, downloadParts);
  const kept = useMemo(
    () => keptWorks.map((k) => ({ workId: k.workId, pausedAt: k.entry.pausedAt ?? null, needs: k.needs })),
    [keptWorks],
  );
  const savesRunning = useMemo(() => ({ ...savesInOtherTabs(saveRecords), ...downloadJobs }), [saveRecords, downloadJobs]);
  const nowState = useMemo(
    () =>
      buildNow({
        activity: serverActivity.activity,
        saves: deviceSaveEntries({ books, downloads, downloadParts, running: savesRunning, records: saveRecords, kept }),
        books,
        admin,
        // No connection: the browser says so, or the last read of the server got no answer at all.
        online: online && serverActivity.reached,
        now: Date.now(),
      }),
    [serverActivity, books, downloads, downloadParts, savesRunning, saveRecords, kept, admin, online, clockNow],
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
    const copies = await listOfflineEbookCopies();
    setOfflineEbookEditionIds(new Set(copies.map((copy) => copy.id)));
    setKeptEbookEditionIds(new Set(copies.filter((copy) => copy.kept).map((copy) => copy.id)));
  }, []);
  // A copy written or removed while the app is open (the reader's cache, a save, a removal) is read again (#671).
  useEffect(() => {
    const read = () => void refreshOfflineEbooks().catch(() => {});
    window.addEventListener(EBOOK_DEVICE_EVENT, read);
    return () => window.removeEventListener(EBOOK_DEVICE_EVENT, read);
  }, [refreshOfflineEbooks]);
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
  // An import from this device into a book (#605) ends in the shell: the library is read again before its sheet
  // closes to the Book page, and with no sheet open its end is the toast.
  useEffect(
    () =>
      deviceImports.configure({
        refresh: async () => {
          await refreshLibraryWorks().catch(() => {});
          window.dispatchEvent(new Event("sonder:library-changed"));
        },
        notify,
      }),
    [notify],
  );
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
    void localDB.preferences.get(WORK_FAVORITES_KEY).then((p) => {
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
    window.addEventListener("sonder:downloads-changed", downloadsChanged);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("beforeinstallprompt", install);
    return () => {
      window.removeEventListener("online", status);
      window.removeEventListener("offline", status);
      window.removeEventListener("sonder:library-changed", changed);
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
    if (p === "library" || p === "discover") void refresh();
  };
  // Back (or any traversal) that changes the page closes the shell's dialogs and confirms nothing: they belonged
  // to the page that was left. A task they started that ends later does not move the user from the page now shown.
  const leftByHistory = useRef(0);
  useEffect(
    () =>
      onPageLeftByHistory(() => {
        leftByHistory.current++;
      }),
    [],
  );
  // Opening a page from a flow (a link, a finished task): adds an entry.
  const navigate = (p: Page) => {
    leavePage(p);
    address.navigate(routeOf(p));
  };
  // A "Connect …" link: Settings › Connections, where TorBox and the catalogue are connected.
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
  // Every opener of a book opens its Book page (#532): a Library tile, a Discover result, the player's "Open title
  // page", This device's rows and Activity's rows (#522).
  const openBook = (workId: string) => {
    address.navigate({ name: "book", workId });
  };
  const openWork = (workId: string) => openBook(workId);
  const openBookOf = (book: Book) => openBook(book.workId);
  // The tab bar and the rail (#581): another place adds an entry, the current one returns to its first page.
  // On the Library, its own tab shows every book again (the rail's Library item did, before #581).
  const choosePlace = (p: Place) => {
    if (p === "library" && page === "library") setFilter(ALL_CHIP);
    leavePage(p);
    address.goPlace(p);
  };
  // The Audiobook page of a book (#530): from the player's "Audiobook", the book dialog's Audiobook row and Activity.
  const audiobookWorkId =
    pageRoute.name === "book-page" && pageRoute.page === "audiobook" ? pageRoute.workId : null;
  const openAudiobook = (book: Book) => address.navigate({ name: "book-page", workId: book.workId, page: "audiobook" });
  // The Book page (#532): `#book/<workId>`, in place of the page under it.
  const bookWorkId = pageRoute.name === "book" ? pageRoute.workId : null;
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
  // The cards of the Library and Discover keep the routes by edition; the Book page adds and removes by work.
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
  // The Book page's Favorite (#532): the work joins the favourites by work, or leaves them (#577).
  const toggleFavorite = (workId: string) => {
    setFavorites((current) => {
      const next = toggleFavoriteWork(workId, current);
      void localDB.preferences.put({ key: WORK_FAVORITES_KEY, value: next });
      return next;
    });
  };
  // A save asked for by a button (the dock's Download, Activity's Resume and Retry). Its line is the status line
  // (#550): no toast. It never asks for persistent storage: only the Keep switch's tap does.
  const startDownload = async (b: Book) => {
    if (controllers.current.has(b.recordingId) || !b.tracks.length) return;
    const ctrl = new AbortController();
    controllers.current.set(b.recordingId, ctrl);
    const save = async () => {
      try {
        await writeDeviceSaveRecord(b.recordingId, b.workId, { state: "saving" }).catch(() => {});
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
      } catch (e) {
        // Stopped from outside: a pause, Keep turned off, or the tab closing (`KeepSaver.pause` notes which).
        const cause = (ctrl as AbortController & { cause?: StopCause }).cause ?? "pause";
        const stop = classifyStop({ cause: ctrl.signal.aborted ? cause : null, error: e });
        await writeDeviceSaveRecord(
          b.recordingId,
          b.workId,
          stop.state === "failed" || stop.state === "interrupted" ? stop : { state: "paused" },
        ).catch(() => {});
        await refreshDownloads();
      }
    };
    try {
      // Another tab (or Keep's saver) saving the same recording: that save goes on, and this tab shows it.
      await claimRecording(b.recordingId, save);
    } finally {
      if (controllers.current.get(b.recordingId) === ctrl) controllers.current.delete(b.recordingId);
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
  const downloaded = (b: Book) =>
    b.tracks.length > 0 &&
    b.tracks.every((t) => downloads.some((d) => d.trackId === t.id));
  // The Library's On device chip (#552, #577): Keep on and complete, every needed file here.
  const keptComplete = new Set(keptWorks.filter((k) => k.needs.complete).map((k) => k.workId));
  // Get ebook (#604): the sheet over the page it is opened from, the administrator's.
  const findEbook = (workId: string) => address.navigate({ name: "get", workId, kind: "ebook" });
  // Get audiobook (#601): the sheet over the page it is opened from, the administrator's.
  const findAudio = (b: Book) => address.navigate({ name: "get", workId: b.workId, kind: "audiobook" });
  // The Series page (#562), alone or beside the Library's list of saved series (a desktop, #567).
  const seriesPage = (id: string, beside: boolean) => (
    <SeriesPage
      key={id}
      id={id}
      admin={admin}
      online={online}
      books={books}
      revision={seriesRevision}
      beside={beside}
      onSaved={() => {
        setSeriesRevision((value) => value + 1);
        void refresh();
      }}
      onRemoved={() => {
        setSeriesRevision((value) => value + 1);
        // The Library it lands on shows the Series chip (spec #560, "Remove series").
        setFilter(SERIES_CHIP);
        void refresh();
        notify(SERIES_REMOVED_TOAST);
      }}
    />
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
      fallback={featured}
      notify={notify}
      books={books}
    >
      <div className="app-shell" data-offline={offlineLine ? "" : undefined}>
        <PlaceNav current={page} attention={attentionDot} onPlace={choosePlace} />
        <div className="main-shell">
          <main className={`main-content page-${page}`}>
            {getSheet && admin && (
              <GetAudiobookSheet
                // Not the work's id alone: the Book page under it, a sibling, is keyed by that.
                key={`get-audiobook:${getSheet}`}
                workId={getSheet}
                online={online}
                prowlarrConfigured={settings ? !!settings.prowlarrConfigured : null}
                torboxConfigured={!!settings?.torboxConfigured}
                onChanged={async () => {
                  await refresh();
                  await refreshDownloads();
                }}
              />
            )}
            {recordingQuery !== null && admin && (
              // The Get sheet without a book (#576): the recording chosen makes the book.
              <GetAudiobookSheet
                key={`recording:${recordingQuery}`}
                workId={null}
                query={recordingQuery}
                online={online}
                prowlarrConfigured={settings ? !!settings.prowlarrConfigured : null}
                torboxConfigured={!!settings?.torboxConfigured}
                onChanged={async () => {
                  await refresh();
                  await refreshDownloads();
                }}
              />
            )}
            {magnetSheet && admin && (
              <GetMagnetSheet
                key={`get-magnet:${magnetSheet}`}
                workId={magnetSheet}
                online={online}
                torboxConfigured={!!settings?.torboxConfigured}
                onChanged={async () => {
                  await refresh();
                  await refreshDownloads();
                }}
              />
            )}
            {getEbookSheet && admin && (
              <GetEbookSheet
                // Not the work's id alone: the Book page under it, a sibling, is keyed by that.
                key={`get-ebook:${getEbookSheet}`}
                workId={getEbookSheet}
                online={online}
                libgenUrl={settings?.libgenUrl || null}
                prowlarrConfigured={settings ? !!settings.prowlarrConfigured : null}
                onChanged={refresh}
              />
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
            {/* The Book page (#532), its match (#721) and Ebook (#531) pages, and the reader's Chapters, Bookmarks and Search (#590) stand in place of the place's page. */}
            {audiobookWorkId ? null : pageRoute.name === "book-page" && isReaderPage(pageRoute.page) ? <ReaderPages key={`${pageRoute.workId}:${pageRoute.page === "search" ? "search" : "chapters"}`} workId={pageRoute.workId} page={pageRoute.page} books={books} /> : bookWorkId ? (
              <BookPage
                key={bookWorkId}
                workId={bookWorkId}
                admin={admin}
                online={online}
                books={books}
                downloads={downloads}
                downloadParts={downloadParts}
                running={savesRunning}
                records={saveRecords}
                favorites={favorites}
                onFavorite={toggleFavorite}
                onSave={(book) => void startDownload(book)}
                onPauseSave={pauseSave}
                onFindAudio={findAudio}
                onFindEbook={(b) => findEbook(b.workId)}
                onSeries={(id) => address.navigate({ name: "series", id: String(id) })}
                onChanged={refresh}
                onDevice={async () => {
                  await refreshDownloads();
                  await refreshOfflineEbooks();
                }}
                notify={notify}
              />
            ) : pageRoute.name === "book-page" && pageRoute.page === "sync" ? (
              // The Reading sync page and its Details (#540).
              <ReadingSyncPage key={pageRoute.workId} workId={pageRoute.workId} admin={admin} />
            ) : pageRoute.name === "sync-details" ? (
              <ReadingSyncDetailsPage key={pageRoute.workId} workId={pageRoute.workId} />
            ) : seriesRouteId !== null && !seriesBeside ? (
              seriesPage(seriesRouteId, false)
            ) : pageRoute.name === "book-page" && pageRoute.page === "match" ? <MatchPage key={pageRoute.workId} workId={pageRoute.workId} admin={user.role === "admin"} onChanged={() => void refresh()} /> : pageRoute.name === "book-page" && pageRoute.page === "edit" ? <EditPage key={pageRoute.workId} workId={pageRoute.workId} admin={user.role === "admin"} onChanged={() => void refresh()} /> : ebookPage ? (
              <EbookPage
                key={ebookPage}
                workId={ebookPage}
                admin={user.role === "admin"}
                onGetEdition={(work) => findEbook(work.workId)}
              />
            ) : <>
            {shownPlace === "library" && (
              <LibraryPage
                works={libraryWorks}
                decided={libraryDecided}
                books={books}
                query={libraryQuery}
                setQuery={setLibraryQuery}
                filter={filter}
                setFilter={setFilter}
                view={view}
                setView={setView}
                sort={sort}
                setSort={setSort}
                shelf={shelf}
                setShelf={setShelf}
                savedSeries={savedSeries}
                openSeries={openSeries}
                findSeries={findSeries}
                findBook={findBook}
                beside={seriesBeside && seriesRouteId !== null ? { id: seriesRouteId, page: seriesPage(seriesRouteId, true) } : null}
                favorites={favorites}
                onDevice={keptComplete}
                openWork={openWork}
                navigate={navigate}
              />
            )}
            {shownPlace === "discover" && (
              <DiscoverPage
                // Opened on the Get sheet without a book (a reload, a link: #576), Discover stands under it without its
                // entry's search; Close mounts it again from its own entry, with its kept query and results.
                key={recordingQuery !== null && !coveredPage() ? "under-sheet" : "discover"}
                admin={user.role === "admin"}
                online={online}
                settingsRead={!!settings}
                onBook={openBook}
                onSeries={(id) => address.navigate({ name: "series", id: String(id) })}
                onRecording={(words) => address.navigate({ name: "discover-get", query: words })}
                onConnect={openConnections}
                notify={notify}
              />
            )}
            {shownPlace === "activity" && (
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
                    sync: (workId) => address.navigate({ name: "book-page", workId, page: "sync" }),
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
                  onDevice={(action, recordingId, bookId, keptBook) => {
                    // A kept book (#552): Pause and Resume go through its Keep record, in whichever tab saves.
                    if (keptBook) return void (action === "pause" ? pauseKeep(keptBook.workId, recordingId) : resumeKeep(keptBook.workId)).catch(() => {});
                    if (action === "pause") return pauseSave(recordingId);
                    // Resume and Retry carry on from the files and sections already saved.
                    const book = books.find((b) => b.recordingId === recordingId) ?? books.find((b) => b.id === bookId);
                    if (book) void startDownload(book);
                  }}
                />}
                device={<ActivityDevice
                  books={books}
                  downloads={downloads}
                  downloadParts={downloadParts}
                  running={savesRunning}
                  records={saveRecords}
                  ebooks={savedEbooks.filter((e) => keptEbookEditionIds.has(e.id))}
                  kept={kept}
                  online={online}
                  onPause={(row) => (row.keep ? void pauseKeep(row.workId, row.recordingId).catch(() => {}) : pauseSave(row.recordingId))}
                  onRetry={(row) => void resumeKeep(row.workId).catch(() => {})}
                  onOpen={openBookOf}
                  onRemove={async (row) => {
                    // Every file of the book on this device: its recordings' audio and its EPUB. The place, the
                    // bookmarks and the library entry stay (ADR 0018).
                    try {
                      // Removing the book's files is Keep off for it (#550), the same action as the switch's Off on
                      // the Book page (#553): every recording (earlier copies included), its EPUB copies, its maps
                      // and its save records. The rows' own ids follow for a book the stored library does not hold.
                      await keepOffAndRemove(row.workId);
                      for (const recordingId of row.recordingIds) await deleteDownloads(recordingId);
                      for (const editionId of row.ebookIds) {
                        await removeOfflineEbook(editionId);
                        // The save record of a kept book with only an ebook (#552).
                        await deleteDownloads(`ebook:${editionId}`);
                      }
                      // The reader's cache of the book's other editions goes too: every file of it (#671).
                      for (const ebook of savedEbooks)
                        if (ebook.workId === row.workId && offlineEbookEditionIds.has(ebook.id) && !row.ebookIds.includes(ebook.id))
                          await removeOfflineEbook(ebook.id);
                    } finally {
                      await refreshDownloads();
                      await refreshOfflineEbooks();
                    }
                  }}
                />}
              />
            )}
            {shownPlace === "settings" && (
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
        {offlineLine && <OfflineLine />}
        <AppUpdate />
        <PlayerDock
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
          onPauseDownload={(book) => pauseSave(book.recordingId)}
          onBookDetails={openBookOf}
          onManageSources={openAudiobook}
        />
        {/* Now playing, its Listen and Read faces (#593): over the page, at #listen/<work> and #read/<work>. */}
        <NowPlaying
          books={books}
          downloads={downloads}
          downloadParts={downloadParts}
          running={savesRunning}
          records={saveRecords}
          admin={admin}
          online={online}
          notify={notify}
          onSave={(book) => void startDownload(book)}
          onDevice={async () => {
            await refreshDownloads();
            await refreshOfflineEbooks();
          }}
        />
        {/* An old reader link (#613 part 2) opens the Read face above, once the server names the work. */}
        <EditionLinkFollower notify={notify} />
        {notice && <Toast text={notice.text} error={notice.error} onDismiss={() => setNotice(null)} />}
      </div>
    </PlayerProvider>
  );
}
export default App;
