import { sqliteTable, text, integer, real, primaryKey, index } from "drizzle-orm/sqlite-core";
import { ACQUISITION_STATUSES, type AcquisitionStatus } from "./acquisition-vocabulary.ts";
export const works = sqliteTable("works", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author").notNull(),
  description: text("description").notNull(),
  genre: text("genre").notNull(),
  year: integer("year").notNull(),
});
export const editions = sqliteTable("audio_editions", {
  language: text("language"),
  releaseTitle: text("release_title"),
  id: text("id").primaryKey(),
  workId: text("work_id")
    .notNull()
    .references(() => works.id),
  cover: text("cover").notNull(),
  narrator: text("narrator").notNull(),
  rating: real("rating").notNull(),
  sourceLabel: text("source_label").notNull(),
}, (t) => [index("audio_editions_work").on(t.workId)]);
export const recordings = sqliteTable("recordings", {
  id: text("id").primaryKey(),
  editionId: text("edition_id")
    .notNull()
    .references(() => editions.id),
}, (t) => [index("recordings_edition").on(t.editionId)]);
export const alignmentJobs = sqliteTable("alignment_jobs", {
  id: text("id").primaryKey(),
  ebookId: text("ebook_id").notNull().references(() => ebookEditions.id),
  recordingId: text("recording_id").notNull().references(() => recordings.id),
  data: text("data").notNull(),
  updatedAt: integer("updated_at").notNull(),
  engine: text("engine").notNull().default("aeneas-1.7.3"),
  outcome: text("outcome"),
  stageTimings: text("stage_timings", { mode: "json" }).$type<Record<string, number>>(),
  claimOwner: text("claim_owner"),
  claimGeneration: text("claim_generation"),
  claimedAt: integer("claimed_at"),
  publishedMap: text("published_map"),
  projectedFrom: text("projected_from"),
});
/** Staged pool folder names retired before their removal was sent (#421): staging never uses one again. */
export const alignmentPoolRetired = sqliteTable("alignment_pool_retired", {
  name: text("name").primaryKey(),
  jobId: text("job_id").notNull(),
  recordingId: text("recording_id").notNull(),
  retiredAt: integer("retired_at").notNull(),
});
/** Where a deleted alignment job had staged its tracks (#421). */
export const alignmentPoolOrphans = sqliteTable("alignment_pool_orphans", {
  hostId: text("host_id").notNull(),
  folder: text("folder").notNull(),
  jobId: text("job_id").notNull(),
  recordingId: text("recording_id").notNull(),
  deletedAt: integer("deleted_at").notNull(),
}, (table) => [primaryKey({ columns: [table.hostId, table.folder] })]);
export const tracks = sqliteTable("tracks", {
  chapters: text("chapters", { mode: "json" })
    .$type<{ title: string; start: number; end?: number }[]>()
    .notNull()
    .default([]),
  id: text("id").primaryKey(),
  recordingId: text("recording_id")
    .notNull()
    .references(() => recordings.id),
  title: text("title").notNull(),
  index: integer("track_index").notNull(),
  duration: real("duration").notNull().default(0),
  source: text("source").notNull(),
  sourceType: text("source_type").notNull(),
}, (t) => [index("tracks_recording").on(t.recordingId)]);
export const library = sqliteTable("library", {
  bookId: text("book_id")
    .primaryKey()
    .references(() => editions.id),
  status: text("status").notNull().default("unread"),
  addedAt: integer("added_at").notNull(),
});
export const hiddenLibrary = sqliteTable("hidden_library", {
  bookId: text("book_id")
    .primaryKey()
    .references(() => editions.id),
});
export const progress = sqliteTable("progress", {
  recordingId: text("recording_id")
    .primaryKey()
    .references(() => recordings.id),
  trackId: text("track_id")
    .notNull()
    .references(() => tracks.id),
  position: real("position").notNull(),
  duration: real("duration").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  userId: integer("user_id").notNull().default(1),
});
// Independent ebook editions and CFI progress reserve the identity boundary for future alignment.
export const ebookEditions = sqliteTable("ebook_editions", {
  id: text("id").primaryKey(),
  workId: text("work_id")
    .notNull()
    .references(() => works.id),
  format: text("format").notNull(),
  source: text("source").notNull(),
});
export const ebookProgress = sqliteTable("ebook_progress", {
  editionId: text("edition_id")
    .primaryKey()
    .references(() => ebookEditions.id),
  cfi: text("cfi").notNull(),
  chapter: integer("chapter").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
/**
 * The statuses a download (acquisition) row can hold, as `server/acquisitions.ts`, `server/app.ts` and
 * `server/series-removal.ts` write them. The table has no CHECK constraint; the column type checks the writers
 * that go through Drizzle, and the Activity source maps each value (#392). TypeScript only: no SQL changes.
 */
export { ACQUISITION_STATUSES };
export type AcquisitionJobStatus = AcquisitionStatus;
/** The statuses a copy to the server (`server_downloads`) can hold, as `server/downloads.ts` writes them. */
export const SERVER_COPY_STATUSES = ["queued", "downloading", "paused", "ready", "error"] as const;
export type ServerCopyStatus = (typeof SERVER_COPY_STATUSES)[number];
/** The statuses of a daily database backup run (`backup_runs`), as `server/backups.ts` writes them (#361). */
export const BACKUP_RUN_STATUSES = ["running", "done", "failed"] as const;
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];
/** The result of the retention after a successful backup run (`backup_runs.cleanup`). */
export const BACKUP_CLEANUP_STATUSES = ["done", "failed"] as const;
export type BackupCleanupStatus = (typeof BACKUP_CLEANUP_STATUSES)[number];
export const acquisitions = sqliteTable("acquisitions", {
  workId: text("work_id"),
  language: text("language"),
  narrator: text("narrator"),
  id: text("id").primaryKey(),
  hash: text("hash").notNull().unique(),
  magnet: text("magnet").notNull(),
  backend: text("backend").notNull(),
  remoteId: text("remote_id"),
  title: text("title").notNull(),
  author: text("author").notNull(),
  cover: text("cover").notNull(),
  status: text("status", { enum: ACQUISITION_STATUSES }).notNull(),
  progress: real("progress").notNull().default(0),
  error: text("error"),
  bookId: text("book_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const mediaCopies = sqliteTable("media_copies", {
  trackId: text("track_id")
    .primaryKey()
    .references(() => tracks.id),
  path: text("path").notNull(),
  size: integer("size").notNull(),
  mime: text("mime").notNull(),
});
export const serverDownloads = sqliteTable("server_downloads", {
  recordingId: text("recording_id")
    .primaryKey()
    .references(() => recordings.id),
  bookId: text("book_id").notNull(),
  status: text("status", { enum: SERVER_COPY_STATUSES }).notNull(),
  progress: real("progress").notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const backupRuns = sqliteTable("backup_runs", {
  /** The scheduled UTC day, YYYY-MM-DD. */
  day: text("day").primaryKey(),
  /** The file name in the backups folder, daily-<day>.db. */
  file: text("file").notNull(),
  status: text("status", { enum: BACKUP_RUN_STATUSES }).notNull(),
  bytes: integer("bytes"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(1),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  /** When the run last renewed its claim (each stage, and every minute while it works); a running row not renewed for 30 minutes is stale. */
  updatedAt: integer("updated_at").notNull(),
  /** SHA-256 (hex) of the verified copy, stored before it is published; with `bytes`, what retention checks before it deletes, and what a retry checks before it adopts a published file. */
  sha256: text("sha256"),
  /** The token of the run that holds the day; only that run may record its result. */
  claim: text("claim"),
  /** Set when the file at `file` is no longer the one this run published: retention leaves it alone for good. */
  disownedAt: integer("disowned_at"),
  /** The retention after this `done` run: `done`, or `failed` with `cleanupError`; null before it ran. */
  cleanup: text("cleanup", { enum: BACKUP_CLEANUP_STATUSES }),
  cleanupError: text("cleanup_error"),
});
export const hardcoverLinks = sqliteTable("hardcover_links", {
  workId: text("work_id")
    .primaryKey()
    .references(() => works.id),
  bookId: integer("book_id").notNull(),
  slug: text("slug"),
  series: text("series", { mode: "json" })
    .$type<{ id?: number; name: string; position: number | null }[]>()
    .notNull()
    .default([]),
  userBookId: integer("user_book_id"),
  statusId: integer("status_id"),
  remoteUpdatedAt: integer("remote_updated_at").notNull().default(0),
  syncedAt: integer("synced_at").notNull().default(0),
});
export const hardcoverOutbox = sqliteTable("hardcover_outbox", {
  bookId: integer("book_id").primaryKey(),
  accountId: integer("account_id").notNull(),
  statusId: integer("status_id").notNull(),
  intent: text("intent").notNull().default("status"),
  updatedAt: integer("updated_at").notNull(),
  error: text("error"),
});
export const hardcoverLists = sqliteTable("hardcover_lists", {
  id: integer("id").primaryKey(),
  accountId: integer("account_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug"),
  members: text("members", { mode: "json" })
    .$type<{ id: number; bookId: number }[]>()
    .notNull()
    .default([]),
  syncedAt: integer("synced_at").notNull(),
});
export const hardcoverProgress = sqliteTable("hardcover_progress", {
  bookId: integer("book_id").primaryKey(),
  accountId: integer("account_id").notNull(),
  recordingId: text("recording_id")
    .notNull()
    .references(() => recordings.id),
  position: real("position").notNull(),
  duration: real("duration").notNull(),
  updatedAt: integer("updated_at").notNull(),
  error: text("error"),
});
export const hardcoverReads = sqliteTable("hardcover_reads", {
  bookId: integer("book_id").primaryKey(),
  accountId: integer("account_id").notNull(),
  snapshot: text("snapshot").notNull(),
  fraction: real("fraction"),
  syncedAt: integer("synced_at").notNull(),
});
export const hardcoverRecordingEditions = sqliteTable(
  "hardcover_recording_editions",
  {
    recordingId: text("recording_id")
      .primaryKey()
      .references(() => recordings.id),
    editionId: integer("edition_id").notNull(),
  },
);

export const users = sqliteTable("users", { id: integer("id").primaryKey(), username: text("username").notNull().unique(), passwordHash: text("password_hash"), role: text("role").notNull(), createdAt: integer("created_at").notNull() });
export const userSettings = sqliteTable("user_settings", { userId: integer("user_id").notNull(), key: text("key").notNull(), value: text("value").notNull() }, t => [primaryKey({ columns: [t.userId, t.key] })]);
export const userLibrary = sqliteTable("user_library", { userId: integer("user_id").notNull(), bookId: text("book_id").notNull(), status: text("status").notNull().default("unread"), addedAt: integer("added_at").notNull() }, t => [primaryKey({ columns: [t.userId, t.bookId] })]);
export const userHiddenLibrary = sqliteTable("user_hidden_library", { userId: integer("user_id").notNull(), bookId: text("book_id").notNull() }, t => [primaryKey({ columns: [t.userId, t.bookId] })]);
export const userProgress = sqliteTable("user_progress", { userId: integer("user_id").notNull(), recordingId: text("recording_id").notNull(), trackId: text("track_id").notNull(), position: real("position").notNull(), duration: real("duration").notNull(), updatedAt: integer("updated_at").notNull() }, t => [primaryKey({ columns: [t.userId, t.recordingId] })]);
export const userEbookProgress = sqliteTable("user_ebook_progress", { userId: integer("user_id").notNull(), editionId: text("edition_id").notNull(), cfi: text("cfi").notNull(), chapter: integer("chapter").notNull(), updatedAt: integer("updated_at").notNull() }, t => [primaryKey({ columns: [t.userId, t.editionId] })]);
export const userReaderCheckpoints = sqliteTable("user_reader_checkpoints", { userId: integer("user_id").notNull(), editionId: text("edition_id").notNull(), data: text("data").notNull() }, t => [primaryKey({ columns: [t.userId, t.editionId] })]);
export const userReaderBookmarks = sqliteTable("user_reader_bookmarks", { userId: integer("user_id").notNull(), id: text("id").notNull(), editionId: text("edition_id").notNull(), label: text("label").notNull(), locator: text("locator").notNull(), createdAt: integer("created_at").notNull() }, t => [primaryKey({ columns: [t.userId, t.id] })]);
export const userReaderEvents = sqliteTable("user_reader_events", { userId: integer("user_id").notNull(), eventId: text("event_id").notNull(), editionId: text("edition_id").notNull() }, t => [primaryKey({ columns: [t.userId, t.eventId] })]);
// The series on AudiobookDB's text ids (#721 part b; the Hardcover tables they replace are `hardcover_<name>`, unused).
export const seriesCatalogue = sqliteTable("series_catalogue", { id: text("id").primaryKey(), name: text("name").notNull(), author: text("author"), bookCount: integer("book_count") });
/** A book of a series: an AudiobookDB book, or (`provider` openlibrary, `book_id` `openlibrary:<work>`) one with no audiobook yet. */
export const seriesCatalogueWorks = sqliteTable("series_catalogue_works", { seriesId: text("series_id").notNull(), bookId: text("book_id").notNull(), workId: text("work_id"), title: text("title").notNull(), position: real("position"), cover: text("cover"), unreleased: integer("unreleased").notNull().default(0), positionLabel: text("position_label"), author: text("author"), provider: text("provider", { enum: ["audiobookdb", "openlibrary"] }).notNull().default("audiobookdb"), language: text("language"), narrators: text("narrators").notNull().default("[]"), lengthMs: integer("length_ms"), releaseDate: text("release_date") }, t => [primaryKey({ columns: [t.seriesId, t.bookId] })]);
export const userSavedSeries = sqliteTable("user_saved_series", { userId: integer("user_id").notNull(), seriesId: text("series_id").notNull(), savedAt: integer("saved_at").notNull(), refreshedAt: integer("refreshed_at"), language: text("language") }, t => [primaryKey({ columns: [t.userId, t.seriesId] })]);
export const userSavedSeriesWorks = sqliteTable("user_saved_series_works", { userId: integer("user_id").notNull(), seriesId: text("series_id").notNull(), bookId: text("book_id").notNull(), workId: text("work_id").notNull(), introduced: integer("introduced").notNull() }, t => [primaryKey({ columns: [t.userId, t.seriesId, t.bookId] })]);
export const userSeriesSeenWorks = sqliteTable("user_series_seen_works", { userId: integer("user_id").notNull(), seriesId: text("series_id").notNull(), bookId: text("book_id").notNull(), acknowledgedAt: integer("acknowledged_at").notNull() }, t => [primaryKey({ columns: [t.userId, t.seriesId, t.bookId] })]);
/** A saved series of the Hardcover tables, to be saved again by its name on AudiobookDB (`server/series-resave.ts`). */
export const seriesResave = sqliteTable("series_resave", { userId: integer("user_id").notNull(), hardcoverSeriesId: integer("hardcover_series_id").notNull(), name: text("name").notNull(), author: text("author"), workIds: text("work_ids").notNull().default("[]"), status: text("status", { enum: ["pending", "saved", "missing", "failed"] }).notNull(), seriesId: text("series_id"), reason: text("reason"), attempts: integer("attempts").notNull().default(0), updatedAt: integer("updated_at").notNull() }, t => [primaryKey({ columns: [t.userId, t.hardcoverSeriesId] })]);
export const seriesAcquisitionJobs = sqliteTable("series_acquisition_jobs", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  seriesId: text("series_id").notNull(),
  bookId: text("book_id").notNull(),
  workId: text("work_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  updatedAt: integer("updated_at").notNull(),
  /** Times a search that could not reach its source was put back in the queue by itself (#717). */
  autoRetries: integer("auto_retries").notNull().default(0),
  /** A search put back by itself waits until then; null for one that may run now. */
  retryAt: integer("retry_at"),
  /** What the audio search found and which one was chosen, as JSON (`server/series-queue.ts`, #898). */
  candidates: text("candidates"),
  /** When the owner moved the job to the front of the queue (Search now, #898); null for the queue's own order. */
  frontAt: integer("front_at"),
  /** 1: a search asked again for a book with its audiobook (or one on its way): it finds, and downloads nothing. */
  searchOnly: integer("search_only").notNull().default(0),
});
export const userWorkCompletion = sqliteTable("user_work_completion", { userId: integer("user_id").notNull(), workId: text("work_id").notNull(), status: text("status").notNull() }, t => [primaryKey({ columns: [t.userId, t.workId] })]);
export const userWorkLibraryOrigin = sqliteTable(
  "user_work_library_origin",
  {
    userId: integer("user_id").notNull(),
    workId: text("work_id").notNull(),
    source: text("source").notNull(),
    /** The Hardcover series of an older row; unused since #721. */
    seriesId: integer("series_id"),
    addedAt: integer("added_at").notNull(),
    /** The AudiobookDB series that brought the work into the library (#721). */
    catalogueSeriesId: text("catalogue_series_id"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workId] })],
);
/** Sonder's own Want to read (#721 part c1), per user and work: "manual" from a Book page or Discover, "hardcover" from the one-time copy of Hardcover's shelf. */
export const userWantToRead = sqliteTable(
  "user_want_to_read",
  {
    userId: integer("user_id").notNull(),
    workId: text("work_id").notNull(),
    source: text("source").notNull(),
    addedAt: integer("added_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workId] })],
);
export const accountRequests = sqliteTable("account_requests", { id: integer("id").primaryKey(), email: text("email").notNull(), username: text("username").notNull(), note: text("note"), status: text("status").notNull().default("pending"), createdAt: integer("created_at").notNull(), reviewedAt: integer("reviewed_at"), inviteId: integer("invite_id") });
export const accountInvites = sqliteTable("account_invites", { id: integer("id").primaryKey(), token: text("token").notNull().unique(), email: text("email").notNull(), username: text("username").notNull(), accountRequestId: integer("account_request_id").notNull(), createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at").notNull(), claimedAt: integer("claimed_at") });

export const userAcquisitions = sqliteTable("user_acquisitions", { userId: integer("user_id").notNull(), acquisitionId: text("acquisition_id").notNull() }, t => [primaryKey({ columns: [t.userId, t.acquisitionId] })]);

export const workMediaStates = sqliteTable(
  "work_media_states",
  {
    userId: integer("user_id").notNull(),
    workId: text("work_id")
      .notNull()
      .references(() => works.id),
    state: text("state").notNull().default("missing"),
    holdReason: text("hold_reason"),
    acquisitionId: text("acquisition_id"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workId] })],
);

export const workEbookSet = sqliteTable("work_ebook_set", {
  workId: text("work_id")
    .primaryKey()
    .references(() => works.id),
  consensusFingerprint: text("consensus_fingerprint"),
  consensusSentences: text("consensus_sentences").notNull().default("[]"),
  projections: text("projections").notNull().default("{}"),
  recordingId: text("recording_id"),
  consensusJobId: text("consensus_job_id"),
  defaultEbookId: text("default_ebook_id"),
  defaultEbookOverride: text("default_ebook_override"),
  updatedAt: integer("updated_at").notNull(),
});

export const workEbookSetMembers = sqliteTable(
  "work_ebook_set_members",
  {
    workId: text("work_id")
      .notNull()
      .references(() => works.id),
    ebookId: text("ebook_id")
      .notNull()
      .references(() => ebookEditions.id),
    status: text("status").notNull(),
    holdReason: text("hold_reason"),
    sourceTitle: text("source_title"),
    sourceAuthor: text("source_author"),
    language: text("language"),
    byteSize: integer("byte_size"),
    evidence: text("evidence").notNull().default("{}"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workId, t.ebookId] })],
);

// Per-user Hardcover account state (#15). The work → Hardcover book match in hardcover_links stays shared.
export const userHardcoverLinks = sqliteTable("user_hardcover_links", { userId: integer("user_id").notNull(), bookId: integer("book_id").notNull(), userBookId: integer("user_book_id"), statusId: integer("status_id"), remoteUpdatedAt: integer("remote_updated_at").notNull().default(0), syncedAt: integer("synced_at").notNull().default(0) }, t => [primaryKey({ columns: [t.userId, t.bookId] })]);
export const userHardcoverOutbox = sqliteTable("user_hardcover_outbox", { userId: integer("user_id").notNull(), bookId: integer("book_id").notNull(), accountId: integer("account_id").notNull(), statusId: integer("status_id").notNull(), intent: text("intent").notNull().default("status"), updatedAt: integer("updated_at").notNull(), error: text("error") }, t => [primaryKey({ columns: [t.userId, t.bookId] })]);
export const userHardcoverReadingOutbox = sqliteTable("user_hardcover_reading_outbox", { userId: integer("user_id").notNull(), bookId: integer("book_id").notNull(), accountId: integer("account_id").notNull(), workId: text("work_id").notNull(), fraction: real("fraction").notNull(), updatedAt: integer("updated_at").notNull(), error: text("error") }, t => [primaryKey({ columns: [t.userId, t.bookId] })]);
export const userHardcoverProgress = sqliteTable("user_hardcover_progress", { userId: integer("user_id").notNull(), bookId: integer("book_id").notNull(), accountId: integer("account_id").notNull(), recordingId: text("recording_id").notNull(), position: real("position").notNull(), duration: real("duration").notNull(), updatedAt: integer("updated_at").notNull(), error: text("error") }, t => [primaryKey({ columns: [t.userId, t.bookId] })]);
export const userHardcoverLists = sqliteTable("user_hardcover_lists", { userId: integer("user_id").notNull(), id: integer("id").notNull(), accountId: integer("account_id").notNull(), name: text("name").notNull(), slug: text("slug"), members: text("members", { mode: "json" }).$type<{ id: number; bookId: number }[]>().notNull().default([]), syncedAt: integer("synced_at").notNull() }, t => [primaryKey({ columns: [t.userId, t.id] })]);
export const userHardcoverReads = sqliteTable("user_hardcover_reads", { userId: integer("user_id").notNull(), bookId: integer("book_id").notNull(), accountId: integer("account_id").notNull(), snapshot: text("snapshot").notNull(), fraction: real("fraction"), syncedAt: integer("synced_at").notNull() }, t => [primaryKey({ columns: [t.userId, t.bookId] })]);
export const userHardcoverRecordingEditions = sqliteTable("user_hardcover_recording_editions", { userId: integer("user_id").notNull(), recordingId: text("recording_id").notNull(), editionId: integer("edition_id").notNull() }, t => [primaryKey({ columns: [t.userId, t.recordingId] })]);
// The catalogue (#721; server/catalogue-cache.ts, server/catalogue-links.ts).
export const catalogueCache = sqliteTable("catalogue_cache", { provider: text("provider").notNull(), kind: text("kind").notNull(), key: text("key").notNull(), data: text("data").notNull(), fetchedAt: integer("fetched_at").notNull(), expiresAt: integer("expires_at").notNull() }, t => [primaryKey({ columns: [t.provider, t.kind, t.key] })]);
export const catalogueUsage = sqliteTable("catalogue_usage", { provider: text("provider").notNull(), day: text("day").notNull(), units: integer("units").notNull().default(0) }, t => [primaryKey({ columns: [t.provider, t.day] })]);
export const workCatalogueLinks = sqliteTable("work_catalogue_links", { workId: text("work_id").primaryKey(), provider: text("provider", { enum: ["audiobookdb", "openlibrary"] }).notNull(), externalId: text("external_id").notNull(), title: text("title").notNull(), author: text("author").notNull(), seriesId: text("series_id"), seriesName: text("series_name"), seriesPosition: text("series_position"), seriesSort: real("series_sort"), matchedBy: text("matched_by", { enum: ["title", "asin", "manual"] }).notNull(), linkedAt: integer("linked_at").notNull() });
export const recordingReleaseLinks = sqliteTable("recording_release_links", { recordingId: text("recording_id").primaryKey(), bookId: text("book_id").notNull(), releaseId: text("release_id").notNull(), narrator: text("narrator"), lengthMs: integer("length_ms"), asin: text("asin"), language: text("language"), chapters: text("chapters").notNull().default("[]"), matchedBy: text("matched_by", { enum: ["asin", "length", "manual"] }).notNull(), linkedAt: integer("linked_at").notNull() });
export const workCatalogueMatch = sqliteTable("work_catalogue_match", { workId: text("work_id").primaryKey(), outcome: text("outcome", { enum: ["matched", "ambiguous", "missing", "failed"] }).notNull(), reason: text("reason"), candidates: integer("candidates").notNull().default(0), checkedAt: integer("checked_at").notNull() });
// Part e: a work's Google Books and iTunes links, beside its main link.
export const workProviderLinks = sqliteTable("work_provider_links", { workId: text("work_id").notNull(), provider: text("provider", { enum: ["googlebooks", "itunes"] }).notNull(), externalId: text("external_id").notNull(), title: text("title").notNull(), author: text("author").notNull(), matchedBy: text("matched_by", { enum: ["manual"] }).notNull().default("manual"), linkedAt: integer("linked_at").notNull() }, t => [primaryKey({ columns: [t.workId, t.provider] })]);
// The book's Edit page (#719 part a): fields edited by hand (JSON values) and the series made by hand.
export const workMetadataOverrides = sqliteTable("work_metadata_overrides", { workId: text("work_id").notNull(), field: text("field").notNull(), value: text("value").notNull(), editedAt: integer("edited_at").notNull(), source: text("source") }, t => [primaryKey({ columns: [t.workId, t.field] })]);
export const recordingMetadataOverrides = sqliteTable("recording_metadata_overrides", { recordingId: text("recording_id").notNull(), field: text("field").notNull(), value: text("value").notNull(), editedAt: integer("edited_at").notNull(), source: text("source") }, t => [primaryKey({ columns: [t.recordingId, t.field] })]);
export const localSeries = sqliteTable("local_series", { id: text("id").primaryKey(), name: text("name").notNull(), createdAt: integer("created_at").notNull() });
// #719 part b: a series' 'Match automatically', one row per work (Activity lists it, with the reason and Retry).
export const metadataMatchJobs = sqliteTable("metadata_match_jobs", { workId: text("work_id").primaryKey(), seriesId: text("series_id").notNull(), userId: integer("user_id").notNull(), status: text("status", { enum: ["pending", "running", "done", "unsure", "failed"] }).notNull(), provider: text("provider"), fields: text("fields").notNull().default("[]"), reason: text("reason"), updatedAt: integer("updated_at").notNull() });
// #754: the other AudiobookDB entries of the same work as the main link, with their release counts.
export const workCatalogueDuplicates = sqliteTable("work_catalogue_duplicates", { workId: text("work_id").notNull(), provider: text("provider", { enum: ["audiobookdb"] }).notNull().default("audiobookdb"), externalId: text("external_id").notNull(), title: text("title").notNull(), author: text("author").notNull(), releases: integer("releases").notNull().default(0), linkedAt: integer("linked_at").notNull() }, t => [primaryKey({ columns: [t.workId, t.provider, t.externalId] })]);
// #889: a preview of a release cached on TorBox (server/torbox-preview.ts). `added`: the best-known fact whether this
// preview put the release on the account; not reliable yet, and nothing acts on it (removal is a later ticket).
export const torboxPreviews = sqliteTable("torbox_previews", { id: text("id").primaryKey(), userId: integer("user_id").notNull(), hash: text("hash").notNull(), torrentId: integer("torrent_id").notNull(), fileId: integer("file_id"), fileName: text("file_name"), added: integer("added", { mode: "boolean" }).notNull(), createdAt: integer("created_at").notNull(), endedAt: integer("ended_at") }, (t) => [index("torbox_previews_hash").on(t.hash)]);
