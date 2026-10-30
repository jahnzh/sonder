import { KeyboardHelpButton } from "./KeyboardHelp";
import { useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  ListMusic,
  Timer,
  Maximize2,
  ChevronDown,
  Loader2,
  Check,
  Headphones,
  Download,
  HardDrive,
  Cloud,
  Smartphone,
  Layers,
  BookOpen,
  X,
  MoreHorizontal,
} from "lucide-react";
import { usePlayer } from "../player";
import { clock, localDB } from "../lib";
import { Dialog } from "./ui/dialog";
import { Chapters } from "./Chapters";
import { PlaybackReader } from "./PlaybackReader";
import { PlaybackSource } from "./PlaybackSource";
import { PlaybackOptions } from "./PlaybackOptions";
import {PlaybackMenuContext,PlaybackExtra} from "./PlaybackMenu";
import { PlaybackTimeline } from "./PlaybackTimeline";
import { useAppearance } from "./Appearance";
import { ReaderShortcut } from "./ReaderShortcut";
import { listeningChapters, currentChapter } from "../chapters";
import { hasKnownReader, warmPlaybackReading } from "../reading";
import type { Book, SavedEbook } from "../types";
export function PlayerDock({
  fallback,
  isDownloaded,
  hasPartialDownload,
  downloadJobs,
  onDownload,
  onPauseDownload,
  onViewDownloads,
  onBookDetails,
  onManageSources,
  books,
  notify,
}: {
  fallback: Book | undefined;
  isDownloaded: (book: Book) => boolean;
  hasPartialDownload: (book: Book) => boolean;
  downloadJobs: Record<
    string,
    { progress: number; chapter: number; total: number }
  >;
  onDownload: (book: Book) => void;
  onPauseDownload: (book: Book) => void;
  onViewDownloads: () => void;
  onBookDetails: (book: Book) => void;
  onManageSources: (book: Book) => void;
  books: Book[];
  notify: (text:string,error?:boolean)=>void;
}) {
  const p = usePlayer();
  const { appearance, saveReader } = useAppearance();
  const [expanded, setExpanded] = useState(false);
  const b = p.book || fallback;
  const [hasReader, setHasReader] = useState(() => hasKnownReader(b?.workId));
  const [chaptersOpen,setChaptersOpen] = useState(false);
  const [optionsOpen,setOptionsOpen] = useState(false);
  const [optionsHost,setOptionsHost] = useState<HTMLDivElement|null>(null);
  const optionsTrigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    const open=(event:Event)=>{if((event as CustomEvent).detail.workId===b?.workId)setExpanded(true);};
    window.addEventListener("sonder:playback-reader",open);
    return ()=>window.removeEventListener("sonder:playback-reader",open);
  },[b?.workId]);
  useEffect(() => {
    if (!b?.workId) {
      setHasReader(false);
      return;
    }
    const known = hasKnownReader(b.workId);
    setHasReader(known);
    if (!known) {
      localDB.preferences
        .get("ebooks")
        .then((item) => {
          const list = item?.value as SavedEbook[] | undefined;
          if (
            list?.some(
              (e) => e.workId === b.workId && e.format === "epub" && e.available,
            )
          ) {
            setHasReader(true);
          }
        })
        .catch(() => {});
    }
  }, [b?.workId]);
  useEffect(() => {
    if (!b?.workId) return;
    const cancel = warmPlaybackReading(b.workId, b.recordingId);
    return () => {
      cancel?.();
    };
  }, [b?.workId, b?.recordingId]);
  useEffect(()=>{if(!expanded)setOptionsOpen(false);},[expanded]);
  useEffect(()=>{
    if(expanded && b && !p.book)void p.prepare(b);
  },[expanded,b?.id,p.book?.id]);
  useEffect(()=>{
    if(!optionsOpen)return;
    const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!optionsHost?.contains(target) && !optionsTrigger.current?.contains(target))setOptionsOpen(false);};
    document.addEventListener("pointerdown",outside,true);
    return()=>document.removeEventListener("pointerdown",outside,true);
  },[optionsOpen,optionsHost]);
  if (!b) return null;
  const downloadJob = downloadJobs[b.recordingId];
  const saved = isDownloaded(b);
  const partial = hasPartialDownload(b);
  const toggle = () => (p.book ? p.toggle() : void p.play(b));
  return (
    <>
      <div className="player-dock">
        <div className="dock-info">
          <button
            className="dock-cover-button"
            aria-label={`Open title page for ${b.title}`}
            onClick={() => onBookDetails(b)}
          >
            <img src={b.cover} alt="" />
          </button>
          <button
            className="dock-book"
            onClick={() => {
              setExpanded(true);
            }}
          >
            <span>
              <strong>{b.title}</strong>
              <small>
                {p.track
                  ? (
                      currentChapter(p.book || b, p.track.id, p.position)
                        ?.title || p.track.title
                    ).replace(/^\d+[. -]*/, "")
                  : b.author}
              </small>
              {p.book && <PlaybackSource compact />}
            </span>
            <ChevronDown className="mobile-player-chevron" size={18} />
          </button>
        </div>
        <div className="dock-center">
          <div className="transport">
            <button
              className="seek-button"
              onClick={() => p.skip(-30)}
              aria-label="Rewind 30 seconds"
              disabled={!p.book}
            >
              <RotateCcw size={23} />
              <span>30</span>
            </button>
            <button
              className="play-button"
              aria-label={p.playing ? "Pause" : "Play"}
              onClick={toggle}
            >
              {p.loading ? (
                <Loader2 size={22} className="spin" />
              ) : p.playing ? (
                <Pause size={20} fill="currentColor" />
              ) : (
                <Play size={20} fill="currentColor" />
              )}
            </button>
            <button
              className="seek-button"
              onClick={() => p.skip(30)}
              aria-label="Forward 30 seconds"
              disabled={!p.book}
            >
              <RotateCw size={23} />
              <span>30</span>
            </button>
          </div>
          <PlaybackTimeline book={b} compact />
        </div>
        <div className="dock-actions">
          <button
            className="icon-button"
            aria-label="Manage versions and sources"
            title="Versions & sources"
            onClick={() => onManageSources(p.book || b)}
          >
            <Layers size={19} />
          </button>
          <button
            className="icon-button"
            aria-label={
              saved
                ? "Saved on this device"
                : downloadJob
                  ? "Pause device download"
                  : partial
                    ? "Resume download on this device"
                    : "Save on this device"
            }
            disabled={saved || !b.tracks.length}
            onClick={() => (downloadJob ? onPauseDownload(b) : onDownload(b))}
          >
            {saved ? (
              <Check size={19} />
            ) : downloadJob ? (
              <Pause size={19} />
            ) : (
              <Download size={19} />
            )}
          </button>
          <PlaybackOptions kind="speed" book={b} />
          <PlaybackOptions kind="sleep" />
          <button
            className="icon-button"
            aria-label="Chapters and now playing"
            onClick={() => {
              setExpanded(true);
            }}
          >
            <ListMusic size={20} />
          </button>
          <div className="volume-control">
            <button
              className="icon-button"
              aria-label={p.volume ? "Mute" : "Unmute"}
              onClick={() => p.setVolume(p.volume ? 0 : 1)}
            >
              {p.volume ? <Volume2 size={20} /> : <VolumeX size={20} />}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step=".05"
              value={p.volume}
              onChange={(e) => p.setVolume(Number(e.target.value))}
              aria-label="Volume"
            />
          </div>
          <button
            className="icon-button expand-player"
            aria-label="Expand player"
            onClick={() => {
              setExpanded(true);
            }}
          >
            <Maximize2 size={17} />
          </button>
        </div>
        <div className="reader-shortcut dock-reader-shortcut"><button className="icon-button" aria-label="Open ebook reader" title="Open ebook reader" onClick={()=>setExpanded(true)}><BookOpen size={19}/></button></div>
      </div>
      {p.error && (
        <div className="player-error" role="alert">
          {p.error}
        </div>
      )}
      <Dialog
        open={expanded}
        onOpenChange={setExpanded}
        title="Now playing"
        forceMount
        className={`now-playing-dialog ${hasReader ? "with-reader" : ""}`}
        onEscapeKeyDown={event=>{if(optionsOpen){event.preventDefault();setOptionsOpen(false);requestAnimationFrame(()=>optionsTrigger.current?.focus());}}}
        onPointerDownOutside={(event) => {
          const target = (event as CustomEvent<{ originalEvent: PointerEvent }>).detail
            ?.originalEvent?.target as Element | undefined;
          if (target?.closest?.(".player-dock")) event.preventDefault();
        }}
        actions={hasReader && <>
          <h2 className="now-playing-heading-title">{(p.book || b).title}</h2>
          <button ref={optionsTrigger} className="icon-button playback-menu-trigger" aria-label="Playback options" aria-expanded={optionsOpen} onClick={()=>setOptionsOpen(!optionsOpen)}><MoreHorizontal size={23}/></button>
        </>}
      >
        {hasReader && optionsOpen && <button className="playback-options-backdrop" aria-label="Dismiss playback options" onClick={()=>setOptionsOpen(false)}/>}
        {hasReader && <div className="playback-options-panel" ref={setOptionsHost} hidden={!optionsOpen} role="region" aria-label="Playback options">
          <div className="playback-options-heading"><h3>Playback options</h3><button className="icon-button" aria-label="Close playback options" onClick={()=>{setOptionsOpen(false);optionsTrigger.current?.focus();}}><X size={20}/></button></div>
        </div>}
        <PlaybackMenuContext.Provider value={hasReader ? {host:optionsHost,open:()=>setOptionsOpen(true),close:()=>setOptionsOpen(false)} : null}>
        <div className="now-playing-layout">
          <div className="now-playing-main">
            <PlaybackExtra>
            <div className="player-quick-links">
              {hasReader && <button className="button subtle mobile-reader-chapters" onClick={()=>{setChaptersOpen(true);document.querySelector(".playback-options-panel .now-playing-chapters")?.scrollIntoView({block:"start"});}}><ListMusic size={16}/> Chapters</button>}
              <button
                className="button subtle"
                onClick={() => {
                  setExpanded(false);
                  onBookDetails(p.book || b);
                }}
              >
                <BookOpen size={16} /> Title page
              </button>
              <button
                className="button subtle"
                onClick={() => {
                  setExpanded(false);
                  onManageSources(p.book || b);
                }}
              >
                <Layers size={16} /> Versions & sources
              </button>
              <KeyboardHelpButton />
            </div>
            </PlaybackExtra>
            {!hasReader && <div className="now-playing-art">
              <img src={(p.book || b).cover} alt={(p.book || b).title} />
            </div>}
            {!hasReader && <h2>{(p.book || b).title}</h2>}
            <PlaybackExtra><p className="now-playing-author">{(p.book || b).author}</p></PlaybackExtra>
            <PlaybackReader
              book={p.book || b}
              books={books}
              notify={notify}
              onAvailable={(available) => {
                setHasReader((prev) => available || (hasKnownReader(b?.workId) && prev));
              }}
              onClose={() => setExpanded(false)}
              onMissing={() => {
                setHasReader(false);
                setExpanded(false);
                onBookDetails(p.book || b);
              }}
            />
            <div className="now-playing-transport">
            <PlaybackExtra><div className="transport-info"><div className="chapter-playing">
              <Headphones size={14} />
              {p.track
                ? currentChapter(p.book || b, p.track.id, p.position)?.title ||
                  p.track.title
                : "Choose a chapter"}
            </div>
            <PlaybackSource />
            </div>
            </PlaybackExtra>
            <PlaybackTimeline book={p.book || b} />
            <div className="player-transport-row">
            {hasReader && <div className="player-transport-display"><button className="button subtle" onClick={() => {
              const order = ["book", "segment", "word"] as const;
              const current = (order as readonly string[]).includes(appearance.reader.display)
                ? appearance.reader.display as typeof order[number]
                : "book";
              void saveReader({ display: order[(order.indexOf(current) + 1) % order.length] }).catch(() => {});
            }}>{appearance.reader.display === "book" ? "Lyrics" : appearance.reader.display === "segment" ? "Word" : "Page"}</button></div>}
            <div className="transport large">
              <button
                className="seek-button"
                onClick={() => p.skip(-30)}
                aria-label="Rewind 30 seconds"
              >
                <RotateCcw size={30} />
                <span>30</span>
              </button>
              <button
                className="play-button"
                onClick={toggle}
                aria-label={p.playing ? "Pause" : "Play"}
              >
                {p.loading ? (
                  <Loader2 className="spin" />
                ) : p.playing ? (
                  <Pause size={25} fill="currentColor" />
                ) : (
                  <Play size={25} fill="currentColor" />
                )}
              </button>
              <button
                className="seek-button"
                onClick={() => p.skip(30)}
                aria-label="Forward 30 seconds"
              >
                <RotateCw size={30} />
                <span>30</span>
              </button>
            </div>
            <div className="player-transport-timer"><PlaybackOptions kind="sleep" /></div>
            </div>
            <PlaybackExtra><div className="full-options">
              <PlaybackOptions kind="speed" book={b} />
            </div></PlaybackExtra>
            </div>
            {/* Always laid out so its appearing never moves the controls below. */}
            <button
              type="button"
              className={`button subtle player-undo-jump${p.canUndoJump ? "" : " is-idle"}`}
              onClick={p.undoJump}
              disabled={!p.canUndoJump}
              tabIndex={p.canUndoJump ? undefined : -1}
              aria-hidden={p.canUndoJump ? undefined : true}
            >Undo jump</button>
            <PlaybackExtra>
            <details className="player-extra-options" open={!hasReader}><summary>Downloads</summary>
            <section
              className="player-device-download"
              aria-label="Device download"
            >
              <div>
                <HardDrive size={19} />
                <span>
                  <strong>
                    {saved ? "Ready on this device" : "Keep listening offline"}
                  </strong>
                  <small>
                    {saved
                      ? "This recording is saved for offline playback."
                      : downloadJob
                        ? `Chapter ${downloadJob.chapter} of ${downloadJob.total} · ${Math.round(downloadJob.progress)}%`
                        : partial
                          ? "Your saved download progress is ready to resume."
                          : "Save this recording to your phone or computer."}
                  </small>
                </span>
              </div>
              {downloadJob && (
                <progress
                  aria-label="Device download progress"
                  max={100}
                  value={downloadJob.progress}
                />
              )}
              <button
                className="button subtle"
                disabled={saved || !b.tracks.length}
                onClick={() =>
                  downloadJob ? onPauseDownload(b) : onDownload(b)
                }
              >
                {saved ? (
                  <Check size={15} />
                ) : downloadJob ? (
                  <Pause size={15} />
                ) : (
                  <Download size={15} />
                )}{" "}
                {saved
                  ? "Saved on device"
                  : downloadJob
                    ? "Pause download"
                    : partial
                      ? "Resume download"
                      : "Save on device"}
              </button>
              <button
                className="text-link"
                onClick={() => {
                  setExpanded(false);
                  onViewDownloads();
                }}
              >
                Manage device downloads
              </button>
              <button
                className="text-link"
                onClick={() => {
                  setExpanded(false);
                  onBookDetails(b);
                }}
              >
                Book details and editions
              </button>
            </section>
            </details>
            </PlaybackExtra>
            {p.error && (
              <p className="error-text" role="alert">
                {p.error}
              </p>
            )}
          </div>
          <PlaybackExtra><div className={`now-playing-chapters ${chaptersOpen ? "open" : ""}`}>
            <button className="icon-button close-reader-chapters" aria-label="Close chapters" onClick={()=>setChaptersOpen(false)}><X size={19}/></button>
            <h3>
              Chapters <span>{listeningChapters(p.book || b).length}</span>
            </h3>
            <Chapters book={p.book || b} onSelect={()=>{setChaptersOpen(false);setOptionsOpen(false);}}/>
          </div></PlaybackExtra>
        </div>
        </PlaybackMenuContext.Provider>
      </Dialog>
    </>
  );
}
export { PlaybackSource } from "./PlaybackSource";
export { PlaybackOptions } from "./PlaybackOptions";
