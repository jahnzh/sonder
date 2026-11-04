import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import * as s from "./schema.ts";
import { requireAdmin } from "./users.ts";
import {
  fetchTopKIntoEbookSet,
  reevaluateEbookSetForWork,
} from "./ebook-set.ts";
import {
  getEbookSetPresentation,
  setDefaultEbookOverride,
} from "./ebook-set-consensus.ts";

export function registerEbookSetRoutes(app: FastifyInstance) {
  app.get("/api/works/:workId/ebook-set", async (req) => {
    const { workId } = req.params as { workId: string };
    if (!db.select().from(s.works).where(eq(s.works.id, workId)).get())
      throw new Error("The selected book could not be found.");
    return getEbookSetPresentation(workId);
  });

  app.patch("/api/works/:workId/ebook-set/default", async (req) => {
    requireAdmin(req);
    const { workId } = req.params as { workId: string };
    const { ebookId } = z
      .object({ ebookId: z.string().nullable() })
      .parse(req.body ?? {});
    return setDefaultEbookOverride(workId, ebookId);
  });

  app.post("/api/works/:workId/ebook-set/fetch", async (req) => {
    requireAdmin(req);
    const { workId } = req.params as { workId: string };
    const { source } = z
      .object({ source: z.enum(["libgen"]).default("libgen") })
      .parse(req.body ?? {});
    return fetchTopKIntoEbookSet(workId, source);
  });

  app.post("/api/works/:workId/ebook-set/reevaluate", async (req) => {
    requireAdmin(req);
    const { workId } = req.params as { workId: string };
    return reevaluateEbookSetForWork(workId);
  });
}

export async function afterRecordingAvailableForWork(workId: string) {
  await reevaluateEbookSetForWork(workId);
}
