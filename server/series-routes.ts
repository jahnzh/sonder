// The series routes (#721 part b): series on AudiobookDB's text ids. The paths are the ones the client has always
// used; an older build that sends a series or book id as a number is answered as if it had sent the text.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  acknowledgeCatalogueSeriesWorks,
  listSavedCatalogueSeries,
  previewCatalogueSeries,
  refreshSavedCatalogueSeries,
  saveCatalogueSeries,
  searchCatalogueSeries,
} from "./series-catalogue.ts";
import { retrySeriesWorkAcquisition } from "./series-acquisition.ts";
import { searchSeriesWorkReleases, selectSeriesWorkRelease } from "./series-release-search.ts";
import {
  chooseSeriesCandidate,
  noteOwnerSelect,
  resumeSeriesSearches,
  searchSeriesWorkAgain,
  searchSeriesWorkNow,
  seriesWorkSearch,
  skipSeriesWork,
  stopSeriesSearches,
  withSeriesQueue,
} from "./series-queue.ts";
import { previewSeriesRemoval, removeSavedSeries } from "./series-removal.ts";
import { currentUserId, requireAdmin } from "./users.ts";

/** A series or book id: AudiobookDB's text, `openlibrary:<work>`, or a number from an older client. */
export const catalogueId = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .pipe(z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/));
const language = z.string().trim().min(1).max(100).optional();
const params = z.object({ id: catalogueId });
const workParams = z.object({ id: catalogueId, bookId: catalogueId });
/** A search's kind; absent (both kinds), as an older or a newer client may send an empty body. */
const optionalKind = z.object({ kind: z.enum(["audio", "ebook"]).optional() }).passthrough();

