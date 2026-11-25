// The Get ebook sheet (#604, spec #600 "The sheet"; boards GetEbook.dc.html, BookGetting.dc.html):
// `#book/<workId>/get/ebook`, the administrator's. Close, the caption "Get ebook", the book (cover, title as the one
// heading, author), the search field "Search for an edition" (the title and author, searched on open and on Enter or
// the search key), Editions with one choice row per file its sources list (Library Genesis, Prowlarr when connected,
// Standard Ebooks and Project Gutenberg, #901; each failing source on its own line with Retry), the Group of the other ways in
// (Import a file from this device, get-import-row.tsx; Search on Library Genesis, the mirror's own search in a new
// tab) and Get this edition with its line. The rows are get-ebook-rows.ts, the search's states get-ebook-state.ts,
// the parts both Get sheets share get-sheet-parts.tsx. The words, the rows and the choice are kept in the history
// entry; a reload searches again.
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib";
import { refreshLibraryWorks, useWork } from "../library-works-store";
import { pageData, setPageData, useAddress } from "../navigation";
import { writeAddress, type Route } from "../routes";
import { Button } from "../parts/Button";
import { ChoiceGroup } from "../parts/ChoiceRow";
import { Sheet } from "../parts/Sheet";
import { InfoMark } from "../parts/Tooltip";
import { tip } from "../tooltip-texts";
import type { EbookResult } from "../types";
import { addedEditions, editionSourceLink, getEditionLine, sourceOf } from "./get-ebook-rows";

import {
  EBOOK_SOURCE_NAMES,
  ebookAnswered,
  ebookFailed,
  ebookSheetView,
  ebookSources,
  emptyEbookSearch,
  retryEbookSource,
  settledEbookSearch,
  SEARCHING_TEXT,
  sourcesLine,
  startEbookSearch,
  clockTime,
  limitedText,
  type EbookAsk,
  type EbookSearch,
  type EbookSourceId,
} from "./get-ebook-state";
import { GetSheetBook, GetSheetSearch, LeavingMark, RowChevron, SourceFailureLine, SourceLinkLine, useChosenRowInView } from "./get-sheet-parts";
import { GetImportRow } from "./get-import-row";
import "./get-ebook-sheet.css";

/** Today's Library Genesis mirror when the settings name none (as Discover's ebook search). */
export const DEFAULT_LIBGEN = "https://libgen.li";

/** The mirror's own search for the words, as today's "Search on Library Genesis" link. */
export function libgenSearchUrl(mirror: string | null | undefined, words: string) {
  const base = (mirror || DEFAULT_LIBGEN).replace(/\/+$/, "");
  return `${base}/index.php?req=${encodeURIComponent(words.trim())}`;
}

/** The sentence for a refusal the server sent without one of its own. */
export const NOT_SAVED = "This edition could not be got. Choose another or try again.";

/** What the sheet keeps in its history entry. */
type Kept = { words: string; search: EbookSearch; chosen: string | null };

function keptOf(data: unknown, workId: string): Kept | null {
  const value = (data as { getEbook?: Kept & { workId?: string } } | null)?.getEbook;
  if (!value || value.workId !== workId || typeof value.words !== "string" || !value.search || typeof value.search !== "object")
    return null;
  const search = value.search as EbookSearch & { results?: unknown };
  // An entry of the one-source sheet keeps its rows at the top; settledEbookSearch reads them as Library Genesis's.
  if ((!search.sources && !Array.isArray(search.results)) || typeof search.token !== "number") return null;
  return { words: value.words, search, chosen: typeof value.chosen === "string" ? value.chosen : null };
}

/** The first sheet shown since the document loaded (a reload, a link): it searches again whatever its entry kept. */
let documentFresh = true;

type Props = {
  workId: string;
  online: boolean;
  /** The Library Genesis mirror of the settings; null while they are not read yet. */
  libgenUrl: string | null;
  /** Prowlarr is connected: its book indexers are asked too (#901). Absent or null: not asked. */
  prowlarrConfigured?: boolean | null;
  /** The library changed: the shell reads the books again. */
  onChanged: () => Promise<void> | void;
};

