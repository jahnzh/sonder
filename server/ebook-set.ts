// Ebook set per work: top-k provider downloads, hold until audio, outlier gate, member evidence.
import { and, eq } from "drizzle-orm";
import { statSync, existsSync, unlinkSync } from "node:fs";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { cheapTitleAuthorMatch } from "./ebook-set-filter.ts";
import {
  evaluateOutlierCheck,
  type OutlierCheckResult,
} from "./ebook-set-outlier.ts";
import {
  autoQueueAlignmentsForWork,
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
import { poolEnabled } from "./alignment-pool.ts";
import {
  ProbeLanguageNotSupported,
  type AnchorSampleScore,
} from "./ebook-set-ctc-probe.ts";
import {
  createCtcProbeSession,
  ProbeUnavailable,
  type ProbeSession,
} from "./ebook-set-ctc-session.ts";
import { normalizeReaderText } from "../src/reading-types.ts";
import { ebookEditionId, searchEbooks, saveEbook, type EbookResult, type EbookSource } from "./ebooks.ts";
import { namesLanguage } from "./release-language.ts";
import { publicDomainAge } from "./sources/public-domain.ts";
import { iso3 } from "./language.ts";
import { ebookSetCheckEnded, ebookSetCheckStarted } from "./ebook-set-activity.ts";

export const EBOOK_SET_TOP_K = 5;

/**
 * `pending`: the member is recorded and its evaluation against the narration has not ended yet; the background
 * evaluation (`server/ebook-set-evaluation.ts`) runs it, also after a restart (#325).
 */
export type EbookSetMemberStatus = "pending" | "held" | "accepted" | "rejected";

/**
 * Why a member is held. `awaiting_worker` is re-examined by the background evaluation once a worker is configured;
 * `evaluation_failed` (the evaluation threw, the message is in the evidence) waits for a retry by an administrator.
 */
export type EbookSetHoldReason = "awaiting_audio" | "awaiting_worker" | "language_not_supported" | "evaluation_failed";

export type EbookSetMemberEvidence = {
  sharedSentenceCount: number;
  uniqueSentenceCount: number;
  audioSupportedCoverage: number | null;
  outlier: OutlierCheckResult;
  language: string | null;
  byteSize: number | null;
  /** Why the evaluation failed (`evaluation_failed`). */
  error?: string;
};

export type EbookSetAnchorSample = AnchorSampleScore;

export type EbookSetDeps = {
  search?: typeof searchEbooks;
  save?: typeof saveEbook;
  /** Start a Prowlarr book release's download for the work (#901). */
  startTorrent?: typeof startEbookTorrent;
  anchorSample?: (input: {
    audioPath: string;
    fragmentTexts: string[];
    language: string;
    start: number;
    duration: number;
  }) => Promise<EbookSetAnchorSample>;
  /** CTC probing: how long to wait for a busy pool host, and the sleep between tries (tests). */
  probeWaitMs?: number;
  probeSleep?: (ms: number) => Promise<void>;
  /** Queues the alignment of a member whose check ended (tests: a queueing that fails). */
  queueAlignment?: (workId: string, filter: { ebookId: string }) => Promise<void>;
};

const probeSessionOptions = () => ({ waitMs: deps.probeWaitMs, sleep: deps.probeSleep });

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

/** A sibling's sentences, or null when its EPUB cannot be parsed: one broken sibling never fails another's check. */
async function siblingSentenceSet(ebookId: string) {
  try {
    return await sentenceSet(ebookId);
  } catch (error) {
    console.warn(`Ebook set sibling ${ebookId} is left out of the evidence: ${(error as Error).message}`);
    return null;
  }
}

async function buildEvidence(
  workId: string,
  ebookId: string,
  outlier: OutlierCheckResult,
  language: string | null,
  byteSize: number | null,
): Promise<EbookSetMemberEvidence> {
  // Every sibling that is not rejected, as before, except one whose own check failed (#325 review).
  const members = listEbookSetMembers(workId).filter(
    (m) =>
      m.ebookId !== ebookId &&
      m.status !== "rejected" &&
      !(m.status === "held" && m.holdReason === "evaluation_failed"),
  );
  const mine = await sentenceSet(ebookId);
  const otherSets = (
    await Promise.all(members.map((member) => siblingSentenceSet(member.ebookId)))
  ).filter((set): set is Set<string> => set !== null);
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
      holdReason: row.holdReason as EbookSetHoldReason | null,
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

function dropOrphanEbookEdition(ebookId: string, workId: string) {
  const row = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, ebookId))
    .get();
  if (!row || row.workId !== workId) return;
  if (
    db
      .select()
      .from(s.workEbookSetMembers)
      .where(
        and(
          eq(s.workEbookSetMembers.workId, workId),
          eq(s.workEbookSetMembers.ebookId, ebookId),
        ),
      )
      .get()
  )
    return;
  db.delete(s.ebookEditions).where(eq(s.ebookEditions.id, ebookId)).run();
  if (row.source && existsSync(row.source)) {
    try {
      unlinkSync(row.source);
    } catch {
      /* already gone */
    }
  }
}

