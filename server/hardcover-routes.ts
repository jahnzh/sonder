import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  hardcoverState,
  testHardcover,
  configureHardcover,
  syncHardcover,
  importHardcoverBook,
  addHardcoverSeries,
  setHardcoverShelf,
  setHardcoverListMember,
  pullHardcoverPosition,
  hardcoverRecordingOptions,
  setHardcoverRecordingEdition,
  setHardcoverToken,
  hardcoverLinkedBook,
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
// Every route acts for the signed-in user's own Hardcover account (#15).
export function registerHardcoverRoutes(app: FastifyInstance) {
  app.get("/api/discover/series", async (req) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(300) }).parse(req.query);
    return hardcoverSeriesSearch(currentUserId(req), q);
  });
  app.get("/api/hardcover/series/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    return hardcoverSeriesPreview(currentUserId(req), id);
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
    const { refresh } = z.object({ refresh: z.coerce.boolean().optional() }).parse(req.query ?? {});
    // Revisiting a saved series refreshes the Hardcover catalogue by ID (#206).
    return refreshSavedHardcoverSeries(currentUserId(req), id, { force: !!refresh });
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
  app.get("/api/hardcover", async (req) => hardcoverState(currentUserId(req)));
  app.put("/api/hardcover/token", async (req) => {
    const { token } = z
      .object({ token: z.string().max(2000) })
      .parse(req.body);
    setHardcoverToken(currentUserId(req), token);
    return hardcoverState(currentUserId(req));
  });
  app.post("/api/hardcover/test", async (req) =>
    testHardcover(currentUserId(req)),
  );
  app.patch("/api/hardcover/config", async (req) => {
    const input = z
      .object({
        mode: z.enum(["off", "import", "two-way"]),
        syncLists: z.boolean(),
      })
      .parse(req.body);
    if (input.mode !== "off") await testHardcover(currentUserId(req));
    return configureHardcover(currentUserId(req), input.mode, input.syncLists);
  });
  app.post("/api/hardcover/sync", async (req) =>
    syncHardcover(currentUserId(req)),
  );
  app.post("/api/hardcover/books", async (req) => {
    const { id, workId } = z
      .object({
        id: z.number().int().positive(),
        workId: z.string().optional(),
      })
      .parse(req.body);
    // The work → Hardcover book match is shared, so only the admin can create or move one.
    // Anyone may re-import a work that already points at this book.
    if (workId && hardcoverLinkedBook(workId) !== id) requireAdmin(req);
    return importHardcoverBook(currentUserId(req), id, workId);
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
  app.patch("/api/hardcover/shelf", async (req) => {
    const { workId, statusId } = z
      .object({
        workId: z.string(),
        statusId: z.union([
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
          z.literal(5),
        ]),
      })
      .parse(req.body);
    return setHardcoverShelf(currentUserId(req), workId, statusId);
  });
  app.patch("/api/hardcover/lists/:id", async (req) => {
    const { id } = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(req.params);
    const { workId, included } = z
      .object({ workId: z.string(), included: z.boolean() })
      .parse(req.body);
    return setHardcoverListMember(currentUserId(req), id, workId, included);
  });
  app.post("/api/hardcover/progress/pull", async (req) => {
    const { workId, recordingId } = z
      .object({ workId: z.string(), recordingId: z.string() })
      .parse(req.body);
    return pullHardcoverPosition(currentUserId(req), workId, recordingId);
  });
  app.get("/api/hardcover/editions", async (req) => {
    const { workId, recordingId } = z
      .object({ workId: z.string(), recordingId: z.string() })
      .parse(req.query);
    return hardcoverRecordingOptions(currentUserId(req), workId, recordingId);
  });
  app.patch("/api/hardcover/edition", async (req) => {
    const { workId, recordingId, editionId } = z
      .object({
        workId: z.string(),
        recordingId: z.string(),
        editionId: z.number().int().positive().nullable(),
      })
      .parse(req.body);
    return setHardcoverRecordingEdition(
      currentUserId(req),
      workId,
      recordingId,
      editionId,
    );
  });
}
