// A recording's chapters on the book's Edit page (#719 part c), the administrator's.
//
// - The edited chapters are one row of `recording_metadata_overrides` (part a's table), field `chapters`: a JSON list
//   of `{ title, start }` with `start` in seconds from the recording's beginning, over all its files. The files and the
//   `tracks` rows are never written; deleting the row (Revert) gives the files' chapters back.
// - Clients read chapters per file (`Track.chapters`, track-relative). `chaptersOverTracks` places the edited list over
//   the files by their lengths, so the player's chapter list, Media Session and the reader's chapter lines read the
//   edited chapters through `GET /api/books` and the read by work without a change of shape. A file that begins inside
//   a chapter starts with that chapter's title again: a chapter row belongs to one file, as a saved place does.
// - Progress stays keyed by recording, track and position: nothing here reads or writes `user_progress`, so an edit
//   never moves a saved place.
// - Look up chapters: the linked AudiobookDB release's `chapterDetail` (#721 keeps it on the link), or the release of
//   an ASIN. They are taken only when the release's length agrees with the recording's within a few seconds
//   (`CHAPTER_LENGTH_TOLERANCE_S`, #721's rule); otherwise they are shown with the reason.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlite } from "./db.ts";
import { requireAdmin } from "./users.ts";
import { idList } from "./work-cover.ts";
import { audiobookDbByAsin, audiobookDbRelease, audiobookDbReleases, type CatalogueChapter, type CatalogueRelease } from "./audiobookdb.ts";
import { CatalogueError } from "./catalogue-provider.ts";
import type { Chapter } from "./chapters.ts";
import type { ChapterLookup, RecordingChapter, RecordingChapters } from "../src/types.ts";

/** How far a release's length may be from the recording's for its chapters to be taken (#721: "a few seconds"). */
export const CHAPTER_LENGTH_TOLERANCE_S = 5;
export const CHAPTER_LIMIT = 2000;

type TrackLike = { id: string; index: number; title: string; duration: number; chapters: Chapter[] | null | undefined };

const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;
const ordered = <T extends TrackLike>(tracks: T[]) => [...tracks].sort((a, b) => a.index - b.index);

/** Whether every file's length is known: only then can a recording's time be placed in a file (one file needs none). */
export function lengthKnown(tracks: TrackLike[]) {
  return tracks.length === 1 || (tracks.length > 0 && tracks.every((track) => track.duration > 0));
}
export const recordingLength = (tracks: TrackLike[]) => (lengthKnown(tracks) ? tracks.reduce((total, track) => total + Math.max(0, track.duration), 0) : 0);

/** The files' own chapters over the whole recording; a file without any is one chapter named after it. */
export function fileChapters(tracks: TrackLike[]): RecordingChapter[] {
  let offset = 0;
  const out: RecordingChapter[] = [];
  for (const track of ordered(tracks)) {
    const own = track.chapters ?? [];
    if (own.length) for (const chapter of own) out.push({ title: chapter.title, start: ms(offset + chapter.start) });
    else out.push({ title: track.title, start: ms(offset) });
    offset += Math.max(0, track.duration);
  }
  return out;
}

/**
 * The edited chapters placed over the files: each file's chapters with starts and ends from the file's beginning. A
 * file that begins inside a chapter starts with that chapter's title. Needs every file's length (`lengthKnown`).
 */
export function chaptersOverTracks(tracks: TrackLike[], chapters: RecordingChapter[]): Map<string, Chapter[]> {
  const list = [...chapters].sort((a, b) => a.start - b.start);
  const out = new Map<string, Chapter[]>();
  const files = ordered(tracks);
  let offset = 0;
  for (const [i, track] of files.entries()) {
    const last = i === files.length - 1;
    const length = Math.max(0, track.duration);
    const end = offset + length;
    const inside = list.filter((chapter) => chapter.start >= offset && (last && !(length > 0) ? true : chapter.start < end));
    const before = list.filter((chapter) => chapter.start < offset).at(-1);
    const own: { title: string; start: number }[] = inside.map((chapter) => ({ title: chapter.title, start: ms(chapter.start - offset) }));
    if (before && !(own[0]?.start === 0)) own.unshift({ title: before.title, start: 0 });
    out.set(
      track.id,
      own.map((chapter, index) => {
        const next = own[index + 1]?.start ?? (length > 0 ? length : undefined);
        return next === undefined ? { ...chapter } : { ...chapter, end: ms(next) };
      }),
    );
    offset = end;
  }
  return out;
}

