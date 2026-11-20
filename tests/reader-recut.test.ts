// A book whose paragraphs are not the standard blocks (ADR 0026, #815): it is cut by another rule, chapter by
// chapter, and places saved in its standard cut are carried over. A book that the standard rule cuts well keeps
// its cut exactly, odd chapter included. All text here is made up.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-reader-recut-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { readerFixture } = await import("./reader-fixture.ts");
const { extractBook, bookWithPlaces, cutEpub, invalidateParsedBook } = await import("../server/reader.ts");
const { normalizeReaderText } = await import("../src/reading-types.ts");
const app = await createApp();
after(async () => {
  await app.close();
  sqlite.close();
});
mkdirSync(join(temp, "media", "ebooks"), { recursive: true });
async function edition(id: string, bodies: [string, string]) {
  const file = join(temp, "media", "ebooks", `${id}.epub`);
  writeFileSync(file, await readerFixture({ title: "Tides", bodies }));
  db.insert(s.ebookEditions).values({ id, workId: "work-alice", format: "epub", source: file }).run();
  return id;
}
const prose = (chapter: string, count: number) =>
  Array.from({ length: count }, (_item, index) => `The ${chapter} tide came in for the ${index + 1}th time that week. Nobody on the quay looked up from the nets.`);
// Kind one: every paragraph is a <div> with a <span> in it; headings and quotations are the only standard blocks.
const divChapter =
  prose("morning", 6).map((text) => `<div class="c1"><span class="c2">${text}</span></div><div class="c3"> </div>`).join("\n") +
  `<h2>The harbour wall</h2><blockquote><div class="c4">A quoted line stands here.</div></blockquote>` +
  prose("evening", 6).map((text) => `<div class="c1"><span class="c2">${text}</span></div>`).join("\n");
// Kind two: the prose is loose text in <body>, between <p> elements that hold only a space.
const looseChapter =
  `<h2>Low water</h2><p class="c1"> </p>` + prose("night", 8).map((text) => `${text}<p class="c1"> </p>`).join("") + `<dfn>Slack</dfn> water held for an hour.<p class="c1"> </p>`;
const sentences = (book: Awaited<ReturnType<typeof extractBook>>) => book.sections.flatMap((section) => section.paragraphs);
const heldShare = (book: Awaited<ReturnType<typeof extractBook>>, text: string) => sentences(book).reduce((sum, sentence) => sum + sentence.text.length, 0) / normalizeReaderText(text).length;
const plain = (html: string) => html.replace(/<[^>]+>/g, " ");

test("a book of <div> paragraphs and one of loose text are cut into the sentences of their prose", async () => {
  const book = await extractBook(await edition("recut-kinds", [divChapter, looseChapter]));
  assert.deepEqual(book.sections.map((section) => [section.index, section.blocks]), [[0, "div"], [1, "body"]]);
  // Nearly all of the text is in sentences (the fixture adds a title heading to each chapter).
  const share = heldShare(book, `Down the Rabbit-Hole ${plain(divChapter)} The Pool of Tears ${plain(looseChapter)}`);
  assert.ok(share > 0.95 && share <= 1, `share ${share}`);
  const [first, second] = book.sections;
  // With <div> as a block, each paragraph is a block of its own and sentences do not run across paragraphs.
  assert.equal(first.paragraphs[0].text, "Down the Rabbit-Hole");
  assert.equal(first.paragraphs[1].text, "The morning tide came in for the 1th time that week.");
  assert.equal(first.paragraphs[2].text, "Nobody on the quay looked up from the nets.");
  assert.deepEqual(first.paragraphs.slice(0, 5).map((sentence) => sentence.blockIndex), [0, 1, 1, 2, 2]);
  assert.ok(first.paragraphs.some((sentence) => sentence.text === "A quoted line stands here."));
  assert.deepEqual(first.paragraphs.map((sentence) => sentence.id), first.paragraphs.map((_sentence, index) => `0:${index}`));
  // Loose text has no element of its own: the chapter is one block, cut into sentences.
  assert.ok(second.paragraphs.every((sentence) => sentence.blockIndex === 0));
  assert.ok(second.paragraphs.some((sentence) => sentence.text === "Nobody on the quay looked up from the nets."));
  assert.ok(second.paragraphs.some((sentence) => sentence.text === "Slack water held for an hour."));
  // The fixture's two headings touch, so they open the first sentence together; then two sentences a paragraph.
  assert.equal(second.paragraphs[0].text, "The Pool of TearsLow water The night tide came in for the 1th time that week.");
  assert.equal(second.paragraphs.length, 17);
});

