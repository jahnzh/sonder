// Ebook-set consensus text (sentence MSA), one recording alignment, projected member maps.
import { createHash } from "node:crypto";
import { cancelPendingConsensus, ConsensusSupersededError, runConsensusBuild } from "./ebook-set-consensus-runner.ts";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import * as s from "./schema.ts";
import { extractBook } from "./reader.ts";
import { normalizeReaderText } from "../src/reading-types.ts";
import type { AlignmentInterval, AlignmentJob, ReaderBook } from "../src/reading-types.ts";
import {
  firstRecordingWithLocalAudio,
  audioFingerprint,
  alignmentJob,
  createAlignment,
  deleteAlignmentJob,
  listAlignmentJobs,
  putAlignmentJob,
  removeProjectedMapsForWork,
} from "./alignment.ts";
import {
  listEbookSetMembers,
  type EbookSetMemberEvidence,
  type EbookSetMemberStatus,
} from "./ebook-set.ts";

export const CONSENSUS_EBOOK_PREFIX = "set-consensus:";
/** Short spoken lines stay in the consensus; do not apply a four-word minimum. */
export const MIN_CONSENSUS_SENTENCE_WORDS = 1;

import { buildConsensusRows, type MemberSentence } from "./ebook-set-aligner.ts";
export { buildConsensusRows, CONSENSUS_ALIGN_BAND } from "./ebook-set-aligner.ts";
export type { MemberSentence, ConsensusRow } from "./ebook-set-aligner.ts";

export function consensusEbookId(workId: string) {
  return `${CONSENSUS_EBOOK_PREFIX}${workId}`;
}

export function consensusFingerprint(sentences: string[]) {
  return createHash("sha256").update(sentences.join("\n")).digest("hex");
}

export function consensusParagraphId(index: number) {
  return `0:${index}`;
}

export function consensusIndexFromParagraphId(paragraphId: string) {
  const match = /^0:(\d+)$/.exec(paragraphId);
  return match ? Number(match[1]) : null;
}

