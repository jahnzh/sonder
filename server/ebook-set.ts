// Ebook set per work: top-k provider downloads, hold until audio, outlier gate, member evidence.
import { eq } from "drizzle-orm";
import { statSync } from "node:fs";
import { db } from "./db.ts";
import * as s from "./schema.ts";
import { cheapTitleAuthorMatch } from "./ebook-set-filter.ts";
import {
  evaluateOutlierCheck,
  type OutlierCheckResult,
} from "./ebook-set-outlier.ts";
import {
  firstRecordingWithLocalAudio,
  recordingContext,
  trackLocalAudioPath,
} from "./alignment.ts";
import {
  planSamples,
  wordCount,
  type AnchorFragment,
} from "./alignment-anchors.ts";
import { extractBook } from "./reader.ts";
import { normalizeReaderText } from "../src/reading-types.ts";
import { searchEbooks, saveEbook } from "./ebooks.ts";
import { join } from "node:path";
import { mediaRoot } from "./storage.ts";

const iso3 = (value: string) =>
  value.length === 3 ? value : value.slice(0, 2).toLowerCase() === "en" ? "eng" : value.slice(0, 3).toLowerCase();

async function workerAnchorSample(input: {
  audioPath: string;
  fragmentTexts: string[];
  language: string;
  start: number;
  duration: number;
}): Promise<EbookSetAnchorSample> {
  if (!process.env.ALIGNMENT_WORKER_URL || !process.env.ALIGNMENT_WORKER_TOKEN)
    throw new Error("The local alignment worker is not configured.");
  const response = await fetch(
    `${process.env.ALIGNMENT_WORKER_URL.replace(/\/$/, "")}/anchor`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        token: process.env.ALIGNMENT_WORKER_TOKEN,
        audio: input.audioPath,
        output: join(mediaRoot, "alignment", "ebook-set-anchor.json"),
        fragments: input.fragmentTexts,
        language: iso3(input.language),
        start: input.start,
        duration: input.duration,
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 504
        ? "The alignment worker timed out on this section. Retry later, or choose a release with chapters."
        : "This excerpt could not be matched against the ebook text.",
    );
  const result = (await response.json()) as {
    text?: string;
    start?: number;
    match?: { index: number; score: number } | null;
  };
  return {
    spokenWords: result.text ? wordCount(result.text) : 0,
    match: result.match
      ? {
          fragment: result.match.index,
          score: result.match.score,
          start: result.start ?? input.start,
        }
      : null,
  };
}

export const EBOOK_SET_TOP_K = 5;

export type EbookSetMemberStatus = "held" | "accepted" | "rejected";

export type EbookSetMemberEvidence = {
  sharedSentenceCount: number;
  uniqueSentenceCount: number;
  audioSupportedCoverage: number | null;
  outlier: OutlierCheckResult;
  language: string | null;
  byteSize: number | null;
};

export type EbookSetAnchorSample = {
  spokenWords: number;
  match: { fragment: number; score: number; start: number } | null;
};

export type EbookSetDeps = {
  search?: typeof searchEbooks;
  save?: typeof saveEbook;
  anchorSample?: (input: {
    audioPath: string;
    fragmentTexts: string[];
    language: string;
    start: number;
    duration: number;
  }) => Promise<EbookSetAnchorSample>;
};

let deps: EbookSetDeps = {};

export function setEbookSetDeps(overrides: EbookSetDeps) {
  deps = overrides;
}

export function resetEbookSetDeps() {
  deps = {};
}

function sentenceSet(ebookId: string) {
  return extractBook(ebookId).then((book) => {
    const sentences = new Set<string>();
    for (const section of book.sections)
      for (const paragraph of section.paragraphs) {
        const text = normalizeReaderText(paragraph.text);
        if (text) sentences.add(text);
      }
    return sentences;
  });
}

async function buildEvidence(
  workId: string,
  ebookId: string,
  outlier: OutlierCheckResult,
  language: string | null,
  byteSize: number | null,
): Promise<EbookSetMemberEvidence> {
  const members = listEbookSetMembers(workId).filter(
    (m) => m.ebookId !== ebookId && m.status !== "rejected",
  );
  const mine = await sentenceSet(ebookId);
  const otherSets = await Promise.all(
    members.map((member) => sentenceSet(member.ebookId)),
  );
  let shared = 0;
  for (const sentence of mine) {
    if (otherSets.some((set) => set.has(sentence))) shared++;
  }
  const coverage =
    outlier.spokenSampleCount > 0
      ? outlier.anchorCount / outlier.spokenSampleCount
      : null;
  return {
    sharedSentenceCount: shared,
    uniqueSentenceCount: mine.size - shared,
    audioSupportedCoverage: coverage,
    outlier,
    language,
    byteSize,
  };
}