test("a book the standard rule cuts well keeps its cut, with an odd chapter left as it is", async () => {
  // Ten times more text in <p> than in the odd chapter: the book as a whole is far above the line.
  const normal = prose("spring", 40).map((text) => `<p>${text}</p>`).join("");
  const odd = `<p>One counted line.</p>` + prose("autumn", 4).map((text) => `<div>${text}</div>`).join("");
  const book = await extractBook(await edition("recut-normal", [normal, odd]));
  assert.ok(book.sections.every((section) => !("blocks" in section)), "no chapter gets a rule");
  // The odd chapter is 13 % in standard blocks and stays so: its <div> text was never a sentence of this book.
  assert.deepEqual(book.sections[1].paragraphs.map((sentence) => sentence.text), ["The Pool of Tears", "One counted line."]);
  assert.equal(book.sections[0].paragraphs.length, 81);
});

test("a chapter of such a book that the standard rule cuts well keeps the standard rule", async () => {
  const standard = prose("winter", 3).map((text) => `<p>${text}</p>`).join("");
  const book = await extractBook(await edition("recut-mixed", [divChapter + divChapter, standard]));
  assert.deepEqual(book.sections.map((section) => section.blocks), ["div", undefined]);
  assert.deepEqual(book.sections[1].paragraphs.map((sentence) => sentence.id), ["1:0", "1:1", "1:2", "1:3", "1:4", "1:5", "1:6"]);
});

test("places saved in the standard cut are carried over to the same text, once", async () => {
  const id = await edition("recut-carry", [divChapter, looseChapter]);
  // What the standard cut held: the title, the heading and the quotation of chapter one; two headings of chapter two.
  const old = { title: "0:0", heading: "0:1", quotation: "0:2", second: "1:1" };
  const locator = (paragraphId: string, quote: string) => ({ cfi: "epubcfi(/6/2!/4/2)", section: Number(paragraphId.split(":")[0]), paragraphId, quote, progression: 0.4 });
  const checkpoint = { locator: locator(old.quotation, "A quoted line stands here."), revision: 3, eventId: "event-one-1", deviceId: "device-1", updatedAt: 1_700_000_000_000, origin: "reading" };
  sqlite.prepare("INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(1,?,?)").run(id, JSON.stringify(checkpoint));
  const bookmark = sqlite.prepare("INSERT INTO user_reader_bookmarks(user_id,id,edition_id,label,locator,created_at) VALUES(1,?,?,?,?,?)");
  bookmark.run("bookmark-heading", id, "Wall", JSON.stringify(locator(old.heading, "The harbour wall")), 1);
  bookmark.run("bookmark-second", id, "Low", JSON.stringify(locator(old.second, "Low water")), 2);
  bookmark.run("bookmark-unknown", id, "Gone", JSON.stringify(locator("7:7", "Nothing")), 3);

  const read = async () => (await app.inject({ method: "GET", url: `/api/reader/${id}` })).json();
  const first = await read();
  const byId = new Map<string, string>(first.sections.flatMap((section: { paragraphs: { id: string; text: string }[] }) => section.paragraphs.map((sentence) => [sentence.id, sentence.text])));
  // The reading place is on the quotation again, which is no longer sentence 0:2.
  assert.notEqual(first.checkpoint.locator.paragraphId, old.quotation);
  assert.equal(byId.get(first.checkpoint.locator.paragraphId), "A quoted line stands here.");
  assert.equal(first.checkpoint.locator.quote, "A quoted line stands here.");
  assert.equal(first.checkpoint.locator.cfi, checkpoint.locator.cfi);
  assert.equal(first.checkpoint.locator.section, 0);
  // Its share of the book is that of the sentence it is on now, not the one it had among the old cut's few.
  const order = [...byId.keys()];
  const shareOf = (paragraphId: string) => order.indexOf(paragraphId) / (order.length - 1);
  assert.equal(first.checkpoint.locator.progression, shareOf(first.checkpoint.locator.paragraphId));
  assert.ok(Math.abs(first.checkpoint.locator.progression - 0.4) > 0.05, "the fixture's old share is not the new one by chance");
  assert.equal(first.checkpoint.revision, 4, "a device holding revision 3 learns of the moved place");
  assert.equal(first.checkpoint.updatedAt, checkpoint.updatedAt);
  const marks = new Map<string, { locator: { paragraphId: string; quote: string }; label: string }>(first.bookmarks.map((entry: { id: string }) => [entry.id, entry]));
  assert.equal(byId.get(marks.get("bookmark-heading")!.locator.paragraphId), "The harbour wall");
  assert.equal(marks.get("bookmark-heading")!.label, "Wall");
  assert.equal((marks.get("bookmark-heading")!.locator as unknown as { progression: number }).progression, shareOf(marks.get("bookmark-heading")!.locator.paragraphId));
  // In the chapter read as one block, the heading is inside the sentence that now holds it.
  assert.match(byId.get(marks.get("bookmark-second")!.locator.paragraphId)!, /Low water The night tide/);
  assert.equal(marks.get("bookmark-second")!.locator.quote, byId.get(marks.get("bookmark-second")!.locator.paragraphId)!.slice(0, 300));
  assert.equal(marks.get("bookmark-unknown")!.locator.paragraphId, "7:7", "a place that was in neither cut is left alone");

  // A restart reads the book again: nothing moves a second time.
  invalidateParsedBook(id);
  const second = await read();
  assert.deepEqual(second.checkpoint, first.checkpoint);
  assert.deepEqual(second.bookmarks, first.bookmarks);
});

