import { userStorageKey } from "../lib";
import { useState } from "react";
import { BookOpen, Loader2 } from "lucide-react";
import { api, localDB, bytes, isAdmin } from "../lib";
import { openReader } from "../reading";
import { usePlayer } from "../player";
import type { Book, SavedEbook } from "../types";
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
  const [loading, setLoading] = useState(false),
    [choices, setChoices] = useState<SavedEbook[]>([]);
  const p = usePlayer();
  const read = (ebook: SavedEbook) => {
    localStorage.setItem(userStorageKey(`reader-ebook:${book.workId}`), ebook.id);
    setChoices([]);
    onOpen();
    if (playback || p.book?.recordingId === book.recordingId)
      window.dispatchEvent(new CustomEvent("sonder:playback-reader",{detail:{id:ebook.id,workId:book.workId}}));
    else openReader(ebook.id);
  };
  const open = async () => {
    setLoading(true);
    try {
      const all = await api<SavedEbook[]>("/ebooks").catch(
        async () =>
          ((await localDB.preferences.get("ebooks"))?.value ||
            []) as SavedEbook[],
      );
      const ebooks = all.filter(
        (ebook) =>
          ebook.workId === book.workId &&
          ebook.format === "epub" &&
          ebook.available,
      );
      const preferred = ebooks.find(
        (ebook) =>
          ebook.id === localStorage.getItem(userStorageKey(`reader-ebook:${book.workId}`)),
      );
      if (preferred || ebooks.length === 1) read(preferred || ebooks[0]);
      else if (ebooks.length) setChoices(ebooks);
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
        {loading ? (
          <Loader2 size={19} className="spin" />
        ) : (
          <BookOpen size={19} />
        )}{" "}
        {!compact && "Read ebook"}
      </button>
      {choices.length > 0 && (
        <>
          <button
            className="menu-backdrop"
            aria-label="Close ebook choices"
            onClick={() => setChoices([])}
          />
          <div
            className="reader-shortcut-menu"
            role="group"
            aria-label="Ebook editions"
          >
            <strong>Choose a reading edition</strong>
            {choices.map((ebook, index) => (
              <button key={ebook.id} onClick={() => read(ebook)}>
                <span>{ebook.title}</span>
                <small>
                  {ebook.id.startsWith("upload-")
                    ? "Imported EPUB"
                    : ebook.id.startsWith("libgen-")
                      ? "Library Genesis EPUB"
                      : `EPUB edition ${index + 1}`}{" "}
                  · {bytes(ebook.size)}
                </small>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
