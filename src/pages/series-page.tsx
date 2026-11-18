// The Series page (#562, spec #560 "The Series page"; boards Series.dc.html, SeriesMore.dc.html, DesktopSeries.dc.html
// for the column): `#series/<id>` for a saved series. The Page header (the back button named after where it goes, the
// series' name as its Title), the intro line, Books · N with the series rows, Related works · N, then Remove series.
// It replaces the series dialog for a saved series; a series that is not saved still opens the dialog. A row's Add
// opens the Add sheet (#563) at `#series/<id>/add`, over the page. The words and
// rules are in series-model.ts; the books in the library come from the library by work on this device (#528).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SERIES_SAVED_POLL_MS } from "../components/SeriesWorkStatus";
import { api, ApiError, userId } from "../lib";
import { refreshLibraryWorks, useStoredWorksWithPlaces } from "../library-works-store";
import { openSheet, useAddress } from "../navigation";
import { BookRow } from "../parts/BookRow";
import { Button } from "../parts/Button";
import { Group } from "../parts/Group";
import { PageHeader } from "../parts/PageHeader";
import { Row } from "../parts/Row";
import { InfoMark } from "../parts/Tooltip";
import { usePlayer } from "../player";
import { normalizeSeriesLanguage } from "../series-selection";
import { forgetSeriesAnswer, isNoConnection, keepSeriesAnswer, seriesAnswerKey, storedSeriesAnswer } from "../series-store";
import { tip } from "../tooltip-texts";
import type { Book } from "../types";
import { chosenRecording } from "./book-model";
import { openAddSheet, SeriesAddSheet } from "./series-add-sheet";
import { SeriesRemoveDialog } from "./series-remove-dialog";
import type { SeriesAddSeries } from "./series-add-model";
import { DISMISS_LABEL, NEW_CARD_LINE, NEW_MARK, seriesPageModel, withoutNew, type SeriesPageSeries, type SeriesRow } from "./series-model";
import "./series-page.css";

/** The preferred language of a series' books, as today's series dialog keeps it. */
export const SERIES_LANGUAGE_KEY = "sonder-series-language";
export function seriesLanguage(): string {
  try {
    return normalizeSeriesLanguage(localStorage.getItem(SERIES_LANGUAGE_KEY) || navigator.language || "en") || "en";
  } catch {
    return normalizeSeriesLanguage(navigator.language || "en") || "en";
  }
}

type SavedSeries = SeriesAddSeries;

/** Without a connection the page asks for the series again this often, until it is answered (#568). */
export const SERIES_OFFLINE_RETRY_MS = 5000;

/**
 * The series last read, by account and id: Back to the page shows it at once (and so at its scroll position) while
 * it is read again.
 */
const lastRead = new Map<string, SavedSeries>();

type Props = {
  id: string;
  admin: boolean;
  online: boolean;
  /** Every book of `GET /api/books` the app holds: the recordings as the player plays them. */
  books: Book[];
  /** Grows when today's series dialog saved something: the page reads the series again. */
  revision: number;
  /** The address names a series this account has not saved: today's dialog shows it (until the not-saved page). */
  onNotSaved: (seriesId: number) => void;
  /** The series was removed. */
  onRemoved: () => void;
  /**
   * The page stands beside the Library's list of saved series (a desktop, #567; board DesktopSeries.dc.html): the
   * Library holds the page's Title and the way back, so the series' name is a heading with the intro beside it.
   */
  beside?: boolean;
};

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5l11 7-11 7z" />
    </svg>
  );
}

/** Something of the series is moving: a series search waits or runs, or a download is on its way. */
function moving(series: SavedSeries | null) {
  return !!series?.works.some(
    (work) =>
      work.acquisition?.audio?.status === "pending" ||
      work.acquisition?.audio?.status === "searching" ||
      work.acquisition?.ebook?.status === "pending" ||
      work.acquisition?.ebook?.status === "searching" ||
      work.mediaState?.state === "queued",
  );
}

