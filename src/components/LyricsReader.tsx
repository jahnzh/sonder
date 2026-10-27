import { isAdmin } from "../lib";
import { useEffect, useMemo, useRef } from "react";
import type { AlignmentInterval, ReaderBook } from "../reading-types";
import "../lyrics-reader.css";

import { lyricsLines } from "../lyrics-lines";

export function LyricsReader({ book, interval, position, hasMap, follow, onSeek, onManualScroll, onPrepareSync, size, selectedParagraph, onToggleControls, onClose }: {
  book: ReaderBook;
  interval?: AlignmentInterval;
  position: number;
  hasMap: boolean;
  follow: boolean;
  onSeek: (paragraphId: string, fraction: number) => void;
  onManualScroll: () => void;
  onPrepareSync: () => void;
  /** Existing text-size preference, with 19px as the normal size. */
  size: number;
  selectedParagraph?: string;
  onToggleControls: () => void;
  onClose: () => void;
}) {
  const lines = useMemo(() => lyricsLines(book), [book.fingerprint]);
  const host = useRef<HTMLDivElement>(null);
  const fraction = interval ? Math.max(0, Math.min(1, (position - interval.start) / Math.max(.001, interval.end - interval.start))) : 0;
  let active = -1;
  if (interval) {
    lines.forEach((line, index) => {
      if (line.paragraphId === interval.paragraphId && line.fraction <= fraction) active = index;
    });
  }
  const scrollToActive = (behavior: ScrollBehavior) => {
    if (!follow || active < 0 || !host.current) return;
    const line = host.current.querySelector<HTMLElement>(`[data-line-index="${active}"]`);
    if (line) host.current.scrollTo({ top: line.offsetTop - host.current.offsetTop - host.current.clientHeight * .3, behavior });
  };
  useEffect(() => scrollToActive("smooth"), [active, follow]);
  // Line wrapping changes with the width; keep the current line in place.
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(() => scrollToActive("instant"));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [active, follow]);
  useEffect(() => {
    if (follow || !selectedParagraph || !host.current) return;
    const index = lines.findIndex(line => line.paragraphId === selectedParagraph);
    const line = host.current.querySelector<HTMLElement>(`[data-line-index="${index}"]`);
    if (line) host.current.scrollTop = line.offsetTop - host.current.offsetTop - host.current.clientHeight * .3;
  }, [selectedParagraph, follow, lines]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || !hasMap) return;
      if ((event.target as HTMLElement)?.closest("input,select,textarea") || host.current?.closest('[data-state="closed"]')) return;
      const line = lines[Math.max(0, Math.min(lines.length - 1, Math.max(0, active) + (event.key === "ArrowUp" ? -1 : 1)))];
      if (!line) return;
      event.preventDefault();
      onSeek(line.paragraphId, line.fraction);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, lines, hasMap, onSeek]);
  // Kept in a ref: the reader re-renders on every playback tick, which would
  // reset a plain variable between touchstart and touchend.
  const touchStart = useRef<{x:number;y:number} | null>(null);
  return <div className="lyrics-reader" ref={host} aria-label="Lyrics reader" onWheel={onManualScroll} onTouchStart={event=>{const touch=event.touches[0]; const top=host.current?.getBoundingClientRect().top || 0; touchStart.current={x:touch.clientX,y:touch.clientY-top};}} onTouchEnd={event=>{const touch=event.changedTouches[0], start=touchStart.current, top=host.current?.getBoundingClientRect().top || 0; if(start && start.y<60 && touch.clientY-top-start.y>80 && Math.abs(touch.clientX-start.x)<60) onClose(); touchStart.current=null;}} onTouchMove={event=>{const touch=event.touches[0], start=touchStart.current, top=host.current?.getBoundingClientRect().top || 0; if(start && Math.hypot(touch.clientX-start.x,touch.clientY-top-start.y)>10) onManualScroll();}} onClick={event=>{if (!(event.target as HTMLElement).closest("button")) onToggleControls();}} style={{ "--lyrics-size-factor": size / 19 } as React.CSSProperties}>
    <div className="lyrics-reader-content">
      {!hasMap && isAdmin() && <p className="lyrics-sync-prompt">Prepare reading sync to follow the narration. <button type="button" onClick={onPrepareSync}>Prepare reading sync</button></p>}
      {lines.map((line, index) => <button type="button" key={`${line.paragraphId}:${index}`} data-line-index={index} className={`lyrics-line ${line.paragraphStart ? "paragraph-start" : ""} ${active < 0 ? "unmapped" : index === active ? "current" : index < active ? "past" : "upcoming"}`} onClick={() => onSeek(line.paragraphId, line.fraction)}>{line.text}</button>)}
      {!lines.length && <p>No readable text in this ebook.</p>}
    </div>
  </div>;
}
