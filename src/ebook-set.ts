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
