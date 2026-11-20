import { autoQueueAlignmentsForWork } from "./alignment.ts";
import { ebookSetMembersRemoved, removePendingMembersLeftBehind } from "./ebook-set-link.ts";
import { currentUserId } from "./users.ts";
import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { parse, type HTMLElement } from "node-html-parser";
import { readFileSync, statSync, existsSync } from "node:fs";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import {
  LOW_SHARE_BOOK,
  chapterBlockRule,
  countedBlocks,
  normalizeReaderText,
  readerSkippedSelector,
  readerTextOffset,
  type ReaderBlockRule,
  type ReaderBook,
  type ReadingCheckpoint,
  type TextLocator,
} from "../src/reading-types.ts";
export function paragraphsOf(root: HTMLElement, rule?: ReaderBlockRule) {
  return countedBlocks(root, (node) => node.text, rule)
    .map((node) => normalizeReaderText(node.text))
    .filter(Boolean);
}
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
/** A chapter's sentences: each counted block's text, cut into sentences that are numbered through the chapter. */
function sentencesOf(body: HTMLElement, index: number, rule?: ReaderBlockRule, blocks = paragraphsOf(body, rule)) {
  let fragment = 0;
  return blocks.flatMap((value, blockIndex) =>
    [...segmenter.segment(value)]
      .filter((sentence) => sentence.segment.trim())
      .map((sentence) => ({
        id: `${index}:${fragment++}`,
        text: sentence.segment.trim(),
        blockIndex,
        start: sentence.index,
        end: sentence.index + sentence.segment.length,
      })),
  );
}
/**
 * Where each sentence of a chapter starts in the chapter's normalised text, whatever rule counted its blocks: what
 * two cuts of one chapter have in common. Null when the chapter's text cannot be walked node by node.
 */
function sentencePlaces(body: HTMLElement, sentences: ReturnType<typeof sentencesOf>, rule?: ReaderBlockRule) {
  const before = new Map<unknown, string>();
  let raw = "";
  const walk = (node: HTMLElement) => {
    before.set(node, raw);
    if (!node.childNodes.length) raw += node.text;
    else for (const child of node.childNodes) walk(child as HTMLElement);
  };
  walk(body);
  if (raw !== body.text) return null;
  const starts = countedBlocks(body, (node) => node.text, rule)
    .filter((block) => normalizeReaderText(block.text))
    .map((block) => readerTextOffset((before.get(block) ?? "") + (/^\s*/.exec(block.text)?.[0] ?? "")));
  return sentences.map((sentence) => ({ ...sentence, place: (starts[sentence.blockIndex] ?? 0) + sentence.start }));
}
/** For a book cut by another rule (ADR 0026): each sentence of its standard cut, and the sentence that holds it now. */
type Recut = Map<string, { id: string; text: string; was: string }>;
type Log = { info: (details: object, message: string) => void };
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  processEntities: false,
});
const array = (value: any): any[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value: any): string => String(value?.["#text"] ?? value ?? "");
const cache = new Map<
  string,
  { stamp: string; book: Omit<ReaderBook, "checkpoint" | "bookmarks">; recut: Recut | null }
>();
export function ebookRecord(id: string) {
  if (id.startsWith("set-consensus:")) {
    const workId = id.slice("set-consensus:".length);
    const row = db
      .select()
      .from(s.works)
      .where(eq(s.works.id, workId))
      .get();
    if (!row) throw new Error("The selected book could not be found.");
    return {
      id,
      workId,
      format: "epub" as const,
      source: id,
    };
  }
  const row = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, id))
    .get();
  // A removed edition is permanent; a missing file may be a volume that is remounting (N1).
  if (!row || !existsSync(row.source))
    throw Object.assign(
      new Error("This ebook is no longer on the media drive."),
      { statusCode: row ? 503 : 404 },
    );
  if (row.format !== "epub")
    throw new Error(
      "The built-in reader supports EPUB. Download PDFs to use your preferred PDF reader.",
    );
  return row;
}
/**
 * The cut of an EPUB file into chapters and sentences, from the file alone: no database is read or written, so it
 * gives the same cut wherever it runs. `recut` is set for a book cut by another rule than the standard one.
 */
