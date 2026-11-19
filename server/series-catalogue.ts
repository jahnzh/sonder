// Series on AudiobookDB (#721 part b). What Hardcover's series did, on AudiobookDB's text ids: Discover's series
// search, the series page of a series that is not saved (preview) and of a saved one, Save series with its Add
// choices, the refresh and the new-book notice, and the books the series search acquires (`series-acquisition.ts`).
//
// - Membership and position come from `GET /api/series/{id}`: each member's structured `position` (label and
//   `sortKey`; novellas at 0.1 or 1.5 are numbers of their own). The members are read in `sortKey` order.
// - English only (the owner, 19 Nov): a member whose releases AudiobookDB names in other languages only is left out;
//   a member whose language is not known stays.
// - A book of the series with no audiobook is not in AudiobookDB. Open Library lists it (`series:"<name>"`) as
//   "No audiobook yet": a row with `audiobook: false` and the book id `openlibrary:<work>`. Added, its work links to
//   Open Library and only its ebook is searched for. Once AudiobookDB lists the book (a refresh), the row becomes
//   the AudiobookDB member: the work, the user's choice and what they saw move to it and the audiobook is searched for.
// - The catalogue is shared (`series_catalogue*`); what a user saved, added and saw is theirs. Covers stay addresses.
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { selectSeriesDefaults, seriesBooks } from "../src/series-selection.ts";
import {
  audiobookDbBook,
  audiobookDbReleases,
  audiobookDbSeries,
  isEnglish,
  searchAudiobookDbSeries,
  type CatalogueSeries,
} from "./audiobookdb.ts";
import { searchOpenLibrarySeries } from "./openlibrary.ts";
import { CatalogueError, type Priority } from "./catalogue-provider.ts";
import { authorMatches, englishRelease, linkWork, normaliseTitle, titleMatches } from "./catalogue-links.ts";
import { ensurePlaceholder, isPlaceholderEdition } from "./placeholder-edition.ts";
import { hasServerMedia } from "./downloads.ts";
import { getWorkMediaStates } from "./work-media-state.ts";
import { enqueueSeriesAcquisition, seriesWorkAcquisitions } from "./series-acquisition.ts";
import { listEbookSetMembers } from "./ebook-set.ts";
import {
  libraryOriginFor,
  libraryOriginLabel,
  removalDefaultSelected,
  removeUserLibraryRow,
  setLibraryOrigin,
} from "./library-origin.ts";
import { workCompletions } from "./work-completion.ts";
import { ADMIN_USER_ID } from "./users.ts";
import type { BackgroundProcess } from "./background-runner.ts";

export const OPEN_LIBRARY_BOOK_PREFIX = "openlibrary:";
export const isOpenLibraryBookId = (bookId: string) => bookId.startsWith(OPEN_LIBRARY_BOOK_PREFIX);
const openLibraryWorkOf = (bookId: string) => bookId.slice(OPEN_LIBRARY_BOOK_PREFIX.length);

/** One book of a series as the catalogue keeps it. */
export type SeriesMember = {
  id: string;
  provider: "audiobookdb" | "openlibrary";
  title: string;
  author: string;
  position: number | null;
  positionLabel: string | null;
  cover: string | null;
  unreleased: boolean;
  language: string | null;
  narrators: string[];
  lengthMs: number | null;
  releaseDate: string | null;
};
export type SeriesCatalogueEntry = { id: string; name: string; author: string | null; count: number | null; members: SeriesMember[] };

const isAdminUser = (userId: number) =>
  userId === ADMIN_USER_ID || (sqlite.prepare("SELECT role FROM users WHERE id=?").pluck().get(userId) as string | undefined) === "admin";
const today = () => new Date().toISOString().slice(0, 10);
/** A date after today, or a year after this one: the book is not out yet. */
export const releasedLater = (date: string | null, now = today()) => !!date && (date.length === 4 ? date > now.slice(0, 4) : date > now);
const sameTitle = (a: string, b: string) => normaliseTitle(a) === normaliseTitle(b);

// ---- Reading a series from AudiobookDB (and its gaps from Open Library) ----
/**
 * Whether a member is in English: the languages the series answer names, else the book's own detail, else its
 * releases (each a detail, cached a week). Unknown is English, as for a work's releases (`englishRelease`).
 */
