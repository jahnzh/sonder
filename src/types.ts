import type { AlignmentJob } from "./reading-types.ts";
export type Track = {
  serverAvailable?: boolean;
  deliverySource?: "server" | "torbox" | "remote";
  chapters?: { title: string; start: number; end?: number }[];
  id: string;
  recordingId: string;
  title: string;
  index: number;
  duration: number;
  source: string;
  sourceType: "local" | "remote" | "torbox";
};
export type Progress = {
  recordingId: string;
  trackId: string;
  position: number;
  duration: number;
  updatedAt: number;
};
export type Book = {
  faults?: Partial<Record<"recording"|"server"|"original",MediaFault>>;
  language?: string | null;
  releaseTitle?: string | null;
  hardcover?: {
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
  id: string;
  workId: string;
  editionId: string;
  recordingId: string;
  title: string;
  author: string;
  narrator: string;
  description: string;
  cover: string;
  genre: string;
  duration: number;
  rating: number;
  year: number;
  tracks: Track[];
  inLibrary: boolean;
  status: "unread" | "listening" | "finished";
  addedAt: number;
  progress?: Progress;
  serverStored: boolean;
  sourceLabel: string;
  mediaState?: {
    state: "missing" | "queued" | "failed" | "available";
    holdReason?: "unreleased" | "empty_search" | null;
    acquisitionId?: string | null;
  } | null;
};
/**
 * One work as the read by work returns it: `GET /api/library` (every work in the user's library)
 * and `GET /api/works/<workId>` (one work, in the library or not), #485, #487, #488. Never holds a
 * placeholder audio edition: a work whose only audio edition is one has no recordings.
 */
export type LibraryWork = {
  workId: string;
  title: string;
  author: string;
  description: string;
  genre: string;
  year: number;
  /** The chosen recording's cover; without one, the placeholder's. */
  cover: string;
  inLibrary: boolean;
  /** The earliest of the user's library rows for the work; null when it is not in the library. */
  addedAt: number | null;
  /** Derived as the series read derives it (ADR 0002); the override, when set, decides. */
  finished: boolean;
  /** The user's override of `finished` (`PATCH /api/works/<workId>/completion`), if any. */
  completionOverride: "finished" | "unread" | null;
  /**
   * See "Chosen recording" in GLOSSARY.md: the user's stored choice (`PUT /api/works/<workId>/recording`)
   * while it is one of `recordings`, otherwise the one with the newest place, otherwise the one added
   * first; null without recordings.
   */
  chosenRecordingId: string | null;
  /** The work's audio editions in the user's library that are not placeholders, the one added first first. */
  recordings: WorkRecording[];
  /** The shared default ebook edition of ADR 0004 (`GET /api/works/<workId>/ebook-set`), when it is one of `ebooks`. */
  chosenEbookId: string | null;
  /** The work's ebook editions, without the consensus text of its ebook set, the one added first first. */
  ebooks: WorkEbook[];
  /**
   * One entry per pair of one of `recordings` and one of `ebooks` that has a reading sync job, in
   * the summary form of `GET /api/alignments?summary=1` without steps, workers and stage times
   * (those stay on the alignment routes). A running rebuild's state is under `rebuild`.
   */
  readingSync: ReadingSyncSummary[];
  /**
   * Every series of the work on AudiobookDB, the ones the user saved first, then by name; when the administrator
   * edited the work's series (#719), that list instead, in its order.
   */
  series: WorkSeries[];
  /** The rest of the work's details (#719 part a), with the fields edited by hand. Absent from an older server. */
  details?: WorkDetails;
  /** The media state of ADR 0011, as `Book.mediaState`; null when the work has none for the user. */
  mediaState: WorkMediaState | null;
  /** As `Book.hardcover` in `GET /api/books`; null when the work has no Hardcover book. */
  hardcover: NonNullable<Book["hardcover"]> | null;
  /**
   * A catalogue book not on the server yet (#721, `work-abdb-<id>` / `work-ol-<id>`): the provider whose answer this
   * is. Absent on a work on the server.
   */
  catalogue?: { provider: "audiobookdb" | "openlibrary"; id: string };
  /** On the user's own Want to read (#721 part c1); absent from a server before it and from works stored by an older build. */
  wantToRead?: boolean;
};
export type WorkEbook = {
  id: string;
  format: string;
  /** In bytes, 0 when the file is not there (as `GET /api/ebooks`). */
  size: number;
  /** The file is there. */
  available: boolean;
  /** Its check against the narration: its ebook-set member's status and hold reason; null when it is not a member. */
  check: {
    status: "pending" | "held" | "accepted" | "rejected";
    holdReason: "awaiting_audio" | "awaiting_worker" | "language_not_supported" | "evaluation_failed" | null;
  } | null;
  /** The user's place, from their reader checkpoint; `origin` is null for one saved before origins were stored. */
  place: { progression: number | null; origin: "reading" | "listening" | null; updatedAt: number } | null;
};
export type ReadingSyncSummary = Omit<
  AlignmentJob,
  | "intervals"
  | "intervalCount"
  | "anchoring"
  | "pairings"
  | "sectionsDone"
  | "pool"
  | "poolErrors"
  | "bookJob"
  | "runConfig"
  | "ctcDevice"
  | "ctcPrecision"
  | "gpuUtilization"
  | "gpuUtilizationSamples"
  | "stageTimings"
  | "elapsedSeconds"
> & { intervalCount: number };
/**
 * One of Discover's works on the server (`GET /api/works`, #573): enough for a result row, which opens
 * the work's Book page (`GET /api/works/<workId>`).
 */
export type WorkResult = {
  workId: string;
  title: string;
  author: string;
  year: number;
  /** As `LibraryWork.cover`: the chosen recording's, otherwise the placeholder's or first audio edition's; "" for none. */
  cover: string;
  /** One of the work's audio editions is in the user's library. */
  inLibrary: boolean;
  /** One of the work's recordings has a track. */
  hasAudiobook: boolean;
  /** The work has an ebook edition; the consensus text of an ebook set is not counted. */
  hasEbook: boolean;
  /** The Hardcover book the work is matched to, if any. */
  hardcoverId: number | null;
  /** On the user's own Want to read (#721 part c1); absent from a server before it. */
  wantToRead?: boolean;
};
/** A series of a work on AudiobookDB (#721): its id, name, number and label ("1.5"), and whether the user saved it. */
/** `local`: a series made by hand on the book's Edit page (#719), id `local-<n>`, not from a provider. */
export type WorkSeries = { id: string | null; name: string; position: number | null; positionLabel?: string | null; saved: boolean; local?: boolean };
/** The fields of the book's Edit page (#719 part a); `narrators` is a recording's. */
export const WORK_FIELDS = ["title", "subtitle", "authors", "series", "genres", "tags", "publisher", "year", "language", "isbn", "asin", "description", "abridged", "explicit", "cover"] as const;
export type WorkField = (typeof WORK_FIELDS)[number];
/** One series of a work as the Edit page writes it: a provider's (`id` from AudiobookDB), or a local one (`id` null for a new one). */
export type SeriesEntry = { id: string | null; name: string; position: number | null; positionLabel: string | null; local: boolean };
/** A work's details beyond `LibraryWork`'s first fields (#719): the edited value where there is one, else the source's. */
export type WorkDetails = {
  subtitle: string;
  authors: string[];
  genres: string[];
  tags: string[];
  publisher: string;
  language: string;
  isbn: string;
  asin: string;
  abridged: boolean | null;
  explicit: boolean | null;
  /** The fields edited by hand: shown as Edited. */
  edited: WorkField[];
};
export type WorkFieldValues = {
  title: string;
  subtitle: string;
  authors: string[];
  series: SeriesEntry[];
  genres: string[];
  tags: string[];
  publisher: string;
  year: number | null;
  language: string;
  isbn: string;
  asin: string;
  description: string;
  abridged: boolean | null;
  explicit: boolean | null;
  cover: string;
};
/** `GET /api/works/<workId>/metadata` (the administrator's): each field's value, the source's value and whether it was edited. */
export type WorkMetadata = {
  workId: string;
  values: WorkFieldValues;
  source: WorkFieldValues;
  edited: WorkField[];
  /** The provider an edited field was taken from by a match (#719 part b); absent for a field edited by hand, and from an older server. */
  from?: Partial<Record<WorkField, MetadataProvider>>;
  recordings: { recordingId: string; label: string; narrators: string[]; source: string[]; edited: boolean; from?: MetadataProvider | null }[];
};
/** The providers a book's details are matched from (#719 part b, #721's four). */
export type MetadataProvider = "audiobookdb" | "openlibrary" | "googlebooks" | "itunes";
/** The fields of the comparison (#719 part b): the work's, and `narrators` (a recording's, one row per recording). */
export const MATCH_FIELDS = ["title", "subtitle", "authors", "series", "genres", "publisher", "year", "language", "isbn", "asin", "description", "cover"] as const satisfies readonly WorkField[];
export type MatchField = (typeof MATCH_FIELDS)[number];
/** One row of the comparison: the value now, the provider's (null when it gives none), and whether it is ticked by default. */
export type MatchRow<T = unknown> = { current: T; found: T | null; ticked: boolean; same: boolean };
/**
 * `GET /api/works/<workId>/metadata/match?provider=&id=` (the administrator's): the per-field comparison of the work
 * with one provider's book. Ticked by default: the fields the work has no value for and the provider has.
 */
export type MetadataComparison = {
  workId: string;
  provider: MetadataProvider;
  id: string;
  title: string;
  fields: Record<MatchField, MatchRow>;
  recordings: ({ recordingId: string; label: string } & MatchRow<string[]>)[];
};
/** What `POST /api/works/<workId>/metadata/match` and `/metadata/auto` wrote (or why nothing). */
export type MetadataApplied = {
  outcome: "applied" | "nothing" | "unsure" | "missing" | "failed";
  provider: MetadataProvider | null;
  fields: string[];
  reason: string | null;
  metadata: WorkMetadata | null;
};
export type WorkMediaState = {
  state: "missing" | "queued" | "failed" | "available";
  holdReason: "unreleased" | "empty_search" | null;
  /**
   * The acquisition behind a queued or failed state. Its status, progress and error are shown to
   * the administrator only, as `/api/acquisitions` is; for anyone else they are null.
   */
  acquisition: { id: string; status: string | null; progress: number | null; error: string | null } | null;
};
export type WorkRecording = {
  recordingId: string;
  editionId: string;
  /** The narrators joined with ", " (the edited ones when the administrator edited them, #719). */
  narrator: string;
  /** The narrators one by one (#719); absent from an older server. */
  narrators?: string[];
  /** Whether the narrators were edited by hand (#719). */
  narratorsEdited?: boolean;
  language: string | null;
  releaseTitle: string | null;
  sourceLabel: string;
  cover: string;
  duration: number;
  /** With chapters and where each is available from, as in `Book.tracks`. */
  tracks: Track[];
  /** Every track is on the server. */
  serverStored: boolean;
  faults: NonNullable<Book["faults"]>;
  /** The user's place. */
  progress: Progress | null;
  /**
   * A copy to the server that has not finished. Always null for a reader who is not the
   * administrator: the copy queue is the administrator's (`/api/acquisitions`, `/api/activity`).
   */
  serverCopy: { status: "queued" | "downloading" | "paused" | "error"; progress: number; error: string | null } | null;
};
export type MediaFault={reason:"wrong-language"|"wrong-book"|"bad-audio"|"incomplete"|"other";note:string;updatedAt:number};
export type PlaybackSourceChoice="auto"|"device"|"server"|"original";
export type RecordingSources={recordingId:string;faults:NonNullable<Book['faults']>;managedCopies:number;serverFiles:number;originalFiles:number;tracks:{id:string;server:boolean;original:boolean}[]};
export type Download = {
  recordingId: string;
  trackId: string;
  name: string;
  size: number;
  storage: "opfs" | "idb" | "chunks";
  completedAt: number;
  mime?: string;
  blob?: Blob;
};
export type DownloadPart = {
  trackId: string;
  recordingId: string;
  loaded: number;
  total: number;
  mime: string;
  version: string | null;
};
export type Settings = {
  torboxConfigured: boolean;
  /** A Hardcover token is stored: never after the switch from Hardcover (#721 part d); kept for older builds. */
  hardcoverConfigured?: boolean;
  abbUrl: string;
  name: string;
  authenticated?: boolean;
  libgenUrl: string;
  localConfigured: boolean;
  storageLabel: string;
  prowlarrUrl?: string;
  prowlarrConfigured?: boolean;
  /** AudiobookDB (#721), for the administrator: a key is set, and whether it is the server's file or Settings. */
  audiobookdbConfigured?: boolean;
  audiobookdbSource?: "env" | "settings" | null;
  /** The media drive, for the administrator (spec #572, "Server storage"); absent from servers that predate it. */
  storage?: { connected: boolean; usedBytes: number | null; totalBytes: number | null } | null;
};

export type Acquisition = {
  workId?: string | null;
  language?: string | null;
  narrator?: string | null;
  id: string;
  hash: string;
  backend: "local" | "torbox" | "copy";
  title: string;
  author: string;
  cover: string;
  status:
    | "checking"
    | "preparing"
    | "downloading"
    | "paused"
    | "ready"
    | "error";
  progress: number;
  error: string | null;
  bookId: string | null;
  createdAt: number;
  updatedAt: number;
};
export type AudiobookRelease = {
  id: string;
  title: string;
  author: string;
  cover?: string;
  url: string;
  language: string | null;
  narrator: string | null;
  format: string | null;
  bitrate: string | null;
  size: string | null;
  posted: string | null;
  uploader: string | null;
  description: string;
  // Absent on AudioBookBay releases from older servers.
  source?: "abb" | "prowlarr";
  indexer?: string | null;
  indexers?: string[];
  seeders?: number | null;
  leechers?: number | null;
  sizeBytes?: number | null;
  infoHash?: string | null;
  cached?: boolean;
};
export type ReleaseSourceStatus = {
  source: "abb" | "prowlarr";
  label: string;
  error?: string;
};
export type EbookResult = {
  md5: string;
  source: "libgen";
  title: string;
  authors: string[];
  extension: "epub" | "pdf";
  language: string | null;
  size: string | null;
  year: string | null;
  coverUrl: string | null;
  url: string;
};
export type SavedEbook = {
  id: string;
  workId: string;
  title: string;
  author: string;
  format: string;
  size: number;
  available: boolean;
};

export type AcquisitionStatus =
  | "pending"
  | "searching"
  | "done"
  | "failed"
  | "skipped";

export type SeriesWorkAcquisition = {
  kind: "audio" | "ebook";
  status: AcquisitionStatus;
  error?: string | null;
  skipReason?:
    | "unreleased"
    | "has_audio"
    | "has_ebook"
    | "no_permission"
    /** The owner's Skip, and Stop searching for the series (#898). */
    | "owner"
    | "stopped"
    | null;
  /** A waiting search's place in the series queue (1 is the search running now), #898; absent from an older server. */
  place?: number | null;
  /** A waiting search the queue put back by itself, after its source could not be reached. */
  retrying?: boolean;
  /** How many releases the audio search found; null before it kept any. */
  found?: number | null;
  /** The audio search picked one and asked for its download. */
  chosen?: boolean;
};

export type TorrentHealth = {
  status: "ok" | "offline" | "unreachable" | "auth" | "error" | "unconfigured";
  // RPC answered with a valid session.
  session: boolean;
  // Outcome of Transmission's port test, which needs working DNS and egress through the VPN.
  network: "ok" | "port-closed" | "failed" | "unknown";
  version: string | null;
  message: string;
  checkedAt: number;
};

// Activity page (#357): one row per unit of background work, grouped under the background process that produces it.
export type ActivityKind =
  | "acquisition"
  | "server-copy"
  | "series-acquisition"
  | "alignment"
  | "ebook-set"
  | "backup";
export type ActivityState = "running" | "queued" | "paused" | "failed" | "done";
/**
 * An item's action, sent to `/api/activity/items/<action>`: Retry after a failure, Resume after a pause, Discard, and
 * Cancel of a stuck or failing download (#716).
 */
export type ActivityItemAction = "retry" | "discard" | "resume" | "cancel";
export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  processId: string;
  title: string;
  detail: string | null;
  /** Whose item it is when the page is read by the administrator (an item a user owns). */
  user: string | null;
  state: ActivityState;
  /** 0 to 1, or null when the kind has no measurable progress. */
  progress: number | null;
  host: string | null;
  startedAt: number | null;
  updatedAt: number;
  error: string | null;
  /** A failed item that cannot succeed on retry: it is offered Discard, not Retry. */
  permanent: boolean;
  /** What the administrator can do with this item now. An older client ignores an action it does not know (#515). */
  actions: ActivityItemAction[];
  /**
   * Why the item does not move. `known` is set when the source named the cause (#716: "No peers", from the torrent
   * client) rather than "No change for …" or "Blocked by …"; Now then leads the line with it, so a narrow row shows it.
   */
  stuck: { reason: string; known?: true } | null;
  /** The background process this item cannot move without, while that process is down. */
  blockedBy: string | null;
  /** The work the item concerns; null for an acquisition with no work yet and a backup (#514). */
  workId: string | null;
  /** The audio edition of the work's chosen recording; null when it has none, and never a placeholder's (#514). */
  bookId: string | null;
  /**
   * The work's cover by the rule of the library by work: the chosen recording's, otherwise the placeholder's. An
   * acquisition with no work yet has its own; a Hardcover queue and a backup have none (#514).
   */
  cover: string | null;
  /** What the item's status line is written from, by kind (#514). */
  facts: ActivityFacts;
  /**
   * The item failed in the last seven days, is stuck or is blocked. The one place this is decided for server work
   * (`buildActivity`); `ActivityResponse.attention` counts these plus the processes that are down (#514).
   */
  attention: boolean;
  /**
   * A download that made no progress while its work already has a ready copy from another download (#716): not
   * stuck and not needing attention, but it offers Cancel and Now says "This book already has a copy". Absent
   * otherwise; an older client ignores it.
   */
  superseded?: true;
};
/**
 * The facts of an item's status line (#514), one shape per kind: the feature's own status word as it is stored (a
 * word outside the vocabulary is possible for an old row or a newer server; its line is then null) and, where the
 * kind has them, the rest of what the line is written from. `kind` is the item's.
 */
