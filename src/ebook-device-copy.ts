// An ebook edition's copy on this device (#531, spec #526 "The Ebook page", "Available from"): the reader keeps an
// EPUB it opened under `reader-file:<id>` (in the origin's private file system, or as a blob where there is none),
// as `saveEpubOffline` writes it. One function removes it, for every screen that offers "Remove from this device"
// (the Ebook page now, Activity's This device, #519, later), and one choice of edition per work on this device.
//
// The server must not import this file: the production image copies only four files of `src/`.
import { useCallback, useEffect, useState } from "react";
import { authDB, userStorageKey } from "./lib";
import { EBOOK_DEVICE_EVENT, forgetEpub, loadReader, saveEpubOffline } from "./reading";
import { deviceEbookChoiceKey } from "./ebook-choice";
import { isKeptReaderFile, type ReaderFileRecord } from "./ebook-keep";

const fileKey = (id: string) => `reader-file:${id}`;
const FOLDER = "sonder-ebooks";
export { EBOOK_DEVICE_EVENT };

type Stored = { fingerprint?: string; blob?: Blob; opfs?: boolean } | undefined;

/**
 * The size in bytes of this device's copy of an edition, or null when this device has none. With `kept`, the reader's
 * own reading cache counts as none: only a copy the user chose to keep (#671).
 */
export async function ebookDeviceCopySize(id: string, options: { kept?: boolean } = {}): Promise<number | null> {
  const stored = (await authDB.preferences.get(fileKey(id)).catch(() => undefined))?.value as Stored;
  if (!stored) return null;
  if (options.kept && !isKeptReaderFile(stored as ReaderFileRecord)) return null;
  if (stored.blob) return stored.blob.size;
  if (!stored.opfs) return null;
  try {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(FOLDER);
    return (await (await folder.getFileHandle(`${id}.epub`)).getFile()).size;
  } catch {
    // The record outlived its file: there is no copy to open.
    return null;
  }
}

/**
 * Removes this device's copy of an ebook edition: its file and its record, and the copy the reader holds in memory,
 * so the reader then reads the edition from the server. The place, bookmarks and library entry stay.
 */
export async function removeEbookFromDevice(id: string): Promise<void> {
  const stored = (await authDB.preferences.get(fileKey(id)).catch(() => undefined))?.value as Stored;
  if (stored?.opfs && navigator.storage?.getDirectory) {
    try {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(FOLDER);
      await folder.removeEntry(`${id}.epub`);
    } catch (error) {
      // A file that is already gone is removed; anything else is a failure to say.
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
  }
  await authDB.preferences.delete(fileKey(id));
  forgetEpub(id);
  window.dispatchEvent(new CustomEvent(EBOOK_DEVICE_EVENT, { detail: { id } }));
}

/**
 * Saves an EPUB on this device for reading offline, as the reader keeps one it opened (`saveEpubOffline`): the Book
 * page's Keep on this device switch, which took over the reader More sheet's "Save ebook offline" (#532).
 */
export async function saveEbookToDevice(id: string): Promise<void> {
  const book = await loadReader(id);
  const response = await fetch(`/api/ebooks/${encodeURIComponent(id)}/file`);
  if (!response.ok) throw new Error("The EPUB could not be saved on this device.");
  await saveEpubOffline(book, await response.blob());
}

/**
 * The size of this device's copy of an edition, read again when a copy is added or removed. With `kept`, only a copy
 * the user chose to keep counts, not the reader's own reading cache.
 */
export function useEbookDeviceCopy(id: string | null, options: { kept?: boolean } = {}) {
  const [size, setSize] = useState<{ id: string; size: number | null } | null>(null);
  const kept = !!options.kept;
  const read = useCallback(() => {
    if (!id) return;
    void ebookDeviceCopySize(id, { kept }).then((value) => setSize({ id, size: value }));
  }, [id, kept]);
  useEffect(() => {
    read();
    window.addEventListener(EBOOK_DEVICE_EVENT, read);
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener(EBOOK_DEVICE_EVENT, read);
      window.removeEventListener("focus", read);
    };
  }, [read]);
  return { size: size && size.id === id ? size.size : null, known: !!size && size.id === id, read };
}

/** This user's choice of edition for a work on this device (today's preference key), or null. */
export function deviceEbookChoice(workId: string): string | null {
  return localStorage.getItem(userStorageKey(deviceEbookChoiceKey(workId)));
}

export function setDeviceEbookChoice(workId: string, ebookId: string) {
  localStorage.setItem(userStorageKey(deviceEbookChoiceKey(workId)), ebookId);
  window.dispatchEvent(new CustomEvent(EBOOK_DEVICE_EVENT, { detail: { workId } }));
}

/** This device's choice for a work, kept current. */
export function useDeviceEbookChoice(workId: string) {
  const [choice, setChoice] = useState(() => deviceEbookChoice(workId));
  useEffect(() => {
    const read = () => setChoice(deviceEbookChoice(workId));
    read();
    window.addEventListener(EBOOK_DEVICE_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(EBOOK_DEVICE_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [workId]);
  return choice;
}
