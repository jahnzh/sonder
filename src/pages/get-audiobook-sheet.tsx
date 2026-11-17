// The Get audiobook sheet (#601, spec #600 "The sheet"; boards GetAudiobook.dc.html, BookGetting.dc.html):
// `#book/<workId>/get/audiobook`, the administrator's. Close, the caption "Get audiobook", the book (cover, title as
// the one heading, author), the search field (the title and author, searched on open and on Enter or the search
// key), Recordings with one choice row per recording found, the Group of the other ways to get one (off until
// tickets 05 and 06) and Get this recording with its line. The rows are get-audiobook-rows.ts, the search's
// states get-audiobook-state.ts. The words, the rows and the choice are kept in the history entry; a reload
// searches again.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib";
import { refreshLibraryWorks, useWork } from "../library-works-store";
import { pageData, setPageData, useAddress } from "../navigation";
import { writeAddress, type Route } from "../routes";
import { Button } from "../parts/Button";
import { ChoiceGroup } from "../parts/ChoiceRow";
import { Sheet } from "../parts/Sheet";
import { InfoMark } from "../parts/Tooltip";
import { tip } from "../tooltip-texts";
import type { Acquisition, AudiobookRelease } from "../types";
import { getLine } from "./get-audiobook-rows";
import {
  answered,
  emptySearch,
  failed,
  retrySource,
  settledSources,
  sheetView,
  SOURCE_NAMES,
  startSearch,
  type Ask,
  type GetSearch,
  type SourceId,
} from "./get-audiobook-state";
import "./get-audiobook-sheet.css";

/** What the sheet keeps in its history entry. */
type Kept = { words: string; search: GetSearch; chosen: string | null };

function keptOf(data: unknown, workId: string): Kept | null {
  const value = (data as { getAudiobook?: Kept & { workId?: string } } | null)?.getAudiobook;
  if (!value || value.workId !== workId || typeof value.words !== "string" || !value.search || typeof value.search !== "object")
    return null;
  return { words: value.words, search: value.search, chosen: typeof value.chosen === "string" ? value.chosen : null };
}

/** The first sheet shown since the document loaded (a reload, a link): it searches again whatever its entry kept. */
let documentFresh = true;

/** The sentence for an acquisition the server left in `error` without one of its own. */
export const NOT_QUEUED = "This recording could not be got. Choose another or try again.";

function SearchIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}
function Chevron() {
  return (
    <svg className="part-row-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** Lighter rows for the history entry: the description is the largest field and the sheet never shows it. */
function lean(search: GetSearch): GetSearch {
  const sources: GetSearch["sources"] = {};
  for (const [source, value] of Object.entries(search.sources) as [SourceId, NonNullable<GetSearch["sources"][SourceId]>][])
    sources[source] = { ...value, results: value.results.map((release) => ({ ...release, description: "" })) };
  return { ...search, sources };
}

type Props = {
  workId: string;
  online: boolean;
  /** Prowlarr is connected; null while the settings are not read yet (the first search waits for them). */
  prowlarrConfigured: boolean | null;
  /** The library changed: the shell reads the books again. */
  onChanged: () => Promise<void> | void;
};

export function GetAudiobookSheet({ workId, online, prowlarrConfigured, onChanged }: Props) {
  const address = useAddress();
  const route: Route = { name: "get", workId, kind: "audiobook" };
  const parent: Route = { name: "book", workId };
  const { work } = useWork(workId);
  const [initial] = useState(() => keptOf(pageData(), workId));
  const [fresh] = useState(() => {
    const was = documentFresh;
    documentFresh = false;
    return was;
  });
  const [words, setWords] = useState(initial?.words ?? "");
  const [search, setSearch] = useState<GetSearch>(() => (initial ? settledSources(initial.search) : emptySearch()));
  const [chosen, setChosen] = useState<string | null>(initial?.chosen ?? null);
  const [refusal, setRefusal] = useState("");
  const [getting, setGetting] = useState(false);
  const live = useRef(true);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const sources = (): SourceId[] => (prowlarrConfigured ? ["abb", "prowlarr"] : ["abb"]);
  const ask = (asks: Ask[]) => {
    for (const { source, token, query } of asks) {
      const path =
        source === "abb"
          ? "/discover/abb/releases?" + new URLSearchParams({ q: query, page: "1" })
          : "/discover/prowlarr/releases?" + new URLSearchParams({ q: query });
      void api<{ results: AudiobookRelease[] }>(path).then(
        (answer) => live.current && setSearch((state) => answered(state, source, token, Array.isArray(answer?.results) ? answer.results : [])),
        (error: Error) => live.current && setSearch((state) => failed(state, source, token, error.message)),
      );
    }
  };
  const run = (text: string) => {
    if (!online) return;
    const { state, asks } = startSearch(searchRef.current, text, sources());
    searchRef.current = state;
    setSearch(state);
    ask(asks);
  };
  const retry = (source: SourceId) => {
    const { state, asks } = retrySource(searchRef.current, source);
    searchRef.current = state;
    setSearch(state);
    ask(asks);
  };

  // The first search: the title and the author, once the book and the settings are known. A sheet that comes back
  // by Back or Forward shows what its entry kept; a reload (or a link) searches its words again.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !work || prowlarrConfigured === null) return;
    started.current = true;
    const text = initial ? initial.words : `${work.title} ${work.author}`.trim();
    if (!initial) setWords(text);
    if (!initial || fresh) run(text);
  }, [work, prowlarrConfigured]);

  // Kept in the sheet's own entry while it is the one shown.
  useEffect(() => {
    if (location.hash !== writeAddress(route)) return;
    setPageData({ getAudiobook: { workId, words, search: lean(search), chosen } });
  }, [words, search, chosen]);

  const title = work?.title ?? "";
  const view = sheetView(search, { online, bookTitle: title });
  const chosenRow = view.rows.find((row) => row.id === chosen) ?? null;
  const line = getLine(chosenRow?.release ?? null);
  const asked = Object.keys(search.sources) as SourceId[];
  const named = (asked.length ? asked : sources()).map((source) => SOURCE_NAMES[source]);
  const sourcesLine = `From ${named.join(" and ")}.`;

  const get = async () => {
    if (!chosenRow || !work) return;
    const release = chosenRow.release;
    setGetting(true);
    setRefusal("");
    try {
      if (!work.inLibrary) await api(`/works/${encodeURIComponent(workId)}/library`, { method: "PUT" });
      const job = await api<Acquisition>(release.source === "prowlarr" ? "/discover/prowlarr/add" : "/discover/abb/add", {
        method: "POST",
        body: JSON.stringify(release.source === "prowlarr" ? { id: release.id, workId } : { slug: release.id, workId }),
      });
      if (job?.status === "error") throw new Error(job.error || NOT_QUEUED);
      await refreshLibraryWorks().catch(() => {});
      window.dispatchEvent(new Event("sonder:library-changed"));
      void onChanged();
      if (live.current && location.hash === writeAddress(route)) address.goBack(parent);
    } catch (error) {
      if (live.current) setRefusal((error as Error).message || NOT_QUEUED);
      // A book added before the refusal stays added: the Book page shows it in the library.
      if (!work.inLibrary) {
        await refreshLibraryWorks().catch(() => {});
        window.dispatchEvent(new Event("sonder:library-changed"));
      }
    } finally {
      if (live.current) setGetting(false);
    }
  };

  const footer = (
    <>
      {refusal && (
        <p className="get-sheet-refusal type-label" role="alert">
          {refusal}
        </p>
      )}
      <Button kind="primary" disabled={!chosenRow || getting || !online} onClick={() => void get()}>
        Get this recording
      </Button>
      {line && <p className="get-sheet-line">{line}</p>}
    </>
  );

  return (
    <Sheet title="Get audiobook" parent={parent} footer={footer}>
      <div className="get-sheet-book">
        {work?.cover ? <img className="get-sheet-cover" src={work.cover} alt="" /> : <span className="get-sheet-cover" aria-hidden="true" />}
        <div className="get-sheet-names">
          <h1 className="get-sheet-title type-heading">{title}</h1>
          {work?.author && <p className="get-sheet-author type-label">{work.author}</p>}
        </div>
      </div>

      <form
        className="get-sheet-search"
        role="search"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          run(words);
        }}
      >
        <label className="get-sheet-field">
          <SearchIcon />
          <input
            type="search"
            aria-label="Search for a recording"
            enterKeyHint="search"
            maxLength={150}
            value={words}
            onChange={(event) => setWords(event.target.value)}
          />
        </label>
      </form>

      <div className="part-group-block get-sheet-recordings">
        <div className="part-group-caption-line">
          <h2 className="part-group-caption type-caption">Recordings · {view.rows.length}</h2>
          <InfoMark name="Recordings" text={tip("getRecordings")} />
        </div>
        {view.failures.map((failure) => (
          <div className="get-sheet-failure" role="status" key={failure.source}>
            <p className="type-label">
              {failure.sentence}
              {failure.reason && <span className="get-sheet-reason"> {failure.reason}</span>}
            </p>
            <Button kind="secondary" aria-label={`Retry ${SOURCE_NAMES[failure.source]}`} onClick={() => retry(failure.source)}>
              Retry
            </Button>
          </div>
        ))}
        {view.notice && (
          <p className="get-sheet-notice type-label" role="status">
            {view.notice.text}
            {view.notice.kind === "nothing" && <span className="get-sheet-try"> {view.notice.tryText}</span>}
          </p>
        )}
        {view.rows.length > 0 && (
          <ChoiceGroup
            label="Recordings"
            value={chosen}
            onChange={(value) => {
              setChosen(value);
              setRefusal("");
            }}
            options={view.rows.map((row) => ({ value: row.id, label: row.first, detail: row.second, edge: row.edge }))}
          />
        )}
        {view.searching && (
          <p className="get-sheet-notice type-label" role="status">
            Searching…
          </p>
        )}
        <p className="part-group-note">{sourcesLine}</p>
      </div>

      <div className="part-group-block">
        <ul className="part-group" role="list" aria-label="Other ways to get it">
          {["Paste a magnet link", "Import files from this device"].map((label) => (
            <li className="part-row-item" key={label}>
              <button type="button" className="part-row get-sheet-off" data-opens="" aria-disabled="true">
                <span className="part-row-label type-body">{label}</span>
                <span className="part-row-value type-label">
                  <Chevron />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
