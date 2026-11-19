// A work's catalogue link and a recording's release link (#721), the matcher, the administrator's batch match over
// the library, and the loop that keeps the cache to its licence (refresh a week's details, delete what is gone).
//
// - A work links to an AudiobookDB book, or to an Open Library work when it has no audiobook.
// - Beside that main link, a work may link to a Google Books volume and an iTunes audiobook (part e), picked on its
//   match page only: the batch never searches those two. Any link makes the work matched.
// - A recording may link to an AudiobookDB release: narrator, length, ASIN and chapters are kept on the link.
// - A link fills only what is missing (the work's description, the edition's narrator); title, author and cover stay.
//   The first series and its position are kept on the link for the series part (721b).
// - A sure match is applied: the exact normalised title and author, or the ASIN in the file's name. Anything else is
//   left unmatched with its outcome, for the administrator to pick on the book's match page.
// - A matched work is not searched again: only its match page searches.
import { sqlite } from "./db.ts";
import { placeholderEditionSql } from "./placeholder-edition.ts";
import {
  audiobookDbBook,
  audiobookDbByAsin,
  audiobookDbRelease,
  audiobookDbReleases,
  isEnglish,
  refreshAudiobookDbEntry,
  searchAudiobookDbBooks,
  type CatalogueBook,
  type CatalogueRelease,
} from "./audiobookdb.ts";
import { openLibraryWork, openLibraryWorkUrl, refreshOpenLibraryEntry, searchOpenLibrary } from "./openlibrary.ts";
import { googleBooksUrl, googleBooksVolume, refreshGoogleBooksEntry } from "./googlebooks.ts";
import { itunesAudiobook, itunesUrl, refreshItunesEntry } from "./itunes.ts";
import {
  CatalogueError,
  dropExpiredSearches,
  expiredDetails,
  isExtraProvider,
  type CatalogueProviderName,
  type ExtraCatalogueProvider,
  type MainCatalogueProvider,
  type Priority,
} from "./catalogue-provider.ts";
import type { BackgroundProcess } from "./background-runner.ts";

// ---- The matcher (pure) ----
// One work may be several AudiobookDB entries (#754, owner 19 Nov): the same main title once a series prefix
// ("Dungeon Crawler Carl, Book 2: …"), an omnibus label ("Star Wars Omnibus: …"), an author's name ("Marcus
// Aurelius – Meditations"), a subtitle or a bracketed note are taken off, and a matching author. Those entries are
// duplicates of the one work, never rival candidates; only entries that are different works (another title, another
// author, another place in the series) leave a work ambiguous.
const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
/** Lower case, no accents or punctuation, single spaces. */
export function normaliseTitle(title: string): string {
  return fold(title);
}
const BRACKETED = /\s*[([{][^)\]}]*[)\]}]\s*/g;
const SUBTITLE = /\s[:–—-]\s|:\s/;
/** A title's separator before what follows a prefix: a colon, or a dash with spaces around it. */
const SEPARATOR = String.raw`\s*(?::|\s[–—-])\s*`;
const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
/** "<Series>, Book <N>: <Title>", "<Series> <N>: <Title>", "<Series> #<N>: <Title>" (also Vol., Volume, Part, No.). */
const SERIES_PREFIX = new RegExp(String.raw`^(.+?)(?:,?\s+(?:book|bk\.?|volume|vol\.?|part|no\.?)\s*#?${NUMBER}|,?\s+#\s*${NUMBER}|\s+${NUMBER})${SEPARATOR}(\S.*)$`, "i");
/** "<Series> Omnibus: <Title>" (also "Omnibus Edition", "Omnibus Collection"). */
const OMNIBUS_PREFIX = new RegExp(String.raw`^(.+?\bomnibus(?:\s+(?:edition|collection))?)${SEPARATOR}(\S.*)$`, "i");
/** "<Name> – <Title>": the head is taken off only when it is one of the book's authors. */
const HEAD = new RegExp(String.raw`^(.+?)${SEPARATOR}(\S.*)$`);
const unbracketed = (title: string) => title.replace(BRACKETED, " ").replace(/\s+/g, " ").trim();
/** The title without its subtitle or a bracketed note ("(Unabridged)", "[Book 1]"). */
function mainTitle(title: string): string {
  return fold(unbracketed(title).split(SUBTITLE)[0]);
}
/** An author name as a set of words, so "Corey, James S. A." is "James S. A. Corey". */
const nameKey = (name: string) => fold(name).split(" ").filter(Boolean).sort().join(" ");
/** One stored author field as names: "A & B", "A and B", "A; B", "Last, First" kept whole. */
const authorKeys = (author: string) => {
  const parts = author.split(/\s*(?:;|&|\band\b|,(?=\s*[A-Z][^,]*\s[A-Z]))\s*/).map(nameKey).filter(Boolean);
  return [nameKey(author), ...parts].filter(Boolean);
};
/**
 * The title as it is meant, beside the title as written: without an author's name in front, an omnibus label or a
 * series prefix. `keepMain` is false for a written title whose head is such a label (its main title is not the book's).
 */
