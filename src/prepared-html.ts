// How a part of prepared text enters the page (ADR 0025, step 3 of #799). A part's HTML goes into the application's
// own page, not into a frame, so a miss in the server's sanitiser (server/prepared-text.ts) must not become script
// that runs as the application. A part's string is never assigned as markup of a live element: it is parsed into an
// inert document (DOMParser: no script runs, no handler fires, nothing is fetched), every element of it is checked
// against the one allow-list the server writes from (prepared-text-rules.ts), and the page's nodes are made one by
// one from those that pass. An element that does not pass stays out with everything under it; the rest of the part
// is shown, and what was refused is named so the reader can report it. This walk does not rely on the application's
// Content-Security-Policy, which production sends report-only.
import { refusedElement } from "./prepared-text-rules";

/** At most this many refusals are kept for a part's report. */
const REFUSED_LIMIT = 20;

export type BuiltPart = {
  /** The part's nodes, made in `into`'s document; not yet in the page. */
  content: DocumentFragment;
  /** Every tagged sentence of the part in reading order: its id and ALL the elements that carry it. */
  sentences: Map<string, HTMLElement[]>;
  /** Why each element that was left out was (`refusedElement`'s words). Empty for a part the sanitiser wrote as it should. */
  refused: string[];
};

/**
 * A part's HTML as nodes of the page. `base` is the address the book's prepared output is served under
 * (`/api/reader/<edition>/prepared/<key>`); a picture may name nothing outside it. A sentence is every element that
 * shares one `data-s`; text outside them is the book's text without a locator.
 */
export function buildPart(html: string, into: Document, base: string): BuiltPart {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  // The parsed document's body, asked of the document itself and not by name: an element named "body" in the part
  // (a form, a picture) would stand in for it in Firefox, and the walk would start there and show nothing else.
  const body = (Object.getOwnPropertyDescriptor(Document.prototype, "body")!.get!.call(parsed) as HTMLElement | null) ?? parsed.documentElement;
  const sentences = new Map<string, HTMLElement[]>();
  const refused = new Set<string>();
  const content = into.createDocumentFragment();
  // Walked without recursion: a book of deeply nested tags must not exhaust the stack.
  const work: { from: Node; to: Node }[] = [{ from: body, to: content }];
  while (work.length) {
    const { from, to } = work.pop()!;
    for (let child = from.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        to.appendChild(into.createTextNode((child as Text).data));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const source = child as Element;
      const reason = refusedElement(source, base);
      if (reason !== null) {
        if (refused.size < REFUSED_LIMIT) refused.add(reason.slice(0, 80));
        continue;
      }
      const tag = source.localName;
      const made = into.createElement(tag);
      for (const attribute of Array.from(source.attributes)) made.setAttribute(attribute.name, attribute.value);
      // A link out of the book opens outside the application and without its opener, whatever the part said.
      if (tag === "a" && made.hasAttribute("href")) {
        made.setAttribute("target", "_blank");
        made.setAttribute("rel", "noopener noreferrer nofollow");
      }
      to.appendChild(made);
      if (tag !== "img" && tag !== "br" && tag !== "hr") work.push({ from: source, to: made });
    }
  }
  // In reading order, which the walk above does not keep between branches.
  for (const element of content.querySelectorAll<HTMLElement>("[data-s]")) {
    const sentence = element.getAttribute("data-s")!;
    const elements = sentences.get(sentence);
    if (elements) elements.push(element);
    else sentences.set(sentence, [element]);
  }
  return { content, sentences, refused: [...refused] };
}
