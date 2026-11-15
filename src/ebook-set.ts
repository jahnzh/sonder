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

export type EbookSetView = {
  members: EbookSetMember[];
  defaultEbookId: string | null;
  defaultEbookOverride: string | null;
  consensus: {
    fingerprint: string | null;
    sentenceCount: number;
    jobId: string | null;
    recordingId: string | null;
  } | null;
};

export function ebookSetStatusLabel(status: EbookSetMember["status"]) {
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  if (status === "pending") return "Checking";
  return "Held";
}

/** While a member is being checked the list is read again this often, so its result shows without a reload. */
export const EBOOK_SET_PENDING_REFRESH_MS = 15_000;

export function ebookSetHasPendingMember(members: Pick<EbookSetMember, "status">[]) {
  return members.some((member) => member.status === "pending");
}

/** The note added to the "saved" message when the new ebook is still being checked against the narration. */
export function checkingNote(ebookSet: { status: EbookSetMember["status"] } | undefined) {
  return ebookSet?.status === "pending" ? " Checking it against the narration." : "";
}
