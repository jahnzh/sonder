// The catalogue routes (#721). Matching is the administrator's: every route here refuses anyone else. A provider
// failure answers with its reason (502) and touches nothing else: the library and playback never read a provider.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { currentUserId, requireAdmin } from "./users.ts";
import { discoverAudiobookDb, discoverOpenLibrary } from "./discover-catalogue.ts";
import { sqlite } from "./db.ts";
import { CATALOGUE_PROVIDERS, CatalogueError, isExtraProvider, type CatalogueProviderName } from "./catalogue-provider.ts";
import { audiobookDbKey, audiobookDbUnitsToday, searchAudiobookDbBooks, testAudiobookDb, type CatalogueBook } from "./audiobookdb.ts";
import { searchOpenLibrary } from "./openlibrary.ts";
import { searchGoogleBooks } from "./googlebooks.ts";
import { searchItunes } from "./itunes.ts";
import {
  batchStatus,
  englishRelease,
  linkRecording,
  linkWork,
  matchOutcome,
  matchQuery,
  providerLinks,
  releaseLink,
  startBatchMatch,
  unlinkProvider,
  unlinkRecording,
  unlinkWork,
  unmatchedWorks,
  workLink,
  workRecordings,
  workReleases,
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

/** The one search call per provider: the same calls (and so the same cache) Discover and the batch use. */
const SEARCHES: Record<CatalogueProviderName, (q: string) => Promise<CatalogueBook[]>> = {
  audiobookdb: (q) => searchAudiobookDbBooks(q),
  openlibrary: (q) => searchOpenLibrary(q),
  googlebooks: (q) => searchGoogleBooks(q),
  itunes: (q) => searchItunes(q),
};
/** A provider's results, or its own reason: one provider failing never fails another. */
async function settle(provider: CatalogueProviderName, q: string) {
  try {
    return { results: (await SEARCHES[provider](q)).map(result), error: null };
  } catch (error) {
    if (!(error instanceof CatalogueError)) throw error;
    return { results: [], error: error.message };
  }
}

/** The match page's answer: the link (with its duplicates), the batch's outcome, the recordings and (on AudiobookDB) the English releases of all the work's entries. */
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
  let releases: { id: string; bookId: string | null; narrators: string[]; lengthMs: number | null; asin: string | null; language: string | null; abridged: boolean | null; chapters: number }[] = [];
  let releasesError: string | null = null;
  if (link?.provider === "audiobookdb") {
    try {
      // The releases of every entry of the work: the main link's, then its duplicates' (#754).
      releases = (await workReleases(workId)).filter(englishRelease).map((release) => ({
        id: release.id,
        bookId: release.bookId,
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
  return { workId, title: work.title, author: work.author, query: matchQuery(work), link, links: providerLinks(workId), outcome: matchOutcome(workId), recordings, releases, releasesError };
}

export function registerCatalogueRoutes(app: FastifyInstance) {
  /**
   * Discover's book search (#721 part c2), for every account with the server's key: `{ books: CatalogueHit[] }`, each
   * with the work it opens for this user. A provider failure answers its reason (`failed`): 409 without a key, else 502.
   */
  const discoverQuery = z.object({ q: z.string().trim().min(2).max(150) });
  app.get("/api/discover/audiobookdb", async (req, reply) => {
    const { q } = discoverQuery.parse(req.query);
    try {
      return { books: await discoverAudiobookDb(currentUserId(req), q) };
    } catch (error) {
      return failed(reply, error);
    }
  });
  app.get("/api/discover/openlibrary", async (req, reply) => {
    const { q } = discoverQuery.parse(req.query);
    try {
      return { books: await discoverOpenLibrary(currentUserId(req), q) };
    } catch (error) {
      return failed(reply, error);
    }
  });
  app.post("/api/audiobookdb/test", async (req, reply) => {
    requireAdmin(req);
    try {
      return { ok: true, source: audiobookDbKey().source, ...(await testAudiobookDb()) };
    } catch (error) {
      return failed(reply, error);
    }
  });
  /**
   * `?provider=` names one of the four, and the answer is that provider's group alone, so the match page shows each
   * group as it arrives. Without it (older match pages) AudiobookDB and Open Library answer together, as before.
   */
  app.get("/api/catalogue/search", async (req) => {
    requireAdmin(req);
    const { q, provider } = z.object({ q: z.string().trim().min(2).max(200), provider: z.enum(CATALOGUE_PROVIDERS).optional() }).parse(req.query);
    if (provider) return { [provider]: await settle(provider, q) };
    const [audiobookdb, openlibrary] = await Promise.all([settle("audiobookdb", q), settle("openlibrary", q)]);
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
      .object({ provider: z.enum(CATALOGUE_PROVIDERS), id: z.string().trim().min(1).max(100), author: z.string().max(300).optional() })
      .parse(req.body ?? {});
    if (!(await workCatalogue(id))) return reply.code(404).send({ error: "This book is not on the server." });
    try {
      await linkWork(id, { provider: body.provider, id: body.id, author: body.author }, "manual");
    } catch (error) {
      return failed(reply, error);
    }
    return workCatalogue(id);
  });
  // An empty body or none, as older requests send it. `?provider=googlebooks|itunes` removes that link alone; without
  // it (or naming AudiobookDB or Open Library) the main link goes, as before.
  app.delete("/api/works/:id/catalogue", async (req, reply) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().min(1).max(300) }).parse(req.params);
    const { provider } = z.object({ provider: z.enum(CATALOGUE_PROVIDERS).optional() }).parse(req.query ?? {});
    if (!(await workCatalogue(id))) return reply.code(404).send({ error: "This book is not on the server." });
    if (provider && isExtraProvider(provider)) unlinkProvider(id, provider);
    else unlinkWork(id);
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