function upsertMember(input: {
  workId: string;
  ebookId: string;
  status: EbookSetMemberStatus;
  holdReason?: EbookSetHoldReason | null;
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

/** A member as a check found it when it started: absent, or its status and last update. */
export type EbookSetMemberSnapshot = { status: string; updatedAt: number } | null;

export function ebookSetMemberSnapshot(workId: string, ebookId: string): EbookSetMemberSnapshot {
  return (
    db
      .select({ status: s.workEbookSetMembers.status, updatedAt: s.workEbookSetMembers.updatedAt })
      .from(s.workEbookSetMembers)
      .where(and(eq(s.workEbookSetMembers.workId, workId), eq(s.workEbookSetMembers.ebookId, ebookId)))
      .get() ?? null
  );
}

/** The ebook is linked to the work, and the work exists. */
function ebookLinkedToWork(workId: string, ebookId: string) {
  const ebook = db
    .select({ workId: s.ebookEditions.workId })
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, ebookId))
    .get();
  return ebook?.workId === workId && !!db.select({ id: s.works.id }).from(s.works).where(eq(s.works.id, workId)).get();
}

/**
 * Writes the result of a check only if, in one transaction, the ebook is still linked to the work and the member is
 * still the one the check started for (absent then and now, or the same status and last update). Otherwise the
 * result is dropped and the member stays as it is (#325 review): a relink, a removal or a member added again while
 * the check ran wins over the check. Returns whether the result was written.
 */
function writeMemberResult(input: Parameters<typeof upsertMember>[0], startedFor: EbookSetMemberSnapshot) {
  return sqlite.transaction(() => {
    if (!ebookLinkedToWork(input.workId, input.ebookId)) return false;
    const current = ebookSetMemberSnapshot(input.workId, input.ebookId);
    const same =
      current === null || startedFor === null
        ? current === startedFor
        : current.status === startedFor.status && current.updatedAt === startedFor.updatedAt;
    if (!same) return false;
    upsertMember(input);
    return true;
  })();
}

/**
 * A member whose ebook is no longer linked to its work is skipped by a check; a pending one is removed, in one
 * transaction with the link test, so a set never shows a check that cannot end (#325 review round 2).
 */
function removeUnlinkedPendingMember(workId: string, ebookId: string) {
  sqlite.transaction(() => {
    if (ebookLinkedToWork(workId, ebookId)) return;
    db.delete(s.workEbookSetMembers)
      .where(
        and(
          eq(s.workEbookSetMembers.workId, workId),
          eq(s.workEbookSetMembers.ebookId, ebookId),
          eq(s.workEbookSetMembers.status, "pending"),
        ),
      )
      .run();
  })();
}

