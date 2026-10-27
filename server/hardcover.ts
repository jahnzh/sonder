import {
  ADMIN_USER_ID,
  getUserSecret,
  getUserSetting,
  listUserIds,
  setUserSecret,
  setUserSetting,
} from "./users.ts";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
export type ShelfStatus = 1 | 2 | 3 | 4 | 5;
export type SyncMode = "off" | "import" | "two-way";
const shelfStatus = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
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
const readSchema = z.object({
  id: z.number().int(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  finished_at_precision: z.number().nullable().optional(),
  progress_seconds: z.number().nullable().optional(),
  progress_pages: z.number().nullable().optional(),
  edition_id: z.number().nullable().optional(),
  edition: z
    .object({
      id: z.number().int(),
      audio_seconds: z.number().nullable().optional(),
      pages: z.number().nullable().optional(),
      reading_format_id: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});
type Read = z.infer<typeof readSchema>;
const readFields =
  "id started_at finished_at finished_at_precision progress_seconds progress_pages edition_id edition { id audio_seconds pages reading_format_id }";
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
        series: z.object({ name: z.string() }).nullable(),
      }),
    )
    .default([]),
});
export type CatalogBook = z.infer<typeof catalogBook>;
const entry = z.object({
  id: z.number().int(),
  book_id: z.number().int(),
  status_id: shelfStatus,
  updated_at: z.string().nullable().optional(),
  book: catalogBook,
  user_book_reads: z.array(readSchema).default([]),
});
type Entry = z.infer<typeof entry>;
const bookFields =
  "pages default_audio_edition { id audio_seconds edition_format contributions { contribution author { name } } } editions(where:{reading_format_id:{_eq:2}},order_by:{users_count:desc},limit:40) { id audio_seconds edition_format contributions { contribution author { name } } } id title slug description release_year cached_image contributions { contribution author { name } } book_series { position series { name } }";
const entryFields = `id book_id status_id updated_at user_book_reads(order_by:{id:desc},limit:1){${readFields}} book { ${bookFields} }`;
type State = {
  mode: SyncMode;
  syncLists: boolean;
  accountId: number | null;
  username: string | null;
  lastSync: number;
  lastError: string | null;
  listWarning: string | null;
};
const defaults: State = {
  mode: "off",
  syncLists: true,
  accountId: null,
  username: null,
  lastSync: 0,
  lastError: null,
  listWarning: null,
};
// Every Hardcover account belongs to one Sonder user (#15): its key, state, queues and
// in-flight sync are all looked up by user id, so a request only ever carries that user's key.
type Runtime = {
  generation: number;
  syncing: boolean;
  retryAt: number;
  activeSync: Promise<SyncSummary> | null;
};
const runtimes = new Map<number, Runtime>();
function runtime(userId: number) {
  let value = runtimes.get(userId);
  if (!value) {
    value = { generation: 0, syncing: false, retryAt: 0, activeSync: null };
    runtimes.set(userId, value);
  }
  return value;
}
let requestTail: Promise<unknown> = Promise.resolve();
let lastRequest = 0;
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
const statusJob = (userId: number, bookId: number) =>
  db
    .select()
    .from(T.outbox)
    .where(and(eq(T.outbox.userId, userId), eq(T.outbox.bookId, bookId)))
    .get();
const progressJob = (userId: number, bookId: number) =>
  db
    .select()
    .from(T.progress)
    .where(and(eq(T.progress.userId, userId), eq(T.progress.bookId, bookId)))
    .get();
const readingJob = (userId: number, bookId: number) =>
  db
    .select()
    .from(T.reading)
    .where(and(eq(T.reading.userId, userId), eq(T.reading.bookId, bookId)))
    .get();
const lastRead = (userId: number, bookId: number) =>
  db
    .select()
    .from(T.reads)
    .where(and(eq(T.reads.userId, userId), eq(T.reads.bookId, bookId)))
    .get();
const deleteStatusJob = (userId: number, bookId: number) =>
  db
    .delete(T.outbox)
    .where(and(eq(T.outbox.userId, userId), eq(T.outbox.bookId, bookId)))
    .run();
const deleteProgressJob = (userId: number, bookId: number) =>
  db
    .delete(T.progress)
    .where(and(eq(T.progress.userId, userId), eq(T.progress.bookId, bookId)))
    .run();
const deleteReadingJob = (userId: number, bookId: number) =>
  db
    .delete(T.reading)
    .where(and(eq(T.reading.userId, userId), eq(T.reading.bookId, bookId)))
    .run();
const localProgress = (userId: number, recordingId: string) =>
  db
    .select()
    .from(s.userProgress)
    .where(
      and(
        eq(s.userProgress.userId, userId),
        eq(s.userProgress.recordingId, recordingId),
      ),
    )
    .get();
const libraryEntry = (userId: number, bookId: string) =>
  db
    .select()
    .from(s.userLibrary)
    .where(
      and(eq(s.userLibrary.userId, userId), eq(s.userLibrary.bookId, bookId)),
    )
    .get();