async function memberLanguage(member: CatalogueSeries["members"][number], priority: Priority): Promise<{ english: boolean; language: string | null; narrators: string[]; lengthMs: number | null }> {
  const fallback = { narrators: member.book.narrators, lengthMs: member.lengthMs };
  const named = member.book.languages;
  if (named.length) return { english: named.some(isEnglish), language: named.find(isEnglish) ? "en" : named[0], ...fallback };
  try {
    const book = await audiobookDbBook(member.book.id, { priority });
    if (book.languages.length) return { english: book.languages.some(isEnglish), language: book.languages.find(isEnglish) ? "en" : book.languages[0], ...fallback };
    if (!book.releaseIds.length) return { english: true, language: null, ...fallback };
    const releases = await audiobookDbReleases(book.id, { priority });
    const english = releases.filter(englishRelease);
    if (releases.length && !english.length) return { english: false, language: releases[0].language, ...fallback };
    return {
      english: true,
      language: english.some((release) => release.language) ? "en" : null,
      narrators: fallback.narrators.length ? fallback.narrators : [...new Set(english.flatMap((release) => release.narrators))],
      lengthMs: fallback.lengthMs ?? english.find((release) => release.lengthMs !== null)?.lengthMs ?? null,
    };
  } catch (error) {
    // A member AudiobookDB no longer has in detail stays as the series lists it.
    if (error instanceof CatalogueError && error.kind === "not_found") return { english: true, language: null, ...fallback };
    throw error;
  }
}

/** The series from AudiobookDB, English members only, with Open Library's books that have no audiobook yet. */
export async function readCatalogueSeries(id: string, options: { priority?: Priority; fresh?: boolean } = {}): Promise<SeriesCatalogueEntry> {
  const priority = options.priority ?? "interactive";
  const series = await audiobookDbSeries(id, { priority, fresh: options.fresh });
  const members: SeriesMember[] = [];
  for (const member of series.members) {
    const language = await memberLanguage(member, priority);
    if (!language.english) continue;
    members.push({
      id: member.book.id,
      provider: "audiobookdb",
      title: member.book.title,
      author: member.book.authors.join(", ") || series.author || "Unknown author",
      position: member.sort,
      positionLabel: member.position,
      cover: member.book.cover,
      unreleased: releasedLater(member.releaseDate),
      language: language.language,
      narrators: language.narrators,
      lengthMs: language.lengthMs,
      releaseDate: member.releaseDate,
    });
  }
  return { id: series.id, name: series.name, author: series.author, count: series.count, members: [...members, ...(await openLibraryGaps(series.name, series.author, members, priority, options.fresh))] };
}

/**
 * Open Library's books of the series that AudiobookDB does not list: same series name, the series' author, a number
 * no AudiobookDB member has and a title none has. Best effort: Open Library failing leaves the AudiobookDB list.
 */
async function openLibraryGaps(name: string, author: string | null, members: SeriesMember[], priority: Priority, fresh?: boolean): Promise<SeriesMember[]> {
  let found: Awaited<ReturnType<typeof searchOpenLibrarySeries>>;
  try {
    found = await searchOpenLibrarySeries(name, { priority, fresh });
  } catch (error) {
    if (error instanceof CatalogueError) return [];
    throw error;
  }
  const held = new Set(members.map((member) => member.position).filter((position) => position !== null));
  const gaps = new Map<number, SeriesMember>();
  for (const entry of found) {
    if (author && entry.book.authors.length && !authorMatches(author, entry.book.authors)) continue;
    if (held.has(entry.sort) || gaps.has(entry.sort)) continue;
    if (members.some((member) => titleMatches(member.title, entry.book.title))) continue;
    gaps.set(entry.sort, {
      id: `${OPEN_LIBRARY_BOOK_PREFIX}${entry.book.id}`,
      provider: "openlibrary",
      title: entry.book.title,
      author: entry.book.authors.join(", ") || author || "Unknown author",
      position: entry.sort,
      positionLabel: entry.position,
      cover: entry.book.cover,
      unreleased: false,
      language: entry.book.languages.includes("eng") ? "en" : null,
      narrators: [],
      lengthMs: null,
      releaseDate: entry.book.year === null ? null : String(entry.book.year),
    });
  }
  return [...gaps.values()].sort((a, b) => a.position! - b.position!);
}

// ---- Discover ----
/** `GET /api/discover/series`: AudiobookDB's series for the words; `saved` is this user's own. */
export async function searchCatalogueSeries(userId: number, query: string) {
  const found = await searchAudiobookDbSeries(query);
  const saved = savedSeriesIds(userId);
  return found.map((series) => ({ id: series.id, name: series.name, author: series.author, count: series.count, cover: series.cover, saved: saved.has(series.id) }));
}
const savedSeriesIds = (userId: number) => new Set(sqlite.prepare("SELECT series_id FROM user_saved_series WHERE user_id=?").pluck().all(userId) as string[]);

