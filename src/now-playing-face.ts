// The face Now playing opens on (#593, spec #586 "Now playing: one screen, two faces"). One pure function of what
// the stored work has (#528) and the face this device last showed for it: Read when the work has no recording,
// Listen when it has no EPUB, else the last face, Listen the first time. The last face is kept per account and work
// in the device's local storage (`userStorageKey("face:<workId>")`), written when a face is shown; nothing reaches
// the server. A page module: the server imports none of it.
import type { LibraryWork } from "./types";

export type Face = "listen" | "read";

/** What the face rule needs to know of a work: whether it has a recording to play and an EPUB to read. */
export type FaceFacts = { recording: boolean; epub: boolean };

/** The face to open. `last` is the face last shown on this device for the work, or null (none, or unreadable). */
export function faceToOpen(facts: FaceFacts, last: Face | null): Face {
  if (!facts.recording) return "read";
  if (!facts.epub) return "listen";
  return last ?? "listen";
}

/** Whether a face exists for the work: Listen needs a recording, Read an EPUB. The other one leads to Get. */
export function faceExists(facts: FaceFacts, face: Face): boolean {
  return face === "listen" ? facts.recording : facts.epub;
}

/**
 * What the face rule reads of a stored work: a recording with files, and an EPUB on the server (a PDF is not one,
 * #460, #533). `epub` is the chosen EPUB's id by the Ebook page's rule (#531), passed in so this stays pure.
 */
export function faceFacts(work: Pick<LibraryWork, "recordings" | "chosenRecordingId">, epub: string | null): FaceFacts {
  const chosen = work.recordings.find((r) => r.recordingId === work.chosenRecordingId) ?? work.recordings[0] ?? null;
  return { recording: !!chosen && chosen.tracks.length > 0, epub: !!epub };
}

/** The local storage key's name, before `userStorageKey` makes it the account's. */
export const faceKeyName = (workId: string) => `face:${workId}`;

/** The stored last face: anything but "listen" or "read" counts as none. */
export function readFace(value: string | null | undefined): Face | null {
  return value === "listen" || value === "read" ? value : null;
}