function queuedJobs(userId: number) {
  return [
    ...db.select().from(T.outbox).where(eq(T.outbox.userId, userId)).all(),
    ...db.select().from(T.progress).where(eq(T.progress.userId, userId)).all(),
    ...db.select().from(T.reading).where(eq(T.reading.userId, userId)).all(),
  ];
}
function state(userId: number): State {
  try {
    return {
      ...defaults,
      ...JSON.parse(getUserSetting(userId, "hardcoverState") || "{}"),
    };
  } catch {
    return { ...defaults };
  }
}
function writeState(userId: number, patch: Partial<State>) {
  setUserSetting(
    userId,
    "hardcoverState",
    JSON.stringify({ ...state(userId), ...patch }),
  );
}
export function resetHardcoverAccount(userId: number) {
  runtime(userId).generation++;
  sqlite.transaction(() => {
    writeState(userId, { ...defaults });
    for (const table of [T.outbox, T.progress, T.reading, T.reads, T.lists, T.links])
      db.delete(table).where(eq(table.userId, userId)).run();
  })();
}
export function setHardcoverToken(userId: number, token: string) {
  if (token !== hardcoverKey(userId)) resetHardcoverAccount(userId);
  setUserSecret(userId, "hardcover", token);
}
export function hardcoverState(userId: number) {
  const data = state(userId);
  return {
    ...data,
    configured: !!hardcoverKey(userId),
    syncing: runtime(userId).syncing,
    pending: queuedJobs(userId).length,
    linked: db.select().from(s.hardcoverLinks).all().length,
    lists: db
      .select()
      .from(T.lists)
      .where(eq(T.lists.userId, userId))
      .all()
      .map((l) => ({
        id: l.id,
        name: l.name,
        count: l.members.length,
        slug: l.slug,
      })),
    shelves: [
      { id: 1, name: "Want to read" },
      { id: 2, name: "Currently reading" },
      { id: 3, name: "Read" },
      { id: 4, name: "Paused" },
      { id: 5, name: "Did not finish" },
    ],
  };
}
export function configureHardcover(
  userId: number,
  mode: SyncMode,
  syncLists: boolean,
) {
  if (mode !== state(userId).mode) runtime(userId).generation++;
  writeState(userId, { mode, syncLists, lastError: null });
  return hardcoverState(userId);
}
async function graphql<T>(
  userId: number,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const live = runtime(userId);
  const expectedGeneration = live.generation;
  const run = async () => {
    if (live.generation !== expectedGeneration)
      throw new Error("The Hardcover connection changed. Sync again.");
    const key = hardcoverKey(userId);
    if (!key)
      throw new Error("Add your Hardcover API token in Settings first.");
    if (live.retryAt > Date.now())
      throw new Error(
        "Hardcover is rate limiting requests. Your changes are saved and will retry shortly.",
      );
    const delay =
      process.env.NODE_ENV === "test"
        ? 0
        : Math.max(0, 1100 - (Date.now() - lastRequest));
    if (delay) await new Promise((r) => setTimeout(r, delay));
    lastRequest = Date.now();
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
      throw new Error(
        "Hardcover could not be reached. Your library and queued changes are kept on this server.",
      );
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After")) || 60;
      live.retryAt = Date.now() + Math.min(3600, seconds) * 1000;
      throw new Error(
        "Hardcover is rate limiting requests. Your changes are saved and will retry shortly.",
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "Hardcover rejected this token or its permissions. Check the scopes in Settings.",
      );
    if (!response.ok)
      throw new Error(
        `Hardcover returned ${response.status}. Your queued changes are kept for retry.`,
      );
    const envelope = (await response.json()) as {
      data?: unknown;
      errors?: { message: string }[];
    };
    if (envelope.errors?.length)
      throw new Error(
        `Hardcover: ${envelope.errors
          .map((e) => e.message)
          .join("; ")
          .slice(0, 450)}`,
      );
    if (live.generation !== expectedGeneration)
      throw new Error("The Hardcover connection changed. Sync again.");
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success)
      throw new Error(
        "Hardcover returned an unexpected response. The last successful library snapshot has been kept.",
      );
    return parsed.data;
  };
  const task = requestTail.then(run, run);
  requestTail = task.catch(() => {});
  return task;
}
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
export async function hardcoverBook(userId: number, id: number) {
  const result = await graphql(
    userId,
    `query SonderBook($id:Int!){books_by_pk(id:$id){${bookFields}}}`,
    { id },
    z.object({ books_by_pk: catalogBook.nullable() }),
  );
  if (!result.books_by_pk)
    throw new Error("Hardcover could not find this book.");
  return result.books_by_pk;
}
async function account(userId: number) {
  const data = await graphql(
    userId,
    "query SonderAccount{me{id username}}",
    {},
    z.object({
      me: z.array(
        z.object({ id: z.number().int(), username: z.string().nullable() }),
      ),
    }),
  );
  if (!data.me[0])
    throw new Error(
      "Hardcover did not return your account. The token needs read:me:content.",
    );
  return data.me[0];
}
export async function testHardcover(userId: number) {
  const who = await account(userId);
  const current = state(userId);
  if (current.accountId !== null && current.accountId !== who.id) {
    resetHardcoverAccount(userId);
    throw new Error(
      "This token belongs to a different Hardcover account. Choose a sync mode again before syncing.",
    );
  }
  writeState(userId, {
    accountId: who.id,
    username: who.username,
    lastError: null,
  });
  return who;
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
function parseRemoteTime(value: string | undefined | null) {
  const n = value ? Date.parse(value) : 0;
  return Number.isFinite(n) ? n : 0;
}
export function hardcoverLinkedBook(workId: string) {
  return db
    .select()
    .from(s.hardcoverLinks)
    .where(eq(s.hardcoverLinks.workId, workId))
    .get()?.bookId;
}
// The work → Hardcover book match is a shared catalogue fact, so moving it clears
// every user's queued work for the old book on this work.
function metadataLink(workId: string, book: CatalogBook) {
  const existing = db
    .select()
    .from(s.hardcoverLinks)
    .where(eq(s.hardcoverLinks.workId, workId))
    .get();
  if (existing && existing.bookId !== book.id) {
    db.delete(T.reading)
      .where(
        and(eq(T.reading.bookId, existing.bookId), eq(T.reading.workId, workId)),
      )
      .run();
    const recordingIds = db
      .select()
      .from(s.editions)
      .where(eq(s.editions.workId, workId))
      .all()
      .flatMap((e) =>
        db
          .select()
          .from(s.recordings)
          .where(eq(s.recordings.editionId, e.id))
          .all(),
      )
      .map((r) => r.id);
    for (const recordingId of recordingIds)
      db.delete(T.editions)
        .where(eq(T.editions.recordingId, recordingId))
        .run();
    for (const queued of db
      .select()
      .from(T.progress)
      .where(eq(T.progress.bookId, existing.bookId))
      .all())
      if (recordingIds.includes(queued.recordingId))
        deleteProgressJob(queued.userId, existing.bookId);
    if (
      !db
        .select()
        .from(s.hardcoverLinks)
        .where(eq(s.hardcoverLinks.bookId, existing.bookId))
        .all()
        .some((l) => l.workId !== workId)
    )
      db.delete(T.outbox).where(eq(T.outbox.bookId, existing.bookId)).run();
  }
  const values = {
    workId,
    bookId: book.id,
    slug: book.slug || null,
    series: book.book_series.flatMap((item) =>
      item.series ? [{ name: item.series.name, position: item.position }] : [],
    ),
  };
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
function applyStatus(userId: number, bookId: number, status: ShelfStatus) {
  for (const link of linkRepresentatives(bookId)) {
    for (const edition of db
      .select()
      .from(s.editions)
      .where(eq(s.editions.workId, link.workId))
      .all())
      db.update(s.userLibrary)
        .set({ status: localStatus(status) })
        .where(
          and(
            eq(s.userLibrary.userId, userId),
            eq(s.userLibrary.bookId, edition.id),
          ),
        )
        .run();
  }
}
function storeRemoteEntry(userId: number, remote: Entry, apply = true) {
  const values = {
    userBookId: remote.id,
    statusId: remote.status_id,
    remoteUpdatedAt: parseRemoteTime(remote.updated_at),
    syncedAt: Date.now(),
  };
  db.insert(T.links)
    .values({ userId, bookId: remote.book_id, ...values })
    .onConflictDoUpdate({ target: [T.links.userId, T.links.bookId], set: values })
    .run();
  if (apply) applyStatus(userId, remote.book_id, remote.status_id);
}
function importCatalogBook(
  userId: number,
  book: CatalogBook,
  status: ShelfStatus | null = null,
  forceLibrary = false,
) {
  let links = linkRepresentatives(book.id);
  let matched = false,
    imported = false;
  if (!links.length) {
    const candidates = db
      .select()
      .from(s.works)
      .all()
      .filter((w) =>
        sameBook(w, { title: book.title || "", author: authorOf(book) }),
      );
    if (candidates.length === 1) {
      metadataLink(candidates[0].id, book);
      links = linkRepresentatives(book.id);
      matched = true;
    }
  }
  if (!links.length) {
    const workId = `work-hc-${book.id}`,
      editionId = `hc-${book.id}`;
    db.insert(s.works)
      .values({
        id: workId,
        title: book.title || "Untitled book",
        author: authorOf(book),
        description:
          book.description ||
          "A book from your Hardcover library. Add a recording whenever you’re ready to listen.",
        genre: "From Hardcover",
        year: book.release_year || new Date().getFullYear(),
      })
      .onConflictDoNothing()
      .run();
    db.insert(s.editions)
      .values({
        id: editionId,
        workId,
        cover: book.cached_image?.url?.startsWith("https://")
          ? book.cached_image.url
          : "/covers/meditations.svg",
        narrator: "Audio not added",
        rating: 0,
        sourceLabel: "Hardcover library",
      })
      .onConflictDoNothing()
      .run();
    db.insert(s.recordings)
      .values({ id: `recording-${editionId}`, editionId })
      .onConflictDoNothing()
      .run();
    metadataLink(workId, book);
    links = linkRepresentatives(book.id);
    imported = true;
  }
  const audio = links.flatMap((l) => audioForWork(l.workId));
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
  if (!db.select().from(s.userHiddenLibrary).where(hidden).get())
    db.insert(s.userLibrary)
      .values({
        userId,
        bookId: representative.id,
        status: localStatus(status || 1),
        addedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  // Metadata-only placeholders are replaced on the shelf when actual audio for that work is linked.
  if (audio.length) {
    for (const link of links)
      for (const e of db
        .select()
        .from(s.editions)
        .where(eq(s.editions.workId, link.workId))
        .all())
        if (e.id.startsWith("hc-") && !audio.some((a) => a.id === e.id))
          db.delete(s.userLibrary)
            .where(
              and(
                eq(s.userLibrary.userId, userId),
                eq(s.userLibrary.bookId, e.id),
              ),
            )
            .run();
  }
  return { bookId: representative.id, matched, imported };
}
export function hardcoverForWork(userId: number, workId: string) {
  const link = db
    .select()
    .from(s.hardcoverLinks)
    .where(eq(s.hardcoverLinks.workId, workId))
    .get();
  if (!link) return undefined;
  const pending = statusJob(userId, link.bookId);
  const queued = progressJob(userId, link.bookId);
  return {
    id: link.bookId,
    slug: link.slug,
    series: link.series,
    statusId: pending?.statusId ?? userLink(userId, link.bookId)?.statusId ?? null,
    pending: !!pending,
    progressFraction: queued
      ? queued.position / queued.duration
      : (lastRead(userId, link.bookId)?.fraction ?? null),
    progressPending: !!queued,
    syncError: pending?.error || queued?.error || null,
    listIds: db
      .select()
      .from(T.lists)
      .where(eq(T.lists.userId, userId))
      .all()
      .filter((l) => l.members.some((m) => m.bookId === link.bookId))
      .map((l) => l.id),
  };
}
// Metadata-only `hc-*` placeholders come from one user's Hardcover shelves and lists, so
// they're only listed for users who have that book themselves, and for admins (r6#1).
// Returns the placeholder edition ids `userId` must not see in the catalogue.
export function hiddenHardcoverPlaceholders(userId: number): Set<string> {
  const role = (
    sqlite.prepare("SELECT role FROM users WHERE id=?").get(userId) as
      | { role: string }
      | undefined
  )?.role;
  if (userId === ADMIN_USER_ID || role === "admin") return new Set();
  const placeholders = sqlite
    .prepare(
      `SELECT e.id, l.book_id AS bookId FROM audio_editions e
       LEFT JOIN hardcover_links l ON l.work_id=e.work_id
       WHERE e.id LIKE 'hc-%' AND NOT EXISTS (
         SELECT 1 FROM recordings r JOIN tracks t ON t.recording_id=r.id WHERE r.edition_id=e.id)`,
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
function canWrite(userId: number) {
  const current = state(userId);
  return (
    current.mode === "two-way" &&
    current.accountId !== null &&
    !!hardcoverKey(userId)
  );
}
export function queueHardcoverStatus(
  userId: number,
  workId: string,
  status: "unread" | "listening" | "finished",
  intent: "status" | "add" = "status",
  updatedAt = Date.now(),
) {
  if (!canWrite(userId)) return;
  const bookId = hardcoverLinkedBook(workId);
  if (bookId === undefined) return;
  queueStatus(
    userId,
    bookId,
    status === "finished" ? 3 : status === "listening" ? 2 : 1,
    intent,
    updatedAt,
  );
}
function queueStatus(
  userId: number,
  bookId: number,
  statusId: ShelfStatus,
  intent: "status" | "add" = "status",
  updatedAt = Date.now(),
) {
  const current = state(userId);
  if (current.mode !== "two-way" || current.accountId === null)
    throw new Error(
      "Enable two-way Hardcover sync and sync your account first.",
    );
  const values = {
    statusId,
    accountId: current.accountId,
    intent,
    updatedAt,
    error: null,
  };
  if (statusId !== 2) {
    deleteReadingJob(userId, bookId);
    deleteProgressJob(userId, bookId);
  }
  db.insert(T.outbox)
    .values({ userId, bookId, ...values })
    .onConflictDoUpdate({ target: [T.outbox.userId, T.outbox.bookId], set: values })
    .run();
  applyStatus(userId, bookId, statusId);
}
export async function importHardcoverBook(
  userId: number,
  id: number,
  workId?: string,
) {
  const book = await hardcoverBook(userId, id);
  let added;
  sqlite.transaction(() => {
    if (workId) {
      if (!db.select().from(s.works).where(eq(s.works.id, workId)).get())
        throw new Error("This local book could not be found.");
      metadataLink(workId, book);
    }
    added = importCatalogBook(userId, book, null, true);
  })();
  const current = state(userId);
  if (!workId && current.mode === "two-way" && current.accountId !== null)
    queueStatus(userId, id, 1, "add");
  return added!;
}
export function setHardcoverShelf(
  userId: number,
  workId: string,
  statusId: ShelfStatus,
) {
  const bookId = hardcoverLinkedBook(workId);
  if (bookId === undefined) throw new Error("Match this book on Hardcover first.");
  queueStatus(userId, bookId, statusId);
  return { queued: true };
}
async function fetchEntries(userId: number, who: number) {
  const entries: Entry[] = [];
  for (let offset = 0; offset < 50000; offset += 250) {
    const page = await graphql(
      userId,
      `query SonderLibrary($userId:Int!,$offset:Int!){user_books(where:{user_id:{_eq:$userId},status_id:{_in:[1,2,3,4,5]}},order_by:{id:asc},limit:250,offset:$offset){${entryFields}}}`,
      { userId: who, offset },
      z.object({ user_books: z.array(entry) }),
    );
    entries.push(...page.user_books);
    if (page.user_books.length < 250) return entries;
  }
  throw new Error(
    "Hardcover returned too many library pages. The previous snapshot was kept.",
  );
}
const ownedList = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  name: z.string(),
  slug: z.string().nullable(),
  books_count: z.number(),
});
async function fetchLists(userId: number, who: number) {
  const lists: z.infer<typeof ownedList>[] = [];
  for (let offset = 0; offset < 10000; offset += 250) {
    const result = await graphql(
      userId,
      "query SonderLists($userId:Int!,$offset:Int!){lists(where:{user_id:{_eq:$userId}},order_by:{id:asc},limit:250,offset:$offset){id user_id name slug books_count}}",
      { userId: who, offset },
      z.object({ lists: z.array(ownedList) }),
    );
    if (result.lists.some((l) => l.user_id !== who))
      throw new Error("Hardcover returned a list owned by another account.");
    lists.push(...result.lists);
    if (result.lists.length < 250) break;
    if (offset === 9750)
      throw new Error("Too many Hardcover lists to sync in one pass.");
  }
  const members: {
    id: number;
    list_id: number;
    book_id: number;
    book: CatalogBook;
  }[] = [];
  for (let i = 0; i < lists.length; i += 100) {
    const ids = lists.slice(i, i + 100).map((l) => l.id);
    for (let offset = 0; offset < 50000; offset += 500) {
      const result = await graphql(
        userId,
        `query SonderListBooks($ids:[Int!]!,$offset:Int!){list_books(where:{list_id:{_in:$ids}},order_by:{id:asc},limit:500,offset:$offset){id list_id book_id book{${bookFields}}}}`,
        { ids, offset },
        z.object({
          list_books: z.array(
            z.object({
              id: z.number().int(),
              list_id: z.number().int(),
              book_id: z.number().int(),
              book: catalogBook,
            }),
          ),
        }),
      );
      if (result.list_books.some((m) => !ids.includes(m.list_id)))
        throw new Error("Hardcover returned an unexpected list membership.");
      members.push(...result.list_books);
      if (result.list_books.length < 500) break;
      if (offset === 49500)
        throw new Error("Too many list entries to sync in one pass.");
    }
  }
  return { lists, members };
}
async function pushStatus(
  userId: number,
  job: { bookId: number; statusId: number },
  remote?: Entry,
) {
  const schema = z.object({
    error: z.string().nullable().optional(),
    user_book: entry.nullable(),
  });
  let updated: Entry;
  if (remote) {
    const response = await graphql(
      userId,
      `mutation SonderShelfUpdate($id:Int!,$object:UserBookUpdateInput!){update_user_book(id:$id,object:$object){error user_book{${entryFields}}}}`,
      { id: remote.id, object: { status_id: job.statusId } },
      z.object({ update_user_book: schema }),
    );
    if (response.update_user_book.error || !response.update_user_book.user_book)
      throw new Error(
        response.update_user_book.error ||
          "Hardcover did not save this shelf change.",
      );
    updated = response.update_user_book.user_book;
  } else {
    const response = await graphql(
      userId,
      `mutation SonderShelfAdd($object:UserBookCreateInput!){insert_user_book(object:$object){error user_book{${entryFields}}}}`,
      { object: { book_id: job.bookId, status_id: job.statusId } },
      z.object({ insert_user_book: schema }),
    );
    if (response.insert_user_book.error || !response.insert_user_book.user_book)
      throw new Error(
        response.insert_user_book.error ||
          "Hardcover did not add this book to your shelf.",
      );
    updated = response.insert_user_book.user_book;
  }
  if (updated.book_id !== job.bookId || updated.status_id !== job.statusId)
    throw new Error(
      "Hardcover returned a different book or status. This change remains queued.",
    );
  return updated;
}
export type SyncSummary = {
  imported: number;
  matched: number;
  pushed: number;
  conflicts: number;
  lists: number;
  pending: number;
  progress: number;
};
async function runSync(userId: number): Promise<SyncSummary> {
  if (state(userId).mode === "off")
    throw new Error("Choose import or two-way library sync in Settings first.");
  const live = runtime(userId);
  const expectedGeneration = live.generation;
  live.syncing = true;
  const ownStatusWrites = new Set<number>();
  const summary: SyncSummary = {
    imported: 0,
    matched: 0,
    pushed: 0,
    conflicts: 0,
    lists: 0,
    pending: 0,
    progress: 0,
  };
  try {
    const who = await testHardcover(userId);
    const snapshot = await fetchEntries(userId, who.id);
    let listData: Awaited<ReturnType<typeof fetchLists>> | null = null;
    let listWarning: string | null = null;
    if (state(userId).syncLists) {
      try {
        listData = await fetchLists(userId, who.id);
      } catch (error) {
        listWarning = (error as Error).message;
      }
    }
    if (live.generation !== expectedGeneration)
      throw new Error("The Hardcover connection changed. Sync again.");
    // Only a complete, validated snapshot is committed. Neither remote deletions nor missing pages delete local books.
    sqlite.transaction(() => {
      for (const remote of snapshot) {
        const added = importCatalogBook(userId, remote.book, remote.status_id);
        summary.imported += Number(added.imported);
        summary.matched += Number(added.matched);
        bootstrapLocalProgress(userId, remote);
        const dirty = statusJob(userId, remote.book_id);
        const progressDirty = progressJob(userId, remote.book_id);
        storeRemoteEntry(userId, remote, !dirty && !progressDirty);
        if (!dirty) pullRemoteProgress(userId, remote);
      }
      if (listData) {
        db.delete(T.lists).where(eq(T.lists.userId, userId)).run();
        for (const list of listData.lists) {
          const members = listData.members.filter((m) => m.list_id === list.id);
          for (const item of members) {
            const added = importCatalogBook(userId, item.book);
            summary.imported += Number(added.imported);
            summary.matched += Number(added.matched);
          }
          db.insert(T.lists)
            .values({
              userId,
              id: list.id,
              accountId: who.id,
              name: list.name,
              slug: list.slug,
              members: members.map((m) => ({ id: m.id, bookId: m.book_id })),
              syncedAt: Date.now(),
            })
            .run();
        }
        summary.lists = listData.lists.length;
      }
    })();
    if (state(userId).mode === "two-way") {
      const jobs = db
        .select()
        .from(T.outbox)
        .where(eq(T.outbox.userId, userId))
        .all();
      for (const job of jobs) {
        if (job.accountId !== who.id) continue;
        const remote = snapshot.find((e) => e.book_id === job.bookId);
        try {
          let result = remote;
          const remoteWins =
            (!!remote && job.intent === "add") ||
            (!!remote && parseRemoteTime(remote.updated_at) > job.updatedAt);
          if (remoteWins || remote?.status_id === job.statusId) {
            if (remote && remote.status_id !== job.statusId)
              summary.conflicts++;
          } else {
            result = await pushStatus(userId, job, remote);
            ownStatusWrites.add(job.bookId);
            summary.pushed++;
            if (remote) snapshot[snapshot.indexOf(remote)] = result;
            else snapshot.push(result);
          }
          // A new local action arriving during a request must keep its own outbox entry.
          const latest = statusJob(userId, job.bookId);
          if (latest?.updatedAt === job.updatedAt) {
            sqlite.transaction(() => {
              if (result) storeRemoteEntry(userId, result);
              deleteStatusJob(userId, job.bookId);
            })();
          }
        } catch (error) {
          const latest = statusJob(userId, job.bookId);
          if (latest?.updatedAt === job.updatedAt)
            db.update(T.outbox)
              .set({ error: (error as Error).message })
              .where(
                and(eq(T.outbox.userId, userId), eq(T.outbox.bookId, job.bookId)),
              )
              .run();
        }
      }
    }
    if (state(userId).mode === "two-way") {
      summary.progress = await flushProgress(
        userId,
        snapshot,
        who.id,
        ownStatusWrites,
      );
      summary.progress += await flushReaderProgress(userId, snapshot, who.id);
    }
    const queued = queuedJobs(userId);
    summary.pending = queued.length;
    writeState(userId, {
      lastSync: Date.now(),
      lastError: queued.find((j) => j.error)?.error || null,
      listWarning,
    });
    return summary;
  } catch (error) {
    writeState(userId, { lastError: (error as Error).message });
    throw error;
  } finally {
    live.syncing = false;
  }
}
export function syncHardcover(userId: number) {
  const live = runtime(userId);
  if (live.activeSync) return live.activeSync;
  live.activeSync = runSync(userId).finally(() => {
    live.activeSync = null;
  });
  return live.activeSync;
}
async function tickUser(userId: number) {
  const current = state(userId);
  if (
    !hardcoverKey(userId) ||
    current.mode === "off" ||
    runtime(userId).retryAt > Date.now()
  )
    return;
  if (
    current.lastSync &&
    Date.now() - current.lastSync < 900000 &&
    !queuedJobs(userId).length
  )
    return;
  await syncHardcover(userId);
}
export async function tickHardcover() {
  // One user's failing account must not hold back the others.
  for (const userId of listUserIds()) await tickUser(userId).catch(() => {});
}
export async function setHardcoverListMember(
  userId: number,
  listId: number,
  workId: string,
  included: boolean,
) {
  const current = state(userId);
  if (current.mode !== "two-way")
    throw new Error(
      "Enable two-way sync to organize Hardcover lists from Sonder.",
    );
  const who = await testHardcover(userId);
  const listWhere = and(eq(T.lists.userId, userId), eq(T.lists.id, listId));
  const list = db.select().from(T.lists).where(listWhere).get();
  if (!list || list.accountId !== who.id)
    throw new Error("Sync your own Hardcover lists before editing them.");
  const bookId = hardcoverLinkedBook(workId);
  if (bookId === undefined) throw new Error("Match this book on Hardcover first.");
  const found = await graphql(
    userId,
    "query SonderListMembership($list:Int!,$book:Int!){list_books(where:{list_id:{_eq:$list},book_id:{_eq:$book}},limit:1){id list_id book_id}}",
    { list: listId, book: bookId },
    z.object({
      list_books: z.array(
        z.object({ id: z.number(), list_id: z.number(), book_id: z.number() }),
      ),
    }),
  );
  let membership = found.list_books[0];
  if (membership && (membership.list_id !== listId || membership.book_id !== bookId))
    throw new Error("Hardcover returned an unexpected list entry.");
  if (included && !membership) {
    const result = await graphql(
      userId,
      "mutation SonderListAdd($object:ListBookInput!){insert_list_book(object:$object){id list_book{id list_id book_id}}}",
      { object: { list_id: listId, book_id: bookId } },
      z.object({
        insert_list_book: z.object({
          id: z.number().nullable(),
          list_book: z
            .object({
              id: z.number(),
              list_id: z.number(),
              book_id: z.number(),
            })
            .nullable(),
        }),
      }),
    );
    if (!result.insert_list_book.list_book)
      throw new Error("Hardcover did not add the book to this list.");
    membership = result.insert_list_book.list_book;
    if (membership.list_id !== listId || membership.book_id !== bookId)
      throw new Error("Hardcover returned an unexpected list entry.");
  }
  if (!included && membership) {
    const result = await graphql(
      userId,
      "mutation SonderListRemove($id:Int!){delete_list_book(id:$id){id}}",
      { id: membership.id },
      z.object({ delete_list_book: z.object({ id: z.number().nullable() }) }),
    );
    if (result.delete_list_book.id !== membership.id)
      throw new Error("Hardcover did not remove this list entry.");
  }
  const latest = db.select().from(T.lists).where(listWhere).get() || list;
  const members = latest.members.filter((m) => m.bookId !== bookId);
  if (included && membership) members.push({ id: membership.id, bookId });
  db.update(T.lists)
    .set({ members, syncedAt: Date.now() })
    .where(listWhere)
    .run();
  return { ok: true };
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
// New audio for a linked work replaces metadata-only placeholders on every user's shelf
// and picks up that user's own Hardcover shelf status and remembered position.
export function claimHardcoverAudio(workId: string, editionId: string) {
  const bookId = hardcoverLinkedBook(workId);
  if (bookId === undefined) return;
  const placeholders = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all()
    .filter((e) => e.id.startsWith("hc-") && e.id !== editionId);
  const recording = db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.editionId, editionId))
    .get();
  for (const userId of listUserIds()) {
    const shelved = placeholders.flatMap((e) => libraryEntry(userId, e.id) || []);
    if (
      shelved.length &&
      !db
        .select()
        .from(s.userHiddenLibrary)
        .where(
          and(
            eq(s.userHiddenLibrary.userId, userId),
            eq(s.userHiddenLibrary.bookId, editionId),
          ),
        )
        .get()
    )
      db.insert(s.userLibrary)
        .values({
          userId,
          bookId: editionId,
          status: shelved[0].status,
          addedAt: Date.now(),
        })
        .onConflictDoNothing()
        .run();
    const dirty = statusJob(userId, bookId);
    const known = userLink(userId, bookId);
    if (dirty || known)
      applyStatus(
        userId,
        bookId,
        (dirty?.statusId || known?.statusId || 1) as ShelfStatus,
      );
    const remoteRead = lastRead(userId, bookId);
    if (
      state(userId).mode !== "off" &&
      recording &&
      remoteRead?.fraction != null &&
      !localProgress(userId, recording.id) &&
      recordingData(recording.id)?.completeDuration
    )
      applyFraction(userId, recording.id, remoteRead.fraction);
    for (const e of placeholders)
      db.delete(s.userLibrary)
        .where(
          and(eq(s.userLibrary.userId, userId), eq(s.userLibrary.bookId, e.id)),
        )
        .run();
  }
}
function recordingData(recordingId: string) {
  const rec = db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.id, recordingId))
    .get();
  if (!rec) return null;
  const edition = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.id, rec.editionId))
    .get();
  if (!edition) return null;
  const tracks = db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.recordingId, recordingId))
    .all()
    .sort((a, b) => a.index - b.index);
  const duration = tracks.reduce((n, t) => n + t.duration, 0);
  return {
    rec,
    edition,
    tracks,
    duration,
    completeDuration: tracks.length > 0 && tracks.every((t) => t.duration > 0),
  };
}
function bootstrapLocalProgress(userId: number, remote: Entry) {
  if (
    state(userId).mode !== "two-way" ||
    lastRead(userId, remote.book_id) ||
    statusJob(userId, remote.book_id) ||
    progressJob(userId, remote.book_id)
  )
    return;
  const recording = chooseLocalRecording(userId, remote.book_id);
  if (!recording) return;
  const local = localProgress(userId, recording.rec.id);
  if (!local || local.updatedAt <= parseRemoteTime(remote.updated_at)) return;
  const saved = libraryEntry(userId, recording.edition.id);
  queueHardcoverStatus(
    userId,
    recording.edition.workId,
    (saved?.status || "listening") as "unread" | "listening" | "finished",
    "status",
    local.updatedAt,
  );
  queueHardcoverProgress(userId, recording.rec.id);
  rememberRead(userId, remote);
}
export function queueHardcoverProgress(userId: number, recordingId: string) {
  if (!canWrite(userId)) return;
  const current = state(userId);
  const data = recordingData(recordingId);
  if (!data?.completeDuration) return;
  const bookId = hardcoverLinkedBook(data.edition.workId);
  const position = localProgress(userId, recordingId);
  if (bookId === undefined || !position) return;
  const reading = readingJob(userId, bookId);
  if (reading && reading.updatedAt > position.updatedAt) return;
  const index = data.tracks.findIndex((t) => t.id === position.trackId);
  if (index < 0) return;
  const absolute = Math.min(
    data.duration,
    data.tracks.slice(0, index).reduce((n, t) => n + t.duration, 0) +
      position.position,
  );
  const saved = libraryEntry(userId, data.edition.id);
  if (saved?.status === "finished" && absolute / data.duration < 0.999) return;
  const values = {
    accountId: current.accountId!,
    recordingId,
    position: absolute,
    duration: data.duration,
    updatedAt: position.updatedAt,
    error: null,
  };
  db.insert(T.progress)
    .values({ userId, bookId, ...values })
    .onConflictDoUpdate({
      target: [T.progress.userId, T.progress.bookId],
      set: values,
    })
    .run();
  deleteReadingJob(userId, bookId);
}
export function remoteProgressFraction(remote: Entry) {
  if (remote.status_id === 3) return 1;
  const read = remote.user_book_reads[0];
  if (!read) return null;
  const audio = read.edition?.audio_seconds || 0,
    pages = read.edition?.pages || remote.book.pages || 0;
  if (read.progress_seconds != null && audio > 0)
    return Math.max(0, Math.min(1, read.progress_seconds / audio));
  if (read.progress_pages != null && pages > 0)
    return Math.max(0, Math.min(1, read.progress_pages / pages));
  return null;
}
export function queueHardcoverReadingProgress(
  userId: number,
  workId: string,
  fraction: number,
  recordingId?: string,
) {
  if (!canWrite(userId)) return;
  const bookId = hardcoverLinkedBook(workId);
  if (bookId === undefined) return;
  queueStatus(userId, bookId, fraction >= 0.999 ? 3 : 2);
  const values = {
    accountId: state(userId).accountId!,
    workId,
    fraction: Math.max(0, Math.min(1, fraction)),
    updatedAt: Date.now(),
    error: null,
  };
  db.insert(T.reading)
    .values({ userId, bookId, ...values })
    .onConflictDoUpdate({
      target: [T.reading.userId, T.reading.bookId],
      set: values,
    })
    .run();
  deleteProgressJob(userId, bookId);
}
async function flushReaderProgress(
  userId: number,
  snapshot: Entry[],
  who: number,
) {
  let pushed = 0;
  for (const job of db
    .select()
    .from(T.reading)
    .where(eq(T.reading.userId, userId))
    .all()) {
    if (job.accountId !== who) continue;
    const sameJob = and(
      eq(T.reading.userId, userId),
      eq(T.reading.bookId, job.bookId),
      eq(T.reading.updatedAt, job.updatedAt),
    );
    try {
      if (statusJob(userId, job.bookId)) continue;
      const remote =
        snapshot.find((entry) => entry.book_id === job.bookId) ||
        (await remoteEntry(userId, job.bookId, who));
      if (!remote)
        throw new Error(
          "Add this book to your Hardcover library before syncing reading progress.",
        );
      const read = await ensureRead(userId, remote),
        pages = read.edition?.pages || remote.book.pages || 0;
      const audio = remote.book.default_audio_edition;
      if (!pages && !audio?.audio_seconds)
        throw new Error(
          "Hardcover has no page count or audio duration for this book. Your precise reading position remains saved in Sonder.",
        );
      const object = {
        edition_id: pages ? (read.edition_id ?? null) : audio!.id,
        started_at: read.started_at ?? null,
        finished_at: read.finished_at ?? null,
        finished_at_precision: read.finished_at_precision ?? null,
        progress_pages: pages
          ? Math.round(job.fraction * pages)
          : (read.progress_pages ?? null),
        progress_seconds: pages
          ? null
          : Math.round(job.fraction * audio!.audio_seconds!),
      };
      const result = await graphql(
        userId,
        `mutation SonderReadProgress($id:Int!,$object:DatesReadInput!){update_user_book_read(id:$id,object:$object){error user_book_read{${readFields}}}}`,
        { id: read.id, object },
        z.object({
          update_user_book_read: z.object({
            error: z.string().nullable().optional(),
            user_book_read: readSchema.nullable(),
          }),
        }),
      );
      if (
        result.update_user_book_read.error ||
        !result.update_user_book_read.user_book_read ||
        result.update_user_book_read.user_book_read.id !== read.id
      )
        throw new Error(
          result.update_user_book_read.error ||
            "Hardcover did not save this reading position.",
        );
      rememberRead(userId, {
        ...remote,
        user_book_reads: [result.update_user_book_read.user_book_read],
      });
      db.delete(T.reading).where(sameJob).run();
      pushed++;
    } catch (error) {
      db.update(T.reading)
        .set({ error: (error as Error).message })
        .where(sameJob)
        .run();
    }
  }
  return pushed;
}
function readFingerprint(remote: Entry) {
  const r = remote.user_book_reads[0];
  return JSON.stringify(
    r
      ? {
          id: r.id,
          editionId: r.edition_id,
          seconds: r.progress_seconds,
          pages: r.progress_pages,
          finished: r.finished_at,
          status: remote.status_id,
        }
      : { status: remote.status_id },
  );
}
function rememberRead(userId: number, remote: Entry) {
  const current = state(userId);
  if (current.accountId === null) return;
  const values = {
    accountId: current.accountId,
    snapshot: readFingerprint(remote),
    fraction: remoteProgressFraction(remote),
    syncedAt: Date.now(),
  };
  db.insert(T.reads)
    .values({ userId, bookId: remote.book_id, ...values })
    .onConflictDoUpdate({ target: [T.reads.userId, T.reads.bookId], set: values })
    .run();
}
function chooseLocalRecording(
  userId: number,
  bookId: number,
  requested?: string,
) {
  const links = linkRepresentatives(bookId);
  const candidates = links
    .flatMap((l) =>
      db.select().from(s.editions).where(eq(s.editions.workId, l.workId)).all(),
    )
    .flatMap((e) =>
      db
        .select()
        .from(s.recordings)
        .where(eq(s.recordings.editionId, e.id))
        .all(),
    )
    .map((r) => recordingData(r.id))
    .filter(
      (r): r is NonNullable<ReturnType<typeof recordingData>> =>
        !!r?.completeDuration,
    );
  if (requested) return candidates.find((c) => c.rec.id === requested) || null;
  return (
    candidates.sort(
      (a, b) =>
        (localProgress(userId, b.rec.id)?.updatedAt || 0) -
        (localProgress(userId, a.rec.id)?.updatedAt || 0),
    )[0] || null
  );
}
function applyFraction(userId: number, recordingId: string, fraction: number) {
  const data = recordingData(recordingId);
  if (!data?.completeDuration)
    throw new Error(
      "The recording’s chapter durations are not known yet. Play or save the audio on your server first.",
    );
  const absolute = Math.max(
    0,
    Math.min(data.duration, fraction * data.duration),
  );
  let offset = 0;
  let track = data.tracks[data.tracks.length - 1];
  for (const t of data.tracks) {
    if (absolute < offset + t.duration) {
      track = t;
      break;
    }
    offset += t.duration;
  }
  if (absolute >= data.duration) offset = data.duration - track.duration;
  const value = {
    recordingId,
    trackId: track.id,
    position: Math.min(track.duration, Math.max(0, absolute - offset)),
    duration: track.duration,
    updatedAt: Date.now(),
  };
  db.insert(s.userProgress)
    .values({ ...value, userId })
    .onConflictDoUpdate({
      target: [s.userProgress.userId, s.userProgress.recordingId],
      set: value,
    })
    .run();
  return value;
}
function pullRemoteProgress(
  userId: number,
  remote: Entry,
  requestedRecording?: string,
  force = false,
) {
  const fraction = remoteProgressFraction(remote);
  if (fraction === null) {
    rememberRead(userId, remote);
    return null;
  }
  const last = lastRead(userId, remote.book_id);
  const changed = !last || last.snapshot !== readFingerprint(remote);
  const queued = progressJob(userId, remote.book_id);
  const target = chooseLocalRecording(userId, remote.book_id, requestedRecording);
  if (!target) {
    rememberRead(userId, remote);
    return null;
  }
  const local = localProgress(userId, target.rec.id);
  const initialLocalIsNewer =
    !last && !!local && local.updatedAt > parseRemoteTime(remote.updated_at);
  const readingQueued = readingJob(userId, remote.book_id);
  if (
    force ||
    ((changed || !local) && !queued && !readingQueued && !initialLocalIsNewer)
  ) {
    const progress = applyFraction(userId, target.rec.id, fraction);
    rememberRead(userId, remote);
    return progress;
  }
  if (!queued) rememberRead(userId, remote);
  return null;
}
async function remoteEntry(userId: number, bookId: number, who: number) {
  const data = await graphql(
    userId,
    `query SonderBookProgress($bookId:Int!,$userId:Int!){user_books(where:{book_id:{_eq:$bookId},user_id:{_eq:$userId}},limit:1){${entryFields}}}`,
    { bookId, userId: who },
    z.object({ user_books: z.array(entry) }),
  );
  return data.user_books[0] || null;
}
const selectedEdition = (userId: number, recordingId: string) =>
  db
    .select()
    .from(T.editions)
    .where(
      and(eq(T.editions.userId, userId), eq(T.editions.recordingId, recordingId)),
    )
    .get();