export async function cutEpub(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (
    entries.length > 5000 ||
    entries.reduce(
      (size, entry) => size + ((entry as any)._data?.uncompressedSize || 0),
      0,
    ) >
      256 * 1024 * 1024
  )
    throw new Error("This EPUB contains too many or oversized resources.");
  const load = async (name: string) => {
    const entry = zip.file(name);
    if (
      !entry ||
      name.includes("..") ||
      ((entry as any)._data?.uncompressedSize || 0) > 5 * 1024 * 1024
    )
      throw new Error("The EPUB contains an invalid or oversized chapter.");
    const value = await entry.async("string");
    if (value.length > 5 * 1024 * 1024)
      throw new Error("The EPUB chapter is too large.");
    return value;
  };
  const container = xml.parse(await load("META-INF/container.xml")),
    opfPath = array(container.container?.rootfiles?.rootfile)[0]?.["full-path"];
  if (typeof opfPath !== "string")
    throw new Error("This EPUB has no readable book manifest.");
  const pkg = xml.parse(await load(opfPath)).package;
  if (!pkg?.manifest || !pkg.spine)
    throw new Error("This EPUB has no reading order.");
  const items = new Map(
      array(pkg.manifest.item).map((item) => [item.id, item]),
    ),
    base = posix.dirname(opfPath);
  const chapter = async (index: number, item: any) => {
    const href = posix.normalize(
      posix.join(base, decodeURIComponent(item.href.split("#")[0])),
    );
    if (href.startsWith("../") || href.startsWith("/"))
      throw new Error("This EPUB contains an invalid chapter path.");
    const root = parse(await load(href));
    root
      .querySelectorAll(readerSkippedSelector)
      .forEach((node) => node.remove());
    return root.querySelector("body") || root;
  };
  const section = (index: number, item: any, body: HTMLElement, paragraphs: ReturnType<typeof sentencesOf>) => ({
    index,
    href: String(item.href),
    title: (body.querySelector("h1,h2,h3")?.text || `Section ${index + 1}`)
      .trim()
      .slice(0, 180),
    paragraphs,
  });
  const chapters = (array(pkg.spine.itemref) as any[])
    .map((ref, index) => ({ index, item: items.get(ref.idref) as any }))
    .filter(({ item }) => item && String(item["media-type"]).includes("html"));
  let sections: ReaderBook["sections"] = [];
  // The standard cut, and with it how much of the book's text its blocks hold.
  let held = 0,
    total = 0;
  for (const { index, item } of chapters) {
    const body = await chapter(index, item);
    const blocks = paragraphsOf(body);
    const paragraphs = sentencesOf(body, index, undefined, blocks);
    total += normalizeReaderText(body.text).length;
    held += blocks.reduce((sum, text) => sum + text.length, 0);
    if (paragraphs.length) sections.push(section(index, item, body, paragraphs));
  }
  let carried: Recut | null = null;
  if (total && held / total < LOW_SHARE_BOOK) {
    // The book's paragraphs are not the standard blocks (ADR 0026): each chapter is cut by the first rule that
    // holds its text. Places saved in the standard cut are found again by where their sentence starts.
    sections = [];
    carried = new Map();
    for (const { index, item } of chapters) {
      const body = await chapter(index, item);
      const rule = chapterBlockRule(body, (node) => node.text);
      const paragraphs = sentencesOf(body, index, rule);
      if (paragraphs.length) sections.push({ ...section(index, item, body, paragraphs), ...(rule ? { blocks: rule } : {}) });
      if (!rule) continue;
      const standard = sentencesOf(body, index),
        was = sentencePlaces(body, standard),
        now = sentencePlaces(body, paragraphs, rule);
      for (const [ordinal, old] of standard.entries()) {
        // The sentence that holds the old one's first character; where the chapter's text cannot be walked, the
        // first that holds its text.
        const to = was && now ? now.filter((sentence) => sentence.place <= was[ordinal].place).at(-1) : paragraphs.find((sentence) => sentence.text.includes(old.text));
        const target = to ?? paragraphs[0];
        if (target) carried.set(old.id, { id: target.id, text: target.text, was: old.text });
      }
    }
  }
  if (!sections.length) throw new Error("This EPUB contains no readable text.");
  return {
    sections,
    language: text(pkg.metadata?.language) || "en",
    fingerprint: createHash("sha256").update(buffer).digest("hex"),
    recut: carried,
  };
}
/**
 * Version of extractBook's cut: which text is a sentence and what id it gets. Raise it with any change to that
 * (here, `countedBlocks` or `normalizeReaderText`), so that prepared text kept on disk (server/prepared-text-cache.ts)
 * is made again from the new cut. It changes nothing in the output itself. 2: a book without paragraph elements is
 * cut by another rule (ADR 0026).
 */
