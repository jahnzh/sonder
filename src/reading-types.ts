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
  bookmarks: { id: string; label: string; locator: TextLocator }[];
};
export type AlignmentInterval = {
  paragraphId: string;
  section: number;
  trackId: string;
  start: number;
  end: number;
  confidence: number;
};
export type AlignmentOutcome = "mapped" | "partial" | "unsynced" | "language_not_supported" | "error" | "rejected";
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
   * Listed and /map responses only: the job serves its previous map while this rebuild runs, and the
   * rebuild replaces it when it publishes.
   */
  rebuild?: {
    status: AlignmentJob["status"];
    progress: number;
    engine: string;
    error: string | null;
    outcome?: AlignmentOutcome;
    updatedAt: number;
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
  };
  /** Present on summary list responses; full intervals live on /map. */
  intervalCount?: number;
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
/** The counted blocks of a section: blocks with text that contain no other block, outside skipped elements. */
export function countedBlocks<T extends BlockElement>(root: T, text: (block: T) => string): T[] {
  const blocks = (node: T) =>
    (Array.from(node.querySelectorAll(readerBlockSelector)) as T[]).filter(
      (block) => !block.closest(readerSkippedSelector),
    );
  const all = blocks(root).filter((block) => !blocks(block).length);
  return all.length ? all.filter((block) => normalizeReaderText(text(block))) : [root];
}