/**
 * Queues the alignment of a member whose check ended (accepted, rejected or held), right after its result is
 * written and before the next member's check starts: the only gate is "not while pending", and main's upload
 * queued whatever the check said. `autoQueueAlignmentsForWork` applies its own eligibility, as on main. A failure is
 * logged with the member and never stops the batch. A server stop between the write and the queueing loses this
 * queueing; the backfill picks the ebook up, as on main.
 */
async function queueAlignmentAfterResult(workId: string, ebookId: string) {
  try {
    await (deps.queueAlignment ?? autoQueueAlignmentsForWork)(workId, { ebookId });
  } catch (error) {
    console.warn(`Reading sync for ebook-set member ${ebookId} of ${workId} could not be queued: ${(error as Error).message}`);
  }
}

/** Scores samples using the injected test prober. */
async function injectedScores(
  samples: { audioPath: string; time: number; duration: number }[],
  fragmentTexts: string[],
  language: string,
) {
  const anchorSample = deps.anchorSample!;
  const scores: AnchorSampleScore[] = [];
  for (const sample of samples)
    scores.push(
      await anchorSample({
        audioPath: sample.audioPath,
        fragmentTexts,
        language,
        start: sample.time,
        duration: sample.duration,
      }),
    );
  return scores;
}

export async function runOutlierCheckForEbook(
  workId: string,
  ebookId: string,
  recordingId: string,
  probe?: ProbeSession | null,
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
  // A track whose audio is not on the server cannot be sampled.
  const planned = planSamples(timeline).flatMap((sample) => {
    const track = tracks.find((t) => t.id === sample.trackId);
    const audioPath = track && trackLocalAudioPath(track);
    return audioPath ? [{ ...sample, audioPath }] : [];
  });
  const language = book.language || "eng";
  let scores: AnchorSampleScore[];
  if (iso3(language) !== "eng") throw new ProbeLanguageNotSupported();
  if (deps.anchorSample) {
    scores = await injectedScores(planned, passages, language);
  } else {
    const session = probe ?? createCtcProbeSession(recordingId, probeSessionOptions());
    try {
      scores = await session.score({ fragmentTexts: passages, language: "eng", samples: planned });
    } finally {
      if (!probe) await session.release();
    }
  }
  const samples = planned.map((sample, i) => ({
    trackId: sample.trackId,
    time: sample.time,
    duration: sample.duration,
    done: true,
    spokenWords: scores[i].spokenWords,
    match: scores[i].match,
    ...(scores[i].matches ? { matches: scores[i].matches } : {}),
  }));
  return evaluateOutlierCheck(samples, fragments, timeline, passages);
}

/**
 * Opens one probing session for a run over several candidates of a work, so they share the pool host, the staged
 * audio and the recording's acoustic cache. Returns null when no CTC session applies.
 */
