export type TextLocator = {
  cfi?: string;
  section: number;
  paragraphId: string;
  quote?: string;
  progression: number;
};
export type ReadingCheckpoint = {
  locator: TextLocator;
  revision: number;
  updatedAt: number;
  eventId: string;
  deviceId: string;
  recordingId?: string;
  origin: "reading" | "listening";
};
export type ReaderSection = {
  index: number;
  href: string;
  title: string;
  /**
   * How this chapter's blocks are counted, when not by the standard rule: only in a book whose standard blocks hold
   * little of its text (`chapterBlockRule`, ADR 0026). `blockIndex` counts the blocks of this rule.
   */
  blocks?: ReaderBlockRule;
  paragraphs: {
    id: string;
    text: string;
    blockIndex: number;
    start: number;
    end: number;
  }[];
};
export type ReaderBook = {
  id: string;
  workId: string;
  title: string;
  author: string;
  language: string;
  fingerprint: string;
  sections: ReaderSection[];
  toc: { label: string; href: string; section: number }[];
  checkpoint: ReadingCheckpoint | null;
  /** `createdAt`: when it was saved (ms); older servers and cached books have none (#590). */
  bookmarks: { id: string; label: string; locator: TextLocator; createdAt?: number }[];
};
export type AlignmentInterval = {
  paragraphId: string;
  section: number;
  trackId: string;
  start: number;
  end: number;
  confidence: number;
};
/** Every outcome an alignment job can carry. */
export const ALIGNMENT_OUTCOMES = ["mapped", "partial", "unsynced", "language_not_supported", "error", "rejected"] as const;
export type AlignmentOutcome = (typeof ALIGNMENT_OUTCOMES)[number];
export type UnsyncedPassage = {
  section: number;
  title: string;
  firstParagraphId: string;
  lastParagraphId: string;
  sentenceCount: number;
  excerpt: string;
};
export type AlignmentFlag = {
  kind:
    | "intro"
    | "outro"
    | "skipped-text"
    | "extra-audio"
    | "unmatched-text"
    | "unaligned";
  trackId?: string;
  start?: number;
  end?: number;
  section?: number;
  title?: string;
  first?: number;
  last?: number;
};
// Sync for recordings without chapter markers: sampled narration anchors, then
// known-text alignment of the windows between them. Fragment numbers index the
// ebook's paragraphs in reading order.
export type AlignmentAnchoring = {
  stage: "sampling" | "aligning" | "done";
  refinements: number;
  samples: {
    trackId: string;
    time: number;
    duration: number;
    done?: boolean;
    spokenWords?: number;
    match?: { fragment: number; lastFragment?: number; score: number; start: number } | null;
    matches?: { fragment: number; lastFragment?: number; score: number; start: number }[];
  }[];
  anchors: { trackId: string; time: number; fragment: number; lastFragment?: number; score: number }[];
  segments: {
    trackId: string;
    start: number;
    duration: number;
    first: number;
    last: number;
    coreFirst: number;
    coreLast: number;
    done?: boolean;
  }[];
  rate: number;
  flags: AlignmentFlag[];
};
export type AlignmentRunConfig = {
  /** Books the server aligns at the same time. */
  admittedBooks: number;
  residentModelsPerDevice: number;
  /** Microbatch configured on the worker. */
  acousticMicrobatch?: number;
  /** Microbatch after out-of-memory halving; later requests of this job start from it. */
  acousticMicrobatchUsed?: number;
  /** Times the worker halved the microbatch on an out-of-memory error, over the whole job. */
  oomHalvings?: number;
  /** Concurrent CTC path decodes and parallel audio extractions on the worker. */
  decodeWorkers?: number;
  extractWorkers?: number;
};
/** Every status an alignment job can have. Transitions between them live in server/alignment-transitions.ts (ADR 0012). */
export const ALIGNMENT_STATUSES = [
  "queued",
  "copying",
  "processing",
  "paused",
  "cancelled",
  "ready",
  "partial",
  "error",
] as const;
export type AlignmentStatus = (typeof ALIGNMENT_STATUSES)[number];
/**
 * The whole-book engine generation (ADR 0016; book-v2 since #403): a job planned under it runs as one whole-book
 * job on a pool worker (#404). Defined here so the Reading sync card can tell such a job from a window-runner job;
 * the server reads it through `server/alignment-engine.ts`.
 */
