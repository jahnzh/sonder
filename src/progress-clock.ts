// Preserve the order of local actions when the wall clock moves backwards.
export function createProgressClock() {
  const last = new Map<string, number>();
  return (recordingId: string, now: number, known = 0) => {
    const timestamp = Math.max(now, known + 1, (last.get(recordingId) ?? 0) + 1);
    last.set(recordingId, timestamp);
    return timestamp;
  };
}