export const EXTRACTOR_VERSION = 2;
export async function extractBook(id: string) {
  if (id.startsWith("set-consensus:")) {
    const workId = id.slice("set-consensus:".length);
    const { readConsensusSentences, consensusReaderBook } = await import(
      "./ebook-set-consensus.ts"
    );
    const sentences = readConsensusSentences(workId);
    if (!sentences.length)
      throw new Error("This work has no ebook-set consensus text yet.");
    return consensusReaderBook(workId, sentences, "en");
  }
  const row = ebookRecord(id),
    stat = statSync(row.source),
    stamp = `${stat.size}:${stat.mtimeMs}`;
  if (cache.get(id)?.stamp === stamp) return cache.get(id)!.book;
  if (stat.size > 150 * 1024 * 1024)
    throw new Error("This EPUB exceeds the reader’s 150 MB limit.");
  const cut = await cutEpub(readFileSync(row.source));
  const work = db
    .select()
    .from(s.works)
    .where(eq(s.works.id, row.workId))
    .get()!;
  const book = {
    id,
    workId: row.workId,
    title: work.title,
    author: work.author,
    language: cut.language,
    fingerprint: cut.fingerprint,
    sections: cut.sections,
    toc: cut.sections.map((section) => ({
      label: section.title,
      href: section.href,
      section: section.index,
    })),
  };
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
  cache.set(id, { stamp, book, recut: cut.recut });
  return book;
}
/** A sentence's place among the book's sentences, from 0 to 1, as the reader gives it to a place it saves. */
function progressionOf(book: { sections: ReaderBook["sections"] }, paragraphId: string) {
  const all = book.sections.flatMap((section) => section.paragraphs);
  return Math.max(0, all.findIndex((sentence) => sentence.id === paragraphId)) / Math.max(1, all.length - 1);
}
/**
 * The book, with the places saved in it carried over to its cut: what a route that answers or stores a place reads.
 * For a book cut by another rule (ADR 0026) the reading places and bookmarks saved in its standard cut are moved
 * to the sentence that holds them now, once: the edition is marked in the same transaction, so a second run finds
 * nothing to do. A moved reading place gets the next revision, so a device that still holds the old one is told of
 * the newer place.
 */
export async function bookWithPlaces(id: string, log?: Log) {
  const book = await extractBook(id);
  const recut = cache.get(id)?.recut;
  if (!recut) return { book, recut: null };
  const key = `reader-recut:${id}`;
  const places = sqlite.transaction(() => {
    if (sqlite.prepare("SELECT 1 FROM settings WHERE key=?").get(key)) return null;
    const moved = <T extends TextLocator>(locator: T): T | null => {
      const to = recut.get(locator.paragraphId);
      return to ? { ...locator, paragraphId: to.id, quote: to.text.slice(0, 300), progression: progressionOf(book, to.id) } : null;
    };
    let count = 0;
    for (const row of sqlite.prepare("SELECT user_id AS userId,data FROM user_reader_checkpoints WHERE edition_id=?").all(id) as { userId: number; data: string }[]) {
      const checkpoint = JSON.parse(row.data) as ReadingCheckpoint;
      const locator = moved(checkpoint.locator);
      if (!locator) continue;
      sqlite.prepare("UPDATE user_reader_checkpoints SET data=? WHERE edition_id=? AND user_id=?").run(JSON.stringify({ ...checkpoint, locator, revision: checkpoint.revision + 1 }), id, row.userId);
      count++;
    }
    for (const row of sqlite.prepare("SELECT user_id AS userId,id AS bookmark,locator FROM user_reader_bookmarks WHERE edition_id=?").all(id) as { userId: number; bookmark: string; locator: string }[]) {
      const locator = moved(JSON.parse(row.locator) as TextLocator);
      if (!locator) continue;
      sqlite.prepare("UPDATE user_reader_bookmarks SET locator=? WHERE edition_id=? AND user_id=? AND id=?").run(JSON.stringify(locator), id, row.userId, row.bookmark);
      count++;
    }
    sqlite.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(key, JSON.stringify({ places: count, at: Date.now() }));
    return count;
  })();
  if (places !== null) log?.info({ edition: id, places }, "reader: the book is cut by another block rule; places saved in its standard cut were moved");
  return { book, recut };
}
/**
 * A place a device sends, as a place in the book's cut; null when it is in neither cut. In a book cut by another
 * rule (ADR 0026) a device that read on its stored copy still names sentences of the standard cut, and ids of the
 * two cuts overlap. The place's quote, the start of its sentence, tells them apart: a place whose sentence does not
 * start with its quote but whose standard-cut sentence does is moved to the sentence that holds it now.
 */