export function SeriesPage({ id, admin, online, books, revision, onNotSaved, onRemoved, beside = false }: Props) {
  const address = useAddress();
  const p = usePlayer();
  const library = useStoredWorksWithPlaces();
  const key = `${userId()}:${id}`;
  const seriesId = Number(id);
  const [series, setSeries] = useState<SavedSeries | null>(() => lastRead.get(key) ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The server could not be reached: the page shows the series this device kept, with the No connection card (#568).
  // The browser going offline says so at once; a read that is answered says the connection is back.
  const [offline, setUnreached] = useState(!online);
  // The page is left or its series was removed: an answer still on its way changes nothing. Without this, removing
  // the series read it once more (the revision grows), and its "could not be found" opened today's dialog for the
  // series just removed, over the Library (#567).
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);
  const [removeOpen, setRemoveOpen] = useState(false);
  // The preferred language: the Add sheet changes it, for the page under it too.
  const [language, setLanguage] = useState(seriesLanguage);
  const changeLanguage = (next: string) => {
    setLanguage(next);
    try {
      localStorage.setItem(SERIES_LANGUAGE_KEY, next);
    } catch {
      // Without storage the language holds for this page only.
    }
  };
  /** Dismiss of the New card: sending, and its failure, shown on the card. */
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState("");

  const load = useCallback(
    async (refresh = false) => {
      if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
        address.navigate({ name: "library" }, { replace: true });
        return;
      }
      if (gone.current) return;
      try {
        const value = await api<SavedSeries>(
          `/series/${seriesId}?language=${encodeURIComponent(seriesLanguage())}${refresh ? "&refresh=1" : ""}`,
          // Not the browser's HTTP cache: without a connection it would answer as if the server had (Firefox does), and
          // the page would offer what cannot be done; the device's own copy stands in for it (#568).
          { cache: "no-store" },
        );
        if (gone.current) return;
        lastRead.set(key, value);
        setSeries(value);
        setError("");
        setUnreached(false);
        // The last answer of a saved series opened on this device: shown without a connection (#568).
        void keepSeriesAnswer(seriesAnswerKey(seriesId), value);
      } catch (reason) {
        if (gone.current) return;
        // No connection: the series this page holds, else the one this device kept; a series this device never opened
        // (or one that is not saved, which needs a connection) shows the Library.
        if (isNoConnection(reason)) {
          const kept = lastRead.get(key) ?? (await storedSeriesAnswer<SavedSeries>(seriesAnswerKey(seriesId)));
          if (gone.current) return;
          if (kept) {
            lastRead.set(key, kept);
            setSeries(kept);
            setError("");
            setUnreached(true);
          } else address.navigate({ name: "library" }, { replace: true });
          return;
        }
        // Not saved by this account: today's dialog shows the series, over the Library.
        if (reason instanceof ApiError && reason.status < 500 && /could not be found/i.test(reason.message)) {
          lastRead.delete(key);
          void forgetSeriesAnswer(seriesAnswerKey(seriesId));
          address.navigate({ name: "library" }, { replace: true });
          onNotSaved(seriesId);
          return;
        }
        setError((reason as Error).message);
      }
    },
    [key, seriesId],
  );
  useEffect(() => {
    setRemoveOpen(false);
    setDismissError("");
    void load();
  }, [load]);
  // Today's dialog saved books (an Add): the series and the library by work are read again.
  useEffect(() => {
    if (!revision) return;
    void load();
    void refreshLibraryWorks().catch(() => {});
  }, [revision]);
  // The connection is back: the page reads the series again (#568). The browser's word is not always given (a network
  // that answers nothing, a browser that does not say it is back online), so without a connection it also asks again
  // every few seconds.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (!online) setUnreached(true);
    else if (!wasOnline.current) void load();
    wasOnline.current = online;
  }, [online, load]);
  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => void load(), SERIES_OFFLINE_RETRY_MS);
    return () => clearInterval(timer);
  }, [offline, load]);
  const isMoving = moving(series);
  useEffect(() => {
    if (!isMoving) return;
    const timer = setInterval(() => void load(), SERIES_SAVED_POLL_MS);
    return () => clearInterval(timer);
  }, [isMoving, load]);

  const model = useMemo(
    () => (series ? seriesPageModel(series, { library, admin, language, offline }) : null),
    [series, library, admin, language, offline],
  );

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const retryRefresh = () => run(() => load(true));
  // Dismiss: acknowledges every work the answer marks new; the card and the marks clear, then the series is read again.
  const dismiss = async (bookIds: number[]) => {
    setDismissing(true);
    setDismissError("");
    try {
      await api(`/series/${seriesId}/ack`, { method: "POST", body: JSON.stringify({ bookIds }) });
      setSeries((current) => {
        if (!current) return current;
        const cleared = withoutNew(current);
        lastRead.set(key, cleared);
        return cleared;
      });
      void load();
    } catch (reason) {
      setDismissError((reason as Error).message);
    } finally {
      setDismissing(false);
    }
  };
  const play = async (workId: string) => {
    const work = library.get(workId);
    const recording = work ? chosenRecording(work) : null;
    const book = recording && books.find((b) => b.recordingId === recording.recordingId);
    if (!book) return;
    if (p.book?.recordingId === book.recordingId) {
      if (!p.playing) p.toggle();
    } else await p.play(book);
    openSheet("now-playing");
  };
  const retry = (row: SeriesRow) =>
    run(async () => {
      const action = row.action;
      if (action?.kind === "retry-search") {
        for (const kind of action.kinds)
          await api(`/series/${seriesId}/works/${row.bookId}/acquisition/retry`, { method: "POST", body: JSON.stringify({ kind }) });
      } else if (action?.kind === "retry-download" && row.workId) {
        await api(`/works/${encodeURIComponent(row.workId)}/media/retry`, { method: "POST" });
        await refreshLibraryWorks().catch(() => {});
      }
      await load();
    });

  const renderRow = (row: SeriesRow) => {
    const open = row.workId ? () => address.navigate({ name: "book", workId: row.workId! }) : undefined;
    const action =
      row.action?.kind === "add" ? (
        <Button kind="secondary" aria-label={`Add ${row.title}`} disabled={row.actionOff} onClick={() => openAddSheet(seriesId, row.bookId)}>
          Add
        </Button>
      ) : row.action?.kind === "retry-search" || row.action?.kind === "retry-download" ? (
        <Button kind="secondary" aria-label={`Retry ${row.title}`} disabled={busy || row.actionOff} onClick={() => void retry(row)}>
          Retry
        </Button>
      ) : row.action?.kind === "play" ? (
        <Button kind="primary" className="series-page-play" icon={<PlayIcon />} label={`Listen to ${row.title}`} onClick={() => void play(row.workId!)} />
      ) : undefined;
    return (
      <BookRow
        key={row.bookId}
        title={row.title}
        status={row.status}
        lead={row.isNew ? NEW_MARK : null}
        cover={row.cover}
        number={row.number}
        marks={row.marks}
        progress={row.progress}
        failed={row.failed}
        onClick={open}
        action={action}
        raised={row.action?.kind === "play"}
      />
    );
  };

  return (
    <section className="series-page" aria-label="Series">
      {beside ? (
        <div className="series-page-beside-head">
          <h2 className="type-heading">{model?.title ?? ""}</h2>
          <span className="type-label">{model ? model.intro : error ? "" : "Loading…"}</span>
        </div>
      ) : (
        <>
          <PageHeader title={model?.title ?? ""} back />
          {model && <p className="series-page-intro type-label">{model.intro}</p>}
          {!model && !error && <p className="series-page-intro type-label">Loading…</p>}
        </>
      )}

      {model?.noConnection && (
        <div className="series-page-card" role="group" aria-label={model.noConnection}>
          <p className="type-label" role="status">
            {model.noConnection}
          </p>
        </div>
      )}

      {model?.refreshError && (
        <div className="series-page-card" role="group" aria-label="Hardcover could not be read">
          <p className="type-label" role="alert">
            {model.refreshError}
          </p>
          <Button kind="secondary" disabled={busy || !online} onClick={() => void retryRefresh()}>
            Retry
          </Button>
        </div>
      )}

      {model?.newCard && (
        <div className="series-page-card series-page-new" role="group" aria-label={NEW_CARD_LINE}>
          <div className="series-page-new-text">
            <span className="type-body">{NEW_CARD_LINE}</span>
            <span className="series-page-new-titles type-label">{model.newCard.titles}</span>
            {dismissError && (
              <span className="series-page-new-error type-label" role="alert">
                {dismissError}
              </span>
            )}
          </div>
          <Button kind="quiet" disabled={dismissing || model.dismissOff} onClick={() => void dismiss(model.newCard!.bookIds)}>
            {DISMISS_LABEL}
          </Button>
        </div>
      )}

      {model && model.books.length > 0 && (
        <Group caption={`Books · ${model.books.length}`} info={<InfoMark name="Books" text={tip("seriesBooks")} />}>
          {model.books.map(renderRow)}
        </Group>
      )}
      {model && model.related.length > 0 && <Group caption={`Related works · ${model.related.length}`}>{model.related.map(renderRow)}</Group>}

      {model && (
        <div className="series-page-remove">
          <Group label="Series">
            <Row label="Remove series" disabled={busy || model.removeOff} onClick={() => setRemoveOpen(true)} />
          </Group>
        </div>
      )}

      {error && (
        <p className="series-page-error type-label" role="alert">
          {error}
        </p>
      )}

      {address.route.name === "series-add" && (
        <SeriesAddSheet
          seriesId={seriesId}
          series={series}
          admin={admin}
          online={!offline}
          language={language}
          onLanguage={changeLanguage}
          onAdded={() => {
            void load();
            void refreshLibraryWorks().catch(() => {});
          }}
        />
      )}

      {series && (
        <SeriesRemoveDialog
          seriesId={seriesId}
          name={model?.title ?? series.name}
          admin={admin}
          online={online}
          open={removeOpen}
          onClose={() => setRemoveOpen(false)}
          onRemoved={() => {
            gone.current = true;
            setRemoveOpen(false);
            lastRead.delete(key);
            void forgetSeriesAnswer(seriesAnswerKey(seriesId));
            onRemoved();
            void refreshLibraryWorks().catch(() => {});
            if (address.backTarget().name === "library") address.goBack();
            else address.navigate({ name: "library" }, { replace: true });
          }}
        />
      )}
    </section>
  );
}