test("a place sent on the old cut after the change lands on its own text, or is refused", async () => {
  // A device that read on its stored copy of the book still names sentences of the standard cut (#821, finding 1).
  const id = await edition("recut-late", [divChapter, looseChapter]);
  const book = (await app.inject({ method: "GET", url: `/api/reader/${id}` })).json();
  const all: { id: string; text: string }[] = book.sections.flatMap((section: { paragraphs: { id: string; text: string }[] }) => section.paragraphs);
  const textOf = (paragraphId: string) => all.find((sentence) => sentence.id === paragraphId)!.text;
  let revision = 0;
  const send = async (paragraphId: string, quote: string | undefined, eventId: string) => {
    const response = await app.inject({ method: "PUT", url: `/api/reader/${id}/progress`, payload: { locator: { section: Number(paragraphId.split(":")[0]), paragraphId, ...(quote === undefined ? {} : { quote }), progression: 0.4 }, baseRevision: revision, eventId, deviceId: "device-1", updatedAt: Date.now() } });
    if (response.statusCode === 200) revision = response.json().checkpoint.revision;
    return response;
  };
  // 0:2 was the quotation in the standard cut; in the new cut 0:2 is a sentence of the first paragraph.
  assert.equal(textOf("0:2"), "Nobody on the quay looked up from the nets.");
  const moved = (await send("0:2", "A quoted line stands here.", "event-late-1")).json().checkpoint.locator;
  assert.notEqual(moved.paragraphId, "0:2");
  assert.equal(textOf(moved.paragraphId), "A quoted line stands here.");
  assert.equal(moved.quote, "A quoted line stands here.");
  assert.equal(moved.progression, all.findIndex((sentence) => sentence.id === moved.paragraphId) / (all.length - 1));
  // In the chapter read as one block the old heading is inside a sentence: the place goes to that sentence.
  const inside = (await send("1:1", "Low water", "event-late-2")).json().checkpoint.locator;
  assert.match(textOf(inside.paragraphId), /Low water The night tide/);
  // A place of the new cut is stored as it was sent, also where the old cut had the same id.
  const kept = (await send("0:2", textOf("0:2"), "event-late-3")).json().checkpoint.locator;
  assert.deepEqual([kept.paragraphId, kept.progression], ["0:2", 0.4]);
  assert.equal((await send("0:7", undefined, "event-late-4")).json().checkpoint.locator.paragraphId, "0:7", "a place without a quote is taken by its id");
  // An id whose text is neither cut's is refused, as an unknown id is.
  for (const [paragraphId, quote] of [["0:2", "Words that are in neither cut."], ["0:9", "A quoted line stands here."], ["9:9", "x"]] as const) {
    const refused = await send(paragraphId, quote, `event-late-refused-${paragraphId}`);
    assert.equal(refused.statusCode, 400, `${paragraphId} ${quote}`);
    assert.equal(refused.json().error, "This reading position does not belong to this EPUB edition.");
  }
  // A bookmark sent the same way is stored on its own text.
  const bookmark = await app.inject({ method: "POST", url: `/api/reader/${id}/bookmarks`, payload: { id: "bookmark-late", label: "Wall", locator: { section: 0, paragraphId: "0:1", quote: "The harbour wall", progression: 0.1 } } });
  assert.equal(bookmark.statusCode, 200, bookmark.body);
  assert.equal(textOf(bookmark.json().locator.paragraphId), "The harbour wall");
  const stored = JSON.parse((sqlite.prepare("SELECT locator FROM user_reader_bookmarks WHERE id='bookmark-late'").get() as { locator: string }).locator);
  assert.equal(stored.paragraphId, bookmark.json().locator.paragraphId);
  assert.equal((await app.inject({ method: "POST", url: `/api/reader/${id}/bookmarks`, payload: { id: "bookmark-wrong", label: "No", locator: { section: 0, paragraphId: "0:2", quote: "Words that are in neither cut.", progression: 0.1 } } })).statusCode, 400);
});

