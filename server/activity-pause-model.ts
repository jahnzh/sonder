/** The pure part of the pause switches: which loops can be paused, what pausing does, and what locks it. */
export const PAUSABLE_PROCESSES = [
  "acquisitions",
  "server-copies",
  "series-acquisition",
  "hardcover-sync",
  "alignment",
  "backups",
] as const;
export type PausableProcess = (typeof PAUSABLE_PROCESSES)[number];

/** What pausing does and does not stop, in the words shown next to the switch. */
export const PAUSE_EFFECT: Record<PausableProcess, string> = {
  acquisitions:
    "Sonder stops checking downloads, so finished torrents are not imported. The torrents keep downloading in the torrent client.",
  "server-copies": "No new copy to the server starts. A copy already running finishes.",
  "series-acquisition": "No new series search or download starts.",
  "hardcover-sync":
    "Your changes keep being saved, but nothing is sent to Hardcover until you resume. Sync now still works.",
  alignment: "No new alignment job starts. A job already running finishes.",
  backups: "No new daily database backup starts. A backup already running finishes. Deploys still make their own backups.",
};

/** An environment flag that disables the loop for good; the UI shows it and refuses to toggle it. */
const ENVIRONMENT_FLAG: Partial<Record<PausableProcess, string>> = {
  "series-acquisition": "SONDER_SKIP_SERIES_ACQUISITION",
};

export const isPausable = (id: string): id is PausableProcess => (PAUSABLE_PROCESSES as readonly string[]).includes(id);

export function lockedByEnvironment(id: PausableProcess, env: NodeJS.ProcessEnv = process.env) {
  const flag = ENVIRONMENT_FLAG[id];
  return !!flag && env[flag] === "1";
}
