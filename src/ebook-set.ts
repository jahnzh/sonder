export type EbookSetMember = {
  ebookId: string;
  status: "held" | "accepted" | "rejected";
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
  return "Held";
}
