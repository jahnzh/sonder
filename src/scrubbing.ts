export function seekSecond(value: number, duration: number) {
  // Chapter offsets can lose a fraction of a millisecond when the media element
  // rounds an absolute timestamp. Keep the displayed second stable after seeking.
  return Math.max(0, Math.min(Math.floor(duration), Math.floor(value + 0.001)));
}
export function seekSensitivity(distance: number) {
  return 1 / (1 + Math.max(0, distance) / 48);
}
export function scrubPosition(
  value: number,
  deltaX: number,
  distance: number,
  duration: number,
  width: number,
) {
  return Math.max(
    0,
    Math.min(
      duration,
      value +
        ((deltaX * duration) / Math.max(1, width)) * seekSensitivity(distance),
    ),
  );
}
