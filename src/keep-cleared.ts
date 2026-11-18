/**
 * A device whose browser cleared Sonder's files (#554, spec #548 "Reporting", #465 decision 9): the server's Keep
 * records say this device completed a work, and the device holds neither a record nor a file of it. The saver
 * remembers when it noticed; This device says so under Storage until every kept book is complete again. Plain data
 * in, an answer out: the saver passes what the device holds, the unit tests pass plain objects.
 *
 * The server must not import this file: the production image copies only four files of `src/`.
 */
import type { HeldFile, HeldPart, KeepEntry, KeepWork, ServerKeep } from "./keep";

/** What this device holds of any book, complete or not, kept or the reader's own copy. */
export type DeviceHolds = {
  /** The device's Keep records. */
  keep: readonly Pick<KeepEntry, "workId">[];
  /** The stored library by work. */
  works: readonly KeepWork[];
  /** The device's save records (`device-save:<recordingId>`), by work. */
  records: readonly { workId: string | null }[];
  /** Every `downloads` row, whether or not its bytes add up to its size. */
  downloads: readonly Pick<HeldFile, "recordingId">[];
  /** Saved sections of files not complete yet. */
  parts: readonly Pick<HeldPart, "recordingId">[];
  /** Ebook editions with any copy on this device (`reader-file:<id>`), kept or the reader's own. */
  ebookIds: readonly string[];
  /** The keys of the stored maps, `reader-map:<ebookId>:<recordingId>`. */
  mapKeys: readonly string[];
};

/**
 * Whether a server record shows that the browser cleared this device: Keep on, completed by this device once, the
 * work in the library, and nothing of it on the device: no Keep record, no save record, no file of any of its
 * recordings, no copy of any of its ebooks and no map of them.
 */
export function wasCleared(server: ServerKeep, holds: DeviceHolds): boolean {
  if (!server.on || server.completeAt === null) return false;
  if (holds.keep.some((entry) => entry.workId === server.workId)) return false;
  const work = holds.works.find((item) => item.workId === server.workId);
  if (!work || !work.inLibrary) return false;
  const recordings = new Set(work.recordings.map((item) => item.recordingId));
  const ebooks = new Set((work.ebooks ?? []).map((item) => item.id));
  if (holds.records.some((record) => record.workId === server.workId)) return false;
  if (holds.downloads.some((file) => recordings.has(file.recordingId))) return false;
  if (holds.parts.some((part) => recordings.has(part.recordingId))) return false;
  if (holds.ebookIds.some((id) => ebooks.has(id))) return false;
  return !holds.mapKeys.some((key) => [...ebooks].some((id) => key.startsWith(`reader-map:${id}:`)));
}

/** What a kept book needs, as far as the message asks: whether it has files to save and whether all are saved. */
export type ClearedNeeds = { filesTotal: number; complete: boolean };

/**
 * Whether the message ends: every work with Keep on that is in the library is complete again. A kept book with
 * nothing to save ("Nothing to save yet") has nothing the browser could have cleared and does not hold it. Before
 * the device has read the library (no works stored) it does not end.
 */
export function clearedMessageEnds(keep: readonly Pick<KeepEntry, "workId" | "on">[], works: readonly KeepWork[], needs: (work: KeepWork) => ClearedNeeds): boolean {
  if (!works.length) return false;
  return keep.every((entry) => {
    if (!entry.on) return true;
    const work = works.find((item) => item.workId === entry.workId);
    if (!work || !work.inLibrary) return true;
    const need = needs(work);
    return need.filesTotal === 0 || need.complete;
  });
}
