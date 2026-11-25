// Which `<a>` in a book's text is a link the reader follows on a tap (#727). A calibre conversion can leave its text
// inside anchors, so a whole page may be inside `<a>` elements; an anchor that wraps whole paragraphs is body text: a
// tap on it shows or hides the controls and it keeps the text's colour. Notes and contents entries stay links
// (`src/prepared-view.ts`).

/** The block elements whose presence inside an anchor means it wraps paragraphs, not a phrase. */
export const BLOCKS_IN_LINK = "p,div,blockquote,li,ul,ol,dl,table,section,article,h1,h2,h3,h4,h5,h6,pre,figure,hr";
