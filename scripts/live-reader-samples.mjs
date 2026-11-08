// Which mapped passages the live reader check samples and presses (#349).
// Only intervals longer than 4 s on the loaded file count; first, middle and last are sampled.
export function pickMappedIntervals(intervals, trackId) {
  const onTrack = intervals.filter((i) => i.trackId === trackId && i.end - i.start > 4);
  return [onTrack[0], onTrack[Math.floor(onTrack.length / 2)], onTrack.at(-1)].filter(Boolean);
}

// A sentence's midpoint is always inside the interval, so the reader highlights it even when
// playback paused in an unsynced gap before the seek.
export function intervalMiddle(interval) {
  return (interval.start + interval.end) / 2;
}
