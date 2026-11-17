import { readerTextOffset } from "./reading-types";

// The lookup from an offset in a block's normalised text (a sentence's start or end) to a place in
// the page (#507). The block is walked once into `parts`; a place is then found by binary search
// over the length of raw text, because the normalised length of a prefix never decreases as the
// prefix grows. The places are the ones the earlier per-character walk found.

/** A text node or a line break of a block, in order, with the offset of its first character in `raw`. */
export type LookupPart<N> = { node: N; start: number; isBreak: boolean };
export type LookupPlace<N> = { node: N; offset: number };
export type LookupIndex<N> = {
  /** The block's text as the server reads it: its text nodes, and "\n" for each line break. */
  raw: string;
  parts: LookupPart<N>[];
  /** Where a target past the block's text goes: the end of its last text node, or of the block. */
  end: LookupPlace<N>;
};

export function lookupIndex<N>(
  items: Iterable<{ node: N; isBreak: boolean; text: string }>,
  block: { node: N; childCount: number },
): LookupIndex<N> {
  const parts: LookupPart<N>[] = [];
  let raw = "",
    end: LookupPlace<N> = { node: block.node, offset: block.childCount };
  for (const item of items) {
    const text = item.isBreak ? "\n" : item.text;
    parts.push({ node: item.node, start: raw.length, isBreak: item.isBreak });
    if (!item.isBreak) end = { node: item.node, offset: text.length };
    raw += text;
  }
  return { raw, parts, end };
}

// The first text node at or after part `from`, at its start; the block's end if there is none.
function textFrom<N>(index: LookupIndex<N>, from: number): LookupPlace<N> {
  for (let i = from; i < index.parts.length; i++)
    if (!index.parts[i].isBreak) return { node: index.parts[i].node, offset: 0 };
  return index.end;
}

/** The place in the page where normalised offset `target` of the block falls. */
export function placeAt<N>(index: LookupIndex<N>, target: number): LookupPlace<N> {
  const { raw, parts } = index;
  if (readerTextOffset(raw) < target) return index.end;
  // The shortest raw prefix whose normalised length reaches the target.
  let lo = 0,
    hi = raw.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (readerTextOffset(raw.slice(0, mid)) >= target) hi = mid;
    else lo = mid + 1;
  }
  if (lo === 0) return textFrom(index, 0);
  // The part holding the character that reached the target: the last one starting at or before it
  // (an empty text node shares its start with the part after it).
  let first = 0,
    last = parts.length - 1;
  while (first < last) {
    const mid = (first + last + 1) >> 1;
    if (parts[mid].start <= lo - 1) first = mid;
    else last = mid - 1;
  }
  const part = parts[first];
  // A line break that reaches the target puts it at the start of the next text node.
  return part.isBreak ? textFrom(index, first + 1) : { node: part.node, offset: lo - part.start };
}