// ---- Works on the server for a series book ----
type LocalWork = { id: string; title: string; author: string };
/** The works with no catalogue link, read once per answer: the candidates a title and author match may take. */
function unlinkedWorks(): LocalWork[] {
  return sqlite.prepare("SELECT id,title,author FROM works WHERE id NOT IN (SELECT work_id FROM work_catalogue_links)").all() as LocalWork[];
}
const ownsWorkSql = "EXISTS(SELECT 1 FROM audio_editions e JOIN user_library u ON u.book_id=e.id WHERE e.work_id=l.work_id AND u.user_id=?)";
/**
 * The server's work for a series book and whether only the administrator can link it (#560): a work linked to the
 * book (one in the user's library first); else, for the administrator, the one unlinked work with its title and
 * author. A member's book is held for the administrator when several works match (for them) or when a work in the
 * user's library matches it but is not linked (for anyone else).
 */
function seriesWorkMatch(userId: number, member: Pick<SeriesMember, "id" | "title" | "author">, candidates: () => LocalWork[]) {
  const provider = isOpenLibraryBookId(member.id) ? "openlibrary" : "audiobookdb";
  const externalId = provider === "openlibrary" ? openLibraryWorkOf(member.id) : member.id;
  let link = sqlite
    .prepare(`SELECT l.work_id AS workId,${ownsWorkSql} AS owned FROM work_catalogue_links l WHERE l.provider=? AND l.external_id=? ORDER BY owned DESC,l.work_id LIMIT 1`)
    .get(userId, provider, externalId) as { workId: string; owned: number } | undefined;
  let needsAdmin = false;
  if (!link?.owned) {
    const matches = candidates().filter((work) => member.author !== "Unknown author" && sameTitle(work.title, member.title) && authorMatches(work.author, [member.author]));
    const owned = matches.filter((work) => ownsWork(userId, work.id));
    const admin = isAdminUser(userId);
    needsAdmin = admin ? matches.length > 1 : owned.length > 0;
    if (!link && admin && matches.length === 1) link = { workId: matches[0].id, owned: Number(owned.length > 0) };
  }
  return { link, needsAdmin };
}
function ownsWork(userId: number, workId: string | null) {
  return !!workId && !!sqlite.prepare("SELECT 1 FROM audio_editions e JOIN user_library u ON u.book_id=e.id WHERE e.work_id=? AND u.user_id=? LIMIT 1").get(workId, userId);
}

// ---- The catalogue rows ----
function upsertCatalogue(entry: SeriesCatalogueEntry, works: Map<string, string | null>) {
  sqlite
    .prepare(`INSERT INTO series_catalogue(id,name,author,book_count) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,author=excluded.author,book_count=excluded.book_count`)
    .run(entry.id, entry.name, entry.author, entry.count);
  const upsert = sqlite.prepare(`INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,position_label,cover,unreleased,author,provider,language,narrators,length_ms,release_date)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(series_id,book_id) DO UPDATE SET title=excluded.title,position=excluded.position,position_label=excluded.position_label,cover=excluded.cover,
      unreleased=excluded.unreleased,author=excluded.author,provider=excluded.provider,language=excluded.language,narrators=excluded.narrators,
      length_ms=excluded.length_ms,release_date=excluded.release_date,work_id=COALESCE(excluded.work_id,series_catalogue_works.work_id)`);
  for (const member of entry.members)
    upsert.run(entry.id, member.id, works.get(member.id) ?? null, member.title, member.position, member.positionLabel, member.cover, Number(member.unreleased), member.author, member.provider, member.language, JSON.stringify(member.narrators), member.lengthMs, member.releaseDate);
}

function markSeen(userId: number, seriesId: string, bookIds: string[]) {
  const insert = sqlite.prepare("INSERT OR IGNORE INTO user_series_seen_works(user_id,series_id,book_id,acknowledged_at) VALUES(?,?,?,?)");
  const now = Date.now();
  for (const bookId of bookIds) insert.run(userId, seriesId, bookId, now);
}

/**
 * AudiobookDB now lists a book its Open Library row stood for (same series, same title): the work, each user's
 * choice, what they saw and their searches move to the AudiobookDB book, the work links to it, and each user who
 * added it gets an audiobook search. The Open Library row goes.
 */
