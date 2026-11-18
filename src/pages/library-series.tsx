// The Library's Series chip (#567, spec #560 "The Library's Series chip"; boards LibrarySeries.dc.html and
// DesktopSeries.dc.html): the saved series of `GET /api/series` as rows of a Group (a stacked cover, the name and
// "<author> · N of M finished"), then the Find a series row. A row opens `#series/<id>`; on a desktop the series stands
// beside the list. The words and rows are in library-series-model.ts.
import { useEffect, useId, useState } from "react";
import { accountAnswer } from "../account-answer";
import { api, userId } from "../lib";
import { Group } from "../parts/Group";
import { Chevron } from "../parts/icons";
import { Row } from "../parts/Row";
import { isNoConnection, keepSeriesAnswer, SERIES_LIST_KEY, storedSeriesAnswer } from "../series-store";
import { NO_CONNECTION_LINE } from "../status-lines";
import {
  FIND_A_SERIES,
  NO_SAVED_SERIES,
  SERIES_HEADING,
  seriesListRows,
  type SavedSeriesItem,
  type SeriesListRow,
} from "./library-series-model";
import "./library-series.css";

/** The saved series last read, for the account they were read for: the list shown again starts with them. */
const lastSeries = accountAnswer<SavedSeriesItem[]>(userId);

/**
 * The saved series of this account: the last answer at once (so Back finds the list as it was left, at its scroll
 * position), then a fresh one. `revision` grows when a series was saved or removed; `visit` changes when the list is
 * shown again (the Library, a series), so counts changed on a Book page are read once more. Without a connection the
 * list is the last answer this device kept (#568), read again when `online` comes back.
 */
export function useSavedSeries(revision: number, visit: string, online = true): { items: SavedSeriesItem[] | undefined; error: string } {
  const [items, setItems] = useState<SavedSeriesItem[] | undefined>(() => lastSeries.kept());
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    lastSeries
      .read(() => api<SavedSeriesItem[]>("/series", { cache: "no-store" }))
      .then((answer) => {
        if (!answer || !active) return;
        setItems(answer.value);
        setError("");
        void keepSeriesAnswer(SERIES_LIST_KEY, answer.value);
      })
      .catch(async (reason) => {
        if (!active) return;
        if (isNoConnection(reason)) {
          const kept = lastSeries.kept() ?? (await storedSeriesAnswer<SavedSeriesItem[]>(SERIES_LIST_KEY));
          if (!active) return;
          if (kept) {
            setItems(kept);
            setError("");
          } else setError(NO_CONNECTION_LINE);
          return;
        }
        setError((reason as Error).message);
      });
    return () => {
      active = false;
    };
  }, [revision, visit, online]);
  return { items, error };
}

function StackedCover({ covers }: { covers: (string | null)[] }) {
  // The first number in front; with no cover, one empty raised square.
  const layers = covers.length ? covers : [null];
  return (
    <span className="library-series-stack" aria-hidden="true">
      {layers
        .map((cover, index) => (
          <span key={index} className="library-series-cover" data-layer={index}>
            {cover && <img src={cover} alt="" loading="lazy" decoding="async" />}
          </span>
        ))
        .reverse()}
    </span>
  );
}

function SeriesListItem({ row, beside, onOpen }: { row: SeriesListRow; beside: boolean; onOpen: (id: number) => void }) {
  const id = useId();
  return (
    <li className="library-series-item">
      <button
        type="button"
        className="library-series-row"
        aria-labelledby={`${id}-name ${id}-line`}
        aria-current={row.current ? "true" : undefined}
        data-current={row.current ? "" : undefined}
        onClick={() => onOpen(row.id)}
      >
        <StackedCover covers={row.covers} />
        <span className="library-series-text">
          <span id={`${id}-name`} className="library-series-name type-body">
            {row.name}
          </span>
          <span id={`${id}-line`} className="library-series-line type-label">
            {row.line}
          </span>
        </span>
        {/* Beside the series (a desktop) the list has no chevron: the row opens nothing new, it shows its series. */}
        {!beside && (
          <span className="library-series-end">
            <Chevron />
          </span>
        )}
      </button>
    </li>
  );
}

export function SeriesList({
  items,
  error,
  query,
  current = null,
  beside = false,
  onOpen,
  onFind,
}: {
  items: SavedSeriesItem[] | undefined;
  error: string;
  query: string;
  /** The series shown beside the list. */
  current?: number | null;
  /** The list stands beside a series (a desktop): no heading of its own, no chevrons. */
  beside?: boolean;
  onOpen: (id: number) => void;
  onFind: () => void;
}) {
  const rows = items ? seriesListRows(items, { query, current }) : [];
  return (
    <section className="library-series" aria-label="Saved series">
      {!beside && <h2 className="library-series-heading type-heading">{SERIES_HEADING}</h2>}
      {items === undefined && !error ? (
        <p className="library-series-note type-label">Loading…</p>
      ) : rows.length ? (
        <Group label={SERIES_HEADING}>
          {rows.map((row) => (
            <SeriesListItem key={row.id} row={row} beside={beside} onOpen={onOpen} />
          ))}
        </Group>
      ) : (
        // A search that matches none of them shows no rows; "No saved series" is for an account that has none.
        !error && !items?.length && <p className="library-series-note type-label">{NO_SAVED_SERIES}</p>
      )}
      {error && (
        <p className="library-series-note library-series-error type-label" role="alert">
          {error}
        </p>
      )}
      <Group label={FIND_A_SERIES}>
        <Row label={FIND_A_SERIES} opens onClick={onFind} />
      </Group>
    </section>
  );
}
