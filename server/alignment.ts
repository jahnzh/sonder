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
import { matchSections } from "./alignment-pairings.ts";
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
  const pairings = matchSections(sections, clips);
  return {
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
  const chosen = pairings || options.pairings;
  if (!chosen.length)
    throw new Error(
      "Match ebook sections to audio chapters before preparing sync.",
    );
  const seen = new Set<number>();
  for (const pair of chosen) {
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
    pairings: chosen,
  };
  store(job);
  void processAlignments();
  return job;
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
        job.sectionsDone.length &&
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
          const response = await fetch(
            `${process.env.ALIGNMENT_WORKER_URL.replace(/\/$/, "")}/align`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                token: process.env.ALIGNMENT_WORKER_TOKEN,
                audio,
                output,
                fragments: section.paragraphs.map((p) => p.text),
                language: iso3(book.language),
                start: pair.start,
                duration: pair.duration,
              }),
              signal: AbortSignal.timeout(30 * 60 * 1000),
            },
          );
          if (!response.ok)
            throw new Error(
              response.status === 409
                ? "The alignment worker is busy. Retry in a moment."
                : "Local alignment could not process this section. Check its chapter pairing and retry.",
            );
          result = (await response.json()) as typeof result;
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
    }
  } catch (error) {
    const current = jobs().find((job) => job.status === "processing");
    if (current) {
      current.status = "error";
      current.error =
        error instanceof Error ? error.message : "Local alignment failed.";
      store(current);
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
        signal: AbortSignal.timeout(180000),
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
  app.get("/api/alignments", (req) => {
    const { ebookId } = z
      .object({ ebookId: z.string().optional() })
      .parse(req.query);
    return {
      available:
        !!process.env.ALIGNMENT_WORKER_URL &&
        !!process.env.ALIGNMENT_WORKER_TOKEN,
      localOnly: true,
      jobs: jobs().filter((job) => !ebookId || job.ebookId === ebookId),
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
      })
      .parse(req.body);
    return createAlignment(input.ebookId, input.recordingId, input.pairings);
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
        job.sectionsDone.length !== job.pairings.length ||
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
    }
    store(job);
    if (action === "resume") void processAlignments();
    return job;
  });
  app.get("/api/alignments/:id/map", async (req) => {
    const { id } = req.params as { id: string };
    const job = alignmentJob(id),
      book = await extractBook(job.ebookId);
    if (
      job.fingerprint !== book.fingerprint ||
      job.audioFingerprint !== audioFingerprint(job.recordingId)
    )
      throw new Error(
        "The ebook or audio changed. Rebuild this alignment before using it.",
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
