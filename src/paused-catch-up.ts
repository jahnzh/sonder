// A paused player picks up a newer place saved on another device (#773, docs/research/audiobookshelf-websocket.md
// §3.1): when the app comes into view, and before a resume from a pause, the player reads the server's place for the
// recording it holds. This decides whether the paused player moves there. Pure, so the cases have a unit test.
import type { Progress } from "./types";

/** A place within one second of the player's own is the same place: no move, no history entry. */
export const SAME_PLACE_SECONDS = 1;
/** How long a resume waits for the server's answer before it plays from the local place. */
export const CATCH_UP_TIMEOUT_MS = 1500;

export type CatchUpInput = {
  /** The element plays: a playing player is never moved. */
  playing: boolean;
  /** The recording loaded in the player, with its tracks. */
  recordingId: string;
  trackIds: string[];
  /** Where the paused player is now. */
  place: { trackId: string; position: number };
  /** This device's last save for the recording (its own place or one it picked up); 0 when it has none. */
  savedAt: number;
  /** The server's answer: its progress, null when it has none, undefined when it gave no answer (offline, slow). */
  server: Progress | null | undefined;
};

export type CatchUpDecision =
  | { action: "stay"; reason: "playing" | "no-answer" | "no-server-place" | "other-recording" | "not-newer" | "same-place" | "unknown-track" }
  | { action: "move"; trackId: string; position: number; progress: Progress };

export function catchUpDecision(input: CatchUpInput): CatchUpDecision {
  const { server } = input;
  if (input.playing) return { action: "stay", reason: "playing" };
  if (server === undefined) return { action: "stay", reason: "no-answer" };
  if (server === null) return { action: "stay", reason: "no-server-place" };
  // Only the loaded recording is compared: progress is never merged across recordings.
  if (server.recordingId !== input.recordingId) return { action: "stay", reason: "other-recording" };
  if (!(server.updatedAt > input.savedAt)) return { action: "stay", reason: "not-newer" };
  if (!input.trackIds.includes(server.trackId)) return { action: "stay", reason: "unknown-track" };
  if (server.trackId === input.place.trackId && Math.abs(server.position - input.place.position) <= SAME_PLACE_SECONDS)
    return { action: "stay", reason: "same-place" };
  return { action: "move", trackId: server.trackId, position: server.position, progress: server };
}
