import JSZip from "jszip";
// A long EPUB (#428, kept for the book-text jumps of #501): `chapters` chapters of `sentences` sentences each, in paragraphs of six.
// Every sentence is unique and names its chapter and number, so a test can find it by text.
export const longBookSentence = (chapter: number, index: number) =>
  `Chapter ${chapter + 1} sentence ${index + 1} walks past the ${nouns[(chapter * 7 + index) % nouns.length]} and ${verbs[(chapter * 3 + index) % verbs.length]} quietly.`;
const nouns = ["river", "lantern", "orchard", "harbour", "meadow", "tower", "garden", "bridge", "forest", "market", "chapel", "valley"];
const verbs = ["listens", "waits", "turns", "wonders", "smiles", "lingers", "hurries", "pauses", "returns"];
export const longBookChapterTitle = (chapter: number) => `Long Chapter ${chapter + 1}`;
export async function longBookFixture({ chapters = 30, sentences = 600, title = "Long Book" } = {}) {
  const zip = new JSZip();
  const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const ids = Array.from({ length: chapters }, (_, index) => `c${index}`);
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">sonder-long-book-${chapters}-${sentences}</dc:identifier><dc:title>${escaped}</dc:title><dc:creator>Reader QA</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-11-15T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${ids.map((id) => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${ids.map((id) => `<itemref idref="${id}"/>`).join("")}</spine></package>`,
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${ids.map((id, index) => `<li><a href="${id}.xhtml">${longBookChapterTitle(index)}</a></li>`).join("")}</ol></nav></body></html>`,
  );
  for (const [chapter, id] of ids.entries()) {
    const paragraphs: string[] = [];
    for (let start = 0; start < sentences; start += 6)
      paragraphs.push(`<p>${Array.from({ length: Math.min(6, sentences - start) }, (_, offset) => longBookSentence(chapter, start + offset)).join(" ")}</p>`);
    zip.file(
      `OEBPS/${id}.xhtml`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${longBookChapterTitle(chapter)}</title></head><body><h1>${longBookChapterTitle(chapter)}</h1>${paragraphs.join("")}</body></html>`,
    );
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