function titleCores(title: string, authors: string[]): { text: string; keepMain: boolean }[] {
  let rest = unbracketed(title) || title.trim();
  const cores = [{ text: rest, keepMain: true }];
  const names = new Set(authors.flatMap(authorKeys));
  const byAuthor = rest.match(HEAD);
  if (byAuthor && names.has(nameKey(byAuthor[1]))) {
    cores[0].keepMain = false;
    rest = byAuthor[2];
    cores.push({ text: rest, keepMain: true });
  }
  const omnibus = rest.match(OMNIBUS_PREFIX);
  if (omnibus) {
    cores.at(-1)!.keepMain = false;
    rest = omnibus[2];
    cores.push({ text: rest, keepMain: true });
  }
  // A numbered head keeps its main title: "Fahrenheit 451: A Novel" is "Fahrenheit 451".
  const series = rest.match(SERIES_PREFIX);
  if (series) cores.push({ text: series[5], keepMain: true });
  return cores;
}
function titleKeys(title: string, authors: string[]) {
  const whole = new Set<string>();
  const main = new Set<string>();
  for (const core of titleCores(title, authors)) {
    whole.add(fold(core.text));
    if (core.keepMain) main.add(mainTitle(core.text));
  }
  whole.delete("");
  main.delete("");
  return { whole, main };
}
const meets = (a: Set<string>, b: Set<string>) => [...a].some((key) => b.has(key));
/**
 * How surely two titles are the same book: "whole" when one's whole title (prefixes off) is the other's whole or main
 * title; "main" when only both main titles agree (both have a subtitle, and the subtitles differ).
 */
export function titleMatch(workTitle: string, candidate: string, authors: string[] = []): "whole" | "main" | null {
  const a = titleKeys(workTitle, authors);
  const b = titleKeys(candidate, authors);
  if (meets(a.whole, b.whole) || meets(a.whole, b.main) || meets(a.main, b.whole)) return "whole";
  return meets(a.main, b.main) ? "main" : null;
}
/** The words to search for: the title without an author's name, omnibus label or series prefix, subtitle or note. */
export function searchTitle(title: string, authors: string[] = []): string {
  const plain = titleCores(title, authors).at(-1)!.text.split(SUBTITLE)[0].replace(/\s+/g, " ").trim();
  return plain || title.trim();
}
/** The search words as before #754 (only the subtitle and note off), tried when the prefix-free title finds nothing sure. */
function writtenSearchTitle(title: string): string {
  return unbracketed(title).split(SUBTITLE)[0].replace(/\s+/g, " ").trim() || title.trim();
}
/** Exact after normalising: the whole titles, or both without a subtitle, bracketed note or prefix. */
export function titleMatches(workTitle: string, candidate: string, authors: string[] = []): boolean {
  return titleMatch(workTitle, candidate, authors) !== null;
}
/** The work's author (one or several, as stored) and one of the candidate's authors are the same person. */
export function authorMatches(workAuthor: string, candidates: string[]): boolean {
  const keys = new Set(authorKeys(workAuthor));
  return candidates.some((name) => keys.has(nameKey(name)));
}
/**
 * A place in a series written in the title: the number of a series prefix ("…, Book 2:", "… #2:"), of a bracketed note
 * ("(The Expanse, Book 1)") or of a subtitle ("…: Dungeon Crawler Carl, Book 2"). Null when the title names none.
 */
