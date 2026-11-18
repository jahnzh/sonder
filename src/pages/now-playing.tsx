// Now playing (#593, spec #586 "Now playing: one screen, two faces" and "The Listen face"; boards NowPlaying.dc.html,
// ReaderControls.dc.html): one screen at `#listen/<workId>` and `#read/<workId>`, its two faces switched in its head.
// Opening it adds an entry, switching faces replaces it (routes.ts, step), Back closes it. The face it opens on is
// the face rule's (src/now-playing-face.ts); the face shown is written for the work on this device.
//
// Listen: the cover and the book, the timeline, the transport, then Speed, Sleep timer and Chapters, then Plays from,
// Earlier positions and Keep on this device, as rows. Read: the reader's page with the face control in its head. It
// replaces the expanded player, its Playback options panel and the reader inside it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { Dialog } from "../components/ui/dialog";
import { PositionHistoryDialog } from "../components/PositionHistoryDialog";
import { PlaybackTimeline } from "../components/PlaybackTimeline";
import { ReaderView } from "../components/Reader";
import { Button } from "../parts/Button";
import { Group } from "../parts/Group";
import { Picker } from "../parts/Picker";
import { Row } from "../parts/Row";
import { Segmented } from "../parts/Segmented";
import { Stepper } from "../parts/Stepper";
import { InfoMark } from "../parts/Tooltip";
import { useAddress } from "../navigation";
import { useWork } from "../library-works-store";
import { useDeviceEbookChoice } from "../ebook-device-copy";
import { chosenEbook } from "../ebook-choice";
import { userStorageKey } from "../lib";
import { useBookSpeed, useHasOwnSpeed, usePlayer } from "../player";
import { SPEED_MAX, SPEED_MIN, SPEED_STEP, formatSpeed } from "../playback-speed";
import { SLEEP_CHOICES, formatSleep, sleepShown } from "../sleep-stepper";
import { currentChapter } from "../chapters";
import { isReaderPage, openedFromListen, useOpenerAny } from "../reader-pages";
import { type Face, faceFacts, faceKeyName, faceToOpen, readFace } from "../now-playing-face";
import { tip } from "../tooltip-texts";
import type { DeviceSaveRecord } from "../device-saves";
import type { Book, Download, DownloadPart, LibraryWork } from "../types";
import { chosenRecording } from "./book-model";
import { KeepItems } from "./keep-item";
import { PlaysFromRow } from "./plays-from";
import "./now-playing.css";

type Running = Record<string, { progress: number; chapter: number; total: number }>;

export type NowPlayingProps = {
  /** Every book of `GET /api/books` the app holds: the recordings as the player plays them. */
  books: Book[];
  downloads: Download[];
  downloadParts: DownloadPart[];
  running: Running;
  records?: readonly DeviceSaveRecord[];
  admin: boolean;
  online: boolean;
  notify: (text: string, error?: boolean) => void;
  /** Today's save of a recording to this device: Keep's Resume of a book that is not kept. */
  onSave: (book: Book) => void;
  /** This device's files changed. */
  onDevice: () => Promise<void> | void;
};

/** The face last shown on this device for a work is written when a face is shown (spec #586). */
function rememberFace(workId: string, face: Face) {
  try {
    localStorage.setItem(userStorageKey(faceKeyName(workId)), face);
  } catch {
    // Private mode or a full storage: the face rule falls back to Listen.
  }
}

export function NowPlaying(props: NowPlayingProps) {
  const { route } = useAddress();
  const opener = useOpenerAny();
  const face: Face | null = route.name === "listen" || route.name === "read" ? route.name : null;
  // Under one of the Read face's pages (Chapters, Bookmarks, Search, #590) the screen stays mounted, hidden, so the
  // reader is where it was when Back returns and a row of the page can show a place in it.
  const under =
    !face && opener?.host === "now-playing" && route.name === "book-page" && isReaderPage(route.page) && route.workId === opener.workId
      ? opener.workId
      : null;
  const workId = face ? (route as { workId: string }).workId : under;
  if (!workId) return null;
  return <NowPlayingScreen key={workId} {...props} workId={workId} face={face ?? "read"} open={!!face} />;
}

