// A load's place is confirmed where the element lands, not where it was asked to go (#593 fix round).
//
// A device copy plays from a Blob of its 4 MiB chunks. Firefox reads such a multi-part Blob only forward: a seek
// past what it has read so far lands at the end of the buffered range (a seek to 40 s ended at 4 to 16 s), and
// `currentTime` reports that place from the seek's `timeupdate` on, so Plays from, a skip or the next save moved
// the listening place. Once the bytes are read the same seek lands where it is aimed. The player therefore
// keeps the load's target as the place until a seek is seen to land within `LANDING_TOLERANCE` of it: while the
// target is not buffered yet it looks again every `LANDING_RECHECK_MS` (no media event reports that the buffered
// range grew: `progress` comes before it does), and seeks again once it is, at most `LANDING_TRIES` times.

export type Landing = { generation: number; target: number; tries: number; since: number };

/** How far, in seconds, a landed seek may be from its target and still count; playback moves a little meanwhile. */
export const LANDING_TOLERANCE = 1;
/** How many times a missed landing is sought again before the element's place is taken as it is. */
export const LANDING_TRIES = 3;
/** How often a landing short of a target not read yet looks again. */
export const LANDING_RECHECK_MS = 250;
/** How long it keeps looking on its own; after that only the element's events look again, and the target stays held. */
export const LANDING_WAIT_MS = 60_000;

export type LandingRead = {
  generation: number;
  seeking: boolean;
  currentTime: number;
  /** Whether the element has buffered the bytes at the landing's target. */
  covers: (target: number) => boolean;
  now: number;
};

export type LandingStep =
  /** Nothing is held: a newer load, or no load's seek. */
  | { action: "none" }
  /** The seek is still running, or its target is not read yet; `recheck` asks to look again after `LANDING_RECHECK_MS`. */
  | { action: "wait"; recheck: boolean }
  /** The seek landed away from its target: seek to it again. */
  | { action: "reseek"; target: number }
  /** The seek landed (or the tries are spent): the element's place is the place again. */
  | { action: "done" };

export function landingStep(landing: Landing | null, read: LandingRead): LandingStep {
  if (!landing || landing.generation !== read.generation) return { action: "none" };
  if (read.seeking) return { action: "wait", recheck: false };
  if (!Number.isFinite(read.currentTime)) return { action: "wait", recheck: false };
  if (Math.abs(read.currentTime - landing.target) <= LANDING_TOLERANCE) return { action: "done" };
  // Short of a target not read yet: a seek now would land at the same buffered end.
  if (!read.covers(landing.target)) return { action: "wait", recheck: read.now - landing.since < LANDING_WAIT_MS };
  if (landing.tries < LANDING_TRIES) return { action: "reseek", target: landing.target };
  return { action: "done" };
}

/** The listening place while a load's seek has not been seen to land: its target; otherwise the element's place. */
export function heldPosition(landing: Landing | null, generation: number, currentTime: number): number {
  return landing && landing.generation === generation ? landing.target : currentTime;
}

/**
 * The element is sent to `soughtTo` while a load's seek is held (#730). The landing's own reseeks go to its target
 * and leave it as it is. Any other seek, the player's or one made on the element itself (the live checks seek it so),
 * replaces the load's: the landing holds and confirms that place from now on, with its own tries. Kept on the old
 * target, the held place stayed the place: a paused seek left the reader on the held passage, or the landing sought
 * back to it.
 */
export function landingSought(landing: Landing | null, generation: number, soughtTo: number, now: number): Landing | null {
  if (!landing || landing.generation !== generation || !Number.isFinite(soughtTo)) return landing;
  if (Math.abs(soughtTo - landing.target) <= LANDING_TOLERANCE) return landing;
  return { generation, target: soughtTo, tries: 0, since: now };
}

/**
 * The place a load still waiting for `loadedmetadata` seeks to once it can (#730 second round). A seek made on the
 * element before then (the live check seeks right after Read opens, while a TorBox stream's metadata is on its way)
 * is that place: the element keeps it only until the load's own seek replaces it with the saved place. With no load
 * waiting, nothing changes.
 */
export function pendingSought(pending: number | null, soughtTo: number): number | null {
  if (pending === null || !Number.isFinite(soughtTo)) return pending;
  return Math.max(0, soughtTo);
}
