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
} from "./hardcover.ts";
export function registerHardcoverRoutes(app: FastifyInstance) {
  app.get("/api/hardcover", async () => hardcoverState());
  app.post("/api/hardcover/test", async () => testHardcover());
  app.patch("/api/hardcover/config", async (req) => {
    const input = z
      .object({
        mode: z.enum(["off", "import", "two-way"]),
        syncLists: z.boolean(),
      })
      .parse(req.body);
    if (input.mode !== "off") await testHardcover();
    return configureHardcover(input.mode, input.syncLists);
  });
  app.post("/api/hardcover/sync", async () => syncHardcover());
  app.post("/api/hardcover/books", async (req) => {
    const { id, workId } = z
      .object({
        id: z.number().int().positive(),
        workId: z.string().optional(),
      })
      .parse(req.body);
    return importHardcoverBook(id, workId);
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
    return setHardcoverShelf(workId, statusId);
  });
  app.patch("/api/hardcover/lists/:id", async (req) => {
    const { id } = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(req.params);
    const { workId, included } = z
      .object({ workId: z.string(), included: z.boolean() })
      .parse(req.body);
    return setHardcoverListMember(id, workId, included);
  });
  app.post("/api/hardcover/progress/pull", async (req) => {
    const { workId, recordingId } = z
      .object({ workId: z.string(), recordingId: z.string() })
      .parse(req.body);
    return pullHardcoverPosition(workId, recordingId);
  });
  app.get("/api/hardcover/editions", async (req) => {
    const { workId, recordingId } = z
      .object({ workId: z.string(), recordingId: z.string() })
      .parse(req.query);
    return hardcoverRecordingOptions(workId, recordingId);
  });
  app.patch("/api/hardcover/edition", async (req) => {
    const { workId, recordingId, editionId } = z
      .object({
        workId: z.string(),
        recordingId: z.string(),
        editionId: z.number().int().positive().nullable(),
      })
      .parse(req.body);
    return setHardcoverRecordingEdition(workId, recordingId, editionId);
  });
}
