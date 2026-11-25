/**
 * What Activity's This device shows (#518, spec #513 "This device"; boards ActivityDevice.dc.html,
 * ActivityDeviceEmpty.dc.html, ActivityDeviceOffline.dc.html, ActivityDeviceMember.dc.html,
 * DesktopActivityDevice.dc.html).
 *
 * Pure: it takes the device's save entries (`device-saves.ts`), the books they belong to and whether there is a
 * connection, and returns the rows of Saving now and Kept on this device and the space they take. The screen
 * (`pages/activity-device.tsx`) only draws them.
 *
 * The server must not import this file: the production image copies only four files of `src/`.
 */
import type { DeviceSaveEntries } from "./device-saves";
import { deviceSaveEntryLine } from "./device-saves";
import { DEVICE_FULL_NOTE, deviceKeptLine, deviceSaveLine } from "./status-lines";
import { bytes } from "./size-format";

/** A book as This device needs it: the audio edition a row opens, its work, title and cover. */
export type DeviceBook = { id: string; workId: string; title: string; cover?: string | null };
/** An ebook edition saved for reading offline, with its title for a work that has no audio edition here. */
export type DeviceEbook = { id: string; workId: string; title: string };

export type DeviceSavingRow = {
  workId: string;
  title: string;
  cover: string | null;
  /** The book a row opens; null when the device knows no book of the work. */
  bookId: string | null;
  /** The recording whose save runs (Pause stops it), or `ebook:<id>` for a kept book with only an ebook. */
  recordingId: string;
  /** Keep is on for the work (#552): Pause goes through its Keep record. */
  keep: boolean;
  /** "Saving · 3 of 12 files". */
  status: string;
  /** 0 to 1, for the bar. */
  progress: number;
};

export type DeviceKeptRow = {
  workId: string;
  title: string;
  cover: string | null;
  bookId: string | null;
  /** "Audiobook and ebook · 414 MB", "Ebook · 0.6 MB", or "Not complete · 3 of 12 files". */
  status: string;
  /** The audiobook's save is not complete: the line has the audiobook's mark. */
  notComplete: boolean;
  /** The save failed (#552): the line is in the failed colour and the row offers Retry instead of Remove. */
  failed: boolean;
  /** Keep is on for the work. */
  keep: boolean;
  /** Everything of the work on this device, in bytes: what Remove frees. */
  size: number;
  /** What Remove deletes: every recording with files here, and every saved ebook edition of the work. */
  recordingIds: string[];
  ebookIds: string[];
};

export type DevicePart = {
  /** Saves running in this tab. Empty without a connection: nothing is saved then. */
  saving: DeviceSavingRow[];
  /** One row per work with files on this device; unfinished saves first, then newest change first. */
  kept: DeviceKeptRow[];
  /** What the device's saves take, in bytes. */
  used: number;
  /**
   * A kept book's save failed because the device is full (#552): Storage shows this note in the failed colour. The
   * bar of Used by Sonder does not decide it.
   */
  fullNote: string | null;
};

export function buildDevicePart({
  entries,
  books,
  ebooks = [],
  online,
}: {
  entries: DeviceSaveEntries;
  books: readonly DeviceBook[];
  ebooks?: readonly DeviceEbook[];
  online: boolean;
}): DevicePart {
  const saving: DeviceSavingRow[] = [];
  const kept: DeviceKeptRow[] = [];
  let used = 0;
  for (const entry of entries) {
    used += entry.totalSize;
    const book =
      (entry.audio ? books.find((b) => b.id === entry.bookId) : undefined) ?? books.find((b) => b.workId === entry.workId);
    const ebookTitle = ebooks.find((e) => e.workId === entry.workId)?.title;
    const title = book?.title ?? ebookTitle ?? "";
    const common = { workId: entry.workId, title, cover: book?.cover ?? null, bookId: book?.id ?? null };
    // A save runs only with a connection; without one it waits as not complete, with no bar.
    if ((entry.audio || entry.keep) && entry.state === "saving" && online) {
      saving.push({
        ...common,
        recordingId: entry.keep ? entry.saveId ?? entry.recordingId : entry.recordingId,
        keep: !!entry.keep,
        status: deviceSaveEntryLine(entry) ?? "",
        progress: entry.progress,
      });
      continue;
    }
    // Every work with Keep on is listed (#552), also before its first file: what it keeps, or why it is not complete.
    if (entry.keep) {
      const failed = entry.state === "not-complete" && entry.why === "failed";
      const status =
        entry.state === "nothing"
          ? deviceSaveLine({ keep: true, saving: false, filesTotal: 0, filesSaved: 0, size: 0 }) ?? ""
          : entry.state === "complete"
            ? deviceKeptLine({ audio: entry.hasAudio ? "complete" : "none", filesTotal: entry.filesTotal, filesSaved: entry.filesDone, ebook: !!entry.ebook || !!entry.hasEbook || !entry.hasAudio, size: entry.totalSize }) ?? ""
            : deviceKeptLine({ audio: "partial", filesTotal: entry.filesTotal, filesSaved: entry.filesDone, ebook: false, size: entry.totalSize }) ?? "";
      kept.push({
        ...common,
        status,
        notComplete: entry.state === "not-complete" || entry.state === "saving",
        failed,
        keep: true,
        size: entry.totalSize,
        recordingIds: entry.recordings.map((r) => r.recordingId).filter(Boolean),
        ebookIds: entry.ebook?.editionIds ?? [],
      });
      continue;
    }
    // Nothing of the work is on this device (a failed save that wrote nothing): Now lists it, not Kept. A save that
    // runs without a connection stays: it waits, and its first section may not be counted yet.
    if (entry.state !== "saving" && !entry.totalSize && !entry.ebook) continue;
    const audio = !entry.audio ? "none" : entry.state === "complete" ? "complete" : "partial";
    const status = deviceKeptLine({
      audio,
      filesTotal: entry.filesTotal,
      filesSaved: entry.filesDone,
      ebook: !!entry.ebook,
      size: entry.totalSize,
    });
    if (!status) continue;
    kept.push({
      ...common,
      status,
      notComplete: audio === "partial",
      failed: false,
      keep: false,
      size: entry.totalSize,
      recordingIds: entry.recordings.map((r) => r.recordingId),
      ebookIds: entry.ebook?.editionIds ?? [],
    });
  }
  // A stable sort: entries come newest change first; a failed save first (#552), then an unfinished one, then the rest.
  kept.sort((a, b) => Number(b.failed) - Number(a.failed) || Number(b.notComplete) - Number(a.notComplete));
  const full = entries.some((entry) => entry.keep && entry.state === "not-complete" && entry.why === "failed" && entry.failure === "full");
  return { saving, kept, used, fullNote: full ? DEVICE_FULL_NOTE : null };
}

/** "2.1 GB of 12 GB": what Sonder uses out of what the browser allows, or the use alone when the browser does not say. */
export function usedLine(used: number, quota: number | null | undefined): string {
  return quota && quota > 0 ? `${bytes(used)} of ${bytes(quota)}` : bytes(used);
}

/** The share of the allowance in use, 0 to 1, for the bar. */
export function usedShare(used: number, quota: number | null | undefined): number {
  return quota && quota > 0 ? Math.min(1, Math.max(0, used / quota)) : 0;
}

/** The value of the Protected storage row: the browser's answer, or Off with what a refused ask said. */
export function protectedLine(state: { persisted: boolean; refused: boolean }): string {
  if (state.persisted) return "On";
  return state.refused ? "Off · Refused by the browser" : "Off";
}
