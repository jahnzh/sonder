// Discover (#575, spec #572 "Discover"; boards Discover.dc.html, DiscoverResults.dc.html, DiscoverNothing.dc.html,
// DiscoverSeries.dc.html): one search field with Books or Series under it. Before a search it lists the works on the
// server outside the user's library; a book search asks the server and Hardcover at once and shows each group when
// its answer arrives; every row opens its Book page, a series its Series page. For the administrator the last row is
// "Search for a recording". The query, the segment and the answers are kept in the history entry, so Back from a
// book shows them; a reload runs the kept query again. What it shows for which answers is discover-model.ts.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { BookRow } from "../parts/BookRow";
import { Button } from "../parts/Button";
import { Group } from "../parts/Group";
import { PageHeader } from "../parts/PageHeader";
import { Segmented } from "../parts/Segmented";
import { api } from "../lib";
import { refreshLibraryWorks } from "../library-works-store";
import { wantToReadNote } from "../status-lines";
import type { Notify } from "./shared";
import { pageData, setPageData } from "../navigation";
import { writeAddress } from "../routes";
import type { WorkResult } from "../types";
import {
  bookResults,
  keptOf,
  searchWords,
  seriesLine,
  startRows,
  wantToReadActionName,
  withWantToRead,
  type Answer,
  type DiscoverRow,
  type DiscoverSegment,
  type HardcoverHit,
  type SeriesResult,
} from "./discover-model";
import { SeriesListItem } from "./library-series";
import "./discover-page.css";

/** Want to read's mark: a bookmark, filled while the book is on it. */
function WantToReadIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h12v16l-6-4-6 4z" />
    </svg>
  );
}

/** The Library's plus (or Find a series) asked for the search: Discover shown next focuses its field on that segment. */
let searchAsked: DiscoverSegment | null = null;
export function askDiscoverSearch(segment: DiscoverSegment) {
  searchAsked = segment;
}

/**
 * This load of the app. Answers kept in a history entry are shown again by Back within the same load; a reload (a new
 * load) runs the kept query again instead of showing what an earlier load received.
 */
const LOAD = Math.random().toString(36).slice(2);

export const HARDCOVER_FAILED_LINE = "Hardcover could not be searched.";
export const SERVER_FAILED_LINE = "The server could not be searched.";
export const OFFLINE_SEARCH_LINE = "Searching needs a connection.";
export const CONNECT_HARDCOVER_LINE = "Connect Hardcover in Settings to search its books too";
export const CONNECT_HARDCOVER_SERIES_LINE = "Connect Hardcover to search for series.";

const waiting = { state: "waiting" } as const;
const answered = <T,>(value: T): Answer<T> => ({ state: "done", value });

type State = {
  segment: DiscoverSegment;
  text: string;
  searched: string | null;
  works: Answer<WorkResult[]>;
  hits: Answer<HardcoverHit[]>;
  series: Answer<SeriesResult[]>;
};

/** The entry's kept state, its answers only when they came in this load. */
function initialState(): { state: State; rerun: boolean } {
  const data = pageData();
  const kept = keptOf(data);
  const sameLoad = (data as { discoverLoad?: unknown } | null | undefined)?.discoverLoad === LOAD;
  const asked = searchAsked;
  if (!kept || asked)
    return {
      state: { segment: asked ?? "books", text: "", searched: null, works: waiting, hits: waiting, series: waiting },
      rerun: false,
    };
  const keep = <T,>(value: T[] | undefined): Answer<T[]> => (sameLoad && value ? answered(value) : waiting);
  return {
    state: { segment: kept.segment, text: kept.text, searched: kept.searched, works: keep(kept.works), hits: keep(kept.hits), series: keep(kept.series) },
    rerun: !!kept.searched && !sameLoad,
  };
}

