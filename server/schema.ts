import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";
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
});
export const recordings = sqliteTable("recordings", {
  id: text("id").primaryKey(),
  editionId: text("edition_id")
    .notNull()
    .references(() => editions.id),
});
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
});
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
  status: text("status").notNull(),
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
  status: text("status").notNull(),
  progress: real("progress").notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const hardcoverLinks = sqliteTable("hardcover_links", {
  workId: text("work_id")
    .primaryKey()
    .references(() => works.id),
  bookId: integer("book_id").notNull(),
  slug: text("slug"),
  series: text("series", { mode: "json" })
    .$type<{ name: string; position: number | null }[]>()
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