export type ActivityFacts =
  /** A download: where it is fetched (`local`, `torbox`, `copy`; null when the row has none). */
  | { kind: "acquisition"; status: string; backend: string | null }
  | { kind: "server-copy"; status: string }
  /** A series search for the audiobook or for the ebook of a work. */
  | {
      kind: "series-acquisition";
      status: string;
      search: "audiobook" | "ebook";
      /**
       * A waiting search's place in the one-at-a-time queue (#717): 1 is the search running now, so the first waiting
       * one is 2 while a search runs. Null for one not waiting, or one that waits to try a source again (`retryAt`).
       */
      place?: number | null;
      /** A search put back in the queue by itself after its source could not be reached waits until then; else null. */
      retryAt?: number | null;
      /**
       * Not a search: a saved series of the Hardcover tables saved again on AudiobookDB (#721 part b). The title is
       * the series name and the error the reason; an older client reads it as a failed audiobook search.
       */
      saveAgain?: true;
      /**
       * Not a search: a book of a series' 'Match automatically' (#719 part b). `status` is the row's own (`pending`,
       * `running`, `done`, `unsure`, `failed`); the error is the reason. An older client reads it as a series search.
       */
      metadataMatch?: true;
      /** The saved series and its book the search is for (#898): the row opens the Series page at the book. */
      seriesId?: string;
      seriesBookId?: string;
      /** The owner's Skip or Stop searching on the Series page (#898); absent for the queue's own outcomes. */
      outcome?: "skipped" | "stopped";
    }
  | {
      kind: "alignment";
      status: string;
      /** The job's outcome (`mapped`, `partial`, `unsynced`, `rejected`, …); null while it has none. */
      outcome: string | null;
      /** 0 to 1: the share of the ebook's sentences found in the narration; null when the record has none. */
      coverage: number | null;
      /** A whole-book job, which reports a stage; false for a job of the older engine. */
      wholeBook: boolean;
      /** The worker's stage of this run (`decoding`, `encoding`, …); null until the worker has reported one. */
      stage: string | null;
      /** The worker's file counts for a stage that counts files (decoding, encoding); null otherwise. */
      files: { done: number; total: number } | null;
      /** The job's EPUB is a spare edition: not the work's chosen one and nobody has a place in it (#718). */
      spare?: boolean;
      /** Queued by itself (the backfill, an ebook-set check, new audio), not by a Prepare (#718). */
      background?: boolean;
    }
  /** An ebook's check against the narration: the member's status, with the reason it is held when it is. */
  | { kind: "ebook-set"; status: string; holdReason: string | null }
  | { kind: "backup"; status: string };
