import type { ReaderBook } from "./reading-types";
export type ReaderWord = { text: string; paragraphId: string; section: number };
/** The words of every sentence of the book, in order, each with its sentence. */
export function readerWords(book: ReaderBook): ReaderWord[] {
  return book.sections.flatMap(section => section.paragraphs.flatMap(fragment =>
    fragment.text.trim().split(/\s+/u).filter(Boolean).map(text => ({text, paragraphId: fragment.id, section:section.index})),
  ));
}
