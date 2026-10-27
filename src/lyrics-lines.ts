import type { ReaderBook } from "./reading-types";

export type LyricsLine = { text: string; paragraphId: string; fraction: number; paragraphStart: boolean };

/** The alignment fragments carry sentence-level timings. Preserve their IDs when
 * breaking longer sentences into readable lines so seeking stays mapped. */
export function lyricsLines(book: ReaderBook): LyricsLine[] {
  const result: LyricsLine[] = [];
  for (const section of book.sections) {
    let previousBlock = -1;
    for (const fragment of section.paragraphs) {
      const text = fragment.text.trim();
      if (!text) continue;
      const sentences = text.match(/[^.!?]+(?:[.!?]+[\u201d\u2019"']*|$)/gu) || [text];
      const pieces = sentences.flatMap(sentence => {
        const clean = sentence.trim();
        if (clean.split(/\s+/u).length <= 22) return [clean];
        const clauses = clean.match(/[^,;]+[,;]?/gu)?.map(part => part.trim()).filter(Boolean) || [clean];
        const lines: string[] = [];
        for (const clause of clauses) {
          const last = lines.length - 1;
          if (last >= 0 && `${lines[last]} ${clause}`.split(/\s+/u).length <= 22) lines[last] += ` ${clause}`;
          else lines.push(clause);
        }
        return lines;
      }).filter(Boolean);
      const total = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
      let offset = 0;
      pieces.forEach((piece, index) => {
        result.push({ text: piece, paragraphId: fragment.id, fraction: offset / total, paragraphStart: index === 0 && fragment.blockIndex !== previousBlock });
        offset += piece.length;
      });
      previousBlock = fragment.blockIndex;
    }
  }
  return result;
}

