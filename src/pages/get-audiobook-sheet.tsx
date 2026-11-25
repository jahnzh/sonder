// The Get audiobook sheet (#601, spec #600 "The sheet"; boards GetAudiobook.dc.html, BookGetting.dc.html):
// `#book/<workId>/get/audiobook`, the administrator's. Close, the caption "Get audiobook", the book (cover, title as
// the one heading, author), the search field (the title and author, searched on open and on Enter or the search
// key), Recordings with one choice row per recording found, the Group of the other ways to get one (the
// magnet link opening its own sheet over this one, get-magnet-sheet.tsx (#606); the import, get-import-row.tsx) and Get this recording with its line. The rows are get-audiobook-rows.ts, the search's
// states get-audiobook-state.ts. The language button beside the field opens a Picker (#602): the choice applies at
// once and is stored on this device; Load more recordings asks AudioBookBay's next page. The words, the rows, the
// pages loaded, the language and the choice are kept in the history entry; a reload searches again (as many pages).
// A row that is a pack of a series the book is in (ADR 0027) starts its second line with the books it holds, the
// line under the button names the other books it also gets, and Get sends `pack: true`. A downloaded pack that could
// not tell which of its files are the book's shows its chooser (get-pack-choice.tsx) above Recordings.
//
// Without a book (#576, spec #572 "Discover"; board GetRecording.dc.html): `#discover/get/<query>` over Discover,
// opened by Discover's "Search for a recording" with the words searched. "A recording for a new book" stands in
// place of the book, each row's own title comes first, and "Adds the book to your library." is said under the
// button. Get this recording sends the add route with `makeWork: true`: the server makes the book, and the sheet's
// entry is replaced by the new book's page. Close goes back to Discover. The magnet link and the import need a book
// to attach the recording to, so this sheet has neither.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, localDB } from "../lib";
import { mergeReleases } from "../releases";
import { refreshLibraryWorks, useWork } from "../library-works-store";
import { pageData, setPageData, useAddress } from "../navigation";
import { writeAddress, type Route } from "../routes";
import { Button } from "../parts/Button";
import { ChoiceGroup } from "../parts/ChoiceRow";
import { Picker } from "../parts/Picker";
import { Sheet } from "../parts/Sheet";
import { InfoMark } from "../parts/Tooltip";
import { tip } from "../tooltip-texts";
import { useTorrentHealth } from "../components/TorrentHealth";
import type { Acquisition, AudiobookRelease } from "../types";
import { GET_LANGUAGE, getLine, LANGUAGE_KEY, languageChoices, languageName, packLabel, packLine, recordingRows, sourceLink, type PackView } from "./get-audiobook-rows";
import { GetPackChoice } from "./get-pack-choice";
import {
  answered,
  emptySearch,
  failed,
  followUp,
  loadMore,
  retrySource,
  settledSources,
  sheetView,
  SOURCE_NAMES,
  startSearch,
  type Ask,
  type GetSearch,
  type SourceId,
} from "./get-audiobook-state";
import { GetImportRow } from "./get-import-row";
import { SourceLinkLine, useChosenRowInView } from "./get-sheet-parts";
import { usePlayer } from "../player";
import { usePreview } from "./get-preview";
import { previewControl } from "./get-preview-model";
import { Cover } from "../parts/Cover";
import "./get-audiobook-sheet.css";

/** What the sheet keeps in its history entry. */
type Kept = { words: string; search: GetSearch; chosen: string | null; language: string | null };

function keptOf(data: unknown, key: string): Kept | null {
  const value = (data as { getAudiobook?: Kept & { workId?: string } } | null)?.getAudiobook;
  if (!value || value.workId !== key || typeof value.words !== "string" || !value.search || typeof value.search !== "object")
    return null;
  return {
    words: value.words,
    search: value.search,
    chosen: typeof value.chosen === "string" ? value.chosen : null,
    // An entry from before the language picker keeps none: the stored one applies.
    language: typeof value.language === "string" && value.language ? value.language : null,
  };
}

