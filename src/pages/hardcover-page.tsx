// The Hardcover page (#529, spec #526 "The Hardcover page"; boards Hardcover.dc.html, HardcoverMatch.dc.html):
// `#book/<workId>/hardcover`. Matched: Shelf and Use Hardcover position with the sync line under them, Lists (one
// Switch each) and Match (Hardcover edition, Open on Hardcover, Change match for the administrator). Not matched: the
// administrator searches Hardcover and matches the book here; anyone else is told the administrator can match it.
// Results that were toasts are lines on the row they concern. The words and rules are in src/hardcover-page-model.ts.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, localDB } from "../lib";
import type { Book, LibraryWork, Progress } from "../types";
import { usePlayer } from "../player";
import { useAddress } from "../navigation";
import { useWork } from "../library-works-store";
import { hardcoverChanged, useHardcover } from "../components/Hardcover";
import { Dialog } from "../components/ui/dialog";
import { PageHeader } from "../parts/PageHeader";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { Switch } from "../parts/Switch";
import { Button } from "../parts/Button";
import { ChoiceGroup } from "../parts/ChoiceRow";
import { InfoMark } from "../parts/Tooltip";
import { ChoiceList } from "./settings/Choice";
import { tip } from "../tooltip-texts";
import {
  EDITION_SAVED_LINE,
  NOT_CONNECTED_LINE,
  NOT_MATCHED_ADMIN_LINE,
  NOT_MATCHED_OTHER_LINE,
  NO_RESULTS_LINE,
  editionChoices,
  editionValue,
  editsOff,
  hardcoverBookUrl,
  listSavedLine,
  matchQuery,
  matchResults,
  modeLine,
  positionOff,
  positionValue,
  shelfValue,
  syncLine,
  type HardcoverEdition,
  type MatchResult,
} from "../hardcover-page-model";
import "./settings/settings.css";
import "./hardcover-page.css";

type Props = {
  workId: string;
  admin: boolean;
  /** The Library's books (`GET /api/books`): the player plays one of them. */
  books: Book[];
  /** After a change of the match, the shelf or a list: the shell reads the Library again. */
  onChanged: () => void;
};

/** A line on the row above it: a result, or why it failed (in the failed colour). */
type RowLine = { text: string; failed: boolean } | null;

function Line({ line }: { line: RowLine }) {
  if (!line) return null;
  return (
    <li className="hardcover-row-line type-label" data-failed={line.failed ? "" : undefined} role={line.failed ? "alert" : "status"}>
      {line.text}
    </li>
  );
}

function ChevronDown() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function OutIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/** A picker: a dialog named after its row, one radio row per choice; choosing closes it. */
function Picker({ open, title, options, value, onClose, onChoose }: { open: boolean; title: string; options: { value: string; label: string }[]; value: string | null; onClose: () => void; onChoose: (value: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()} title={title} className="settings-choice-dialog">
      <ChoiceList
        label={title}
        options={options}
        value={value}
        onChoose={(next) => {
          onClose();
          if (next !== value) onChoose(next);
        }}
      />
    </Dialog>
  );
}

/** The Library book that plays this work's chosen recording; built from the work when the Library has not read it. */
function bookToPlay(work: LibraryWork, books: Book[]): Book | null {
  const recording = work.recordings.find((item) => item.recordingId === work.chosenRecordingId) ?? null;
  if (!recording) return null;
  const known = books.find((book) => book.recordingId === recording.recordingId);
  if (known) return known;
  return {
    id: recording.editionId,
    workId: work.workId,
    editionId: recording.editionId,
    recordingId: recording.recordingId,
    title: work.title,
    author: work.author,
    narrator: recording.narrator,
    description: work.description,
    cover: recording.cover || work.cover,
    genre: work.genre,
    duration: recording.duration,
    rating: 0,
    year: work.year,
    tracks: recording.tracks,
    inLibrary: work.inLibrary,
    status: work.finished ? "finished" : recording.progress ? "listening" : "unread",
    addedAt: work.addedAt ?? 0,
    progress: recording.progress ?? undefined,
    serverStored: recording.serverStored,
    sourceLabel: recording.sourceLabel,
    language: recording.language,
    releaseTitle: recording.releaseTitle,
    faults: recording.faults,
    hardcover: work.hardcover ?? undefined,
  };
}

