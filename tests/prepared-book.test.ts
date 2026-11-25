// Where a sentence is in a book, from the prepared manifest (src/prepared-book.ts) and from the sentences
// themselves (src/reader-places.ts): the new reading view and today's reader ask the same questions and must get
// the same answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareEpub } from "../server/prepared-text.ts";
import { preparedFixture } from "./prepared-text-fixture.ts";

// lib.ts, which prepared-book.ts takes its transport from, reads the browser's storage as it loads.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) },
  window: Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }),
});
const { sentenceIndex, positionInBook, patiently, preparedBook, PreparedStaleError, LOAD_ATTEMPTS, LOAD_WAITS_MS } = await import("../src/prepared-book.ts");
const { ApiError } = await import("../src/lib.ts");
const { sentencePlaces } = await import("../src/reader-places.ts");

/** Sections as extractBook cuts them, from plain sentences per chapter: `<section>:<n>` ids in reading order. */
function sectionsOf(chapters: string[][], indexes: number[]) {
  return chapters.map((sentences, at) => {
    return {
      index: indexes[at]!,
      href: `c${at}.xhtml`,
      title: `Chapter ${at + 1}`,
      paragraphs: sentences.map((text, number) => ({ id: `${indexes[at]}:${number}`, text, blockIndex: number, start: 0, end: text.length })),
    };
  });
}

test("the manifest places every sentence where the sentences themselves do", async () => {
  // Chapters long enough for several parts, and a spine whose second file has no text (its index is skipped).
  const chapters = [0, 1, 2].map((chapter) => Array.from({ length: 900 }, (_unused, number) => `Chapter ${chapter} sentence ${number} is a sentence of some length to fill the parts of this book.`));
  const files: Record<string, string> = {
    "c0.xhtml": chapters[0]!.map((text) => `<p>${text}</p>`).join(""),
    "empty.xhtml": "<div></div>",
    "c1.xhtml": chapters[1]!.map((text) => `<p>${text}</p>`).join(""),
    "c2.xhtml": chapters[2]!.map((text) => `<p>${text}</p>`).join(""),
  };
  const sections = sectionsOf(chapters, [0, 2, 3]);
  const { manifest } = await prepareEpub({
    epub: await preparedFixture({ chapters: files }),
    book: { id: "ed", fingerprint: "f", language: "en", sections },
    base: "/api/reader/ed/prepared/0123456789abcdef",
    key: "0123456789abcdef",
    writePicture: async () => {},
  });
  assert.deepEqual(manifest.problems, []);
  assert.ok(manifest.parts.length > 2, `${manifest.parts.length} parts`);
  const index = sentenceIndex(manifest);
  const places = sentencePlaces(sections);
  assert.equal(index.total, places.total);
  assert.equal(index.total, 2700);
  for (let ordinal = 0; ordinal < places.total; ordinal++) {
    const id = places.idAt(ordinal)!;
    assert.equal(index.idAt(ordinal), id);
    assert.equal(index.ordinalOf(id), ordinal);
    assert.equal(index.sectionOf(id), places.sectionOf(id));
    const part = manifest.parts[index.partOf(id)]!;
    assert.ok(ordinal >= part.ordinal && ordinal < part.ordinal + part.sentences, id);
  }
  for (const section of sections) assert.deepEqual(index.sectionSpan(section.index), places.sectionSpan(section.index));
  assert.equal(index.progression("0:0"), 0);
  assert.equal(index.progression("3:899"), 1);
  // What the book does not have.
  for (const id of ["1:0", "9:0", "0:900", "x", ""]) {
    assert.equal(index.ordinalOf(id), -1, id);
    assert.equal(index.partOf(id), -1, id);
    assert.equal(places.ordinalOf(id), -1, id);
  }
  assert.equal(index.ordinalOf(undefined), -1);
  assert.equal(index.idAt(-1), undefined);
  assert.equal(index.idAt(2700), undefined);
  assert.equal(places.idAt(2700), undefined);
  assert.equal(index.sectionOf("x"), null);
  assert.deepEqual(index.sectionSpan(1), { start: 0, count: 0 });
  assert.deepEqual(places.sectionSpan(1), { start: 0, count: 0 });
});