export const BOOK_ENGINE = "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2";
/**
 * The pool worker's id for a whole-book job's current generation (#404): `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. A
 * stored `bookJob` with another id belongs to an earlier generation.
 */
export function bookWorkerJobId(job: { id: string; generation?: string }) {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");
  const id = `${safe(job.id).slice(0, 110)}-${safe(job.generation ?? "").replace(/[._-]/g, "").slice(0, 12)}`;
  return /^[A-Za-z0-9]/.test(id) ? id : `j${id.slice(0, 127)}`;
}
/** Waiting for or running on a worker. */
export const ALIGNMENT_ACTIVE_STATUSES = ["queued", "copying", "processing"] as const satisfies readonly AlignmentStatus[];
/** The job waits for or runs on a worker. Takes any string, as stored rows are read without validation. */
export const alignmentJobActive = (status: string | null | undefined) =>
  !!status && (ALIGNMENT_ACTIVE_STATUSES as readonly string[]).includes(status);
/** Active, or paused: the job still has work to finish. */
export const alignmentJobInFlight = (status: string | null | undefined) =>
  alignmentJobActive(status) || status === "paused";
/** Stopped before it finished (paused, failed or cancelled): the Reading sync card offers to resume or retry it. */
export const alignmentJobResumable = (status: string | null | undefined) =>
  status === "paused" || status === "error" || status === "cancelled";
/** A finished map worth serving, also while its rebuild runs. */
export const alignmentMapUsable = (job: { status: string }) => job.status === "ready" || job.status === "partial";
/**
 * A write of this job state publishes it and drops a kept map: a finished map, or an explicit "language not
 * supported" outcome. A failed or cancelled rebuild keeps the old map, and so does a finished or unsupported one
 * that the #379 publish rule refuses (it is stored as rejected before this is asked).
 */
export const alignmentMapPublishes = (job: { status: string; outcome?: string | null }) =>
  alignmentMapUsable(job) || (job.status === "error" && job.outcome === "language_not_supported");
/**
 * The new job's state as a served job lists it under `rebuild` while the row keeps its map in use (#277, #538):
 * the server's listing and the Reading sync card's merge of an action's answer both build it here.
 */