export function GetEbookSheet({ workId, online, libgenUrl, prowlarrConfigured, onChanged }: Props) {
  const address = useAddress();
  const route: Route = { name: "get", workId, kind: "ebook" };
  const parent: Route = { name: "book", workId };
  const { work } = useWork(workId);
  const [initial] = useState(() => keptOf(pageData(), workId));
  const [fresh] = useState(() => {
    const was = documentFresh;
    documentFresh = false;
    return was;
  });
  const [words, setWords] = useState(initial?.words ?? "");
  const [search, setSearch] = useState<EbookSearch>(() => (initial ? settledEbookSearch(initial.search) : emptyEbookSearch()));
  const [chosen, setChosen] = useState<string | null>(initial?.chosen ?? null);
  const [refusal, setRefusal] = useState("");
  const [getting, setGetting] = useState(false);
  /** The edition to get again, and when: its source limited requests (#901). */
  const [getAgain, setGetAgain] = useState<{ id: string; at: number } | null>(null);
  const live = useRef(true);
  const searchRef = useRef(search);
  searchRef.current = search;
  // Words asked for while there was no connection: searched when it is back.
  const waiting = useRef<string | null>(null);

  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const sources = () => ebookSources({ prowlarr: !!prowlarrConfigured });
  const ask = (next: EbookSearch, requests: EbookAsk[]) => {
    searchRef.current = next;
    setSearch(next);
    for (const { source, token, query } of requests)
      void api<{ files?: EbookResult[] }>("/discover/ebooks?" + new URLSearchParams({ source, q: query })).then(
        (answer) =>
          live.current && setSearch((state) => ebookAnswered(state, source, token, Array.isArray(answer?.files) ? answer.files : [])),
        (error: Error) => {
          if (!live.current) return;
          // For want of a connection: asked again when it is back.
          if (!navigator.onLine) waiting.current = query;
          // A source that limits requests says when to ask again (Library Genesis, #901).
          const wait = error instanceof ApiError && error.code === "source_limited" ? error.retryAfter : undefined;
          setSearch((state) => ebookFailed(state, source, token, error.message, wait ? Date.now() + wait * 1000 : null));
        },
      );
  };
  const run = (text: string) => {
    if (!online) {
      waiting.current = text;
      return;
    }
    waiting.current = null;
    const { state, asks } = startEbookSearch(searchRef.current, text, sources());
    if (asks.length) setChosen(null);
    ask(state, asks);
  };
  const retry = (source: EbookSourceId) => {
    const { state, asks } = retryEbookSource(searchRef.current, source);
    ask(state, asks);
  };

  // The first search: the title and the author, once the book is known. A sheet that comes back by Back or Forward
  // shows what its entry kept; a reload (or a link) searches its words again.
  const started = useRef(false);
  useEffect(() => {
    // Prowlarr is asked only once the settings say it is connected.
    if (started.current || !work || prowlarrConfigured === null) return;
    started.current = true;
    const text = initial ? initial.words : `${work.title} ${work.author}`.trim();
    if (!initial) setWords(text);
    if (!initial || fresh) {
      // A reload keeps its choice: the same search lists the same files.
      const keep = chosen;
      run(text);
      if (initial && keep) setChosen(keep);
    } else {
      // Back or Forward to an entry left while a source was still searching: that source is asked again.
      const unsettled = Object.entries(initial.search.sources ?? {}).filter(([, state]) => state?.status === "searching");
      for (const [source] of unsettled) retry(source as EbookSourceId);
    }
  }, [work, prowlarrConfigured]);

  // The connection is back: the search asked for meanwhile starts.
  useEffect(() => {
    if (online && waiting.current !== null) run(waiting.current);
  }, [online]);

  // A source that limits requests is asked again at the time its line names.
  const due = Object.entries(search.sources).flatMap(([source, state]) =>
    state?.status === "failed" && state.retryAt ? [`${source}:${state.token}:${state.retryAt}`] : [],
  );
  useEffect(() => {
    const timers = due.map((key) => {
      const [source, , at] = key.split(":");
      return window.setTimeout(() => {
        const current = searchRef.current.sources[source as EbookSourceId];
        if (online && current?.status === "failed" && current.retryAt === Number(at)) retry(source as EbookSourceId);
      }, Math.max(0, Number(at) - Date.now()));
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [due.join("|"), online]);

  // Kept in the sheet's own entry while it is the one shown.
  useEffect(() => {
    if (location.hash !== writeAddress(route)) return;
    setPageData({ getEbook: { workId, words, search, chosen } });
  }, [words, search, chosen]);

  const added = addedEditions(work);
  const asked = Object.keys(search.sources) as EbookSourceId[];
  const view = ebookSheetView(search, { online, added });
  const chosenRow = view.rows.find((row) => row.id === chosen && !row.disabled) ?? null;
  const line = getEditionLine(chosenRow?.result ?? null, work);

  const get = async () => {
    if (!chosenRow || !work) return;
    setGetting(true);
    setRefusal("");
    setGetAgain(null);
    try {
      // A book not in the library is added first (#527's PUT).
      if (!work.inLibrary) await api(`/works/${encodeURIComponent(workId)}/library`, { method: "PUT" });
      // A Prowlarr release answers with its download (#901): Activity shows it, and the edition joins the book when done.
      await api("/ebooks", { method: "POST", body: JSON.stringify({ ...chosenRow.result, workId }) });
      await refreshLibraryWorks().catch(() => {});
      window.dispatchEvent(new Event("sonder:library-changed"));
      void onChanged();
      if (live.current && location.hash === writeAddress(route)) address.goBack(parent);
    } catch (error) {
      // Library Genesis limiting requests (#901): the sheet says when, and gets the edition then if it is still chosen.
      const wait = error instanceof ApiError && error.code === "source_limited" ? error.retryAfter : undefined;
      if (live.current && wait) {
        const at = Date.now() + wait * 1000;
        setRefusal(limitedText(sourceOf(chosenRow.result), clockTime(at)));
        setGetAgain({ id: chosenRow.id, at });
      } else if (live.current) setRefusal((error as Error).message || NOT_SAVED);
      // A book added before the refusal stays added: the Book page shows it in the library.
      if (!work.inLibrary) {
        await refreshLibraryWorks().catch(() => {});
        window.dispatchEvent(new Event("sonder:library-changed"));
      }
    } finally {
      if (live.current) setGetting(false);
    }
  };

  useEffect(() => {
    if (!getAgain) return;
    const timer = window.setTimeout(() => {
      if (chosenRow?.id === getAgain.id && !getting && online) void get();
    }, Math.max(0, getAgain.at - Date.now()));
    return () => window.clearTimeout(timer);
  }, [getAgain, chosenRow?.id, getting, online]);

  // The footer, bottom to top: the button row, pinned to the foot and never moving; the sentence that says what the
  // button will do, 8 above it; the link to the chosen edition's own page; a refusal. Nothing is reserved, so the footer
  // is the button alone while nothing is chosen and grows upward into the list when there is something to say. This
  // departs from the board's order (the button, then its sentence under it) on purpose: the button under the thumb must
  // not move when a row is chosen, and under it the sentence would have to be kept room for (#889).
  const link = editionSourceLink(chosenRow?.result);
  useChosenRowInView(`${chosenRow?.id}|${link?.href}|${line}|${refusal}`);
  const footer = (
    <>
      {refusal && (
        <p className="get-sheet-refusal type-label" role="alert">
          {refusal}
        </p>
      )}
      <SourceLinkLine link={link} />
      {line && <p className="get-sheet-line">{line}</p>}
      <div className="get-sheet-buttons">
        <Button kind="primary" disabled={!chosenRow || getting || !online} onClick={() => void get()}>
          Get this edition
        </Button>
      </div>
    </>
  );

  return (
    <Sheet title="Get ebook" parent={parent} footer={footer}>
      <GetSheetBook work={work} />
      <GetSheetSearch name="Search for an edition" words={words} onWords={setWords} onSearch={() => run(words)} />

      <div className="part-group-block get-sheet-recordings">
        <div className="part-group-caption-line">
          <h2 className="part-group-caption type-caption">Editions · {view.rows.length}</h2>
          <InfoMark name="Editions" text={tip("getEditions")} />
        </div>
        {view.searching && (
          <p className="get-sheet-notice type-label" role="status">
            {SEARCHING_TEXT}
          </p>
        )}
        {view.notice && (
          <p className="get-sheet-notice type-label" role="status">
            {view.notice.text}
            {view.notice.kind === "nothing" && <span className="get-sheet-try"> {view.notice.tryText}</span>}
          </p>
        )}
        {view.rows.length > 0 && (
          <ChoiceGroup
            label="Editions"
            value={chosenRow?.id ?? null}
            onChange={(value) => {
              setChosen(value);
              setRefusal("");
            }}
            options={view.rows.map((row) => ({ value: row.id, label: row.first, detail: row.second, edge: row.edge, disabled: row.disabled }))}
          />
        )}
        {view.failures.map((failure) => (
          <SourceFailureLine
            key={failure.source}
            source={EBOOK_SOURCE_NAMES[failure.source]}
            sentence={failure.sentence}
            reason={failure.reason}
            onRetry={() => retry(failure.source)}
          />
        ))}
        <p className="part-group-note">{sourcesLine(asked.length ? asked : sources())}</p>
      </div>

      <div className="part-group-block">
        <ul className="part-group" role="list" aria-label="Other ways to get it">
          <GetImportRow kind="ebook" workId={workId} title={work?.title ?? ""} />
          <li className="part-row-item">
            <a className="part-row get-sheet-out" href={libgenSearchUrl(libgenUrl, words)} target="_blank" rel="noopener noreferrer">
              <span className="part-row-label type-body">Search on Library Genesis</span>
              <span className="part-row-value type-label">
                <LeavingMark />
              </span>
            </a>
          </li>
        </ul>
      </div>
    </Sheet>
  );
}
