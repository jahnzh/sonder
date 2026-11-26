// MyAnonamouse's routes (#911): its audiobook search for the Get audiobook sheet, the Get of one of its torrents, the
// Settings check of the session, and the seeding of its torrents for Activity. The administrator's (`app.ts` holds
// `/api/mam` and `/api/discover/mam` to the administrator). Every call to MAM goes through `sources/myanonamouse.ts`.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { acquireReplacing, mamTorrentMayBeRemoved } from "./acquisitions.ts";
import type { MamSeeding } from "../src/types.ts";
import { acquireForNewBook } from "./new-book.ts";
import { packRequestFor } from "./series-pack-step.ts";
import { getSeedingStates, type SeedingState } from "./transmission.ts";
import { currentUserId } from "./users.ts";
import { mam, mamAudiobookRelease, mamConfigured, mamIdOf, mamLink, MAM_UNCONFIGURED } from "./sources/myanonamouse.ts";

type Row = ReturnType<typeof mamAudiobookRelease>;
/** The rows of recent searches, for the Get of one: its title, author, narrator and language (6 hours, not over a restart). */
const rows = new Map<number, { row: Row; expires: number }>();
const ROW_MS = 6 * 3600_000;
function remember(found: Row[]) {
  const expires = Date.now() + ROW_MS;
  for (const row of found) {
    const id = mamIdOf(row.id);
    if (id) rows.set(id, { row, expires });
  }
  for (const [id, entry] of rows) if (entry.expires <= Date.now() || rows.size > 5000) rows.delete(id);
}

/** A row of a recent search; else MAM is asked for the torrent by its id (one search). */
async function rowOf(id: number): Promise<Row> {
  const known = rows.get(id);
  if (known && known.expires > Date.now()) return known.row;
  const release = await mam().torrent(id);
  if (!release) throw Object.assign(new Error("MyAnonamouse no longer lists this torrent. Search again."), { statusCode: 404 });
  const row = mamAudiobookRelease(release);
  remember([row]);
  return row;
}


/** Transmission's status 0 stopped, 1-4 checking or downloading, 5 waiting to seed, 6 seeding. */
export function mamSeedingOf(row: { id: string; title: string; hash: string }, state: SeedingState | undefined): MamSeeding {
  if (!state) return { id: row.id, title: row.title, state: "missing", progress: 0, secondsSeeding: null, ratio: null, seededEnough: false };
  const seconds = Number.isFinite(state.secondsSeeding) ? Math.max(0, state.secondsSeeding) : null;
  const done = state.percentDone >= 1;
  return {
    id: row.id,
    title: row.title,
    state: state.status === 0 ? "stopped" : done ? "seeding" : "downloading",
    progress: Number.isFinite(state.percentDone) ? Math.max(0, Math.min(1, state.percentDone)) : 0,
    secondsSeeding: seconds,
    // -1: nothing downloaded yet; -2: an infinite ratio (uploaded without downloading).
    ratio: Number.isFinite(state.uploadRatio) && state.uploadRatio >= 0 ? state.uploadRatio : null,
    seededEnough: mamTorrentMayBeRemoved(seconds),
  };
}

export function registerMamRoutes(app: FastifyInstance) {
  app.get("/api/discover/mam/releases", async (req) => {
    const { q } = z.object({ q: z.string().min(2).max(150) }).parse(req.query);
    if (!mamConfigured()) throw Object.assign(new Error(MAM_UNCONFIGURED), { statusCode: 409 });
    const answer = await mam().search(q, "audio");
    const results = answer.results.map(mamAudiobookRelease);
    remember(results);
    // One page: MAM is asked once per search (#911).
    return { results, page: 1, nextPage: null };
  });

  app.post("/api/discover/mam/add", async (req) => {
    const input = z
      .object({
        id: z.string().regex(/^mam-\d{1,12}$/),
        workId: z.string().max(100).optional(),
        replaceActive: z.boolean().optional(),
        // A recording for a new book (#576): the book is made from the release, in the requester's library.
        makeWork: z.boolean().optional(),
        // A series pack for the book (ADR 0027): it also gets the other books of the series it holds.
        pack: z.boolean().optional(),
      })
      .parse(req.body);
    if (!mamConfigured()) throw Object.assign(new Error(MAM_UNCONFIGURED), { statusCode: 409 });
    const torrentId = mamIdOf(input.id)!;
    const row = await rowOf(torrentId);
    const link = mamLink(torrentId);
    const userId = currentUserId(req);
    if (input.makeWork && !input.workId)
      return acquireForNewBook(link, { title: row.title, author: row.author || null, language: row.language, narrator: row.narrator }, userId);
    const work = input.workId ? db.select().from(s.works).where(eq(s.works.id, input.workId)).get() : undefined;
    if (input.workId && !work) throw new Error("The selected book could not be found.");
    const pack = input.pack ? packRequestFor(userId, input.workId, row.title) : undefined;
    return acquireReplacing(link, {
      workId: input.workId,
      replaceActive: input.replaceActive,
      pack,
      // A pack is named by its release, not by one of its books.
      title: (pack && row.title) || work?.title || row.title,
      author: work?.author || row.author || undefined,
      language: row.language,
      narrator: row.narrator,
      userId,
    });
  });

  // Settings' check of the session: one small search. MAM's answer renews the session, kept by the client.
  app.post("/api/mam/test", async () => {
    if (!mamConfigured()) throw new Error(MAM_UNCONFIGURED);
    const answer = await mam().search("the", "audio", { perpage: 5 });
    return { ok: true, found: answer.found };
  });

  // Activity's list of MAM torrents (#911): every one Sonder added, with its seeding time and ratio from the client.
  app.get("/api/mam/seeding", async () => {
    const list = sqlite
      // Only torrents the client got (`remote_id`): one that failed before it was added is no torrent to seed.
      .prepare("SELECT id, title, hash FROM acquisitions WHERE mam_torrent_id IS NOT NULL AND remote_id IS NOT NULL ORDER BY created_at DESC LIMIT 200")
      .all() as { id: string; title: string; hash: string }[];
    if (!list.length) return { torrents: [] as MamSeeding[], error: null };
    try {
      const states = new Map((await getSeedingStates(list.map((row) => row.hash))).map((state) => [state.hashString.toLowerCase(), state]));
      return { torrents: list.map((row) => mamSeedingOf(row, states.get(row.hash.toLowerCase()))), error: null };
    } catch (error) {
      return { torrents: [] as MamSeeding[], error: (error as Error).message };
    }
  });
}
