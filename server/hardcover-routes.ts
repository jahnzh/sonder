import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  hardcoverState,
  testHardcover,
  configureHardcover,
  syncHardcover,
  importHardcoverBook,
  setHardcoverShelf,
  setHardcoverListMember,
  pullHardcoverPosition,
  hardcoverRecordingOptions,
  setHardcoverRecordingEdition,
  setHardcoverToken,
  hardcoverLinkedBook,
} from "./hardcover.ts";
import { currentUserId, requireAdmin } from "./users.ts";
// Every route acts for the signed-in user's own Hardcover account (#15).
export function registerHardcoverRoutes(app: FastifyInstance) {
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
