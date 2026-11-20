// Prepared reader text (server/prepared-text.ts): the EPUB as sanitised HTML in parts, every stored sentence tagged
// with its own id. The stored sentences come from extractBook and are never changed here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-prepared-text-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { extractBook } = await import("../server/reader.ts");
const { parse } = await import("node-html-parser");
const { normalizeReaderText } = await import("../src/reading-types.ts");
const { prepareEpub, sentencesOfParts, PREPARED_TEXT_VERSION, PART_TARGET_BYTES, ALLOWED_TAGS, ALLOWED_ATTRIBUTES } = await import("../server/prepared-text.ts");
const { preparedFixture, tinyPng } = await import("./prepared-text-fixture.ts");
type Fixture = import("./prepared-text-fixture.ts").PreparedFixture;
after(() => sqlite.close());
mkdirSync(join(temp, "media", "ebooks"), { recursive: true });
db.insert(s.works).values({ id: "work-prepared", title: "Prepared", author: "Test", description: "", genre: "", year: 2026 }).run();
const BASE = "/api/reader/book/prepared/key";
let made = 0;
async function prepared(fixture: Fixture) {
  const id = `prepared-${made++}`;
  const file = join(temp, "media", "ebooks", `${id}.epub`);
  const epub = await preparedFixture(fixture);
  writeFileSync(file, epub);
  db.insert(s.ebookEditions).values({ id, workId: "work-prepared", format: "epub", source: file }).run();
  const book = await extractBook(id);
  const pictures = new Map<string, Buffer>();
  const result = await prepareEpub({ epub, book, base: BASE, key: "key", writePicture: async (name, data) => void pictures.set(name, data) });
  return { ...result, book, pictures, html: result.parts.join("") };
}
const stored = (book: Awaited<ReturnType<typeof extractBook>>) => book.sections.flatMap((section) => section.paragraphs.map((paragraph) => ({ id: paragraph.id, text: paragraph.text })));
/** The plan's check on one book: every stored id once, in order, with the stored text. */
function assertTagged(result: Awaited<ReturnType<typeof prepared>>) {
  const found = sentencesOfParts(result.parts);
  assert.deepEqual(found.problems, []);
  assert.deepEqual(
    found.sentences.map((sentence) => ({ id: sentence.id, text: normalizeReaderText(sentence.text) })),
    stored(result.book),
  );
  assert.deepEqual(result.manifest.problems, []);
}

test("every stored sentence is tagged once, in order, with its own text", async () => {
  const result = await prepared({
    chapters: {
      "one.xhtml": "<h1>Down the Rabbit-Hole</h1><p>Alice was beginning to get <em>very</em> tired. She had nothing to do.</p><p>“What is the use of a book,” thought Alice, “without pictures?”</p>",
      "two.xhtml": "<h2>The Pool of Tears</h2><p>Curiouser and curiouser, cried Alice.</p>",
    },
  });
  assertTagged(result);
  assert.deepEqual(stored(result.book).map((sentence) => sentence.id), ["0:0", "0:1", "0:2", "0:3", "1:0", "1:1"]);
  // Emphasis inside a sentence splits its tag into pieces that share the id; the markup itself is kept.
  assert.match(result.html, /<span data-s="0:1">Alice was beginning to get <\/span><em><span data-s="0:1">very<\/span><\/em><span data-s="0:1"> tired\.<\/span> <span data-s="0:2">She had nothing to do\.<\/span>/);
  assert.match(result.html, /<h1><span data-s="0:0">Down the Rabbit-Hole<\/span><\/h1>/);
});

test("compatibility characters, entities, line breaks and collapsed spaces stay as the book wrote them", async () => {
  const result = await prepared({
    chapters: {
      "one.xhtml":
        "<p>  The ﬁrst oﬃce…\n   was&nbsp;empty &amp; cold.   He waited ½ an hour.</p><p>A line<br/>broken in two. Then été came.</p><p>Tom &lt;b&gt; Jones said x² ≠ ｙ.</p>",
    },
  });
  assertTagged(result);
  // The stored text is NFKC ("first office..."); the page keeps the publisher's ligatures and ellipsis.
  assert.equal(stored(result.book)[0].text, "The first office... was empty & cold.");
  assert.ok(result.html.includes("The ﬁrst oﬃce…"));
  assert.ok(result.html.includes("Tom &lt;b&gt; Jones"), "decoded entities are escaped again");
  assert.match(result.html, /<br><span data-s="0:2">\n<\/span>/, "the break's space is part of the sentence");
});

