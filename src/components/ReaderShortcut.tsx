import { useState } from "react";
import { BookOpen, Loader2 } from "lucide-react";
import { api, isAdmin } from "../lib";
import { openReader } from "../reading";
import { usePlayer } from "../player";
import { chosenEbook } from "../ebook-choice";
import { deviceEbookChoice } from "../ebook-device-copy";
import { useStoredWorks } from "../library-works-store";
import type { Book, LibraryWork } from "../types";

/**
 * Read: opens the work's chosen EPUB (src/ebook-choice.ts, the edition the Ebook page ticks) without asking which
 * one (#531). Without an EPUB it closes and, for the administrator, opens today's ebook search.
 */
export function ReaderShortcut({
  book,
  compact = false,
  onOpen,
  onMissing,
  playback = false,
}: {
  book: Book;
  compact?: boolean;
  onOpen: () => void;
  onMissing: () => void;
  playback?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const p = usePlayer();
  const stored = useStoredWorks().find((work) => work.workId === book.workId) ?? null;
  const read = (ebookId: string) => {
    onOpen();
    if (playback || p.book?.recordingId === book.recordingId)
      window.dispatchEvent(new CustomEvent("sonder:playback-reader", { detail: { id: ebookId, workId: book.workId } }));
    else openReader(ebookId);
  };
  const open = async () => {
    setLoading(true);
    try {
      // The work as the server has it now (an edition added a moment ago counts); without a connection, the
      // library's stored work.
      const work = (await api<LibraryWork>(`/works/${encodeURIComponent(book.workId)}`).catch(() => null)) ?? stored;
      const chosen = work ? chosenEbook(work, deviceEbookChoice(book.workId)) : null;
      if (chosen) read(chosen.id);
      else {
        onOpen();
        if (isAdmin()) onMissing();
      }
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className={`reader-shortcut ${compact ? "dock-reader-shortcut" : ""}`}>
      <button
        className={compact ? "icon-button" : "button subtle"}
        aria-label={compact ? "Open ebook reader" : undefined}
        title="Open ebook reader"
        disabled={loading}
        onClick={() => void open()}
      >
        {loading ? <Loader2 size={19} className="spin" /> : <BookOpen size={19} />} {!compact && "Read ebook"}
      </button>
    </div>
  );
}
