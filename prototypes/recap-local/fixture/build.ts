// Writes the invented story as an EPUB, so that the fixture goes through the same extractor as a real book.
//   npx tsx prototypes/recap-local/fixture/build.ts <out.epub>
import JSZip from "jszip";
import { writeFileSync } from "node:fs";
import { author, chapters, title } from "./story.ts";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export async function fixtureEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const items = chapters.map((_, index) => `<item id="c${index + 1}" href="c${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = chapters.map((_, index) => `<itemref idref="c${index + 1}"/>`).join("");
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">recap-prototype-fixture</dc:identifier><dc:title>${escape(title)}</dc:title><dc:creator>${escape(author)}</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>${items}</manifest><spine><itemref idref="title"/>${spine}</spine></package>`,
  );
  // A title page, as real books have: a section too short to be a unit of its own.
  zip.file("OEBPS/title.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1><p>An invented story for testing recaps.</p></body></html>`);
  for (const [index, chapter] of chapters.entries())
    zip.file(
      `OEBPS/c${index + 1}.xhtml`,
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escape(chapter.title)}</title></head><body><h2>${index + 1}. ${escape(chapter.title)}</h2>${chapter.paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("")}</body></html>`,
    );
  return zip.generateAsync({ type: "nodebuffer" });
}

if (process.argv[1]?.endsWith("build.ts")) {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write("usage: npx tsx prototypes/recap-local/fixture/build.ts <out.epub>\n");
    process.exit(2);
  }
  writeFileSync(out, await fixtureEpub());
  process.stdout.write(`${out}\n`);
}
