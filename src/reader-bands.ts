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
