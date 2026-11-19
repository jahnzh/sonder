// Matching a book's details from a provider (#719 part b), on #721's provider layer (the same calls, cache, limiter
// and failure reasons as the match page and Discover):
//
// - The comparison: one provider's book against the work, field by field (title, subtitle, authors, narrators per
//   recording, series and position, genres, publisher, year, language, ISBN, ASIN, description, cover). Ticked by
//   default are the fields the work has no value for and the provider has ('Fill only what's missing').
// - Applying writes the ticked fields as part a's overrides with the provider named as their source; a field not ticked
//   stays as it is. The work's catalogue link is not changed (the match page links).
// - 'Match automatically' takes a sure match only (the work's own link, or `matchWork`'s: the file's ASIN, or #754's
//   `decide`, where entries of the same title and author are one work's duplicates and only different works leave it
//   unsure) and fills missing fields only. A series runs it over its works in the background, one row
//   each in `metadata_match_jobs`, which Activity lists with the reason and Retry.
// - Covers are a provider's address, shown by URL and never downloaded; a description is read from a live answer only
//   (the cache never holds one) and kept a few minutes in memory between the comparison and Apply.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlite } from "./db.ts";
import { currentUserId, requireAdmin } from "./users.ts";
import { CATALOGUE_PROVIDERS, CatalogueError, isEnglish, type CatalogueProviderName, type Priority } from "./catalogue-provider.ts";
import { audiobookDbBook, audiobookDbReleases, type CatalogueRelease } from "./audiobookdb.ts";
import { openLibraryAuthor, openLibraryWork } from "./openlibrary.ts";
import { googleBooksVolume } from "./googlebooks.ts";
import { itunesAudiobook } from "./itunes.ts";
import { englishRelease, matchWork, pickRelease, providerLinks, workLink, workRecordings } from "./catalogue-links.ts";
import { fieldInputs, writeNarrators, writeWorkEdits } from "./work-metadata.ts";
import type { MetadataReader } from "./work-metadata.ts";
import { MATCH_FIELDS, type MatchField, type MatchRow, type MetadataApplied, type MetadataComparison, type SeriesEntry, type WorkFieldValues, type WorkMetadata } from "../src/types.ts";

/** What a provider gives for the comparison; null (or an empty list) where it gives nothing. */
export type ProviderFields = {
  title: string | null;
  subtitle: string | null;
  authors: string[];
  series: SeriesEntry[];
  genres: string[];
  publisher: string | null;
  year: number | null;
  language: string | null;
  isbn: string | null;
  asin: string | null;
  description: string | null;
  cover: string | null;
  /** The narrators of the book (the release picked for the work's first recording on AudiobookDB). */
  narrators: string[];
  /** AudiobookDB: each recording's narrators by the release it surely is (`pickRelease`), where one is. */
  recordingNarrators: Record<string, string[]>;
};

const LANGUAGES: Record<string, string> = {
  en: "English", eng: "English", english: "English",
  de: "German", ger: "German", deu: "German", german: "German",
  fr: "French", fre: "French", fra: "French", french: "French",
  es: "Spanish", spa: "Spanish", spanish: "Spanish",
  it: "Italian", ita: "Italian", italian: "Italian",
  nl: "Dutch", dut: "Dutch", nld: "Dutch", dutch: "Dutch",
};
/** A language as a person reads it: "en", "eng" and "English" are English. */
export function languageName(value: string | null | undefined): string {
  const clean = (value ?? "").trim();
  if (!clean) return "";
  return LANGUAGES[clean.toLowerCase().replace(/[-_].*$/, "")] ?? clean;
}
/** A field value the work's input check accepts, or null (a provider's ISBN with letters, an ASIN of another shape). */
function accepted<F extends keyof typeof fieldInputs>(field: F, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const parsed = fieldInputs[field].safeParse(value);
  return parsed.success ? parsed.data : null;
}
const names = (list: string[] | undefined) => [...new Set((list ?? []).map((name) => name.trim()).filter(Boolean))].slice(0, 50);
const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
/** The generated covers (`/covers/<name>.svg`) stand for no cover. */
const isDefaultCover = (cover: string) => !cover || /^\/covers\/[a-z0-9-]+\.svg$/.test(cover);

