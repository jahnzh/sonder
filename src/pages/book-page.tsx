// The Book page (#532, spec #526 "The Book page"; boards Book.dc.html, BookMore.dc.html, BookGetting.dc.html,
// BookSeries.dc.html; and #533's BookNotInLibrary.dc.html, BookNothing.dc.html, BookPdf.dc.html): `#book/<workId>`. The head (the back button named after where it goes, Favorite), the intro
// (cover, title, author, the series line, the place line), Listen and Read; Files (Audiobook, Ebook, Reading sync);
// This device (Keep on this device, the work's standing choice on this device, #550); About; then Hardcover, Mark as
// finished and Remove from library. It replaces the book dialog (`BookDetail`). The words and rules are in
// book-model.ts; the work comes from the library by work on the device (`useWork`), so it opens without a connection.
import { useEffect, useMemo, useState } from "react";
import { useHardcover } from "../components/Hardcover";
import { api, localDB } from "../lib";
import { refreshLibraryWorks, useWork } from "../library-works-store";
import { openSheet, useAddress } from "../navigation";
import { Button } from "../parts/Button";
import { FileRow } from "../parts/FileRow";
import { Group } from "../parts/Group";
import { ProgressBar } from "../parts/ProgressBar";
import { Row } from "../parts/Row";
import { Switch } from "../parts/Switch";
import { InfoMark } from "../parts/Tooltip";
import { backName } from "../parts/back-name";
import { usePlayer } from "../player";
import { openReader } from "../reading";
import { useDeviceEbookChoice, useEbookDeviceCopy } from "../ebook-device-copy";
import { ebookSearchTarget } from "./ebook-page";
import { keepOffAndRemove, keepSaver, removeBookFiles, removeEarlierCopy, resumeKeep, tapKeep, useDeviceBook, useKeepRecord, useKeptNeeds } from "../keep-runtime";
import type { DeviceSaveRecord } from "../device-saves";
import { hardcoverRowValue } from "../hardcover-page-model";
import { bytes } from "../size-format";
import { tip } from "../tooltip-texts";
import type { Book, Download, DownloadPart, LibraryWork } from "../types";
import { bookModel, chosenRecording, deviceHold, favoriteOf, keepState } from "./book-model";
import type { Notify } from "./shared";
import "./book-page.css";

