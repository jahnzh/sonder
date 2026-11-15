import { isAdmin } from "../lib";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AlignmentInterval, ReaderBook } from "../reading-types";
import "../lyrics-reader.css";

import { lyricsLines } from "../lyrics-lines";
import { activeLine, extendWindow, firstLines, windowAround, windowFor, type LyricsWindow } from "../lyrics-window";

export function LyricsReader({ book, interval, position, hasMap, follow, onSeek, onManualScroll, onPrepareSync, size, selectedParagraph, ignoreKeys, onToggleControls, onClose }: {
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
  /** A reader panel or sheet is open over the lines. */
  ignoreKeys?: boolean;
  onToggleControls: () => void;
  onClose: () => void;
}) {
  const lines = useMemo(() => lyricsLines(book), [book.fingerprint]);
  const host = useRef<HTMLDivElement>(null);
  const fraction = interval ? Math.max(0, Math.min(1, (position - interval.start) / Math.max(.001, interval.end - interval.start))) : 0;
  const first = useMemo(() => firstLines(lines), [lines]);
  const active = activeLine(lines, first, interval?.paragraphId, fraction);
  const selectedIndex = selectedParagraph ? first.get(selectedParagraph) ?? -1 : -1;
  // Only a window of lines around the narrated or chosen one is rendered (#428): a long book has 18,000 sentences.
  // Following keeps the narrated line in the window; a page chosen while not following (search, bookmark, Contents,
  // the page view) places it around that line; scrolling by hand towards an edge adds lines there.
  const anchor = follow && active >= 0 ? active : !follow && selectedIndex >= 0 ? selectedIndex : -1;
  const [shown, setShown] = useState<{ lines: typeof lines; window: LyricsWindow; anchor: number }>(() => ({ lines, window: windowAround(Math.max(0, anchor), lines.length), anchor }));
  // A line on screen and its distance from the top of the box before the window changes, so the lines that stay do
  // not move when lines are added or removed above them.
  const keep = useRef<{ index: number; offset: number } | null>(null);
  const visibleLine = () => {
    const box = host.current;
    if (!box) return null;
    for (const line of box.querySelectorAll<HTMLElement>("[data-line-index]"))
      if (line.offsetTop + line.offsetHeight > box.scrollTop) return { index: Number(line.dataset.lineIndex), offset: line.offsetTop - box.scrollTop };
    return null;
  };
  let range = shown.window;
  if (shown.lines !== lines) range = windowAround(Math.max(0, anchor), lines.length);
  else if (anchor >= 0 && anchor !== shown.anchor) range = windowFor(range, anchor, lines.length);
  if (shown.lines !== lines || range !== shown.window || anchor !== shown.anchor) {
    // Read before React replaces the lines: the page still shows the previous window.
    if (range !== shown.window) keep.current = visibleLine();
    setShown({ lines, window: range, anchor });
  }
  useLayoutEffect(() => {
    const box = host.current, kept = keep.current;
    keep.current = null;
    if (!box || !kept) return;
    const line = box.querySelector<HTMLElement>(`[data-line-index="${kept.index}"]`);
    // Browsers with scroll anchoring have already kept it in place.
    if (line && Math.abs(box.scrollTop - (line.offsetTop - kept.offset)) > 1) box.scrollTop = line.offsetTop - kept.offset;
  }, [shown.window]);
  // Lines are added only while no follow scroll can be under way: moving the content under a smooth scroll would
  // stop it short of the current line in browsers without scroll anchoring.
  const extend = () => {
    const box = host.current;
    if (!box || (follow && active >= 0)) return;
    const room = box.clientHeight * 1.5;
    const edge = shown.window.from > 0 && box.scrollTop < room ? "start"
      : shown.window.to < lines.length && box.scrollHeight - box.scrollTop - box.clientHeight < room ? "end" : null;
    if (!edge) return;
    keep.current = visibleLine();
    setShown(current => ({ ...current, window: extendWindow(current.window, edge, lines.length) }));
  };
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
    const line = host.current.querySelector<HTMLElement>(`[data-line-index="${selectedIndex}"]`);
    if (line) host.current.scrollTop = line.offsetTop - host.current.offsetTop - host.current.clientHeight * .3;
  }, [selectedParagraph, follow, lines]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || !hasMap || ignoreKeys) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if ((event.target as HTMLElement)?.closest("input,select,textarea") || host.current?.closest('[data-state="closed"]')) return;
      // Without a current line there is nothing to step from; seeking would
      // replace the listening position with the start of the book.
      if (active < 0) return;
      const line = lines[Math.max(0, Math.min(lines.length - 1, active + (event.key === "ArrowUp" ? -1 : 1)))];
      if (!line) return;
      event.preventDefault();
      onSeek(line.paragraphId, line.fraction);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, lines, hasMap, ignoreKeys, onSeek]);
  // Kept in a ref: the reader re-renders on every playback tick, which would
  // reset a plain variable between touchstart and touchend.
  const touchStart = useRef<{x:number;y:number} | null>(null);
  return <div className="lyrics-reader" ref={host} aria-label="Lyrics reader" onScroll={extend} onWheel={onManualScroll} onTouchStart={event=>{const touch=event.touches[0]; const top=host.current?.getBoundingClientRect().top || 0; touchStart.current={x:touch.clientX,y:touch.clientY-top};}} onTouchEnd={event=>{const touch=event.changedTouches[0], start=touchStart.current, top=host.current?.getBoundingClientRect().top || 0; if(start && start.y<60 && touch.clientY-top-start.y>80 && Math.abs(touch.clientX-start.x)<60) onClose(); touchStart.current=null;}} onTouchMove={event=>{const touch=event.touches[0], start=touchStart.current, top=host.current?.getBoundingClientRect().top || 0; if(start && Math.hypot(touch.clientX-start.x,touch.clientY-top-start.y)>10) onManualScroll();}} onClick={event=>{if (!(event.target as HTMLElement).closest("button")) onToggleControls();}} style={{ "--lyrics-size-factor": size / 19 } as React.CSSProperties}>
    <div className="lyrics-reader-content">
      {!hasMap && isAdmin() && range.from === 0 && <p className="lyrics-sync-prompt">Prepare reading sync to follow the narration. <button type="button" onClick={onPrepareSync}>Prepare reading sync</button></p>}
      {lines.slice(range.from, range.to).map((line, offset) => { const index = range.from + offset; return <button type="button" key={`${line.paragraphId}:${index}`} data-line-index={index} className={`lyrics-line ${line.paragraphStart ? "paragraph-start" : ""} ${active < 0 ? "unmapped" : index === active ? "current" : index < active ? "past" : "upcoming"}`} onClick={() => onSeek(line.paragraphId, line.fraction)}>{line.text}</button>; })}
      {!lines.length && <p>No readable text in this ebook.</p>}
    </div>
  </div>;
}
