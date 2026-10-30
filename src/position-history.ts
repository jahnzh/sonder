export type JumpKind = "seek" | "skip" | "chapter" | "play" | "hardcover" | "recording" | "source";

export type PositionEntry = {
  trackId: string;
  position: number;
  timestamp: number;
  kind: JumpKind;
};

export type PositionHistory = {
  recordingId: string;
  entries: PositionEntry[];
};

export const HISTORY_LIFETIME = 24 * 60 * 60 * 1000;
export const HISTORY_LIMIT = 20;
export const SKIP_WINDOW = 10 * 1000;

export function recentPositions(entries: PositionEntry[], now: number) {
  return entries.filter((entry) => now - entry.timestamp < HISTORY_LIFETIME).slice(-HISTORY_LIMIT);
}

export function recordPosition(entries: PositionEntry[], entry: PositionEntry) {
  const recent = recentPositions(entries, entry.timestamp);
  const previous = recent[recent.length - 1];
  if (
    entry.kind === "skip" &&
    previous?.kind === "skip" &&
    entry.timestamp - previous.timestamp <= SKIP_WINDOW
  ) return recent;
  return [...recent, entry].slice(-HISTORY_LIMIT);
}

export function popPosition(entries: PositionEntry[], now: number) {
  const recent = recentPositions(entries, now);
  return { entry: recent[recent.length - 1], entries: recent.slice(0, -1) };
}