function editionForProgress(
  userId: number,
  book: CatalogBook,
  recordingId: string,
  read?: Read,
) {
  const selected = selectedEdition(userId, recordingId);
  const editions = [
    ...book.editions,
    ...(book.default_audio_edition ? [book.default_audio_edition] : []),
  ].filter((e, i, all) => all.findIndex((a) => a.id === e.id) === i);
  if (selected) {
    const match = editions.find(
      (e) => e.id === selected.editionId && !!e.audio_seconds,
    );
    if (!match)
      throw new Error(
        "The selected Hardcover audio edition is no longer available. Choose another edition.",
      );
    return match;
  }
  if (read?.edition?.audio_seconds) {
    const e = editions.find((e) => e.id === read.edition_id);
    if (e) return e;
  }
  const local = recordingData(recordingId);
  const narrator = local ? normalized(local.edition.narrator) : "";
  const matches = editions.filter(
    (e) =>
      (e.audio_seconds || 0) > 0 &&
      !!narrator &&
      !["unknown narrator", "audio not added", "librivox volunteers"].includes(
        narrator,
      ) &&
      e.contributions.some(
        (c) =>
          c.contribution?.toLowerCase() === "narrator" &&
          normalized(c.author?.name || "") === narrator,
      ),
  );
  const matched = matches.sort(
    (a, b) =>
      Math.abs((a.audio_seconds || 0) - (local?.duration || 0)) -
      Math.abs((b.audio_seconds || 0) - (local?.duration || 0)),
  )[0];
  if (matched) return matched;
  if (book.default_audio_edition?.audio_seconds)
    return book.default_audio_edition;
  return editions.find((e) => (e.audio_seconds || 0) > 0) || null;
}
async function ensureRead(userId: number, remote: Entry) {
  if (remote.user_book_reads[0]) return remote.user_book_reads[0];
  const result = await graphql(
    userId,
    `mutation SonderReadStart($userBookId:Int!,$read:DatesReadInput!){insert_user_book_read(user_book_id:$userBookId,user_book_read:$read){error user_book_read{${readFields}}}}`,
    {
      userBookId: remote.id,
      read: { started_at: new Date().toISOString().slice(0, 10) },
    },
    z.object({
      insert_user_book_read: z.object({
        error: z.string().nullable().optional(),
        user_book_read: readSchema.nullable(),
      }),
    }),
  );
  if (
    result.insert_user_book_read.error ||
    !result.insert_user_book_read.user_book_read
  )
    throw new Error(
      result.insert_user_book_read.error || "Hardcover could not start a read.",
    );
  return result.insert_user_book_read.user_book_read;
}
async function flushProgress(
  userId: number,
  snapshot: Entry[],
  who: number,
  ownStatusWrites: Set<number>,
) {
  let pushed = 0;
  for (const job of db
    .select()
    .from(T.progress)
    .where(eq(T.progress.userId, userId))
    .all()) {
    if (job.accountId !== who) continue;
    // A newer local position queued while this request was in flight keeps its own job.
    const settle = () => {
      if (progressJob(userId, job.bookId)?.updatedAt === job.updatedAt)
        deleteProgressJob(userId, job.bookId);
    };
    try {
      let remote =
        snapshot.find((e) => e.book_id === job.bookId) ||
        (await remoteEntry(userId, job.bookId, who));
      if (statusJob(userId, job.bookId)) continue;
      const previous = lastRead(userId, job.bookId);
      if (
        remote &&
        !ownStatusWrites.has(job.bookId) &&
        previous &&
        previous.snapshot !== readFingerprint(remote) &&
        parseRemoteTime(remote.updated_at) > job.updatedAt
      ) {
        pullRemoteProgress(userId, remote, job.recordingId, true);
        storeRemoteEntry(userId, remote);
        settle();
        continue;
      }
      if (
        !remote ||
        [1, 4, 5].includes(remote.status_id) ||
        (remote.status_id === 3 && job.position / job.duration < 0.999)
      ) {
        const book = remote?.book || (await hardcoverBook(userId, job.bookId));
        remote = await pushStatus(
          userId,
          { bookId: job.bookId, statusId: 2 },
          remote || undefined,
        );
        metadataLink(
          chooseLocalRecording(userId, job.bookId, job.recordingId)!.edition
            .workId,
          book,
        );
        storeRemoteEntry(userId, remote);
      }
      {
        const read = await ensureRead(userId, remote);
        const edition = editionForProgress(
          userId,
          remote.book,
          job.recordingId,
          read,
        );
        const fraction = Math.max(0, Math.min(1, job.position / job.duration));
        const pages = read.edition?.pages || remote.book.pages || 0;
        if (!edition && !pages)
          throw new Error(
            "Hardcover has no audio duration or page count for this book. Select an audio edition before syncing progress.",
          );
        const object = {
          edition_id: edition?.id ?? read.edition_id ?? null,
          started_at: read.started_at ?? null,
          finished_at: read.finished_at ?? null,
          finished_at_precision: read.finished_at_precision ?? null,
          progress_seconds: edition
            ? Math.round(fraction * (edition.audio_seconds || 0))
            : null,
          progress_pages: edition
            ? (read.progress_pages ?? null)
            : Math.round(fraction * pages),
        };
        const result = await graphql(
          userId,
          `mutation SonderReadProgress($id:Int!,$object:DatesReadInput!){update_user_book_read(id:$id,object:$object){error user_book_read{${readFields}}}}`,
          { id: read.id, object },
          z.object({
            update_user_book_read: z.object({
              error: z.string().nullable().optional(),
              user_book_read: readSchema.nullable(),
            }),
          }),
        );
        if (
          result.update_user_book_read.error ||
          !result.update_user_book_read.user_book_read
        )
          throw new Error(
            result.update_user_book_read.error ||
              "Hardcover did not save your reading progress.",
          );
        if (result.update_user_book_read.user_book_read.id !== read.id)
          throw new Error(
            "Hardcover returned a different read. Your position remains queued.",
          );
        remote = {
          ...remote,
          user_book_reads: [result.update_user_book_read.user_book_read],
        };
        rememberRead(userId, remote);
        pushed++;
      }
      settle();
    } catch (error) {
      if (progressJob(userId, job.bookId)?.updatedAt === job.updatedAt)
        db.update(T.progress)
          .set({ error: (error as Error).message })
          .where(
            and(eq(T.progress.userId, userId), eq(T.progress.bookId, job.bookId)),
          )
          .run();
    }
  }
  return pushed;
}
export async function pullHardcoverPosition(
  userId: number,
  workId: string,
  recordingId: string,
) {
  const current = state(userId);
  if (current.mode === "off")
    throw new Error("Enable Hardcover library sync first.");
  const who = await testHardcover(userId);
  const bookId = hardcoverLinkedBook(workId);
  const target = recordingData(recordingId);
  if (bookId === undefined || target?.edition.workId !== workId)
    throw new Error("Choose a linked recording of this book.");
  const remote = await remoteEntry(userId, bookId, who.id);
  if (!remote || remoteProgressFraction(remote) === null)
    throw new Error("Hardcover has no reading position for this book yet.");
  const progress = pullRemoteProgress(userId, remote, recordingId, true);
  deleteReadingJob(userId, bookId);
  deleteProgressJob(userId, bookId);
  return { progress };
}
export async function hardcoverRecordingOptions(
  userId: number,
  workId: string,
  recordingId: string,
) {
  const bookId = hardcoverLinkedBook(workId);
  const recording = recordingData(recordingId);
  if (bookId === undefined || recording?.edition.workId !== workId)
    throw new Error("Choose a linked recording of this book.");
  const book = await hardcoverBook(userId, bookId);
  const editions = [
    ...book.editions,
    ...(book.default_audio_edition ? [book.default_audio_edition] : []),
  ].filter(
    (e, i, all) =>
      (e.audio_seconds || 0) > 0 && all.findIndex((a) => a.id === e.id) === i,
  );
  return {
    selectedEditionId: selectedEdition(userId, recordingId)?.editionId || null,
    editions: editions.map((e) => ({
      id: e.id,
      duration: e.audio_seconds,
      narrators: e.contributions
        .filter((c) => c.contribution?.toLowerCase() === "narrator")
        .flatMap((c) => c.author?.name || []),
    })),
    localDuration: recording.duration,
    durationsKnown: recording.completeDuration,
  };
}
export async function setHardcoverRecordingEdition(
  userId: number,
  workId: string,
  recordingId: string,
  editionId: number | null,
) {
  const options = await hardcoverRecordingOptions(userId, workId, recordingId);
  if (editionId !== null && !options.editions.some((e) => e.id === editionId))
    throw new Error("Choose an audio edition of this Hardcover book.");
  if (editionId === null)
    db.delete(T.editions)
      .where(
        and(eq(T.editions.userId, userId), eq(T.editions.recordingId, recordingId)),
      )
      .run();
  else
    db.insert(T.editions)
      .values({ userId, recordingId, editionId })
      .onConflictDoUpdate({
        target: [T.editions.userId, T.editions.recordingId],
        set: { editionId },
      })
      .run();
  return { ok: true };
}