test("a chapter of bare divs: a sentence that runs across blocks keeps one id on several tags", async () => {
  const result = await prepared({
    chapters: { "one.xhtml": "<div>The first line has no stop</div>\n<div>and runs on here. A second one.</div><div><div>Deeper.</div></div>" },
  });
  assertTagged(result);
  const first = stored(result.book)[0];
  assert.equal(first.text, "The first line has no stop and runs on here.");
  assert.equal(result.html.split(`data-s="${first.id}"`).length - 1, 3, "two lines and the space between them");
});

test("text the extractor does not count is shown without a tag", async () => {
  const result = await prepared({
    nav: '<nav epub:type="toc"><ol><li><a href="one.xhtml">One</a></li></ol></nav>',
    navInSpine: true,
    chapters: {
      "one.xhtml":
        '<p>Counted here.</p><table><tr><td>A cell of text.</td><td><p>A counted cell.</p></td></tr></table><div>Loose text beside a paragraph.</div><nav><p>In-book links.</p></nav><pre>keep   <b>this</b>\n  shape</pre>',
    },
  });
  assertTagged(result);
  for (const text of ["A cell of text.", "Loose text beside a paragraph.", "In-book links.", "One"]) {
    assert.ok(result.html.includes(text), text);
    assert.ok(!sentencesOfParts(result.parts).sentences.some((sentence) => sentence.text.includes(text)), `${text} is not a sentence`);
  }
  assert.match(result.html, /<table><tr><td>A cell of text\.<\/td><td><p><span data-s="1:1">A counted cell\.<\/span><\/p><\/td><\/tr><\/table>/);
  // The parser keeps a <pre>'s markup as text, and so does the stored sentence: it is shown escaped.
  assert.ok(result.html.includes("keep   &lt;b&gt;this&lt;/b&gt;\n  shape"));
});

test("structure is kept, the publisher's fonts and layout are not", async () => {
  const result = await prepared({
    files: { "style.css": ".c { text-align: center; font-family: Fancy } p.it, .other { font-style: italic } .sc { font-variant: small-caps } @font-face { font-family: Fancy; src: url(https://evil.example/f.woff) } .big { font-size: 40px; position: absolute }" },
    chapters: {
      "one.xhtml":
        '<h2 class="c">Chapter</h2><p class="it big" style="color:red;margin-left:2em">Italic. </p><blockquote><p>Quoted.</p></blockquote><ul><li>One.</li></ul><ol start="3"><li>Three.</li></ol><p style="text-align:center">* * *</p><center>Old centre.</center><p><span class="sc">Small</span> caps <b>bold</b> <i>it</i> <sup>1</sup>.</p><hr/><table><tr><th colspan="2">Head</th></tr></table><section><p lang="fr">Bonjour.</p></section>',
    },
  });
  assertTagged(result);
  assert.match(result.html, /<h2 class="t-c">/);
  assert.match(result.html, /<p class="t-i t-in1">/);
  assert.match(result.html, /<blockquote><p>/);
  assert.match(result.html, /<ul><li>/);
  assert.match(result.html, /<ol start="3"><li>/);
  assert.match(result.html, /<p class="t-c"><span data-s="[^"]+">\* \* \*<\/span><\/p>/);
  assert.match(result.html, /<div class="t-c">/);
  assert.match(result.html, /<span class="t-sc">/);
  assert.match(result.html, /<th colspan="2">/);
  assert.match(result.html, /<p lang="fr">/);
  assert.ok(result.html.includes("<hr>"));
  for (const gone of ["Fancy", "color", "40px", "absolute", "style=", "evil.example", "margin"]) assert.ok(!result.html.includes(gone), gone);
});

