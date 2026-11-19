// The reader and its pages (#590): Chapters, Bookmarks and Search are pages of their own (`#book/<workId>/chapters`,
// `/bookmarks`, `/search`), not panels over the text. The reader that opened a page stays mounted under it; this
// module is what the two share: the reader publishes what the pages list, and a page asks that reader (or the reader
// it opens, after a link straight to the page) to show a place, paged away. No React state lives here.
import { useSyncExternalStore } from "react";
import type { ReaderBook, ReaderSection } from "./reading-types";

export type ReaderPage = "chapters" | "bookmarks" | "search";
export const READER_PAGES: readonly ReaderPage[] = ["chapters", "bookmarks", "search"];
export const isReaderPage = (page: string): page is ReaderPage => (READER_PAGES as readonly string[]).includes(page);

/** Where a page sends the reader: a section's start (a Chapters row) or a sentence (a result, a bookmark). */
export type ReaderPlace =
  | { kind: "section"; section: number; href: string }
  | { kind: "sentence"; paragraphId: string; from: "search" | "bookmark" };

export type Bookmark = ReaderBook["bookmarks"][number];

/** The reader as its pages see it. Published by the reader that is mounted; replaced whenever it changes. */
export type LiveReader = {
  ebookId: string;
  workId: string;
  /** Which reader: the one in Now playing's Read face, the only one since the reader on its own went (#613 part 2). */
  host: "now-playing";
  title: string;
  sections: readonly ReaderSection[];
  bookmarks: readonly Bookmark[];
  /** The section the page shows, and the one the narration is in with the time left of its chapter. */
  shownSection: number | null;
  narrated: { section: number; secondsLeft: number } | null;
  removeBookmark: (bookmark: Bookmark) => void;
  /** Shows the reader again with an entry of its own, so Back returns to the page. */
  show: () => void;
};

let opener: LiveReader | null = null;
const live = new Map<string, LiveReader>();
const places = new Map<string, { host: LiveReader["host"]; place: ReaderPlace }>();
const listeners = new Set<() => void>();
const placeListeners = new Set<() => void>();
const keyOf = (reader: Pick<LiveReader, "ebookId" | "host">) => `${reader.host}:${reader.ebookId}`;
const emit = () => {
  for (const listener of listeners) listener();
};

/** The reader publishes itself while it is mounted; null takes it away. */
export function publishReader(key: Pick<LiveReader, "ebookId" | "host">, reader: LiveReader | null) {
  const id = keyOf(key);
  if (reader) live.set(id, reader);
  else live.delete(id);
  if (opener && keyOf(opener) === id) opener = reader;
  emit();
}

/** A reader's head or foot opens one of its pages: that reader is the one the page lists and sends back. */
export function openedFrom(reader: Pick<LiveReader, "ebookId" | "host">) {
  opener = live.get(keyOf(reader)) ?? null;
  listenOpener = null;
  emit();
}

/**
 * Now playing's Listen face opens Chapters (#593, spec #586 "Chapters, Bookmarks and Search as pages"): the page lists
 * the recording's chapters, not the ebook's sections. The page takes this once, as it opens, and keeps it in its entry.
 */
let listenOpener: string | null = null;
export function openedFromListen(workId: string) {
  opener = null;
  listenOpener = workId;
  emit();
}
/** Whether the page of this work that is opening was opened from Listen; forgotten as it is taken. */
export function takeListenOpener(workId: string): boolean {
  const from = listenOpener === workId;
  listenOpener = null;
  return from;
}

/** The reader a page of this work was opened from, while it is still mounted. */
export function openerOf(workId: string): LiveReader | null {
  return opener && opener.workId === workId && live.get(keyOf(opener)) === opener ? opener : null;
}

/** Forgets the opener: a page reached some other way (a link, a reload) lists the book itself. */
export function forgetOpener() {
  listenOpener = null;
  if (!opener) return;
  opener = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** The opener of a page of this work, for a screen. */
export function useOpener(workId: string): LiveReader | null {
  return useSyncExternalStore(subscribe, () => openerOf(workId));
}
/** The reader any page was last opened from, while mounted: the reader on its own stays mounted under it. */
export function useOpenerAny(): LiveReader | null {
  return useSyncExternalStore(subscribe, () => opener);
}

/** A page asks a reader to show a place. The reader takes it as soon as it has its pages laid out. */
export function requestPlace(ebookId: string, host: LiveReader["host"], place: ReaderPlace) {
  places.set(`${host}:${ebookId}`, { host, place });
  for (const listener of placeListeners) listener();
}
/** The place asked of this reader, once: it is forgotten as it is taken. */
export function takePlace(reader: Pick<LiveReader, "ebookId" | "host">): ReaderPlace | null {
  const id = keyOf(reader);
  const asked = places.get(id);
  if (!asked) return null;
  places.delete(id);
  return asked.place;
}
export function onPlaceRequested(listener: () => void) {
  placeListeners.add(listener);
  return () => {
    placeListeners.delete(listener);
  };
}

const DAY_MONTH: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
const DAY_MONTH_YEAR: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
/** A bookmark's line under its sentence: its chapter and the day it was saved ("Letter 1 · 14 Nov"); the year when not this one. */
export function bookmarkLine(chapter: string | undefined, createdAt: number | undefined, now = Date.now()) {
  const parts: string[] = [];
  if (chapter?.trim()) parts.push(chapter.trim());
  if (typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0) {
    const day = new Date(createdAt);
    const sameYear = day.getFullYear() === new Date(now).getFullYear();
    parts.push(day.toLocaleDateString("en-GB", sameYear ? DAY_MONTH : DAY_MONTH_YEAR));
  }
  return parts.join(" · ");
}

/** The marked Chapters row's value: "Now · 4 min left". */
export function narratedLine(minutes: number) {
  return `Now · ${minutes} min left`;
}

/** The section a sentence is in. */
export function sectionOfSentence<T extends Pick<ReaderSection, "paragraphs">>(sections: readonly T[], paragraphId: string) {
  return sections.find((section) => section.paragraphs.some((fragment) => fragment.id === paragraphId));
}
