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
  verified?: boolean;
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
    match?: { fragment: number; score: number; start: number } | null;
  }[];
  anchors: { trackId: string; time: number; fragment: number; score: number }[];
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
  error: string | null;
  warning: string | null;
  intervals: AlignmentInterval[];
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
  /** Present on summary list responses; full intervals live on /map. */
  intervalCount?: number;
  unverifiedCount?: number;
};
