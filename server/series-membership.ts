import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import * as s from "./schema.ts";
import {
  getWorkMediaState,
  syncWorkMediaState,
  type WorkMediaState,
} from "./work-media-state.ts";

export type SeriesVolumeCandidate = {
  position: number | null;
  book: {
    id: number;
    title: string;
    compilation?: boolean | null;
    release_year?: number | null;
    release_date?: string | null;
  };
};

export function pickCanonicalBookPerPosition(
  entries: SeriesVolumeCandidate[],
): { position: number; bookId: number; title: string }[] {
  const byPos = new Map<number, { id: number; title: string }>();
  for (const entry of entries) {
    if (entry.position == null || !Number.isInteger(entry.position)) continue;
    const book = entry.book;
    if (book.compilation || /[^\x00-\x7f]/.test(book.title)) continue;
    const current = byPos.get(entry.position);
    if (!current || book.id < current.id)
      byPos.set(entry.position, { id: book.id, title: book.title });
  }
  return [...byPos.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([position, book]) => ({
      position,
      bookId: book.id,
      title: book.title,
    }));
}

export function isUnreleasedHardcoverBook(book: {
  release_year?: number | null;
  release_date?: string | null;
}) {
  return book.release_year == null && !book.release_date;
}

export type SeriesMembershipVolume = {
  position: number;
  hardcoverBookId: number;
  workId: string;
  editionId: string;
  unreleased: boolean;
  mediaState: WorkMediaState;
};

export async function retryWorkMediaAcquisition(
  userId: number,
  workId: string,
  acquire: (
    magnet: string,
    metadata: {
      title?: string;
      author?: string;
      cover?: string;
      workId?: string;
      language?: string | null;
      narrator?: string | null;
      userId?: number;
    },
  ) => Promise<unknown>,
) {
  const state = getWorkMediaState(userId, workId);
  if (state?.state !== "failed" || !state.acquisitionId)
    throw new Error("This book is not waiting for a retry.");
  const job = db
    .select()
    .from(s.acquisitions)
    .where(eq(s.acquisitions.id, state.acquisitionId))
    .get();
  if (!job?.magnet) throw new Error("The failed download could not be found.");
  await acquire(job.magnet, {
    title: job.title,
    author: job.author,
    cover: job.cover,
    workId: job.workId || workId,
    language: job.language,
    narrator: job.narrator,
    userId,
  });
  return syncWorkMediaState(userId, workId);
}
