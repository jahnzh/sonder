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
export type AlignmentOutcome = "mapped" | "partial" | "unsynced" | "language_not_supported" | "error";
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
export type AlignmentJob = {
  id: string;
  generation?: string;
  ebookId: string;
  recordingId: string;
  status:
    | "queued"
    | "copying"
    | "processing"
    | "paused"
    | "cancelled"
    | "ready"
    | "partial"
    | "error";
  progress: number;
  engine: string;
  /** Identifies jobs prepared with CTC passage validation. */
  ctcValidationVersion?: 1;
  /** Runtime details for CTC diagnostics; neither changes the map generation. */
  ctcDevice?: string;
  ctcPrecision?: string;
  outcome?: AlignmentOutcome;
  /** Total seconds spent in each worker stage across completed requests. */
  stageTimings?: Record<string, number>;
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
  /** Remote SSH pool dispatch for CTC or full anchored jobs. */
  pool?: {
    hostId: "wsl" | "steamdeck" | "lisa";
    attempt: number;
    jobMediaRoot: string;
    workerUrl: string;
    triedHosts: ("wsl" | "steamdeck" | "lisa")[];
    stagedAudio: Record<string, string>;
  };
  /** Present on summary list responses; full intervals live on /map. */
  intervalCount?: number;
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