export function wordCount(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

export function sentencesForMember(
  book: Pick<ReaderBook, "sections">,
): MemberSentence[] {
  const rows: MemberSentence[] = [];
  for (const section of book.sections)
    for (const paragraph of section.paragraphs) {
      const norm = normalizeReaderText(paragraph.text);
      if (!norm || wordCount(norm) < MIN_CONSENSUS_SENTENCE_WORDS) continue;
      rows.push({
        norm,
        text: paragraph.text,
        paragraphId: paragraph.id,
        section: section.index,
      });
    }
  return rows;
}

export function isConsensusEbookId(id: string) {
  return id.startsWith(CONSENSUS_EBOOK_PREFIX);
}

export function pickDefaultEbookId(input: {
  members: {
    ebookId: string;
    status: EbookSetMemberStatus;
    evidence: EbookSetMemberEvidence;
  }[];
  consensusSentenceCount: number;
  override: string | null;
}) {
  const accepted = input.members.filter((member) => member.status === "accepted");
  if (!accepted.length) return null;
  if (
    input.override &&
    accepted.some((member) => member.ebookId === input.override)
  )
    return input.override;
  const ranked = [...accepted].sort((a, b) => {
    const covA = a.evidence.audioSupportedCoverage ?? -1;
    const covB = b.evidence.audioSupportedCoverage ?? -1;
    if (covB !== covA) return covB - covA;
    const fracA = input.consensusSentenceCount
      ? a.evidence.sharedSentenceCount / input.consensusSentenceCount
      : 0;
    const fracB = input.consensusSentenceCount
      ? b.evidence.sharedSentenceCount / input.consensusSentenceCount
      : 0;
    return fracB - fracA;
  });
  return ranked[0]?.ebookId ?? null;
}

export function projectIntervals(
  consensus: AlignmentInterval[],
  projection: (string | null)[],
  memberBook: Pick<ReaderBook, "sections">,
): AlignmentInterval[] {
  const byId = new Map<string, { section: number }>();
  for (const section of memberBook.sections)
    for (const paragraph of section.paragraphs)
      byId.set(paragraph.id, { section: section.index });
  const projected: AlignmentInterval[] = [];
  for (const interval of consensus) {
    const index = consensusIndexFromParagraphId(interval.paragraphId);
    if (index === null) continue;
    const paragraphId = projection[index];
    if (!paragraphId) continue;
    const target = byId.get(paragraphId);
    if (!target) continue;
    projected.push({
      ...interval,
      paragraphId,
      section: target.section,
    });
  }
  return projected;
}

export function consensusReaderBook(
  workId: string,
  sentences: string[],
  language: string,
): Omit<ReaderBook, "checkpoint" | "bookmarks"> {
  const work = db.select().from(s.works).where(eq(s.works.id, workId)).get()!;
  return {
    id: consensusEbookId(workId),
    workId,
    title: work.title,
    author: work.author,
    language,
    fingerprint: consensusFingerprint(sentences),
    sections: [
      {
        index: 0,
        href: "consensus.xhtml",
        title: "Consensus",
        paragraphs: sentences.map((text, index) => ({
          id: consensusParagraphId(index),
          text,
          blockIndex: 0,
          start: 0,
          end: text.length,
        })),
      },
    ],
    toc: [{ label: "Consensus", href: "consensus.xhtml", section: 0 }],
  };
}

type WorkEbookSetState = {
  workId: string;
  consensusFingerprint: string | null;
  consensusSentences: string[];
  projections: Record<string, (string | null)[]>;
  recordingId: string | null;
  consensusJobId: string | null;
  defaultEbookId: string | null;
  defaultEbookOverride: string | null;
  updatedAt: number;
};

function readState(workId: string): WorkEbookSetState | null {
  const row = db
    .select()
    .from(s.workEbookSet)
    .where(eq(s.workEbookSet.workId, workId))
    .get();
  if (!row) return null;
  return {
    workId: row.workId,
    consensusFingerprint: row.consensusFingerprint,
    consensusSentences: JSON.parse(row.consensusSentences) as string[],
    projections: JSON.parse(row.projections) as Record<string, (string | null)[]>,
    recordingId: row.recordingId,
    consensusJobId: row.consensusJobId,
    defaultEbookId: row.defaultEbookId,
    defaultEbookOverride: row.defaultEbookOverride,
    updatedAt: row.updatedAt,
  };
}

function writeState(state: WorkEbookSetState) {
  db.insert(s.workEbookSet)
    .values({
      workId: state.workId,
      consensusFingerprint: state.consensusFingerprint,
      consensusSentences: JSON.stringify(state.consensusSentences),
      projections: JSON.stringify(state.projections),
      recordingId: state.recordingId,
      consensusJobId: state.consensusJobId,
      defaultEbookId: state.defaultEbookId,
      defaultEbookOverride: state.defaultEbookOverride,
      updatedAt: state.updatedAt,
    })
    .onConflictDoUpdate({
      target: s.workEbookSet.workId,
      set: {
        consensusFingerprint: state.consensusFingerprint,
        consensusSentences: JSON.stringify(state.consensusSentences),
        projections: JSON.stringify(state.projections),
        recordingId: state.recordingId,
        consensusJobId: state.consensusJobId,
        defaultEbookId: state.defaultEbookId,
        defaultEbookOverride: state.defaultEbookOverride,
        updatedAt: state.updatedAt,
      },
    })
    .run();
}

function clearState(workId: string) {
  db.delete(s.workEbookSet).where(eq(s.workEbookSet.workId, workId)).run();
  removeProjectedMapsForWork(workId);
}

function ensureConsensusEdition(workId: string) {
  const id = consensusEbookId(workId);
  // Inline consensus text lives in work_ebook_set; keep a virtual edition row for alignment_jobs FK.
  const source = `consensus:${workId}`;
  db.insert(s.ebookEditions)
    .values({
      id,
      workId,
      format: "epub",
      source,
    })
    .onConflictDoUpdate({
      target: s.ebookEditions.id,
      set: { source },
    })
    .run();
}

export function readConsensusSentences(workId: string) {
  return readState(workId)?.consensusSentences ?? [];
}

export function getEbookSetPresentation(workId: string) {
  const members = listEbookSetMembers(workId);
  const state = readState(workId);
  return {
    members,
    defaultEbookId: state?.defaultEbookId ?? null,
    defaultEbookOverride: state?.defaultEbookOverride ?? null,
    consensus: state
      ? {
          fingerprint: state.consensusFingerprint,
          sentenceCount: state.consensusSentences.length,
          jobId: state.consensusJobId,
          recordingId: state.recordingId,
        }
      : null,
  };
}

export function setDefaultEbookOverride(workId: string, ebookId: string | null) {
  const members = listEbookSetMembers(workId);
  if (
    ebookId &&
    !members.some(
      (member) => member.ebookId === ebookId && member.status === "accepted",
    )
  )
    throw new Error("Choose an accepted ebook-set member.");
  const state = readState(workId);
  if (!state) throw new Error("This work has no ebook set consensus yet.");
  const defaultEbookId =
    pickDefaultEbookId({
      members,
      consensusSentenceCount: state.consensusSentences.length,
      override: ebookId,
    }) ?? null;
  writeState({
    ...state,
    defaultEbookOverride: ebookId,
    defaultEbookId,
    updatedAt: Date.now(),
  });
  return getEbookSetPresentation(workId);
}

export async function publishProjectedMaps(workId: string, consensusJob: AlignmentJob) {
  const state = readState(workId);
  if (!state || consensusJob.id !== state.consensusJobId) return;
  if (!["partial", "ready"].includes(consensusJob.status)) return;
  const members = listEbookSetMembers(workId).filter(
    (member) => member.status === "accepted",
  );
  for (const member of members) {
    const projection = state.projections[member.ebookId];
    if (!projection?.length) continue;
    // A prepared (non-projected) map for this release wins over the projection,
    // while it runs and once it maps something. A finished map with no mapped
    // text (for example from a wrong chapter pairing) must not shadow it.
    const prepared = listAlignmentJobs().find(
      (job) =>
        job.ebookId === member.ebookId &&
        job.recordingId === consensusJob.recordingId &&
        job.origin !== "projected" &&
        job.status !== "cancelled" &&
        job.status !== "error" &&
        (["queued", "copying", "processing", "paused"].includes(job.status) || job.coverage > 0),
    );
    if (prepared) continue;
    const memberBook = await extractBook(member.ebookId);
    const intervals = projectIntervals(
      consensusJob.intervals,
      projection,
      memberBook,
    );
    if (!intervals.length) continue;
    // (ebook, recording) is unique: a cancelled or failed prepare of this
    // ebook still holds that slot, and the projection takes its place.
    const projectedId = projectedJobId(workId, member.ebookId, consensusJob.recordingId);
    for (const stale of listAlignmentJobs())
      if (
        stale.ebookId === member.ebookId &&
        stale.recordingId === consensusJob.recordingId &&
        stale.id !== projectedId
      )
        deleteAlignmentJob(stale.id);
    const sectionsDone = [
      ...new Set(intervals.map((interval) => interval.section)),
    ].sort((a, b) => a - b);
    putAlignmentJob({
      id: projectedId,
      generation: consensusJob.generation,
      ebookId: member.ebookId,
      recordingId: consensusJob.recordingId,
      status: consensusJob.status,
      progress: consensusJob.progress,
      engine: consensusJob.engine,
      outcome: consensusJob.outcome,
      stageTimings: consensusJob.stageTimings,
      error: null,
      warning: consensusJob.warning,
      intervals,
      sectionsDone,
      elapsedSeconds: consensusJob.elapsedSeconds,
      fingerprint: memberBook.fingerprint,
      audioFingerprint: consensusJob.audioFingerprint,
      createdAt: consensusJob.createdAt,
      updatedAt: Date.now(),
      coverage: intervals.length / Math.max(1, projection.length),
      pairings: [],
      mode: "anchored",
      origin: "projected",
    });
  }
}

function projectedJobId(workId: string, ebookId: string, recordingId: string) {
  return createHash("sha256")
    .update(`${workId}:${ebookId}:${recordingId}:projected`)
    .digest("hex")
    .slice(0, 32);
}

export async function onConsensusAlignmentFinished(workId: string, job: AlignmentJob) {
  const state = readState(workId);
  if (!state || state.consensusJobId !== job.id) return;
  await publishProjectedMaps(workId, job);
}

const consensusGenerations = new Map<string, symbol>();

export async function syncEbookSetConsensus(workId: string) {
  const generation = Symbol(workId);
  consensusGenerations.set(workId, generation);
  cancelPendingConsensus(workId);
  try {
  const members = listEbookSetMembers(workId);
  const accepted = members.filter((member) => member.status === "accepted");
  if (!accepted.length) {
    clearState(workId);
    return getEbookSetPresentation(workId);
  }
  const recordingId = firstRecordingWithLocalAudio(workId);
  const recordingFingerprint = recordingId ? audioFingerprint(recordingId) : null;
  const books = await Promise.all(accepted.map(member => extractBook(member.ebookId)));
  if (consensusGenerations.get(workId) !== generation) return getEbookSetPresentation(workId);
  const memberLists = books.map(sentencesForMember);
  let rows;
  try { rows = await runConsensusBuild(workId, memberLists); }
  catch (error) {
    if (error instanceof ConsensusSupersededError) return getEbookSetPresentation(workId);
    throw error;
  }
  const stillCurrent = () => consensusGenerations.get(workId) === generation &&
    JSON.stringify(listEbookSetMembers(workId)) === JSON.stringify(members) &&
    firstRecordingWithLocalAudio(workId) === recordingId &&
    (!recordingId || audioFingerprint(recordingId) === recordingFingerprint);
  if (!stillCurrent()) return getEbookSetPresentation(workId);
  const currentBooks = await Promise.all(accepted.map(member => extractBook(member.ebookId)));
  if (!stillCurrent() || currentBooks.some((book, index) => book.fingerprint !== books[index].fingerprint))
    return getEbookSetPresentation(workId);
  const sentences = rows.map((row) => row.text);
  const fingerprint = consensusFingerprint(sentences);
  const projections: Record<string, (string | null)[]> = {};
  for (const [index, member] of accepted.entries())
    projections[member.ebookId] = rows.map(
      (row) => row.memberParagraphIds[index] ?? null,
    );
  const previous = readState(workId);
  const defaultEbookId =
    pickDefaultEbookId({
      members,
      consensusSentenceCount: sentences.length,
      override: previous?.defaultEbookOverride ?? null,
    }) ?? null;
  ensureConsensusEdition(workId);
  const consensusChanged = previous?.consensusFingerprint !== fingerprint;
  const recordingChanged = previous?.recordingId !== recordingId;
  let consensusJobId = previous?.consensusJobId ?? null;
  writeState({
    workId,
    consensusFingerprint: fingerprint,
    consensusSentences: sentences,
    projections,
    recordingId: recordingId ?? null,
    consensusJobId,
    defaultEbookId,
    defaultEbookOverride: previous?.defaultEbookOverride ?? null,
    updatedAt: Date.now(),
  });
  if (recordingId && (consensusChanged || recordingChanged || !consensusJobId)) {
    const job = await createAlignment(
      consensusEbookId(workId),
      recordingId,
      undefined,
      "anchored",
      "backfill",
    );
    if (!stillCurrent()) return getEbookSetPresentation(workId);
    consensusJobId = job.id;
    writeState({
      workId,
      consensusFingerprint: fingerprint,
      consensusSentences: sentences,
      projections,
      recordingId,
      consensusJobId,
      defaultEbookId,
      defaultEbookOverride: previous?.defaultEbookOverride ?? null,
      updatedAt: Date.now(),
    });
  } else if (consensusJobId && !consensusChanged && !recordingChanged) {
    try {
      const job = alignmentJob(consensusJobId);
      await publishProjectedMaps(workId, job);
    } catch {
      /* job missing */
    }
  }
  return getEbookSetPresentation(workId);
  } finally {
    if (consensusGenerations.get(workId) === generation) consensusGenerations.delete(workId);
  }
}
