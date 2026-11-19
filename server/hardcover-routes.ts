import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addHardcoverSeries,
  hardcoverSeriesSearch,
  hardcoverSeriesPreview,
  saveHardcoverSeries,
  listSavedHardcoverSeries,
  refreshSavedHardcoverSeries,
  acknowledgeSeriesWorks,
  hardcoverBook,
  setWorkCompletionOverride,
} from "./hardcover.ts";
import { acquire } from "./acquisitions.ts";
import { retryWorkMediaAcquisition } from "./series-membership.ts";
import { retrySeriesWorkAcquisition } from "./series-acquisition.ts";
import {
  searchSeriesWorkReleases,
  selectSeriesWorkRelease,
} from "./series-release-search.ts";
import {
  previewSeriesRemoval,
  removeSavedHardcoverSeries,
} from "./series-removal.ts";
import { currentUserId, requireAdmin } from "./users.ts";

/**
 * The Hardcover routes removed with its sync (#721 part d): the state, token, test, sync mode, sync, the Change
 * match import, shelf, lists, position pull and audio edition. An older client that still calls one gets this
 * clear answer (410, `hardcover_removed`) instead of a 404, and never a cached one.
 */
export const REMOVED_HARDCOVER_ROUTES = [
  ["GET", "/api/hardcover"],
  ["PUT", "/api/hardcover/token"],
  ["POST", "/api/hardcover/test"],
  ["PATCH", "/api/hardcover/config"],
  ["POST", "/api/hardcover/sync"],
  ["POST", "/api/hardcover/books"],
  ["PATCH", "/api/hardcover/shelf"],
  ["PATCH", "/api/hardcover/lists/:id"],
  ["POST", "/api/hardcover/progress/pull"],
  ["GET", "/api/hardcover/editions"],
  ["PATCH", "/api/hardcover/edition"],
] as const;
export const HARDCOVER_REMOVED_ERROR =
  "Hardcover is no longer part of Sonder: its sync and settings were removed. Reload Sonder to get the current version.";

// The series routes below still read Hardcover's catalogue until part b moves them to AudiobookDB (#721).
export function registerHardcoverRoutes(app: FastifyInstance) {
  for (const [method, url] of REMOVED_HARDCOVER_ROUTES)
    app.route({
      method,
      url,
      handler: async (_req, reply) =>
        reply.code(410).header("Cache-Control", "private, no-store").send({ code: "hardcover_removed", error: HARDCOVER_REMOVED_ERROR }),
    });
  app.get("/api/discover/series", async (req) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(300) }).parse(req.query);
    return hardcoverSeriesSearch(currentUserId(req), q);
  });
  app.get("/api/hardcover/series/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { language } = z.object({ language: z.string().trim().min(1).max(100).optional() }).parse(req.query ?? {});
    return hardcoverSeriesPreview(currentUserId(req), id, language);
  });
  app.get("/api/hardcover/books/:id/series", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const book = await hardcoverBook(currentUserId(req), id);
    return book.book_series.flatMap((entry) => entry.series?.id ? [{ id: entry.series.id, name: entry.series.name, position: entry.position }] : []);
  });
  app.get("/api/series", async (req) => listSavedHardcoverSeries(currentUserId(req)));
  app.get("/api/series/:id/removal", async (req) => {
    const { id } = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(req.params);
    return previewSeriesRemoval(currentUserId(req), id);
  });
  app.get("/api/series/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { refresh, language } = z.object({ refresh: z.coerce.boolean().optional(), language: z.string().trim().min(1).max(100).optional() }).parse(req.query ?? {});
    // Revisiting a saved series refreshes the Hardcover catalogue by ID (#206).
    return refreshSavedHardcoverSeries(currentUserId(req), id, { force: !!refresh, language });
  });
  app.post("/api/series", async (req) => {
    const body = z
      .object({
        id: z.number().int().positive(),
        bookIds: z.array(z.number().int().positive()).max(1000),
        searchAudio: z.boolean().optional(),
        searchEbooks: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    return saveHardcoverSeries(currentUserId(req), body.id, body.bookIds, {
      searchAudio: body.searchAudio,
      searchEbooks: body.searchEbooks,
    });
  });
  app.delete("/api/series/:id", async (req) => {
    const { id } = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = z
      .object({
        bookIds: z.array(z.number().int().positive()).max(1000).optional(),
      })
      .parse(req.body ?? {});
    const bookIds = body.bookIds ?? [];
    if (bookIds.length) requireAdmin(req);
    return await removeSavedHardcoverSeries(currentUserId(req), id, bookIds);
  });
  app.post("/api/series/:id/works/:bookId/acquisition/retry", async (req) => {
    const { id, bookId } = z
      .object({
        id: z.coerce.number().int().positive(),
        bookId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const { kind } = z.object({ kind: z.enum(["audio", "ebook"]) }).parse(req.body ?? {});
    return retrySeriesWorkAcquisition(
      currentUserId(req),
      id,
      bookId,
      kind,
    );
  });
  app.get("/api/series/:id/works/:bookId/releases/search", async (req) => {
    requireAdmin(req);
    const { id, bookId } = z
      .object({
        id: z.coerce.number().int().positive(),
        bookId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const { q, page } = z
      .object({
        q: z.string().min(2).max(150),
        page: z.coerce.number().int().min(1).max(100).default(1),
      })
      .parse(req.query);
    return searchSeriesWorkReleases(currentUserId(req), id, bookId, q, page);
  });
  app.post("/api/series/:id/works/:bookId/releases/select", async (req) => {
    requireAdmin(req);
    const { id, bookId } = z
      .object({
        id: z.coerce.number().int().positive(),
        bookId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z
      .object({
        source: z.enum(["abb", "prowlarr"]),
        id: z.string().min(1).max(300),
        replaceActive: z.boolean().optional(),
        confirmExistingAudio: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    return selectSeriesWorkRelease(currentUserId(req), id, bookId, body);
  });
  app.post("/api/series/:id/ack", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { bookIds } = z.object({ bookIds: z.array(z.number().int().positive()).max(1000).default([]) }).parse(req.body ?? {});
    return acknowledgeSeriesWorks(currentUserId(req), id, bookIds);
  });
  app.patch("/api/works/:workId/completion", async (req) => {
    const { workId } = z.object({ workId: z.string().min(1) }).parse(req.params);
    const { status } = z
      .object({ status: z.enum(["finished", "unread", "derived"]) })
      .parse(req.body ?? {});
    setWorkCompletionOverride(currentUserId(req), workId, status);
    return { ok: true };
  });
  app.post("/api/hardcover/series", async (req) => {
    const { name } = z
      .object({ name: z.string().min(1).max(300) })
      .parse(req.body);
    return addHardcoverSeries(currentUserId(req), name);
  });
  app.post("/api/works/:workId/media/retry", async (req) => {
    const { workId } = z
      .object({ workId: z.string().min(1) })
      .parse(req.params);
    return retryWorkMediaAcquisition(
      currentUserId(req),
      workId,
      (magnet, metadata) => acquire(magnet, metadata),
    );
  });

}