export async function withProbeSession<T>(
  workId: string,
  run: (probe: ProbeSession | null) => Promise<T>,
): Promise<T> {
  const recordingId =
    deps.anchorSample
      ? null
      : firstRecordingWithLocalAudio(workId);
  const session = recordingId ? createCtcProbeSession(recordingId, probeSessionOptions()) : null;
  try {
    return await run(session);
  } finally {
    await session?.release();
  }
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
  probe?: ProbeSession | null,
) {
  // A shared probe session holds the recording lease across candidates; consensus
  // alignment must wait until that session releases (HIGH-1 / ADR 0005 stages).
  // `probe` is null with injected samples, but still means "batch caller".
  const deferSync = probe !== undefined;
  const sync = async () => {
    if (deferSync) return;
    const { syncEbookSetConsensus } = await import("./ebook-set-consensus.ts");
    await syncEbookSetConsensus(workId);
  };
  const startedFor = ebookSetMemberSnapshot(workId, ebookId);
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
    const written = writeMemberResult(
      {
        workId,
        ebookId,
        status: "held",
        holdReason: "awaiting_audio",
        sourceTitle: meta.sourceTitle,
        sourceAuthor: meta.sourceAuthor,
        language: meta.language,
        byteSize,
        evidence,
      },
      startedFor,
    );
    await sync();
    return { status: "held" as const, evidence, written };
  }
  const injected = Boolean(deps.anchorSample);
  const workerReady = ebookSetWorkerConfigured();
  const usesWorker = !injected;
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
  let holdReason: EbookSetHoldReason = "awaiting_worker";
  if (!workerUnavailable) {
    try {
      outlier = await runOutlierCheckForEbook(workId, ebookId, recordingId, probe);
    } catch (error) {
      if (usesWorker) {
        outlier = pendingOutlier;
        workerUnavailable = true;
        // The CTC engine only hears English; a book in another language is neither accepted nor rejected on it.
        if (error instanceof ProbeLanguageNotSupported) holdReason = "language_not_supported";
        else if (!(error instanceof ProbeUnavailable)) console.warn(`Ebook candidate probe failed: ${(error as Error).message}`);
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
    const written = writeMemberResult(
      {
        workId,
        ebookId,
        status: "held",
        holdReason,
        sourceTitle: meta.sourceTitle,
        sourceAuthor: meta.sourceAuthor,
        language: meta.language,
        byteSize,
        evidence,
      },
      startedFor,
    );
    await sync();
    return { status: "held" as const, evidence, written };
  }
  const evidence = await buildEvidence(
    workId,
    ebookId,
    outlier,
    meta.language ?? null,
    byteSize,
  );
  const status: EbookSetMemberStatus = outlier.passed ? "accepted" : "rejected";
  const written = writeMemberResult(
    {
      workId,
      ebookId,
      status,
      holdReason: null,
      sourceTitle: meta.sourceTitle,
      sourceAuthor: meta.sourceAuthor,
      language: meta.language,
      byteSize,
      evidence,
    },
    startedFor,
  );
  const result = { status, evidence, written };
  await sync();
  return result;
}

/** The pool is on and the server holds the worker token: a probe can be tried. */
export function ebookSetWorkerConfigured() {
  return poolEnabled() && Boolean(process.env.ALIGNMENT_WORKER_TOKEN);
}

const noSamples = (): OutlierCheckResult => ({
  passed: false,
  reason: "no_spoken_samples",
  spokenSampleCount: 0,
  matchedSampleCount: 0,
  anchorCount: 0,
  forwardOrder: true,
  samples: [],
});

/**
 * Records an EPUB of a work as a pending member, at once, so a request that adds it never waits for the evaluation
 * (#325). A member that was already accepted or rejected keeps its result: the file is the same (the id is its hash
 * or provider md5), so the evaluation would give the same answer. Returns the member's status, or null for a
 * format that does not join the set.
 */
export function markEbookSetMemberPending(
  workId: string,
  ebookId: string,
  meta: { sourceTitle?: string | null; sourceAuthor?: string | null; language?: string | null } = {},
): EbookSetMemberStatus | null {
  const row = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, ebookId))
    .get();
  if (!row || row.format !== "epub" || row.workId !== workId) return null;
  const existing = listEbookSetMembers(workId).find((member) => member.ebookId === ebookId);
  if (existing && (existing.status === "accepted" || existing.status === "rejected")) return existing.status;
  let byteSize: number | null = null;
  try {
    byteSize = statSync(row.source).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const evidence: EbookSetMemberEvidence = existing?.evidence ?? {
    sharedSentenceCount: 0,
    uniqueSentenceCount: 0,
    audioSupportedCoverage: null,
    outlier: noSamples(),
    language: meta.language ?? null,
    byteSize,
  };
  const updatedAt = Date.now();
  db.insert(s.workEbookSetMembers)
    .values({
      workId,
      ebookId,
      status: "pending",
      holdReason: null,
      sourceTitle: meta.sourceTitle ?? null,
      sourceAuthor: meta.sourceAuthor ?? null,
      language: meta.language ?? null,
      byteSize,
      evidence: JSON.stringify(evidence),
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [s.workEbookSetMembers.workId, s.workEbookSetMembers.ebookId],
      set: { status: "pending", holdReason: null, updatedAt },
    })
    .run();
  return "pending";
}

