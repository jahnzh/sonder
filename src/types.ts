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
  /** Every series of the work (its Hardcover book's), the ones the user saved first, then in Hardcover's order. */
  series: WorkSeries[];
  /** The media state of ADR 0011, as `Book.mediaState`; null when the work has none for the user. */
  mediaState: WorkMediaState | null;
  /** As `Book.hardcover` in `GET /api/books`; null when the work has no Hardcover book. */
  hardcover: NonNullable<Book["hardcover"]> | null;
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
};
export type WorkSeries = { id: number | null; name: string; position: number | null; saved: boolean };
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
  narrator: string;
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
  hardcoverConfigured: boolean;
  abbUrl: string;
  name: string;
  authenticated?: boolean;
  libgenUrl: string;
  localConfigured: boolean;
  storageLabel: string;
  prowlarrUrl?: string;
  prowlarrConfigured?: boolean;
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
    | null;
};

export type HardcoverState = {
  configured: boolean;
  mode: "off" | "import" | "two-way";
  syncLists: boolean;
  accountId: number | null;
  username: string | null;
  lastSync: number;
  lastError: string | null;
  listWarning: string | null;
  syncing: boolean;
  pending: number;
  linked: number;
  lists: { id: number; name: string; count: number; slug: string | null }[];
  shelves: { id: number; name: string }[];
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
  | "hardcover"
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
  /** Whose item it is when the page is read by the administrator (one row per user for Hardcover). */
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
  /** The work the item concerns; null for an acquisition with no work yet, a Hardcover queue and a backup (#514). */
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
  | { kind: "hardcover"; status: "waiting" | "failing"; queue: "status" | "listening" | "reading" }
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
