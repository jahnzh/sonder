import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { extractBook, ebookRecord } from "./reader.ts";
import { ensureMediaStorage, mediaRoot } from "./storage.ts";
import { hasServerMedia, requestServerDownload } from "./downloads.ts";
import type { AlignmentJob, AlignmentInterval } from "../src/reading-types.ts";
import { requireAdmin } from "./users.ts";
import { matchSections } from "./alignment-pairings.ts";
import {
  dispatchFullAlignmentJob,
  getAlignmentPoolCoordinator,
  poolAlignmentFolder,
  poolAudioPath,
  poolEnabled,
  poolFailureMessage,
  poolWorkerBase,
  shouldDispatchToPool,
} from "./alignment-pool.ts";
import {
  coreIntervals,
  planSamples,
  planSegments,
  prefixWords,
  refinementSamples,
  selectAnchors,
  speakingRate,
  stitch,
  wordCount,
} from "./alignment-anchors.ts";
export { matchTitle } from "./alignment-pairings.ts";
export function recordingContext(id: string) {
  const rec = db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.id, id))
    .get();
  if (!rec) throw new Error("Choose an audiobook recording.");
  const edition = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.id, rec.editionId))
    .get()!;
  const tracks = db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.recordingId, id))
    .all()
    .sort((a, b) => a.index - b.index);
  return { rec, edition, tracks };
}
function localAudio(track: typeof s.tracks.$inferSelect) {
  if (track.sourceType === "local" && existsSync(track.source))
    return track.source;
  const copy = db
    .select()
    .from(s.mediaCopies)
    .where(eq(s.mediaCopies.trackId, track.id))
    .get();
  return copy && existsSync(copy.path) && statSync(copy.path).size === copy.size
    ? copy.path
    : null;
}
export function trackLocalAudioPath(track: typeof s.tracks.$inferSelect) {
  return localAudio(track);
}
export function recordingHasLocalAudio(recordingId: string) {
  try {
    const { tracks } = recordingContext(recordingId);
    return tracks.some((track) => localAudio(track));
  } catch {
    return false;
  }
}
export function firstRecordingWithLocalAudio(workId: string) {
  const rows = db
    .select({ id: s.recordings.id })
    .from(s.recordings)
    .innerJoin(s.editions, eq(s.recordings.editionId, s.editions.id))
    .where(eq(s.editions.workId, workId))
    .all();
  return rows.find((row) => recordingHasLocalAudio(row.id))?.id ?? null;
}
function audioFingerprint(recordingId: string, stable = true) {
  const { tracks } = recordingContext(recordingId);
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        tracks.map((track) => {
          const path = localAudio(track);
          const stat = path ? statSync(path) : null;
          return {
            id: track.id,
            path,
            size: stat?.size,
            mtime: stat?.mtimeMs,
            // Once the file exists, its version identifies the audio. Browsers
            // and metadata readers can disagree about duration by microseconds.
            duration: stable && stat ? undefined : track.duration,
            chapters: track.chapters,
          };
        }),
      ),
    )
    .digest("hex");
  return stable ? `audio-v2:${hash}` : hash;
}
const jobs = () =>
  (
    sqlite
      .prepare("SELECT data FROM alignment_jobs ORDER BY updated_at DESC")
      .all() as { data: string }[]
  ).map((row) => JSON.parse(row.data) as AlignmentJob);
export function alignmentJob(id: string) {
  const row = sqlite
    .prepare("SELECT data FROM alignment_jobs WHERE id=?")
    .get(id) as { data: string } | undefined;
  if (!row) throw new Error("This reading-sync job could not be found.");
  return JSON.parse(row.data) as AlignmentJob;
}
function store(job: AlignmentJob) {
  job.updatedAt = Date.now();
  if (["ready", "partial"].includes(job.status)) {
    ensureMediaStorage();
    const folder = join(mediaRoot, "alignment", job.id);
    mkdirSync(folder, { recursive: true, mode: 0o750 });
    const path = join(folder, "map.json");
    writeFileSync(path + ".part", JSON.stringify(job), { mode: 0o640 });
    renameSync(path + ".part", path);
  }
  sqlite
    .prepare(
      "INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
    )
    .run(
      job.id,
      job.ebookId,
      job.recordingId,
      JSON.stringify(job),
      job.updatedAt,
    );
  return job;
}
export function putAlignmentJob(job: AlignmentJob) {
  return store(job);
}
export function removeProjectedMapsForWork(workId: string) {
  const ebookIds = new Set(
    db
      .select({ id: s.ebookEditions.id })
      .from(s.ebookEditions)
      .where(eq(s.ebookEditions.workId, workId))
      .all()
      .map((row) => row.id),
  );
  for (const job of jobs()) {
    if (job.origin === "projected" && ebookIds.has(job.ebookId))
      sqlite.prepare("DELETE FROM alignment_jobs WHERE id=?").run(job.id);
  }
}
const language = (value: string) => {
  const code = value.toLowerCase().split(/[-_]/)[0];
  return (
    {
      english: "en",
      french: "fr",
      german: "de",
      spanish: "es",
      italian: "it",
      portuguese: "pt",
      norwegian: "no",
      nob: "no",
      nor: "no",
      eng: "en",
      fra: "fr",
      fre: "fr",
    }[code as "english"] || code
  );
};
const iso3 = (value: string) =>
  ({
    en: "eng",
    fr: "fra",
    de: "deu",
    es: "spa",
    it: "ita",
    pt: "por",
    no: "nob",
    nb: "nob",
    da: "dan",
    sv: "swe",
    nl: "nld",
  })[language(value) as "en"] || "eng";
