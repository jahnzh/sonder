// The words of the reader's head and foot at rest (#587, spec #586 "The reader's page"): the head names the book
// and the chapter, the foot's lower row says where the narration is in its chapter, or with no narration of this
// book in the player, where the page is in the book.

/** Whole minutes, rounded up, so a chapter with seconds left never says "0 min left". */
export function minutesLeft(seconds: number) {
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 0;
}

/** "Book · Chapter", or whichever of the two is known. */
export function headRestLine(book: string | undefined, chapter: string | undefined) {
  return [book, chapter].map((part) => part?.trim()).filter(Boolean).join(" · ");
}

/**
 * The foot's lower row at rest: "Chapter · N min left" with this book's narration in the player (the time left at the
 * speed it plays at), else "Chapter · N% of the book".
 */
export function footRestLine(
  chapter: string | undefined,
  place: { secondsLeft: number } | { fraction: number },
) {
  const where =
    "secondsLeft" in place
      ? `${minutesLeft(place.secondsLeft)} min left`
      : `${Math.round(Math.min(1, Math.max(0, Number.isFinite(place.fraction) ? place.fraction : 0)) * 100)}% of the book`;
  return headRestLine(chapter, where);
}

/** A control of the foot: at rest, or in the row shown with the controls. */
export type FootControl = "pause" | "chapters" | "back-to-narration" | "transport" | "sleep-timer" | "speed" | "position";

/**
 * What the foot holds (#594, spec #586 "A book without a recording", ReaderEbookOnly.dc.html). A work with a
 * recording: Pause at rest; with the controls shown Chapters, Back to narration, the transport, the sleep timer and
 * Speed under the timeline. A work without one (an ebook-only book, #555) has no narration to hold: at rest the
 * progress line and the place in the book only, no Pause; with the controls shown Chapters and the position slider,
 * "Position in the book". No Back to narration, transport, Speed or Sleep timer.
 */
export function footControls(recording: boolean): { rest: FootControl[]; shown: FootControl[] } {
  return recording
    ? { rest: ["pause"], shown: ["chapters", "back-to-narration", "transport", "sleep-timer", "speed"] }
    : { rest: [], shown: ["chapters", "position"] };
}

/**
 * The foot's line with the controls shown for a work without a recording: the chapter, and "N% of the book" for the
 * page's place in the whole book (the slider beside Chapters moves through the whole book too).
 */
export function ebookOnlyFootLine(chapter: string | undefined, fraction: number) {
  return { chapter: chapter?.trim() ?? "", place: footRestLine(undefined, { fraction }) };
}
