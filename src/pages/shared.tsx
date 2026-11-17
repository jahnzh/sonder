import type { ReactNode } from "react";
import { Library, Search, Play, Pause, Loader2 } from "lucide-react";
import { usePlayer } from "../player";
import { isAdmin } from "../lib";
import type { Book } from "../types";

/** The pages the shell switches between; the shell reads the address into one of these. */
export type Page = "library" | "discover" | "settings" | "activity";
export type Notify = (text: string, error?: boolean) => void;

export function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
export function ListenButton({
  onFindAudio,
  book,
  compact = false,
}: {
  book: Book;
  compact?: boolean;
  onFindAudio?: () => void;
}) {
  const p = usePlayer();
  const active = p.book?.id === book.id;
  if (!book.tracks.length && !isAdmin()) return null;
  if (!book.tracks.length)
    return (
      <button
        className={`button ${compact ? "subtle" : "primary"}`}
        onClick={onFindAudio}
      >
        <Search size={15} /> Find audio
      </button>
    );
  return (
    <button
      className={`button ${compact ? "subtle" : "primary"}`}
      onClick={() => (active ? p.toggle() : void p.play(book))}
    >
      {active && p.loading ? (
        <Loader2 size={16} className="spin" />
      ) : active && p.playing ? (
        <Pause size={16} fill="currentColor" />
      ) : (
        <Play size={15} fill="currentColor" />
      )}
      {active && p.playing
        ? "Pause"
        : book.progress
          ? "Continue listening"
          : "Start listening"}
    </button>
  );
}
export function Empty({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: typeof Library;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={27} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
