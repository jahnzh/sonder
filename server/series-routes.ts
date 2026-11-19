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
    return refreshSavedCatalogueSeries(currentUserId(req), id, { force: !!query.refresh, language: query.language });
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
    return selectSeriesWorkRelease(currentUserId(req), id, bookId, body);
  });
  app.post("/api/series/:id/ack", async (req) => {
    const { id } = params.parse(req.params);
    const { bookIds } = z.object({ bookIds: z.array(catalogueId).max(1000).default([]) }).parse(req.body ?? {});
    return acknowledgeCatalogueSeriesWorks(currentUserId(req), id, bookIds);
  });
}