const activeStatuses = ["queued", "copying", "processing"];
export async function alignmentOptions(ebookId: string, recordingId: string) {
  const book = await extractBook(ebookId),
    { edition, tracks } = recordingContext(recordingId);
  const clips = tracks.flatMap((track) =>
    track.chapters?.length
      ? track.chapters.map((chapter) => ({
          trackId: track.id,
          title: chapter.title,
          start: chapter.start,
          duration: (chapter.end ?? track.duration) - chapter.start,
        }))
      : [
          {
            trackId: track.id,
            title: track.title,
            start: 0,
            duration: track.duration,
          },
        ],
  );
  const sections = book.sections.filter(
    (section) =>
      section.paragraphs.reduce(
        (count, p) => count + p.text.split(/\s+/).length,
        0,
      ) >= 40,
  );
  // One long file without chapter markers is located by sampling its
  // narration instead; a title match there would pair only one section.
  const anchored =
    tracks.every((track) => !track.chapters?.length) &&
    tracks.some((track) => track.duration > 0);
  const matched = matchSections(sections, clips);
  const pairings = anchored && tracks.length === 1 ? [] : matched;
  return {
    anchored,
    sections: book.sections.map((section) => ({
      index: section.index,
      title: section.title,
      paragraphs: section.paragraphs.length,
    })),
    clips,
    pairings,
    sameWork: book.workId === edition.workId,
    languageMatch:
      !edition.language ||
      language(edition.language) === language(book.language),
  };
}
export async function createAlignment(
  ebookId: string,
  recordingId: string,
  pairings?: AlignmentJob["pairings"],
  mode?: AlignmentJob["mode"],
  origin?: AlignmentJob["origin"],
) {
  ensureMediaStorage();
  const book = await extractBook(ebookId),
    { edition, tracks } = recordingContext(recordingId);
  if (book.workId !== edition.workId)
    throw new Error(
      "Link this ebook to the selected audiobook before preparing reading sync.",
    );
  if (
    edition.language &&
    language(edition.language) !== language(book.language)
  )
    throw new Error(
      "The ebook and audiobook languages differ. Choose a matching release.",
    );
  const existing = jobs().find(
    (job) => job.ebookId === ebookId && job.recordingId === recordingId,
  );
  if (existing && activeStatuses.includes(existing.status)) return existing;
  const options = await alignmentOptions(ebookId, recordingId);
  const chosen = pairings?.length ? pairings : options.pairings;
  const anchored =
    mode === "anchored" ||
    (mode !== "chapters" && !chosen.length && options.anchored);
  if (anchored && !options.anchored)
    throw new Error(
      "This release has chapter markers or matched chapters. Match its chapters instead.",
    );
  if (!anchored && !chosen.length)
    throw new Error(
      "Match ebook sections to audio chapters before preparing sync.",
    );
  const seen = new Set<number>();
  for (const pair of anchored ? [] : chosen) {
    const track = tracks.find((track) => track.id === pair.trackId);
    if (
      !track ||
      !book.sections.some((section) => section.index === pair.section) ||
      seen.has(pair.section) ||
      pair.start < 0 ||
      pair.duration <= 0 ||
      pair.duration > 7200 ||
      (track.duration > 0 && pair.start + pair.duration > track.duration + 1)
    )
      throw new Error(
        "Choose valid, distinct ebook sections and audio chapter boundaries.",
      );
    seen.add(pair.section);
  }
  const copying = tracks.some((track) => !hasServerMedia(track));
  if (copying) requestServerDownload(edition.id);
  const job: AlignmentJob = {
    id: existing?.id || randomUUID(),
    generation: randomUUID(),
    ebookId,
    recordingId,
    status: copying ? "copying" : "queued",
    progress: 0,
    engine: "aeneas-1.7.3",
    error: null,
    warning: null,
    intervals: [],
    sectionsDone: [],
    elapsedSeconds: 0,
    fingerprint: book.fingerprint,
    audioFingerprint: audioFingerprint(recordingId),
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    coverage: 0,
    pairings: anchored ? [] : chosen,
    ...(origin === "backfill" ? { origin } : {}),
    ...(anchored
      ? {
          mode: "anchored" as const,
          anchoring: {
            stage: "sampling" as const,
            refinements: 0,
            samples: planSamples(tracks),
            anchors: [],
            segments: [],
            rate: 0,
            flags: [],
          },
        }
      : {}),
  };
  store(job);
  void processAlignments();
  return job;
}
const slimJob = (job: AlignmentJob) => ({
  ...job,
  intervalCount: job.intervals.length,
  unverifiedCount: job.intervals.filter((interval) => !interval.verified)
    .length,
  intervals: [],
});
const workerConfigured = () =>
  !!process.env.ALIGNMENT_WORKER_URL && !!process.env.ALIGNMENT_WORKER_TOKEN;