/** The edited chapters of `recordingIds` (all recordings when absent), by recording. A row that is not a list is not ours. */
export function chapterOverrides(recordingIds?: string[]): Map<string, RecordingChapter[]> {
  if (recordingIds && !recordingIds.length) return new Map();
  const rows = (
    recordingIds
      ? sqlite
          .prepare("SELECT recording_id AS recordingId,value FROM recording_metadata_overrides WHERE field='chapters' AND recording_id IN (SELECT value FROM json_each(?))")
          .all(idList(recordingIds))
      : sqlite.prepare("SELECT recording_id AS recordingId,value FROM recording_metadata_overrides WHERE field='chapters'").all()
  ) as { recordingId: string; value: string }[];
  const map = new Map<string, RecordingChapter[]>();
  for (const row of rows) {
    const value = parsed(row.value);
    if (!Array.isArray(value)) continue;
    const list = value.flatMap((entry) =>
      entry && typeof entry === "object" && typeof entry.title === "string" && typeof entry.start === "number" && Number.isFinite(entry.start)
        ? [{ title: entry.title as string, start: entry.start as number }]
        : [],
    );
    map.set(row.recordingId, list);
  }
  return map;
}
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** The tracks as stored, each with the edited chapters in place when the recording's were edited (and can be placed). */
export function withEditedChapters<T extends TrackLike>(tracks: T[], edited: RecordingChapter[] | undefined): T[] {
  if (!edited || !lengthKnown(tracks)) return tracks;
  const placed = chaptersOverTracks(tracks, edited);
  return tracks.map((track) => ({ ...track, chapters: placed.get(track.id) ?? [] }));
}

/** Whether a release's chapters may be taken for a recording of `seconds`: the reason when not. */
export function releaseAgreement(release: { lengthMs: number | null; chapters: unknown[] }, seconds: number, known: boolean): string | null {
  if (!release.chapters.length) return "AudiobookDB has no chapters for this release.";
  if (!known || !(seconds > 0)) return "The recording's length is not known yet: play each file once, then look up again.";
  if (release.lengthMs === null) return "AudiobookDB gives no length for this release, so its chapters cannot be checked against the recording.";
  const difference = Math.abs(release.lengthMs / 1000 - seconds);
  if (difference <= CHAPTER_LENGTH_TOLERANCE_S) return null;
  return `The release is ${clockText(release.lengthMs / 1000)} long and this recording ${clockText(seconds)}; chapters are taken only when they agree within ${CHAPTER_LENGTH_TOLERANCE_S} seconds.`;
}
export function clockText(seconds: number) {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600),
    m = Math.floor((whole % 3600) / 60),
    s = whole % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export const releaseChapters = (chapters: CatalogueChapter[]): RecordingChapter[] =>
  [...chapters].sort((a, b) => a.startMs - b.startMs).map((chapter, index) => ({ title: chapter.title.trim() || `Chapter ${index + 1}`, start: ms(chapter.startMs / 1000) }));

// ---- Reading a recording ----
type RecordingRow = { recordingId: string; workId: string; label: string };
function recordingRow(recordingId: string): RecordingRow | null {
  const row = sqlite
    .prepare(
      `SELECT r.id AS recordingId,e.work_id AS workId,COALESCE(NULLIF(e.release_title,''),NULLIF(e.source_label,''),NULLIF(e.narrator,''),'Recording') AS label
       FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE r.id=?`,
    )
    .get(recordingId) as RecordingRow | undefined;
  return row ?? null;
}
function storedTracks(recordingId: string): TrackLike[] {
  const rows = sqlite.prepare("SELECT id,track_index AS 'index',title,duration,chapters FROM tracks WHERE recording_id=?").all(recordingId) as (Omit<TrackLike, "chapters"> & { chapters: string })[];
  return rows.map((row) => {
    const value = parsed(row.chapters);
    return { ...row, chapters: Array.isArray(value) ? (value as Chapter[]) : [] };
  });
}
function overrideSource(recordingId: string): "audiobookdb" | null {
  const source = sqlite.prepare("SELECT source FROM recording_metadata_overrides WHERE recording_id=? AND field='chapters'").pluck().get(recordingId);
  return source === "audiobookdb" ? "audiobookdb" : null;
}
type LinkRow = { releaseId: string; bookId: string; asin: string | null; lengthMs: number | null; chapters: string };
const linkRow = (recordingId: string) =>
  (sqlite.prepare("SELECT release_id AS releaseId,book_id AS bookId,asin,length_ms AS lengthMs,chapters FROM recording_release_links WHERE recording_id=?").get(recordingId) as LinkRow | undefined) ?? null;
