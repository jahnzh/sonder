// The Book page (#532, spec #526 "The Book page"; boards Book.dc.html, BookMore.dc.html, BookGetting.dc.html,
// BookSeries.dc.html; and #533's BookNotInLibrary.dc.html, BookNothing.dc.html, BookPdf.dc.html): `#book/<workId>`. The head (the back button named after where it goes, Favorite), the intro
// (cover, title, author, the series line, the place line), Listen and Read; Files (Audiobook, Ebook, Reading sync);
// This device (Keep on this device, the work's standing choice on this device, #550); About; then Want to read, Match
// (the administrator's), Mark as finished and Remove from library (the Hardcover row went with Hardcover, #721 part d). It replaces the book dialog (`BookDetail`). The words and rules are in
// book-model.ts; the work comes from the library by work on the device (`useWork`), so it opens without a connection.
import { useEffect, useMemo, useState } from "react";
import { api, localDB } from "../lib";
import { refreshLibraryWorks, useWork } from "../library-works-store";
import { useAddress } from "../navigation";
import { Button } from "../parts/Button";
import { FileRow } from "../parts/FileRow";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { InfoMark } from "../parts/Tooltip";
import { backName } from "../parts/back-name";
import { usePlayer } from "../player";
import { openReader } from "../reading";
import { useDeviceEbookChoice, useEbookDeviceCopy } from "../ebook-device-copy";
import { ebookSearchTarget } from "./ebook-page";
import { keepOffAndRemove, removeBookFiles, useDeviceBook, useKeepRecord } from "../keep-runtime";
import type { DeviceSaveRecord } from "../device-saves";
import { bytes } from "../size-format";
import { tip } from "../tooltip-texts";
import type { Book, Download, DownloadPart, LibraryWork } from "../types";
import { addedElsewhere, addsBeforeGet, bookModel, chosenRecording, wantToReadAction } from "./book-model";
import { wantToReadNote } from "../status-lines";
import type { Notify } from "./shared";
import { KeepItems } from "./keep-item";
import "./book-page.css";

export { KEEP_OFF_KEEPS, keepOffQuestion, earlierQuestion } from "./keep-item";
/** Remove from library's question adds this when this device holds files of the book. */
export const removedFromDevice = (size: number) => `It is also removed from this device, ${bytes(size)}.`;
/** Remove from library keeps these. */
export const REMOVE_KEEPS = "Your place and the files stay.";

type Running = Record<string, { progress: number; chapter: number; total: number }>;