export function HardcoverPage({ workId, admin, books, onChanged }: Props) {
  const address = useAddress();
  const { work, status, reload } = useWork(workId);
  const { state, refresh } = useHardcover();
  const [changing, setChanging] = useState(false);
  // A work the server does not know, or one outside the library without a connection: the Library (spec #526).
  useEffect(() => {
    if (status === "missing" || status === "offline") address.navigate({ name: "library" }, { replace: true });
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setChanging(false), [workId, work?.hardcover?.id]);
  const changed = async () => {
    hardcoverChanged();
    onChanged();
    await Promise.all([reload(), refresh()]);
  };
  const match = work?.hardcover ?? null;
  return (
    <div className="hardcover-page" data-testid="hardcover-page">
      <div className="hardcover-page-head">
        {/* Back in history, or to the Library after a link, until the Book page exists (#532); named after the book. */}
        <PageHeader title="Hardcover" back parent={{ name: "library" }} named={() => "the book"} />
        {work && <p className="hardcover-page-book type-label">{work.title}</p>}
      </div>
      {!work || !state ? null : !state.configured ? (
        <p className="hardcover-page-line type-label">{NOT_CONNECTED_LINE}</p>
      ) : !match || changing ? (
        admin ? (
          <MatchSearch work={work} current={match?.id ?? null} onMatched={changed} />
        ) : (
          <p className="hardcover-page-line type-label">{NOT_MATCHED_OTHER_LINE}</p>
        )
      ) : (
        <Matched work={work} match={match} state={state} admin={admin} books={books} onChanged={changed} onChangeMatch={() => setChanging(true)} />
      )}
    </div>
  );
}

type MatchedProps = {
  work: LibraryWork;
  match: NonNullable<LibraryWork["hardcover"]>;
  state: NonNullable<ReturnType<typeof useHardcover>["state"]>;
  admin: boolean;
  books: Book[];
  onChanged: () => Promise<void>;
  onChangeMatch: () => void;
};

function Matched({ work, match, state, admin, books, onChanged, onChangeMatch }: MatchedProps) {
  const player = usePlayer();
  const off = editsOff(state.mode);
  const recordingId = work.chosenRecordingId;
  const [busy, setBusy] = useState("");
  // The shelf being saved, shown until the work read after it says so.
  const [shelfDraft, setShelfDraft] = useState<number | null>(null);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [shelfLine, setShelfLine] = useState<RowLine>(null);
  const [positionLine, setPositionLine] = useState<RowLine>(null);
  const [listDraft, setListDraft] = useState<Record<number, boolean>>({});
  const [listLines, setListLines] = useState<Record<number, RowLine>>({});
  const [editions, setEditions] = useState<{ recordingId: string; selected: number | null; editions: HardcoverEdition[] } | null>(null);
  const [editionOpen, setEditionOpen] = useState(false);
  const [editionLine, setEditionLine] = useState<RowLine>(null);
  const listSignature = match.listIds.join(",");
  useEffect(() => setListDraft({}), [work.workId, listSignature]);
  useEffect(() => setShelfDraft(null), [work.workId, match.statusId]);
  useEffect(() => {
    if (!recordingId) return;
    let live = true;
    void api<{ selectedEditionId: number | null; editions: HardcoverEdition[] }>(
      "/hardcover/editions?" + new URLSearchParams({ workId: work.workId, recordingId }),
    )
      .then((answer) => live && setEditions({ recordingId, selected: answer.selectedEditionId ?? null, editions: answer.editions ?? [] }))
      .catch((error: Error) => live && setEditionLine({ text: error.message, failed: true }));
    return () => {
      live = false;
    };
  }, [work.workId, recordingId, match.id]);

  const setShelf = async (statusId: number) => {
    setBusy("shelf");
    setShelfDraft(statusId);
    setShelfLine(null);
    try {
      await api("/hardcover/shelf", { method: "PATCH", body: JSON.stringify({ workId: work.workId, statusId }) });
      await onChanged();
    } catch (error) {
      setShelfDraft(null);
      setShelfLine({ text: (error as Error).message, failed: true });
    } finally {
      setBusy("");
    }
  };
  const setList = async (id: number, included: boolean) => {
    setListDraft((current) => ({ ...current, [id]: included }));
    setListLines((current) => ({ ...current, [id]: null }));
    setBusy(`list-${id}`);
    try {
      await api(`/hardcover/lists/${id}`, { method: "PATCH", body: JSON.stringify({ workId: work.workId, included }) });
      setListLines((current) => ({ ...current, [id]: { text: listSavedLine(included), failed: false } }));
      await onChanged();
    } catch (error) {
      // The switch returns to its state and says why on its row.
      setListDraft((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setListLines((current) => ({ ...current, [id]: { text: (error as Error).message, failed: true } }));
    } finally {
      setBusy("");
    }
  };
  const usePosition = async () => {
    const book = bookToPlay(work, books);
    if (!book) return;
    setBusy("position");
    setPositionLine(null);
    try {
      const previous = (await localDB.progress.get(book.recordingId)) || book.progress || null;
      const result = await api<{ progress: Progress | null }>("/hardcover/progress/pull", {
        method: "POST",
        body: JSON.stringify({ workId: work.workId, recordingId: book.recordingId }),
      });
      if (result.progress) {
        await localDB.progress.put({ ...result.progress, pending: false });
        const track = book.tracks.find((item) => item.id === result.progress!.trackId);
        // No confirmation: the place left is kept under Earlier positions, where it is undone.
        if (track) await player.play({ ...book, progress: result.progress }, track, result.progress.position, { kind: "hardcover", previous });
      }
      await onChanged();
    } catch (error) {
      setPositionLine({ text: (error as Error).message, failed: true });
    } finally {
      setBusy("");
    }
  };
  const chooseEdition = async (value: string) => {
    if (!recordingId) return;
    const editionId = value === "auto" ? null : Number(value);
    setBusy("edition");
    setEditionLine(null);
    try {
      await api("/hardcover/edition", { method: "PATCH", body: JSON.stringify({ workId: work.workId, recordingId, editionId }) });
      setEditions((current) => (current ? { ...current, selected: editionId } : current));
      setEditionLine({ text: EDITION_SAVED_LINE, failed: false });
    } catch (error) {
      setEditionLine({ text: (error as Error).message, failed: true });
    } finally {
      setBusy("");
    }
  };

  const statusId = shelfDraft ?? match.statusId;
  const sync = syncLine({ match, lastSync: state.lastSync, now: Date.now() });
  const notes = modeLine(state.mode);
  const url = hardcoverBookUrl(match);
  const shownEditions = editions && editions.recordingId === recordingId ? editions : null;
  const position = positionValue(match.progressFraction);
  return (
    <>
      <div className="hardcover-page-group">
        <Group label="Shelf and position">
          <Row label="Shelf" value={shelfValue(statusId, state.shelves)} onClick={() => setShelfOpen(true)} disabled={off || !!busy} />
          <Line line={shelfLine} />
          <Row
            label="Use Hardcover position"
            info={<InfoMark name="Use Hardcover position" text={tip("hardcoverPosition")} />}
            control={
              <button
                type="button"
                className="hardcover-value-button type-label"
                aria-label="Use Hardcover position"
                disabled={positionOff({ mode: state.mode, fraction: match.progressFraction, hasRecording: !!recordingId }) || !!busy}
                onClick={() => void usePosition()}
              >
                {position}
              </button>
            }
          />
          <Line line={positionLine} />
        </Group>
        <p className="hardcover-page-note" data-failed={sync.failed ? "" : undefined} role={sync.failed ? "alert" : undefined}>
          {sync.text}
        </p>
        {notes && <p className="hardcover-page-note">{notes}</p>}
      </div>
      {state.lists.length > 0 && (
        <Group caption="Lists">
          {state.lists.map((list) => (
            <ListRow
              key={list.id}
              name={list.name}
              on={listDraft[list.id] ?? match.listIds.includes(list.id)}
              disabled={off || !!busy}
              line={listLines[list.id] ?? null}
              onChange={(included) => void setList(list.id, included)}
            />
          ))}
        </Group>
      )}
      <Group caption="Match">
        {recordingId && (
          <>
            <Row
              label="Hardcover edition"
              info={<InfoMark name="Hardcover edition" text={tip("hardcoverEdition")} />}
              control={
                <button
                  type="button"
                  className="hardcover-value-button type-label"
                  aria-label={`Hardcover edition: ${editionValue(shownEditions?.selected ?? null, shownEditions?.editions ?? [])}`}
                  disabled={!shownEditions || !!busy}
                  onClick={() => setEditionOpen(true)}
                >
                  <span className="hardcover-value-text">{editionValue(shownEditions?.selected ?? null, shownEditions?.editions ?? [])}</span>
                  <ChevronDown />
                </button>
              }
            />
            <Line line={editionLine} />
          </>
        )}
        {url && (
          <li className="part-row-item">
            <a className="part-row hardcover-link-row" href={url} target="_blank" rel="noopener noreferrer">
              <span className="part-row-label type-body">Open on Hardcover</span>
              <span className="part-row-value type-label">
                <OutIcon />
              </span>
            </a>
          </li>
        )}
        {admin && <Row label="Change match" onClick={onChangeMatch} disabled={!!busy} />}
      </Group>
      <Picker
        open={shelfOpen}
        title="Shelf"
        options={state.shelves.map((shelf) => ({ value: String(shelf.id), label: shelf.name }))}
        value={statusId ? String(statusId) : null}
        onClose={() => setShelfOpen(false)}
        onChoose={(value) => void setShelf(Number(value))}
      />
      {shownEditions && (
        <Picker
          open={editionOpen}
          title="Hardcover edition"
          options={editionChoices(shownEditions.editions)}
          value={shownEditions.selected === null ? "auto" : String(shownEditions.selected)}
          onClose={() => setEditionOpen(false)}
          onChoose={(value) => void chooseEdition(value)}
        />
      )}
    </>
  );
}

function ListRow({ name, on, disabled, line, onChange }: { name: string; on: boolean; disabled: boolean; line: RowLine; onChange: (on: boolean) => void }) {
  return (
    <>
      <Row label={name} control={<Switch label={name} on={on} disabled={disabled} onChange={onChange} />} />
      <Line line={line} />
    </>
  );
}

/** Matching (administrator): the search filled with the title and author, the results as choice rows, and Match. */
function MatchSearch({ work, current, onMatched }: { work: LibraryWork; current: number | null; onMatched: () => Promise<void> }) {
  const [query, setQuery] = useState(() => matchQuery(work.title, work.author));
  const [results, setResults] = useState<MatchResult[] | null>(null);
  const [chosen, setChosen] = useState<number | null>(current);
  const [busy, setBusy] = useState<"" | "search" | "match">("");
  const [line, setLine] = useState<RowLine>(null);
  const asked = useRef(0);
  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = query.trim();
    if (text.length < 2) return;
    const ask = ++asked.current;
    setBusy("search");
    setLine(null);
    try {
      const answer = await api<unknown>("/discover/hardcover?q=" + encodeURIComponent(text.slice(0, 150)));
      if (ask !== asked.current) return;
      const found = matchResults(answer);
      setResults(found);
      setChosen((value) => (value !== null && found.some((item) => item.id === value) ? value : current !== null && found.some((item) => item.id === current) ? current : null));
    } catch (error) {
      if (ask === asked.current) setLine({ text: (error as Error).message, failed: true });
    } finally {
      if (ask === asked.current) setBusy("");
    }
  };
  // The search is filled with the title and author and asked at once, so the results are there when the page opens.
  useEffect(() => {
    void search();
  }, [work.workId]); // eslint-disable-line react-hooks/exhaustive-deps
  const match = async () => {
    if (chosen === null) return;
    setBusy("match");
    setLine(null);
    try {
      await api("/hardcover/books", { method: "POST", body: JSON.stringify({ id: chosen, workId: work.workId }) });
      await onMatched();
    } catch (error) {
      setLine({ text: (error as Error).message, failed: true });
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      {current === null && <p className="hardcover-page-line type-label">{NOT_MATCHED_ADMIN_LINE}</p>}
      <form className="hardcover-search" role="search" onSubmit={(event) => void search(event)}>
        <label className="hardcover-search-field">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input type="search" className="type-body" aria-label="Search Hardcover" value={query} maxLength={150} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} />
        </label>
      </form>
      <div className="hardcover-match-block">
        <div className="part-group-caption-line hardcover-match-caption">
          <h2 className="part-group-caption type-caption">Match on Hardcover</h2>
          <InfoMark name="Match on Hardcover" text={tip("hardcoverMatch")} />
        </div>
        {results && results.length > 0 && (
          <ChoiceGroup
            label="Match on Hardcover"
            options={results.map((result) => ({ value: String(result.id), label: result.title, detail: result.detail }))}
            value={chosen === null ? null : String(chosen)}
            onChange={(value) => setChosen(Number(value))}
          />
        )}
        {results && results.length === 0 && <p className="hardcover-page-line type-label">{NO_RESULTS_LINE}</p>}
        {busy === "search" && !results && <p className="hardcover-page-line type-label" role="status">Searching Hardcover</p>}
        {line && (
          <p className="hardcover-page-line type-label" data-failed="" role="alert">
            {line.text}
          </p>
        )}
      </div>
      <Button kind="primary" className="hardcover-match-button" disabled={chosen === null || !!busy || chosen === current} onClick={() => void match()}>
        Match
      </Button>
    </>
  );
}
