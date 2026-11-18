/**
 * The status vocabulary of an acquisition (a release being brought into the library).
 * Copies to the server have their own vocabulary in `downloads.ts` (ADR 0011).
 *
 * This file opens no database, so scripts can use it without the server's `db.ts`;
 * `acquisition-status.ts` re-exports it next to the one status writer.
 */
export const ACQUISITION_STATUSES = [
  "checking",
  "preparing",
  "downloading",
  "paused",
  "ready",
  "error",
  // Cancelled from Activity (#716): the torrent was removed from the client; nothing is fetched or imported again.
  "cancelled",
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
  "cancelled",
] as const satisfies readonly AcquisitionStatus[];

const active = new Set<string>(ACTIVE_ACQUISITION_STATUSES);
const finished = new Set<string>(FINISHED_ACQUISITION_STATUSES);

export function isActiveAcquisitionStatus(status: string) {
  return active.has(status);
}

export function isFinishedAcquisitionStatus(status: string) {
  return finished.has(status);
}