// ---- Reading a provider's book ----
const MEMO_MS = 10 * 60_000;
const memo = new Map<string, { at: number; fields: ProviderFields }>();
/** Tests: forget what was read. */
export const forgetProviderFields = () => memo.clear();

function audiobookDbSeries(series: { id: string | null; name: string; position: string | null; sort: number | null }[]): SeriesEntry[] {
  return series.slice(0, 20).map((entry) => {
    const position = entry.sort ?? (entry.position && /^\d+(?:\.\d+)?$/.test(entry.position) ? Number(entry.position) : null);
    return { id: entry.id, name: entry.name, position, positionLabel: entry.position ?? (position != null ? String(position) : null), local: !entry.id };
  });
}

/**
 * One provider's book read for the comparison: a live detail answer (the description is never cached), then kept for
 * `MEMO_MS` so Apply reads the same values without another request.
 */
export async function providerFields(provider: CatalogueProviderName, id: string, workId: string, priority: Priority = "interactive"): Promise<ProviderFields> {
  const key = `${provider}:${id}:${workId}`;
  const kept = memo.get(key);
  if (kept && Date.now() - kept.at < MEMO_MS) return kept.fields;
  const fields = await readProvider(provider, id, workId, priority);
  memo.set(key, { at: Date.now(), fields });
  for (const [other, entry] of memo) if (Date.now() - entry.at >= MEMO_MS) memo.delete(other);
  return fields;
}

async function readProvider(provider: CatalogueProviderName, id: string, workId: string, priority: Priority): Promise<ProviderFields> {
  const base = { series: [] as SeriesEntry[], genres: [] as string[], narrators: [] as string[], recordingNarrators: {} as Record<string, string[]>, asin: null, isbn: null, publisher: null, language: null };
  if (provider === "audiobookdb") {
    const book = await audiobookDbBook(id, { priority, fresh: true });
    let releases: CatalogueRelease[] = [];
    try {
      releases = (await audiobookDbReleases(book.id, { priority })).filter(englishRelease);
    } catch (error) {
      // The book's own fields still compare; its releases' (narrator, publisher, ISBN, ASIN) are then not given.
      if (!(error instanceof CatalogueError)) throw error;
    }
    const recordings = workRecordings(workId);
    const recordingNarrators: Record<string, string[]> = {};
    let first: CatalogueRelease | null = null;
    for (const recording of recordings) {
      const picked = pickRelease(recording, releases);
      if (!picked) continue;
      first ??= picked.release;
      if (picked.release.narrators.length) recordingNarrators[recording.recordingId] = names(picked.release.narrators);
    }
    // No recording surely of one release: the book's only English release, if it has one.
    const release = first ?? (releases.length === 1 ? releases[0] : null);
    return {
      ...base,
      title: book.title,
      subtitle: book.subtitle,
      authors: names(book.authors),
      series: audiobookDbSeries(book.series),
      genres: names(book.genres),
      year: book.year,
      language: languageName(release?.language ?? book.languages.find(isEnglish) ?? book.languages[0] ?? null) || null,
      isbn: release?.isbn ?? null,
      asin: release?.asin ?? null,
      publisher: release?.publisher ?? null,
      description: book.description,
      cover: book.cover,
      narrators: names(release?.narrators.length ? release.narrators : book.narrators),
      recordingNarrators,
    };
  }
  if (provider === "openlibrary") {
    const work = await openLibraryWork(id, { priority, fresh: true });
    const authors: string[] = [];
    for (const authorId of work.authorIds.slice(0, 5)) {
      const name = await openLibraryAuthor(authorId, { priority });
      if (name) authors.push(name);
    }
    return { ...base, title: work.title, subtitle: work.subtitle, authors: names(authors), genres: names(work.subjects), year: work.year, description: work.description, cover: work.cover };
  }
  const book = provider === "googlebooks" ? await googleBooksVolume(id, { priority, fresh: true }) : await itunesAudiobook(id, { priority, fresh: true });
  return {
    ...base,
    title: book.title,
    subtitle: book.subtitle,
    authors: names(book.authors),
    genres: names(book.genres),
    year: book.year,
    language: languageName(book.languages[0] ?? null) || null,
    isbn: book.isbn ?? null,
    publisher: book.publisher ?? null,
    description: book.description,
    cover: book.cover && /^https:\/\//.test(book.cover) ? book.cover : null,
  };
}