function NowPlayingScreen({ workId, face, open, ...props }: NowPlayingProps & { workId: string; face: Face; open: boolean }) {
  const address = useAddress();
  const p = usePlayer();
  const { work, status } = useWork(workId);
  const deviceChoice = useDeviceEbookChoice(workId);
  const epub = work ? chosenEbook(work, deviceChoice) : null;
  const facts = work ? faceFacts(work, epub?.id ?? null) : null;
  const recording = work ? chosenRecording(work) : null;
  // The book Listen plays: the one in the player when it is this work's, else the chosen recording's (#488).
  const book: Book | null =
    (p.book?.workId === workId ? p.book : null) ??
    props.books.find((entry) => entry.recordingId === recording?.recordingId) ??
    props.books.find((entry) => entry.workId === workId && entry.tracks.length > 0) ??
    null;
  const listenExists = !!facts?.recording && !!book;
  const readExists = !!facts?.epub;
  const exists = (which: Face) => (which === "listen" ? listenExists : readExists);

  // A face the work does not have is not shown: the other one is, in place of its entry; a work with neither (or
  // none at all) shows its Book page.
  const known = status === "ready" && !!work && !!facts;
  useEffect(() => {
    if (!open) return;
    if (status === "missing" || status === "offline") return void address.navigate({ name: "book", workId }, { replace: true });
    // A recording whose book the app has not read yet: wait for it rather than take Listen for missing.
    if (!known || (facts.recording && !book)) return;
    if (exists(face)) return;
    const other: Face = face === "listen" ? "read" : "listen";
    address.navigate(exists(other) ? { name: other, workId } : { name: "book", workId }, { replace: true });
  }, [open, known, face, status, listenExists, readExists, workId]);
  // The face is written when it is shown.
  useEffect(() => {
    if (open && known && exists(face)) rememberFace(workId, face);
  }, [open, known, face, listenExists, readExists, workId]);
  // A book that is not in the player yet is made ready to play on Listen, as the expanded player did.
  useEffect(() => {
    if (open && face === "listen" && book && !p.book) void p.prepare(book);
  }, [open, face, book?.id, p.book?.id]);

  const close = () => address.goBack({ name: "book", workId });
  const faceControl = <FaceSwitch workId={workId} face={face} admin={props.admin} exists={exists} />;
  const shown = known && exists(face);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && open) close();
      }}
      title="Now playing"
      forceMount
      className="now-playing-screen"
    >
      <div className="now-playing-face" data-face={face}>
        {face === "read" && epub && facts?.epub ? (
          <ReaderView
            key={epub.id}
            id={epub.id}
            fromAudio={false}
            inline
            recordingId={recording?.recordingId}
            books={props.books}
            notify={props.notify}
            onClose={close}
            faceControl={faceControl}
          />
        ) : face === "listen" && shown && book && work ? (
          <ListenFace work={work} book={book} epub={epub?.id ?? null} faceControl={faceControl} onClose={close} {...props} />
        ) : (
          <header className="now-playing-head">
            <CloseButton onClick={close} />
            {faceControl}
            <span className="now-playing-head-end" />
          </header>
        )}
      </div>
    </Dialog>
  );
}

function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function BookIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 6v14M12 6C10 4.500 7 4 4 4v14c3 0 6 .5 8 2M12 6c2-1.500 5-2 8-2v14c-3 0-6 .5-8 2" />
    </svg>
  );
}
function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
function PlayIcon({ playing, loading }: { playing: boolean; loading: boolean }) {
  if (loading) return <Loader2 size={28} className="spin" aria-hidden="true" />;
  return playing ? <Pause size={28} fill="currentColor" aria-hidden="true" /> : <Play size={28} fill="currentColor" aria-hidden="true" />;
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return <Button kind="secondary" className="now-playing-close" icon={<ChevronDownIcon />} label="Close now playing" onClick={onClick} />;
}

/**
 * The head's Listen or Read control (#489's Segmented control). A face the work does not have is still in it: it
 * opens Get audiobook or Get ebook for the administrator (`#book/<workId>/get/<kind>`) and is off for anyone else.
 */
function FaceSwitch({ workId, face, admin, exists }: { workId: string; face: Face; admin: boolean; exists: (face: Face) => boolean }) {
  const { navigate } = useAddress();
  return (
    <span className="now-playing-switch">
      <Segmented<Face>
        label="Listen or read"
        options={[
          { value: "listen", label: "Listen", disabled: !exists("listen") && !admin },
          { value: "read", label: "Read", disabled: !exists("read") && !admin },
        ]}
        value={face}
        onChange={(next) => {
          if (exists(next)) navigate({ name: next, workId });
          else if (admin) navigate({ name: "get", workId, kind: next === "listen" ? "audiobook" : "ebook" });
        }}
      />
    </span>
  );
}