export function titlePosition(title: string): number | null {
  const plain = title.replace(/\s+/g, " ").trim();
  const prefix = unbracketed(plain).match(SERIES_PREFIX);
  const found =
    // A bare number ("Fahrenheit 451: A Novel") is part of a title as often as a place: only "Book N" and "#N" count.
    (prefix && (prefix[2] ?? prefix[3])) ??
    plain.match(/[([{][^)\]}]*?(?:\bbook|\bbk\.?|\bvol(?:ume)?\.?|\bpart|#)\s*#?(\d+(?:\.\d+)?)\s*[)\]}]/i)?.[1] ??
    unbracketed(plain).match(new RegExp(String.raw`(?:\s[:–—-]\s|:\s).*?(?:\bbook|\bbk\.?|\bvol(?:ume)?\.?|#)\s*#?${NUMBER}\s*$`, "i"))?.[1];
  return found === undefined || found === null ? null : Number(found);
}
/** A provider book's place in its (first) series: the structured position, else the one its title names. */
export const bookPosition = (book: Pick<CatalogueBook, "title" | "series">): number | null => book.series[0]?.sort ?? titlePosition(book.title);
/** An Audible ASIN (B0 and eight more) in the file names, the release title or the torrent name. */
export function findAsin(texts: string[]): string | null {
  for (const value of texts) {
    const found = value.toUpperCase().match(/(?:^|[^A-Z0-9])(B0[0-9A-Z]{8})(?![A-Z0-9])/);
    if (found) return found[1];
  }
  return null;
}
export type Decision =
  /** `book` is the first of `books`, every entry that is this work (one or several duplicates). */
  | { outcome: "matched"; book: CatalogueBook; books: CatalogueBook[] }
  | { outcome: "ambiguous"; candidates: number }
  | { outcome: "missing" };
/**
 * Sure: the results whose title and author are this work's are one work (its duplicates), gathered. Results whose
 * whole title fits are preferred to those whose main title alone does; the work's place in its series (`position`)
 * leaves out entries at another place. Entries left at two places of a series are different books: ambiguous.
 */
export function decide(work: { title: string; author: string; position?: number | null }, results: CatalogueBook[]): Decision {
  const unique = [...new Map(results.map((book) => [book.id, book])).values()];
  const fitting = unique.flatMap((book) => {
    if (!authorMatches(work.author, book.authors)) return [];
    const strength = titleMatch(work.title, book.title, [work.author, ...book.authors]);
    return strength ? [{ book, strength }] : [];
  });
  if (!fitting.length) return results.length ? { outcome: "ambiguous", candidates: results.length } : { outcome: "missing" };
  const whole = fitting.filter((entry) => entry.strength === "whole");
  let same = (whole.length ? whole : fitting).map((entry) => entry.book);
  const position = work.position ?? null;
  if (position !== null) {
    const placed = same.filter((book) => {
      const place = bookPosition(book);
      return place === null || place === position;
    });
    if (!placed.length) return { outcome: "ambiguous", candidates: same.length };
    same = placed;
  }
  if (new Set(same.map(bookPosition).filter((place) => place !== null)).size > 1) return { outcome: "ambiguous", candidates: same.length };
  return { outcome: "matched", book: same[0], books: same };
}
/** English or unknown: only a release the provider marks as another language is left out. */
export const englishRelease = (release: CatalogueRelease) => !release.language || isEnglish(release.language);
/**
 * The release a recording is surely of: the one with the file's ASIN, else the only English release whose length
 * agrees with the recording's within a minute (and 1 %).
 */
export function pickRelease(recording: { durationMs: number; asin: string | null }, releases: CatalogueRelease[]): { release: CatalogueRelease; by: "asin" | "length" } | null {
  if (recording.asin) {
    const byAsin = releases.find((release) => release.asin === recording.asin);
    if (byAsin) return { release: byAsin, by: "asin" };
  }
  if (!(recording.durationMs > 0)) return null;
  const tolerance = Math.max(60_000, recording.durationMs * 0.01);
  const close = releases.filter((release) => englishRelease(release) && release.lengthMs !== null && Math.abs(release.lengthMs - recording.durationMs) <= tolerance);
  return close.length === 1 ? { release: close[0], by: "length" } : null;
}

// ---- What the server knows of a work ----
type WorkRow = { id: string; title: string; author: string; description: string };
const workRow = (workId: string) => sqlite.prepare("SELECT id,title,author,description FROM works WHERE id=?").get(workId) as WorkRow | undefined;
export type RecordingFacts = { recordingId: string; editionId: string; label: string; durationMs: number; asin: string | null; narrator: string };
/** The work's real recordings (placeholders have none): their length, an ASIN in their names, their narrator. */
export function workRecordings(workId: string): RecordingFacts[] {
  const rows = sqlite
    .prepare(
      `SELECT r.id AS recordingId,e.id AS editionId,e.narrator,e.release_title AS releaseTitle,e.source_label AS sourceLabel,
              COALESCE((SELECT SUM(t.duration) FROM tracks t WHERE t.recording_id=r.id),0) AS seconds,
              (SELECT group_concat(t.title || ' ' || t.source, char(10)) FROM tracks t WHERE t.recording_id=r.id) AS names,
              (SELECT a.title FROM acquisitions a WHERE a.book_id=e.id LIMIT 1) AS torrent
       FROM recordings r JOIN audio_editions e ON e.id=r.edition_id
       WHERE e.work_id=? AND NOT ${placeholderEditionSql("e.id")} AND EXISTS(SELECT 1 FROM tracks t WHERE t.recording_id=r.id)
       ORDER BY r.id`,
    )
    .all(workId) as { recordingId: string; editionId: string; narrator: string; releaseTitle: string | null; sourceLabel: string; seconds: number; names: string | null; torrent: string | null }[];
  return rows.map((row) => ({
    recordingId: row.recordingId,
    editionId: row.editionId,
    label: row.releaseTitle || row.sourceLabel || row.recordingId,
    durationMs: Math.round(row.seconds * 1000),
    asin: findAsin([row.releaseTitle ?? "", row.torrent ?? "", row.names ?? ""]),
    narrator: row.narrator,
  }));
}
/**
 * The work's own place in its series, for choosing among entries of the same title (#754): the one its title names,
 * else the one stored with it (a saved series' member row, or Hardcover's series kept on its old link). Null if none.
 */
export function workSeriesPosition(workId: string, title: string): number | null {
  const written = titlePosition(title);
  if (written !== null) return written;
  const member = sqlite.prepare("SELECT position FROM series_catalogue_works WHERE work_id=? AND position IS NOT NULL ORDER BY rowid LIMIT 1").pluck().get(workId);
  if (typeof member === "number") return member;
  const hardcover = sqlite
    .prepare(
      `SELECT json_extract(s.value,'$.position') FROM hardcover_links l, json_each(CASE WHEN json_valid(l.series) THEN l.series ELSE '[]' END) s
       WHERE l.work_id=? AND json_type(s.value,'$.position') IN ('integer','real') LIMIT 1`,
    )
    .pluck()
    .get(workId);
  return typeof hardcover === "number" ? hardcover : null;
}
const missingNarrator = (value: string | null | undefined) => !value || !value.trim() || /^unknown( narrator)?$/i.test(value.trim());

// ---- Links ----
export type WorkLink = {
  provider: MainCatalogueProvider;
  id: string;
  title: string;
  author: string;
  series: { id: string | null; name: string; position: string | null; sort: number | null } | null;
  matchedBy: "title" | "asin" | "manual";
  url: string;
  /** The other AudiobookDB entries of the same work (#754), each with its number of releases. */
  duplicates: WorkDuplicate[];
};
export type WorkDuplicate = { id: string; title: string; releases: number };
type LinkRow = { provider: MainCatalogueProvider; externalId: string; title: string; author: string; seriesId: string | null; seriesName: string | null; seriesPosition: string | null; seriesSort: number | null; matchedBy: WorkLink["matchedBy"] };
export function workLink(workId: string): WorkLink | null {
  const row = sqlite
    .prepare(
      `SELECT provider,external_id AS externalId,title,author,series_id AS seriesId,series_name AS seriesName,series_position AS seriesPosition,series_sort AS seriesSort,matched_by AS matchedBy
       FROM work_catalogue_links WHERE work_id=?`,
    )
    .get(workId) as LinkRow | undefined;
  if (!row) return null;
  return {
    provider: row.provider,
    id: row.externalId,
    title: row.title,
    author: row.author,
    series: row.seriesName ? { id: row.seriesId, name: row.seriesName, position: row.seriesPosition, sort: row.seriesSort } : null,
    matchedBy: row.matchedBy,
    url: row.provider === "openlibrary" ? openLibraryWorkUrl(row.externalId) : "https://audiobookdb.org",
    duplicates: row.provider === "audiobookdb" ? workDuplicates(workId) : [],
  };
}
export function workDuplicates(workId: string): WorkDuplicate[] {
  return sqlite
    .prepare("SELECT external_id AS id,title,releases FROM work_catalogue_duplicates WHERE work_id=? AND provider='audiobookdb' ORDER BY releases DESC,linked_at,external_id")
    .all(workId) as WorkDuplicate[];
}
/** Every AudiobookDB entry the work is: its main link first, then its duplicates. Empty without an AudiobookDB link. */
export function workEntryIds(workId: string): string[] {
  const link = workLink(workId);
  return link?.provider === "audiobookdb" ? [link.id, ...link.duplicates.map((entry) => entry.id)] : [];
}
/** The English-or-unknown and other releases of all the work's entries, main entry first; one id once. */
export async function workReleases(workId: string, priority: Priority = "interactive"): Promise<CatalogueRelease[]> {
  const seen = new Map<string, CatalogueRelease>();
  for (const id of workEntryIds(workId)) for (const release of await audiobookDbReleases(id, { priority })) if (!seen.has(release.id)) seen.set(release.id, { ...release, bookId: release.bookId ?? id });
  return [...seen.values()];
}
/** A work's Google Books or iTunes link (part e), beside its main link. */
export type ProviderLink = { provider: ExtraCatalogueProvider; id: string; title: string; author: string; matchedBy: "manual"; url: string };
export function providerLinks(workId: string): ProviderLink[] {
  const rows = sqlite
    .prepare("SELECT provider,external_id AS id,title,author,matched_by AS matchedBy FROM work_provider_links WHERE work_id=? ORDER BY CASE provider WHEN 'googlebooks' THEN 0 ELSE 1 END")
    .all(workId) as Omit<ProviderLink, "url">[];
  return rows.map((row) => ({ ...row, url: row.provider === "googlebooks" ? googleBooksUrl(row.id) : itunesUrl(row.id) }));
}
/** Each work's main link and its duplicates (#754) as (work_id, provider, external_id): a provider book opens the work it is any entry of. */
export const LINKED_ENTRIES =
  "SELECT work_id,provider,external_id FROM work_catalogue_links UNION ALL SELECT work_id,provider,external_id FROM work_catalogue_duplicates";
/** The works with any link: the batch skips them and the list of works not matched leaves them out. */
const LINKED_WORKS = "SELECT work_id FROM work_catalogue_links UNION SELECT work_id FROM work_provider_links";

export type ReleaseLink = { releaseId: string; bookId: string; narrator: string | null; lengthMs: number | null; asin: string | null; language: string | null; chapters: number; matchedBy: "asin" | "length" | "manual" };
export function releaseLink(recordingId: string): ReleaseLink | null {
  const row = sqlite
    .prepare(
      `SELECT release_id AS releaseId,book_id AS bookId,narrator,length_ms AS lengthMs,asin,language,chapters,matched_by AS matchedBy
       FROM recording_release_links WHERE recording_id=?`,
    )
    .get(recordingId) as (Omit<ReleaseLink, "chapters"> & { chapters: string }) | undefined;
  if (!row) return null;
  const chapters = JSON.parse(row.chapters) as unknown[];
  return { ...row, chapters: Array.isArray(chapters) ? chapters.length : 0 };
}

/** Links a recording to a release; fills the edition's narrator when it has none. */
export async function linkRecording(recordingId: string, releaseId: string, matchedBy: ReleaseLink["matchedBy"], priority: Priority = "interactive"): Promise<void> {
  const recording = sqlite
    .prepare("SELECT r.id,e.id AS editionId,e.work_id AS workId,e.narrator FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE r.id=?")
    .get(recordingId) as { id: string; editionId: string; workId: string; narrator: string } | undefined;
  if (!recording) throw new Error("This recording is not on the server.");
  const link = workLink(recording.workId);
  if (link?.provider !== "audiobookdb") throw new Error("Match the book on AudiobookDB first.");
  // A release of the main entry or of one of its duplicates (#754): all are this work's.
  const entries = workEntryIds(recording.workId);
  const release = await audiobookDbRelease(releaseId, { priority, bookId: link.id });
  if (release.bookId && !entries.includes(release.bookId)) throw new Error("This release belongs to another book.");
  const narrator = release.narrators.join(", ") || null;
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO recording_release_links(recording_id,book_id,release_id,narrator,length_ms,asin,language,chapters,matched_by,linked_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(recording_id) DO UPDATE SET book_id=excluded.book_id,release_id=excluded.release_id,narrator=excluded.narrator,length_ms=excluded.length_ms,
           asin=excluded.asin,language=excluded.language,chapters=excluded.chapters,matched_by=excluded.matched_by,linked_at=excluded.linked_at`,
      )
      .run(recordingId, release.bookId ?? link.id, release.id, narrator, release.lengthMs, release.asin, release.language, JSON.stringify(release.chapters), matchedBy, Date.now());
    if (narrator && missingNarrator(recording.narrator)) sqlite.prepare("UPDATE audio_editions SET narrator=? WHERE id=?").run(narrator, recording.editionId);
  })();
}
export function unlinkRecording(recordingId: string) {
  sqlite.prepare("DELETE FROM recording_release_links WHERE recording_id=?").run(recordingId);
}

/**
 * The other AudiobookDB entries that are the same work as `book` (#754): one search by its own title and author, the
 * matcher's rule applied to the book itself. A search refused or failing leaves the link alone, without duplicates.
 */
async function sameWorkEntries(book: CatalogueBook, priority: Priority): Promise<string[]> {
  if (!book.authors.length) return [];
  try {
    const results = await searchAudiobookDbBooks(`${searchTitle(book.title, book.authors)} ${book.authors[0]}`, { priority });
    const found = decide({ title: book.title, author: book.authors.join("; "), position: bookPosition(book) }, [book, ...results]);
    return found.outcome === "matched" ? found.books.map((entry) => entry.id).filter((id) => id !== book.id) : [];
  } catch (error) {
    if (!(error instanceof CatalogueError)) throw error;
    return [];
  }
}

/**
 * Links a work to a provider book (AudiobookDB) or work (Open Library) and fills what is missing. On AudiobookDB the
 * other entries of the same work are kept beside it as duplicates (#754): `duplicates` when the matcher has found
 * them, else gathered by one search. Each recording without a release picked by hand is linked to the release, of any
 * of these entries, it surely is.
 */
export async function linkWork(
  workId: string,
  target: { provider: CatalogueProviderName; id: string; author?: string },
  matchedBy: WorkLink["matchedBy"],
  priority: Priority = "interactive",
  options: { duplicates?: string[] } = {},
): Promise<void> {
  const work = workRow(workId);
  if (!work) throw new Error("This book is not on the server.");
  const wantsDescription = !work.description.trim();
  if (isExtraProvider(target.provider)) return linkProvider(workId, target.provider, target.id, wantsDescription, priority);
  let stored: { title: string; author: string; series: CatalogueBook["series"][number] | null; description: string | null };
  let releases: CatalogueRelease[] = [];
  const duplicates: { book: CatalogueBook; releases: number }[] = [];
  if (target.provider === "audiobookdb") {
    // A live answer only when the description is to be filled: the cache never holds one.
    const book = await audiobookDbBook(target.id, { priority, fresh: wantsDescription });
    stored = { title: book.title, author: book.authors.join(", "), series: book.series[0] ?? null, description: book.description };
    releases = (await audiobookDbReleases(book.id, { priority })).map((release) => ({ ...release, bookId: release.bookId ?? book.id }));
    const others = options.duplicates ?? (await sameWorkEntries(book, priority));
    for (const id of new Set(others.filter((other) => other !== book.id))) {
      const duplicate = await audiobookDbBook(id, { priority });
      const own = (await audiobookDbReleases(id, { priority })).map((release) => ({ ...release, bookId: release.bookId ?? id }));
      duplicates.push({ book: duplicate, releases: own.length });
      releases.push(...own.filter((release) => !releases.some((known) => known.id === release.id)));
    }
  } else {
    const found = await openLibraryWork(target.id, { priority, fresh: wantsDescription });
    stored = { title: found.title, author: (target.author ?? "").slice(0, 300), series: null, description: found.description };
  }
  const entries = target.provider === "audiobookdb" ? [target.id, ...duplicates.map((entry) => entry.book.id)] : [];
  const now = Date.now();
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO work_catalogue_links(work_id,provider,external_id,title,author,series_id,series_name,series_position,series_sort,matched_by,linked_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(work_id) DO UPDATE SET provider=excluded.provider,external_id=excluded.external_id,title=excluded.title,author=excluded.author,
           series_id=excluded.series_id,series_name=excluded.series_name,series_position=excluded.series_position,series_sort=excluded.series_sort,
           matched_by=excluded.matched_by,linked_at=excluded.linked_at`,
      )
      .run(workId, target.provider, target.id, stored.title, stored.author, stored.series?.id ?? null, stored.series?.name ?? null, stored.series?.position ?? null, stored.series?.sort ?? null, matchedBy, now);
    sqlite.prepare("DELETE FROM work_catalogue_duplicates WHERE work_id=?").run(workId);
    const keep = sqlite.prepare("INSERT OR REPLACE INTO work_catalogue_duplicates(work_id,provider,external_id,title,author,releases,linked_at) VALUES(?,'audiobookdb',?,?,?,?,?)");
    for (const entry of duplicates) keep.run(workId, entry.book.id, entry.book.title, entry.book.authors.join(", ").slice(0, 300), entry.releases, now);
    if (wantsDescription && stored.description) sqlite.prepare("UPDATE works SET description=? WHERE id=? AND trim(description)=''").run(stored.description, workId);
    sqlite
      .prepare("INSERT INTO work_catalogue_match(work_id,outcome,reason,candidates,checked_at) VALUES(?,?,NULL,1,?) ON CONFLICT(work_id) DO UPDATE SET outcome=excluded.outcome,reason=NULL,candidates=1,checked_at=excluded.checked_at")
      .run(workId, "matched", now);
    // A release of an entry the work no longer is: its link no longer holds.
    sqlite
      .prepare(
        `DELETE FROM recording_release_links WHERE recording_id IN (SELECT r.id FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE e.work_id=?)
         AND book_id NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(workId, JSON.stringify(entries));
  })();
  if (target.provider !== "audiobookdb") return;
  for (const recording of workRecordings(workId)) {
    if (releaseLink(recording.recordingId)?.matchedBy === "manual") continue;
    const picked = pickRelease(recording, releases);
    if (picked) await linkRecording(recording.recordingId, picked.release.id, picked.by, priority);
  }
}
/**
 * A Google Books volume or an iTunes audiobook (part e), linked beside the main link. It fills only what is missing:
 * of series, position, narrator and description these two give only the description; title, author and cover stay.
 */
async function linkProvider(workId: string, provider: ExtraCatalogueProvider, id: string, wantsDescription: boolean, priority: Priority): Promise<void> {
  // A live answer only when the description is to be filled: the cache never holds one.
  const book = provider === "googlebooks" ? await googleBooksVolume(id, { priority, fresh: wantsDescription }) : await itunesAudiobook(id, { priority, fresh: wantsDescription });
  const now = Date.now();
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO work_provider_links(work_id,provider,external_id,title,author,matched_by,linked_at) VALUES(?,?,?,?,?,'manual',?)
         ON CONFLICT(work_id,provider) DO UPDATE SET external_id=excluded.external_id,title=excluded.title,author=excluded.author,matched_by=excluded.matched_by,linked_at=excluded.linked_at`,
      )
      .run(workId, provider, book.id, book.title, book.authors.join(", ").slice(0, 300), now);
    if (wantsDescription && book.description) sqlite.prepare("UPDATE works SET description=? WHERE id=? AND trim(description)=''").run(book.description, workId);
    sqlite
      .prepare("INSERT INTO work_catalogue_match(work_id,outcome,reason,candidates,checked_at) VALUES(?,?,NULL,1,?) ON CONFLICT(work_id) DO UPDATE SET outcome=excluded.outcome,reason=NULL,candidates=1,checked_at=excluded.checked_at")
      .run(workId, "matched", now);
  })();
}
/** Removes one Google Books or iTunes link; the main link and the other stay. */
export function unlinkProvider(workId: string, provider: ExtraCatalogueProvider) {
  sqlite.prepare("DELETE FROM work_provider_links WHERE work_id=? AND provider=?").run(workId, provider);
}
/** Removes the main link (AudiobookDB or Open Library), its duplicates and its recordings' release links; Google Books and iTunes stay. */
export function unlinkWork(workId: string) {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM work_catalogue_links WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM work_catalogue_duplicates WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM work_catalogue_match WHERE work_id=?").run(workId);
    sqlite.prepare("DELETE FROM recording_release_links WHERE recording_id IN (SELECT r.id FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE e.work_id=?)").run(workId);
  })();
}

