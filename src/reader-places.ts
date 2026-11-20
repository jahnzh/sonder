// Where a sentence is among all the sentences of a book the reader holds whole (today's reader, which gets every
// sentence from the server). The new view answers the same questions from the prepared manifest without the
// sentences (`sentenceIndex` in prepared-book.ts); the reader's head and foot ask either through this shape.
import type { ReaderSection } from "./reading-types";

export type SentencePlaces = {
  /** How many sentences the book has. */
  total: number;
  /** A sentence's place among all of them, from 0; -1 for one the book does not have. */
  ordinalOf(id: string | null | undefined): number;
  /** The sentence at a place; undefined outside the book. */
  idAt(ordinal: number): string | undefined;
  /** The index of the section (chapter file) that holds a sentence. */
  sectionOf(id: string | null | undefined): number | null;
  /** A section's sentences as a run of places. */
  sectionSpan(section: number): { start: number; count: number };
};

export function sentencePlaces(sections: readonly Pick<ReaderSection, "index" | "paragraphs">[]): SentencePlaces {
  const ids: string[] = [];
  const places = new Map<string, { ordinal: number; section: number }>();
  const spans = new Map<number, { start: number; count: number }>();
  for (const section of sections) {
    // The first section of an index is the one a search by index finds.
    if (!spans.has(section.index)) spans.set(section.index, { start: ids.length, count: section.paragraphs.length });
    for (const fragment of section.paragraphs) {
      if (!places.has(fragment.id)) places.set(fragment.id, { ordinal: ids.length, section: section.index });
      ids.push(fragment.id);
    }
  }
  return {
    total: ids.length,
    ordinalOf: (id) => (id ? places.get(id)?.ordinal ?? -1 : -1),
    idAt: (ordinal) => ids[ordinal],
    sectionOf: (id) => (id ? places.get(id)?.section ?? null : null),
    sectionSpan: (section) => spans.get(section) ?? { start: 0, count: 0 },
  };
}