function ListenFace({
  work,
  book,
  epub,
  faceControl,
  onClose,
  ...props
}: NowPlayingProps & { work: LibraryWork; book: Book; epub: string | null; faceControl: ReactNode; onClose: () => void }) {
  const address = useAddress();
  const p = usePlayer();
  const [sleepOpen, setSleepOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Closing Position history puts the focus back on Earlier positions.
  const earlier = useRef<HTMLButtonElement>(null);
  const [keepError, setKeepError] = useState("");
  const playsThis = p.book?.recordingId === book.recordingId;
  const trackId = playsThis ? p.track?.id : book.progress?.trackId ?? book.tracks[0]?.id;
  const position = playsThis ? p.position : book.progress?.position ?? 0;
  const chapter = trackId ? currentChapter(book, trackId, position) : undefined;
  const chapterTitle = (chapter?.title || book.tracks.find((t) => t.id === trackId)?.title || "").trim();
  const toggle = () => (playsThis ? p.toggle() : void p.play(book));
  const speed = useBookSpeed(book);
  const own = useHasOwnSpeed(book);
  const sleep = sleepShown(p.sleep);
  const sleepOptions = useMemo(
    () => [{ value: "off", label: "Off" }, ...SLEEP_CHOICES.map((minutes) => ({ value: String(minutes), label: `${minutes} minutes` }))],
    [],
  );
  const sleepValue = sleep === 0 ? "off" : sleepOptions.some((option) => option.value === String(sleep)) ? String(sleep) : null;
  return (
    <div className="now-playing-listen">
      <header className="now-playing-head">
        <CloseButton onClick={onClose} />
        {faceControl}
        <Button
          kind="secondary"
          className="now-playing-book"
          icon={<BookIcon />}
          label="Open this book’s page"
          onClick={() => address.navigate({ name: "book", workId: work.workId })}
        />
      </header>
      <div className="now-playing-body">
        <div className="now-playing-intro">
          <img className="now-playing-cover" src={book.cover || work.cover} alt="" />
          <div className="now-playing-names">
            <h1 className="type-heading">{work.title || book.title}</h1>
            <p className="type-label">{work.author || book.author}</p>
            {chapterTitle && <p className="type-label now-playing-chapter">{chapterTitle}</p>}
          </div>
        </div>
        <div className="now-playing-timeline">
          <PlaybackTimeline book={book} />
        </div>
        <div className="now-playing-transport">
          <button type="button" className="now-playing-skip type-label" aria-label="Rewind 30 seconds" disabled={!playsThis} onClick={() => p.skip(-30)}>
            −30
          </button>
          <button type="button" className="now-playing-play" aria-label={playsThis && p.playing ? "Pause" : "Play"} onClick={toggle}>
            <PlayIcon playing={playsThis && p.playing} loading={playsThis && p.loading} />
          </button>
          <button type="button" className="now-playing-skip type-label" aria-label="Forward 30 seconds" disabled={!playsThis} onClick={() => p.skip(30)}>
            +30
          </button>
        </div>
        {p.error && playsThis && (
          <p className="now-playing-error type-label" role="alert">
            {p.error}
          </p>
        )}
        <Group label="Playback">
          <Row
            label="Speed"
            info={<InfoMark name="Speed" text={tip("speed")} />}
            control={
              <span className="now-playing-speed">
                {own.recordingId && own.has && (
                  <Button kind="quiet" aria-label={`Use default · ${formatSpeed(p.defaultSpeed)}×`} onClick={() => p.resetSpeed(own.recordingId!)}>
                    Use default
                  </Button>
                )}
                <Stepper
                  label="Playback speed"
                  value={speed}
                  min={SPEED_MIN}
                  max={SPEED_MAX}
                  step={SPEED_STEP}
                  format={(value) => `${formatSpeed(value)}×`}
                  decreaseLabel="Slower"
                  increaseLabel="Faster"
                  onChange={(value) => p.setSpeed(value, book.recordingId)}
                />
              </span>
            }
          />
          <Row label="Sleep timer" value={formatSleep(sleep)} opens onClick={() => setSleepOpen(true)} />
          <Row
            label="Chapters"
            value={chapterTitle}
            opens
            onClick={() => {
              openedFromListen(work.workId);
              address.navigate({ name: "book-page", workId: work.workId, page: "chapters" });
            }}
          />
        </Group>
        <Group label="Source and device" note={keepError || undefined} noteFailed={!!keepError}>
          <PlaysFromRow book={book} downloads={props.downloads} online={props.online} />
          <Row
            label="Earlier positions"
            info={<InfoMark name="Earlier positions" text={tip("earlier")} />}
            control={
              <button ref={earlier} type="button" className="now-playing-opens type-label" aria-label="Earlier positions" onClick={() => setHistoryOpen(true)}>
                Undo a jump
                <ChevronRightIcon />
              </button>
            }
          />
          <KeepItems
            workId={work.workId}
            work={work}
            chosenEpub={epub}
            chosenBook={book}
            online={props.online}
            downloads={props.downloads}
            downloadParts={props.downloadParts}
            running={props.running}
            records={props.records}
            onSave={props.onSave}
            onDevice={props.onDevice}
            onError={setKeepError}
            idPrefix="listen-keep"
          />
        </Group>
      </div>
      <Picker
        open={sleepOpen}
        title="Sleep timer"
        options={sleepOptions}
        value={sleepValue}
        onClose={() => setSleepOpen(false)}
        onChoose={(value) => p.setSleep(value === "off" ? null : Number(value))}
      />
      <PositionHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} triggerRef={earlier} />
    </div>
  );
}

/**
 * Opens Now playing for a work on its face rule (the mini player, #593): Read without a recording, Listen without an
 * EPUB, else the face last shown for the work on this device, Listen the first time. It adds an entry.
 */
export function useOpenNowPlaying(workId: string | undefined) {
  const { navigate } = useAddress();
  const { work } = useWork(workId ?? "");
  const deviceChoice = useDeviceEbookChoice(workId ?? "");
  return () => {
    if (!workId) return;
    const facts = work ? faceFacts(work, chosenEbook(work, deviceChoice)?.id ?? null) : { recording: true, epub: false };
    let last: string | null = null;
    try {
      last = localStorage.getItem(userStorageKey(faceKeyName(workId)));
    } catch {
      last = null;
    }
    navigate({ name: faceToOpen(facts, readFace(last)), workId });
  };
}