export function DiscoverPage({
  admin,
  online,
  hardcoverConnected,
  settingsRead,
  onBook,
  onSeries,
  onRecording,
  onConnect,
  notify,
}: {
  admin: boolean;
  online: boolean;
  hardcoverConnected: boolean;
  /** The settings are read: whether Hardcover is connected is known. */
  settingsRead: boolean;
  onBook: (workId: string) => void;
  onSeries: (id: number) => void;
  onRecording: (query: string) => void;
  onConnect: () => void;
  /** Says what a row's Want to read action did. */
  notify?: Notify;
}) {
  const [{ state: first, rerun }] = useState(initialState);
  const [state, setState] = useState<State>(first);
  const [start, setStart] = useState<Answer<WorkResult[]>>(waiting);
  const field = useRef<HTMLInputElement>(null);
  // Each search counts up; an answer for an earlier search than the latest is dropped.
  const searchId = useRef(0);
  const { segment, text, searched } = state;

  useEffect(() => {
    if (!searchAsked) return;
    searchAsked = null;
    field.current?.focus();
  }, []);

  // The entry keeps the query, the segment and the answers (#455): Back to it shows them as they were left.
  // Only while Discover's own entry is the current one: under the Get sheet without a book after a reload (#576) the
  // current entry is the sheet's, whose kept search this would replace.
  useEffect(() => {
    if (location.hash !== writeAddress({ name: "discover" })) return;
    const done = <T,>(answer: Answer<T>) => (answer.state === "done" ? answer.value : undefined);
    setPageData({
      discover: { segment, text, searched, works: done(state.works), hits: done(state.hits), series: done(state.series) },
      discoverLoad: LOAD,
    });
  }, [segment, text, searched, state.works, state.hits, state.series]);

  // Before a search: the works on the server that are not in the user's library.
  useEffect(() => {
    if (!online) return;
    let active = true;
    api<{ works: WorkResult[] }>("/works")
      .then((answer) => active && setStart(answered(answer.works)))
      .catch(() => active && setStart({ state: "failed" }));
    return () => {
      active = false;
    };
  }, [online]);

  const searchBooks = (words: string, groups: { server: boolean; hardcover: boolean } = { server: true, hardcover: true }) => {
    const id = ++searchId.current;
    const current = () => id === searchId.current;
    const q = encodeURIComponent(words);
    setState((s) => ({
      ...s,
      searched: words,
      works: groups.server ? waiting : s.works,
      hits: groups.hardcover ? waiting : s.hits,
    }));
    // Both requests go at once; each group shows when its own answer arrives.
    if (groups.server)
      api<{ works: WorkResult[] }>(`/works?q=${q}`)
        .then((answer) => current() && setState((s) => ({ ...s, works: answered(answer.works) })))
        .catch(() => current() && setState((s) => ({ ...s, works: { state: "failed" } })));
    if (groups.hardcover && hardcoverConnected)
      api<{ hits?: HardcoverHit[] }>(`/discover/hardcover?q=${q}`)
        .then((answer) => current() && setState((s) => ({ ...s, hits: answered(answer.hits ?? []) })))
        .catch(() => current() && setState((s) => ({ ...s, hits: { state: "failed" } })));
  };
  const searchSeries = (words: string) => {
    const id = ++searchId.current;
    setState((s) => ({ ...s, searched: words, series: waiting }));
    api<SeriesResult[]>(`/discover/series?q=${encodeURIComponent(words)}`)
      .then((answer) => id === searchId.current && setState((s) => ({ ...s, series: answered(answer) })))
      .catch(() => id === searchId.current && setState((s) => ({ ...s, series: { state: "failed" } })));
  };
  const run = (seg: DiscoverSegment, words: string) => {
    if (seg === "books") searchBooks(words);
    else if (hardcoverConnected) searchSeries(words);
  };

  // A reload runs the kept query again, once the settings say whether Hardcover is searched.
  const reran = useRef(!rerun);
  useEffect(() => {
    if (reran.current || !settingsRead || !online || !searched) return;
    reran.current = true;
    run(segment, searched);
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const words = searchWords(text);
    if (!words || !online) return;
    field.current?.blur();
    run(segment, words);
  };
  const choose = (next: DiscoverSegment) => {
    searchId.current++;
    const words = searchWords(text);
    setState((s) => ({ ...s, segment: next, searched: null, works: waiting, hits: waiting, series: waiting }));
    // The words in the field are searched again in the other segment.
    if (words && online) run(next, words);
  };
  const changeText = (value: string) => {
    setState((s) => (value.trim() ? { ...s, text: value } : { ...s, text: value, searched: null, works: waiting, hits: waiting, series: waiting }));
    if (!value.trim()) searchId.current++;
  };

  // Want to read on a row (#721 part c1): the row's own action, by work id, until the answers are read again.
  const [tapped, setTapped] = useState<Record<string, boolean>>({});
  const [wanting, setWanting] = useState<string | null>(null);
  const toggleWantToRead = async (row: DiscoverRow) => {
    const on = !row.wantToRead;
    setWanting(row.workId);
    try {
      await api(`/works/${encodeURIComponent(row.workId)}/want-to-read`, { method: on ? "PUT" : "DELETE" });
      setTapped((t) => ({ ...t, [row.workId]: on }));
      notify?.(wantToReadNote(on));
      window.dispatchEvent(new Event("sonder:library-changed"));
      await refreshLibraryWorks().catch(() => {});
    } catch (error) {
      notify?.((error as Error).message, true);
    } finally {
      setWanting(null);
    }
  };
  const rows = (list: DiscoverRow[]) =>
    list.map((listed) => {
      const row = withWantToRead(listed, tapped[listed.workId]);
      return (
        <BookRow
          key={row.workId}
          title={row.title}
          status={row.status}
          cover={row.cover}
          onClick={() => onBook(row.workId)}
          action={
            <Button
              kind="quiet"
              label={wantToReadActionName(row)}
              aria-pressed={row.wantToRead}
              disabled={!online || wanting === row.workId}
              icon={<WantToReadIcon on={row.wantToRead} />}
              onClick={() => void toggleWantToRead(row)}
            />
          }
        />
      );
    });
  const failed = (line: string, retry: () => void) => (
    <div className="discover-failed" role="alert">
      <p className="type-label">{line}</p>
      <Button kind="secondary" disabled={!online} onClick={retry}>
        Retry
      </Button>
    </div>
  );
  const recordingRow = searched && admin && (
    <Group label="Search for a recording">
      <li className="part-book-row-item">
        <button type="button" className="discover-recording" onClick={() => onRecording(searched)}>
          <span className="discover-recording-text">
            <span className="type-body">Search for a recording</span>
            <span className="discover-recording-line type-label">of “{searched}”</span>
          </span>
          <svg className="discover-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      </li>
    </Group>
  );

  let body: React.ReactNode = null;
  if (!searched) {
    const list = start.state === "done" ? startRows(start.value) : [];
    body = list.length ? <Group caption="On the server, not in your library">{rows(list)}</Group> : null;
  } else if (segment === "books") {
    const results = bookResults({ server: state.works, hardcover: state.hits, hardcoverConnected, admin });
    body = (
      <>
        {results.nothing ? (
          <div className="discover-nothing" role="status">
            <p className="discover-nothing-title type-body">No books found</p>
            <p className="type-label">Nothing on the server or on Hardcover matches “{searched}”.</p>
          </div>
        ) : (
          <>
            {results.serverFailed && failed(SERVER_FAILED_LINE, () => searchBooks(searched, { server: true, hardcover: false }))}
            {!!results.server?.length && <Group caption="On the server">{rows(results.server)}</Group>}
            {results.hardcoverFailed && failed(HARDCOVER_FAILED_LINE, () => searchBooks(searched, { server: false, hardcover: true }))}
            {!!results.hardcover?.length && <Group caption="From Hardcover">{rows(results.hardcover)}</Group>}
          </>
        )}
        {recordingRow}
      </>
    );
  } else if (hardcoverConnected) {
    const found = state.series;
    body =
      found.state === "failed" ? (
        failed(HARDCOVER_FAILED_LINE, () => searchSeries(searched))
      ) : found.state === "done" ? (
        found.value.length ? (
          <Group caption={`Series · ${found.value.length}`}>
            {found.value.map((series) => (
              <SeriesListItem
                key={series.id}
                row={{ id: series.id, name: series.name, line: seriesLine(series, found.value), covers: [series.cover, null, null], current: false }}
                beside={false}
                onOpen={onSeries}
              />
            ))}
          </Group>
        ) : (
          <div className="discover-nothing" role="status">
            <p className="type-label">No series found.</p>
          </div>
        )
      ) : null;
  }
  const busy = !!searched && (segment === "books" ? state.works.state === "waiting" || (hardcoverConnected && state.hits.state === "waiting") : state.series.state === "waiting");

  return (
    <section className="discover-page" aria-label="Discover">
      <PageHeader title="Discover" />
      <div className="discover-head">
        <form role="search" onSubmit={submit}>
          <label className="discover-field">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              ref={field}
              className="discover-input"
              type="search"
              enterKeyHint="search"
              aria-label={segment === "books" ? "Search for a book" : "Search for a series"}
              placeholder="Title or author"
              value={text}
              maxLength={150}
              onChange={(event) => changeText(event.target.value)}
            />
          </label>
        </form>
        <Segmented
          label="Search for"
          options={[
            { value: "books", label: "Books" },
            { value: "series", label: "Series" },
          ]}
          value={segment}
          onChange={choose}
        />
        {!online ? (
          <p className="discover-line type-label" role="status">
            {OFFLINE_SEARCH_LINE}
          </p>
        ) : (
          settingsRead &&
          !hardcoverConnected && (
            <p className="discover-line type-label">
              <button type="button" className="discover-link" onClick={onConnect}>
                {segment === "books" ? CONNECT_HARDCOVER_LINE : CONNECT_HARDCOVER_SERIES_LINE}
              </button>
            </p>
          )
        )}
      </div>
      <div className="discover-results" aria-busy={busy || undefined}>
        {body}
      </div>
    </section>
  );
}
