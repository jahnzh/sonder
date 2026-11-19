import JSZip from "jszip";
// A calibre conversion of a MOBI (#727), with the structures such conversions use: `.html` section files (epub.js
// parses those as HTML, not XHTML), a book jacket, `calibre…` classes with a colour, and an `<a id="filepos…"/>`
// written self-closing at the start of every paragraph. Parsed as HTML, that anchor stays open and the parser carries
// it into every paragraph after it, so the whole text sits inside anchors without an href. A real note reference and
// an in-book contents entry are links with a target; one paragraph is wrapped whole by a link.

export const CALIBRE_FIRST = "The ship drifted past the ring of the outer moon while the crew slept.";
export const CALIBRE_SECOND = "Far beyond the gas giant the second part of the story begins.";
export const CALIBRE_CONTENTS = "The Second Part";
export const CALIBRE_WRAPPED = "A whole paragraph sits inside a link to the second part.";
export const CALIBRE_LINK_COLOUR = "rgb(0, 0, 238)";

const paragraph = (n: number, text: string) =>
  `<p class="calibre1"><a id="filepos${1000 + n * 37}"/>${text} The sentence ${n + 1} goes on about the ship, the crew and the long quiet between the stars.</p>`;

export async function calibreLinkFixture(options: { title?: string } = {}) {
  const title = (options.title || "Calibre Links").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    "content.opf",
    `<?xml version='1.0' encoding='utf-8'?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uuid_id" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="uuid_id" opf:scheme="uuid">sonder-calibre-links</dc:identifier><dc:title>${title}</dc:title><dc:creator opf:role="aut">Reader QA</dc:creator><dc:language>en</dc:language><meta name="calibre:timestamp" content="2026-11-15T00:00:00+00:00"/></metadata><manifest><item href="jacket.xhtml" id="jacket" media-type="application/xhtml+xml"/><item href="index_split_000.html" id="html" media-type="application/xhtml+xml"/><item href="index_split_001.html" id="html1" media-type="application/xhtml+xml"/><item href="stylesheet.css" id="css" media-type="text/css"/><item href="toc.ncx" id="ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="jacket"/><itemref idref="html"/><itemref idref="html1"/></spine></package>`,
  );
  zip.file(
    "toc.ncx",
    `<?xml version='1.0' encoding='utf-8'?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="sonder-calibre-links"/></head><docTitle><text>${title}</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>The First Part</text></navLabel><content src="index_split_000.html"/></navPoint><navPoint id="n2" playOrder="2"><navLabel><text>${CALIBRE_CONTENTS}</text></navLabel><content src="index_split_001.html"/></navPoint></navMap></ncx>`,
  );
  // calibre's own classes: body text in the link colour too, as a MOBI's font colour often comes through.
  zip.file(
    "stylesheet.css",
    `.calibre { display: block; font-size: 1em; padding: 0; margin: 0 5pt } .calibre1 { color: ${CALIBRE_LINK_COLOUR}; display: block; text-indent: 1.5em; margin: 0 } .calibre2 { color: ${CALIBRE_LINK_COLOUR}; text-decoration: underline } .calibre3 { font-size: 0.75em; vertical-align: super } a { color: ${CALIBRE_LINK_COLOUR}; text-decoration: underline }`,
  );
  zip.file(
    "jacket.xhtml",
    `<?xml version='1.0' encoding='utf-8'?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><link href="stylesheet.css" rel="stylesheet" type="text/css"/></head><body class="calibre"><div class="calibre_rescale_100"><h1 class="title">${title}</h1><div class="cbj_author">Reader QA</div><div class="cbj_comments"><p>A calibre book jacket.</p></div></div></body></html>`,
  );
  const first = Array.from({ length: 14 }, (_, n) => paragraph(n, n === 0 ? CALIBRE_FIRST : "The crew kept their watch."));
  // A note reference to a paragraph of this page that exists, in the third paragraph.
  first[2] = first[2]!.replace("goes on about the ship", `goes on about the ship<a href="#filepos9000" class="calibre2"><sup class="calibre3">1</sup></a>`);
  // A link around a whole paragraph, as some conversions write a chapter's opening.
  first[1] = `<a href="index_split_001.html" class="calibre2"><p class="calibre1">${CALIBRE_WRAPPED} It runs on for a while so that it fills two lines.</p></a>`;
  zip.file(
    "index_split_000.html",
    `<?xml version='1.0' encoding='utf-8'?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><link href="stylesheet.css" rel="stylesheet" type="text/css"/></head><body class="calibre"><p class="calibre1"><a id="filepos0"/><a href="index_split_001.html#filepos5000" class="calibre2">${CALIBRE_CONTENTS}</a></p>${first.join("")}<p class="calibre1"><a id="filepos9000"/>1. A note at the end of the first part.</p></body></html>`,
  );
  zip.file(
    "index_split_001.html",
    `<?xml version='1.0' encoding='utf-8'?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><link href="stylesheet.css" rel="stylesheet" type="text/css"/></head><body class="calibre"><p class="calibre1"><a id="filepos5000"/>${CALIBRE_SECOND}</p>${Array.from({ length: 6 }, (_, n) => paragraph(n + 20, "The second part carries on.")).join("")}</body></html>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
