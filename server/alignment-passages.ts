import type { AlignmentInterval, ReaderBook, UnsyncedPassage } from "../src/reading-types.ts";

/** Describe every maximal run of unmapped sentences within a section. */
export function unsyncedPassages(book: Pick<ReaderBook, "sections">, intervals: AlignmentInterval[]): UnsyncedPassage[] {
  const mapped = new Set(intervals.map((interval) => interval.paragraphId));
  const passages: UnsyncedPassage[] = [];
  for (const section of book.sections) {
    let current: UnsyncedPassage | undefined;
    for (const paragraph of section.paragraphs) {
      if (mapped.has(paragraph.id)) {
        current = undefined;
        continue;
      }
      if (current) {
        current.lastParagraphId = paragraph.id;
        current.sentenceCount++;
      } else {
        current = {
          section: section.index,
          title: section.title,
          firstParagraphId: paragraph.id,
          lastParagraphId: paragraph.id,
          sentenceCount: 1,
          excerpt: paragraph.text.slice(0, 120),
        };
        passages.push(current);
      }
    }
  }
  return passages;
}
