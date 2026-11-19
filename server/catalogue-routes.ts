// The catalogue routes (#721). Matching is the administrator's: every route here refuses anyone else. A provider
// failure answers with its reason (502) and touches nothing else: the library and playback never read a provider.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./users.ts";
import { sqlite } from "./db.ts";
import { CatalogueError } from "./catalogue-provider.ts";
import { audiobookDbKey, audiobookDbReleases, audiobookDbUnitsToday, searchAudiobookDbBooks, testAudiobookDb, type CatalogueBook } from "./audiobookdb.ts";
import { searchOpenLibrary } from "./openlibrary.ts";
import {
  batchStatus,
  englishRelease,
  linkRecording,
  linkWork,
  matchOutcome,
  matchQuery,
  releaseLink,
  startBatchMatch,
  unlinkRecording,
  unlinkWork,
  unmatchedWorks,
  workLink,
  workRecordings,
} from "./catalogue-links.ts";

const failed = (reply: FastifyReply, error: unknown) => {
  if (error instanceof CatalogueError) return reply.code(error.kind === "missing_key" ? 409 : 502).send({ error: error.message, kind: error.kind, provider: error.provider });
  throw error;
};
const result = (book: CatalogueBook) => ({
  provider: book.provider,
  id: book.id,
  title: book.title,
  subtitle: book.subtitle,
  authors: book.authors,
  narrators: book.narrators,
  cover: book.cover,
  year: book.year,
  series: book.series[0] ?? null,
});

/** The match page's answer: the link, the batch's outcome, the recordings and (on AudiobookDB) the English releases. */
async function workCatalogue(workId: string) {
  const work = sqlite.prepare("SELECT id,title,author FROM works WHERE id=?").get(workId) as { id: string; title: string; author: string } | undefined;
  if (!work) return null;
  const link = workLink(workId);
  const recordings = workRecordings(workId).map((recording) => ({
    recordingId: recording.recordingId,
    label: recording.label,
    durationMs: recording.durationMs,
    narrator: recording.narrator,
    release: releaseLink(recording.recordingId),
  }));
  let releases: { id: string; narrators: string[]; lengthMs: number | null; asin: string | null; language: string | null; abridged: boolean | null; chapters: number }[] = [];
  let releasesError: string | null = null;
  if (link?.provider === "audiobookdb") {
    try {
      releases = (await audiobookDbReleases(link.id)).filter(englishRelease).map((release) => ({
        id: release.id,
        narrators: release.narrators,
        lengthMs: release.lengthMs,
        asin: release.asin,
        language: release.language,
        abridged: release.abridged,
        chapters: release.chapters.length,
      }));
    } catch (error) {
      if (!(error instanceof CatalogueError)) throw error;
      releasesError = error.message;
    }
  }
  return { workId, title: work.title, author: work.author, query: matchQuery(work), link, outcome: matchOutcome(workId), recordings, releases, releasesError };
}

export function registerCatalogueRoutes(app: FastifyInstance) {
  app.post("/api/audiobookdb/test", async (req, reply) => {
    requireAdmin(req);
    try {
      return { ok: true, source: audiobookDbKey().source, ...(await testAudiobookDb()) };
    } catch (error) {
      return failed(reply, error);
    }
  });
  /** Both providers at once; each answers its results or its own reason. */
  app.get("/api/catalogue/search", async (req) => {
    requireAdmin(req);
    const { q } = z.object({ q: z.string().trim().min(2).max(200) }).parse(req.query);
    const settle = async (search: () => Promise<CatalogueBook[]>) => {
      try {
        return { results: (await search()).map(result), error: null };
      } catch (error) {
        if (!(error instanceof CatalogueError)) throw error;
        return { results: [], error: error.message };
      }
    };
    const [audiobookdb, openlibrary] = await Promise.all([settle(() => searchAudiobookDbBooks(q)), settle(() => searchOpenLibrary(q))]);
    return { audiobookdb, openlibrary };
  });
  app.get("/api/works/:id/catalogue", async (req, reply) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().min(1).max(300) }).parse(req.params);
    const answer = await workCatalogue(id);
    return answer ?? reply.code(404).send({ error: "This book is not on the server." });
  });
  app.put("/api/works/:id/catalogue", async (req, reply) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().min(1).max(300) }).parse(req.params);
    const body = z
      .object({ provider: z.enum(["audiobookdb", "openlibrary"]), id: z.string().trim().min(1).max(100), author: z.string().max(300).optional() })
      .parse(req.body ?? {});
    if (!(await workCatalogue(id))) return reply.code(404).send({ error: "This book is not on the server." });
    try {
      await linkWork(id, { provider: body.provider, id: body.id, author: body.author }, "manual");
    } catch (error) {
      return failed(reply, error);
    }
    return workCatalogue(id);
  });
  // An empty body or none, as older requests send it.
  app.delete("/api/works/:id/catalogue", async (req, reply) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().min(1).max(300) }).parse(req.params);
    if (!(await workCatalogue(id))) return reply.code(404).send({ error: "This book is not on the server." });
    unlinkWork(id);
    return workCatalogue(id);
  });
  app.put("/api/recordings/:id/release", async (req, reply) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().min(1).max(300) }).parse(req.params);
    const { releaseId } = z.object({ releaseId: z.string().trim().min(1).max(100) }).parse(req.body ?? {});
    try {
      await linkRecording(id, releaseId, "manual");
    } catch (error) {
      if (error instanceof CatalogueError) return failed(reply, error);
      return reply.code(400).send({ error: (error as Error).message });
    }
    const workId = sqlite.prepare("SELECT e.work_id FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE r.id=?").pluck().get(id) as string;
    return workCatalogue(workId);
  });
  app.delete("/api/recordings/:id/release", async (req, reply) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().min(1).max(300) }).parse(req.params);
    const workId = sqlite.prepare("SELECT e.work_id FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE r.id=?").pluck().get(id) as string | undefined;
    if (!workId) return reply.code(404).send({ error: "This recording is not on the server." });
    unlinkRecording(id);
    return workCatalogue(workId);
  });
  app.get("/api/catalogue/match", async (req) => {
    requireAdmin(req);
    return { status: batchStatus(), unmatched: unmatchedWorks(), unitsToday: audiobookDbUnitsToday() };
  });
  app.post("/api/catalogue/match", async (req, reply) => {
    requireAdmin(req);
    if (!audiobookDbKey().key) return reply.code(409).send({ error: "Add the AudiobookDB API key first.", kind: "missing_key", provider: "audiobookdb" });
    return { status: startBatchMatch(), unmatched: unmatchedWorks(), unitsToday: audiobookDbUnitsToday() };
  });
}