/** Every tag and attribute of the output is on the allow-list, and no address leaves the server. */
function assertClean(html: string) {
  const root = parse(html);
  for (const element of root.querySelectorAll("*")) {
    const tag = element.rawTagName.toLowerCase();
    assert.ok(ALLOWED_TAGS.has(tag), `tag ${tag}`);
    for (const [name, value] of Object.entries(element.attrs)) {
      assert.ok(ALLOWED_ATTRIBUTES.has(name), `attribute ${name} on ${tag}`);
      if (name === "src") assert.ok(value.startsWith(`${BASE}/pictures/`), `src ${value}`);
      if (name === "href") assert.match(value, /^(https?:\/\/|mailto:)/, `href ${value}`);
    }
  }
  assert.doesNotMatch(html, /javascript:|vbscript:|data:|<script|<style|<iframe|<object|<embed|<form|<link|<meta|<base/i);
  // What the parser of this test accepts as text, a browser must too: no raw "<" survives outside a tag we wrote.
  assert.equal(root.querySelectorAll("*").length, (html.match(/<[a-z]/g) || []).length);
}

test("hostile markup: scripts, handlers, frames, forms and outside addresses do not survive", async () => {
  const result = await prepared({
    files: { "pic.png": tinyPng, "evil.js": "alert(1)", "style.css": "p { background: url(https://evil.example/track.gif) } @import url(https://evil.example/x.css);" },
    chapters: {
      "one.xhtml": [
        '<p onclick="alert(1)" ONMOUSEOVER="alert(2)" style="background:url(https://evil.example/a)">Handler text.</p>',
        "<script>alert('script body')</script><script src=\"evil.js\"></script><style>p{color:red}</style>",
        '<p>Before <script>alert(3)</script>after.</p>',
        '<iframe src="https://evil.example/frame">Frame fallback.</iframe><p>Inside <iframe srcdoc="&lt;script&gt;alert(4)&lt;/script&gt;">framed words</iframe> a paragraph.</p>',
        '<object data="evil.swf"><param name="x" value="y"/>Object fallback.</object><embed src="evil.swf"/>',
        '<form action="https://evil.example/post"><input name="q" value="typed"/><button formaction="javascript:alert(5)">Send it.</button><textarea>Area text.</textarea><select><option>Option text.</option></select></form>',
        '<p><a href="javascript:alert(6)">Script link.</a> <a href=" JaVaScRiPt:alert(7)">Mixed case.</a> <a href="data:text/html,&lt;script&gt;alert(8)&lt;/script&gt;">Data link.</a> <a href="vbscript:x">Old link.</a> <a href="https://example.org/a?b=1&amp;c=2" onclick="x()">Outside link.</a> <a href="//evil.example/x">Scheme-less.</a></p>',
        '<p><img src="https://evil.example/pixel.gif" alt="remote"/><img src="//evil.example/pixel.gif"/><img src="data:image/svg+xml,&lt;svg onload=alert(9)&gt;"/><img src="pic.png" onerror="alert(10)" srcset="https://evil.example/2x.png 2x" alt=\'"&gt;&lt;script&gt;alert(11)&lt;/script&gt;\'/><img src="../../../../etc/passwd"/><img src="evil.js"/></p>',
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(12)"><script>alert(13)</script><foreignObject><p>Foreign words.</p></foreignObject><image href="pic.png"/><a href="javascript:alert(14)"><text>Svg text.</text></a></svg>',
        '<math><mtext>Math text.</mtext><annotation-xml encoding="text/html"><script>alert(15)</script></annotation-xml></math>',
        '<link rel="stylesheet" href="https://evil.example/x.css"/><meta http-equiv="refresh" content="0;url=https://evil.example"/><base href="https://evil.example/"/>',
        '<video src="https://evil.example/v.mp4" poster="https://evil.example/p.jpg" autoplay="">Video fallback.</video><audio src="https://evil.example/a.mp3"></audio>',
        "<p>Encoded &lt;script&gt;alert(16)&lt;/script&gt; and &#60;img src=x onerror=alert(17)&#62; stay text.</p>",
        '<p id="&quot;&gt;&lt;script&gt;alert(18)&lt;/script&gt;" lang="en&quot; onclick=&quot;alert(19)" class="x&quot; onclick=&quot;alert(20)">Attribute breakers.</p>',
        '<template><p>Template words.</p></template><noscript><p>No script words.</p></noscript><marquee>Unknown tag.</marquee><x-custom onclick="alert(21)">Custom tag.</x-custom>',
        '<table background="https://evil.example/t.gif"><tr><td background="https://evil.example/c.gif" style="behavior:url(x.htc)">Cell.</td></tr></table>',
      ].join("\n"),
    },
  });
  assertClean(result.html);
  assertTagged(result);
  // Words the extractor counts inside a refused element are still the book's sentences: the element goes, they stay.
  for (const text of ["Handler text.", "Frame fallback.", "framed words", "Object fallback.", "Send it.", "Script link.", "Outside link.", "Math text.", "Video fallback.", "Unknown tag.", "Custom tag.", "Cell."])
    assert.ok(result.html.includes(text), text);
  // Script and style bodies are not text of the book.
  for (const gone of ["script body", "alert(3)", "alert(13)", "Svg text.", "color:red", "evil.example", "evil.js", "passwd", "swf", "typed", "srcset"]) assert.ok(!result.html.includes(gone), gone);
  assert.ok(result.html.includes('<a href="https://example.org/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">'));
  assert.ok(result.html.includes(`alt="&quot;&gt;&lt;script&gt;alert(11)&lt;/script&gt;"`), "an attribute's value cannot close its tag");
  assert.deepEqual([...result.pictures.keys()], ["0.png"], "only the book's own picture is copied");
});