// ---- Matching one work, and the batch ----
export type MatchOutcome = { outcome: "matched" | "ambiguous" | "missing" | "failed"; reason: string | null; candidates: number };
function recordOutcome(workId: string, outcome: MatchOutcome) {
  sqlite
    .prepare(
      `INSERT INTO work_catalogue_match(work_id,outcome,reason,candidates,checked_at) VALUES(?,?,?,?,?)
       ON CONFLICT(work_id) DO UPDATE SET outcome=excluded.outcome,reason=excluded.reason,candidates=excluded.candidates,checked_at=excluded.checked_at`,
    )
    .run(workId, outcome.outcome, outcome.reason, outcome.candidates, Date.now());
}
export function matchOutcome(workId: string): (MatchOutcome & { checkedAt: number }) | null {
  return (sqlite.prepare("SELECT outcome,reason,candidates,checked_at AS checkedAt FROM work_catalogue_match WHERE work_id=?").get(workId) as (MatchOutcome & { checkedAt: number }) | undefined) ?? null;
}

/** One work: by the file's ASIN, else by exact title and author on AudiobookDB, else (no audio) on Open Library. */
export async function matchWork(workId: string, priority: Priority = "background"): Promise<MatchOutcome> {
  const work = workRow(workId);
  if (!work) throw new Error("This book is not on the server.");
  const recordings = workRecordings(workId);
  const asin = recordings.find((recording) => recording.asin)?.asin ?? null;
  if (asin) {
    const hit = await audiobookDbByAsin(asin, { priority });
    if (hit) {
      await linkWork(workId, { provider: "audiobookdb", id: hit.bookId }, "asin", priority);
      return { outcome: "matched", reason: null, candidates: 1 };
    }
  }
  // The title without a series prefix, omnibus label or author's name first; as written (before #754) if that is not sure.
  const title = searchTitle(work.title, [work.author]);
  const written = writtenSearchTitle(work.title);
  const facts = { title: work.title, author: work.author, position: workSeriesPosition(workId, work.title) };
  let decision = decide(facts, await searchAudiobookDbBooks(`${title} ${work.author}`, { priority }));
  if (decision.outcome !== "matched" && written !== title) {
    const asWritten = decide(facts, await searchAudiobookDbBooks(`${written} ${work.author}`, { priority }));
    if (asWritten.outcome === "matched" || decision.outcome === "missing") decision = asWritten;
  }
  if (decision.outcome !== "matched") {
    const byTitle = decide(facts, await searchAudiobookDbBooks(title, { priority }));
    if (byTitle.outcome === "matched" || decision.outcome === "missing") decision = byTitle;
  }
  if (decision.outcome === "matched") {
    // Every entry of the work, with its releases: the one with the most is the link, the others its duplicates.
    const entries: { id: string; releases: CatalogueRelease[] }[] = [];
    for (const book of decision.books) entries.push({ id: book.id, releases: await audiobookDbReleases(book.id, { priority }) });
    const all = entries.flatMap((entry) => entry.releases);
    if (all.length && !all.some(englishRelease)) {
      const outcome: MatchOutcome = { outcome: "missing", reason: "No English release on AudiobookDB.", candidates: 0 };
      recordOutcome(workId, outcome);
      return outcome;
    }
    const main = entries.reduce((best, entry) => (entry.releases.length > best.releases.length ? entry : best));
    await linkWork(workId, { provider: "audiobookdb", id: main.id }, "title", priority, { duplicates: entries.filter((entry) => entry !== main).map((entry) => entry.id) });
    return { outcome: "matched", reason: null, candidates: 1 };
  }
  // A book without an audiobook is not on AudiobookDB: Open Library gives it its link.
  if (!recordings.length) {
    const open = decide(facts, await searchOpenLibrary(`${title} ${work.author}`, { priority }));
    // Duplicates are kept for AudiobookDB entries only: several Open Library works of this title stay for the administrator.
    if (open.outcome === "matched" && open.books.length === 1) {
      await linkWork(workId, { provider: "openlibrary", id: open.book.id, author: open.book.authors.join(", ") }, "title", priority);
      return { outcome: "matched", reason: null, candidates: 1 };
    }
  }
  const outcome: MatchOutcome =
    decision.outcome === "ambiguous"
      ? { outcome: "ambiguous", reason: null, candidates: decision.candidates }
      : { outcome: "missing", reason: null, candidates: 0 };
  recordOutcome(workId, outcome);
  return outcome;
}