export type BackfillEligibility =
  | { eligible: true }
  | { eligible: false; reason: "linked" | "language" | "media" };
/** Eligible only when linked, language-matching and every track is on the server. */
export async function backfillEligibility(
  ebookId: string,
  recordingId: string,
): Promise<BackfillEligibility> {
  const ebook = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, ebookId))
    .get();
  const rec = db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.id, recordingId))
    .get();
  if (!ebook || !rec) return { eligible: false, reason: "linked" };
  const { edition, tracks } = recordingContext(recordingId);
  if (ebook.workId !== edition.workId)
    return { eligible: false, reason: "linked" };
  if (edition.language) {
    try {
      const book = await extractBook(ebookId);
      if (language(edition.language) !== language(book.language))
        return { eligible: false, reason: "language" };
    } catch {
      return { eligible: false, reason: "language" };
    }
  }
  if (!tracks.length || !tracks.every((track) => hasServerMedia(track)))
    return { eligible: false, reason: "media" };
  return { eligible: true };
}
type BackfillDecision =
  | "queue"
  | "ready"
  | "inProgress"
  | "paused"
  | "notEligible";
async function backfillDecision(
  ebookId: string,
  recordingId: string,
): Promise<BackfillDecision> {
  const existing = jobs().find(
    (job) => job.ebookId === ebookId && job.recordingId === recordingId,
  );
  if (existing) {
    if (activeStatuses.includes(existing.status)) return "inProgress";
    if (existing.status === "paused") return "paused";
    if (existing.status === "ready" || existing.status === "partial")
      return "ready";
  }
  return (await backfillEligibility(ebookId, recordingId)).eligible
    ? "queue"
    : "notEligible";
}
/** Queues one job per eligible pair. Only enqueues; the queue runs them. */
export async function runAlignmentBackfill() {
  const result = {
    queued: 0,
    failed: 0,
    skipped: { ready: 0, inProgress: 0, paused: 0, notEligible: 0 },
  };
  const pairs = db
    .select({ ebookId: s.ebookEditions.id, recordingId: s.recordings.id })
    .from(s.ebookEditions)
    .innerJoin(s.editions, eq(s.editions.workId, s.ebookEditions.workId))
    .innerJoin(s.recordings, eq(s.recordings.editionId, s.editions.id))
    .all();
  for (const { ebookId, recordingId } of pairs) {
    const decision = await backfillDecision(ebookId, recordingId);
    if (decision !== "queue") {
      result.skipped[decision]++;
      continue;
    }
    try {
      await createAlignment(
        ebookId,
        recordingId,
        undefined,
        undefined,
        "backfill",
      );
      result.queued++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
type AutoQueueLog = { warn: (...args: unknown[]) => void };
/** Non-fatal: queues the pair when eligible and the worker is configured. */
export async function autoQueueAlignmentForPair(
  ebookId: string,
  recordingId: string,
  log: AutoQueueLog = console,
) {
  if (!workerConfigured()) return false;
  try {
    if ((await backfillDecision(ebookId, recordingId)) !== "queue")
      return false;
    await createAlignment(ebookId, recordingId, undefined, undefined, "backfill");
    return true;
  } catch (error) {
    log.warn(
      `Reading sync could not be queued automatically: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
/** Auto-queues every pair of a work, optionally limited to one ebook or recording. */
export async function autoQueueAlignmentsForWork(
  workId: string,
  filter: { ebookId?: string; recordingId?: string } = {},
  log: AutoQueueLog = console,
) {
  if (!workerConfigured()) return;
  try {
    const ebooks = db
      .select()
      .from(s.ebookEditions)
      .where(eq(s.ebookEditions.workId, workId))
      .all()
      .filter((row) => !filter.ebookId || row.id === filter.ebookId);
    const recordings = db
      .select({ id: s.recordings.id })
      .from(s.recordings)
      .innerJoin(s.editions, eq(s.editions.id, s.recordings.editionId))
      .where(eq(s.editions.workId, workId))
      .all()
      .filter((row) => !filter.recordingId || row.id === filter.recordingId);
    for (const ebook of ebooks)
      for (const rec of recordings)
        await autoQueueAlignmentForPair(ebook.id, rec.id, log);
  } catch (error) {
    log.warn(
      `Reading sync could not be queued automatically: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
const finished = (job: AlignmentJob) =>
  job.mode === "anchored"
    ? job.anchoring?.stage === "done"
    : job.sectionsDone.length === job.pairings.length;
// The worker ends a request itself (HTTP 504) after at most 1700 s, so these client
// waits must stay longer than that for its clear error to arrive first.
const SECTION_TIMEOUT_MS = 30 * 60 * 1000,
  ANCHOR_TIMEOUT_MS = 180000;
export const WORKER_TIMEOUT_MESSAGE =
  "The alignment worker timed out on this section. Retry later, or choose a release with chapters.";
async function workerRequest(
  path: string,
  body: object,
  timeout: number,
  failure = path === "/anchor"
    ? "Local speech recovery is unavailable. Check that the speech model is installed on the media drive."
    : "Local alignment could not process part of this narration. Retry, or choose a release with chapters.",
  workerBase = process.env.ALIGNMENT_WORKER_URL!,
) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(
      `${workerBase.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: process.env.ALIGNMENT_WORKER_TOKEN,
          ...body,
        }),
        signal: AbortSignal.timeout(timeout),
      },
    );
    // A speech-recovery request can briefly hold the single worker.
    if (response.status === 409 && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    // The worker stopped this request at its time limit; running it again would hold the core for as long.
    if (response.status === 504) throw new Error(WORKER_TIMEOUT_MESSAGE);
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "The alignment worker is busy. Retry in a moment."
          : failure,
      );
    return response.json();
  }
}
const anchorResult = z.object({
  match: z
    .object({ index: z.number().int().nonnegative(), score: z.number() })
    .nullable(),
  start: z.number().nonnegative().finite().optional(),
  text: z.string().optional(),
});
async function processAnchored(
  job: AlignmentJob,
  book: Awaited<ReturnType<typeof extractBook>>,
  tracks: ReturnType<typeof recordingContext>["tracks"],
  folder: string,
) {
  const workerBase = poolWorkerBase(job);
  const audioPath = (track: (typeof tracks)[number]) =>
    poolAudioPath(job, track, localAudio);
  const workFolder = poolAlignmentFolder(job, folder);
  if (job.pool) mkdirSync(workFolder, { recursive: true, mode: 0o750 });
  const usingLocalFull =
    !job.pool && shouldDispatchToPool(job) === false && job.mode === "anchored";
  if (usingLocalFull)
    getAlignmentPoolCoordinator().localFullAlignmentStarting(
      job.recordingId,
      job.id,
    );
  try {
  const generation = job.generation;
  const live = () => {
    const current = alignmentJob(job.id);
    return (
      !stopping &&
      activeStatuses.includes(current.status) &&
      current.generation === generation
    );
  };
  // Work finished after a pause is still kept; only a rebuild discards it.
  const current = () => alignmentJob(job.id).generation === generation;
  const paragraphs = book.sections.flatMap((section) =>
    section.paragraphs.map((paragraph) => ({
      ...paragraph,
      section: section.index,
      words: wordCount(paragraph.text),
    })),
  );
  const words = prefixWords(paragraphs),
    order = new Map(paragraphs.map((paragraph, i) => [paragraph.id, i]));
  const timeline = tracks.map((track) => ({
    id: track.id,
    duration: track.duration,
  }));
  // The worker accepts up to 20,000 fragments, so very long books are sent as
  // groups of consecutive sentences.
  const group = Math.ceil(paragraphs.length / 20000);
  const blocks: string[] = [];
  for (let i = 0; i < paragraphs.length; i += group)
    blocks.push(
      paragraphs
        .slice(i, i + group)
        .map((paragraph) => paragraph.text)
        .join(" "),
    );
  const language = iso3(book.language);
  const progress = (current: AlignmentJob) => {
    const plan = current.anchoring!;
    const sampled =
      plan.samples.filter((sample) => sample.done).length /
      Math.max(1, plan.samples.length);
    const aligned =
      plan.segments.filter((segment) => segment.done).length /
      Math.max(1, plan.segments.length);
    current.progress =
      plan.stage === "sampling" ? sampled * 0.25 : 0.25 + aligned * 0.75;
  };
  while (job.anchoring!.stage === "sampling") {
    for (const [i, sample] of job.anchoring!.samples.entries()) {
      if (sample.done) continue;
      if (!live()) return;
      const track = tracks.find((track) => track.id === sample.trackId);
      const audio = track && audioPath(track);
      if (!audio) throw new Error("The required audio file is unavailable.");
      const result = anchorResult.parse(
        await workerRequest(
          "/anchor",
          {
            audio,
            output: join(workFolder, "anchor.json"),
            fragments: blocks,
            language,
            start: sample.time,
            duration: sample.duration,
          },
          ANCHOR_TIMEOUT_MS,
          undefined,
          workerBase,
        ),
      );
      if (!current()) return;
      job = alignmentJob(job.id);
      job.anchoring!.samples[i] = {
        ...sample,
        done: true,
        spokenWords: result.text ? wordCount(result.text) : 0,
        match: result.match
          ? {
              fragment: result.match.index * group,
              score: result.match.score,
              start: result.start ?? sample.time,
            }
          : null,
      };
      progress(job);
      store(job);
    }
    // A pause or cancel during the last sample must not be replaced by the next stage's result.
    if (!live()) return;
    job = alignmentJob(job.id);
    const plan = job.anchoring!;
    const anchors = selectAnchors(plan.samples, words, timeline);
    const spoken = plan.samples.filter(
      (sample) => (sample.spokenWords ?? 0) >= 10,
    ).length;
    if (anchors.length < 3 || anchors.length < spoken * 0.3) {
      job.status = "error";
      job.error = `Only ${anchors.length} of ${spoken} narration samples were found in this EPUB. Choose the matching ebook edition or a release with chapters.`;
      plan.anchors = anchors;
      store(job);
      return;
    }
    const rate = speakingRate(anchors, words, timeline);
    const extra =
      plan.refinements < 2
        ? refinementSamples(anchors, plan.samples, words, rate)
        : [];
    plan.anchors = anchors;
    plan.rate = rate;
    if (extra.length) {
      plan.refinements++;
      plan.samples.push(...extra);
      plan.samples.sort(
        (a, b) =>
          tracks.findIndex((track) => track.id === a.trackId) -
            tracks.findIndex((track) => track.id === b.trackId) ||
          a.time - b.time,
      );
    } else {
      const planned = planSegments(anchors, paragraphs, timeline, rate);
      plan.segments = planned.segments;
      plan.flags = planned.flags;
      plan.stage = "aligning";
    }
    progress(job);
    store(job);
  }
  for (const [i, segment] of job.anchoring!.segments.entries()) {
    if (segment.done) continue;
    if (!live()) return;
    const track = tracks.find((track) => track.id === segment.trackId);
    const audio = track && audioPath(track);
    if (!audio) throw new Error("The required audio file is unavailable.");
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify([
          job.engine,
          "anchored-v1",
          job.fingerprint,
          job.audioFingerprint,
          segment,
        ]),
      )
      .digest("hex")
      .slice(0, 24);
    const output = join(workFolder, `window-${i}-${cacheKey}.json`);
    const raw = existsSync(output)
      ? JSON.parse(readFileSync(output, "utf8"))
      : await workerRequest(
          "/align",
          {
            audio,
            output,
            fragments: paragraphs
              .slice(segment.first, segment.last + 1)
              .map((paragraph) => paragraph.text),
            language,
            start: segment.start,
            duration: segment.duration,
          },
          SECTION_TIMEOUT_MS,
          undefined,
          workerBase,
        );
    if (!current()) return;
    const result = z
      .object({
        intervals: z
          .array(
            z.object({
              index: z.number().int().nonnegative(),
              start: z.number().nonnegative().finite(),
              end: z.number().nonnegative().finite(),
            }),
          )
          .max(20000),
        elapsedSeconds: z.number().nonnegative().finite(),
      })
      .parse(raw);
    const intervals: AlignmentInterval[] = coreIntervals(
      segment,
      result.intervals,
    ).map((interval) => {
      const paragraph = paragraphs[interval.fragment],
        rate = paragraph.words / (interval.end - interval.start);
      return {
        paragraphId: paragraph.id,
        section: paragraph.section,
        trackId: segment.trackId,
        start: interval.start,
        end: interval.end,
        confidence: rate > 0.3 && rate < 6 ? 0.65 : 0.2,
      };
    });
    job = alignmentJob(job.id);
    const plan = job.anchoring!;
    if (!intervals.length)
      plan.flags.push({
        kind: "unaligned",
        trackId: segment.trackId,
        start: segment.start,
        end: segment.start + segment.duration,
        section: paragraphs[segment.coreFirst].section,
        first: segment.coreFirst,
        last: segment.coreLast,
      });
    job.intervals.push(...intervals);
    plan.segments[i] = { ...segment, done: true };
    job.elapsedSeconds += result.elapsedSeconds;
    progress(job);
    job.coverage = job.intervals.length / paragraphs.length;
    store(job);
  }
  if (!live()) return;
  job = alignmentJob(job.id);
  const plan = job.anchoring!;
  job.intervals = stitch(job.intervals, order, timeline);
  job.coverage = job.intervals.length / paragraphs.length;
  // Sections with real text and no narration at all, such as front matter.
  const mapped = new Set(job.intervals.map((interval) => interval.section));
  for (const section of book.sections)
    if (
      !mapped.has(section.index) &&
      section.paragraphs.reduce((count, p) => count + wordCount(p.text), 0) >=
        40
    )
      plan.flags.push({ kind: "unmatched-text", section: section.index });
  for (const flag of plan.flags)
    if (flag.section !== undefined)
      flag.title = book.sections.find(
        (section) => section.index === flag.section,
      )?.title;
  plan.stage = "done";
  job.progress = 1;
  job.status = "partial";
  job.warning =
    "Timings are estimated from sampled narration. Preview a few passages, then mark the alignment reviewed. Passages without matching narration are left unsynced.";
  store(job);
  if (job.ebookId.startsWith("set-consensus:")) {
    const { onConsensusAlignmentFinished } = await import(
      "./ebook-set-consensus.ts"
    );
    await onConsensusAlignmentFinished(job.ebookId.slice("set-consensus:".length), job);
  }
  } finally {
    if (usingLocalFull)
      getAlignmentPoolCoordinator().localFullAlignmentFinished(
        job.recordingId,
        job.id,
      );
    if (job.pool)
      getAlignmentPoolCoordinator().release(
        job.pool.hostId,
        job.id,
        job.recordingId,
      );
  }
}
let running = false,
  stopping = false,
  activeApps = 0;
export async function processAlignments() {
  if (
    running ||
    stopping ||
    !process.env.ALIGNMENT_WORKER_URL ||
    !process.env.ALIGNMENT_WORKER_TOKEN
  )
    return;
  running = true;
  try {
    for (const pending of jobs().filter((job) =>
      activeStatuses.includes(job.status),
    )) {
      // Each job fails on its own, so one broken job can't stall the rest of the queue.
      try {
        let job = alignmentJob(pending.id);
        const book = await extractBook(job.ebookId),
          context = recordingContext(job.recordingId);
        if (context.tracks.some((track) => !hasServerMedia(track))) {
          const download = db
            .select()
            .from(s.serverDownloads)
            .where(eq(s.serverDownloads.recordingId, job.recordingId))
            .get();
          if (download?.status === "error") {
            job.status = "error";
            job.error =
              download.error || "The audio could not be saved on the HDD.";
            store(job);
          }
          continue;
        }
        if (book.fingerprint !== job.fingerprint) {
          job.status = "error";
          job.error = "The EPUB changed. Prepare a new reading-sync map.";
          store(job);
          continue;
        }
        const currentAudioFingerprint = audioFingerprint(job.recordingId);
        if (
          (job.sectionsDone.length ||
            job.anchoring?.samples.some((sample) => sample.done)) &&
          currentAudioFingerprint !== job.audioFingerprint
        ) {
          job.status = "error";
          job.error =
            "The audio changed. Rebuild this reading-sync map before continuing.";
          store(job);
          continue;
        }
        job.audioFingerprint = currentAudioFingerprint;
        job.status = "processing";
        store(job);
        const generation = job.generation;
        const folder = join(mediaRoot, "alignment", job.id);
        mkdirSync(folder, { recursive: true, mode: 0o750 });
        if (job.mode === "anchored") {
          if (shouldDispatchToPool(job) && !job.pool) {
            try {
              job.pool = await dispatchFullAlignmentJob(
                job,
                context.tracks,
                localAudio,
              );
              store(job);
            } catch (error) {
              job.status = "error";
              job.error = poolFailureMessage(error);
              store(job);
              continue;
            }
          } else if (
            shouldDispatchToPool(job) &&
            !getAlignmentPoolCoordinator().canUseLocalWorker(job.recordingId)
          ) {
            continue;
          }
          await processAnchored(job, book, context.tracks, folder);
          continue;
        }
        for (const pair of job.pairings) {
          const current = alignmentJob(job.id);
          if (
            stopping ||
            !activeStatuses.includes(current.status) ||
            current.generation !== generation
          )
            break;
          if (job.sectionsDone.includes(pair.section)) continue;
          const section = book.sections.find(
            (section) => section.index === pair.section,
          )!;
          const track = context.tracks.find(
            (track) => track.id === pair.trackId,
          )!;
          const audio = localAudio(track);
          if (!audio) throw new Error("The required audio file is unavailable.");
          const cacheKey = createHash("sha256")
            .update(
              JSON.stringify([
                job.engine,
                "sentence-normalization-v1-speech-check-v1",
                job.fingerprint,
                job.audioFingerprint,
                pair,
              ]),
            )
            .digest("hex")
            .slice(0, 24);
          const output = join(folder, `section-${pair.section}-${cacheKey}.json`);
          let result: {
            intervals: { index: number; start: number; end: number }[];
            elapsedSeconds: number;
            peakMemoryMB?: number;
            engine: string;
          };
          if (existsSync(output))
            result = JSON.parse(readFileSync(output, "utf8"));
          else {
            result = await workerRequest(
              "/align",
              {
                audio,
                output,
                fragments: section.paragraphs.map((p) => p.text),
                language: iso3(book.language),
                start: pair.start,
                duration: pair.duration,
              },
              SECTION_TIMEOUT_MS,
              "Local alignment could not process this section. Check its chapter pairing and retry.",
            );
          }
          if (
            !activeStatuses.includes(alignmentJob(job.id).status) ||
            alignmentJob(job.id).generation !== generation
          )
            break;
          result = z
            .object({
              intervals: z
                .array(
                  z.object({
                    index: z.number().int().nonnegative(),
                    start: z.number().nonnegative().finite(),
                    end: z.number().nonnegative().finite(),
                  }),
                )
                .max(20000),
              elapsedSeconds: z.number().nonnegative().finite(),
              engine: z.string(),
            })
            .parse(result);
          const intervals: AlignmentInterval[] = result.intervals
            .filter(
              (interval) =>
                section.paragraphs[interval.index] &&
                interval.end > interval.start &&
                interval.start >= pair.start &&
                interval.end <= pair.start + pair.duration + 1,
            )
            .map((interval) => {
              const paragraph = section.paragraphs[interval.index],
                rate =
                  paragraph.text.split(/\s+/).length /
                  (interval.end - interval.start);
              return {
                paragraphId: paragraph.id,
                section: pair.section,
                trackId: pair.trackId,
                start: interval.start,
                end: interval.end,
                confidence: rate > 0.3 && rate < 6 ? 0.65 : 0.2,
              };
            });
          job = alignmentJob(job.id);
          if (!intervals.length)
            job.warning =
              "This section could not be matched reliably. Check its edition and chapter pairing; unmatched text remains unsynced.";
          job.intervals.push(...intervals);
          job.sectionsDone.push(pair.section);
          job.elapsedSeconds += result.elapsedSeconds;
          job.progress = job.sectionsDone.length / job.pairings.length;
          job.coverage =
            job.intervals.length /
            book.sections.reduce(
              (count, section) => count + section.paragraphs.length,
              0,
            );
          store(job);
        }
        job = alignmentJob(job.id);
        if (
          job.sectionsDone.length === job.pairings.length &&
          job.generation === generation &&
          activeStatuses.includes(job.status)
        ) {
          job.status = "partial";
          job.warning ||=
            "Timings are estimated from the supplied text. Preview a few passages, then mark the alignment reviewed. Sections without a matching narration are left unsynced.";
          store(job);
          const path = join(folder, "map.json");
          writeFileSync(path + ".part", JSON.stringify(job));
          renameSync(path + ".part", path);
        }
      } catch (error) {
        const current = jobs().find((job) => job.id === pending.id);
        if (
          current &&
          activeStatuses.includes(current.status) &&
          current.generation === pending.generation
        ) {
          current.status = "error";
          current.error =
            error instanceof Error ? error.message : "Local alignment failed.";
          store(current);
        }
      }
    }
  } finally {
    running = false;
  }
}
export function stopAlignments() {
  stopping = true;
}
export function registerAlignment(app: FastifyInstance) {
  activeApps++;
  stopping = false;
  for (const job of jobs()) {
    if (job.audioFingerprint.startsWith("audio-v2:")) continue;
    try {
      // Upgrade only maps whose complete original source fingerprint still
      // validates; never bless a changed file just because it has a new format.
      if (job.audioFingerprint === audioFingerprint(job.recordingId, false)) {
        job.audioFingerprint = audioFingerprint(job.recordingId);
        store(job);
      }
    } catch {}
  }
  app.post("/api/alignments/recover", async (req) => {
    const input = z
      .object({
        ebookId: z.string(),
        recordingId: z.string(),
        trackId: z.string(),
        position: z.number().nonnegative(),
      })
      .parse(req.body);
    ensureMediaStorage();
    const book = await extractBook(input.ebookId),
      { edition, tracks } = recordingContext(input.recordingId);
    if (
      book.workId !== edition.workId ||
      (edition.language &&
        language(edition.language) !== language(book.language))
    )
      throw new Error(
        "Choose a matching ebook and narration in the same language.",
      );
    const track = tracks.find((t) => t.id === input.trackId),
      audio = track && localAudio(track);
    if (!track || !audio)
      throw new Error(
        "Save this audiobook to the server HDD before locating its text locally.",
      );
    if (
      !process.env.ALIGNMENT_WORKER_URL ||
      !process.env.ALIGNMENT_WORKER_TOKEN
    )
      throw new Error("The local alignment worker is not configured.");
    const start = Math.max(0, input.position - 3),
      duration = Math.min(30, track.duration - start);
    if (duration <= 0)
      throw new Error("Choose a position inside the narration.");
    const fragments = book.sections.flatMap((section) => section.paragraphs);
    const response = await fetch(
      `${process.env.ALIGNMENT_WORKER_URL.replace(/\/$/, "")}/anchor`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
        body: JSON.stringify({
          token: process.env.ALIGNMENT_WORKER_TOKEN,
          audio,
          output: join(mediaRoot, "alignment", "recovery.json"),
          fragments: fragments.map((p) => p.text),
          language: iso3(book.language),
          start,
          duration,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "The local worker is busy. Try again after the current section."
          : response.status === 504
            ? WORKER_TIMEOUT_MESSAGE
            : "This passage could not be located locally. Check its edition and chapter match.",
      );
    const result = z
      .object({
        match: z
          .object({
            index: z.number().int().nonnegative(),
            score: z.number(),
            text: z.string(),
          })
          .nullable(),
      })
      .parse(await response.json());
    const fragment = result.match && fragments[result.match.index];
    if (!fragment)
      throw new Error(
        "No reliable text match was found in this excerpt. Choose another passage or a matching edition.",
      );
    const section = book.sections.find((section) =>
      section.paragraphs.some((p) => p.id === fragment.id),
    )!;
    return {
      locator: {
        section: section.index,
        paragraphId: fragment.id,
        quote: fragment.text.slice(0, 300),
        progression:
          fragments.indexOf(fragment) / Math.max(1, fragments.length - 1),
      },
      score: result.match!.score,
      approximate: true,
    };
  });
  app.get("/api/alignments/backfill", (req) => {
    requireAdmin(req);
    const all = jobs();
    const count = (...statuses: string[]) =>
      all.filter((job) => statuses.includes(job.status)).length;
    const next = all.find((job) => activeStatuses.includes(job.status));
    return {
      available: workerConfigured(),
      counts: {
        queued: count("queued"),
        running: count("copying", "processing"),
        ready: count("ready"),
        partial: count("partial"),
        failed: count("error"),
      },
      next: next ? slimJob(next) : null,
    };
  });
  app.post("/api/alignments/backfill", async (req) => {
    requireAdmin(req);
    return runAlignmentBackfill();
  });
  app.get("/api/alignments", (req) => {
    const { ebookId, summary } = z
      .object({
        ebookId: z.string().optional(),
        summary: z
          .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
          .optional(),
      })
      .parse(req.query);
    const slim = summary === "1" || summary === "true";
    const listed = jobs().filter((job) => !ebookId || job.ebookId === ebookId);
    return {
      available:
        !!process.env.ALIGNMENT_WORKER_URL &&
        !!process.env.ALIGNMENT_WORKER_TOKEN,
      localOnly: true,
      jobs: slim
        ? listed.map((job) => ({
            ...job,
            intervalCount: job.intervals.length,
            unverifiedCount: job.intervals.filter((interval) => !interval.verified)
              .length,
            intervals: [],
          }))
        : listed,
    };
  });
  app.get("/api/alignments/options", async (req) => {
    const { ebookId, recordingId } = z
      .object({ ebookId: z.string(), recordingId: z.string() })
      .parse(req.query);
    return alignmentOptions(ebookId, recordingId);
  });
  app.post("/api/alignments", async (req) => {
    const input = z
      .object({
        ebookId: z.string(),
        recordingId: z.string(),
        pairings: z
          .array(
            z.object({
              section: z.number().int().min(0),
              trackId: z.string(),
              start: z.number().min(0),
              duration: z.number().positive().max(7200),
            }),
          )
          .min(1)
          .max(1000)
          .optional(),
        mode: z.enum(["chapters", "anchored"]).optional(),
      })
      .parse(req.body);
    return createAlignment(
      input.ebookId,
      input.recordingId,
      input.pairings,
      input.mode,
    );
  });
  app.patch("/api/alignments/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel", "review"]) })
      .parse(req.body);
    const job = alignmentJob(id);
    if (action === "review") {
      const book = await extractBook(job.ebookId);
      if (
        !finished(job) ||
        book.fingerprint !== job.fingerprint ||
        audioFingerprint(job.recordingId) !== job.audioFingerprint
      )
        throw new Error(
          "Finish or rebuild this alignment before marking it reviewed.",
        );
      job.intervals = job.intervals.map((interval) => ({
        ...interval,
        verified: true,
      }));
      job.status = job.coverage > 0.95 ? "ready" : "partial";
      job.warning =
        job.coverage > 0.95
          ? null
          : "Reviewed sections are ready. Text without matching narration remains unsynced.";
    } else {
      job.status =
        action === "pause"
          ? "paused"
          : action === "cancel"
            ? "cancelled"
            : "queued";
      job.error = null;
      if (action === "resume") delete job.pool;
    }
    store(job);
    if (action === "resume") void processAlignments();
    return job;
  });
  app.get("/api/alignments/:id/map", async (req, reply) => {
    // A 410 is a cacheable status per RFC 9111: browsers store the response
    // even without freshness headers, and a cached 410 then answers every
    // later /map fetch — including after a rebuild — until the cache is gone.
    reply.header("Cache-Control", "private, no-store");
    const { id } = req.params as { id: string };
    const job = alignmentJob(id),
      book = await extractBook(job.ebookId);
    if (job.status === "cancelled")
      throw Object.assign(
        new Error("This alignment was cancelled. Rebuild it before using it."),
        { statusCode: 410, code: "alignment_cancelled" },
      );
    if (
      job.fingerprint !== book.fingerprint ||
      job.audioFingerprint !== audioFingerprint(job.recordingId)
    )
      throw Object.assign(
        new Error(
          "The ebook or audio changed. Rebuild this alignment before using it.",
        ),
        { statusCode: 410, code: "alignment_stale" },
      );
    return job;
  });
  app.post("/api/alignments/:id/anchors", async (req) => {
    const { id } = req.params as { id: string };
    const input = z
      .object({
        paragraphId: z.string(),
        trackId: z.string(),
        start: z.number().min(0),
        end: z.number().positive(),
      })
      .parse(req.body);
    const job = alignmentJob(id),
      book = await extractBook(job.ebookId);
    if (
      activeStatuses.includes(job.status) ||
      job.fingerprint !== book.fingerprint ||
      job.audioFingerprint !== audioFingerprint(job.recordingId)
    )
      throw new Error(
        "Finish or rebuild this alignment before correcting sentence timings.",
      );
    const section = book.sections.find((section) =>
      section.paragraphs.some((p) => p.id === input.paragraphId),
    );
    const track = recordingContext(job.recordingId).tracks.find(
      (t) => t.id === input.trackId,
    );
    if (
      !section ||
      !track ||
      input.end <= input.start ||
      input.end > track.duration
    )
      throw new Error("Choose a valid passage and audio interval.");
    job.intervals = job.intervals.filter(
      (interval) => interval.paragraphId !== input.paragraphId,
    );
    job.intervals.push({
      ...input,
      section: section.index,
      confidence: 1,
      verified: true,
    });
    return store(job);
  });
  const timer = setInterval(() => void processAlignments(), 5000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    activeApps--;
    if (activeApps === 0) stopAlignments();
  });
}
