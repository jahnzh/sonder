import type { ReaderBook } from "./reading-types";

export type LyricsLine = { text: string; paragraphId: string; fraction: number; paragraphStart: boolean };

const abbreviations = new Set([
  "mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "mt", "rev", "gen", "col", "capt", "lt", "sgt", "vs",
  "e.g", "i.e", "p.m", "a.m", "u.s", "u.k", "u.n", "e.u", "u.s.a", "a.d", "b.c",
]);

/** Splits at sentence ends followed by a space. Keeps leading punctuation
 * ("...Wait") with its sentence and does not break decimals ("3.5"),
 * common single or multi-period abbreviations ("Mr.", "p.m.", "U.S.") or initials ("J. R."). */
export function sentences(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?]+[\u201d\u2019"')\]]*(?=\s|$)/gu)) {
    const end = match.index + match[0].length;
    const piece = text.slice(start, end);
    if (!/[\p{L}\p{N}]/u.test(piece)) continue;
    if (match[0] === ".") {
      const word = (/\S+$/u.exec(text.slice(start, match.index))?.[0] || "").replace(/^[^\p{L}]+/u, "");
      if (abbreviations.has(word.toLowerCase()) || (/^\p{Lu}$/u.test(word) && word !== "I")) continue;
    }
    result.push(piece.trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) result.push(rest);
  return result;
}

/** The alignment fragments carry sentence-level timings. Preserve their IDs when
 * breaking longer sentences into readable lines so seeking stays mapped. */
export function lyricsLines(book: ReaderBook): LyricsLine[] {
  const result: LyricsLine[] = [];
  for (const section of book.sections) {
    let previousBlock = -1;
    for (const fragment of section.paragraphs) {
      const text = fragment.text.trim();
      if (!text) continue;
      const pieces = sentences(text).flatMap(sentence => {
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

