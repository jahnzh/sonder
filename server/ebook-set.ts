// Ebook set per work: top-k provider downloads, hold until audio, outlier gate, member evidence.
import { and, eq } from "drizzle-orm";
import { statSync, existsSync, unlinkSync } from "node:fs";
import { db } from "./db.ts";
import * as s from "./schema.ts";
import { cheapTitleAuthorMatch } from "./ebook-set-filter.ts";
import {
  evaluateOutlierCheck,
  type OutlierCheckResult,
} from "./ebook-set-outlier.ts";
import {
  listAlignmentJobs,
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
  sampleFromWhisperAnchor,
  type AnchorSampleScore,
} from "./ebook-set-ctc-probe.ts";
import {
  createCtcProbeSession,
  ProbeUnavailable,
  type ProbeSession,
} from "./ebook-set-ctc-session.ts";
import { normalizeReaderText } from "../src/reading-types.ts";
import { searchEbooks, saveEbook } from "./ebooks.ts";
import { join } from "node:path";
import { mediaRoot } from "./storage.ts";

const iso3 = (value: string) =>
  value.length === 3 ? value : value.slice(0, 2).toLowerCase() === "en" ? "eng" : value.slice(0, 3).toLowerCase();

/**
 * Which prober scores a candidate's audio samples. CTC is the ADR 0006 prober; Whisper stays selectable until
 * its code is removed (#279), then this setting and the Whisper branches go with it.
 */
export type EbookSetProber = "ctc" | "whisper";
export const DEFAULT_EBOOK_SET_PROBER: EbookSetProber = "ctc";
export function ebookSetProber(env: NodeJS.ProcessEnv = process.env): EbookSetProber {
  return env.EBOOK_SET_PROBER === "whisper" ? "whisper" : DEFAULT_EBOOK_SET_PROBER;
}

export async function workerAnchorSample(input: {
  audioPath: string;
  fragmentTexts: string[];
  language: string;
  start: number;
  duration: number;
}): Promise<EbookSetAnchorSample> {
  if (!process.env.ALIGNMENT_WORKER_URL || !process.env.ALIGNMENT_WORKER_TOKEN)
    throw new Error("The local alignment worker is not configured.");
  // An in-flight sample may finish, but no new background sample may start
  // while a reading-sync job is queued or processing.
  while (listAlignmentJobs().some((job) =>
    job.status === "queued" || job.status === "processing"
  )) await new Promise((resolve) => setTimeout(resolve, 1000));
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
  return sampleFromWhisperAnchor(result, input.start);
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

export type EbookSetAnchorSample = AnchorSampleScore;

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
  /** CTC probing: how long to wait for a busy pool host, and the sleep between tries (tests). */
  probeWaitMs?: number;
  probeSleep?: (ms: number) => Promise<void>;
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

/** Scores each sample with the injected or Whisper prober, one worker request per sample. */
async function whisperScores(
  samples: { audioPath: string; time: number; duration: number }[],
  fragmentTexts: string[],
  language: string,
) {
  const anchorSample = deps.anchorSample ?? workerAnchorSample;
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
  if (deps.anchorSample || ebookSetProber() === "whisper") {
    scores = await whisperScores(planned, passages, language);
  } else {
    if (iso3(language) !== "eng") throw new ProbeLanguageNotSupported();
    const session = probe ?? createCtcProbeSession(recordingId, probeSessionOptions());
    try {
      scores = await session.score({ fragmentTexts: passages, language: "eng", samples: planned });
    } finally {
      if (!probe) await session.close();
    }
  }
  const samples = planned.map((sample, i) => ({
    trackId: sample.trackId,
    time: sample.time,
    duration: sample.duration,
    done: true,
    spokenWords: scores[i].spokenWords,
    match: scores[i].match,
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
    deps.anchorSample || ebookSetProber() === "whisper"
      ? null
      : firstRecordingWithLocalAudio(workId);
  const session = recordingId ? createCtcProbeSession(recordingId, probeSessionOptions()) : null;
  try {
    return await run(session);
  } finally {
    await session?.close();
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
  const injected = Boolean(deps.anchorSample);
  const usesCtc = !injected && ebookSetProber() === "ctc";
  const workerReady = usesCtc
    ? poolEnabled() && Boolean(process.env.ALIGNMENT_WORKER_TOKEN)
    : Boolean(process.env.ALIGNMENT_WORKER_URL) &&
      Boolean(process.env.ALIGNMENT_WORKER_TOKEN);
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
  let holdReason = "awaiting_worker";
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
    upsertMember({
      workId,
      ebookId,
      status: "held",
      holdReason,
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
  return withProbeSession(workId, async (probe) => {
    const results = [];
    for (const member of members)
      results.push(
        await evaluateEbookSetMember(
          workId,
          member.ebookId,
          {
            sourceTitle: member.sourceTitle,
            sourceAuthor: member.sourceAuthor,
            language: member.language,
            byteSize: member.byteSize,
          },
          probe,
        ),
      );
    return results;
  });
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
  const failures: string[] = [];
  await withProbeSession(workId, async (probe) => {
    for (const file of filtered) {
      if (downloaded.length >= remaining) break;
      const already = db
        .select()
        .from(s.workEbookSetMembers)
        .where(eq(s.workEbookSetMembers.workId, workId))
        .all()
        .some((m) => m.ebookId === `${file.source}-${file.md5}`);
      if (already) continue;
      const ebookId = `${file.source}-${file.md5}`;
      try {
        let saved: { id: string };
        try {
          saved = await save({ ...file, workId });
        } catch (saveError) {
          const message = (saveError as Error).message;
          const existing = db
            .select()
            .from(s.ebookEditions)
            .where(eq(s.ebookEditions.id, ebookId))
            .get();
          if (!existing || existing.workId !== workId) {
            failures.push(message);
            continue;
          }
          saved = { id: ebookId };
        }
        try {
          const result = await evaluateEbookSetMember(
            workId,
            saved.id,
            {
              sourceTitle: file.title,
              sourceAuthor: file.authors.join(", ") || null,
              language: file.language,
            },
            probe,
          );
          downloaded.push({ id: saved.id, status: result.status });
        } catch (evaluateError) {
          failures.push((evaluateError as Error).message);
          dropOrphanEbookEdition(saved.id, workId);
        }
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
  });
  return { downloaded, skipped: null, failures };
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
