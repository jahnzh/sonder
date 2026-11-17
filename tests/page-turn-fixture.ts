import JSZip from "jszip";
import { crc32, deflateSync } from "node:zlib";
// The cases of the turn inside a sentence beyond one plain break (#509), one chapter each:
// - "Three pages": a sentence long enough to run over at least three pages at 390 by 844.
// - "Hyphenated": sentences that are mostly one long hyphenated word, so a page break falls inside a word.
// - "Pictures": sentences with a picture between their two halves, so a picture is pushed to the next page
//   with the words after it.
// Every chapter opens with PACED_MARKER: the alignment fixture then spreads each sentence's time by its length
// (PACED_CHARACTERS_PER_SECOND) instead of two seconds a sentence, so a word has a time of its own to test.
export const PACED_MARKER = "This chapter is narrated at reading pace.";
export const PACED_CHARACTERS_PER_SECOND = 40;
const nouns = ["river", "lantern", "orchard", "harbour", "meadow", "tower", "garden", "bridge", "forest", "market", "chapel", "valley"];
const names = ["Ada", "Bram", "Cleo", "Dov", "Edda", "Finn", "Greta", "Hugo", "Ines", "Jules", "Kai", "Lena"];
const compounds = ["matter", "of", "fact", "and", "down", "to", "earth", "and", "straight", "from", "the", "shoulder", "and", "no", "nonsense"];
/** Clause `index` of the long sentence: unique, without a full stop, so the whole chapter part is one sentence. */
export const longClause = (index: number) => `past the ${nouns[index % nouns.length]} number ${index + 1} where the wind keeps turning`;
export const longSentence = (clauses: number) =>
  `The long walk went on ${Array.from({ length: clauses }, (_, index) => longClause(index)).join(", and ")}, until the evening came.`;
/** A long hyphenated word, different in each sentence. */
export const hyphenatedWord = (index: number) =>
  [...compounds.slice(index % 4), ...compounds.slice(0, index % 4), `${nouns[index % nouns.length]}${index + 1}`].join("-");
export const hyphenatedSentence = (index: number) =>
  `${names[index % names.length]} spoke in a ${hyphenatedWord(index)}-like way.`;
/** The two halves of a sentence with a picture between them. */
export const pictureHalves = (index: number): [string, string] => [
  `Picture ${index + 1} hangs by the ${nouns[index % nouns.length]} where`,
  `the visitors stop and look at it for a while before they walk on.`,
];
// A solid PNG, so a picture has a size before it is decoded too (its width and height are also set on the img).
function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([120, 150, 190], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export const PAGE_TURN_CHAPTERS = ["Three pages", "Hyphenated", "Pictures"];
export async function pageTurnFixture({ title = "Turn Cases", clauses = 45, hyphenated = 60, pictures = 30 } = {}) {
  const zip = new JSZip();
  const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const ids = PAGE_TURN_CHAPTERS.map((_, index) => `t${index}`);
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">sonder-page-turn-${clauses}-${hyphenated}-${pictures}</dc:identifier><dc:title>${escaped}</dc:title><dc:creator>Reader QA</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-11-17T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="picture" href="picture.png" media-type="image/png"/>${ids.map((id) => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${ids.map((id) => `<itemref idref="${id}"/>`).join("")}</spine></package>`,
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${ids.map((id, index) => `<li><a href="${id}.xhtml">${PAGE_TURN_CHAPTERS[index]}</a></li>`).join("")}</ol></nav></body></html>`,
  );
  zip.file("OEBPS/picture.png", png(300, 280));
  const chapter = (index: number, paragraphs: string[]) =>
    zip.file(
      `OEBPS/${ids[index]}.xhtml`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${PAGE_TURN_CHAPTERS[index]}</title></head><body><h1>${PAGE_TURN_CHAPTERS[index]}</h1><p>${PACED_MARKER} The next sentence starts here and runs on.</p>${paragraphs.join("")}</body></html>`,
    );
  chapter(0, [`<p>${longSentence(clauses)}</p>`, `<p>The walk ended at the gate. Nobody spoke for a while. Then the lights went out.</p>`]);
  chapter(1, Array.from({ length: hyphenated }, (_, index) => `<p>${hyphenatedSentence(index)}</p>`));
  chapter(
    2,
    Array.from({ length: pictures }, (_, index) => {
      const [before, after] = pictureHalves(index);
      return `<p>${before} <img src="picture.png" width="300" height="280" alt="" style="display:block;width:100%;height:auto"/> ${after}</p>`;
    }),
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