type Props = {
  workId: string;
  admin: boolean;
  online: boolean;
  /** Every book of `GET /api/books` the app holds: the recordings as the player plays them, and the favourites' ids. */
  books: Book[];
  downloads: Download[];
  downloadParts: DownloadPart[];
  /** Saves to this device that are running now, by recording. */
  running: Running;
  /** The device's records of its saves (#517): how a kept book's last save stopped (#552). */
  records?: readonly DeviceSaveRecord[];
  /** The favourites by work (work ids). */
  favorites: string[];
  /** The Favorite button: the work joins the favourites by work, or leaves them (#577). */
  onFavorite: (workId: string) => void;
  /** Today's save of a recording to this device (the dock's and Activity's): Resume of a book that is not kept. */
  onSave: (book: Book) => void;
  /** Stops a running save of a recording. */
  onPauseSave: (recordingId: string) => void;
  /** Get audiobook (#601): opens the sheet at `#book/<workId>/get/audiobook`. */
  onFindAudio: (book: Book) => void;
  /** Today's ebook search for the book (Get ebook, until slice "Get"). */
  onFindEbook: (book: Book) => void;
  /** Opens the series' page, saved or not (#562, #564). */
  onSeries: (id: number, saved: boolean) => void;
  /** The library changed (an add, a removal, a mark): read the books again. */
  onChanged: () => Promise<void> | void;
  /** This device's files changed. */
  onDevice: () => Promise<void> | void;
  notify: Notify;
};

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5l11 7-11 7z" />
    </svg>
  );
}
function ReadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 6v14M12 6C10 4.5 7 4 4 4v14c3 0 6 .5 8 2M12 6c2-1.5 5-2 8-2v14c-3 0-6 .5-8 2" />
    </svg>
  );
}
function AddIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function ExpandIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function BookPage(props: Props) {
  const { workId, admin, online, books, downloads, downloadParts, running, favorites, notify } = props;
  const address = useAddress();
  const p = usePlayer();
  const { work, status, reload } = useWork(workId);
  const deviceChoice = useDeviceEbookChoice(workId);
  // Keep on this device is the work's Keep record on this device (#550); undefined while it is read.
  const keepRecord = useKeepRecord(workId);
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // An address that names nothing (no such work, or one outside the library without a connection) shows the Library.
  useEffect(() => {
    if (status === "missing" || status === "offline") address.navigate({ name: "library" }, { replace: true });
  }, [status, workId]);
  useEffect(() => {
    setConfirmRemove(false);
    setExpanded(false);
    setError("");
  }, [workId]);

  const recording = work ? chosenRecording(work) : null;
  const preModel = work ? bookModel(work, { admin, deviceChoice }) : null;
  const chosenEpub = preModel?.readEbookId ?? null;
  // Only a copy the user kept: the reader's own copy of a book it opened is a reading cache, not kept (#671), so it
  // neither turns Keep on nor stops Keep from saving the EPUB.
  const epubCopy = useEbookDeviceCopy(chosenEpub ?? work?.ebooks[0]?.id ?? null, { kept: true });
  const model = work ? bookModel(work, { admin, deviceChoice, deviceEbookSize: epubCopy.size }) : null;
  const entries = useMemo(() => books.filter((b) => b.workId === workId), [books, workId]);
  const favorite = favorites.includes(workId);
  const chosenBook = (recording && entries.find((b) => b.recordingId === recording.recordingId)) ?? null;
  const searchTarget = chosenBook ?? entries[0] ?? (work ? ebookSearchTarget(work) : null);
  // Every file of the book on this device (#553): what Off frees and the earlier copies.
  const onDevice = useDeviceBook(work);

  const back = address.backTarget();
  const backLabel = backName(back);
  const head = (
    <header className="book-page-head">
      <Button kind="secondary" icon={<BackIcon />} label={backLabel} onClick={() => address.goBack()} />
      {work?.inLibrary && (
        <Button
          kind="secondary"
          className="book-page-favorite"
          icon={<HeartIcon filled={favorite} />}
          label="Favorite"
          aria-pressed={favorite}
          data-pressed={favorite ? "" : undefined}
          onClick={() => props.onFavorite(workId)}
        />
      )}
    </header>
  );
  if (!work || !model) {
    return (
      <section className="book-page" aria-label="Book" data-status={status}>
        {head}
        {status === "loading" && <p className="book-page-muted type-label">Loading…</p>}
      </section>
    );
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const listen = async () => {
    if (!chosenBook) return;
    if (p.book?.recordingId === chosenBook.recordingId) {
      if (!p.playing) p.toggle();
    } else await p.play(chosenBook);
    // Now playing on its Listen face (#593).
    address.navigate({ name: "listen", workId });
  };
  const read = () => {
    if (!model.readEbookId) return;
    // The book in the player reads beside the narration: Now playing on its Read face (#593). A book without a
    // recording reads there too, like any other book (#594).
    if (model.readFace || p.book?.workId === workId) address.navigate({ name: "read", workId });
    else openReader(model.readEbookId);
  };
  /**
   * Add to library (#527): the work the server added, which for a Hardcover book not on the server is the work its
   * import made or matched (ADR 0022). When that is another work, the page's address becomes its address.
   */
  const addToLibrary = async () => {
    const answer = await api<{ ok: true; workId?: string }>(`/works/${encodeURIComponent(workId)}/library`, { method: "PUT" });
    await reload();
    await props.onChanged();
    window.dispatchEvent(new Event("sonder:library-changed"));
    const elsewhere = addedElsewhere(workId, answer);
    if (elsewhere) address.navigate({ name: "book", workId: elsewhere }, { replace: true });
    return elsewhere ?? workId;
  };
  // Get on a Hardcover book not in the library adds it first (#467, ADR 0022), then opens Get for the work that was added.
  const getFile = (kind: "audiobook" | "ebook") => {
    if (!addsBeforeGet(work)) {
      if (!searchTarget) return;
      if (kind === "audiobook") props.onFindAudio(searchTarget);
      else props.onFindEbook(searchTarget);
      return;
    }
    void run(async () => {
      const added = await addToLibrary();
      address.navigate({ name: "get", workId: added, kind });
    });
  };
  const getAudiobook = () => getFile("audiobook");
  const getEbook = () => getFile("ebook");
  const retry = () =>
    run(async () => {
      await api(`/works/${encodeURIComponent(workId)}/media/retry`, { method: "POST" });
      await reload();
    });
  const add = () =>
    run(async () => {
      await addToLibrary();
    });
  /**
   * Want to read (#721 part c1): on puts the work on the user's own list, adding it to the library first when it is
   * not there (a Hardcover book not on the server through the work Add to library makes, ADR 0022); off takes it off
   * and leaves it in the library.
   */
  const wantToRead = wantToReadAction(work);
  const toggleWantToRead = () =>
    run(async () => {
      const on = wantToRead.on;
      const answer = await api<{ ok: true; workId?: string }>(`/works/${encodeURIComponent(workId)}/want-to-read`, { method: on ? "PUT" : "DELETE" });
      await reload();
      await refreshLibraryWorks().catch(() => {});
      await props.onChanged();
      window.dispatchEvent(new Event("sonder:library-changed"));
      notify(wantToReadNote(on));
      const elsewhere = on ? addedElsewhere(workId, answer) : null;
      if (elsewhere) address.navigate({ name: "book", workId: elsewhere }, { replace: true });
    });
  const markFinished = () =>
    run(async () => {
      await api(`/works/${encodeURIComponent(workId)}/completion`, {
        method: "PATCH",
        body: JSON.stringify({ status: model.finished ? "unread" : "finished" }),
      });
      await refreshLibraryWorks().catch(() => {});
      await props.onChanged();
    });
  const remove = () =>
    run(async () => {
      await api(`/works/${encodeURIComponent(workId)}/library`, { method: "DELETE" });
      // Its files leave this device (#553): the server turned Keep off for the book on every device, and the question
      // said so. Another device removes them at its next run.
      if (keepRecord?.on) await keepOffAndRemove(workId, work);
      else await removeBookFiles(workId, work);
      await props.onDevice();
      // The history of the work's recordings goes with it, as removing a library row did; the places stay.
      const recordingIds = new Set([...work.recordings.map((r) => r.recordingId), ...entries.map((b) => b.recordingId)].filter(Boolean));
      await localDB.positionHistory.bulkDelete([...recordingIds]).catch(() => {});
      await refreshLibraryWorks().catch(() => {});
      await props.onChanged();
      notify("Removed from your library");
      setConfirmRemove(false);
      if (back.name === "library") address.goBack();
      else address.navigate({ name: "library" }, { replace: true });
    });

  const audiobookAction =
    model.audiobook.action === "get" ? (
      <Button kind={model.main === "get-audiobook" ? "primary" : "secondary"} aria-label="Get an audiobook" onClick={getAudiobook}>
        Get
      </Button>
    ) : model.audiobook.action === "retry" ? (
      <Button kind="secondary" aria-label="Retry the download" disabled={busy || !online} onClick={() => void retry()}>
        Retry
      </Button>
    ) : undefined;
  const syncInfo = <InfoMark name="Reading sync" text={tip("readingSync")} />;

  return (
    <section className="book-page" aria-label="Book">
      {head}

      <div className="book-page-intro">
        {work.cover ? (
          <img className="book-page-cover" src={work.cover} alt="" />
        ) : (
          <div className="book-page-cover book-page-cover-blank type-label" aria-hidden="true">
            {work.title}
          </div>
        )}
        <div className="book-page-names">
          <h1 className="book-page-title type-heading">{work.title}</h1>
          <p className="book-page-muted type-label">{work.author}</p>
          {model.series &&
            (model.series.id != null ? (
              <button
                type="button"
                className="book-page-series type-label"
                onClick={() =>
                  // A book not in the library opens its series' page (ADR 0022), which shows it saved or not saved.
                  model.inLibrary ? props.onSeries(model.series!.id!, model.series!.saved) : address.navigate({ name: "series", id: String(model.series!.id) })
                }
              >
                {model.series.label}
              </button>
            ) : (
              <p className="book-page-muted type-label">{model.series.label}</p>
            ))}
          <p className="book-page-muted type-label" data-testid="book-place">
            {model.place}
          </p>
        </div>
      </div>

      {model.inLibrary ? (
        <div className="book-page-actions">
          <Button kind={model.main === "listen" ? "primary" : "secondary"} icon={<PlayIcon />} disabled={!model.listen || !chosenBook} onClick={() => void listen()}>
            Listen
          </Button>
          <Button kind="secondary" icon={<ReadIcon />} disabled={!model.readEbookId} onClick={read}>
            Read
          </Button>
        </div>
      ) : (
        <div className="book-page-actions">
          <Button kind="primary" icon={<AddIcon />} disabled={busy || !online} onClick={() => void add()}>
            Add to library
          </Button>
          <Button kind="secondary" disabled={busy || !online} onClick={() => void toggleWantToRead()}>
            {wantToRead.label}
          </Button>
        </div>
      )}

      <Group caption="Files">
        {model.audiobook.opens ? (
          <FileRow
            kind="audiobook"
            name="Audiobook"
            status={model.audiobook.line}
            progress={model.audiobook.progress}
            onClick={() =>
              model.audiobook.opens === "audiobook"
                ? address.navigate({ name: "book-page", workId, page: "audiobook" })
                : address.navigate({ name: "activity", part: "now" })
            }
          />
        ) : (
          <FileRow kind="audiobook" name="Audiobook" status={model.audiobook.line} action={audiobookAction} />
        )}
        {model.ebook.opens ? (
          <FileRow kind="ebook" name="Ebook" status={model.ebook.line} onClick={() => address.navigate({ name: "book-page", workId, page: "ebook" })} />
        ) : (
          <FileRow
            kind="ebook"
            name="Ebook"
            status={model.ebook.line}
            action={
              model.ebook.action === "get" ? (
                <Button kind="secondary" aria-label="Get an ebook" onClick={getEbook}>
                  Get
                </Button>
              ) : undefined
            }
          />
        )}
        {/* With both files the row opens the Reading sync page (#540), as More › Reading sync in the reader does (#543). */}
        {model.sync.opens ? (
          <FileRow kind="sync" name="Reading sync" status={model.sync.line} info={syncInfo} onClick={() => address.navigate({ name: "book-page", workId, page: "sync" })} />
        ) : (
          <FileRow kind="sync" name="Reading sync" status={model.sync.line} info={syncInfo} muted={model.sync.muted} />
        )}
      </Group>

      {model.device && (
        <Group caption="This device">
          <KeepItems
            workId={workId}
            work={work}
            chosenEpub={chosenEpub}
            chosenBook={chosenBook}
            online={online}
            downloads={downloads}
            downloadParts={downloadParts}
            running={running}
            records={props.records}
            onSave={props.onSave}
            onDevice={props.onDevice}
            onError={setError}
          />
        </Group>
      )}

      {work.description && (
        <div className="part-group-block">
          <h2 className="part-group-caption type-caption">About</h2>
          <button
            type="button"
            className="book-page-about type-label"
            aria-expanded={expanded}
            aria-label="Show the whole description"
            data-expanded={expanded ? "" : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="book-page-about-text">{work.description}</span>
            <ExpandIcon />
          </button>
        </div>
      )}

      {model.inLibrary && (
        <Group label="Book">
          <Row label={wantToRead.label} disabled={busy || !online} onClick={() => void toggleWantToRead()} />
          {/* The catalogue match (#721), the administrator's. */}
          {admin && <Row label="Match" opens onClick={() => address.navigate({ name: "book-page", workId, page: "match" })} />}
          <Row label={model.finished ? "Mark as not finished" : "Mark as finished"} disabled={busy || !online} onClick={() => void markFinished()} />
          <Row label="Remove from library" disabled={busy || confirmRemove} onClick={() => setConfirmRemove(true)} />
        </Group>
      )}
      {confirmRemove && (
        <div className="book-page-confirm" role="group" aria-label="Remove from library?">
          <p className="type-label">
            Remove from library? {REMOVE_KEEPS}
            {onDevice?.any ? ` ${removedFromDevice(onDevice.size)}` : ""}
          </p>
          <div className="book-page-confirm-actions">
            <Button kind="secondary" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button kind="primary" disabled={busy || !online} onClick={() => void remove()}>
              Remove
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="book-page-error type-label" role="alert">
          {error}
        </p>
      )}

    </section>
  );
}
