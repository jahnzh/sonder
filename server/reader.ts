import { autoQueueAlignmentsForWork } from "./alignment.ts";
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
  countedBlocks,
  normalizeReaderText,
  readerSkippedSelector,
  type ReaderBook,
  type ReadingCheckpoint,
  type TextLocator,
} from "../src/reading-types.ts";
import { queueHardcoverReadingProgress } from "./hardcover.ts";
export function paragraphsOf(root: HTMLElement) {
  return countedBlocks(root, (node) => node.text)
    .map((node) => normalizeReaderText(node.text))
    .filter(Boolean);
}
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
  { stamp: string; book: Omit<ReaderBook, "checkpoint" | "bookmarks"> }
>();
export function ebookRecord(id: string) {
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
export async function extractBook(id: string) {
  const row = ebookRecord(id),
    stat = statSync(row.source),
    stamp = `${stat.size}:${stat.mtimeMs}`;
  if (cache.get(id)?.stamp === stamp) return cache.get(id)!.book;
  if (stat.size > 150 * 1024 * 1024)
    throw new Error("This EPUB exceeds the reader’s 150 MB limit.");
  const buffer = readFileSync(row.source),
    zip = await JSZip.loadAsync(buffer);
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
  const work = db
    .select()
    .from(s.works)
    .where(eq(s.works.id, row.workId))
    .get()!;
  const sections: ReaderBook["sections"] = [];
  for (const [index, ref] of array(pkg.spine.itemref).entries()) {
    const item = items.get(ref.idref);
    if (!item || !String(item["media-type"]).includes("html")) continue;
    const href = posix.normalize(
      posix.join(base, decodeURIComponent(item.href.split("#")[0])),
    );
    if (href.startsWith("../") || href.startsWith("/"))
      throw new Error("This EPUB contains an invalid chapter path.");
    const root = parse(await load(href));
    root
      .querySelectorAll(readerSkippedSelector)
      .forEach((node) => node.remove());
    const body = root.querySelector("body") || root;
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    let fragment = 0;
    const paragraphs = paragraphsOf(body).flatMap((value, blockIndex) =>
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
    if (paragraphs.length)
      sections.push({
        index,
        href: String(item.href),
        title: (body.querySelector("h1,h2,h3")?.text || `Section ${index + 1}`)
          .trim()
          .slice(0, 180),
        paragraphs,
      });
  }
  if (!sections.length) throw new Error("This EPUB contains no readable text.");
  const book = {
    id,
    workId: row.workId,
    title: work.title,
    author: work.author,
    language: text(pkg.metadata?.language) || "en",
    fingerprint: createHash("sha256").update(buffer).digest("hex"),
    sections,
    toc: sections.map((section) => ({
      label: section.title,
      href: section.href,
      section: section.index,
    })),
  };
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
  cache.set(id, { stamp, book });
  return book;
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
    db.update(s.ebookEditions)
      .set({ workId })
      .where(eq(s.ebookEditions.id, id))
      .run();
    invalidateParsedBook(id);
    await autoQueueAlignmentsForWork(workId, { ebookId: id }, req.log);
    return { ok: true };
  });
  app.get("/api/reader/:id", async (req) => {
    const { id } = req.params as { id: string };
    const book = await extractBook(id);
    const bookmarks = sqlite
      .prepare(
        "SELECT id,label,locator FROM user_reader_bookmarks WHERE edition_id=? AND user_id=? ORDER BY created_at",
      )
      .all(id, currentUserId(req)) as { id: string; label: string; locator: string }[];
    return {
      ...book,
      checkpoint: readerCheckpoint(id, currentUserId(req)),
      bookmarks: bookmarks.map((bookmark) => ({
        ...bookmark,
        locator: JSON.parse(bookmark.locator),
      })),
    };
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
    const book = await extractBook(id);
    if (
      !book.sections.some((section) =>
        section.paragraphs.some(
          (paragraph) => paragraph.id === input.locator.paragraphId,
        ),
      )
    )
      throw new Error(
        "This reading position does not belong to this EPUB edition.",
      );
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
      if (input.origin === "reading")
        queueHardcoverReadingProgress(
          currentUserId(req),
          book.workId,
          input.locator.progression,
          input.recordingId,
        );
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
    const book = await extractBook(id);
    if (
      !book.sections.some((section) =>
        section.paragraphs.some(
          (paragraph) => paragraph.id === input.locator.paragraphId,
        ),
      )
    )
      throw new Error("This bookmark does not belong to this edition.");
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
