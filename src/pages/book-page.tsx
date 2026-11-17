// The Book page (#532, spec #526 "The Book page"; boards Book.dc.html, BookMore.dc.html, BookGetting.dc.html,
// BookSeries.dc.html; and #533's BookNotInLibrary.dc.html, BookNothing.dc.html, BookPdf.dc.html): `#book/<workId>`. The head (the back button named after where it goes, Favorite), the intro
// (cover, title, author, the series line, the place line), Listen and Read; Files (Audiobook, Ebook, Reading sync);
// This device (Keep on this device, a bridge to today's saves until slice "Keep"); About; then Hardcover, Mark as
// finished and Remove from library. It replaces the book dialog (`BookDetail`). The words and rules are in
// book-model.ts; the work comes from the library by work on the device (`useWork`), so it opens without a connection.
import { useEffect, useMemo, useState } from "react";
import { useHardcover } from "../components/Hardcover";
import { Dialog } from "../components/ui/dialog";
import { api, deleteDownloads, localDB } from "../lib";
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
import { ebookDeviceCopySize, EBOOK_DEVICE_EVENT, removeEbookFromDevice, saveEbookToDevice, useDeviceEbookChoice, useEbookDeviceCopy } from "../ebook-device-copy";
import { ebookSearchTarget } from "./ebook-page";
import { hardcoverRowValue } from "../hardcover-page-model";
import { bytes } from "../size-format";
import { tip } from "../tooltip-texts";
import type { Book, Download, DownloadPart, LibraryWork } from "../types";
import { bookModel, chosenRecording, deviceHold, favoriteOf, keepState } from "./book-model";
import type { Notify } from "./shared";
import "./book-page.css";

/** Removing the book's files from this device keeps these. */
export const KEEP_OFF_KEEPS = "Your place, bookmarks and the library entry stay.";
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
  favorites: string[];
  /** Every entry of the work joins today's favourites list, or every one leaves it. */
  onFavorite: (entryIds: string[]) => void;
  /** Today's save of a recording to this device (the dock's and Activity's). */
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

/** The bytes of a work's files on this device: every recording's audio (whole files and saved sections) and its EPUBs. */
function useDeviceSize(work: LibraryWork | null, downloads: Download[], parts: DownloadPart[]) {
  const [ebookBytes, setEbookBytes] = useState(0);
  const ebookIds = work?.ebooks.map((ebook) => ebook.id).join(" ") ?? "";
  useEffect(() => {
    let live = true;
    const read = () =>
      void Promise.all(ebookIds.split(" ").filter(Boolean).map((id) => ebookDeviceCopySize(id))).then((sizes) => {
        if (live) setEbookBytes(sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0));
      });
    read();
    window.addEventListener(EBOOK_DEVICE_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(EBOOK_DEVICE_EVENT, read);
    };
  }, [ebookIds]);
  const recordings = new Set(work?.recordings.map((r) => r.recordingId) ?? []);
  const whole = downloads.filter((file) => recordings.has(file.recordingId));
  const done = new Set(whole.map((file) => file.trackId));
  const audio =
    whole.reduce((sum, file) => sum + (file.size || 0), 0) +
    parts.filter((part) => recordings.has(part.recordingId) && !done.has(part.trackId)).reduce((sum, part) => sum + (part.loaded || 0), 0);
  return audio + ebookBytes;
}

export function BookPage(props: Props) {
  const { workId, admin, online, books, downloads, downloadParts, running, favorites, notify } = props;
  const address = useAddress();
  const p = usePlayer();
  const { work, status, reload } = useWork(workId);
  const { state: hardcover } = useHardcover();
  const deviceChoice = useDeviceEbookChoice(workId);
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmKeepOff, setConfirmKeepOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // An address that names nothing (no such work, or one outside the library without a connection) shows the Library.
  useEffect(() => {
    if (status === "missing" || status === "offline") address.navigate({ name: "library" }, { replace: true });
  }, [status, workId]);
  useEffect(() => {
    setConfirmRemove(false);
    setConfirmKeepOff(false);
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
  const job = recording ? running[recording.recordingId] : undefined;
  const epubSize = chosenEpub && epubCopy.known ? epubCopy.size : null;
  const keep = keepState({
    hold,
    saving: job ? { filesSaved: Math.max(0, job.chapter - 1), filesTotal: job.total } : null,
    ebookSize: epubSize,
    hasRecording: !!recording && recording.tracks.length > 0,
  });
  const deviceSize = useDeviceSize(work, downloads, downloadParts);
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

  // Keep on this device, a bridge to today's saves: on starts the save of the chosen recording and the chosen EPUB.
  // Neither save holds the switch: the audio's runs in the app (Activity shows it), the EPUB's ends by itself.
  const keepOn = () => {
    setError("");
    if (chosenBook && chosenBook.tracks.length) props.onSave(chosenBook);
    if (chosenEpub && epubSize == null)
      void saveEbookToDevice(chosenEpub)
        .then(() => epubCopy.read())
        .catch((e: Error) => setError(e.message));
  };
  // Off removes every file of the book from this device: its recordings' audio and its EPUBs. The place stays.
  const keepOff = () =>
    run(async () => {
      for (const r of work.recordings) {
        if (running[r.recordingId]) props.onPauseSave(r.recordingId);
        await deleteDownloads(r.recordingId);
      }
      for (const ebook of work.ebooks) if ((await ebookDeviceCopySize(ebook.id)) != null) await removeEbookFromDevice(ebook.id);
      window.dispatchEvent(new Event("sonder:downloads-changed"));
      await props.onDevice();
      setConfirmKeepOff(false);
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
        {/* Not a link until the Reading sync page (S9); the reader's More sheet keeps today's card. */}
        <FileRow kind="sync" name="Reading sync" status={model.sync.line} info={syncInfo} muted={model.sync.muted} />
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
                  <span id="book-keep-line" className="part-file-row-status type-label">
                    {keep.line}
                  </span>
                )}
                {job && <ProgressBar progress={job.progress / 100} />}
              </span>
              <span className="part-file-row-end">
                {keep.resumable && !job && chosenBook && (
                  <Button kind="quiet" disabled={busy} onClick={() => props.onSave(chosenBook)}>
                    Resume
                  </Button>
                )}
                <Switch
                  label="Keep on this device"
                  on={keep.on}
                  disabled={busy}
                  onChange={(on) => (on ? keepOn() : setConfirmKeepOff(true))}
                />
              </span>
            </div>
          </li>
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
          <p className="type-label">Remove from library? {REMOVE_KEEPS}</p>
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

      <Dialog
        open={confirmKeepOff}
        onOpenChange={(next) => !next && setConfirmKeepOff(false)}
        title="Remove from this device?"
        description={`${bytes(deviceSize)} on this device. ${KEEP_OFF_KEEPS}`}
        className="book-page-dialog"
      >
        <div className="book-page-confirm-actions">
          <Button kind="secondary" onClick={() => setConfirmKeepOff(false)}>
            Cancel
          </Button>
          <Button kind="primary" disabled={busy} onClick={() => void keepOff()}>
            Remove
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