export function listEbookSetMembers(workId: string) {
  return db
    .select()
    .from(s.workEbookSetMembers)
    .where(eq(s.workEbookSetMembers.workId, workId))
    .all()
    .map((row) => ({
      workId: row.workId,
      ebookId: row.ebookId,
      status: row.status as EbookSetMemberStatus,
      holdReason: row.holdReason,
      sourceTitle: row.sourceTitle,
      sourceAuthor: row.sourceAuthor,
      language: row.language,
      byteSize: row.byteSize,
      evidence: JSON.parse(row.evidence) as EbookSetMemberEvidence,
      updatedAt: row.updatedAt,
    }));
}

export function ebookSetMemberCount(workId: string) {
  return db
    .select()
    .from(s.workEbookSetMembers)
    .where(eq(s.workEbookSetMembers.workId, workId))
    .all().length;
}

function upsertMember(input: {
  workId: string;
  ebookId: string;
  status: EbookSetMemberStatus;
  holdReason?: string | null;
  sourceTitle?: string | null;
  sourceAuthor?: string | null;
  language?: string | null;
  byteSize?: number | null;
  evidence: EbookSetMemberEvidence;
}) {
  const updatedAt = Date.now();
  db.insert(s.workEbookSetMembers)
    .values({
      workId: input.workId,
      ebookId: input.ebookId,
      status: input.status,
      holdReason: input.holdReason ?? null,
      sourceTitle: input.sourceTitle ?? null,
      sourceAuthor: input.sourceAuthor ?? null,
      language: input.language ?? null,
      byteSize: input.byteSize ?? null,
      evidence: JSON.stringify(input.evidence),
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [s.workEbookSetMembers.workId, s.workEbookSetMembers.ebookId],
      set: {
        status: input.status,
        holdReason: input.holdReason ?? null,
        evidence: JSON.stringify(input.evidence),
        updatedAt,
      },
    })
    .run();
}

export async function runOutlierCheckForEbook(
  workId: string,
  ebookId: string,
  recordingId: string,
): Promise<OutlierCheckResult> {
  const book = await extractBook(ebookId);
  const paragraphs = book.sections.flatMap((section) =>
    section.paragraphs.map((paragraph) => ({
      text: paragraph.text,
      section: section.index,
      words: wordCount(paragraph.text),
    })),
  );
  const fragments: AnchorFragment[] = paragraphs.map((p) => ({
    words: p.words,
    section: p.section,
  }));
  const passages = paragraphs.map((p) => p.text);
  const { tracks } = recordingContext(recordingId);
  const timeline = tracks.map((track) => ({
    id: track.id,
    duration: track.duration,
  }));
  const planned = planSamples(timeline);
  const anchorSample = deps.anchorSample ?? workerAnchorSample;
  const samples = [];
  for (const sample of planned) {
    const track = tracks.find((t) => t.id === sample.trackId);
    if (!track) continue;
    const audioPath = trackLocalAudioPath(track);
    if (!audioPath) continue;
    const result = await anchorSample({
      audioPath,
      fragmentTexts: passages,
      language: book.language || "eng",
      start: sample.time,
      duration: sample.duration,
    });
    samples.push({
      ...sample,
      done: true,
      spokenWords: result.spokenWords,
      match: result.match,
    });
  }
  return evaluateOutlierCheck(samples, fragments, timeline, passages);
}

