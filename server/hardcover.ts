import {
  ADMIN_USER_ID,
  getUserSecret,
  onUserDeleted,
} from "./users.ts";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import { ensurePlaceholder, isPlaceholderEdition, placeholderEditionSql } from "./placeholder-edition.ts";
import * as s from "./schema.ts";
import {
  isUnreleasedHardcoverBook,
  pickCanonicalBookPerPosition,
} from "./series-membership.ts";
import { autoAcquireSeriesVolumes, type SeriesAudioSearchDeps } from "./series-audio.ts";
import { acquire as defaultAcquire } from "./acquisitions.ts";
import { hasServerMedia } from "./downloads.ts";
import {
  getWorkMediaStates,
  setWorkMediaHold,
  trackWorkMediaState,
  type WorkMediaState,
} from "./work-media-state.ts";
import {
  enqueueSeriesAcquisition,
  seriesWorkAcquisitions,
} from "./series-acquisition.ts";
import { listEbookSetMembers } from "./ebook-set.ts";
import {
  libraryOriginFor,
  libraryOriginLabel,
  removeUserLibraryRow,
  setLibraryOrigin,
  removalDefaultSelected,
  setWorkCompletionOverride,
} from "./library-origin.ts";
import { workCompletions } from "./work-completion.ts";
export { setWorkCompletionOverride };
export type ShelfStatus = 1 | 2 | 3 | 4 | 5;
const image = z
  .object({ url: z.string().nullable().optional() })
  .nullable()
  .optional();
const audioEdition = z.object({
  id: z.number().int(),
  audio_seconds: z.number().nullable().optional(),
  edition_format: z.string().nullable().optional(),
  contributions: z
    .array(
      z.object({
        contribution: z.string().nullable().optional(),
        author: z.object({ name: z.string() }).nullable(),
      }),
    )
    .default([]),
});
const catalogBook = z.object({
  pages: z.number().nullable().optional(),
  default_audio_edition: audioEdition.nullable().optional(),
  editions: z.array(audioEdition).default([]),
  id: z.number().int(),
  title: z.string().nullable(),
  slug: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  release_year: z.number().nullable().optional(),
  cached_image: image,
  contributions: z
    .array(
      z.object({
        contribution: z.string().nullable().optional(),
        author: z.object({ name: z.string() }).nullable(),
      }),
    )
    .default([]),
  book_series: z
    .array(
      z.object({
        position: z.number().nullable(),
        series: z.object({ id: z.number().int().optional(), name: z.string() }).nullable(),
      }),
    )
    .default([]),
});
export type CatalogBook = z.infer<typeof catalogBook>;
const bookFields =
  "pages default_audio_edition { id audio_seconds edition_format contributions { contribution author { name } } } editions(where:{reading_format_id:{_eq:2}},order_by:{users_count:desc},limit:40) { id audio_seconds edition_format contributions { contribution author { name } } } id title slug description release_year cached_image contributions { contribution author { name } } book_series { position series { id name } }";
