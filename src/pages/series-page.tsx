// The Series page (#562, spec #560 "The Series page"; boards Series.dc.html, SeriesMore.dc.html, DesktopSeries.dc.html
// for the column): `#series/<id>` for a saved series. The Page header (the back button named after where it goes, the
// series' name as its Title), the intro line, Books · N with the series rows, Related works · N, then Remove series.
// It replaced the series dialog (#569) for a saved series and for one that is not saved (#564). A row's Add
// opens the Add sheet (#563) at `#series/<id>/add`, over the page. The words and
// rules are in series-model.ts; the books in the library come from the library by work on this device (#528).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, userId } from "../lib";
import { refreshLibraryWorks, useStoredWorksWithPlaces } from "../library-works-store";
import { useAddress } from "../navigation";
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
import { openAddSheet, openSaveSheet, SeriesAddSheet } from "./series-add-sheet";
import { SeriesRemoveDialog } from "./series-remove-dialog";
import type { SeriesAddSeries } from "./series-add-model";
import { DISMISS_LABEL, NEW_CARD_LINE, NEW_MARK, seriesPageModel, withoutNew, type SeriesPageSeries, type SeriesRow } from "./series-model";
import "./series-page.css";

/** The preferred language of a series' books, under the key the series dialog of an older build keeps it. */
export const SERIES_LANGUAGE_KEY = "sonder-series-language";
export function seriesLanguage(): string {
  try {
    return normalizeSeriesLanguage(localStorage.getItem(SERIES_LANGUAGE_KEY) || navigator.language || "en") || "en";
  } catch {
    return normalizeSeriesLanguage(navigator.language || "en") || "en";
  }
}

type SavedSeries = SeriesAddSeries;

/** While a book of the series is on its way (a search or a download), the page reads the series again this often. */
export const SERIES_SAVED_POLL_MS = 2500;

/** Without a connection the page asks for the series again this often, until it is answered (#568). */
export const SERIES_OFFLINE_RETRY_MS = 5000;

/**
 * The series last read, by account and id: Back to the page shows it at once (and so at its scroll position) while
 * it is read again.
 */
const lastRead = new Map<string, { series: SavedSeries; saved: boolean }>();

