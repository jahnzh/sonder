import { eq } from "drizzle-orm";
import { db } from "../server/db.ts";
import * as s from "../server/schema.ts";
import {
  resetSeriesAcquisitionDeps,
  setSeriesAcquisitionDeps,
} from "../server/series-acquisition.ts";

// Each work's first ebook search fails and the next one succeeds, then the next fails again: a spec that saves the
// series and retries sees the same failure and recovery when it runs again on the same server.
const failNext = new Map<string, boolean>();

export function installSeriesAcquisitionFixture() {
  resetSeriesAcquisitionDeps();
  setSeriesAcquisitionDeps({
    fetchEbooks: async (workId) => {
      const work = db
        .select()
        .from(s.works)
        .where(eq(s.works.id, workId))
        .get();
      if (work?.title === "Crossing Companion") {
        const fail = failNext.get(workId) ?? true;
        failNext.set(workId, !fail);
        if (fail) throw new Error("fixture ebook fail");
      }
      return {
        downloaded: [{ id: "libgen-series-fixture", status: "held" as const }],
        skipped: null,
        failures: [] as string[],
      };
    },
  });
}