/** The language stored on this device (today's `release-language`), English when none is. */
async function storedLanguage(): Promise<string> {
  try {
    const value = (await localDB.preferences.get(LANGUAGE_KEY))?.value;
    return typeof value === "string" && value ? value : GET_LANGUAGE;
  } catch {
    return GET_LANGUAGE;
  }
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
function ChevronDown() {
  return (
    <svg className="get-sheet-language-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
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
  /** The book; null for the sheet without a book (#576), which searches `query`. */
  workId: string | null;
  /** The words Discover searched: the sheet without a book's first search. */
  query?: string;
  online: boolean;
  /** Prowlarr is connected; null while the settings are not read yet (the first search waits for them). */
  prowlarrConfigured: boolean | null;
  /** TorBox is connected: the line under the button says whether a recording plays at once. */
  torboxConfigured: boolean;
  /** The library changed: the shell reads the books again. */
  onChanged: () => Promise<void> | void;
};

/** Above the line under the button of the sheet without a book (#576, GetRecording.dc.html). */
export const ADDS_THE_BOOK = "Adds the book to your library.";
/** In place of the book on the sheet without a book (#576). */
export const NEW_BOOK_HEADING = "A recording for a new book";

export function GetAudiobookSheet({ workId: bookId, query = "", online, prowlarrConfigured, torboxConfigured, onChanged }: Props) {
  const address = useAddress();
  const newBook = bookId === null;
  const workId = bookId ?? "";
  const route: Route = newBook ? { name: "discover-get", query } : { name: "get", workId, kind: "audiobook" };
  const parent: Route = newBook ? { name: "discover" } : { name: "book", workId };
  // What the kept entry is for: the book, or the words of the sheet without one.
  const keptKey = newBook ? `discover-get:${query}` : workId;
  const { work } = useWork(workId);
  // Today's hook: the line under the button warns when the torrent client a recording would need is not working.
  const { health } = useTorrentHealth();
  const [initial] = useState(() => keptOf(pageData(), keptKey));
  const [fresh] = useState(() => {
    const was = documentFresh;
    documentFresh = false;
    return was;
  });
  const [words, setWords] = useState(initial?.words ?? "");
  const [search, setSearch] = useState<GetSearch>(() => (initial ? settledSources(initial.search) : emptySearch()));
  const [chosen, setChosen] = useState<string | null>(initial?.chosen ?? null);
  // The entry's language; else the stored one, read before the first search (null until then).
  const [language, setLanguage] = useState<string | null>(initial?.language ?? null);
  const [picking, setPicking] = useState(false);
  const [refusal, setRefusal] = useState("");
  const [getting, setGetting] = useState(false);
  // The rows that are packs of a series the book is in (ADR 0027), by the release's title; asked once per title.
  const [packsOf, setPacksOf] = useState<{ workId: string; packs: Record<string, PackView> }>({ workId: "", packs: {} });
  const packs = packsOf.workId === workId ? packsOf.packs : {};
  const described = useRef(new Set<string>());
  const live = useRef(true);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  useEffect(() => {
    if (language !== null) return;
    void storedLanguage().then((stored) => live.current && setLanguage((current) => current ?? stored));
  }, []);

  const sources = (): SourceId[] => (prowlarrConfigured ? ["abb", "prowlarr"] : ["abb"]);
  const ask = (asks: Ask[]) => {
    for (const { source, token, query, page } of asks) {
      const path =
        source === "abb"
          ? "/discover/abb/releases?" + new URLSearchParams({ q: query, page: String(page) })
          : "/discover/prowlarr/releases?" + new URLSearchParams({ q: query });
      void api<{ results: AudiobookRelease[]; nextPage?: number | null }>(path).then(
        (answer) => {
          if (!live.current) return;
          const results = Array.isArray(answer?.results) ? answer.results : [];
          const next = typeof answer?.nextPage === "number" ? answer.nextPage : null;
          apply(answered(searchRef.current, source, token, results, next));
          // A reload asks again as many pages as its entry had loaded, one after the other.
          const more = followUp(searchRef.current);
          if (more.asks.length) {
            apply(more.state);
            ask(more.asks);
          }
        },
        (error: Error) => live.current && apply(failed(searchRef.current, source, token, error.message)),
      );
    }
  };
  const apply = (state: GetSearch) => {
    searchRef.current = state;
    setSearch(state);
  };
  const run = (text: string, { pages = 1, keepChoice = false }: { pages?: number; keepChoice?: boolean } = {}) => {
    if (!online) return;
    const { state, asks } = startSearch(searchRef.current, text, sources(), pages);
    // A new search clears the choice; a reload's search of the kept words keeps it while its row is shown.
    if (asks.length && !keepChoice) setChosen(null);
    apply(state);
    ask(asks);
  };
  const retry = (source: SourceId) => {
    const { state, asks } = retrySource(searchRef.current, source);
    apply(state);
    ask(asks);
  };
  const more = () => {
    const { state, asks } = loadMore(searchRef.current);
    apply(state);
    ask(asks);
  };

  // The first search: the title and the author, once the book and the settings are known. A sheet that comes back
  // by Back or Forward shows what its entry kept; a reload (or a link) searches its words again.
  const started = useRef(false);
  useEffect(() => {
    // The language too, so the first rows shown are already in it.
    if (started.current || (!newBook && !work) || prowlarrConfigured === null || language === null) return;
    started.current = true;
    const text = initial ? initial.words : work ? `${work.title} ${work.author}`.trim() : query;
    if (!initial) setWords(text);
    if (!initial) run(text);
    // A reload: the kept words again, as many AudioBookBay pages as were loaded, the choice kept while its row is shown.
    else if (fresh) run(initial.search.query || text, { pages: initial.search.pages ?? 1, keepChoice: true });
  }, [work, prowlarrConfigured, language]);

  // Kept in the sheet's own entry while it is the one shown.
  useEffect(() => {
    if (location.hash !== writeAddress(route)) return;
    setPageData({ getAudiobook: { workId: keptKey, words, search: lean(search), chosen, language } });
  }, [words, search, chosen, language]);

  // Without a book the rows are sorted by the words searched, as a book's are by its title.
  const title = newBook ? search.query || query : work?.title ?? "";
  const shownLanguage = language ?? GET_LANGUAGE;
  const view = sheetView(search, { online, bookTitle: title, language: shownLanguage, titleFirst: newBook });
  const loaded = mergeReleases(...Object.values(search.sources).map((source) => source?.results ?? []));
  const chooseLanguage = (next: string) => {
    setLanguage(next);
    void localDB.preferences.put({ key: LANGUAGE_KEY, value: next }).catch(() => {});
    // The choice stays while its row is still shown in the new language.
    if (chosen && !recordingRows(loaded, title, next, newBook).some((row) => row.id === chosen)) setChosen(null);
  };
  const chosenRow = view.rows.find((row) => row.id === chosen) ?? null;
  const chosenPack = chosenRow ? packs[chosenRow.release.title] ?? null : null;
  // Another book's sheet starts with none described.
  const describedFor = useRef(workId);
  if (describedFor.current !== workId) {
    describedFor.current = workId;
    described.current = new Set();
  }
  useEffect(() => {
    if (newBook || !online) return;
    const titles = [...new Set(loaded.map((release) => release.title))].filter((title) => !described.current.has(title)).slice(0, 200);
    if (!titles.length) return;
    for (const title of titles) described.current.add(title);
    const asked = workId;
    void api<{ packs?: Record<string, PackView> }>(`/works/${encodeURIComponent(workId)}/packs/describe`, {
      method: "POST",
      body: JSON.stringify({ titles }),
    }).then(
      (answer) =>
        live.current &&
        answer?.packs &&
        setPacksOf((known) => ({ workId: asked, packs: { ...(known.workId === asked ? known.packs : {}), ...answer.packs } })),
      // Not answered: asked again with the next rows or when the device is back online; an older server has no such
      // route, and its rows stay plain recordings.
      () => {
        if (asked === describedFor.current) for (const title of titles) described.current.delete(title);
      },
    );
  }, [loaded.map((release) => release.title).join("\n"), newBook, online, workId]);
  const line = getLine({ chosen: chosenRow?.release ?? null, mediaState: work?.mediaState, torboxConnected: torboxConfigured, health });
  // A preview of the chosen row when it says "Plays now" (#889): its own audio element, off while the book plays.
  const { playing: bookPlaying } = usePlayer();
  const preview = usePreview(chosenRow?.release ?? null, bookPlaying);
  const previewing = previewControl({ chosen: chosenRow?.release, phase: preview.phase, played: preview.played, bookPlaying, online });
  const asked = Object.keys(search.sources) as SourceId[];
  const named = (asked.length ? asked : sources()).map((source) => SOURCE_NAMES[source]);
  const sourcesLine = `From ${named.join(" and ")}.`;

  const getNew = async () => {
    if (!chosenRow) return;
    preview.stop();
    const release = chosenRow.release;
    setGetting(true);
    setRefusal("");
    try {
      const job = await api<Acquisition>(release.source === "prowlarr" ? "/discover/prowlarr/add" : "/discover/abb/add", {
        method: "POST",
        body: JSON.stringify({ ...(release.source === "prowlarr" ? { id: release.id } : { slug: release.id }), makeWork: true }),
      });
      if (job?.status === "error") throw new Error(job.error || NOT_QUEUED);
      if (!job?.workId) throw new Error(NOT_QUEUED);
      await refreshLibraryWorks().catch(() => {});
      window.dispatchEvent(new Event("sonder:library-changed"));
      void onChanged();
      // The new book's page takes the sheet's entry: Back from it goes to Discover.
      if (live.current && location.hash === writeAddress(route)) address.navigate({ name: "book", workId: job.workId }, { replace: true });
    } catch (error) {
      if (live.current) setRefusal((error as Error).message || NOT_QUEUED);
    } finally {
      if (live.current) setGetting(false);
    }
  };

  const get = async () => {
    if (newBook) return getNew();
    if (!chosenRow || !work) return;
    preview.stop();
    const release = chosenRow.release;
    setGetting(true);
    setRefusal("");
    try {
      if (!work.inLibrary) await api(`/works/${encodeURIComponent(workId)}/library`, { method: "PUT" });
      const job = await api<Acquisition>(release.source === "prowlarr" ? "/discover/prowlarr/add" : "/discover/abb/add", {
        method: "POST",
        // Sent only when the line under the button says the add replaces the download on its way.
        body: JSON.stringify({
          ...(release.source === "prowlarr" ? { id: release.id, workId } : { slug: release.id, workId }),
          ...(line?.replaceActive ? { replaceActive: true } : {}),
          // A pack of the book's series also gets the other books it holds (ADR 0027).
          ...(chosenPack ? { pack: true } : {}),
        }),
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

  // The footer, bottom to top: the button row, pinned to the foot and never moving; the sentence that says what the
  // button will do, 8 above it; the link to the chosen release's own page; a refusal. Nothing is reserved, so the
  // footer is the button alone while nothing is chosen and grows upward into the list when there is something to say.
  // This departs from the board's order (the button, then its sentence under it) on purpose: the button under the
  // thumb must not move when a row is chosen, and under it the sentence would have to be kept room for (#889).
  const link = sourceLink(chosenRow?.release);
  const sentence = newBook
    ? line ? `${ADDS_THE_BOOK} ${line.text}` : ADDS_THE_BOOK
    : [chosenPack ? packLine(chosenPack, workId) : null, line?.text].filter(Boolean).join(" ") || undefined;
  useChosenRowInView(`${chosen}|${link?.href}|${sentence}|${refusal}|${previewing?.line?.text}`);
  const footer = (
    <>
      {refusal && (
        <p className="get-sheet-refusal type-label" role="alert">
          {refusal}
        </p>
      )}
      <SourceLinkLine link={link} />
      {sentence && (
        <p className={line?.failed ? "get-sheet-line get-sheet-line-failed" : "get-sheet-line"} data-testid="get-line">
          {sentence}
        </p>
      )}
      {previewing?.line && (
        <p className={previewing.line.failed ? "get-sheet-line get-sheet-line-failed" : "get-sheet-line"} data-testid="preview-line" role="status">
          {previewing.line.text}
        </p>
      )}
      {/* Preview (#889) at its own width on the left, only for a row that says "Plays now"; Get fills the rest. */}
      <div className="get-sheet-buttons">
        {previewing && (
          <Button
            kind="secondary"
            className="get-sheet-preview"
            disabled={previewing.disabled}
            onClick={() => (preview.phase === "playing" ? preview.stop() : void preview.start())}
          >
            {previewing.label}
          </Button>
        )}
        <Button kind="primary" disabled={!chosenRow || getting || !online} onClick={() => void get()}>
          Get this recording
        </Button>
      </div>
    </>
  );

  return (
    <Sheet title="Get audiobook" parent={parent} footer={footer}>
      {newBook ? (
        <h1 className="get-sheet-title type-heading">{NEW_BOOK_HEADING}</h1>
      ) : (
      <div className="get-sheet-book">
        <Cover className="get-sheet-cover" src={work?.cover} title={work?.title ?? ""} workId={work?.workId} compact />
        <div className="get-sheet-names">
          <h1 className="get-sheet-title type-heading">{title}</h1>
          {work?.author && <p className="get-sheet-author type-label">{work.author}</p>}
        </div>
      </div>
      )}

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
            className="get-sheet-input"
            aria-label="Search for a recording"
            enterKeyHint="search"
            maxLength={150}
            value={words}
            onChange={(event) => setWords(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="get-sheet-language type-label"
          aria-label={`Language: ${languageName(shownLanguage)}`}
          aria-haspopup="dialog"
          onClick={() => setPicking(true)}
        >
          <span className="get-sheet-language-name">{languageName(shownLanguage)}</span>
          <ChevronDown />
        </button>
      </form>
      <Picker
        open={picking}
        title="Language"
        options={languageChoices(loaded, shownLanguage)}
        value={shownLanguage}
        onClose={() => setPicking(false)}
        onChoose={chooseLanguage}
      />

      {!newBook && (
        <GetPackChoice
          workId={workId}
          online={online}
          onChosen={async () => {
            await refreshLibraryWorks().catch(() => {});
            window.dispatchEvent(new Event("sonder:library-changed"));
            void onChanged();
            if (live.current && location.hash === writeAddress(route)) address.goBack(parent);
          }}
        />
      )}

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
            options={view.rows.map((row) => {
              const pack = packs[row.release.title];
              return { value: row.id, label: row.first, detail: pack ? [packLabel(pack), row.second].filter(Boolean).join(" · ") : row.second, edge: row.edge };
            })}
          />
        )}
        {view.more && (
          <Button kind="quiet" className="get-sheet-more" onClick={more}>
            Load more recordings
          </Button>
        )}
        {view.searching && (
          <p className="get-sheet-notice type-label" role="status">
            Searching…
          </p>
        )}
        <p className="part-group-note">{sourcesLine}</p>
      </div>

      {!newBook && (
      <div className="part-group-block">
        <ul className="part-group" role="list" aria-label="Other ways to get it">
          <li className="part-row-item">
            <button type="button" className="part-row" data-opens="" onClick={() => address.navigate({ name: "get-magnet", workId })}>
              <span className="part-row-label type-body">Paste a magnet link</span>
              <span className="part-row-value type-label">
                <Chevron />
              </span>
            </button>
          </li>
          <GetImportRow kind="audiobook" workId={workId} title={title} />
        </ul>
      </div>
      )}
    </Sheet>
  );
}
