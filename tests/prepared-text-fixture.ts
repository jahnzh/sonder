// EPUBs for the prepared-text tests: chapters given as body markup, plus any other files of the archive.
import JSZip from "jszip";

export type PreparedFixture = {
  /** Body markup per chapter file, in reading order. A value that starts with "<html" or "<?xml" is the whole file. */
  chapters: Record<string, string>;
  /** Other archive entries, by their path under OEBPS/. */
  files?: Record<string, string | Buffer>;
  /** The EPUB 3 contents document's `<nav>` markup; it is in the manifest and, with `navInSpine`, in the spine. */
  nav?: string;
  navInSpine?: boolean;
  /** An NCX's `<navMap>` markup. */
  ncx?: string;
  language?: string;
};

const types: Record<string, string> = { css: "text/css", png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", js: "text/javascript" };

export async function preparedFixture(fixture: PreparedFixture): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const names = Object.keys(fixture.chapters);
  const items = names.map((name, index) => `<item id="c${index}" href="${name}" media-type="application/xhtml+xml"/>`);
  const spine = names.map((_name, index) => `<itemref idref="c${index}"/>`);
  for (const [index, name] of Object.keys(fixture.files || {}).entries()) {
    const type = types[name.split(".").pop()!.toLowerCase()] || "application/octet-stream";
    items.push(`<item id="f${index}" href="${name}" media-type="${type}"/>`);
  }
  if (fixture.nav) {
    items.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    if (fixture.navInSpine) spine.unshift('<itemref idref="nav"/>');
    zip.file("OEBPS/nav.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>${fixture.nav}</body></html>`);
  }
  if (fixture.ncx) {
    items.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
    zip.file("OEBPS/toc.ncx", `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">${fixture.ncx}</ncx>`);
  }
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">prepared-text-test</dc:identifier><dc:title>Prepared</dc:title><dc:creator>Test</dc:creator><dc:language>${fixture.language || "en"}</dc:language></metadata><manifest>${items.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
  );
  for (const [name, body] of Object.entries(fixture.chapters))
    zip.file(
      `OEBPS/${name}`,
      /^<(html|\?xml)/.test(body) ? body : `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${name}</title><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`,
    );
  for (const [name, data] of Object.entries(fixture.files || {})) zip.file(`OEBPS/${name}`, data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A 2×3 PNG: enough of a header for its size to be read. */
export const tinyPng = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000020000000308060000007d0b6c6e0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