// ---- The comparison (pure) ----
/** The provider's value of a field in the work's shape, or null when it gives none the work could hold. */
export function foundValue(field: MatchField, found: ProviderFields): unknown {
  switch (field) {
    case "title":
      return accepted("title", found.title);
    case "subtitle":
      return isEmpty(found.subtitle) ? null : accepted("subtitle", found.subtitle);
    case "authors":
    case "genres":
      return found[field].length ? accepted(field, found[field]) : null;
    case "series":
      return found.series.length ? found.series : null;
    case "publisher":
      return isEmpty(found.publisher) ? null : accepted("publisher", found.publisher);
    case "year":
      return found.year === null ? null : accepted("year", found.year);
    case "language":
      return isEmpty(found.language) ? null : accepted("language", found.language);
    case "isbn":
      return isEmpty(found.isbn) ? null : accepted("isbn", found.isbn);
    case "asin":
      return isEmpty(found.asin) ? null : accepted("asin", found.asin);
    case "description":
      return isEmpty(found.description) ? null : accepted("description", found.description);
    case "cover":
      return found.cover && /^https:\/\//.test(found.cover) ? accepted("cover", found.cover) : null;
  }
}
const seriesKey = (list: SeriesEntry[]) => list.map((entry) => `${entry.id ?? entry.name.toLowerCase()}@${entry.position ?? ""}`).join("|");
/** Whether the work's value and the provider's say the same (languages by name, series by id and position, text by case). */
export function sameValue(field: MatchField, current: unknown, found: unknown): boolean {
  if (found === null) return false;
  if (field === "language") return languageName(current as string).toLowerCase() === languageName(found as string).toLowerCase();
  if (field === "series") return seriesKey(current as SeriesEntry[]) === seriesKey(found as SeriesEntry[]);
  if (typeof current === "string" && typeof found === "string") return current.trim().toLowerCase() === found.trim().toLowerCase();
  if (Array.isArray(current) && Array.isArray(found)) return JSON.stringify(current.map((v) => String(v).toLowerCase())) === JSON.stringify(found.map((v) => String(v).toLowerCase()));
  return JSON.stringify(current) === JSON.stringify(found);
}
/** Whether the work has no value for the field: what 'Fill only what's missing' fills. */
export function missing(field: MatchField, current: unknown): boolean {
  if (field === "cover") return isDefaultCover(String(current ?? ""));
  return isEmpty(current);
}
/** One row: ticked by default only when the work has nothing there and the provider has something else. */
export function matchRow<T>(field: MatchField | "narrators", current: T, found: T | null): MatchRow<T> {
  const same = field === "narrators" ? found !== null && sameValue("authors", current, found) : sameValue(field, current, found);
  const empty = field === "narrators" ? isEmpty(current) : missing(field, current);
  return { current, found, same, ticked: found !== null && !same && empty };
}

