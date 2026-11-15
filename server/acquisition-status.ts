import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import * as s from "./schema.ts";

/**
 * The status vocabulary of an acquisition (a release being brought into the library).
 * Copies to the server have their own vocabulary in `downloads.ts` (ADR 0011).
 */
export const ACQUISITION_STATUSES = [
  "checking",
  "preparing",
  "downloading",
  "paused",
  "ready",
  "error",
] as const;
export type AcquisitionStatus = (typeof ACQUISITION_STATUSES)[number];

/** Statuses of an acquisition that is still on its way: the work shows as queued. */
export const ACTIVE_ACQUISITION_STATUSES = [
  "checking",
  "preparing",
  "downloading",
  "paused",
] as const satisfies readonly AcquisitionStatus[];

/** Statuses after which an acquisition no longer changes on its own. */
export const FINISHED_ACQUISITION_STATUSES = [
  "ready",
  "error",
] as const satisfies readonly AcquisitionStatus[];

const active = new Set<string>(ACTIVE_ACQUISITION_STATUSES);
const finished = new Set<string>(FINISHED_ACQUISITION_STATUSES);

export function isActiveAcquisitionStatus(status: string) {
  return active.has(status);
}

export function isFinishedAcquisitionStatus(status: string) {
  return finished.has(status);
}

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
 * media state is derived when read (`work-media-state.ts`).
 */
export function setAcquisitionStatus(
  id: string,
  status: AcquisitionStatus,
  fields: StatusFields = {},
) {
  db.update(s.acquisitions)
    .set({ ...fields, status })
    .where(eq(s.acquisitions.id, id))
    .run();
}

/** Record a new (or restarted, same hash) acquisition; every acquisition starts `checking`. */
export function startAcquisitionRecord(entry: Omit<AcquisitionRow, "status">) {
  const row = { ...entry, status: "checking" satisfies AcquisitionStatus };
  db.insert(s.acquisitions)
    .values(row)
    .onConflictDoUpdate({ target: s.acquisitions.hash, set: row })
    .run();
}