/** Removing the book's files from this device keeps these (board KeepOff.dc.html). */
export const KEEP_OFF_KEEPS = "Your place, bookmarks and library entry stay.";
/** Turning Keep off asks this, with the size of every file of the book on this device. */
export const keepOffQuestion = (size: number) => `Remove ${bytes(size)} from this device? ${KEEP_OFF_KEEPS}`;
/** An earlier copy's Remove asks this (board KeepEarlier.dc.html). */
export const earlierQuestion = (size: number) => `Remove ${bytes(size)} from this device?`;
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
  favorites: string[];
  /** Every entry of the work joins today's favourites list, or every one leaves it. */
  onFavorite: (entryIds: string[]) => void;
  /** Today's save of a recording to this device (the dock's and Activity's): Resume of a book that is not kept. */
  onSave: (book: Book) => void;
  /** Stops a running save of a recording. */
  onPauseSave: (recordingId: string) => void;
  /** Get audiobook (#601): opens the sheet at `#book/<workId>/get/audiobook`. */
  onFindAudio: (book: Book) => void;
  /** Today's ebook search for the book (Get ebook, until slice "Get"). */
  onFindEbook: (book: Book) => void;
  /** A saved series opens its Series page (#562); another one today's series dialog. */
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
  const { state: hardcover } = useHardcover();
  const deviceChoice = useDeviceEbookChoice(workId);
  // Keep on this device is the work's Keep record on this device (#550); undefined while it is read.
  const keepRecord = useKeepRecord(workId);
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmKeepOff, setConfirmKeepOff] = useState(false);
  // The earlier copy whose Remove asks in place (#553), by recording.
  const [confirmEarlier, setConfirmEarlier] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // An address that names nothing (no such work, or one outside the library without a connection) shows the Library.
  useEffect(() => {
    if (status === "missing" || status === "offline") address.navigate({ name: "library" }, { replace: true });
  }, [status, workId]);
  useEffect(() => {
    setConfirmRemove(false);
    setConfirmKeepOff(false);
    setConfirmEarlier(null);
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
  const entryIds = entries.map((b) => b.id);
  const favorite = favoriteOf(entryIds, favorites);
  const chosenBook = (recording && entries.find((b) => b.recordingId === recording.recordingId)) ?? null;
  const searchTarget = chosenBook ?? entries[0] ?? (work ? ebookSearchTarget(work) : null);
  const hold = deviceHold(recording, downloads, downloadParts);
  const epubSize = chosenEpub && epubCopy.known ? epubCopy.size : null;
  const needs = useKeptNeeds(work, downloads, downloadParts);
  // The save of the book: its recording's, or for a book with only an ebook its EPUB's (#551).
  const saveId = recording ? recording.recordingId : needs?.ebook ? `ebook:${needs.ebook.id}` : null;
  const job = saveId ? running[saveId] : undefined;
  const saveRecord = saveId ? props.records?.find((r) => r.recordingId === saveId) : undefined;
  // How the kept book's last save stopped (#552): a failure waits for Retry, a pause (on any tab) for Resume.
  const stop =
    saveRecord?.state === "failed"
      ? { why: "failed" as const, failure: saveRecord.failure ?? null }
      : keepRecord?.pausedAt || saveRecord?.state === "paused"
        ? { why: "paused" as const }
        : null;
  const keep = keepState({
    keep: keepRecord?.on === true,
    hold,
    saving: job ? { filesSaved: Math.max(0, job.chapter - 1), filesTotal: job.total } : null,
    ebookSize: epubSize,
    hasRecording: !!recording && recording.tracks.length > 0,
    needs,
    stop,
  });
  // Every file of the book on this device (#553): what Off frees and the earlier copies.
  const onDevice = useDeviceBook(work);
  const hardcoverValue = hardcoverRowValue(hardcover, work?.hardcover ?? null);

  const back = address.backTarget();
  const backLabel = backName(back);
  const head = (
    <header className="book-page-head">
      <Button kind="secondary" icon={<BackIcon />} label={backLabel} onClick={() => address.goBack()} />
      {work?.inLibrary && entryIds.length > 0 && (
        <Button
          kind="secondary"
          className="book-page-favorite"
          icon={<HeartIcon filled={favorite} />}
          label="Favorite"
          aria-pressed={favorite}
          data-pressed={favorite ? "" : undefined}
          onClick={() => props.onFavorite(entryIds)}
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
    openSheet("now-playing");
  };
  const read = () => {
    if (!model.readEbookId) return;
    // The book in the player reads beside the narration, as the player's own Read does.
    if (p.book?.workId === workId)
      window.dispatchEvent(new CustomEvent("sonder:playback-reader", { detail: { id: model.readEbookId, workId } }));
    else openReader(model.readEbookId);
  };
  const getAudiobook = () => searchTarget && props.onFindAudio(searchTarget);
  const getEbook = () => searchTarget && props.onFindEbook(searchTarget);
  const retry = () =>
    run(async () => {
      await api(`/works/${encodeURIComponent(workId)}/media/retry`, { method: "POST" });
      await reload();
    });
  const add = () =>
    run(async () => {
      await api(`/works/${encodeURIComponent(workId)}/library`, { method: "PUT" });
      await reload();
      await props.onChanged();
      window.dispatchEvent(new Event("sonder:library-changed"));
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

  // Keep on this device (#550): on stores the choice and asks the saver to make this device hold the book; the saver
  // saves the chosen recording, the chosen EPUB and the pair's map now, and whatever of them arrives later (#551).
  // Only this tap asks for persistent storage (`tap`).
  const keepOn = () => {
    setError("");
    void tapKeep(workId, true).catch((e: Error) => setError(e.message));
  };
  // Resume: a kept book's save is the saver's; another is today's save.
  // Resume and Retry of a kept book clear its pause and ask the tab that saves to save it again (#552).
  const resume = () => {
    if (keepRecord?.on && keepSaver()) void resumeKeep(workId).catch((e: Error) => setError(e.message));
    else if (chosenBook) props.onSave(chosenBook);
  };
  // Off (#553): removes every file of the book from this device (its recordings, complete and partial, earlier copies
  // included, its EPUB copies, its maps and its save records) and writes off. The place, bookmarks and library entry
  // stay. Remove on Activity's This device is the same action.
  const keepOff = () =>
    run(async () => {
      await keepOffAndRemove(workId, work);
      await props.onDevice();
      setConfirmKeepOff(false);
    });
  // The switch turned off asks in place with the size; with nothing on the device it turns off without asking.
  const switchOff = () => {
    if (onDevice?.any) setConfirmKeepOff(true);
    else void keepOff();
  };
  const removeEarlier = (recordingId: string) =>
    run(async () => {
      await removeEarlierCopy(workId, recordingId);
      await props.onDevice();
      setConfirmEarlier(null);
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
              <button type="button" className="book-page-series type-label" onClick={() => props.onSeries(model.series!.id!, model.series!.saved)}>
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
        <div className="book-page-actions" data-one="">
          <Button kind="primary" icon={<AddIcon />} disabled={busy || !online} onClick={() => void add()}>
            Add to library
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
          <li className="book-page-keep-item" aria-labelledby={`book-keep-name${keep.line ? " book-keep-line" : ""}`}>
            <div className="part-file-row book-page-keep" data-moving={job ? "" : undefined}>
              <span className="part-file-row-text">
                <span className="part-file-row-title">
                  <span id="book-keep-name" className="part-file-row-name type-body">
                    Keep on this device
                  </span>
                  <InfoMark name="Keep on this device" text={tip("keep")} />
                </span>
                {keep.line && (
                  <span id="book-keep-line" className="part-file-row-status type-label" data-failed={keep.failed ? "" : undefined}>
                    {keep.line}
                  </span>
                )}
                {job && <ProgressBar progress={job.progress / 100} />}
              </span>
              <span className="part-file-row-end">
                {keep.resumable && !job && (chosenBook || keepRecord?.on) && (
                  <Button kind="quiet" disabled={busy || !online} onClick={resume}>
                    Resume
                  </Button>
                )}
                <Switch
                  label="Keep on this device"
                  on={keep.on}
                  disabled={busy || keepRecord === undefined}
                  onChange={(on) => (on ? keepOn() : switchOff())}
                />
              </span>
            </div>
          </li>
          {/* A failed save: its reason in one line and Retry (board KeepNotComplete.dc.html). */}
          {keep.failed && keep.reason && !job && (
            <li className="part-file-row book-page-keep-failure">
              <span className="part-file-row-text">
                <span className="part-file-row-status type-label" id="book-keep-reason">
                  {keep.reason}
                </span>
              </span>
              <span className="part-file-row-end">
                <Button aria-label="Retry saving on this device" aria-describedby="book-keep-reason" disabled={busy || !online} onClick={resume}>
                  Retry
                </Button>
              </span>
            </li>
          )}
          {/* Turning the switch off asks in place under the row (board KeepOff.dc.html); the switch stays on until Remove. */}
          {confirmKeepOff && (
            <li className="book-page-device-confirm" role="group" aria-label="Turn off Keep on this device">
              <span className="type-body">{keepOffQuestion(onDevice?.size ?? 0)}</span>
              <span className="book-page-device-confirm-buttons">
                <Button onClick={() => setConfirmKeepOff(false)}>Cancel</Button>
                <Button className="book-page-device-remove" disabled={busy} onClick={() => void keepOff()}>
                  Remove
                </Button>
              </span>
            </li>
          )}
          {/* An earlier copy (board KeepEarlier.dc.html): a row per copy with Remove, which asks once in place. */}
          {keep.on &&
            (onDevice?.earlier ?? []).map((copy) => (
              <EarlierRow
                key={copy.recordingId}
                narrator={copy.narrator}
                size={copy.size}
                asking={confirmEarlier === copy.recordingId}
                busy={busy}
                onAsk={() => setConfirmEarlier(copy.recordingId)}
                onCancel={() => setConfirmEarlier(null)}
                onRemove={() => void removeEarlier(copy.recordingId)}
              />
            ))}
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
          {hardcoverValue !== null && (
            <Row label="Hardcover" value={hardcoverValue} opens onClick={() => address.navigate({ name: "book-page", workId, page: "hardcover" })} />
          )}
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

/** An earlier copy's row: "Earlier recording", the narrator and its size, and Remove that asks once in place. */
function EarlierRow(props: { narrator: string; size: number; asking: boolean; busy: boolean; onAsk: () => void; onCancel: () => void; onRemove: () => void }) {
  const status = [props.narrator, bytes(props.size)].filter(Boolean).join(" · ");
  return (
    <>
      <li className="part-file-row book-page-earlier" data-asking={props.asking ? "" : undefined}>
        <span className="part-file-row-text">
          <span className="part-file-row-name type-body">Earlier recording</span>
          <span className="part-file-row-status type-label">{status}</span>
        </span>
        <span className="part-file-row-end">
          <Button aria-label="Remove the earlier recording from this device" aria-expanded={props.asking} disabled={props.busy} onClick={props.onAsk}>
            Remove
          </Button>
        </span>
      </li>
      {props.asking && (
        <li className="book-page-device-confirm" role="group" aria-label="Remove the earlier recording from this device">
          <span className="type-body">{earlierQuestion(props.size)}</span>
          <span className="book-page-device-confirm-buttons">
            <Button onClick={props.onCancel}>Cancel</Button>
            <Button className="book-page-device-remove" disabled={props.busy} onClick={props.onRemove}>
              Remove
            </Button>
          </span>
        </li>
      )}
    </>
  );
}