/** The work's ASIN: the edited one, else a release link's. */
function workAsin(workId: string): string | null {
  const edited = sqlite.prepare("SELECT value FROM work_metadata_overrides WHERE work_id=? AND field='asin'").pluck().get(workId) as string | undefined;
  const value = edited === undefined ? undefined : parsed(edited);
  if (typeof value === "string" && value) return value;
  return (
    (sqlite
      .prepare("SELECT l.asin FROM recording_release_links l JOIN recordings r ON r.id=l.recording_id JOIN audio_editions e ON e.id=r.edition_id WHERE e.work_id=? AND l.asin IS NOT NULL ORDER BY l.linked_at LIMIT 1")
      .pluck()
      .get(workId) as string | undefined) ?? null
  );
}

export function recordingChapters(recordingId: string): RecordingChapters | null {
  const row = recordingRow(recordingId);
  if (!row) return null;
  const tracks = storedTracks(recordingId);
  const source = fileChapters(tracks);
  const edited = chapterOverrides([recordingId]).get(recordingId);
  const link = linkRow(recordingId);
  return {
    recordingId,
    workId: row.workId,
    label: row.label,
    duration: ms(recordingLength(tracks)),
    lengthKnown: lengthKnown(tracks),
    chapters: edited ?? source,
    source,
    edited: !!edited,
    from: edited ? overrideSource(recordingId) : null,
    release: link ? { releaseId: link.releaseId, asin: link.asin, lengthMs: link.lengthMs } : null,
    asin: link?.asin ?? workAsin(row.workId),
  };
}

/** Writes or reverts (null) a recording's chapters; a list equal to the files' is not kept as an edit. */
export function writeChapters(recordingId: string, chapters: RecordingChapter[] | null, from: "audiobookdb" | null = null) {
  const current = recordingChapters(recordingId);
  if (!current) throw Object.assign(new Error("This recording could not be found."), { statusCode: 404 });
  const list = chapters && [...chapters].sort((a, b) => a.start - b.start).map((chapter) => ({ title: chapter.title.trim(), start: ms(chapter.start) }));
  if (list) {
    if (list.length > 1 && !current.lengthKnown)
      throw Object.assign(new Error("Every file's length must be known to place chapters over the files: play each file once."), { statusCode: 409 });
    for (const [index, chapter] of list.entries()) {
      if (index > 0 && chapter.start <= list[index - 1].start) throw Object.assign(new Error("Two chapters start at the same time."), { statusCode: 400 });
      if (current.duration > 0 && chapter.start >= current.duration) throw Object.assign(new Error(`"${chapter.title}" starts after the recording ends.`), { statusCode: 400 });
    }
  }
  if (!list || JSON.stringify(list) === JSON.stringify(current.source))
    sqlite.prepare("DELETE FROM recording_metadata_overrides WHERE recording_id=? AND field='chapters'").run(recordingId);
  else
    sqlite
      .prepare(
        "INSERT INTO recording_metadata_overrides(recording_id,field,value,edited_at,source) VALUES(?,'chapters',?,?,?) ON CONFLICT(recording_id,field) DO UPDATE SET value=excluded.value,edited_at=excluded.edited_at,source=excluded.source",
      )
      .run(recordingId, JSON.stringify(list), Date.now(), from);
  return recordingChapters(recordingId)!;
}