/** The comparison of the work's values (`WorkMetadata`) with a provider's fields. */
export function compare(metadata: WorkMetadata, provider: CatalogueProviderName, id: string, found: ProviderFields): MetadataComparison {
  const values = metadata.values as WorkFieldValues;
  const fields = Object.fromEntries(MATCH_FIELDS.map((field) => [field, matchRow(field, values[field] as unknown, foundValue(field, found))])) as MetadataComparison["fields"];
  const recordings = metadata.recordings.map((recording) => {
    const own = found.recordingNarrators[recording.recordingId];
    // AudiobookDB: the narrators of the release this recording surely is; with one recording, the book's narrators.
    const theirs = own ?? (metadata.recordings.length === 1 && found.narrators.length ? found.narrators : null);
    return { recordingId: recording.recordingId, label: recording.label, ...matchRow<string[]>("narrators", recording.narrators, theirs) };
  });
  return { workId: metadata.workId, provider, id, title: found.title ?? "", fields, recordings };
}

/** The ticked rows by default: the fields and recordings 'Fill only what's missing' takes. */
export function defaultTicks(comparison: MetadataComparison): { fields: MatchField[]; narrators: string[] } {
  return {
    fields: MATCH_FIELDS.filter((field) => comparison.fields[field].ticked),
    narrators: comparison.recordings.filter((recording) => recording.ticked).map((recording) => recording.recordingId),
  };
}

// ---- Applying ----
/**
 * Writes the chosen fields of the comparison as overrides named after the provider; a field the provider gives nothing
 * for, or one not chosen, is left as it is. Returns the fields written (`narrators:<recordingId>` for a recording).
 */
export function applyComparison(metadata: WorkMetadata, comparison: MetadataComparison, chosen: { fields: MatchField[]; narrators: string[] }): string[] {
  const values: Record<string, unknown> = {};
  for (const field of chosen.fields) {
    const row = comparison.fields[field];
    if (!row || row.found === null || row.same) continue;
    values[field] = row.found;
  }
  const written = Object.keys(values);
  sqlite.transaction(() => {
    if (written.length) writeWorkEdits(metadata.workId, metadata.source, values, [], comparison.provider);
    for (const recordingId of chosen.narrators) {
      const row = comparison.recordings.find((recording) => recording.recordingId === recordingId);
      const source = metadata.recordings.find((recording) => recording.recordingId === recordingId)?.source;
      if (!row || !source || row.found === null || row.same) continue;
      writeNarrators(recordingId, source, row.found, comparison.provider);
      written.push(`narrators:${recordingId}`);
    }
  })();
  return written;
}

// ---- Match automatically ----
/** The provider book a work is surely: its own link, else #721's sure match (which links it), else none. */
async function sureTarget(workId: string, priority: Priority): Promise<{ provider: CatalogueProviderName; id: string } | { outcome: "unsure" | "missing"; reason: string }> {
  const link = workLink(workId);
  if (link) return { provider: link.provider, id: link.id };
  const other = providerLinks(workId)[0];
  if (other) return { provider: other.provider, id: other.id };
  const outcome = await matchWork(workId, priority);
  const linked = workLink(workId);
  if (outcome.outcome === "matched" && linked) return { provider: linked.provider, id: linked.id };
  if (outcome.outcome === "ambiguous") return { outcome: "unsure", reason: outcome.candidates > 1 ? `Several books fit · ${outcome.candidates}` : "No exact match · pick one" };
  return { outcome: "missing", reason: outcome.reason ?? "Not found on AudiobookDB or Open Library" };
}

/** 'Match automatically' for one work: a sure match only, the missing fields only. */
export async function matchAutomatically(read: MetadataReader, userId: number, workId: string, priority: Priority = "interactive"): Promise<MetadataApplied> {
  const before = read(userId, workId);
  if (!before) throw Object.assign(new Error("This book could not be found."), { statusCode: 404 });
  const target = await sureTarget(workId, priority);
  if ("outcome" in target) return { outcome: target.outcome, provider: null, fields: [], reason: target.reason, metadata: read(userId, workId) };
  // The match may have filled the description or a narrator: compare with what the work holds now.
  const metadata = read(userId, workId) ?? before;
  const comparison = compare(metadata, target.provider, target.id, await providerFields(target.provider, target.id, workId, priority));
  const fields = applyComparison(metadata, comparison, defaultTicks(comparison));
  return { outcome: fields.length ? "applied" : "nothing", provider: target.provider, fields, reason: null, metadata: read(userId, workId) };
}

