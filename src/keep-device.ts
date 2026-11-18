/**
 * A book's files on this device, for turning Keep off and for its earlier copies (#553, spec #548 "Off", "Earlier
 * copies", "The Book page's This device group"; boards KeepOff.dc.html and KeepEarlier.dc.html).
 *
 * - `deviceBook`: every file of a book this device holds (its recordings' complete files and saved sections, earlier
 *   copies included, its EPUB copies and its reading sync maps), their size, and what Off removes.
 * - `earlierCopies` (in `deviceBook`): the recordings of the book with files here that are not the chosen one, named
 *   from the stored work or, after a recording left the library, from the Keep record.
 * - `rememberRecording`: the Keep record's list of the recordings saved for the book, so an earlier copy keeps its
 *   narrator after its recording left the library.
 * - `turnedOffFromServer`: the books whose Keep record a merge turned off (Remove from library on any device): their
 *   files are removed at that run.
 *
 * Plain data in and out: no React, no Dexie, no `window`. The server must not import this file: the production
 * image copies only four files of `src/`.
 */
import type { HeldFile, HeldPart, KeepEntry } from "./keep";

/** A recording the Keep record remembers for its book: its id and narrator. */
export type KeptRecording = { recordingId: string; narrator: string };

export type DeviceBookInput = {
  workId: string;
  /** The book's recordings as the stored work lists them. */
  recordings: readonly KeptRecording[];
  /** The chosen recording (the kept one), or null when the book has none. */
  chosenRecordingId: string | null;
  /** The book's ebook editions as the stored work lists them. */
  ebookIds: readonly string[];
  /** The recordings the Keep record remembers (a recording that left the library is only named here). */
  remembered?: readonly KeptRecording[];
  /** The device's save records (`device-save:<id>`), each with its book. */
  records: readonly { recordingId: string; workId: string }[];
  downloads: readonly HeldFile[];
  parts: readonly HeldPart[];
  /** Every copy of an EPUB on this device, kept or the reader's own, with its size. */
  ebookCopies: readonly { id: string; size: number }[];
  /** The device's stored reading sync maps (`reader-map:<ebookId>:<recordingId>`) with their size. */
  maps: readonly { key: string; size: number }[];
};

/** A recording of the book with files here that is not the chosen one. */
export type EarlierCopy = { recordingId: string; narrator: string; size: number };

export type DeviceBook = {
  /** Every recording of the book with a file, a saved section or a save record here: what Off removes. */
  recordingIds: string[];
  /** The book's EPUB copies here. */
  ebookIds: string[];
  /** The save records of the book (recordings and `ebook:<id>`). */
  saveIds: string[];
  /** The book's reading sync maps here. */
  mapKeys: string[];
  /** Bytes of every file of the book here: what Off frees. */
  size: number;
  /** The recordings with files here that are not the chosen one, in the order the work lists them. */
  earlier: EarlierCopy[];
  /** Whether this device holds any file of the book. */
  any: boolean;
};

const MAP_PREFIX = "reader-map:";

/** The bytes of one recording here: its complete files, and the saved sections of the files not complete. */
export function recordingBytes(recordingId: string, downloads: readonly HeldFile[], parts: readonly HeldPart[]): number {
  const files = downloads.filter((file) => file.recordingId === recordingId);
  const complete = new Set(files.map((file) => file.trackId));
  return (
    files.reduce((sum, file) => sum + Math.max(0, file.size || 0), 0) +
    parts.filter((part) => part.recordingId === recordingId && !complete.has(part.trackId)).reduce((sum, part) => sum + Math.max(0, part.loaded || 0), 0)
  );
}

/** Every file of a book on this device, what it takes, and its earlier copies. */
export function deviceBook(input: DeviceBookInput): DeviceBook {
  const held = new Set([
    ...input.downloads.map((file) => file.recordingId),
    ...input.parts.filter((part) => part.loaded > 0).map((part) => part.recordingId),
  ]);
  const ebookSaves = new Set(input.ebookIds.map((id) => `ebook:${id}`));
  const ownRecords = input.records.filter((record) => record.workId === input.workId);
  // The book's recordings: the work's, the remembered ones, and any a save record of the book names.
  const names = new Map<string, string>();
  for (const recording of [...input.recordings, ...(input.remembered ?? [])])
    if (!names.has(recording.recordingId) || !names.get(recording.recordingId)) names.set(recording.recordingId, recording.narrator);
  for (const record of ownRecords) if (!record.recordingId.startsWith("ebook:") && !names.has(record.recordingId)) names.set(record.recordingId, "");
  const recordingIds = [...names.keys()].filter((id) => held.has(id) || ownRecords.some((record) => record.recordingId === id));
  const ebookIds = new Set(input.ebookIds);
  const ebooks = input.ebookCopies.filter((copy) => ebookIds.has(copy.id));
  const ids = new Set(recordingIds);
  const maps = input.maps.filter((map) => {
    if (!map.key.startsWith(MAP_PREFIX)) return false;
    const rest = map.key.slice(MAP_PREFIX.length);
    const cut = rest.indexOf(":");
    if (cut < 0) return false;
    return ebookIds.has(rest.slice(0, cut)) || ids.has(rest.slice(cut + 1)) || names.has(rest.slice(cut + 1));
  });
  const audio = recordingIds.reduce((sum, id) => sum + recordingBytes(id, input.downloads, input.parts), 0);
  const size = audio + ebooks.reduce((sum, copy) => sum + Math.max(0, copy.size || 0), 0) + maps.reduce((sum, map) => sum + Math.max(0, map.size || 0), 0);
  const saveIds = [...new Set([...recordingIds, ...ownRecords.map((record) => record.recordingId), ...ebookSaves])];
  const earlier = recordingIds
    .filter((id) => id !== input.chosenRecordingId && held.has(id))
    .map((recordingId) => ({ recordingId, narrator: names.get(recordingId) ?? "", size: recordingBytes(recordingId, input.downloads, input.parts) }))
    .filter((copy) => copy.size > 0);
  return {
    recordingIds,
    ebookIds: ebooks.map((copy) => copy.id),
    saveIds,
    mapKeys: maps.map((map) => map.key),
    size,
    earlier,
    any: recordingIds.some((id) => held.has(id)) || ebooks.length > 0 || maps.length > 0,
  };
}

/**
 * The Keep record's remembered recordings with `recording` among them (its narrator brought up to date). Unchanged
 * (the same array) when it is already there with that narrator.
 */
export function rememberRecording(remembered: readonly KeptRecording[] | undefined, recording: KeptRecording): KeptRecording[] {
  const list = remembered ?? [];
  const index = list.findIndex((r) => r.recordingId === recording.recordingId);
  if (index >= 0 && list[index].narrator === recording.narrator) return list as KeptRecording[];
  if (index >= 0) return list.map((r, i) => (i === index ? { ...r, narrator: recording.narrator } : r));
  return [...list, { recordingId: recording.recordingId, narrator: recording.narrator }];
}

/** The books a merge turned off: on in the device's records before it, off after it (Remove from library elsewhere). */
export function turnedOffFromServer(before: readonly Pick<KeepEntry, "workId" | "on">[], after: readonly Pick<KeepEntry, "workId" | "on">[]): string[] {
  const was = new Map(before.map((entry) => [entry.workId, entry.on]));
  return after.filter((entry) => !entry.on && was.get(entry.workId) === true).map((entry) => entry.workId);
}
