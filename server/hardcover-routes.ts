import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { acquire } from "./acquisitions.ts";
import { setWorkCompletionOverride } from "./library-origin.ts";
import { retryWorkMediaAcquisition } from "./series-membership.ts";
import { currentUserId } from "./users.ts";

/**
 * The Hardcover routes removed with its sync (#721 part d): the state, token, test, sync mode, sync, the Change
 * match import, shelf, lists, position pull and audio edition; and with its catalogue (#721 parts b and c2): the
 * book search, a book's series and the series add by name. An older client that still calls one gets this clear
 * answer (410, `hardcover_removed`) instead of a 404, and never a cached one. The series routes, on AudiobookDB's
 * ids, are in `series-routes.ts`.
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
  ["GET", "/api/discover/hardcover"],
  ["GET", "/api/hardcover/books/:id/series"],
  ["POST", "/api/hardcover/series"],
] as const;
export const HARDCOVER_REMOVED_ERROR =
  "Hardcover is no longer part of Sonder: its sync and settings were removed. Reload Sonder to get the current version.";

export function registerHardcoverRoutes(app: FastifyInstance) {
  for (const [method, url] of REMOVED_HARDCOVER_ROUTES)
    app.route({
      method,
      url,
      handler: async (_req, reply) =>
        reply.code(410).header("Cache-Control", "private, no-store").send({ code: "hardcover_removed", error: HARDCOVER_REMOVED_ERROR }),
    });
  // Two work routes that were registered here and never read Hardcover.
  app.patch("/api/works/:workId/completion", async (req) => {
    const { workId } = z.object({ workId: z.string().min(1) }).parse(req.params);
    const { status } = z
      .object({ status: z.enum(["finished", "unread", "derived"]) })
      .parse(req.body ?? {});
    setWorkCompletionOverride(currentUserId(req), workId, status);
    return { ok: true };
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