async function adoptAudiobooks(entry: SeriesCatalogueEntry, priority: Priority): Promise<void> {
  const gaps = sqlite
    .prepare("SELECT book_id AS bookId,title,work_id AS workId FROM series_catalogue_works WHERE series_id=? AND provider='openlibrary'")
    .all(entry.id) as { bookId: string; title: string; workId: string | null }[];
  for (const gap of gaps) {
    const member = entry.members.find((candidate) => candidate.provider === "audiobookdb" && titleMatches(candidate.title, gap.title));
    if (!member) continue;
    const users = sqlite.prepare("SELECT user_id AS userId,work_id AS workId FROM user_saved_series_works WHERE series_id=? AND book_id=?").all(entry.id, gap.bookId) as { userId: number; workId: string }[];
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE series_catalogue_works SET work_id=COALESCE(work_id,?) WHERE series_id=? AND book_id=?").run(gap.workId, entry.id, member.id);
      for (const table of ["user_saved_series_works", "user_series_seen_works", "series_acquisition_jobs"])
        sqlite.prepare(`UPDATE OR IGNORE ${table} SET book_id=? WHERE series_id=? AND book_id=?`).run(member.id, entry.id, gap.bookId);
      for (const table of ["user_saved_series_works", "user_series_seen_works", "series_acquisition_jobs"])
        sqlite.prepare(`DELETE FROM ${table} WHERE series_id=? AND book_id=?`).run(entry.id, gap.bookId);
      sqlite.prepare("DELETE FROM series_catalogue_works WHERE series_id=? AND book_id=?").run(entry.id, gap.bookId);
    })();
    const workId = gap.workId ?? users[0]?.workId ?? null;
    if (workId && sqlite.prepare("SELECT provider FROM work_catalogue_links WHERE work_id=?").pluck().get(workId) !== "audiobookdb") {
      try {
        await linkWork(workId, { provider: "audiobookdb", id: member.id }, "manual", priority);
      } catch (error) {
        // The audiobook is still searched for; the link is made again at the next refresh.
        if (!(error instanceof CatalogueError)) throw error;
      }
    }
    for (const user of users)
      enqueueSeriesAcquisition(user.userId, entry.id, [{ bookId: member.id, workId: user.workId, unreleased: member.unreleased }], { searchAudio: true });
  }
}

// ---- Not saved: the preview ----
type PreviewWork = ReturnType<typeof previewWorks>[number];
function previewWorks(userId: number, entry: SeriesCatalogueEntry, language: string) {
  let candidates: LocalWork[] | null = null;
  const lazy = () => (candidates ??= unlinkedWorks());
  const works = entry.members.map((member) => {
    const { link, needsAdmin } = seriesWorkMatch(userId, member, lazy);
    return {
      id: member.id,
      title: member.title,
      position: member.position,
      positionLabel: member.positionLabel,
      cover: member.cover,
      workId: link?.workId ?? null,
      owned: !!link?.owned,
      unreleased: member.unreleased,
      needsAdmin,
      /** False for a book listed from Open Library: no audiobook yet. */
      audiobook: member.provider === "audiobookdb",
      language: member.language,
      editionLanguages: member.language ? [member.language] : [],
      popularity: null as number | null,
      releaseDate: member.releaseDate,
    };
  });
  const defaults = selectSeriesDefaults(works, language);
  return works.map((work) => ({ ...work, selected: defaults.has(work.id) }));
}
/** `GET /api/discover/series/<id>`: a series as the page of one that is not saved shows it, and the Add sheet's choice. */
export async function previewCatalogueSeries(userId: number, id: string, language = "en") {
  const entry = await readCatalogueSeries(id);
  return { id: entry.id, name: entry.name, author: entry.author, count: entry.count, saved: savedSeriesIds(userId).has(entry.id), works: previewWorks(userId, entry, language) };
}

// ---- Save series ----
/**
 * The server's work for a series book in the user's library, made when there is none: the linked work, the
 * administrator's one unlinked match (linked now), or a new work linked to the book with its placeholder. It joins the
 * user's library through its audio, else its placeholder; a work that joins this way names the series as its origin.
 */
