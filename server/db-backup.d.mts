/** Types for `server/db-backup.mjs` (plain JavaScript, shared with `npm run backup`). */
export declare class BackupError extends Error {
  constructor(message: string, options?: { cause?: unknown });
}

/**
 * Copy `sourcePath` to `destinationPath` through SQLite's online backup API, verified with
 * PRAGMA integrity_check. Throws BackupError on any failure; the destination only exists for a
 * verified backup, and an existing destination is never replaced.
 */
export declare function backupDatabase(
  sourcePath: string,
  destinationPath: string,
): Promise<{ source: string; destination: string; bytes: number }>;