test("a normal book takes a place by its id alone, whatever its quote, as before", async () => {
  const id = await edition("recut-normal-place", [prose("summer", 5).map((text) => `<p>${text}</p>`).join(""), `<p>Second chapter.</p>`]);
  const response = await app.inject({ method: "PUT", url: `/api/reader/${id}/progress`, payload: { locator: { section: 0, paragraphId: "0:3", quote: "Any words at all.", progression: 0.2 }, baseRevision: 0, eventId: "event-normal-place", deviceId: "device-1", updatedAt: Date.now() } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().checkpoint.locator, { section: 0, paragraphId: "0:3", quote: "Any words at all.", progression: 0.2 });
});

test("a normal book's saved places are never touched", async () => {
  const id = await edition("recut-untouched", [prose("summer", 5).map((text) => `<p>${text}</p>`).join(""), `<p>Second chapter.</p>`]);
  const data = JSON.stringify({ locator: { section: 0, paragraphId: "0:3", quote: "q", progression: 0.1 }, revision: 1, eventId: "event-three", deviceId: "device-1", updatedAt: 5, origin: "reading" });
  sqlite.prepare("INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(1,?,?)").run(id, data);
  await extractBook(id);
  assert.equal((sqlite.prepare("SELECT data FROM user_reader_checkpoints WHERE edition_id=?").get(id) as { data: string }).data, data);
  assert.equal(sqlite.prepare("SELECT 1 FROM settings WHERE key=?").get(`reader-recut:${id}`), undefined);
});

test("cutting a book writes nothing; the carry-over is a step of its own, and says when it ran", async () => {
  const id = await edition("recut-pure", [divChapter, looseChapter]);
  const data = JSON.stringify({ locator: { section: 0, paragraphId: "0:2", quote: "A quoted line stands here.", progression: 0.5 }, revision: 1, eventId: "event-pure-1", deviceId: "device-1", updatedAt: 5, origin: "reading" });
  sqlite.prepare("INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(1,?,?)").run(id, data);
  const place = () => (sqlite.prepare("SELECT data FROM user_reader_checkpoints WHERE edition_id=?").get(id) as { data: string }).data;
  const mark = () => sqlite.prepare("SELECT value FROM settings WHERE key=?").get(`reader-recut:${id}`) as { value: string } | undefined;
  // A database that refuses every write: the cut is still made, by extractBook and from the file alone.
  sqlite.pragma("query_only = ON");
  try {
    const book = await extractBook(id);
    assert.deepEqual(book.sections.map((section) => section.blocks), ["div", "body"]);
    const cut = await cutEpub(readFileSync(join(temp, "media", "ebooks", `${id}.epub`)));
    assert.deepEqual(cut.sections, book.sections);
    assert.equal(cut.fingerprint, book.fingerprint);
    assert.equal(cut.recut?.get("0:2")?.was, "A quoted line stands here.");
  } finally {
    sqlite.pragma("query_only = OFF");
  }
  assert.equal(place(), data, "extractBook moved nothing");
  assert.equal(mark(), undefined);
  // The step that carries the places logs the edition and how many it moved, once.
  const lines: { details: Record<string, unknown>; message: string }[] = [];
  const log = { info: (details: object, message: string) => void lines.push({ details: details as Record<string, unknown>, message }) };
  await bookWithPlaces(id, log);
  await bookWithPlaces(id, log);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].details, { edition: id, places: 1 });
  assert.notEqual(place(), data);
  assert.equal(JSON.parse(mark()!.value).places, 1);
  // A book cut by the standard rule has no table and is never marked.
  assert.equal((await cutEpub(readFileSync(join(temp, "media", "ebooks", "recut-normal.epub")))).recut, null);
});
