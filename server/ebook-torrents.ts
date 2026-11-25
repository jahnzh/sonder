// A torrent fetched for its ebook (#901): a Prowlarr book release, through the download queue as an audiobook's is
// (TorBox when cached, else local Transmission). When its EPUB or PDF is complete it is imported into the book as an
// upload is (`importEbook`): the edition joins the library of each user of the download, an EPUB joins the work's
// ebook set (checked against the narration) and its reading sync is queued.
import type { Readable } from "node:stream";

export const ebookFilePattern = /\.(epub|pdf)$/i;

/** The file to import: the first EPUB by name, else the first PDF; null when the torrent has neither. */
export function chooseEbookFile<T extends { name: string }>(files: readonly T[]): T | null {
  const ebooks = files
    .filter((file) => ebookFilePattern.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return ebooks.find((file) => /\.epub$/i.test(file.name)) ?? ebooks[0] ?? null;
}

/** A failure of the file itself (not an EPUB, too large): the next refresh would not change it. */
export class InvalidEbookFileError extends Error {}

/** Import the torrent's ebook into the download's book, for every user of the download. */
export async function importTorrentEbook(
  job: { id: string; workId: string | null },
  file: Readable,
  filename: string,
  log: { warn: (...args: unknown[]) => void } = console,
) {
  const [{ importEbook }, { sqlite }, { joinLibraryWithEbook }, { registerUploadedEbookSetMember }, { autoQueueAlignmentsForWork }] =
    await Promise.all([
      import("./ebooks.ts"),
      import("./db.ts"),
      import("./work-library.ts"),
      import("./ebook-set-evaluation.ts"),
      import("./alignment.ts"),
    ]);
  let imported: { id: string };
  try {
    imported = await importEbook(file, filename, job.workId || undefined);
  } catch (error) {
    // A disk failure is tried again by the next refresh; a file that is not an ebook is not.
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) throw error;
    throw new InvalidEbookFileError((error as Error).message);
  }
  const users = sqlite
    .prepare("SELECT user_id AS userId FROM user_acquisitions WHERE acquisition_id=?")
    .all(job.id) as { userId: number }[];
  for (const { userId } of users) joinLibraryWithEbook(userId, imported.id);
  if (job.workId && /\.epub$/i.test(filename)) {
    registerUploadedEbookSetMember(job.workId, imported.id);
    // It logs its own failure and never throws.
    await autoQueueAlignmentsForWork(job.workId, { ebookId: imported.id }, log);
  }
  return imported;
}