test("documents with their parts in odd places are tagged as the extractor read them", async () => {
  const { readerFixture } = await import("./reader-fixture.ts");
  for (const variant of [undefined, "svg-root", "iframe-root", "nav-root", "no-head", "head-late", "text-before-head", "template-root", "svg-asset"] as const) {
    const id = `prepared-variant-${variant}`;
    const file = join(temp, "media", "ebooks", `${id}.epub`);
    const epub = await readerFixture({ variant, script: true, cover: true });
    writeFileSync(file, epub);
    db.insert(s.ebookEditions).values({ id, workId: "work-prepared", format: "epub", source: file }).run();
    const book = await extractBook(id);
    const pictures = new Map<string, Buffer>();
    const result = await prepareEpub({ epub, book, base: BASE, key: "key", writePicture: async (name, data) => void pictures.set(name, data) });
    assertClean(result.parts.join(""));
    assertTagged({ ...result, book, pictures, html: result.parts.join("") });
  }
});

test("a hostile book cannot forge the marks the preparing step leaves for itself", async () => {
  const result = await prepared({
    files: { "pic.png": tinyPng },
    chapters: { "one.xhtml": '<p>Marks \u0001x:g:0\u0001 and \u0001x:d:0\u0001 in text. <a href="#there">Go</a><img src="pic.png" alt="\u0001x:d:0\u0001"/></p><p id="there">There.</p>' },
  });
  assertClean(result.html);
  assertTagged(result);
  assert.ok(result.html.includes("\u0001x:g:0\u0001"), "the book's own control characters stay text");
  assert.match(result.html, /<a data-part="0" data-sentence="0:2" data-anchor="there">/);
});

test("parts are cut at about 120 KB, at block boundaries and never inside a sentence", async () => {
  const paragraph = (chapter: number, index: number) => `<p>Chapter ${chapter} paragraph ${index} begins here. ${"It goes on with more of the same words for a while. ".repeat(6)}</p>`;
  const chapters: Fixture["chapters"] = {};
  // One long file inside a wrapper, one file of bare divs whose sentences run across them, and many short files.
  chapters["long.xhtml"] = `<div class="wrap"><section>${Array.from({ length: 900 }, (_item, index) => (index % 300 === 0 ? `<h2>Heading ${index}</h2>` : "") + paragraph(0, index)).join("\n")}</section></div>`;
  chapters["divs.xhtml"] = Array.from({ length: 1500 }, (_item, index) => `<div>line ${index} of a chapter without stops that goes on and on and on for quite a long while</div>`).join("\n");
  for (let chapter = 2; chapter < 12; chapter++) chapters[`c${chapter}.xhtml`] = `<h1>Chapter ${chapter}</h1>${Array.from({ length: 40 }, (_item, index) => paragraph(chapter, index)).join("")}`;
  const result = await prepared({ chapters });
  assertTagged(result);
  const { manifest, parts } = result;
  assert.ok(parts.length > 4, `${parts.length} parts`);
  assert.equal(manifest.parts.length, parts.length);
  const seen = new Map<string, number>();
  for (const [index, html] of parts.entries()) {
    const part = manifest.parts[index];
    assert.equal(part.bytes, Buffer.byteLength(html));
    // Each part parses on its own: what it opens it closes.
    const root = parse(html);
    assert.equal(root.toString().length, html.length, `part ${index} is balanced`);
    for (const id of new Set(root.querySelectorAll("[data-s]").map((span) => span.getAttribute("data-s")!))) {
      assert.ok(!seen.has(id), `sentence ${id} is in parts ${seen.get(id)} and ${index}`);
      seen.set(id, index);
    }
  }
  const sizes = manifest.parts.map((part) => part.bytes);
  // The bare-div chapter is one sentence from end to end, so it cannot be cut; every other part keeps to the size.
  const whole = manifest.parts.filter((part) => part.bytes > PART_TARGET_BYTES);
  assert.equal(whole.length, 1, `oversized parts: ${sizes}`);
  assert.deepEqual(whole[0].ranges.map((range) => range.section), [1]);
  assert.ok(sizes.filter((size) => size < PART_TARGET_BYTES / 4).length <= 2, `small parts: ${sizes}`);
  // A long file is cut inside its wrappers, which each part opens and closes again.
  assert.ok(manifest.parts.filter((part) => part.ranges.some((range) => range.section === 0)).length >= 3);
  assert.match(parts[1], /^<section data-section="0"><div><div>/);
  // Short files share a part.
  assert.ok(manifest.parts.some((part) => part.ranges.length > 1));
});