export type BatchStatus = { running: boolean; startedAt: number | null; finishedAt: number | null; done: number; total: number; matched: number; error: string | null };
let batch: BatchStatus = { running: false, startedAt: null, finishedAt: null, done: 0, total: 0, matched: 0, error: null };
let batchRun: Promise<void> | null = null;
export const batchStatus = (): BatchStatus => ({ ...batch });
/** Tests: wait for the batch that is running. */
export const batchFinished = () => batchRun ?? Promise.resolve();

/** Starts the batch over every work without a link, unless one is running. */
export function startBatchMatch(): BatchStatus {
  if (batch.running) return batchStatus();
  const works = sqlite.prepare(`SELECT id FROM works WHERE id NOT IN (${LINKED_WORKS}) ORDER BY title`).pluck().all() as string[];
  batch = { running: true, startedAt: Date.now(), finishedAt: null, done: 0, total: works.length, matched: 0, error: null };
  batchRun = (async () => {
    for (const workId of works) {
      try {
        const outcome = await matchWork(workId, "background");
        if (outcome.outcome === "matched") batch.matched++;
      } catch (error) {
        const reason = (error as Error).message;
        recordOutcome(workId, { outcome: "failed", reason, candidates: 0 });
        // No key, a rejected key or the day's units spent: every next work would fail the same way.
        if (error instanceof CatalogueError && ["missing_key", "rejected", "daily_limit"].includes(error.kind)) {
          batch.error = reason;
          break;
        }
      } finally {
        batch.done++;
      }
    }
    batch.running = false;
    batch.finishedAt = Date.now();
  })();
  return batchStatus();
}