type Props = {
  id: string;
  admin: boolean;
  online: boolean;
  /** Every book of `GET /api/books` the app holds: the recordings as the player plays them. */
  books: Book[];
  /** Grows when a series was saved or removed: the page reads the series again. */
  revision: number;
  /** Save series saved the series: the app reads its saved series and library again. */
  onSaved: () => void;
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

export function SeriesPage({ id, admin, online, books, revision, onSaved, onRemoved, beside = false }: Props) {
  const address = useAddress();
  const p = usePlayer();
  const library = useStoredWorksWithPlaces();
  const key = `${userId()}:${id}`;
  // AudiobookDB's id (#721): text; an address from before (a Hardcover number) finds no saved series.
  const seriesId = id;
  const [series, setSeries] = useState<SavedSeries | null>(() => lastRead.get(key)?.series ?? null);
  // This account saved the series; a series that is not saved is AudiobookDB's, with Save series (#564).
  const [saved, setSaved] = useState(() => lastRead.get(key)?.saved ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The server could not be reached: the page shows the series this device kept, with the No connection card (#568).
  // The browser going offline says so at once; a read that is answered says the connection is back.
  const [offline, setUnreached] = useState(!online);
  // The page is left or its series was removed: an answer still on its way changes nothing. Without this, removing
  // the series read it once more (the revision grows), and showed the series just removed as not saved, over the
  // Library (#567).
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
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(seriesId)) {
        address.navigate({ name: "library" }, { replace: true });
        return;
      }
      if (gone.current) return;
      const language = encodeURIComponent(seriesLanguage());
      // Not the browser's HTTP cache: without a connection it would answer as if the server had (Firefox does), and
      // the page would offer what cannot be done; the device's own copy stands in for it (#568).
      const fresh = { cache: "no-store" as const };
      const show = (value: SavedSeries, isSaved: boolean, unreached = false) => {
        lastRead.set(key, { series: value, saved: isSaved });
        setSeries(value);
        setSaved(isSaved);
        setError("");
        setUnreached(unreached);
      };
      try {
        // Whether this account saved the series (spec #560 "The Series page"): its saved series, or AudiobookDB's.
        const list = await api<{ id: string }[]>("/series", fresh);
        if (gone.current) return;
        if (list.some((item) => item.id === seriesId)) {
          const value = await api<SavedSeries>(`/series/${encodeURIComponent(seriesId)}?language=${language}${refresh ? "&refresh=1" : ""}`, fresh);
          if (gone.current) return;
          show(value, true);
          // The last answer of a saved series opened on this device: shown without a connection (#568).
          void keepSeriesAnswer(seriesAnswerKey(seriesId), value);
          return;
        }
        // Not saved by this account: the page of AudiobookDB's series, with Save series. A copy this device kept from
        // when it was saved is not this series any more.
        void forgetSeriesAnswer(seriesAnswerKey(seriesId));
        const value = await api<SavedSeries>(`/discover/series/${encodeURIComponent(seriesId)}?language=${language}`, fresh);
        if (gone.current) return;
        show(value, false);
      } catch (reason) {
        if (gone.current) return;
        // No connection: the saved series this page holds, else the one this device kept; a series this device never
        // opened, or one that is not saved (it needs a connection), shows the Library.
        if (isNoConnection(reason)) {
          const held = lastRead.get(key);
          const kept = held?.saved ? held.series : await storedSeriesAnswer<SavedSeries>(seriesAnswerKey(seriesId));
          if (gone.current) return;
          if (kept) show(kept, true, true);
          else address.navigate({ name: "library" }, { replace: true });
          return;
        }
        // A series that cannot be read at all: the message, and Back.
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
  // A series was saved or removed elsewhere in the app: the series and the library by work are read again.
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
    () => (series ? seriesPageModel(series, { library, admin, language, offline, saved }) : null),
    [series, library, admin, language, offline, saved],
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
  const dismiss = async (bookIds: string[]) => {
    setDismissing(true);
    setDismissError("");
    try {
      await api(`/series/${encodeURIComponent(seriesId)}/ack`, { method: "POST", body: JSON.stringify({ bookIds }) });
      setSeries((current) => {
        if (!current) return current;
        const cleared = withoutNew(current);
        lastRead.set(key, { series: cleared, saved: true });
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
    // Now playing on its Listen face (#593).
    address.navigate({ name: "listen", workId });
  };
  const retry = (row: SeriesRow) =>
    run(async () => {
      const action = row.action;
      if (action?.kind === "retry-search") {
        for (const kind of action.kinds)
          await api(`/series/${encodeURIComponent(seriesId)}/works/${encodeURIComponent(row.bookId)}/acquisition/retry`, { method: "POST", body: JSON.stringify({ kind }) });
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
        number={row.label ?? row.number}
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

      {model?.save && (
        <Button kind="primary" className="series-page-save" disabled={!online} onClick={() => openSaveSheet(seriesId)}>
          {model.save.label}
        </Button>
      )}

      {model?.noConnection && (
        <div className="series-page-card" role="group" aria-label={model.noConnection}>
          <p className="type-label" role="status">
            {model.noConnection}
          </p>
        </div>
      )}

      {model?.refreshError && (
        <div className="series-page-card" role="group" aria-label="AudiobookDB could not be read">
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

      {model?.removable && (
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
          saved={saved}
          admin={admin}
          online={!offline && online}
          language={language}
          onLanguage={changeLanguage}
          onAdded={() => {
            // After Save series the page shows the saved series; the app's list of saved series grows by it.
            if (!saved) {
              setSaved(true);
              onSaved();
            }
            void load();
            void refreshLibraryWorks().catch(() => {});
          }}
        />
      )}

      {series && saved && (
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
