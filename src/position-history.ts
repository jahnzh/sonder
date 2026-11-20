// "hardcover" is a jump an earlier build made with Use Hardcover position; nothing makes one since #721 part d, but
// places kept on this device (24 hours) may still name it.
// "device" is the move a paused player makes to a newer place saved on another device (#773).
export type JumpKind = "seek" | "skip" | "chapter" | "play" | "hardcover" | "recording" | "source" | "device";

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

export function peekPosition(entries: PositionEntry[], now: number) {
  return recentPositions(entries, now).at(-1);
}

/** Removes one entry (the newest match), keeping any recorded since it was read. */
export function dropPosition(entries: PositionEntry[], target: PositionEntry, now: number) {
  const recent = recentPositions(entries, now);
  let index = -1;
  recent.forEach((entry, at) => {
    if (entry.timestamp === target.timestamp && entry.trackId === target.trackId &&
        entry.position === target.position && entry.kind === target.kind) index = at;
  });
  return index < 0 ? recent : recent.filter((_, at) => at !== index);
}

export type UndoPlan =
  | { action: "seek" | "play" }
  | { action: "keep"; reason: "recording-changed" | "track-missing" | "no-source" };

/** What an undo can do with the newest entry; anything but a restore leaves the entry in place. */
export function planUndo(
  entry: PositionEntry,
  context: { recordingId: string; trackIds: string[]; current: { recordingId: string; trackId?: string } | null; hasSource: boolean },
): UndoPlan {
  if (context.current?.recordingId !== context.recordingId) return { action: "keep", reason: "recording-changed" };
  if (!context.trackIds.includes(entry.trackId)) return { action: "keep", reason: "track-missing" };
  if (context.current.trackId === entry.trackId) return context.hasSource ? { action: "seek" } : { action: "keep", reason: "no-source" };
  return { action: "play" };
}

/** A cross-track restore counts only once the player holds the entry's track of the same recording. */
export function restored(entry: PositionEntry, recordingId: string, current: { recordingId: string; trackId?: string } | null) {
  return current?.recordingId === recordingId && current.trackId === entry.trackId;
}

/**
 * Runs jobs for one key strictly in the order they were queued, so a read sees
 * every write queued before it. A failed job does not block the ones after it.
 */
export function serialQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, job: () => Promise<T>): Promise<T> {
      const result = (tails.get(key) ?? Promise.resolve()).then(job);
      const tail = result.catch(() => {});
      tails.set(key, tail);
      void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return result;
    },
    settled(key: string): Promise<void> {
      return (tails.get(key) ?? Promise.resolve()).then(() => {});
    },
  };
}
