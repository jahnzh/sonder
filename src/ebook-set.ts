export type EbookSetMember = {
  ebookId: string;
  /** `pending`: the check against the narration is still running on the server. */
  status: "pending" | "held" | "accepted" | "rejected";
  holdReason?: string | null;
  sourceTitle?: string | null;
  language?: string | null;
  byteSize?: number | null;
  evidence: {
    sharedSentenceCount: number;
    uniqueSentenceCount: number;
    audioSupportedCoverage: number | null;
    outlier: { passed: boolean; reason: string; samples: { passage: string | null }[] };
  };
};

/** The note added to the "saved" message when the new ebook is still being checked against the narration. */
export function checkingNote(ebookSet: { status: EbookSetMember["status"] } | undefined) {
  return ebookSet?.status === "pending" ? " Checking it against the narration." : "";
}

/** A work's ebook-set counts in the series view; `pending` is absent from an older server. */
export type SeriesEbookSetCounts = { held: number; accepted: number; rejected: number; pending?: number };

/** The series view's ebook label from the set counts, or null when the set has no member. */
export function seriesEbookSetLabel(ebookSet: SeriesEbookSetCounts | null | undefined) {
  if (ebookSet?.pending) return ebookSet.accepted ? `${ebookSet.accepted} accepted · Checking` : "Checking";
  if (ebookSet?.accepted) return `${ebookSet.accepted} accepted`;
  if (ebookSet?.held) return `${ebookSet.held} held for review`;
  if (ebookSet?.rejected) return "Candidates rejected";
  return null;
}