function addSeriesBook(userId: number, seriesId: string, member: SeriesMember, match: PreviewWork, entryName: string): { workId: string; previouslyOwned: boolean } {
  const provider = member.provider;
  const externalId = provider === "openlibrary" ? openLibraryWorkOf(member.id) : member.id;
  let workId = match.workId;
  const previouslyOwned = ownsWork(userId, workId);
  const linkRow = (target: string) =>
    sqlite
      .prepare(
        `INSERT INTO work_catalogue_links(work_id,provider,external_id,title,author,series_id,series_name,series_position,series_sort,matched_by,linked_at)
         VALUES(?,?,?,?,?,?,?,?,?,'manual',?) ON CONFLICT(work_id) DO NOTHING`,
      )
      .run(target, provider, externalId, member.title, member.author, provider === "audiobookdb" ? seriesId : null, entryName, member.positionLabel, member.position, Date.now());
  if (workId && !sqlite.prepare("SELECT 1 FROM work_catalogue_links WHERE work_id=?").get(workId)) linkRow(workId);
  if (!workId) {
    workId = `work-${provider === "openlibrary" ? "ol" : "abdb"}-${externalId}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
    const year = Number(member.releaseDate?.slice(0, 4)) || new Date().getFullYear();
    sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,'','',?) ON CONFLICT DO NOTHING").run(workId, member.title, member.author, year);
    linkRow(workId);
  }
  const editions = sqlite.prepare("SELECT id FROM audio_editions WHERE work_id=? ORDER BY rowid").pluck().all(workId) as string[];
  const audio = editions.filter((id) => !isPlaceholderEdition(sqlite, id));
  const representative = audio[0] ?? ensurePlaceholder(sqlite, workId, { cover: member.cover });
  // Added from the series: a hidden entry of this book is lifted.
  sqlite.prepare("DELETE FROM user_hidden_library WHERE user_id=? AND book_id=?").run(userId, representative);
  const addedAt = Date.now();
  const inserted = sqlite.prepare("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?) ON CONFLICT DO NOTHING").run(userId, representative, addedAt).changes > 0;
  if (inserted && !previouslyOwned) setLibraryOrigin(userId, workId, "series", { seriesId, addedAt });
  // A placeholder stays out of the library while the work has audio there.
  if (audio.length) for (const id of editions) if (!audio.includes(id)) removeUserLibraryRow(userId, id);
  return { workId, previouslyOwned };
}

/**
 * `POST /api/series`: the series saved for the user with the books they chose. Books only the administrator can link
 * are left out and answered in `needsAdmin`. Audio and ebook searches start where asked; a book with no audiobook yet
 * has its ebook searched for when either was asked.
 */
export async function saveCatalogueSeries(
  userId: number,
  id: string,
  bookIds: string[],
  options?: {
    searchAudio?: boolean;
    searchEbooks?: boolean;
    /** The reset (`series-resave.ts`): books saved with the Hardcover series, each with the work it had then. */
    restore?: Map<string, { workId: string; introduced: boolean }>;
    priority?: Priority;
  },
) {
  const entry = await readCatalogueSeries(id, { priority: options?.priority });
  const restore = options?.restore ?? new Map<string, { workId: string; introduced: boolean }>();
  const preview = previewWorks(userId, entry, "en").map((work) =>
    restore.has(work.id) ? { ...work, workId: restore.get(work.id)!.workId, needsAdmin: false } : work,
  );
  const requested = new Set(bookIds);
  if ([...requested].some((bookId) => !preview.some((work) => work.id === bookId))) throw new Error("Choose works from this series.");
  const needsAdmin = preview.filter((work) => work.needsAdmin && requested.has(work.id)).map(({ id, title }) => ({ id, title }));
  const selected = preview.filter((work) => requested.has(work.id) && !work.needsAdmin);
  const audiobooks: { bookId: string; workId: string; unreleased: boolean }[] = [];
  const ebookOnly: { bookId: string; workId: string; unreleased: boolean }[] = [];
  sqlite.transaction(() => {
    upsertCatalogue(entry, new Map(preview.map((work) => [work.id, work.workId])));
    sqlite.prepare("INSERT OR IGNORE INTO user_saved_series(user_id,series_id,saved_at,refreshed_at) VALUES(?,?,?,?)").run(userId, id, Date.now(), Date.now());
    markSeen(userId, id, entry.members.map((member) => member.id));
    for (const work of selected) {
      const member = entry.members.find((candidate) => candidate.id === work.id)!;
      const added = addSeriesBook(userId, id, member, work, entry.name);
      sqlite.prepare("UPDATE series_catalogue_works SET work_id=? WHERE series_id=? AND book_id=?").run(added.workId, id, work.id);
      const introduced = restore.get(work.id)?.introduced ?? !added.previouslyOwned;
      sqlite.prepare("INSERT OR IGNORE INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(?,?,?,?,?)").run(userId, id, work.id, added.workId, Number(introduced));
      (work.audiobook ? audiobooks : ebookOnly).push({ bookId: work.id, workId: added.workId, unreleased: work.unreleased });
    }
  })();
  if (options?.searchAudio || options?.searchEbooks) enqueueSeriesAcquisition(userId, id, audiobooks, options);
  if ((options?.searchAudio || options?.searchEbooks) && ebookOnly.length) enqueueSeriesAcquisition(userId, id, ebookOnly, { searchEbooks: true });
  return { ...savedCatalogueSeries(userId, id), needsAdmin };
}

// ---- Saved ----
type SavedRow = {
  id: string; title: string; position: number | null; positionLabel: string | null; cover: string | null; unreleased: number;
  provider: "audiobookdb" | "openlibrary"; author: string | null; language: string | null; releaseDate: string | null;
  workId: string | null; added: number; introduced: number; seen: number;
};
function savedRows(userId: number, id: string): SavedRow[] {
  return sqlite
    .prepare(
      `SELECT c.book_id AS id,c.title,c.position,c.position_label AS positionLabel,c.cover,c.unreleased,c.provider,c.author,c.language,c.release_date AS releaseDate,
        COALESCE(u.work_id,c.work_id) AS workId,u.book_id IS NOT NULL AS added,COALESCE(u.introduced,0) AS introduced,
        EXISTS(SELECT 1 FROM user_series_seen_works s WHERE s.user_id=? AND s.series_id=c.series_id AND s.book_id=c.book_id) AS seen
       FROM series_catalogue_works c LEFT JOIN user_saved_series_works u ON u.series_id=c.series_id AND u.book_id=c.book_id AND u.user_id=?
       WHERE c.series_id=? ORDER BY c.position IS NULL,c.position,c.book_id`,
    )
    .all(userId, userId, id) as SavedRow[];
}
function savedHead(userId: number, id: string) {
  const series = sqlite
    .prepare("SELECT c.id,c.name,c.author,c.book_count AS count FROM series_catalogue c JOIN user_saved_series u ON u.series_id=c.id WHERE u.user_id=? AND c.id=?")
    .get(userId, id) as { id: string; name: string; author: string | null; count: number | null } | undefined;
  if (!series) throw new Error("This saved series could not be found.");
  return series;
}
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** One row per local work (an added row wins when a work sits under several books), in reading order. */
function uniqueSeriesWorks<T extends { id: string; position: number | null; workId: string | null; added: boolean }>(works: T[]) {
  const preferred = new Map<string, T>();
  for (const work of works) {
    const key = work.workId ? `w:${work.workId}` : `b:${work.id}`;
    const current = preferred.get(key);
    if (!current || (!current.added && work.added) || (current.added === work.added && compareIds(work.id, current.id) < 0)) preferred.set(key, work);
  }
  return [...preferred.values()].sort((a, b) =>
    a.position === null ? (b.position === null ? compareIds(a.id, b.id) : 1) : b.position === null ? -1 : a.position - b.position || compareIds(a.id, b.id),
  );
}

/** A saved series for the user (`GET /api/series/<id>`), from the stored catalogue: no provider request. */
export function savedCatalogueSeries(userId: number, id: string, options?: { refreshError?: string }) {
  const series = savedHead(userId, id);
  const rows = savedRows(userId, id);
  const author = series.author || "Unknown author";
  let candidates: LocalWork[] | null = null;
  const lazy = () => (candidates ??= unlinkedWorks());
  const mediaStates = getWorkMediaStates(userId, rows.flatMap((work) => (work.added && work.workId ? [work.workId] : [])));
  const mapped = rows.map((work) => {
    const added = !!work.added;
    const unreleased = !!work.unreleased;
    const { needsAdmin } = added ? { needsAdmin: false } : seriesWorkMatch(userId, { id: work.id, title: work.title, author: work.author || author }, lazy);
    const stateWorkId = added || ownsWork(userId, work.workId) ? work.workId : null;
    const base = seriesWorkState(userId, stateWorkId, { seriesId: id, added, legacyIntroduced: !!work.introduced });
    const members = added && stateWorkId ? listEbookSetMembers(stateWorkId) : [];
    const { seen: _seen, provider, author: _author, ...rest } = work;
    return {
      ...rest,
      seen: !!work.seen,
      unreleased,
      added,
      introduced: !!work.introduced,
      needsAdmin,
      audiobook: provider === "audiobookdb",
      ...base,
      mediaState: added && stateWorkId ? (mediaStates.get(stateWorkId) ?? null) : null,
      acquisition: added && stateWorkId ? seriesWorkAcquisitions(userId, id, work.id, stateWorkId, unreleased) : null,
      ebookSet:
        added && stateWorkId
          ? {
              held: members.filter((member) => member.status === "held").length,
              accepted: members.filter((member) => member.status === "accepted").length,
              rejected: members.filter((member) => member.status === "rejected").length,
              pending: members.filter((member) => member.status === "pending").length,
            }
          : null,
    };
  });
  const unique = uniqueSeriesWorks(mapped).map(({ seen, ...rest }) => ({ ...rest, new: !rest.added && !seen }));
  const needsAdmin = unique.filter((work) => work.needsAdmin && !work.added).map(({ id, title }) => ({ id, title }));
  // An unreleased work the user has not added cannot be finished, so it does not hold completion below 100%.
  const counted = unique.filter((work) => work.added || !work.unreleased);
  return {
    ...series,
    saved: true,
    works: unique,
    needsAdmin,
    ...(options?.refreshError ? { refreshError: options.refreshError } : {}),
    completion: { finished: counted.filter((work) => work.finished).length, total: counted.length, nextBookId: counted.find((work) => !work.finished)?.id ?? null },
  };
}

function seriesWorkState(userId: number, workId: string | null, series?: { seriesId: string; added: boolean; legacyIntroduced: boolean }) {
  const editions = workId ? db.select().from(s.editions).where(eq(s.editions.workId, workId)).all() : [];
  const library = editions.filter((edition) => !!sqlite.prepare("SELECT 1 FROM user_library WHERE user_id=? AND book_id=?").get(userId, edition.id));
  const { finished, completionOverride } = (workId ? workCompletions(userId, [workId]).get(workId) : undefined) ?? { finished: false, completionOverride: null };
  const recordings = editions
    .flatMap((edition) => db.select().from(s.recordings).where(eq(s.recordings.editionId, edition.id)).all())
    .map((recording) => {
      const tracks = db.select().from(s.tracks).where(eq(s.tracks.recordingId, recording.id)).all().sort((a, b) => a.index - b.index);
      return {
        id: recording.id,
        tracks: tracks.map((track) => track.id),
        server: tracks.length > 0 && tracks.every(hasServerMedia),
        stream: tracks.length > 0 && tracks.every((track) => track.sourceType !== "local"),
      };
    });
  const ebooks = workId ? db.select().from(s.ebookEditions).where(eq(s.ebookEditions.workId, workId)).all().filter((ebook) => !ebook.id.startsWith("set-consensus:")) : [];
  const base = {
    editionId: library[0]?.id ?? null,
    finished,
    completionOverride,
    availability: {
      audio: { server: workId ? recordings.some((recording) => recording.server) : null, recordings },
      ebook: { server: workId ? ebooks.some((ebook) => existsSync(ebook.source)) : null, editionIds: ebooks.map((ebook) => ebook.id), device: null },
    },
  };
  if (!series || !workId) return base;
  const origin = libraryOriginFor(userId, workId);
  const libraryOrigin = origin
    ? { source: origin.source as "manual" | "hardcover_sync" | "series" | "unknown", seriesId: origin.seriesId, addedAt: origin.addedAt }
    : { source: "unknown" as const, seriesId: null, addedAt: null };
  return {
    ...base,
    libraryOrigin,
    libraryOriginLabel: libraryOriginLabel(libraryOrigin, series.seriesId),
    removalDefaultSelected: removalDefaultSelected(userId, series.seriesId, { added: series.added, workId }, series.legacyIntroduced),
  };
}

/** `GET /api/series`: the user's saved series with the Library's counts (#561). */
export function listSavedCatalogueSeries(userId: number) {
  const list = sqlite
    .prepare("SELECT c.id,c.name,c.author,c.book_count AS count FROM series_catalogue c JOIN user_saved_series u ON u.series_id=c.id WHERE u.user_id=? ORDER BY c.name,c.id")
    .all(userId) as { id: string; name: string; author: string | null; count: number | null }[];
  return list.map((series) => ({ ...series, ...savedSeriesCounts(userId, series.id, series.author || "Unknown author") }));
}
function savedSeriesCounts(userId: number, id: string, author: string) {
  const rows = savedRows(userId, id).map((row) => ({ ...row, added: !!row.added, unreleased: !!row.unreleased }));
  const works = uniqueSeriesWorks(rows);
  const library = new Set(works.filter((work) => ownsWork(userId, work.workId)).map((work) => work.id));
  const completions = workCompletions(userId, works.flatMap((work) => (library.has(work.id) && work.workId ? [work.workId] : [])));
  const heldPositions = new Set(works.filter((work) => library.has(work.id)).map((work) => work.position));
  let candidates: LocalWork[] | null = null;
  const lazy = () => (candidates ??= unlinkedWorks());
  const books = works.map((work) => ({
    id: work.id,
    position: work.position,
    workId: work.workId,
    cover: work.cover,
    unreleased: work.unreleased,
    language: work.language,
    finished: library.has(work.id) && !!completions.get(work.workId!)?.finished,
    needsAdmin: !work.added && work.position !== null && !heldPositions.has(work.position) && seriesWorkMatch(userId, { id: work.id, title: work.title, author: work.author || author }, lazy).needsAdmin,
  }));
  const { numbers, finished, total } = seriesBooks(books, library, "en");
  return { finished, total, covers: numbers.slice(0, 3).map((number) => number.book.cover) };
}

/** `POST /api/series/<id>/ack`: the new books the user has now seen. */
export function acknowledgeCatalogueSeriesWorks(userId: number, seriesId: string, bookIds: string[]) {
  savedHead(userId, seriesId);
  const known = new Set(sqlite.prepare("SELECT book_id FROM series_catalogue_works WHERE series_id=?").pluck().all(seriesId) as string[]);
  if (bookIds.some((bookId) => !known.has(bookId))) throw new Error("Choose works from this series.");
  markSeen(userId, seriesId, bookIds);
  return savedCatalogueSeries(userId, seriesId);
}

// ---- Refresh ----
function refreshErrorMessage(error: CatalogueError) {
  if (error.kind === "missing_key") return "Add the AudiobookDB API key in Settings, then retry.";
  if (error.kind === "unreachable") return "AudiobookDB could not be reached. Showing the last saved catalogue.";
  return error.message;
}
/**
 * The shared catalogue of a series read again and stored (new books appear as new for each user who has not seen
 * them); books AudiobookDB now lists in place of an Open Library row take it over.
 */
export async function refreshCatalogueSeries(id: string, options: { priority?: Priority; fresh?: boolean } = {}): Promise<SeriesCatalogueEntry> {
  const priority = options.priority ?? "background";
  const entry = await readCatalogueSeries(id, { priority, fresh: options.fresh });
  sqlite.transaction(() => {
    upsertCatalogue(entry, new Map());
    // A book AudiobookDB or Open Library no longer lists that nobody added goes; one somebody added stays.
    const listed = new Set(entry.members.map((member) => member.id));
    for (const bookId of sqlite.prepare("SELECT book_id FROM series_catalogue_works WHERE series_id=?").pluck().all(id) as string[])
      if (!listed.has(bookId) && !sqlite.prepare("SELECT 1 FROM user_saved_series_works WHERE series_id=? AND book_id=?").get(id, bookId))
        sqlite.prepare("DELETE FROM series_catalogue_works WHERE series_id=? AND book_id=? AND NOT EXISTS(SELECT 1 FROM series_acquisition_jobs WHERE series_id=? AND book_id=?)").run(id, bookId, id, bookId);
  })();
  await adoptAudiobooks(entry, priority);
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id=?").run(Date.now(), id);
  return entry;
}

/**
 * `GET /api/series/<id>`: the saved series, read from AudiobookDB's cached answer (a week; `refresh` asks AudiobookDB
 * again). A provider failure keeps the stored list and says why.
 */
export async function refreshSavedCatalogueSeries(userId: number, id: string, options?: { force?: boolean; language?: string }) {
  savedHead(userId, id);
  const refreshedAt = sqlite.prepare("SELECT refreshed_at FROM user_saved_series WHERE user_id=? AND series_id=?").pluck().get(userId, id) as number | null;
  // The page reads the series again while its books are fetched: a read of the last minute stands.
  if (!options?.force && refreshedAt && Date.now() - refreshedAt < SERIES_REFRESH_MAX_AGE_MS) return withDefaults(userId, id, options?.language || "en");
  try {
    await refreshCatalogueSeries(id, { priority: "interactive", fresh: !!options?.force });
  } catch (error) {
    if (!(error instanceof CatalogueError)) throw error;
    return savedCatalogueSeries(userId, id, { refreshError: refreshErrorMessage(error) });
  }
  return withDefaults(userId, id, options?.language || "en");
}
/** The saved series with the Add sheet's choice for the new books: one per number the user has no book at. */
function withDefaults(userId: number, id: string, language: string) {
  const saved = savedCatalogueSeries(userId, id);
  const addedPositions = new Set(saved.works.filter((work) => work.added && work.position !== null).map((work) => work.position));
  const choosable = saved.works.filter((work) => work.new && !work.added && !addedPositions.has(work.position));
  const defaults = selectSeriesDefaults(
    choosable.map((work) => ({ ...work, editionLanguages: work.language ? [work.language] : [], popularity: null })),
    language,
  );
  return {
    ...saved,
    works: saved.works.map((work) => ({ ...work, editionLanguages: work.language ? [work.language] : [], popularity: null, selected: defaults.has(work.id) })),
  };
}

const SERIES_REFRESH_MAX_AGE_MS = 60_000;
/** Saved series are read again from AudiobookDB once a day, so new books appear without a visit. */
export const SAVED_SERIES_REFRESH_MS = 24 * 60 * 60 * 1000;
export async function refreshSavedSeriesDue(now = Date.now()): Promise<{ refreshed: number; failed: number }> {
  const due = sqlite
    .prepare("SELECT series_id FROM user_saved_series GROUP BY series_id HAVING MIN(COALESCE(refreshed_at,0))<=? ORDER BY MIN(COALESCE(refreshed_at,0))")
    .pluck()
    .all(now - SAVED_SERIES_REFRESH_MS) as string[];
  let refreshed = 0;
  let failed = 0;
  for (const id of due) {
    try {
      await refreshCatalogueSeries(id, { priority: "background", fresh: true });
      refreshed++;
    } catch (error) {
      if (!(error instanceof CatalogueError)) throw error;
      failed++;
      if (["missing_key", "rejected", "daily_limit"].includes(error.kind)) break;
    }
  }
  return { refreshed, failed };
}
export function savedSeriesRefreshLoop(log: (message: string) => void): BackgroundProcess {
  return {
    id: "series-refresh",
    intervalMs: 60 * 60 * 1000,
    runAtStart: false,
    tick: () =>
      refreshSavedSeriesDue().then(
        (result) => {
          if (result.failed) log(`Series refresh: ${result.failed} saved series could not be read from AudiobookDB; they are tried next hour.`);
        },
        (error: Error) => log(`Series refresh failed: ${error.message}`),
      ),
  };
}
