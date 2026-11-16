/** The pure part of the pause switches: which loops can be paused, what pausing does, and what locks it. */
export const PAUSABLE_PROCESSES = [
  "acquisitions",
  "server-copies",
  "series-acquisition",
  "hardcover-sync",
  "alignment",
  "ebook-set",
  "backups",
] as const;
export type PausableProcess = (typeof PAUSABLE_PROCESSES)[number];

/**
 * What pausing does and does not stop, in the words shown next to the switch. Each sentence is the design's tooltip of
 * the same queue (`docs/design/redesign/tools/tips.mjs`: downloadQueue, copies, seriesSearch, hardcoverSync, syncQueue,
 * ebookChecks, backups); a test keeps the two identical. The server cannot import the design, so the words live here.
 */
export const PAUSE_EFFECT: Record<PausableProcess, string> = {
  acquisitions:
    "Off: Sonder stops checking downloads, so finished ones do not join the library. They keep downloading in the torrent client.",
  "server-copies": "Off: no new copy to the server starts. One that is running finishes.",
  "series-acquisition": "Off: no new search or download for a series starts.",
  "hardcover-sync":
    "Off: your changes are still saved, but nothing is sent to Hardcover until it is on again. Sync now still works.",
  alignment: "Off: no new reading sync starts. One that is running finishes.",
  "ebook-set":
    "Off: no new check of an ebook against the narration starts. One that is running finishes. Turning the reading sync queue off holds these checks too.",
  backups: "Off: no new daily backup starts. One that is running finishes. A deploy still makes its own backup.",
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