/** The release of an ASIN: the one AudiobookDB names, else the book's release with that ASIN, else its only release. */
async function releaseOfAsin(asin: string): Promise<CatalogueRelease | null> {
  const found = await audiobookDbByAsin(asin);
  if (!found) return null;
  if (found.releaseId) return audiobookDbRelease(found.releaseId, { bookId: found.bookId });
  const releases = await audiobookDbReleases(found.bookId);
  return releases.find((release) => release.asin?.toUpperCase() === asin.toUpperCase()) ?? (releases.length === 1 ? releases[0] : null);
}

/** Look up chapters: from the linked release (its stored chapters, else read again), or the release of `asin`. */
export async function lookUpChapters(recordingId: string, asin?: string): Promise<ChapterLookup> {
  const current = recordingChapters(recordingId);
  if (!current) throw Object.assign(new Error("This recording could not be found."), { statusCode: 404 });
  const link = linkRow(recordingId);
  let release: { id: string; asin: string | null; lengthMs: number | null; chapters: CatalogueChapter[] } | null = null;
  let from: ChapterLookup["from"];
  if (asin || !link) {
    const key = (asin ?? current.asin ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(key))
      throw Object.assign(new Error(link || current.asin ? "An ASIN has 10 letters and digits." : "Link this recording to an AudiobookDB release on the match page, or give an ASIN."), { statusCode: 400 });
    from = "asin";
    release = await releaseOfAsin(key);
    if (!release) throw Object.assign(new Error(`AudiobookDB has no release with the ASIN ${key}.`), { statusCode: 404 });
  } else {
    from = "release";
    const stored = parsed(link.chapters);
    const chapters = Array.isArray(stored) ? (stored as CatalogueChapter[]) : [];
    release = chapters.length
      ? { id: link.releaseId, asin: link.asin, lengthMs: link.lengthMs, chapters }
      : await audiobookDbRelease(link.releaseId, { bookId: link.bookId });
  }
  const reason = releaseAgreement(release, current.duration, current.lengthKnown);
  return { from, releaseId: release.id, asin: release.asin, lengthMs: release.lengthMs, chapters: releaseChapters(release.chapters), agrees: reason === null, reason };
}

// ---- Routes ----
const chapterInput = z.object({ title: z.string().trim().min(1, "Name every chapter.").max(300), start: z.number().finite().min(0).max(1_000_000) }).strip();

export function registerRecordingChapterRoutes(app: FastifyInstance) {
  const params = z.object({ recordingId: z.string().min(1).max(200) });
  const answer = (recordingId: string) => {
    const value = recordingChapters(recordingId);
    if (!value) throw Object.assign(new Error("This recording could not be found."), { statusCode: 404 });
    return value;
  };
  app.get("/api/recordings/:recordingId/chapters", async (req) => {
    requireAdmin(req);
    return answer(params.parse(req.params).recordingId);
  });
  /**
   * `{ chapters: [{ title, start }] }` keeps them as the recording's edited chapters (`from: "audiobookdb"` when they
   * were looked up); `{ chapters: null }` reverts to the files'. An empty body (an older client's) changes nothing.
   */
  app.put("/api/recordings/:recordingId/chapters", async (req) => {
    requireAdmin(req);
    const { recordingId } = params.parse(req.params);
    answer(recordingId);
    const body = z
      .object({ chapters: z.array(chapterInput).max(CHAPTER_LIMIT).nullable().optional(), from: z.enum(["audiobookdb"]).nullable().optional() })
      .parse(req.body ?? {});
    if (body.chapters === undefined) return answer(recordingId);
    return writeChapters(recordingId, body.chapters, body.from ?? null);
  });
  /** `{ asin? }`: the chapters of the linked release, or of the ASIN's release, with whether they may be taken. */
  app.post("/api/recordings/:recordingId/chapters/lookup", async (req, reply) => {
    requireAdmin(req);
    const { recordingId } = params.parse(req.params);
    const { asin } = z.object({ asin: z.string().trim().max(20).optional() }).parse(req.body ?? {});
    try {
      return await lookUpChapters(recordingId, asin || undefined);
    } catch (error) {
      if (error instanceof CatalogueError)
        return reply.code(error.kind === "missing_key" ? 409 : 502).send({ error: error.message, kind: error.kind, provider: error.provider });
      throw error;
    }
  });
}