export function registerSeriesRoutes(app: FastifyInstance) {
  app.get("/api/discover/series", async (req) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(300) }).parse(req.query);
    return searchCatalogueSeries(currentUserId(req), q);
  });
  // A series that is not saved, as its page and the Add sheet show it. The Hardcover path is an older client's.
  const preview = async (req: FastifyRequest) => {
    const { id } = params.parse(req.params);
    const query = z.object({ language }).parse(req.query ?? {});
    return previewCatalogueSeries(currentUserId(req), id, query.language);
  };
  app.get("/api/discover/series/:id", preview);
  app.get("/api/hardcover/series/:id", preview);
  app.get("/api/series", async (req) => listSavedCatalogueSeries(currentUserId(req)));
  app.get("/api/series/:id/removal", async (req) => previewSeriesRemoval(currentUserId(req), params.parse(req.params).id));
  app.get("/api/series/:id", async (req) => {
    const { id } = params.parse(req.params);
    const query = z.object({ refresh: z.coerce.boolean().optional(), language }).parse(req.query ?? {});
    const userId = currentUserId(req);
    // The queue's run for the series and each book's place in it (#898), over the saved series' answer.
    return withSeriesQueue(userId, id, await refreshSavedCatalogueSeries(userId, id, { force: !!query.refresh, language: query.language }));
  });
  app.post("/api/series", async (req) => {
    const body = z
      .object({ id: catalogueId, bookIds: z.array(catalogueId).max(1000), searchAudio: z.boolean().optional(), searchEbooks: z.boolean().optional() })
      .parse(req.body ?? {});
    return saveCatalogueSeries(currentUserId(req), body.id, body.bookIds, { searchAudio: body.searchAudio, searchEbooks: body.searchEbooks });
  });
  app.delete("/api/series/:id", async (req) => {
    const { id } = params.parse(req.params);
    const body = z.object({ bookIds: z.array(catalogueId).max(1000).optional() }).parse(req.body ?? {});
    const bookIds = body.bookIds ?? [];
    if (bookIds.length) requireAdmin(req);
    return await removeSavedSeries(currentUserId(req), id, bookIds);
  });
  app.post("/api/series/:id/works/:bookId/acquisition/retry", async (req) => {
    const { id, bookId } = workParams.parse(req.params);
    const { kind } = z.object({ kind: z.enum(["audio", "ebook"]) }).parse(req.body ?? {});
    return retrySeriesWorkAcquisition(currentUserId(req), id, bookId, kind);
  });
  app.get("/api/series/:id/works/:bookId/releases/search", async (req) => {
    requireAdmin(req);
    const { id, bookId } = workParams.parse(req.params);
    const { q, page } = z.object({ q: z.string().min(2).max(150), page: z.coerce.number().int().min(1).max(100).default(1) }).parse(req.query);
    return searchSeriesWorkReleases(currentUserId(req), id, bookId, q, page);
  });
  app.post("/api/series/:id/works/:bookId/releases/select", async (req) => {
    requireAdmin(req);
    const { id, bookId } = workParams.parse(req.params);
    const body = z
      .object({ source: z.enum(["abb", "prowlarr"]), id: z.string().min(1).max(300), replaceActive: z.boolean().optional(), confirmExistingAudio: z.boolean().optional() })
      .parse(req.body ?? {});
    const result = await selectSeriesWorkRelease(currentUserId(req), id, bookId, body);
    noteOwnerSelect(currentUserId(req), id, bookId, { source: body.source, id: body.id });
    return result;
  });
  // The series queue on the Series page (#898): a book's searches with what was found and chosen, and the owner's
  // steering. The administrator's, as the release select is.
  app.get("/api/series/:id/works/:bookId/acquisition", async (req) => {
    requireAdmin(req);
    const { id, bookId } = workParams.parse(req.params);
    return seriesWorkSearch(currentUserId(req), id, bookId);
  });
  app.post("/api/series/:id/works/:bookId/acquisition/now", async (req) => {
    requireAdmin(req);
    const { id, bookId } = workParams.parse(req.params);
    return searchSeriesWorkNow(currentUserId(req), id, bookId, optionalKind.parse(req.body ?? {}).kind);
  });
  app.post("/api/series/:id/works/:bookId/acquisition/again", async (req) => {
    requireAdmin(req);
    const { id, bookId } = workParams.parse(req.params);
    return searchSeriesWorkAgain(currentUserId(req), id, bookId, optionalKind.parse(req.body ?? {}).kind ?? "audio");
  });
  app.post("/api/series/:id/works/:bookId/acquisition/skip", async (req) => {
    requireAdmin(req);
    const { id, bookId } = workParams.parse(req.params);
    return skipSeriesWork(currentUserId(req), id, bookId, optionalKind.parse(req.body ?? {}).kind);
  });
  app.post("/api/series/:id/works/:bookId/acquisition/choose", async (req) => {
    requireAdmin(req);
    const { id, bookId } = workParams.parse(req.params);
    const body = z
      .object({ key: z.string().min(1).max(400).optional(), source: z.enum(["abb", "prowlarr"]).optional(), id: z.string().min(1).max(300).optional() })
      .refine((value) => !!value.key || (!!value.source && !!value.id), "Name the release by its key, or by its source and id.")
      .parse(req.body ?? {});
    return chooseSeriesCandidate(currentUserId(req), id, bookId, body);
  });
  app.post("/api/series/:id/queue/stop", async (req) => {
    requireAdmin(req);
    return stopSeriesSearches(currentUserId(req), params.parse(req.params).id);
  });
  app.post("/api/series/:id/queue/resume", async (req) => {
    requireAdmin(req);
    return resumeSeriesSearches(currentUserId(req), params.parse(req.params).id);
  });
  app.post("/api/series/:id/ack", async (req) => {
    const { id } = params.parse(req.params);
    const { bookIds } = z.object({ bookIds: z.array(catalogueId).max(1000).default([]) }).parse(req.body ?? {});
    return acknowledgeCatalogueSeriesWorks(currentUserId(req), id, bookIds);
  });
}