test("the manifest counts what the parts hold", async () => {
  const result = await prepared({
    files: { "pic.png": tinyPng },
    nav: '<nav epub:type="toc"><ol><li><a href="one.xhtml">One</a><ol><li><a href="one.xhtml#mid">Middle</a></li></ol></li><li><a href="cover.xhtml">Cover</a></li><li><a href="two.xhtml#end">Two</a></li><li><a href="gone.xhtml">Gone</a></li></ol></nav><nav epub:type="landmarks"><ol><li><a href="two.xhtml">Start</a></li></ol></nav>',
    chapters: {
      "one.xhtml": '<h1>One</h1><p>First. Second.</p><p id="mid">Third 😀 here.</p>',
      "cover.xhtml": '<div><img src="pic.png" alt="Cover"/></div>',
      "two.xhtml": '<h1>Two</h1><p>Fourth.</p><p id="end"></p>',
    },
  });
  assertTagged(result);
  const { manifest, parts, book } = result;
  assert.equal(manifest.version, PREPARED_TEXT_VERSION);
  assert.equal(manifest.key, "key");
  assert.equal(manifest.id, book.id);
  assert.equal(manifest.fingerprint, book.fingerprint);
  assert.equal(manifest.sentences, stored(book).length);
  assert.equal(manifest.pictures, 1);
  // Characters are those of the text a browser shows: UTF-16 units of the part's text content.
  let chars = 0;
  let ordinal = 0;
  for (const [index, html] of parts.entries()) {
    const part = manifest.parts[index];
    assert.equal(part.index, index);
    assert.equal(part.chars, parse(html).text.length, `chars of part ${index}`);
    assert.equal(part.charStart, chars);
    assert.equal(part.ordinal, ordinal);
    const ids = [...new Set(parse(html).querySelectorAll("[data-s]").map((span) => span.getAttribute("data-s")!))];
    assert.equal(part.sentences, ids.length);
    assert.equal(part.first, ids[0] ?? null);
    assert.equal(part.last, ids.at(-1) ?? null);
    assert.equal(part.ranges.reduce((sum, range) => sum + range.count, 0), ids.length);
    chars += part.chars;
    ordinal += part.sentences;
  }
  assert.equal(manifest.chars, chars);
  assert.deepEqual(manifest.parts[0].ranges, [
    { section: 0, first: "0:0", last: "0:3", count: 4 },
    { section: 2, first: "2:0", last: "2:1", count: 2 },
  ]);
  // Every file of the reading order is listed, also one with no sentence of its own (the picture page).
  assert.deepEqual(
    manifest.sections.map((section) => [section.index, section.href, section.title, section.part, section.sentences, section.first, section.last]),
    [
      [0, "one.xhtml", "One", 0, 4, "0:0", "0:3"],
      [1, "cover.xhtml", "", 0, 0, null, null],
      [2, "two.xhtml", "Two", 0, 2, "2:0", "2:1"],
    ],
  );
  assert.deepEqual(manifest.sections.map((section) => section.charStart), [0, parse(parts[0]).querySelector('[data-section="0"]')!.text.length, manifest.chars - parse(parts[0]).querySelector('[data-section="2"]')!.text.length]);
  // Chapters come from the book's own contents, with their depth, and point at the sentence they start on.
  assert.deepEqual(manifest.chapters, [
    { label: "One", depth: 0, section: 0, part: 0, sentence: "0:0" },
    { label: "Middle", depth: 1, section: 0, part: 0, sentence: "0:3", anchor: "mid" },
    { label: "Cover", depth: 0, section: 1, part: 0, sentence: "2:0" },
    { label: "Two", depth: 0, section: 2, part: 0, sentence: null, anchor: "end" },
  ]);
  assert.match(result.html, /<p data-id="mid">/);
});

