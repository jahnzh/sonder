import { readerTextOffset } from "../src/reading-types.ts";
// The reader's lookup before #507, kept to compare the searched lookup with: rangeAt()'s find() as it
// was in src/components/Reader.tsx, over the same walk of the block (text nodes and line breaks in
// order). It tries every character of a text node and normalises the whole text before it each time.
export function linearPlaceAt<N>(
  items: { node: N; isBreak: boolean; text: string }[],
  block: { node: N; childCount: number },
  target: number,
  textLength: (node: N) => number,
) {
  let raw = "",
    last: N = block.node,
    lastIsText = false,
    pending = false;
  for (const item of items) {
    // A <br> that reaches the target puts it at the start of the next text node.
    if (pending && !item.isBreak) return { node: item.node, offset: 0 };
    if (item.isBreak) {
      raw += "\n";
      if (readerTextOffset(raw) >= target) pending = true;
      continue;
    }
    last = item.node;
    lastIsText = true;
    const text = item.text;
    if (readerTextOffset(raw + text) >= target) {
      let i = 0;
      for (; i <= text.length; i++) if (readerTextOffset(raw + text.slice(0, i)) >= target) break;
      return { node: item.node, offset: Math.min(i, text.length) };
    }
    raw += text;
  }
  return { node: last, offset: lastIsText ? textLength(last) : block.childCount };
}