/** The works the batch could not match surely, for the administrator to pick by hand. */
export function unmatchedWorks(): { workId: string; title: string; author: string; outcome: MatchOutcome["outcome"]; reason: string | null; candidates: number }[] {
  return sqlite
    .prepare(
      `SELECT w.id AS workId,w.title,w.author,m.outcome,m.reason,m.candidates FROM work_catalogue_match m JOIN works w ON w.id=m.work_id
       WHERE m.outcome<>'matched' AND m.work_id NOT IN (${LINKED_WORKS}) ORDER BY w.title`,
    )
    .all() as ReturnType<typeof unmatchedWorks>;
}

// ---- The cache's refresh and deletion obligations ----
/** One round: expired searches go; up to `limit` expired details are fetched again (a 404 deletes them). */
export async function refreshCatalogue(now = Date.now(), limit = 20): Promise<{ dropped: number; refreshed: number; failed: number }> {
  const dropped = dropExpiredSearches(now);
  let refreshed = 0;
  let failed = 0;
  // A provider out of key or units waits for the next round; the others go on.
  const stopped = new Set<CatalogueProviderName>();
  for (const entry of expiredDetails(now, limit)) {
    if (stopped.has(entry.provider)) continue;
    try {
      if (entry.provider === "audiobookdb") await refreshAudiobookDbEntry(entry.kind, entry.key);
      else if (entry.provider === "googlebooks") await refreshGoogleBooksEntry(entry.kind, entry.key);
      else if (entry.provider === "itunes") await refreshItunesEntry(entry.kind, entry.key);
      else await refreshOpenLibraryEntry(entry.kind, entry.key);
      refreshed++;
    } catch (error) {
      if (error instanceof CatalogueError && error.kind === "not_found") {
        refreshed++;
        continue;
      }
      failed++;
      // No key or no units left: that provider's rest waits for the next round; the stale entry keeps serving.
      if (error instanceof CatalogueError && ["missing_key", "rejected", "daily_limit", "rate_limited"].includes(error.kind)) stopped.add(entry.provider);
    }
  }
  return { dropped, refreshed, failed };
}
export function catalogueRefreshLoop(log: (message: string) => void): BackgroundProcess {
  return {
    id: "catalogue-refresh",
    intervalMs: 60 * 60 * 1000,
    runAtStart: false,
    tick: () =>
      refreshCatalogue().then(
        (result) => {
          if (result.failed) log(`Catalogue refresh: ${result.failed} cached entries could not be fetched again; they are tried next hour.`);
        },
        (error: Error) => log(`Catalogue refresh failed: ${error.message}`),
      ),
  };
}

/** What a work's own catalogue is called in a search on its match page. */
export const matchQuery = (work: { title: string; author: string }) => `${work.title} ${work.author}`.trim().slice(0, 150);
export { audiobookDbBook };
