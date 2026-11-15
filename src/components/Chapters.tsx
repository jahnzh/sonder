import { Download, Volume2 } from "lucide-react";
import type { Book, Download as DownloadRecord } from "../types";
import { useBookSpeed, usePlayer } from "../player";
import { listeningChapters, currentChapter, chapterRowTime } from "../chapters";
import { clock } from "../lib";
export function Chapters({
  book,
  downloads = [],
  onSelect,
}: {
  book: Book;
  downloads?: DownloadRecord[];
  onSelect?:()=>void;
}) {
  const p = usePlayer();
  const speed = useBookSpeed(book);
  const loaded = p.book?.id === book.id;
  const selected =
    loaded && p.track
      ? currentChapter(book, p.track.id, p.position)
      : undefined;
  return (
    <div className="chapter-list">
      {listeningChapters(book).map((c, index) => {
        const active =
          selected?.track.id === c.track.id && selected?.start === c.start;
        const time = chapterRowTime(c, active ? p.position : null, speed);
        return (
          <button
            key={`${c.track.id}-${c.start}`}
            className={`chapter-row ${active ? "selected" : ""}`}
            onClick={() => { void p.play(book, c.track, c.start, { kind: "chapter" }); onSelect?.(); }}
          >
            <span className="chapter-index">
              {active && p.playing ? (
                <Volume2 size={14} />
              ) : (
                String(index + 1).padStart(2, "0")
              )}
            </span>
            <span>{c.title}</span>
            {downloads.some((d) => d.trackId === c.track.id) && (
              <Download size={12} />
            )}
            <small title={time.title}>
              {time.left && "−"}
              {clock(time.seconds)}
            </small>
          </button>
        );
      })}
    </div>
  );
}
