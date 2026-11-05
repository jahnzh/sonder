import { eq } from "drizzle-orm";
import { db } from "../server/db.ts";
import * as s from "../server/schema.ts";
import {
  resetSeriesAcquisitionDeps,
  setSeriesAcquisitionDeps,
} from "../server/series-acquisition.ts";

const failOnce = new Set<string>();

export function installSeriesAcquisitionFixture() {
  resetSeriesAcquisitionDeps();
  setSeriesAcquisitionDeps({
    fetchEbooks: async (workId) => {
      const work = db
        .select()
        .from(s.works)
        .where(eq(s.works.id, workId))
        .get();
      if (work?.title === "Crossing Companion" && !failOnce.has(workId)) {
        failOnce.add(workId);
        throw new Error("fixture ebook fail");
      }
      return {
        downloaded: [{ id: "libgen-series-fixture", status: "held" as const }],
        skipped: null,
        failures: [] as string[],
      };
    },
  });
}