export function placeInCut<T extends TextLocator>(book: { sections: ReaderBook["sections"] }, recut: Recut | null, locator: T): T | null {
  const sentence = book.sections.flatMap((section) => section.paragraphs).find((paragraph) => paragraph.id === locator.paragraphId);
  if (!recut) return sentence ? locator : null;
  if (sentence && (!locator.quote || sentence.text.startsWith(locator.quote))) return locator;
  const old = recut.get(locator.paragraphId);
  if (!old || !locator.quote || !old.was.startsWith(locator.quote)) return null;
  return { ...locator, paragraphId: old.id, quote: old.text.slice(0, 300), progression: progressionOf(book, old.id) };
}
export function invalidateParsedBook(id: string) {
  cache.delete(id);
}
export const locatorSchema = z.object({
  cfi: z.string().max(2500).optional(),
  section: z.number().int().min(0),
  paragraphId: z.string().regex(/^\d+:\d+$/),
  quote: z.string().max(500).optional(),
  progression: z.number().min(0).max(1),
});
export function readerCheckpoint(id: string, userId = 1): ReadingCheckpoint | null {
  const row = sqlite
    .prepare("SELECT data FROM user_reader_checkpoints WHERE edition_id=? AND user_id=?")
    .get(id, userId) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}
export function registerReader(app: FastifyInstance) {
  app.post("/api/reader/:id/link", async (req) => {
    const { id } = req.params as { id: string };
    const { workId } = z.object({ workId: z.string() }).parse(req.body);
    ebookRecord(id);
    if (!db.select().from(s.works).where(eq(s.works.id, workId)).get())
      throw new Error("This audiobook could not be found.");
    // Its pending ebook-set member in the work it leaves goes with the link change (#325); the work it joins gets
    // what it got on main: no member, and the auto-queue below.
    const left = sqlite.transaction(() => {
      db.update(s.ebookEditions)
        .set({ workId })
        .where(eq(s.ebookEditions.id, id))
        .run();
      return removePendingMembersLeftBehind(id, workId);
    })();
    invalidateParsedBook(id);
    await ebookSetMembersRemoved(left);
    await autoQueueAlignmentsForWork(workId, { ebookId: id }, req.log);
    return { ok: true };
  });
  /** What this user saved in the edition: where they are and their bookmarks. */
  const savedState = (id: string, userId: number) => {
    const bookmarks = sqlite
      .prepare(
        "SELECT id,label,locator,created_at AS createdAt FROM user_reader_bookmarks WHERE edition_id=? AND user_id=? ORDER BY created_at",
      )
      .all(id, userId) as { id: string; label: string; locator: string; createdAt: number }[];
    return {
      checkpoint: readerCheckpoint(id, userId),
      bookmarks: bookmarks.map((bookmark) => ({
        ...bookmark,
        locator: JSON.parse(bookmark.locator),
      })),
    };
  };
  app.get("/api/reader/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { book } = await bookWithPlaces(id, req.log);
    return { ...book, ...savedState(id, currentUserId(req)) };
  });
  // The reader of prepared text (ADR 0025) takes the book's text from the prepared parts, so it asks for what the
  // user saved without the sentences. The edition is checked and its saved places are carried over to its cut
  // (ADR 0026) exactly as the route above does, so a place answered here names a sentence of the prepared text.
  app.get("/api/reader/:id/state", async (req, reply) => {
    const { id } = req.params as { id: string };
    await bookWithPlaces(id, req.log);
    const record = ebookRecord(id);
    const work = db.select().from(s.works).where(eq(s.works.id, record.workId)).get();
    reply.header("Cache-Control", "private, no-store");
    return { id, workId: record.workId, title: work?.title ?? "", author: work?.author ?? "", ...savedState(id, currentUserId(req)) };
  });
  // The reader of prepared text makes a part's nodes against an allow-list (src/prepared-html.ts) and leaves out what
  // is not on it. The server's own sanitiser should have left nothing to leave out, so each such part is reported
  // here once and logged: a miss in the sanitiser is seen, not papered over.
  app.post("/api/reader/:id/prepared-refused", { bodyLimit: 4096 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = z
      .object({ key: z.string().regex(/^[0-9a-f]{16}$/), part: z.number().int().min(0).max(99999), refused: z.array(z.string().min(1).max(80)).min(1).max(20) })
      .parse(req.body);
    ebookRecord(id);
    // A reason may quote the book (a class, an id): only printable characters reach the log.
    const refused = input.refused.map((reason) => reason.replace(/[^\x20-\x7e]/g, "?"));
    req.log.warn({ edition: id, key: input.key, part: input.part, refused }, "prepared text: the reader refused markup the sanitiser let through");
    return reply.code(204).send();
  });
  app.put("/api/reader/:id/progress", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = z
      .object({
        locator: locatorSchema,
        baseRevision: z.number().int().min(0),
        eventId: z.string().min(8).max(100),
        deviceId: z.string().min(4).max(100),
        updatedAt: z
          .number()
          .int()
          .min(0)
          .max(Date.now() + 300000),
        recordingId: z.string().max(150).optional(),
        origin: z.enum(["reading", "listening"]).default("reading"),
        resolve: z.boolean().optional(),
      })
      .parse(req.body);
    const { book, recut } = await bookWithPlaces(id, req.log);
    const locator = placeInCut(book, recut, input.locator);
    if (!locator)
      throw new Error(
        "This reading position does not belong to this EPUB edition.",
      );
    input.locator = locator;
    return sqlite.transaction(() => {
      const current = readerCheckpoint(id, currentUserId(req)),
        duplicate = sqlite
          .prepare(
            "SELECT event_id FROM user_reader_events WHERE event_id=? AND edition_id=? AND user_id=?",
          )
          .get(input.eventId, id, currentUserId(req));
      if (duplicate) return { checkpoint: current, duplicate: true };
      if (input.baseRevision !== (current?.revision || 0))
        return reply
          .code(409)
          .send({
            error:
              "This book has a newer position from another session. Choose which place to keep.",
            conflict: true,
            current,
            attempted: input,
          });
      const checkpoint: ReadingCheckpoint = {
        locator: input.locator,
        revision: (current?.revision || 0) + 1,
        eventId: input.eventId,
        deviceId: input.deviceId,
        updatedAt: Date.now(),
        origin: input.origin,
        ...(input.recordingId ? { recordingId: input.recordingId } : {}),
      };
      sqlite
        .prepare(
          "INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(?,?,?) ON CONFLICT(user_id,edition_id) DO UPDATE SET data=excluded.data",
        )
        .run(currentUserId(req), id, JSON.stringify(checkpoint));
      sqlite
        .prepare("INSERT INTO user_reader_events(user_id,event_id,edition_id) VALUES(?,?,?)")
        .run(currentUserId(req), input.eventId, id);
      return { checkpoint };
    })();
  });
  app.post("/api/reader/:id/bookmarks", async (req) => {
    const { id } = req.params as { id: string };
    const input = z
      .object({
        id: z.string().min(8).max(100),
        label: z.string().min(1).max(200),
        locator: locatorSchema,
      })
      .parse(req.body);
    const { book, recut } = await bookWithPlaces(id, req.log);
    const locator = placeInCut(book, recut, input.locator);
    if (!locator) throw new Error("This bookmark does not belong to this edition.");
    input.locator = locator;
    sqlite
      .prepare(
        "INSERT INTO user_reader_bookmarks(user_id,id,edition_id,label,locator,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET label=excluded.label,locator=excluded.locator WHERE edition_id=excluded.edition_id",
      )
      .run(
        currentUserId(req),
        input.id,
        id,
        input.label,
        JSON.stringify(input.locator),
        Date.now(),
      );
    return input;
  });
  app.delete("/api/reader/:id/bookmarks/:bookmark", (req) => {
    const { id, bookmark } = req.params as { id: string; bookmark: string };
    sqlite
      .prepare("DELETE FROM user_reader_bookmarks WHERE edition_id=? AND id=? AND user_id=?")
      .run(id, bookmark, currentUserId(req));
    return { ok: true };
  });
}