export function rebuildState(working: AlignmentJob): NonNullable<AlignmentJob["rebuild"]> {
  return {
    status: working.status,
    progress: working.progress,
    engine: working.engine,
    error: working.error,
    ...(working.outcome ? { outcome: working.outcome } : {}),
    updatedAt: working.updatedAt,
    ...(working.generation ? { generation: working.generation } : {}),
    ...(working.bookJob ? { bookJob: working.bookJob } : {}),
    ...(working.poolErrors ? { poolErrors: working.poolErrors } : {}),
    coverage: working.coverage,
    elapsedSeconds: working.elapsedSeconds,
    createdAt: working.createdAt,
  };
}
export type AlignmentJob = {
  id: string;
  generation?: string;
  ebookId: string;
  recordingId: string;
  status: AlignmentStatus;
  progress: number;
  engine: string;
  /** Identifies jobs prepared with CTC passage validation. */
  ctcValidationVersion?: 1;
  /** Runtime details for CTC diagnostics; neither changes the map generation. */
  ctcDevice?: string;
  ctcPrecision?: string;
  /**
   * Mean GPU utilization percent (0-100) sampled at 1 Hz on the worker while it
   * was busy for this job. Null when the host has no GPU or never reported one.
   */
  gpuUtilization?: number | null;
  /** Request weights contributing to gpuUtilization (batch size or 1). */
  gpuUtilizationSamples?: number;
  outcome?: AlignmentOutcome;
  /** Total seconds spent in each worker stage across completed requests. */
  stageTimings?: Record<string, number>;
  /**
   * Concurrency settings the job ran with (#276): the scheduler's from the server, the rest as the worker
   * reported them on its latest request. Diagnostics only; none of it changes the map generation.
   */
  runConfig?: AlignmentRunConfig;
  error: string | null;
  warning: string | null;
  intervals: AlignmentInterval[];
  /** Consecutive ebook sentences without a matching narration interval. */
  unsyncedPassages?: UnsyncedPassage[];
  sectionsDone: number[];
  elapsedSeconds: number;
  fingerprint: string;
  audioFingerprint: string;
  updatedAt: number;
  createdAt: number;
  coverage: number;
  pairings: {
    section: number;
    trackId: string;
    start: number;
    duration: number;
  }[];
  mode?: "chapters" | "anchored";
  anchoring?: AlignmentAnchoring;
  /** "backfill" for jobs queued automatically; "projected" for ebook-set maps. */
  origin?: "backfill" | "manual" | "projected";
  /** Set on a job queued automatically to replace a map made by an older engine (#277). */
  rebuildOf?: { engine: string; status: AlignmentJob["status"]; requestedAt: number };
  /**
   * Listed and /map responses only: the job serves its previous map (the map in use) while this new job runs, a
   * rebuild or a Prepare again (#538), and the new job replaces it when it publishes.
   */
  rebuild?: {
    status: AlignmentJob["status"];
    progress: number;
    engine: string;
    error: string | null;
    outcome?: AlignmentOutcome;
    updatedAt: number;
    /**
     * The new job's run, steps and result for the Reading sync page (#538). Older servers omit them; someone who
     * is not the administrator gets `bookJob` without its `hostId` and no `poolErrors`.
     */
    generation?: string;
    bookJob?: Omit<NonNullable<AlignmentJob["bookJob"]>, "hostId"> & { hostId?: AlignmentPoolHostId };
    poolErrors?: AlignmentJob["poolErrors"];
    coverage?: number;
    elapsedSeconds?: number;
    createdAt?: number;
  };
  /** Most recent dispatch failure per remote host, if any. */
  poolErrors?: Partial<Record<AlignmentPoolHostId, string>>;
  /** Remote SSH pool dispatch for CTC or full anchored jobs. */
  pool?: {
    hostId: AlignmentPoolHostId;
    attempt: number;
    jobMediaRoot: string;
    workerUrl: string;
    triedHosts: AlignmentPoolHostId[];
    stagedAudio: Record<string, string>;
    /** Every host the job has staged its tracks on, and the folder there (older rows omit it). */
    stagedHosts?: Record<AlignmentPoolHostId, string>;
  };
  /**
   * The whole-book job this job last started on a pool worker (#404): its id there, the host, and the worker's
   * state when the server last read it. A run of the same generation polls it again instead of starting anew.
   */
  bookJob?: {
    id: string;
    hostId: AlignmentPoolHostId;
    state: string;
    /** Worker restarts the job has continued from. */
    resumed?: number;
    startedAt: number;
    /** The worker's counts for the stage it is in, as last read (#404; older rows omit it). */
    counts?: BookJobCounts;
  };
  /** Present on summary list responses; full intervals live on /map. */
  intervalCount?: number;
};
/**
 * The counts of a whole-book job's progress answer the Reading sync card shows (docs/CTC_WORKER_POOL.md
 * "Progress"); each is present only while the worker reports it.
 */
