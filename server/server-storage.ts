// The media drive as Settings › Library and storage shows it (spec #572, "Server storage"; #580): whether it is
// connected (`mediaMountProblem()`), and how much of it is used, from `statfs` of the media root. Read for the
// administrator's `GET /api/settings` only.
import { statfsSync } from "node:fs";
import { mediaMountProblem, mediaRoot } from "./storage.ts";

export type ServerStorage = { connected: boolean; usedBytes: number | null; totalBytes: number | null };

/** The fields of `fs.statfsSync` this reads (sizes in blocks of `bsize` bytes). */
export type StatfsSizes = { bsize: number; blocks: number; bfree: number };

export type StorageProbe = {
  /** Why the drive must not be written now, or null when it is the recorded drive. */
  problem?: () => string | null;
  statfs?: (path: string) => StatfsSizes;
  root?: string;
  /** Told why the sizes could not be read. */
  warn?: (message: string) => void;
};

/**
 * `connected` is `mediaMountProblem() === null`. The sizes are null when the drive is not connected (a `statfs` of
 * the media root would then measure the disk under it, not the drive) or when `statfs` cannot read them.
 */
export function serverStorage(probe: StorageProbe = {}): ServerStorage {
  const connected = (probe.problem ?? mediaMountProblem)() === null;
  if (!connected) return { connected, usedBytes: null, totalBytes: null };
  try {
    const sizes = (probe.statfs ?? statfsSync)(probe.root ?? mediaRoot);
    const totalBytes = Number(sizes.blocks) * Number(sizes.bsize);
    const usedBytes = (Number(sizes.blocks) - Number(sizes.bfree)) * Number(sizes.bsize);
    if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes) || totalBytes <= 0 || usedBytes < 0)
      return { connected, usedBytes: null, totalBytes: null };
    return { connected, usedBytes, totalBytes };
  } catch (error) {
    probe.warn?.(`The media drive's sizes could not be read: ${(error as Error).message}`);
    return { connected, usedBytes: null, totalBytes: null };
  }
}