// Every Hardcover request is made for one Sonder user (#15) and carries only their key. Sync, its queues and the
// token routes are gone (#721 part d); the catalogue and series reads below remain until parts b and c2 replace them.
type Runtime = {
  generation: number;
  retryAt: number;
};
const runtimes = new Map<number, Runtime>();
function runtime(userId: number) {
  let value = runtimes.get(userId);
  if (!value) {
    value = { generation: 0, retryAt: 0 };
    runtimes.set(userId, value);
  }
  return value;
}
// A single-token bucket limits every caller to 24 requests per minute, with
// no initial burst. The request queue serializes access to this budget.
export function createHardcoverRequestBudget(options: {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.intervalMs ?? 2500;
  let nextTokenAt = 0;
  let retryAt = 0;
  return {
    async wait() {
      for (;;) {
        const delay = Math.max(nextTokenAt, retryAt) - now();
        if (delay <= 0) break;
        await sleep(delay);
      }
    },
    take() { nextTokenAt = now() + interval; },
    isDeferred() { return retryAt > now(); },
    deferUntil(time: number) {
      retryAt = Math.max(retryAt, time);
    },
  };
}
let requestBudget = createHardcoverRequestBudget({
  intervalMs: process.env.NODE_ENV === "test" ? 0 : 2500,
});
export function setHardcoverRequestBudgetForTests(budget: ReturnType<typeof createHardcoverRequestBudget>) {
  requestBudget = budget;
}
type HardcoverPriority = "interactive" | "background";
type PendingHardcoverRequest = { run: () => Promise<void>; reject: (error: Error) => void };
const hardcoverRequests: Record<HardcoverPriority, PendingHardcoverRequest[]> = {
  interactive: [], background: [],
};
let processingHardcoverRequests = false;
const rateLimited = () => new HardcoverUpstreamError(
  "rate_limited",
  "Hardcover is rate limiting requests. Your changes are saved and will retry shortly.",
);
async function drainHardcoverRequests() {
  if (processingHardcoverRequests) return;
  processingHardcoverRequests = true;
  try {
    while (hardcoverRequests.interactive.length || hardcoverRequests.background.length) {
      if (requestBudget.isDeferred() && hardcoverRequests.interactive.length) {
        for (const item of hardcoverRequests.interactive.splice(0)) item.reject(rateLimited());
        continue;
      }
      // Choose the request after waiting so a newly arrived interactive request
      // can overtake background work while the next token is replenishing.
      await requestBudget.wait();
      const item = hardcoverRequests.interactive.shift() ?? hardcoverRequests.background.shift();
      if (!item) continue;
      requestBudget.take();
      await item.run();
    }
  } finally {
    processingHardcoverRequests = false;
  }
}
function scheduleHardcoverRequest<T>(priority: HardcoverPriority, run: () => Promise<T>): Promise<T> {
  if (priority === "interactive" && requestBudget.isDeferred())
    return Promise.reject(rateLimited());
  return new Promise<T>((resolve, reject) => {
    hardcoverRequests[priority].push({
      run: async () => { try { resolve(await run()); } catch (error) { reject(error); } },
      reject,
    });
    void drainHardcoverRequests();
  });
}
const hardcoverKey = (userId: number) => getUserSecret(userId, "hardcover");
const T = {
  links: s.userHardcoverLinks,
  outbox: s.userHardcoverOutbox,
  reading: s.userHardcoverReadingOutbox,
  progress: s.userHardcoverProgress,
  lists: s.userHardcoverLists,
  reads: s.userHardcoverReads,
  editions: s.userHardcoverRecordingEditions,
};
const userLink = (userId: number, bookId: number) =>
  db
    .select()
    .from(T.links)
    .where(and(eq(T.links.userId, userId), eq(T.links.bookId, bookId)))
    .get();
const libraryEntry = (userId: number, bookId: string) =>
  db
    .select()
    .from(s.userLibrary)
    .where(
      and(eq(s.userLibrary.userId, userId), eq(s.userLibrary.bookId, bookId)),
    )
    .get();
// Called when a user is deleted: any in-flight request or sync for that id stops before
// it commits, and a later user who reuses the id starts with a fresh runtime (r6#6).
export function forgetHardcoverUser(userId: number) {
  const live = runtimes.get(userId);
  if (live) live.generation++;
  runtimes.delete(userId);
}
onUserDeleted(forgetHardcoverUser);
export type HardcoverUpstreamKind = "missing_token" | "unreachable" | "rate_limited" | "rejected" | "other";
export class HardcoverUpstreamError extends Error {
  readonly kind: HardcoverUpstreamKind;
  constructor(kind: HardcoverUpstreamKind, message: string) {
    super(message);
    this.name = "HardcoverUpstreamError";
    this.kind = kind;
  }
}
function upstream(kind: HardcoverUpstreamKind, message: string): never {
  throw new HardcoverUpstreamError(kind, message);
}

async function graphql<T>(
  userId: number,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
  priority: HardcoverPriority = "interactive",
): Promise<T> {
  const live = runtime(userId);
  const expectedGeneration = live.generation;
  const run = async () => {
    if (live.generation !== expectedGeneration)
      upstream("other", "The Hardcover connection changed. Sync again.");
    const key = hardcoverKey(userId);
    if (!key)
      upstream("missing_token", "Add your Hardcover API token in Settings first.");
    let response: Response;
    try {
      response = await fetch("https://api.hardcover.app/v1/graphql", {
        method: "POST",
        headers: {
          Authorization: key.startsWith("Bearer ") ? key : `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Sonder audiobook library",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      upstream(
        "unreachable",
        "Hardcover could not be reached. Your library and queued changes are kept on this server.",
      );
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After")) || 60;
      live.retryAt = Date.now() + Math.min(3600, seconds) * 1000;
      requestBudget.deferUntil(live.retryAt);
      upstream(
        "rate_limited",
        "Hardcover is rate limiting requests. Your changes are saved and will retry shortly.",
      );
    }
    if (response.status === 401 || response.status === 403)
      upstream(
        "rejected",
        "Hardcover rejected this token or its permissions. Check the scopes in Settings.",
      );
    if (!response.ok)
      upstream(
        "other",
        `Hardcover returned ${response.status}. Your queued changes are kept for retry.`,
      );
    const envelope = (await response.json()) as {
      data?: unknown;
      errors?: { message: string }[];
    };
    if (envelope.errors?.length)
      upstream(
        "other",
        `Hardcover: ${envelope.errors
          .map((e) => e.message)
          .join("; ")
          .slice(0, 450)}`,
      );
    if (live.generation !== expectedGeneration)
      upstream("other", "The Hardcover connection changed. Sync again.");
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success)
      upstream(
        "other",
        "Hardcover returned an unexpected response. The last successful library snapshot has been kept.",
      );
    return parsed.data;
  };
  return scheduleHardcoverRequest(priority, run);
}
// The series (search, preview, save, the saved series and their refresh) moved to AudiobookDB in #721:
// `server/series-catalogue.ts`.
export async function hardcoverSearch(userId: number, query: string) {
  const data = await graphql(
    userId,
    'query SonderSearch($q:String!){search(query:$q,query_type:"Book",per_page:12,page:1){results}}',
    { q: query },
    z.object({ search: z.object({ results: z.unknown() }) }),
  );
  const raw = data.search.results;
  const results = z
    .object({
      hits: z.array(
        z
          .object({
            document: z
              .object({ id: z.union([z.string(), z.number()]) })
              .passthrough(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .parse(typeof raw === "string" ? JSON.parse(raw) : raw);
  const ids = results.hits
    .map((hit) => Number(hit.document.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return results;
  // Search documents do not consistently include the canonical slug. Resolve
  // all results in one catalog request instead of guessing URLs from IDs/titles.
  const catalog = await graphql(
    userId,
    "query SonderSearchLinks($ids:[Int!]!){books(where:{id:{_in:$ids}}){id slug}}",
    { ids },
    z.object({
      books: z.array(
        z.object({ id: z.number().int(), slug: z.string().nullable() }),
      ),
    }),
  );
  const slugs = new Map(catalog.books.map((book) => [book.id, book.slug]));
  return {
    ...results,
    hits: results.hits.map((hit) => ({
      ...hit,
      document: {
        ...hit.document,
        url: slugs.get(Number(hit.document.id))
          ? `https://hardcover.app/books/${encodeURIComponent(slugs.get(Number(hit.document.id))!)}`
          : null,
      },
    })),
  };
}
/** Hardcover's book `id`, or null when Hardcover does not know it. */
async function findHardcoverBook(userId: number, id: number) {
  const result = await graphql(
    userId,
    `query SonderBook($id:Int!){books_by_pk(id:$id){${bookFields}}}`,
    { id },
    z.object({ books_by_pk: catalogBook.nullable() }),
  );
  return result.books_by_pk;
}
export async function hardcoverBook(userId: number, id: number) {
  const book = await findHardcoverBook(userId, id);
  if (!book) throw new Error("Hardcover could not find this book.");
  return book;
}
/** Whether the user has a Hardcover token saved ("Hardcover connected"). */
export function hardcoverConnected(userId: number) {
  return !!hardcoverKey(userId);
}
/**
 * Hardcover's books as a look at a book not on the server reads them (ADR 0022), remembered for
 * `ttlMs` per user and book so a Book page opened again or read again after an add does not ask
 * Hardcover each time. Only what Hardcover answered is kept; nothing is written to the database.
 */
export const hardcoverLooks = { ttlMs: 10 * 60_000, now: () => Date.now() };
const looked = new Map<string, { book: CatalogBook | null; at: number }>();
/**
 * Hardcover's book `id` for a look by `userId` (`hardcoverLooks`): null when the user has no
 * Hardcover token or Hardcover does not know the book. Any other failure of Hardcover is thrown.
 */
export async function lookAtHardcoverBook(userId: number, id: number): Promise<CatalogBook | null> {
  if (!hardcoverConnected(userId)) return null;
  const key = `${userId}:${id}`;
  const known = looked.get(key);
  if (known && hardcoverLooks.now() - known.at < hardcoverLooks.ttlMs) return known.book;
  let book: CatalogBook | null;
  try {
    book = await findHardcoverBook(userId, id);
  } catch (error) {
    // The token went between the check and the request: as no token.
    if (error instanceof HardcoverUpstreamError && error.kind === "missing_token") return null;
    throw error;
  }
  if (looked.size >= 1000) looked.clear();
  looked.set(key, { book, at: hardcoverLooks.now() });
  return book;
}
/** The fields of the work the Hardcover import makes for `book` (`importCatalogBook`). */
export function hardcoverWorkFields(book: CatalogBook) {
  return {
    title: book.title || "Untitled book",
    author: authorOf(book),
    description:
      book.description ||
      "A book from your Hardcover library. Add a recording whenever you’re ready to listen.",
    genre: "From Hardcover",
    year: book.release_year || new Date().getFullYear(),
  };
}
/** The Hardcover link the import writes for `book` (`metadataLink`): its slug and series. */
export function hardcoverLinkFields(book: CatalogBook) {
  return {
    bookId: book.id,
    slug: book.slug || null,
    series: book.book_series.flatMap((item) =>
      item.series ? [{ id: item.series.id, name: item.series.name, position: item.position }] : [],
    ),
  };
}
function authorOf(book: CatalogBook) {
  return (
    book.contributions
      .filter(
        (c) => !c.contribution || c.contribution.toLowerCase() === "author",
      )
      .flatMap((c) => c.author?.name || [])
      .join(", ") || "Unknown author"
  );
}
function normalized(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}
export function sameBook(
  a: { title: string; author: string },
  b: { title: string; author: string },
) {
  const names = (v: string) => normalized(v).split(" ").sort().join(" ");
  return (
    normalized(a.title) === normalized(b.title) &&
    a.author !== "Unknown author" &&
    b.author !== "Unknown author" &&
    names(a.author) === names(b.author)
  );
}
function localStatus(status: ShelfStatus): "unread" | "listening" | "finished" {
  return status === 3 ? "finished" : status === 2 ? "listening" : "unread";
}
function isAdminUser(userId: number) {
  const role = (
    sqlite.prepare("SELECT role FROM users WHERE id=?").get(userId) as
      | { role: string }
      | undefined
  )?.role;
  return userId === ADMIN_USER_ID || role === "admin";
}
export function hardcoverLinkedBook(workId: string) {
  return db
    .select()
    .from(s.hardcoverLinks)
    .where(eq(s.hardcoverLinks.workId, workId))
    .get()?.bookId;
}
// The work → Hardcover book match is a shared catalogue fact (the sync queues it once cleared are gone, #721 part d).
function metadataLink(workId: string, book: CatalogBook) {
  const existing = db
    .select()
    .from(s.hardcoverLinks)
    .where(eq(s.hardcoverLinks.workId, workId))
    .get();
  const values = { workId, ...hardcoverLinkFields(book) };
  db.insert(s.hardcoverLinks)
    .values(values)
    .onConflictDoUpdate({
      target: s.hardcoverLinks.workId,
      set: {
        ...values,
        ...(existing?.bookId !== book.id
          ? {
              userBookId: null,
              statusId: null,
              remoteUpdatedAt: 0,
              syncedAt: 0,
            }
          : {}),
      },
    })
    .run();
}
function linkRepresentatives(bookId: number) {
  return db
    .select()
    .from(s.hardcoverLinks)
    .where(eq(s.hardcoverLinks.bookId, bookId))
    .all();
}
function audioForWork(workId: string) {
  const editions = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all();
  return editions.filter((e) => {
    const r = db
      .select()
      .from(s.recordings)
      .where(eq(s.recordings.editionId, e.id))
      .get();
    return (
      r &&
      !!db.select().from(s.tracks).where(eq(s.tracks.recordingId, r.id)).get()
    );
  });
}
function importCatalogBook(
  userId: number,
  book: CatalogBook,
  status: ShelfStatus | null = null,
  forceLibrary = false,
  libraryOrigin?: { source: "series"; seriesId: string },
) {
  let links = linkRepresentatives(book.id);
  let matched = false,
    imported = false;
  // A title/author match creates a shared work → book link, which only the admin may do.
  // A regular user's unmatched book gets their own hidden `hc-*` placeholder instead.
  if (!links.length && isAdminUser(userId)) {
    const candidates = db
      .select()
      .from(s.works)
      .all()
      .filter((w) =>
        hardcoverLinkedBook(w.id) === undefined && sameBook(w, { title: book.title || "", author: authorOf(book) }),
      );
    if (candidates.length === 1) {
      metadataLink(candidates[0].id, book);
      links = linkRepresentatives(book.id);
      matched = true;
    }
  }
  if (!links.length) {
    const workId = `work-hc-${book.id}`;
    db.insert(s.works)
      .values({ id: workId, ...hardcoverWorkFields(book) })
      .onConflictDoNothing()
      .run();
    // Linked first, so the placeholder the work gets is `hc-<book id>` (#467, `ensurePlaceholder`).
    metadataLink(workId, book);
    ensurePlaceholder(sqlite, workId, { cover: book.cached_image?.url });
    links = linkRepresentatives(book.id);
    imported = true;
  }
  const audio = links.flatMap((l) => audioForWork(l.workId));
  // A work matched by title and author may have no audio edition yet (only an ebook): it joins the
  // library through its placeholder, as Add to library does (#467, `ensurePlaceholder`).
  if (!audio.length && !db.select().from(s.editions).where(eq(s.editions.workId, links[0].workId)).get())
    ensurePlaceholder(sqlite, links[0].workId, { cover: book.cached_image?.url });
  const representative =
    audio[0] ||
    db
      .select()
      .from(s.editions)
      .where(eq(s.editions.workId, links[0].workId))
      .get()!;
  const hidden = and(
    eq(s.userHiddenLibrary.userId, userId),
    eq(s.userHiddenLibrary.bookId, representative.id),
  );
  if (forceLibrary) db.delete(s.userHiddenLibrary).where(hidden).run();
  if (!db.select().from(s.userHiddenLibrary).where(hidden).get()) {
    const addedAt = Date.now();
    const inserted =
      db
        .insert(s.userLibrary)
        .values({
          userId,
          bookId: representative.id,
          status: localStatus(status || 1),
          addedAt,
        })
        .onConflictDoNothing()
        .run().changes > 0;
    if (inserted) {
      if (libraryOrigin)
        setLibraryOrigin(userId, links[0].workId, libraryOrigin.source, {
          seriesId: libraryOrigin.seriesId,
          addedAt,
        });
      else setLibraryOrigin(userId, links[0].workId, "hardcover_sync", { addedAt });
    }
  }
  // Metadata-only placeholders are replaced on the shelf when actual audio for that work is linked.
  if (audio.length) {
    for (const link of links)
      for (const e of db
        .select()
        .from(s.editions)
        .where(eq(s.editions.workId, link.workId))
        .all())
        if (isPlaceholderEdition(sqlite, e.id)) removeUserLibraryRow(userId, e.id);
  }
  return { bookId: representative.id, matched, imported };
}
export function hardcoverForWork(userId: number, workId: string) {
  return hardcoverForWorks(userId, [workId]).get(workId);
}
/** The Hardcover block of `GET /api/books` (`hardcoverForWork`) for many works, one query per table. */
export function hardcoverForWorks(userId: number, workIds: string[]) {
  return hardcoverBlocks(userId, db.select().from(s.hardcoverLinks).where(inArray(s.hardcoverLinks.workId, workIds)).all());
}
/**
 * The Hardcover block for links of works to Hardcover books, by work id: the stored links of
 * `hardcoverForWorks`, or the link a book not on the server will get (ADR 0022).
 */
export function hardcoverBlocks(
  userId: number,
  links: { workId: string; bookId: number; slug: string | null; series: HardcoverBlock["series"] }[],
) {
  const blocks = new Map<string, HardcoverBlock>();
  if (!links.length) return blocks;
  const bookIds = [...new Set(links.map((link) => link.bookId))];
  const byBook = <Row extends { bookId: number }>(rows: Row[]) => {
    const found = new Map<number, Row>();
    for (const row of rows) if (!found.has(row.bookId)) found.set(row.bookId, row);
    return found;
  };
  const pending = byBook(db.select().from(T.outbox).where(and(eq(T.outbox.userId, userId), inArray(T.outbox.bookId, bookIds))).all());
  const queued = byBook(db.select().from(T.progress).where(and(eq(T.progress.userId, userId), inArray(T.progress.bookId, bookIds))).all());
  const shelves = byBook(db.select().from(T.links).where(and(eq(T.links.userId, userId), inArray(T.links.bookId, bookIds))).all());
  const reads = byBook(
    db.select({ bookId: T.reads.bookId, fraction: T.reads.fraction }).from(T.reads)
      .where(and(eq(T.reads.userId, userId), inArray(T.reads.bookId, bookIds))).all(),
  );
  const lists = db.select().from(T.lists).where(eq(T.lists.userId, userId)).all();
  for (const link of links) {
    const job = pending.get(link.bookId);
    const progress = queued.get(link.bookId);
    blocks.set(link.workId, {
      id: link.bookId,
      slug: link.slug,
      series: link.series,
      statusId: job?.statusId ?? shelves.get(link.bookId)?.statusId ?? null,
      pending: !!job,
      progressFraction: progress
        ? progress.position / progress.duration
        : (reads.get(link.bookId)?.fraction ?? null),
      progressPending: !!progress,
      syncError: job?.error || progress?.error || null,
      listIds: lists.filter((l) => l.members.some((m) => m.bookId === link.bookId)).map((l) => l.id),
    });
  }
  return blocks;
}
type HardcoverBlock = {
  id: number;
  slug: string | null;
  series: { id?: number; name: string; position: number | null }[];
  statusId: number | null;
  pending: boolean;
  progressFraction: number | null;
  progressPending: boolean;
  syncError: string | null;
  listIds: number[];
};
// Metadata-only placeholders come from one user's Hardcover shelves and lists, so
// they're only listed for users who have that book themselves, and for admins (r6#1).
// Returns the placeholder edition ids `userId` must not see in the catalogue.
export function hiddenHardcoverPlaceholders(userId: number): Set<string> {
  if (isAdminUser(userId)) return new Set();
  const placeholders = sqlite
    .prepare(
      `SELECT e.id, l.book_id AS bookId FROM audio_editions e
       LEFT JOIN hardcover_links l ON l.work_id=e.work_id
       WHERE ${placeholderEditionSql("e.id")}`,
    )
    .all() as { id: string; bookId: number | null }[];
  if (!placeholders.length) return new Set();
  const library = new Set(
    db
      .select()
      .from(s.userLibrary)
      .where(eq(s.userLibrary.userId, userId))
      .all()
      .map((row) => row.bookId),
  );
  const books = new Set<number>([
    ...db
      .select()
      .from(T.links)
      .where(eq(T.links.userId, userId))
      .all()
      .map((row) => row.bookId),
    ...db
      .select()
      .from(T.lists)
      .where(eq(T.lists.userId, userId))
      .all()
      .flatMap((list) => list.members.map((m) => m.bookId)),
  ]);
  return new Set(
    placeholders
      .filter(
        (p) => !library.has(p.id) && (p.bookId === null || !books.has(p.bookId)),
      )
      .map((p) => p.id),
  );
}
export async function importHardcoverBook(
  userId: number,
  id: number,
  workId?: string,
) {
  return importFetchedBook(userId, await hardcoverBook(userId, id), workId);
}
/**
 * Add to library on a Hardcover book that is not on the server (ADR 0022): today's import
 * (`importHardcoverBook`) of book `id`, read from Hardcover afresh; null when Hardcover does not
 * know the book.
 */
export async function importHardcoverBookToAdd(userId: number, id: number) {
  const book = await findHardcoverBook(userId, id);
  return book ? importFetchedBook(userId, book) : null;
}
function importFetchedBook(userId: number, book: CatalogBook, workId?: string) {
  let added: ReturnType<typeof importCatalogBook> | undefined;
  sqlite.transaction(() => {
    if (workId) {
      if (!db.select().from(s.works).where(eq(s.works.id, workId)).get())
        throw new Error("This local book could not be found.");
      metadataLink(workId, book);
    }
    added = importCatalogBook(userId, book, null, true);
  })();
  return added!;
}
export function applyHardcoverCatalogBook(userId: number, book: CatalogBook) {
  sqlite.transaction(() => {
    importCatalogBook(userId, book, null, false);
  })();
}
export async function addHardcoverSeries(
  userId: number,
  seriesName: string,
  overrides?: {
    acquire?: typeof defaultAcquire;
    seriesAudioDeps?: SeriesAudioSearchDeps;
  },
) {
  const result = await graphql(
    userId,
    `query SonderSeries($name:String!){series(where:{name:{_eq:$name}}){name book_series(order_by:{position:asc}){position book{id title compilation release_year release_date}}}}`,
    { name: seriesName },
    z.object({
      series: z.array(
        z.object({
          name: z.string(),
          book_series: z.array(
            z.object({
              position: z.number().nullable(),
              book: z.object({
                id: z.number(),
                title: z.string(),
                compilation: z.boolean().nullable().optional(),
                release_year: z.number().nullable().optional(),
                release_date: z.string().nullable().optional(),
              }),
            }),
          ),
        }),
      ),
    }),
  );
  const series = result.series[0];
  if (!series) throw new Error("Hardcover could not find this series.");
  const picked = pickCanonicalBookPerPosition(series.book_series);
  const volumes = picked.map((volume) => {
    const entry = series.book_series.find(
      (row) =>
        row.position === volume.position && row.book.id === volume.bookId,
    )!;
    return {
      ...volume,
      unreleased: isUnreleasedHardcoverBook(entry.book),
    };
  });
  const added: {
    position: number;
    hardcoverBookId: number;
    workId: string;
    editionId: string;
    unreleased: boolean;
    mediaState: WorkMediaState | null;
  }[] = [];
  for (const volume of volumes) {
    const imported = await importHardcoverBook(userId, volume.bookId);
    const edition = db
      .select()
      .from(s.editions)
      .where(eq(s.editions.id, imported.bookId))
      .get();
    if (!edition) throw new Error("The series volume could not be added.");
    const workId = edition.workId;
    if (volume.unreleased) setWorkMediaHold(userId, workId, "unreleased");
    else trackWorkMediaState(userId, workId);
    added.push({
      position: volume.position,
      hardcoverBookId: volume.bookId,
      workId,
      editionId: imported.bookId,
      unreleased: volume.unreleased,
      mediaState: null,
    });
  }
  const author =
    db.select().from(s.works).where(eq(s.works.id, added[0]?.workId)).get()
      ?.author || "Unknown author";
  if (process.env.SONDER_SKIP_SERIES_AUTO_ACQUIRE !== "1") {
    await autoAcquireSeriesVolumes(
    userId,
    {
      seriesName,
      author,
      volumes: added.map((row) => {
        const meta = volumes.find((entry) => entry.bookId === row.hardcoverBookId)!;
        const edition = db
          .select()
          .from(s.editions)
          .where(eq(s.editions.id, row.editionId))
          .get();
        return {
          position: row.position,
          title: meta.title,
          workId: row.workId,
          unreleased: row.unreleased,
          cover: edition?.cover,
        };
      }),
    },
    overrides?.acquire ?? defaultAcquire,
    overrides?.seriesAudioDeps,
  );
  }
  const mediaStates = getWorkMediaStates(
    userId,
    added.map((row) => row.workId),
  );
  for (const row of added) row.mediaState = mediaStates.get(row.workId) ?? null;
  return { seriesName, volumes: added };
}
export function hardcoverWorkForMedia(title: string, author: string) {
  const links = db.select().from(s.hardcoverLinks).all();
  const matches = db
    .select()
    .from(s.works)
    .all()
    .filter(
      (w) =>
        links.some((l) => l.workId === w.id) && sameBook(w, { title, author }),
    );
  return matches.length === 1 ? matches[0].id : undefined;
}
