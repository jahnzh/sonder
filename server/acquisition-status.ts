import { eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import { clearWorkMediaHoldsOfAcquisition } from "./work-media-state.ts";
import * as s from "./schema.ts";

export {
  ACQUISITION_STATUSES,
  ACTIVE_ACQUISITION_STATUSES,
  FINISHED_ACQUISITION_STATUSES,
  isActiveAcquisitionStatus,
  isFinishedAcquisitionStatus,
  type AcquisitionStatus,
} from "./acquisition-vocabulary.ts";
import type { AcquisitionStatus } from "./acquisition-vocabulary.ts";

type AcquisitionRow = typeof s.acquisitions.$inferInsert;
type StatusFields = Partial<
  Pick<
    AcquisitionRow,
    "error" | "progress" | "bookId" | "backend" | "remoteId" | "updatedAt"
  >
>;

/**
 * The one writer of `acquisitions.status` for an existing acquisition. Fields written
 * with the status (error, progress, …) go in `fields`; `updatedAt` is written only when
 * given, as each caller did before. Nothing has to be refreshed afterwards: a work's
 * media state is derived when read (`work-media-state.ts`). Reaching `ready` clears the
 * work's hold reason for every user of the acquisition, in the same transaction (ADR 0011).
 */
export function setAcquisitionStatus(
  id: string,
  status: AcquisitionStatus,
  fields: StatusFields = {},
) {
  sqlite.transaction(() => {
    db.update(s.acquisitions)
      .set({ ...fields, status })
      .where(eq(s.acquisitions.id, id))
      .run();
    if (status === "ready") clearWorkMediaHoldsOfAcquisition(id);
  })();
}

/** Record a new (or restarted, same hash) acquisition; every acquisition starts `checking`. */
export function startAcquisitionRecord(entry: Omit<AcquisitionRow, "status">) {
  const row = { ...entry, status: "checking" satisfies AcquisitionStatus };
  db.insert(s.acquisitions)
    .values(row)
    .onConflictDoUpdate({ target: s.acquisitions.hash, set: row })
    .run();
}
