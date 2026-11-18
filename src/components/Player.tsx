import { useEffect } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  ListMusic,
  Maximize2,
  ChevronDown,
  Loader2,
  Check,
  Download,
  Layers,
} from "lucide-react";
import { usePlayer } from "../player";
import { PlaybackSource } from "./PlaybackSource";
import { PlaybackTimeline } from "./PlaybackTimeline";
import { currentChapter } from "../chapters";
import { warmPlaybackReading } from "../reading";
import { useOpenNowPlaying } from "../pages/now-playing";
import type { Book } from "../types";
// The mini player (S13 draws its look). It opens Now playing (#593) on its face rule: `#listen/<workId>` or
// `#read/<workId>`, an entry of its own that Back closes.
export function PlayerDock({
  fallback,
  isDownloaded,
  hasPartialDownload,
  downloadJobs,
  onDownload,
  onPauseDownload,
  onBookDetails,
  onManageSources,
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
  onBookDetails: (book: Book) => void;
  onManageSources: (book: Book) => void;
}) {
  const p = usePlayer();
  const b = p.book || fallback;
  const openNowPlaying = useOpenNowPlaying(b?.workId);
  useEffect(() => {
    if (!b?.workId) return;
    const cancel = warmPlaybackReading(b.workId, b.recordingId);
    return () => {
      cancel?.();
    };
  }, [b?.workId, b?.recordingId]);
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
            onClick={openNowPlaying}
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
            aria-label="Audiobook"
            title="Audiobook"
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
          <button
            className="icon-button"
            aria-label="Chapters and now playing"
            onClick={openNowPlaying}
          >
            <ListMusic size={20} />
          </button>
          <button
            className="icon-button expand-player"
            aria-label="Expand player"
            onClick={openNowPlaying}
          >
            <Maximize2 size={17} />
          </button>
        </div>
      </div>
      {p.error && (
        <div className="player-error" role="alert">
          {p.error}
        </div>
      )}
    </>
  );
}
export { PlaybackSource } from "./PlaybackSource";