// ---- A series' batch ----
type JobRow = { workId: string; seriesId: string; userId: number; status: string; reason: string | null };
let running: Promise<void> | null = null;
/** Tests: wait for the batch that is running. */
export const seriesMatchFinished = () => running ?? Promise.resolve();

/** Queues every work of the series for 'Match automatically' (a work already queued stays once) and starts the queue. */
export function queueSeriesMatch(read: MetadataReader, userId: number, seriesId: string, workIds: string[]): number {
  const now = Date.now();
  const put = sqlite.prepare(
    `INSERT INTO metadata_match_jobs(work_id,series_id,user_id,status,provider,fields,reason,updated_at) VALUES(?,?,?,'pending',NULL,'[]',NULL,?)
     ON CONFLICT(work_id) DO UPDATE SET series_id=excluded.series_id,user_id=excluded.user_id,status='pending',provider=NULL,fields='[]',reason=NULL,updated_at=excluded.updated_at
     WHERE metadata_match_jobs.status NOT IN ('pending','running')`,
  );
  sqlite.transaction(() => {
    for (const workId of new Set(workIds)) put.run(workId, seriesId, userId, now);
  })();
  runQueue(read);
  return workIds.length;
}
/** Retry from Activity: the work's row waits again. */
export function retryMetadataMatch(read: MetadataReader, workId: string): boolean {
  const changed = sqlite.prepare("UPDATE metadata_match_jobs SET status='pending',reason=NULL,updated_at=? WHERE work_id=? AND status IN ('failed','unsure')").run(Date.now(), workId).changes;
  if (changed) runQueue(read);
  return changed > 0;
}
/** The series' rows (the Series page's line). */
export function seriesMatchJobs(seriesId: string) {
  return sqlite.prepare("SELECT work_id AS workId,status,reason,fields FROM metadata_match_jobs WHERE series_id=? ORDER BY rowid").all(seriesId) as { workId: string; status: string; reason: string | null; fields: string }[];
}

function runQueue(read: MetadataReader) {
  if (running) return;
  running = (async () => {
    // One at a time, in the order queued; a provider out of key or units stops the rest with the same reason.
    for (;;) {
      const job = sqlite.prepare("SELECT work_id AS workId,series_id AS seriesId,user_id AS userId,status,reason FROM metadata_match_jobs WHERE status='pending' ORDER BY updated_at,rowid LIMIT 1").get() as JobRow | undefined;
      if (!job) break;
      sqlite.prepare("UPDATE metadata_match_jobs SET status='running',updated_at=? WHERE work_id=?").run(Date.now(), job.workId);
      try {
        const result = await matchAutomatically(read, job.userId, job.workId, "background");
        const status = result.outcome === "unsure" || result.outcome === "missing" ? "unsure" : "done";
        sqlite
          .prepare("UPDATE metadata_match_jobs SET status=?,provider=?,fields=?,reason=?,updated_at=? WHERE work_id=?")
          .run(status, result.provider, JSON.stringify(result.fields), result.reason, Date.now(), job.workId);
      } catch (error) {
        const reason = (error as Error).message;
        sqlite.prepare("UPDATE metadata_match_jobs SET status='failed',reason=?,updated_at=? WHERE work_id=?").run(reason, Date.now(), job.workId);
        if (error instanceof CatalogueError && ["missing_key", "rejected", "daily_limit"].includes(error.kind))
          sqlite.prepare("UPDATE metadata_match_jobs SET status='failed',reason=?,updated_at=? WHERE status='pending'").run(reason, Date.now());
      }
    }
  })().finally(() => {
    running = null;
  });
}

