import type { FastifyInstance } from "fastify";
import { existsSync, statSync, realpathSync, unlinkSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { mediaRoot, ensureMediaStorage } from "./storage.ts";
import { hasServerMedia, pauseServerDownload } from "./downloads.ts";
import type { Book, MediaFault, RecordingChapter, RecordingSources } from "../src/types.ts";
import { withEditedChapters } from "./recording-chapters.ts";
type Track = typeof s.tracks.$inferSelect;
/**
 * A recording's tracks as clients read them (`GET /api/books`, the read by work): in order, without
 * their file path, with where each is available from. `onServer` is asked once per track; the read
 * by work passes one that needs no query per track.
 */
export function deliveredTracks(
  rows: Track[],
  faults: NonNullable<Book["faults"]>,
  onServer: (track: Track) => boolean = hasServerMedia,
  /** The recording's edited chapters (#719 part c), placed over its files in place of theirs. */
  editedChapters?: RecordingChapter[],
) {
  const tracks = withEditedChapters([...rows], editedChapters)
    .sort((a, b) => a.index - b.index)
    .map((t) => {
      const serverAvailable = onServer(t);
      return {
        ...t,
        source: "",
        sourceType: t.sourceType as "local" | "remote" | "torbox",
        serverAvailable,
        deliverySource: serverAvailable && !faults.server
          ? ("server" as const)
          : t.sourceType === "torbox"
            ? ("torbox" as const)
            : ("remote" as const),
      };
    });
  return { tracks, serverStored: tracks.length > 0 && tracks.every((t) => t.serverAvailable) };
}
export const sourceChoice = z.enum(["auto", "server", "original"]);
export function faultsFor(recordingId: string): NonNullable<Book["faults"]> {
  const rows = sqlite
    .prepare(
      "SELECT scope,reason,note,updated_at FROM media_faults WHERE recording_id=?",
    )
    .all(recordingId) as {
    scope: "recording" | "server" | "original";
    reason: MediaFault["reason"];
    note: string;
    updated_at: number;
  }[];
  return Object.fromEntries(
    rows.map((row) => [
      row.scope,
      { reason: row.reason, note: row.note, updatedAt: row.updated_at },
    ]),
  );
}
function recordingTracks(id: string) {
  if (!db.select().from(s.recordings).where(eq(s.recordings.id, id)).get())
    throw new Error("This recording could not be found.");
  return db.select().from(s.tracks).where(eq(s.tracks.recordingId, id)).all();
}
export function recordingSources(id: string): RecordingSources {
  const tracks = recordingTracks(id),
    copies = db.select().from(s.mediaCopies).all();
  return {
    recordingId: id,
    faults: faultsFor(id),
    managedCopies: copies.filter((copy) =>
      tracks.some((track) => track.id === copy.trackId),
    ).length,
    serverFiles: tracks.filter(hasServerMedia).length,
    originalFiles: tracks.filter((track) => track.sourceType !== "local")
      .length,
    tracks: tracks.map((track) => ({
      id: track.id,
      server: hasServerMedia(track),
      original: track.sourceType !== "local",
    })),
  };
}
export function chooseMedia(
  track: Track,
  choice: "auto" | "server" | "original" = "auto",
) {
  const faults = faultsFor(track.recordingId);
  if (faults.recording)
    throw Object.assign(
      new Error(
        "This recording is marked faulty. Choose another version or clear its flag in Versions & sources.",
      ),
      { statusCode: 409 },
    );
  const copy = db
    .select()
    .from(s.mediaCopies)
    .where(eq(s.mediaCopies.trackId, track.id))
    .get();
  const copied =
    copy && existsSync(copy.path) && statSync(copy.path).size === copy.size;
  const local = track.sourceType === "local" && existsSync(track.source);
  if (choice !== "original" && !faults.server && (copied || local))
    return copied
      ? { ...track, source: copy.path, sourceType: "local" }
      : track;
  if (choice !== "server" && track.sourceType !== "local" && !faults.original)
    return track;
  throw Object.assign(
    new Error(
      choice === "server"
        ? "This server copy is unavailable or marked faulty. Choose another source."
        : choice === "original"
          ? "The original stream is unavailable or marked faulty. Choose another source."
          : "No healthy audio source is available. Choose another version or clear a fault flag.",
    ),
    { statusCode: 409 },
  );
}
export function registerMediaLibrary(app: FastifyInstance) {
  app.get("/api/recordings/:id/sources", (req) =>
    recordingSources((req.params as { id: string }).id),
  );
  app.put("/api/recordings/:id/faults/:scope", (req) => {
    const { id } = req.params as { id: string };
    recordingTracks(id);
    const scope = z
      .enum(["recording", "server", "original"])
      .parse((req.params as { scope: string }).scope);
    const value = z
      .object({
        reason: z.enum([
          "wrong-language",
          "wrong-book",
          "bad-audio",
          "incomplete",
          "other",
        ]),
        note: z.string().max(500).default(""),
      })
      .parse(req.body);
    sqlite
      .prepare(
        "INSERT INTO media_faults(recording_id,scope,reason,note,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(recording_id,scope) DO UPDATE SET reason=excluded.reason,note=excluded.note,updated_at=excluded.updated_at",
      )
      .run(id, scope, value.reason, value.note, Date.now());
    return recordingSources(id);
  });
  app.delete("/api/recordings/:id/faults/:scope", (req) => {
    const { id } = req.params as { id: string };
    recordingTracks(id);
    const scope = z
      .enum(["recording", "server", "original"])
      .parse((req.params as { scope: string }).scope);
    sqlite
      .prepare("DELETE FROM media_faults WHERE recording_id=? AND scope=?")
      .run(id, scope);
    return recordingSources(id);
  });
  app.delete("/api/recordings/:id/server-copy", (req) => {
    ensureMediaStorage();
    const { id } = req.params as { id: string };
    const tracks = recordingTracks(id);
    const copies = db
      .select()
      .from(s.mediaCopies)
      .all()
      .filter((copy) => tracks.some((track) => track.id === copy.trackId));
    const root = realpathSync(join(mediaRoot, "saved"));
    for (const copy of copies) {
      const path = existsSync(copy.path) ? realpathSync(copy.path) : copy.path;
      const rel = relative(root, path);
      if (!rel || rel.startsWith("..") || isAbsolute(rel))
        throw new Error("Only managed server copies can be removed here.");
    }
    pauseServerDownload(id);
    for (const copy of copies) {
      if (existsSync(copy.path)) unlinkSync(copy.path);
      db.delete(s.mediaCopies)
        .where(eq(s.mediaCopies.trackId, copy.trackId))
        .run();
    }
    db.delete(s.serverDownloads)
      .where(eq(s.serverDownloads.recordingId, id))
      .run();
    sqlite
      .prepare("DELETE FROM media_faults WHERE recording_id=? AND scope=?")
      .run(id, "server");
    return recordingSources(id);
  });
}