export type BookJobCounts = {
  tracksTotal?: number;
  tracksDecoded?: number;
  tracksEncoded?: number;
  groupsTotal?: number;
  groupsDone?: number;
  /** While encoding: 0 holds the encoder, 1… waiting behind it. */
  encodeQueuePosition?: number;
  /** While a retained job waits for its turn after a worker restart: 1… */
  resumeQueuePosition?: number;
  /** The encode waits for the worker's window requests. */
  waitingForWindowRequests?: boolean;
};
// A pool host's configured id (ADR 0013): "wsl" and "lisa" by default. "steamdeck" only appears on jobs stored
// before the Steam Deck left the pool (#279).
export type AlignmentPoolHostId = string;
export type AlignmentPoolHostStatus = {
  id: AlignmentPoolHostId;
  sshTarget: string;
  workerUrl: string;
  reachable: boolean;
  device: string | null;
  precision: string | null;
  busy: boolean;
  stuck: boolean;
  activeJobs: number;
  maxConcurrent: number;
  lastError: string | null;
  /** The administrator took the host out of use (#357): it gets no new work; older servers omit it. */
  disabled?: boolean;
  /** The worker's code revision from its `/health`, null when it reports none or cannot be read (#357). */
  revision?: string | null;
  /** What the worker runs now, from its `/health`; null when it could not be read (#357). */
  work?: AlignmentPoolHostWork | null;
};
/** A worker's current work as its `/health` reports it (#357). */
export type AlignmentPoolHostWork = {
  /** Window requests (alignment sections, probes, passage locating) running now. */
  windowRequests: number;
  /** Whole-book jobs the worker holds, and whether one of them is encoding (holds an encode slot). */
  bookJobs: number;
  encoding: boolean;
  /** The worker is picking up its retained whole-book jobs after a start. */
  resuming: boolean;
  /** Stuck requests or whole-book sessions. */
  stuck: number;
};
export type AlignmentPoolStatus = {
  enabled: boolean;
  engine: "ctc";
  checkedAt: number;
  hosts: AlignmentPoolHostStatus[];
};
// A sentence locator's blockIndex counts the "blocks" of a section. The server
// (node-html-parser) and the reader (the browser DOM) count them with this one
// definition, so a fragment's block, start and end point at the same text (#69).
// Changing it re-numbers every block and invalidates saved alignment maps.
export const readerBlockSelector = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption";
/** Elements that are not book text: their blocks and text are never counted. */
export const readerSkippedSelector = "script,style,nav,svg";
export const normalizeReaderText = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim();
/**
 * Where a block's raw text prefix ends in normalizeReaderText(block): leading
 * whitespace is dropped and runs collapse to one space, but a trailing run still
 * counts, so the offset just after a space is the start of the next sentence.
 */
export const readerTextOffset = (prefix: string) =>
  prefix.normalize("NFKC").replace(/\s+/g, " ").trimStart().length;
type BlockElement = {
  querySelectorAll(selector: string): Iterable<unknown> | ArrayLike<unknown>;
  closest(selector: string): unknown;
};
/**
 * The other ways of counting a chapter's blocks (ADR 0026), for a book whose paragraphs are not `<p>` elements:
 * `div` counts a `<div>` as a block too, `body` takes the whole chapter as one block.
 */
export type ReaderBlockRule = "div" | "body";
/** A book whose standard blocks hold less than this share of its text is cut by `chapterBlockRule`. */
export const LOW_SHARE_BOOK = 0.5;
/** In such a book, a chapter uses the first rule whose blocks hold at least this share of the chapter's text. */
export const CHAPTER_SHARE = 0.9;
/**
 * The counted blocks of a section: blocks with text that contain no other block, outside skipped elements. Without
 * a rule this is the standard count, which every book cut before ADR 0026 has and keeps.
 */
export function countedBlocks<T extends BlockElement>(root: T, text: (block: T) => string, rule?: ReaderBlockRule): T[] {
  if (rule === "body") return [root];
  const selector = rule === "div" ? `${readerBlockSelector},div` : readerBlockSelector;
  const blocks = (node: T) =>
    (Array.from(node.querySelectorAll(selector)) as T[]).filter(
      (block) => !block.closest(readerSkippedSelector),
    );
  const all = blocks(root).filter((block) => !blocks(block).length);
  return all.length || rule ? all.filter((block) => normalizeReaderText(text(block))) : [root];
}
/** The share of a chapter's text that its counted blocks hold, from 0 to 1; 1 for a chapter without text. */
export function blockShare<T extends BlockElement>(root: T, text: (block: T) => string, rule?: ReaderBlockRule) {
  const total = normalizeReaderText(text(root)).length;
  if (!total) return 1;
  const held = countedBlocks(root, text, rule).reduce((sum, block) => sum + (block === root ? total : normalizeReaderText(text(block)).length), 0);
  return Math.min(1, held / total);
}
/**
 * The rule for one chapter of a book whose standard blocks hold little of its text: the standard rule where it
 * holds the chapter's text, else with `<div>` as a block, else the whole chapter as one block.
 */
export function chapterBlockRule<T extends BlockElement>(root: T, text: (block: T) => string): ReaderBlockRule | undefined {
  if (blockShare(root, text) >= CHAPTER_SHARE) return undefined;
  return blockShare(root, text, "div") >= CHAPTER_SHARE ? "div" : "body";
}