// ---- Routes (the administrator's) ----
const providerQuery = z.object({ provider: z.enum(CATALOGUE_PROVIDERS), id: z.string().trim().min(1).max(100) });
const failed = (error: unknown) => {
  if (error instanceof CatalogueError) return Object.assign(new Error(error.message), { statusCode: error.kind === "missing_key" ? 409 : 502 });
  return error;
};

export function registerMetadataMatchRoutes(app: FastifyInstance, read: MetadataReader, seriesWorks: (userId: number, seriesId: string) => string[]) {
  const params = z.object({ workId: z.string().min(1).max(200) });
  const metadataOf = (userId: number, workId: string) => {
    const metadata = read(userId, workId);
    if (!metadata) throw Object.assign(new Error("This book could not be found."), { statusCode: 404 });
    return metadata;
  };
  const comparisonOf = async (userId: number, workId: string, provider: CatalogueProviderName, id: string) => {
    const metadata = metadataOf(userId, workId);
    try {
      return { metadata, comparison: compare(metadata, provider, id, await providerFields(provider, id, workId)) };
    } catch (error) {
      throw failed(error);
    }
  };
  app.get("/api/works/:workId/metadata/match", async (req) => {
    requireAdmin(req);
    const { workId } = params.parse(req.params);
    const { provider, id } = providerQuery.parse(req.query);
    return (await comparisonOf(currentUserId(req), workId, provider, id)).comparison;
  });
  /** `{ provider, id, fields: [<field>], narrators: [<recordingId>] }`: the ticked rows, written from that provider. */
  app.post("/api/works/:workId/metadata/match", async (req): Promise<MetadataApplied> => {
    requireAdmin(req);
    const userId = currentUserId(req);
    const { workId } = params.parse(req.params);
    const body = providerQuery
      .extend({ fields: z.array(z.enum(MATCH_FIELDS)).max(MATCH_FIELDS.length).default([]), narrators: z.array(z.string().min(1).max(200)).max(100).default([]) })
      .parse(req.body ?? {});
    const { metadata, comparison } = await comparisonOf(userId, workId, body.provider, body.id);
    const fields = applyComparison(metadata, comparison, { fields: body.fields, narrators: body.narrators });
    return { outcome: fields.length ? "applied" : "nothing", provider: body.provider, fields, reason: null, metadata: read(userId, workId) };
  });
  app.post("/api/works/:workId/metadata/auto", async (req): Promise<MetadataApplied> => {
    requireAdmin(req);
    const userId = currentUserId(req);
    const { workId } = params.parse(req.params);
    metadataOf(userId, workId);
    try {
      return await matchAutomatically(read, userId, workId);
    } catch (error) {
      if (error instanceof CatalogueError) return { outcome: "failed", provider: error.provider, fields: [], reason: error.message, metadata: read(userId, workId) };
      throw error;
    }
  });
  const seriesParams = z.object({ id: z.string().min(1).max(200) });
  const seriesAnswer = (seriesId: string) => {
    const jobs = seriesMatchJobs(seriesId);
    const count = (status: string) => jobs.filter((job) => job.status === status).length;
    return { total: jobs.length, waiting: count("pending") + count("running"), done: count("done"), unsure: count("unsure"), failed: count("failed") };
  };
  app.get("/api/series/:id/metadata/auto", async (req) => {
    requireAdmin(req);
    return seriesAnswer(seriesParams.parse(req.params).id);
  });
  app.post("/api/series/:id/metadata/auto", async (req) => {
    requireAdmin(req);
    const userId = currentUserId(req);
    const { id } = seriesParams.parse(req.params);
    const works = seriesWorks(userId, id);
    if (!works.length) throw Object.assign(new Error("This series has no books in your library."), { statusCode: 404 });
    queueSeriesMatch(read, userId, id, works);
    return seriesAnswer(id);
  });
}
