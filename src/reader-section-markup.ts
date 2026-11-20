// epub.js chooses a section's parser by its file name: `.xhtml` is parsed as XHTML, `.html` and `.htm` as HTML. An
// EPUB's documents are XHTML whatever they are called, and XHTML may write an empty element self-closing. HTML reads
// `<title/>` as an opening tag whose content is text up to `</title>`, which never comes, so the rest of the document,
// its body included, becomes the title and the page shows nothing (#812). The same holds for the other elements whose
// content HTML reads as text. Only those get their end tag: closing every self-closing element would move the nodes
// that saved places in such books count from.
const RAW_TEXT = /<(title|style|textarea|script|iframe|noscript|noframes|noembed|xmp)(\s[^<>]*?)?\/>/gi;

/** A section's markup with every self-closing element whose content HTML reads as text written with an end tag. */
export function closeRawTextElements(markup: string): string {
  return markup.replace(RAW_TEXT, (_match, name: string, attributes = "") => `<${name}${attributes}></${name}>`);
}