test("a sentence's position in the whole book comes from the manifest alone, rises with the reading order and ends near 1", async () => {
  const chapters = [0, 1, 2].map((chapter) => Array.from({ length: 900 }, (_unused, number) => `Chapter ${chapter} sentence ${number} is a sentence of some length to fill the parts of this book.`));
  const files: Record<string, string> = Object.fromEntries(chapters.map((chapter, at) => [`c${at}.xhtml`, chapter.map((text) => `<p>${text}</p>`).join("")]));
  const sections = sectionsOf(chapters, [0, 1, 2]);
  const { manifest } = await prepareEpub({
    epub: await preparedFixture({ chapters: files }),
    book: { id: "ed", fingerprint: "f", language: "en", sections },
    base: "/api/reader/ed/prepared/0123456789abcdef",
    key: "0123456789abcdef",
    writePicture: async () => {},
  });
  assert.ok(manifest.parts.length > 2);
  const index = sentenceIndex(manifest);
  const ids = sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.id));
  let before = -1;
  for (const id of ids) {
    const position = positionInBook(manifest, index, id);
    assert.ok(position > before || (before === 0 && position === 0), `${id}: ${position} after ${before}`);
    assert.ok(position >= 0 && position <= 1);
    before = position;
  }
  assert.equal(positionInBook(manifest, index, ids[0]!), 0);
  assert.ok(before > 0.99, `the last sentence is at ${before}`);
  // Sentences of one length: the position is the share of the sentences before, within a hundredth.
  for (const at of [300, 1350, 2400]) assert.ok(Math.abs(positionInBook(manifest, index, ids[at]!) - at / ids.length) < 0.01, `sentence ${at}`);
  // The first sentence of a part is where the parts before it end.
  const third = manifest.parts[2]!;
  assert.equal(positionInBook(manifest, index, third.first!), third.charStart / manifest.chars);
  assert.equal(positionInBook(manifest, index, "9:9"), 0);
});

test("a failed request is asked again a few times with growing waits, never without end; a refusal that stands is not asked again", async () => {
  const run = async (answers: unknown[]) => {
    let asked = 0;
    const waits: number[] = [];
    const outcome = await patiently(
      async () => {
        const answer = answers[Math.min(asked++, answers.length - 1)];
        if (answer instanceof Error) throw answer;
        return answer;
      },
      async (ms) => void waits.push(ms),
    ).then((value) => ({ value }), (error: Error) => ({ error }));
    return { asked, waits, ...outcome };
  };
  const failed = (status: number, retryAfter?: number) => new ApiError("refused", status, undefined, retryAfter);
  assert.equal(LOAD_ATTEMPTS, 3);
  // A server error and no answer at all: three attempts, the waits as set, then the failure is the caller's.
  for (const error of [failed(500), failed(503), new TypeError("Failed to fetch")]) {
    const always = await run([error]);
    assert.equal(always.asked, 3);
    assert.deepEqual(always.waits, LOAD_WAITS_MS);
    assert.equal((always as { error: Error }).error, error);
  }
  // It mends: the answer of the second attempt is the answer.
  assert.deepEqual(await run([failed(500), "the part"]), { asked: 2, waits: [LOAD_WAITS_MS[0]], value: "the part" });
  // Refusals that asking again cannot change are asked once.
  for (const error of [failed(404), failed(401), failed(403), failed(400), new PreparedStaleError()]) assert.equal((await run([error])).asked, 1, error.message);
  // Too many requests: never asked again by itself, unless the server names a short wait, which is kept.
  assert.equal((await run([failed(429)])).asked, 1);
  assert.equal((await run([failed(429, 60)])).asked, 1);
  const short = await run([failed(429, 2), "the part"]);
  assert.deepEqual([short.asked, short.waits], [2, [2000]]);
  assert.equal((await run([failed(429, 2)])).asked, 3);
});

test("a part that could not be loaded stays failed without another request, until the reader asks again", async () => {
  // The server as the book's loader sees it: a manifest, a part that fails until it is mended, one that works.
  const asked: string[] = [];
  let mended = false;
  const native = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    asked.push(path);
    if (path.endsWith("/prepared")) return Response.json({ key: "0123456789abcdef", parts: [], sections: [], sentences: 0, fingerprint: "f" });
    if (path.endsWith("/parts/1") && !mended) return Response.json({ error: "no" }, { status: 500 });
    return new Response("<p>text</p>", { status: 200 });
  }) as typeof fetch;
  try {
    const book = await preparedBook("ed-kept-failure");
    const of = (part: number) => asked.filter((path) => path.endsWith(`/parts/${part}`)).length;
    await assert.rejects(book.part(1));
    assert.equal(of(1), LOAD_ATTEMPTS);
    // Wanted again and again, as a view near the end of its text wants it: the same failure, no request.
    for (let again = 0; again < 50; again++) await assert.rejects(book.part(1));
    assert.equal(of(1), LOAD_ATTEMPTS);
    // A part that arrived is asked for once.
    assert.equal(await book.part(0), "<p>text</p>");
    assert.equal(await book.part(0), "<p>text</p>");
    assert.equal(of(0), 1);
    // The reader's Retry: asked anew, and it arrives.
    mended = true;
    book.retry();
    assert.equal(await book.part(1), "<p>text</p>");
    assert.equal(of(1), LOAD_ATTEMPTS + 1);
    assert.equal(asked.filter((path) => path.endsWith("/prepared")).length, 1);
  } finally {
    globalThis.fetch = native;
  }
});
