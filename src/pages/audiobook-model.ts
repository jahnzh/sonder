// The Audiobook page's words and choices (#530, spec #526 "The Audiobook page"; board Audiobook.dc.html), as pure
// functions of what the page knows: the work's recordings, the chosen one's sources, its copies on this device and its
// fault marks. No React, no `window`, no fetch, so the unit tests read them as plain data. The server imports nothing
// from here.
import { ANOTHER_LANGUAGE_LINE, downloadLine, serverCopyLine } from "../status-lines";
import { bytes } from "../size-format";
import type { Download, MediaFault, PlaybackSourceChoice, RecordingSources, Track, WorkRecording } from "../types";

const DOT = " · ";

/** A recording's length as the boards write it: "9 h 12 min", "42 min"; "" when it is not known. */
export function lengthLine(seconds: number): string {
  if (!(seconds > 0)) return "";
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${Math.max(1, m)} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A recording's narrator, the first line of its Choice row. */
export function recordingName(recording: Pick<WorkRecording, "narrator">): string {
  return recording.narrator?.trim() || "Unknown narrator";
}

/**
 * The second line of a recording's Choice row: language and length (the board's format is not in the work's
 * shape, spec #526 adds nothing to it), and "Marked faulty" when the recording carries a mark.
 */
export function recordingDetail(recording: Pick<WorkRecording, "language" | "duration" | "faults">): string {
  const parts = [recording.language?.trim() || "", lengthLine(recording.duration)];
  if (recording.faults?.recording) parts.push("Marked faulty");
  return parts.filter(Boolean).join(DOT);
}

/** Where a recording stands, as the Book page's Audiobook row says it: "Streams from TorBox", "On server", or null. */
export function recordingPlace(recording: { serverStored: boolean; tracks: Pick<Track, "sourceType">[] }): string | null {
  if (recording.serverStored) return downloadLine({ status: "ready", backend: "local" });
  if (recording.tracks.some((track) => track.sourceType === "torbox")) return downloadLine({ status: "ready", backend: "torbox" });
  return null;
}

/** The Audiobook row's line: the recording's narrator, length and where it stands ("[NARRATOR] · 9 h 12 min · On server"). */
export function audiobookRowLine(
  recording: Pick<WorkRecording, "narrator" | "duration" | "serverStored"> & { tracks: Pick<Track, "sourceType">[] },
  anotherLanguage = false,
): string {
  return [recordingName(recording), lengthLine(recording.duration), recordingPlace(recording), anotherLanguage ? ANOTHER_LANGUAGE_LINE : null].filter(Boolean).join(DOT);
}

export type CopyScope = "device" | "server" | "original";
/** What a fault mark is on: the recording or one copy. */
export type FaultScope = "recording" | CopyScope;
export type Faults = Partial<Record<FaultScope, MediaFault>>;

export const SCOPE_NAMES: Record<FaultScope, string> = {
  recording: "Recording",
  device: "Device copy",
  server: "Server copy",
  original: "Original stream",
};

/** Today's reasons, with "version" replaced by "recording". */
export const FAULT_REASONS: Record<MediaFault["reason"], string> = {
  "wrong-language": "Wrong language",
  "wrong-book": "Wrong book or recording",
  "bad-audio": "Audio does not play correctly",
  incomplete: "Missing or incomplete audio",
  other: "Other problem",
};

export const MARKED_LINE = "Marked faulty";
/** The name of a mark, as its row and the copy's dialog say it ("Device copy marked faulty"). */
export const markName = (scope: FaultScope) => `${SCOPE_NAMES[scope]} marked faulty`;
/** What a mark says: its reason, then the note. */
export const markDetail = (fault: MediaFault) => (fault.note ? `${FAULT_REASONS[fault.reason]}${DOT}${fault.note}` : FAULT_REASONS[fault.reason]);

export type CopyFacts = {
  /** The chosen recording's tracks. */
  tracks: Pick<Track, "id" | "sourceType">[];
  /** Its tracks' files on this device. */
  deviceFiles: Pick<Download, "trackId" | "size">[];
  /** What the server says of its sources; null until it is read. */
  sources: Pick<RecordingSources, "serverFiles" | "originalFiles" | "managedCopies"> | null;
  /** A copy to the server that has not finished (the administrator's only). */
  serverCopy: WorkRecording["serverCopy"];
  faults: Faults;
  /** The book's source label, for an original stream that is not TorBox. */
  sourceLabel: string;
};

export type CopyRow = {
  scope: CopyScope;
  name: string;
  /** The value on the row's right edge: the size or source, "None", or "Marked faulty". */
  value: string;
  /** The copy is there, so the row opens the copy's dialog. */
  present: boolean;
  faulty: boolean;
};

const NONE = "None";

/** The rows of "Available from", in the board's order: Device copy, Server copy, Original stream. */
export function copyRows(facts: CopyFacts): CopyRow[] {
  const total = facts.tracks.length;
  const onDevice = facts.deviceFiles.filter((file) => facts.tracks.some((track) => track.id === file.trackId));
  const size = onDevice.reduce((sum, file) => sum + (file.size || 0), 0);
  const deviceValue = !onDevice.length
    ? NONE
    : onDevice.length >= total
      ? bytes(size)
      : `${onDevice.length} of ${total} files${DOT}${bytes(size)}`;
  const serverFiles = facts.sources?.serverFiles ?? 0;
  const copying = facts.serverCopy ? serverCopyLine({ status: facts.serverCopy.status, progress: facts.serverCopy.progress }) : null;
  const serverValue = copying ?? (!serverFiles ? NONE : serverFiles >= total ? downloadLine({ status: "ready", backend: "local" })! : `${serverFiles} of ${total} files`);
  const originalFiles = facts.sources?.originalFiles ?? facts.tracks.filter((track) => track.sourceType !== "local").length;
  const torbox = facts.tracks.some((track) => track.sourceType === "torbox");
  const originalValue = !originalFiles ? NONE : torbox ? "TorBox" : facts.sourceLabel || "Online";
  const row = (scope: CopyScope, value: string, present: boolean): CopyRow => {
    const faulty = !!facts.faults[scope];
    return { scope, name: SCOPE_NAMES[scope], value: faulty ? MARKED_LINE : value, present: present || faulty, faulty };
  };
  return [
    row("device", deviceValue, onDevice.length > 0),
    row("server", serverValue, serverFiles > 0 || !!copying),
    row("original", originalValue, originalFiles > 0),
  ];
}

export type PlaysFromFacts = {
  faults: Faults;
  /** This device holds the file of the track the place is in. */
  deviceHasTrack: boolean;
  /** The server holds that track, or it has an original stream. */
  serverHasTrack: boolean;
  originalHasTrack: boolean;
  online: boolean;
};
export type PlaysFromOption = { value: PlaybackSourceChoice; label: string; disabled: boolean };

export const PLAYS_FROM_NAMES: Record<PlaybackSourceChoice, string> = {
  auto: "Automatic",
  device: "Device copy",
  server: "Server copy",
  original: "Original stream",
};

/**
 * The Plays from picker's choices. A choice a fault mark rules out is off, as is one with no file for the place or,
 * for the server and the stream, without a connection; a recording marked faulty rules out every choice.
 */
export function playsFromOptions(facts: PlaysFromFacts): PlaysFromOption[] {
  const all = !!facts.faults.recording;
  return [
    { value: "auto", label: PLAYS_FROM_NAMES.auto, disabled: all },
    { value: "device", label: PLAYS_FROM_NAMES.device, disabled: all || !facts.deviceHasTrack || !!facts.faults.device },
    { value: "server", label: PLAYS_FROM_NAMES.server, disabled: all || !facts.serverHasTrack || !!facts.faults.server || !facts.online },
    { value: "original", label: PLAYS_FROM_NAMES.original, disabled: all || !facts.originalHasTrack || !!facts.faults.original || !facts.online },
  ];
}

/** What Report a problem can mark: the recording, and each copy that is there. */
export function reportScopes(facts: { deviceFiles: number; serverFiles: number; originalFiles: number }): FaultScope[] {
  return [
    "recording",
    ...(facts.deviceFiles > 0 ? (["device"] as const) : []),
    ...(facts.serverFiles > 0 ? (["server"] as const) : []),
    ...(facts.originalFiles > 0 ? (["original"] as const) : []),
  ];
}

/** The recordings in the order the page lists them: the work's own order (the one added first first). */
export type RecordingChoice = { value: string; label: string; detail: string };
export function recordingChoices(recordings: WorkRecording[], anotherLanguageId: string | null = null): RecordingChoice[] {
  return recordings.map((recording) => {
    const detail = recordingDetail(recording);
    // The work is held "another language" (#897): the chosen recording says it, so a copy in another language is not an ordinary download.
    return {
      value: recording.recordingId,
      label: recordingName(recording),
      detail: recording.recordingId === anotherLanguageId ? [detail, ANOTHER_LANGUAGE_LINE].filter(Boolean).join(DOT) : detail,
    };
  });
}

/** The stand-in a removal confirmation states: what stays. */
export const REMOVAL_KEEPS = "Your place and the library entry stay.";
