// A torrent fetched for its ebook (#901): a Prowlarr book release, through the download queue as an audiobook's is
// (TorBox when cached, else local Transmission). When its EPUB or PDF is complete it is imported into the book as an
// upload is (`importEbook`): the edition joins the library of each user of the download, an EPUB joins the work's
// ebook set (checked against the narration) and its reading sync is queued.
import { Transform, type Readable } from "node:stream";

export const ebookFilePattern = /\.(epub|pdf)$/i;

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !["the", "and", "epub", "pdf"].includes(word));

/**
 * The file to import: EPUBs before PDFs. A torrent with one ebook gives it; a collection (a series, an author's
 * books) gives the file named most like the book, and none when no single file names the book, so another book of
 * the collection is never imported as this one. Null when the torrent has no EPUB or PDF, or none of a collection fits.
 */
export function chooseEbookFile<T extends { name: string }>(files: readonly T[], title = ""): T | null {
  const ebooks = files
    .filter((file) => ebookFilePattern.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const epubs = ebooks.filter((file) => /\.epub$/i.test(file.name));
  const kind = epubs.length ? epubs : ebooks;
  if (kind.length <= 1) return kind[0] ?? null;
  const wanted = words(title);
  if (!wanted.length) return null;
  const score = (file: T) => {
    const have = new Set(words(file.name.split("/").pop() ?? file.name));
    return wanted.filter((word) => have.has(word)).length;
  };
  const best = Math.max(...kind.map(score));
  // Most of the title's words, and only one file with that many.
  if (best < Math.ceil(wanted.length / 2)) return null;
  const top = kind.filter((file) => score(file) === best);
  return top.length === 1 ? top[0] : null;
}

/** A failure of the file itself (not an EPUB, too large): the next refresh would not change it. */
export class InvalidEbookFileError extends Error {}

// The refusals of `importEbook` that are about the file, which a later try would give again.
const fileRefusals = /not a valid EPUB or PDF|exceeds the 150 MB limit|Choose an EPUB or PDF|could not be found/;

/** A stream that fails when nothing arrives for `ms`, so a stalled transfer does not hold the download queue. */
export function idleLimit(ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const stream: Transform = new Transform({
    transform(chunk, _encoding, callback) {
      arm();
      callback(null, chunk);
    },
    flush(callback) {
      clearTimeout(timer);
      callback();
    },
    destroy(error, callback) {
      clearTimeout(timer);
      callback(error);
    },
  });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stream.destroy(new Error("The ebook download stalled. The download can retry shortly.")), ms);
  };
  arm();
  return stream;
}

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
    // A refusal of the file is final; a broken or stalled transfer, or a disk failure, is tried again by the next refresh.
    if (fileRefusals.test((error as Error).message)) throw new InvalidEbookFileError((error as Error).message);
    throw error;
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
