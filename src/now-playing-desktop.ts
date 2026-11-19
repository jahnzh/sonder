// Now playing on a desktop (#595, spec #586 "Desktop"; boards DesktopReader.dc.html, DesktopNowPlaying.dc.html): from
// 760 px (plan 0.1) Read has the contents beside the text, the page arrows in the margins and the player as its
// footer; Listen keeps the same head and footer with Chapters beside on the left and the cover and the rows in the
// middle. A page module: the server imports none of it.
import { useEffect, useState } from "react";

/** The width from which both faces use the desktop's layout; the CSS (reader.css, now-playing.css) uses the same. */
export const DESKTOP_MIN_WIDTH = 760;
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

/** Whether the window is a desktop's, kept up to date as it is resized. */
export function useDesktop() {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const change = () => setDesktop(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return desktop;
}

/**
 * Listen's line under the author on a desktop: "Letter 1 · 4 min left in the chapter". The minutes are whole and
 * rounded up, so a chapter with seconds left never says 0; without a chapter there is no line, without a time left
 * the chapter alone.
 */
export function listenChapterLine(chapter: string, secondsLeft: number | null) {
  const title = chapter.trim();
  if (!title) return "";
  if (secondsLeft === null || !Number.isFinite(secondsLeft)) return title;
  const minutes = Math.max(1, Math.ceil(Math.max(0, secondsLeft) / 60));
  return `${title} · ${minutes} min left in the chapter`;
}

/**
 * Where each of Listen's controls is, on a phone and on a desktop: on a desktop the transport and the timeline are
 * the footer, Chapters is the list beside on the left, and Speed and the sleep timer are rows only, so each control
 * is in one place (spec #586: "On desktop Listen, Speed and the sleep timer are rows and not in the footer").
 */
export type ListenPlace = "middle" | "rows" | "footer" | "beside";
export type ListenControl = "timeline" | "transport" | "speed" | "sleep" | "chapters" | "plays-from" | "earlier" | "keep";
export function listenPlaces(desktop: boolean): Record<ListenControl, ListenPlace> {
  return {
    timeline: desktop ? "footer" : "middle",
    transport: desktop ? "footer" : "middle",
    speed: "rows",
    sleep: "rows",
    chapters: desktop ? "beside" : "rows",
    "plays-from": "rows",
    earlier: "rows",
    keep: "rows",
  };
}