test("chapters fall back to the NCX, then to the files' own headings", async () => {
  const ncx = await prepared({
    ncx: '<navMap><navPoint id="a"><navLabel><text>Part I</text></navLabel><content src="one.xhtml"/><navPoint id="b"><navLabel><text>Inner</text></navLabel><content src="two.xhtml"/></navPoint></navPoint></navMap>',
    chapters: { "one.xhtml": "<p>First.</p>", "two.xhtml": "<p>Second.</p>" },
  });
  assert.deepEqual(ncx.manifest.chapters, [
    { label: "Part I", depth: 0, section: 0, part: 0, sentence: "0:0" },
    { label: "Inner", depth: 1, section: 1, part: 0, sentence: "1:0" },
  ]);
  const none = await prepared({ chapters: { "one.xhtml": "<h1>Alpha</h1><p>First.</p>", "two.xhtml": "<p>Second.</p>" } });
  assert.deepEqual(none.manifest.chapters, [
    { label: "Alpha", depth: 0, section: 0, part: 0, sentence: "0:0" },
    { label: "Section 2", depth: 0, section: 1, part: 0, sentence: "1:0" },
  ]);
});

test("pictures get an address under the prepared version, once each, with their size", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script></svg>';
  const result = await prepared({
    files: { "images/pic.png": tinyPng, "images/Second Pic.png": tinyPng, "drawing.svg": svg, "notes.txt": "not a picture" },
    chapters: {
      "one.xhtml":
        '<p>Text <img src="images/pic.png" alt="A &quot;pic&quot;"/></p><p><img src="images/pic.png"/><img src="images/Second%20Pic.png"/><img src="./images/../images/pic.png#frag"/></p><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="images/pic.png"/></svg><p><img src="drawing.svg"/><img src="notes.txt"/><img src="missing.png"/><img/></p>',
    },
  });
  assertClean(result.html);
  assert.deepEqual([...result.pictures.keys()].sort(), ["0.png", "1.png", "2.svg"]);
  assert.equal(result.manifest.pictures, 3);
  assert.equal(result.html.split(`src="${BASE}/pictures/0.png"`).length - 1, 4);
  assert.ok(result.html.includes(`<img src="${BASE}/pictures/0.png" alt="A &quot;pic&quot;" width="2" height="3" loading="lazy" decoding="async">`));
  assert.ok(result.html.includes(`<img src="${BASE}/pictures/2.svg" alt="" loading="lazy" decoding="async">`));
  assert.ok(result.pictures.get("2.svg")!.equals(Buffer.from(svg)), "a picture is copied as it is; the route that serves it makes it inert");
});

test("format guard: a change to the prepared output comes with a new PREPARED_TEXT_VERSION", async () => {
  const result = await prepared({
    files: { "pic.png": tinyPng, "style.css": ".c{text-align:center}" },
    nav: '<nav epub:type="toc"><ol><li><a href="one.xhtml#a">One</a></li></ol></nav>',
    chapters: {
      "one.xhtml": '<h1 id="a" class="c">One</h1><p>Alice was <em>very</em> tired… She slept.<br/>Then woke.</p><div>Loose <a href="two.xhtml">link</a>.</div><img src="pic.png" alt="x"/><table><tr><td>Cell</td></tr></table>',
      "two.xhtml": "<blockquote><p>Quoted.</p></blockquote><ul><li>Item.</li></ul><pre>pre  text</pre>",
    },
  });
  const { fingerprint: _fingerprint, id: _id, ...manifest } = result.manifest;
  const digest = createHash("sha256").update(JSON.stringify([manifest, result.parts])).digest("hex").slice(0, 16);
  // When this fails: raise PREPARED_TEXT_VERSION in server/prepared-text.ts (stored books are prepared again), then
  // put the new digest and version here.
  assert.deepEqual([PREPARED_TEXT_VERSION, digest], [1, "d389187ebb4bb8a1"]);
});