export type ActivityHealth = "ok" | "degraded" | "down" | "unknown";
export type ActivityProcess = {
  id: string;
  label: string;
  type: "loop" | "service";
  health: ActivityHealth;
  reason: string | null;
  /** When the current health began, if known. */
  since: number | null;
  /** True for a process the app does not track yet (imports). */
  notTracked: boolean;
  /** The loop can be paused from the page (the services and untracked processes cannot). */
  pausable: boolean;
  paused: boolean;
  /** Why the switch cannot be used: an environment flag disables the loop for good. */
  lockedBy: "environment" | null;
  /** What pausing does and does not stop, in plain words. */
  pauseEffect: string | null;
  counts: { running: number; queued: number; failed: number; stuck: number };
  /** An alignment worker host's row (#357): status, code version, current job, restart and the disable switch. */
  host?: ActivityWorkerHost;
};
/** The last restart of a worker host from the page, as the server remembers it until it restarts itself. */
export type ActivityHostRestart = { at: number; ok: boolean; forced: boolean; message: string };
export type ActivityWorkerHost = {
  hostId: string;
  device: string | null;
  /** The worker answers `/health` and SSH. */
  online: boolean;
  /** Disabled by the administrator: the pool gives it no new work; work running there finishes. */
  disabled: boolean;
  /** The worker's code revision; null when it reports none (shown as unknown). */
  revision: string | null;
  /** What the worker runs now, from its `/health` ("1 whole-book job, encoding"); null when idle or not read. */
  work: string | null;
  /** Titles of the alignment jobs Sonder runs on it now. */
  jobs: string[];
  restarting: boolean;
  lastRestart: ActivityHostRestart | null;
};
export type ActivityResponse = {
  checkedAt: number;
  stuckMultiplier: number;
  processes: ActivityProcess[];
  items: ActivityItem[];
  /** Number of items with `attention` plus down processes: drives the indicator on Settings. */
  attention: number;
};
/** A chapter of a whole recording (#719 part c): its start in seconds from the recording's beginning, over its files. */
export type RecordingChapter = { title: string; start: number };
/** Chapters found for a recording (#719 part c): from its linked AudiobookDB release or by an ASIN. */
export type ChapterLookup = {
  from: "release" | "asin";
  releaseId: string;
  asin: string | null;
  /** The release's length, null when AudiobookDB gives none. */
  lengthMs: number | null;
  chapters: RecordingChapter[];
  /** Whether the release's length agrees with the recording's within `CHAPTER_LENGTH_TOLERANCE_S`: only then are they taken. */
  agrees: boolean;
  /** Why they are not taken; null when they agree. */
  reason: string | null;
};
/** A recording's chapters on the Edit page (#719 part c), the administrator's. */
export type RecordingChapters = {
  recordingId: string;
  workId: string;
  label: string;
  /** The recording's length in seconds over all its files; 0 while a file's length is not known. */
  duration: number;
  /** Whether every file's length is known, so chapters can be placed over the files. */
  lengthKnown: boolean;
  /** The chapters shown: the edited ones, or the files'. */
  chapters: RecordingChapter[];
  /** The files' own chapters (one per file without any). */
  source: RecordingChapter[];
  edited: boolean;
  /** The provider the edited chapters were looked up from; null when edited by hand or not edited. */
  from: "audiobookdb" | null;
  /** The linked AudiobookDB release, whose chapters 'Look up chapters' reads first. */
  release: { releaseId: string; asin: string | null; lengthMs: number | null } | null;
  /** The ASIN 'Look up chapters' takes when there is no linked release: the work's (edited or the link's). */
  asin: string | null;
};

/**
 * The sample books (#763): `public/covers/<id>.svg` is the art of the seeded book whose edition id is `<id>`
 * (server/seed.ts). Older server builds stored one of them as the fallback of an edition without a cover of its own.
 */
export const SAMPLE_COVER_BOOKS = ["alice", "sherlock", "pride", "frankenstein", "time", "meditations", "gatsby", "war"] as const;
const SAMPLE_COVER = /^\/covers\/([a-z0-9-]+)\.svg$/;

/** A sample book's cover held by another edition: read as no cover (#763). */
export function isSampleCoverOfAnother(cover: string | null | undefined, editionId: string | null | undefined): boolean {
  const name = SAMPLE_COVER.exec(cover ?? "")?.[1];
  return !!name && (SAMPLE_COVER_BOOKS as readonly string[]).includes(name) && name !== editionId;
}

/** The edition's own cover: "" for none, and for a sample book's cover stored for another edition (#763). */
export function ownCover(cover: string | null | undefined, editionId: string | null | undefined): string {
  return !cover || isSampleCoverOfAnother(cover, editionId) ? "" : cover;
}