export async function evaluateEbookSetMember(
  workId: string,
  ebookId: string,
  meta: {
    sourceTitle?: string | null;
    sourceAuthor?: string | null;
    language?: string | null;
    byteSize?: number | null;
  } = {},
) {
  const row = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, ebookId))
    .get();
  if (!row || row.workId !== workId)
    throw new Error("This ebook is not linked to the chosen book.");
  let byteSize = meta.byteSize ?? null;
  try {
    byteSize = statSync(row.source).size;
  } catch {
    /* missing file */
  }
  const recordingId = firstRecordingWithLocalAudio(workId);
  if (!recordingId) {
    const outlier: OutlierCheckResult = {
      passed: false,
      reason: "no_spoken_samples",
      spokenSampleCount: 0,
      matchedSampleCount: 0,
      anchorCount: 0,
      forwardOrder: true,
      samples: [],
    };
    const evidence = await buildEvidence(
      workId,
      ebookId,
      outlier,
      meta.language ?? null,
      byteSize,
    );
    upsertMember({
      workId,
      ebookId,
      status: "held",
      holdReason: "awaiting_audio",
      sourceTitle: meta.sourceTitle,
      sourceAuthor: meta.sourceAuthor,
      language: meta.language,
      byteSize,
      evidence,
    });
    const { syncEbookSetConsensus } = await import("./ebook-set-consensus.ts");
    await syncEbookSetConsensus(workId);
    return { status: "held" as const, evidence };
  }
  const workerReady =
    Boolean(process.env.ALIGNMENT_WORKER_URL) &&
    Boolean(process.env.ALIGNMENT_WORKER_TOKEN);
  const usesWorker = !deps.anchorSample;
  const pendingOutlier: OutlierCheckResult = {
    passed: false,
    reason: "no_spoken_samples",
    spokenSampleCount: 0,
    matchedSampleCount: 0,
    anchorCount: 0,
    forwardOrder: true,
    samples: [],
  };
  let outlier = pendingOutlier;
  let workerUnavailable = usesWorker && !workerReady;
  if (!workerUnavailable) {
    try {
      outlier = await runOutlierCheckForEbook(workId, ebookId, recordingId);
    } catch {
      if (usesWorker) {
        outlier = pendingOutlier;
        workerUnavailable = true;
      } else {
        throw new Error("The ebook set outlier check failed.");
      }
    }
  }
  if (workerUnavailable) {
    const evidence = await buildEvidence(
      workId,
      ebookId,
      outlier,
      meta.language ?? null,
      byteSize,
    );
    upsertMember({
      workId,
      ebookId,
      status: "held",
      holdReason: "awaiting_worker",
      sourceTitle: meta.sourceTitle,
      sourceAuthor: meta.sourceAuthor,
      language: meta.language,
      byteSize,
      evidence,
    });
    const { syncEbookSetConsensus } = await import("./ebook-set-consensus.ts");
    await syncEbookSetConsensus(workId);
    return { status: "held" as const, evidence };
  }
  const evidence = await buildEvidence(
    workId,
    ebookId,
    outlier,
    meta.language ?? null,
    byteSize,
  );
  const status: EbookSetMemberStatus = outlier.passed ? "accepted" : "rejected";
  upsertMember({
    workId,
    ebookId,
    status,
    holdReason: null,
    sourceTitle: meta.sourceTitle,
    sourceAuthor: meta.sourceAuthor,
    language: meta.language,
    byteSize,
    evidence,
  });
  const result = { status, evidence };
  const { syncEbookSetConsensus } = await import("./ebook-set-consensus.ts");
  await syncEbookSetConsensus(workId);
  return result;
}

export async function registerUploadedEbookSetMember(
  workId: string,
  ebookId: string,
) {
  const row = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, ebookId))
    .get();
  if (!row || row.format !== "epub") return null;
  return evaluateEbookSetMember(workId, ebookId, { sourceTitle: null });
}

export async function reevaluateEbookSetForWork(workId: string) {
  const members = listEbookSetMembers(workId).filter((m) => m.status === "held");
  if (!firstRecordingWithLocalAudio(workId)) return [];
  const results = [];
  for (const member of members)
    results.push(
      await evaluateEbookSetMember(workId, member.ebookId, {
        sourceTitle: member.sourceTitle,
        sourceAuthor: member.sourceAuthor,
        language: member.language,
        byteSize: member.byteSize,
      }),
    );
  return results;
}

export async function fetchTopKIntoEbookSet(
  workId: string,
  source: "libgen" = "libgen",
) {
  const work = db
    .select()
    .from(s.works)
    .where(eq(s.works.id, workId))
    .get();
  if (!work) throw new Error("The selected book could not be found.");
  const existing = ebookSetMemberCount(workId);
  const remaining = Math.max(0, EBOOK_SET_TOP_K - existing);
  if (!remaining) return { downloaded: [], skipped: "limit" as const };
  const search = deps.search ?? searchEbooks;
  const save = deps.save ?? saveEbook;
  const { files } = await search(source, `${work.title} ${work.author}`);
  const filtered = files.filter(
    (f) =>
      f.extension === "epub" &&
      cheapTitleAuthorMatch(work, { title: f.title, authors: f.authors }),
  );
  const downloaded: { id: string; status: EbookSetMemberStatus }[] = [];
  for (const file of filtered) {
    if (downloaded.length >= remaining) break;
    const already = db
      .select()
      .from(s.workEbookSetMembers)
      .where(eq(s.workEbookSetMembers.workId, workId))
      .all()
      .some((m) => m.ebookId === `${file.source}-${file.md5}`);
    if (already) continue;
    const saved = await save({ ...file, workId });
    const result = await evaluateEbookSetMember(workId, saved.id, {
      sourceTitle: file.title,
      sourceAuthor: file.authors.join(", ") || null,
      language: file.language,
    });
    downloaded.push({ id: saved.id, status: result.status });
  }
  return { downloaded, skipped: null };
}

export function workHasRecording(workId: string) {
  return (
    db
      .select({ id: s.recordings.id })
      .from(s.recordings)
      .innerJoin(s.editions, eq(s.recordings.editionId, s.editions.id))
      .where(eq(s.editions.workId, workId))
      .all().length > 0
  );
}

export function recordingReadyForOutlier(workId: string) {
  return !!firstRecordingWithLocalAudio(workId);
}
