export const SPEED_MIN = 0.5;
export const SPEED_MAX = 3;
export const SPEED_STEP = 0.05;
export const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2];
/** Device-local Dexie preference key for one recording's speed. */
export const recordingSpeedKey = (recordingId: string) =>
  `speed:${recordingId}`;
/** The single per-device speed saved by builds before per-recording speed. */
export const LEGACY_SPEED_KEY = "speed";
export function clampSpeed(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, value)) * 20) / 20;
}
export function stepSpeed(current: number, direction: 1 | -1) {
  return clampSpeed((clampSpeed(current) ?? 1) + direction * SPEED_STEP)!;
}
export function formatSpeed(speed: number) {
  return String(Number(speed.toFixed(2)));
}
/**
 * A recording's own speed wins, then the default from Settings, then the
 * device-wide speed older builds saved, so upgrading doesn't reset anyone to 1×.
 */
export function resolveSpeed({
  recording,
  preferred,
  legacy,
}: {
  recording?: unknown;
  preferred?: unknown;
  legacy?: unknown;
}) {
  return (
    clampSpeed(recording) ?? clampSpeed(preferred) ?? clampSpeed(legacy) ?? 1
  );
}
export function timeAtSpeed(seconds: number, speed: number) {
  return Math.max(0, seconds) / (speed > 0 ? speed : 1);
}
type RateElement = {
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};
export function applySpeed(el: RateElement, speed: number) {
  // load() resets playbackRate to defaultPlaybackRate, so both must carry the
  // speed or every chapter change falls back to 1×.
  el.defaultPlaybackRate = speed;
  el.playbackRate = speed;
  el.preservesPitch = true;
  // Older Safari only knows the prefixed property.
  el.webkitPreservesPitch = true;
}
export function mediaPositionState(el: {
  duration: number;
  currentTime: number;
  playbackRate: number;
}): MediaPositionState | null {
  if (!Number.isFinite(el.duration) || el.duration <= 0) return null;
  if (!Number.isFinite(el.playbackRate) || el.playbackRate <= 0) return null;
  return {
    duration: el.duration,
    playbackRate: el.playbackRate,
    position: Math.min(Math.max(0, el.currentTime || 0), el.duration),
  };
}
