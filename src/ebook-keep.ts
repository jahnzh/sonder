// Which of this device's EPUB copies the user chose to keep (#671, spec #548 "Activity's entries"): the reader copies
// every EPUB it opens to the device as a reading cache, so a book can be read again without a connection, and the
// hidden reader of Now playing does so for the book in the mini player as well. That copy is not kept: it counts in
// Used by Sonder and is not listed or counted under Kept on this device. Only an explicit save ("Save ebook offline")
// keeps an edition. A record written before #671 carries no mark and stays kept, as nobody can tell it apart.
//
// Pure functions of the stored `reader-file:<id>` record; the server must not import this file.

export type ReaderFileRecord = { fingerprint?: string; blob?: Blob; opfs?: boolean; cache?: boolean } | undefined | null;

/** Whether a stored copy is one the user chose to keep (not the reader's own cache). */
export function isKeptReaderFile(record: ReaderFileRecord): boolean {
  return !!record && record.cache !== true;
}

/**
 * Whether a copy about to be written is only a reading cache: a copy the reader makes on its own stays a cache,
 * unless the edition is already kept here (a changed file then replaces the kept copy and stays kept).
 */
export function writesAsCache(existing: ReaderFileRecord, request: { cache: boolean }): boolean {
  return request.cache && !isKeptReaderFile(existing);
}