type ListedMember = ReturnType<typeof listEbookSetMembers>[number];

/**
 * An evaluation that threw: the member is held with the reason, so it neither runs again by itself nor vanishes.
 * The hold follows the rule of every result (it is dropped if the member changed or its ebook moved while it was
 * checked), and it never throws: one member's failure does not stop the checks of the others. Returns whether the
 * hold was written: a written hold is a result like any other, and its alignment is queued after it.
 */
function holdFailedMember(member: ListedMember, error: unknown, startedFor: EbookSetMemberSnapshot) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Ebook set evaluation of ${member.ebookId} failed: ${message}`);
  try {
    const written = writeMemberResult(
      {
        workId: member.workId,
        ebookId: member.ebookId,
        status: "held",
        holdReason: "evaluation_failed",
        evidence: { ...member.evidence, outlier: noSamples(), audioSupportedCoverage: null, error: message },
      },
      startedFor,
    );
    if (!written) console.warn(`Ebook set member ${member.ebookId} changed while it was checked; its failure is not recorded.`);
    return written;
  } catch (writeError) {
    console.warn(`Ebook set failure of ${member.ebookId} could not be recorded: ${(writeError as Error).message}`);
    return false;
  }
}

// One evaluation run per work at a time: the background evaluation and a reevaluate request never probe the same
// members side by side, and a later run starts from the results of the earlier one.
const workRuns = new Map<string, Promise<unknown>>();

function runForWork<T>(workId: string, run: () => Promise<T>): Promise<T> {
  const previous = workRuns.get(workId) ?? Promise.resolve();
  const next = previous.then(run, run);
  workRuns.set(workId, next);
  const forget = () => {
    if (workRuns.get(workId) === next) workRuns.delete(workId);
  };
  next.then(forget, forget);
  return next;
}

/** Tests: forget the runs in progress, as a restarted server has none. */
export function forgetEbookSetRunsForTests() {
  workRuns.clear();
}

/** The results a run wrote, with the member each is for. A result dropped by `writeMemberResult` is left out. */
type MemberResult = Awaited<ReturnType<typeof evaluateEbookSetMember>> & { ebookId: string };

async function evaluateMembers(
  workId: string,
  members: ListedMember[],
  options: {
    /** Whether a member in this status (read again just before its check) is still due. */
    due: (status: EbookSetMemberStatus) => boolean;
    /** Records a check that threw; returns whether it wrote a result for the member. */
    onFailure?: (member: ListedMember, error: unknown, startedFor: EbookSetMemberSnapshot) => boolean;
    /** Read before each member's check: false leaves it and the rest as they are. */
    mayStart?: () => boolean;
    /** Whether a member that started in this status has its alignment queued once its result is written. */
    queueAfterResult?: (startedAs: EbookSetMemberStatus) => boolean;
  },
) {
  const results: MemberResult[] = [];
  try {
    await withProbeSession(workId, async (probe) => {
      for (const member of members) {
        if (options.mayStart && !options.mayStart()) break;
        // The member as it is now: one removed or given a result since the listing is not checked.
        const startedFor = ebookSetMemberSnapshot(workId, member.ebookId);
        if (!startedFor || !options.due(startedFor.status as EbookSetMemberStatus)) continue;
        // One whose ebook is now in another work is skipped, and removed if pending: its check could only fail.
        if (!ebookLinkedToWork(workId, member.ebookId)) {
          removeUnlinkedPendingMember(workId, member.ebookId);
          continue;
        }
        const meta = {
          sourceTitle: member.sourceTitle,
          sourceAuthor: member.sourceAuthor,
          language: member.language,
          byteSize: member.byteSize,
        };
        ebookSetCheckStarted(workId, member.ebookId);
        let queue = false;
        try {
          const result = await evaluateEbookSetMember(workId, member.ebookId, meta, probe);
          if (result.written) results.push({ ...result, ebookId: member.ebookId });
          queue = result.written && !!options.queueAfterResult?.(startedFor.status as EbookSetMemberStatus);
        } catch (error) {
          if (!options.onFailure) throw error;
          const held = options.onFailure(member, error, startedFor);
          queue = held && !!options.queueAfterResult?.(startedFor.status as EbookSetMemberStatus);
        } finally {
          ebookSetCheckEnded(workId, member.ebookId);
        }
        if (queue) await queueAlignmentAfterResult(workId, member.ebookId);
      }
    });
  } finally {
    const { syncEbookSetConsensus } = await import("./ebook-set-consensus.ts");
    await syncEbookSetConsensus(workId);
  }
  return results;
}

/**
 * Runs the evaluation of a work's pending members (the background evaluation). A member whose evaluation throws is
 * held as `evaluation_failed`; one without server audio is held as `awaiting_audio`, as before. `mayStart` is read
 * before each member's check (the pause switches); a member whose ebook is now linked to another work is not
 * checked. Returns the results written, with their member.
 */
export function evaluatePendingEbookSetMembers(workId: string, options: { mayStart?: () => boolean } = {}) {
  return runForWork(workId, async () => {
    if (options.mayStart && !options.mayStart()) return [];
    const members = listEbookSetMembers(workId).filter(
      (member) => member.status === "pending" && ebookLinkedToWork(workId, member.ebookId),
    );
    if (!members.length) return [];
    return evaluateMembers(workId, members, {
      due: (status) => status === "pending",
      onFailure: holdFailedMember,
      mayStart: options.mayStart,
      // No alignment is queued while a member is pending; once its check ends it gets what the upload queued on main.
      queueAfterResult: () => true,
    });
  });
}

/**
 * Evaluates a work's held and pending members again and waits for the results (`POST .../ebook-set/reevaluate`).
 * A member whose ebook is linked to another work is skipped (and removed if pending), so one such member never
 * makes the request fail.
 */
export function reevaluateEbookSetForWork(workId: string) {
  return runForWork(workId, async () => {
    const hasAudio = !!firstRecordingWithLocalAudio(workId);
    // Without server audio a held member would only be held again; a pending one still needs its first result.
    const due = (status: EbookSetMemberStatus) => status === "pending" || (hasAudio && status === "held");
    const members = listEbookSetMembers(workId).filter((member) => due(member.status));
    // With server audio the consensus is synced even when no member needed a new result, as before.
    if (!hasAudio && !members.length) return [];
    // A member moved from pending to its result has its alignment queued as in the loop; a held one checked again
    // queues nothing, as on main.
    const results = await evaluateMembers(workId, members, { due, queueAfterResult: (startedAs) => startedAs === "pending" });
    return results.map(({ status, evidence }) => ({ status, evidence }));
  });
}

/** Which sources are set up in Settings: Anna's Archive's key, Z-Library's account, Prowlarr. */
export type ConfiguredSources = { annas: boolean; zlib: boolean; prowlarr: boolean; mam?: boolean };

/**
 * The sources the series ebook search asks, in order (#901): MyAnonamouse when its session is saved (the owner's order,
 * #911: after a release TorBox has cached, which `fetchTopKIntoEbookSet` takes first), Library Genesis, Anna's Archive
 * and Z-Library when set up, the other Library Genesis family, Prowlarr's book indexers when connected, then Standard
 * Ebooks and Project Gutenberg for a book old enough to be in the public domain.
 */
export function seriesEbookSources(work: { year: number | null }, configured: ConfiguredSources, now = new Date()): EbookSource[] {
  return [
    ...(configured.mam ? (["mam"] as const) : []),
    "libgen",
    ...(configured.annas ? (["annas"] as const) : []),
    ...(configured.zlib ? (["zlib"] as const) : []),
    "libgenrs",
    ...(configured.prowlarr ? (["prowlarr"] as const) : []),
    ...(publicDomainAge(work.year, now) ? (["standardebooks", "gutenberg"] as const) : []),
  ];
}

/**
 * Start the download of a Prowlarr book release for the work (#901), or of a MyAnonamouse one (#911, MAM's own
 * `.torrent`, local client only); its EPUB joins the set when it is complete.
 */
async function startEbookTorrent(file: EbookResult, work: { id: string; title: string; author: string }, userId: number) {
  const [{ prowlarrMagnet }, { acquire }, { mamIdOfEbookKey, mamLink }] = await Promise.all([
    import("./services.ts"),
    import("./acquisitions.ts"),
    import("./sources/myanonamouse.ts"),
  ]);
  const mamId = file.source === "mam" ? mamIdOfEbookKey(file.md5) : null;
  if (file.source === "mam" && !mamId) throw new Error("This MyAnonamouse release could not be found.");
  const job = await acquire(mamId ? mamLink(mamId) : await prowlarrMagnet(`prowlarr-${file.md5}`), {
    kind: "ebook",
    workId: work.id,
    title: work.title,
    author: work.author,
    userId,
  });
  return { id: job.id };
}

/** What a fetch gave: the editions checked, the failures on the way, and a Prowlarr download it started (#901). */
export type EbookSetFetch = {
  downloaded: { id: string; status: EbookSetMemberStatus }[];
  skipped: "limit" | null;
  failures?: string[];
  started?: string | null;
  /** When a source that limited requests on the way may be asked again (the latest such); absent when none did. */
  retryAt?: number | null;
};

export async function fetchTopKIntoEbookSet(
  workId: string,
  source: "libgen" = "libgen",
  options: { sources?: EbookSource[]; userId?: number } = {},
): Promise<EbookSetFetch> {
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
  const startTorrent = deps.startTorrent ?? startEbookTorrent;
  // One edition at a time (#718): the next is fetched only when this one fails the narration check (rejected), or
  // its download or check fails. One accepted or held (no audio or no worker yet: not failed) ends the fetch. Each
  // check has its own probe session, released before the next download, so the pool lease is never held across a
  // LibGen transfer (MEDIUM-1). The sources are asked in order (#901) until one gives that edition; a source that
  // fails (Library Genesis limiting requests) is a failure of its own and the next source is asked.
  const failures: string[] = [];
  const downloaded: { id: string; status: EbookSetMemberStatus }[] = [];
  let started: string | null = null;
  let retryAt: number | null = null;
  // A source's failure, with the time it named to be asked again (one limiting requests).
  const failed = (error: unknown) => {
    failures.push((error as Error).message);
    const at = Number((error as { retryAt?: unknown }).retryAt);
    if (Number.isFinite(at) && at > 0) retryAt = Math.max(retryAt ?? 0, at);
  };
  const found = () => downloaded.some((member) => member.status !== "rejected");
  const sources = options.sources ?? [source];
  // The owner's order (#911): a release TorBox has cached comes first, from any source. Of the series sources only
  // Prowlarr's torrents can be cached, so Prowlarr is asked first; its answer is kept for its own turn, and only a
  // cached release is got before the others.
  const asked = new Map<EbookSource, EbookResult[]>();
  const order: EbookSource[] = sources.includes("prowlarr") && sources[0] !== "prowlarr" ? ["prowlarr", ...sources] : sources;
  let cachedPass = order.length !== sources.length;
  try {
    for (const from of order) {
      if (found() || started || downloaded.length >= remaining) break;
      const onlyCached = cachedPass && from === "prowlarr";
      if (!onlyCached && from === "prowlarr") cachedPass = false;
      let files: EbookResult[];
      try {
        files = asked.get(from) ?? (await search(from, `${work.title} ${work.author}`)).files;
        asked.set(from, files);
      } catch (searchError) {
        // The cached pass is a look ahead: its failure is said in Prowlarr's own turn.
        if (onlyCached) {
          cachedPass = false;
          continue;
        }
        // Only the one source asked: its failure is the fetch's, as before.
        if (!options.sources) throw searchError;
        // The libgen.rs family is often out of reach for good (it did not answer while this was built): that alone does
        // not hold a search in the queue; it is logged, and the next source is asked.
        if (from === "libgenrs" && /could not be reached|did not respond/.test((searchError as Error).message)) {
          console.warn(`ebook search ${workId}: ${(searchError as Error).message}`);
          continue;
        }
        failed(searchError);
        continue;
      }
      const filtered = files.filter(
        (f) =>
          f.extension === "epub" &&
          // A torrent's title names its author (Prowlarr gives no author of its own).
          cheapTitleAuthorMatch(work, { title: f.title, authors: f.authors.length ? f.authors : from === "prowlarr" ? [f.title] : [] }),
      );
      if (onlyCached) {
        cachedPass = false;
        const cached = filtered.find((release) => release.cached);
        if (!cached || earlierEbookTorrent(workId)) continue;
        try {
          started = (await startTorrent(cached, work, options.userId ?? 1)).id;
        } catch (startError) {
          failed(startError);
        }
        continue;
      }
      if (from === "prowlarr" || from === "mam") {
        // A torrent is not checked here: its download is started, and its EPUB joins the set when complete. One
        // torrent download per book (Prowlarr's or MyAnonamouse's): one on its way is waited for; a finished one (its
        // edition was not taken, or the search would not run) is not started again, and the next source is asked.
        const earlier = earlierEbookTorrent(workId);
        if (earlier) {
          if (earlier.status !== "ready") started = earlier.id;
          continue;
        }
        // A MyAnonamouse row names its language: one in another language than the book's is never started (#897).
        const release = from === "mam" ? filtered.find((file) => namesLanguage(file.language, bookLanguage(workId))) : filtered[0];
        if (!release) continue;
        try {
          started = (await startTorrent(release, work, options.userId ?? 1)).id;
        } catch (startError) {
          failed(startError);
        }
        continue;
      }
      for (const file of filtered) {
        if (downloaded.length >= remaining || found()) break;
        const ebookId = ebookEditionId(file);
        const already = db
          .select()
          .from(s.workEbookSetMembers)
          .where(eq(s.workEbookSetMembers.workId, workId))
          .all()
          .some((m) => m.ebookId === ebookId);
        if (already) continue;
        let saved: { id: string };
        try {
          saved = await save({ ...file, workId });
        } catch (saveError) {
          const existingRow = db
            .select()
            .from(s.ebookEditions)
            .where(eq(s.ebookEditions.id, ebookId))
            .get();
          if (!existingRow || existingRow.workId !== workId) {
            failed(saveError);
            continue;
          }
          saved = { id: ebookId };
        }
        let status: EbookSetMemberStatus;
        try {
          status = await withProbeSession(workId, async (probe) =>
            (
              await evaluateEbookSetMember(
                workId,
                saved.id,
                {
                  sourceTitle: file.title,
                  sourceAuthor: file.authors.join(", ") || null,
                  language: file.language,
                },
                probe,
              )
            ).status,
          );
        } catch (evaluateError) {
          failures.push((evaluateError as Error).message);
          dropOrphanEbookEdition(saved.id, workId);
          continue;
        }
        downloaded.push({ id: saved.id, status });
      }
    }
  } finally {
    const { syncEbookSetConsensus } = await import("./ebook-set-consensus.ts");
    await syncEbookSetConsensus(workId);
  }
  return { downloaded, skipped: null, failures, started, retryAt };
}

/** The book's language: its recordings' (the first named), else English. */
function bookLanguage(workId: string) {
  const named = sqlite
    .prepare("SELECT language FROM audio_editions WHERE work_id=? AND language IS NOT NULL AND trim(language) <> '' LIMIT 1")
    .pluck()
    .get(workId) as string | undefined;
  return named ?? "English";
}

/** The book's latest ebook torrent that did not fail: on its way, or finished. */
function earlierEbookTorrent(workId: string) {
  return sqlite
    .prepare(
      `SELECT id, status FROM acquisitions WHERE kind='ebook' AND work_id=? AND status NOT IN ('error','cancelled')
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(workId) as { id: string; status: string } | undefined;
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
