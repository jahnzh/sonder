import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { resolve, join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { parseFile } from "music-metadata";
import { normalizeChapters, type Chapter } from "./chapters.ts";
import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { db, sqlite, dataDir } from "./db.ts";
import * as s from "./schema.ts";
import { seed } from "./seed.ts";
import {
  hardcoverForWork,
  hardcoverSearch,
  queueHardcoverStatus,
  queueHardcoverProgress,
  resetHardcoverAccount,
  tickHardcover,
  hardcoverWorkForMedia,
  claimHardcoverAudio,
} from "./hardcover.ts";
import { registerHardcoverRoutes } from "./hardcover-routes.ts";
import { registerAppearance } from "./appearance.ts";
import { registerReader } from "./reader.ts";
import { registerAlignment } from "./alignment.ts";
import {registerMediaLibrary,faultsFor,chooseMedia,sourceChoice} from "./media-library.ts";
import { parseRange } from "./range.ts";
import {
  isCompleteMediaResponse,
  retryDelayFromHeader,
} from "./media-response.ts";
import {
  mediaRoot,
  importedDir,
  ensureMediaStorage,
  torrentDownloadDir,
} from "./storage.ts";
import { acquire, refreshQueue } from "./acquisitions.ts";
import { transmission, transmissionConfigured } from "./transmission.ts";
import { searchEbooks, saveEbook, listEbooks, importEbook } from "./ebooks.ts";
import {
  hasServerMedia,
  requestServerDownload,
  processServerDownloads,
  pauseServerDownload,
  stopServerDownloads,
  listServerDownloads,
} from "./downloads.ts";
import { encrypt, passwordMatches, hashToken } from "./security.ts";
import {
  getSetting,
  getSecret,
  torbox,
  torboxUrl,
  abbSearch,
  abbReleaseSearch,
  abbRelease,
  abbMagnet,
  prowlarrConfig,
  prowlarrReleaseSearch,
  prowlarrRelease,
  prowlarrMagnet,
} from "./services.ts";
import {
  normalizeBaseUrl,
  prowlarrStatus,
  releaseDisplayTitle,
} from "./sources/prowlarr.ts";
import type { Book } from "../src/types.ts";
const uploadDir = importedDir;
export function listBooks(): Book[] {
  const allTracks = db.select().from(s.tracks).all();
  const allProgress = db.select().from(s.progress).all();
  const lib = db.select().from(s.library).all();
  return db
    .select({ work: s.works, edition: s.editions, recording: s.recordings })
    .from(s.editions)
    .innerJoin(s.works, eq(s.works.id, s.editions.workId))
    .innerJoin(s.recordings, eq(s.recordings.editionId, s.editions.id))
    .all()
    .map(({ work, edition, recording }) => {
      const saved = lib.find((l) => l.bookId === edition.id);
      const faults=faultsFor(recording.id);
      const tracks = allTracks
        .filter((t) => t.recordingId === recording.id)
        .sort((a, b) => a.index - b.index)
        .map((t) => ({
          ...t,
          source: "",
          sourceType: t.sourceType as "local" | "remote" | "torbox",
          serverAvailable:hasServerMedia(t),
          deliverySource: hasServerMedia(t) && !faults.server
            ? ("server" as const)
            : t.sourceType === "torbox"
              ? ("torbox" as const)
              : ("remote" as const),
        }));
      return {
        serverStored:
          tracks.length > 0 &&
          allTracks
            .filter((t) => t.recordingId === recording.id)
            .every(hasServerMedia),
        faults,
        hardcover: hardcoverForWork(work.id),
        id: edition.id,
        workId: work.id,
        editionId: edition.id,
        recordingId: recording.id,
        title: work.title,
        author: work.author,
        narrator: edition.narrator,
        language: edition.language,
        releaseTitle: edition.releaseTitle,
        description: work.description,
        genre: work.genre,
        year: work.year,
        cover: edition.cover,
        rating: edition.rating,
        sourceLabel: edition.sourceLabel,
        tracks,
        duration: tracks.reduce((v, t) => v + t.duration, 0),
        inLibrary: !!saved,
        status: (saved?.status || "unread") as Book["status"],
        addedAt: saved?.addedAt || 0,
        progress: allProgress.find((p) => p.recordingId === recording.id),
      };
    });
}
const mime = (path: string) =>
  ({
    ".m4b": "audio/mp4",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
  })[extname(path).toLowerCase()] || "application/octet-stream";
export async function createApp() {
  ensureMediaStorage();
  seed();
  sqlite
    .prepare("UPDATE tracks SET source=? WHERE id=? AND source=?")
    .run(
      join(mediaRoot, "demo", "alice-01.mp3"),
      "alice-0",
      "/audio/alice-01.mp3",
    );
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 1024 * 1024,
    disableRequestLogging: true,
  });
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      // Older installed clients attached JSON headers to bodyless actions.
      if (
        !body.length &&
        ((request.method === "DELETE" &&
          /^\/api\/library\/[^/?]+(?:\?.*)?$/.test(request.url)) ||
          (request.method === "POST" &&
            /^\/api\/books\/[^/?]+\/keep(?:\?.*)?$/.test(request.url)))
      )
        return done(null, undefined);
      parseJson(request, String(body), done);
    },
  );
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    allowList: (request) => !request.url.startsWith("/api/"),
  });
  await app.register(multipart, {
    limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 200, fields: 10 },
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode || 400;
    const retry = error as { retryable?: boolean; retryAfterMs?: number };
    if (retry.retryable && retry.retryAfterMs !== undefined)
      reply.header("Retry-After", Math.ceil(retry.retryAfterMs / 1000));
    reply.code(status).send({
      ...(typeof retry.retryable === "boolean"
        ? { retryable: retry.retryable, retryAfterMs: retry.retryAfterMs }
        : {}),
      error:
        error instanceof z.ZodError
          ? "Please check the information you entered."
          : error instanceof Error
            ? error.message
            : "Something went wrong. Please try again.",
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin
    ) {
      const origin = new URL(req.headers.origin);
      const allowed =
        origin.host === req.headers.host ||
        (process.env.NODE_ENV !== "production" &&
          ["localhost:5173", "127.0.0.1:5173"].includes(origin.host));
      if (!allowed)
        return reply
          .code(403)
          .send({ error: "This request came from an unrecognized origin." });
    }
    if (
      ["/api/auth/status", "/api/auth/login", "/api/health"].includes(
        req.url.split("?")[0],
      )
    )
      return;
    if (process.env.APP_PASSWORD) {
      const token = req.cookies.sonder_session;
      const session =
        token &&
        db
          .select()
          .from(s.sessions)
          .where(
            and(
              eq(s.sessions.token, hashToken(token)),
              gt(s.sessions.expiresAt, Date.now()),
            ),
          )
          .get();
      if (!session)
        return reply
          .code(401)
          .send({ error: "Sign in to your listening space." });
    }
  });
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/auth/status", async (req) => ({
    required: !!process.env.APP_PASSWORD,
    authenticated:
      !process.env.APP_PASSWORD ||
      !!(
        req.cookies.sonder_session &&
        db
          .select()
          .from(s.sessions)
          .where(
            and(
              eq(s.sessions.token, hashToken(req.cookies.sonder_session)),
              gt(s.sessions.expiresAt, Date.now()),
            ),
          )
          .get()
      ),
  }));
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const { password } = z
        .object({ password: z.string().max(512) })
        .parse(req.body);
      if (!process.env.APP_PASSWORD || !passwordMatches(password))
        return reply
          .code(401)
          .send({ error: "That password doesn’t match. Try again." });
      const token = randomBytes(32).toString("hex");
      sqlite
        .prepare("DELETE FROM sessions WHERE expires_at < ?")
        .run(Date.now());
      db.insert(s.sessions)
        .values({
          token: hashToken(token),
          expiresAt: Date.now() + 30 * 86400000,
        })
        .run();
      return reply
        .setCookie("sonder_session", token, {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
          secure: process.env.COOKIE_SECURE === "true",
          maxAge: 30 * 86400,
        })
        .send({ ok: true });
    },
  );
  app.post("/api/auth/logout", async (req, reply) => {
    if (req.cookies.sonder_session)
      db.delete(s.sessions)
        .where(eq(s.sessions.token, hashToken(req.cookies.sonder_session)))
        .run();
    reply.clearCookie("sonder_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/books", async () => listBooks());
  registerHardcoverRoutes(app);
  registerAppearance(app);
  registerReader(app);
  registerAlignment(app);
  registerMediaLibrary(app);
  app.post("/api/library", async (req) => {
    const { bookId } = z.object({ bookId: z.string() }).parse(req.body);
    if (!db.select().from(s.editions).where(eq(s.editions.id, bookId)).get())
      throw new Error("This book could not be found.");
    db.delete(s.hiddenLibrary).where(eq(s.hiddenLibrary.bookId, bookId)).run();
    db.insert(s.library)
      .values({ bookId, status: "unread", addedAt: Date.now() })
      .onConflictDoNothing()
      .run();
    const edition = db
      .select()
      .from(s.editions)
      .where(eq(s.editions.id, bookId))
      .get();
    if (edition) queueHardcoverStatus(edition.workId, "unread", "add");
    return { ok: true };
  });
  app.patch("/api/library/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { status } = z
      .object({ status: z.enum(["unread", "listening", "finished"]) })
      .parse(req.body);
    db.update(s.library).set({ status }).where(eq(s.library.bookId, id)).run();
    const edition = db
      .select()
      .from(s.editions)
      .where(eq(s.editions.id, id))
      .get();
    if (edition) queueHardcoverStatus(edition.workId, status);
    return { ok: true };
  });
  app.delete("/api/library/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (db.select().from(s.editions).where(eq(s.editions.id, id)).get())
      db.insert(s.hiddenLibrary)
        .values({ bookId: id })
        .onConflictDoNothing()
        .run();
    db.delete(s.library)
      .where(eq(s.library.bookId, (req.params as { id: string }).id))
      .run();
    return { ok: true };
  });
  app.post("/api/progress", async (req) => {
    const p = z
      .object({
        recordingId: z.string(),
        trackId: z.string(),
        position: z.number().finite().min(0).max(604800),
        duration: z.number().finite().min(0).max(604800),
        updatedAt: z
          .number()
          .int()
          .min(0)
          .max(Date.now() + 300000),
      })
      .parse(req.body);
    const track = db
      .select()
      .from(s.tracks)
      .where(
        and(
          eq(s.tracks.id, p.trackId),
          eq(s.tracks.recordingId, p.recordingId),
        ),
      )
      .get();
    if (!track)
      throw new Error("This chapter does not belong to the recording.");
    const current = db
      .select()
      .from(s.progress)
      .where(eq(s.progress.recordingId, p.recordingId))
      .get();
    if (current && current.updatedAt > p.updatedAt)
      return { progress: current, conflict: true };
    db.insert(s.progress)
      .values(p)
      .onConflictDoUpdate({ target: s.progress.recordingId, set: p })
      .run();
    if (p.duration > 0)
      db.update(s.tracks)
        .set({ duration: p.duration })
        .where(eq(s.tracks.id, p.trackId))
        .run();
    const rec = db
      .select()
      .from(s.recordings)
      .where(eq(s.recordings.id, p.recordingId))
      .get();
    if (rec) {
      const changed = db
        .update(s.library)
        .set({ status: "listening" })
        .where(
          and(
            eq(s.library.bookId, rec.editionId),
            eq(s.library.status, "unread"),
          ),
        )
        .run();
      if (changed.changes) {
        const edition = db
          .select()
          .from(s.editions)
          .where(eq(s.editions.id, rec.editionId))
          .get();
        if (edition)
          queueHardcoverStatus(
            edition.workId,
            "listening",
            "status",
            p.updatedAt,
          );
      }
    }
    queueHardcoverProgress(p.recordingId);
    return { progress: p, conflict: false };
  });
  app.get("/api/settings", async () => ({
    name: getSetting("name") || "My listening space",
    torboxConfigured: !!getSetting("torbox"),
    hardcoverConfigured: !!getSetting("hardcover"),
    abbUrl: getSetting("abbUrl") || "https://audiobookbay.lu",
    annasUrl: getSetting("annasUrl") || "https://annas-archive.gl",
    libgenUrl: getSetting("libgenUrl") || "https://libgen.li",
    annasConfigured: !!getSetting("annas"),
    prowlarrUrl: getSetting("prowlarrUrl") || "",
    prowlarrConfigured: !!prowlarrConfig(),
    localConfigured: transmissionConfigured(),
    storageLabel: "4 TB media drive",
    authenticationEnabled: !!process.env.APP_PASSWORD,
  }));
  app.patch("/api/settings", async (req) => {
    const input = z
      .object({
        name: z.string().min(1).max(60).optional(),
        torbox: z.string().max(300).optional(),
        hardcover: z.string().max(2000).optional(),
        abbUrl: z.url().optional(),
        annasUrl: z.url().optional(),
        libgenUrl: z.url().optional(),
        annas: z.string().max(1000).optional(),
        prowlarrUrl: z.union([z.url(), z.literal("")]).optional(),
        prowlarr: z.string().max(200).optional(),
      })
      .parse(req.body);
    if (input.prowlarrUrl) input.prowlarrUrl = normalizeBaseUrl(input.prowlarrUrl);
    if (input.abbUrl) {
      const u = new URL(input.abbUrl);
      if (
        u.protocol !== "https:" ||
        !/^([a-z0-9-]+\.)*audiobookbay\.[a-z]{2,6}$/.test(u.hostname)
      )
        throw new Error(
          "Use an HTTPS AudioBookBay mirror, for example https://audiobookbay.lu.",
        );
      input.abbUrl = u.origin;
    }
    for (const field of ["annasUrl", "libgenUrl"] as const) {
      if (input[field]) {
        const url = new URL(input[field]!);
        const valid =
          field === "annasUrl"
            ? /^([a-z0-9-]+\.)?annas-archive\.[a-z]{2,8}$/
            : /^([a-z0-9-]+\.)?libgen\.[a-z]{2,8}$/;
        if (
          url.protocol !== "https:" ||
          !valid.test(url.hostname) ||
          url.username ||
          url.password ||
          url.port
        )
          throw new Error("Use an HTTPS mirror of the selected ebook source.");
        input[field] = url.origin;
      }
    }
    if (
      input.hardcover !== undefined &&
      input.hardcover !== getSecret("hardcover")
    )
      resetHardcoverAccount();
    for (const [key, value] of Object.entries(input)) {
      if (value === "") {
        db.delete(s.settings).where(eq(s.settings.key, key)).run();
        continue;
      }
      const v = ["torbox", "hardcover", "annas", "prowlarr"].includes(key)
        ? encrypt(value)
        : value;
      db.insert(s.settings)
        .values({ key, value: v })
        .onConflictDoUpdate({ target: s.settings.key, set: { value: v } })
        .run();
    }
    return { ok: true };
  });
  app.post("/api/prowlarr/test", async () => {
    const config = prowlarrConfig();
    if (!config) throw new Error("Enter the Prowlarr address and API key first.");
    return { ok: true, ...(await prowlarrStatus(config)) };
  });
  app.post("/api/torbox/test", async () => {
    await torbox("user/me");
    return { ok: true };
  });
  app.get("/api/torbox/files", async () => {
    const data = (await torbox("torrents/mylist")) as {
      id: number;
      name: string;
      download_present?: boolean;
      files?: { id: number; name: string; short_name?: string; size: number }[];
    }[];
    return (Array.isArray(data) ? data : [])
      .filter((t) => t.download_present)
      .map((t) => ({
        ...t,
        files: (t.files || []).filter((f) =>
          /\.(m4b|m4a|mp3|ogg|flac|opus|wav)$/i.test(f.name),
        ),
      }))
      .filter((t) => t.files.length);
  });
  app.post("/api/torbox/import", async (req) => {
    const { torrentId } = z
      .object({ torrentId: z.number().int().nonnegative() })
      .parse(req.body);
    const torrent = (await torbox(`torrents/mylist?id=${torrentId}`)) as {
      id: number;
      name: string;
      download_present?: boolean;
      files?: { id: number; name: string; short_name?: string; size: number }[];
    };
    if (!torrent?.download_present)
      throw new Error(
        "This torrent is still downloading in TorBox. Try again when it’s ready.",
      );
    const files = (torrent.files || [])
      .filter((f) => /\.(m4b|m4a|mp3|ogg|flac|opus|wav)$/i.test(f.name))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    if (!files.length)
      throw new Error("This torrent contains no supported audio files.");
    const id = `torbox-${torrentId}`;
    if (db.select().from(s.editions).where(eq(s.editions.id, id)).get()) {
      db.insert(s.library)
        .values({ bookId: id, status: "unread", addedAt: Date.now() })
        .onConflictDoNothing()
        .run();
      return { id };
    }
    sqlite.transaction(() => {
      db.insert(s.works)
        .values({
          id: `work-${id}`,
          title: torrent.name,
          author: "Unknown author",
          description: "Imported from your TorBox library.",
          genre: "Audiobook",
          year: new Date().getFullYear(),
        })
        .run();
      db.insert(s.editions)
        .values({
          id,
          workId: `work-${id}`,
          cover: "/covers/time.svg",
          narrator: "Unknown narrator",
          rating: 0,
          sourceLabel: "TorBox",
        })
        .run();
      db.insert(s.recordings)
        .values({ id: `recording-${id}`, editionId: id })
        .run();
      files.forEach((f, index) =>
        db
          .insert(s.tracks)
          .values({
            id: `${id}-${f.id}`,
            recordingId: `recording-${id}`,
            title:
              f.short_name || f.name.split("/").pop() || `Chapter ${index + 1}`,
            index,
            duration: 0,
            source: JSON.stringify({ torrentId, fileId: f.id }),
            sourceType: "torbox",
          })
          .run(),
      );
      db.insert(s.library)
        .values({ bookId: id, status: "unread", addedAt: Date.now() })
        .run();
    })();
    return { id };
  });
  const acquisitionInput = z.object({
    magnet: z.string().startsWith("magnet:?").max(10000),
    title: z.string().max(300).optional(),
    author: z.string().max(200).optional(),
    cover: z.string().max(2000).optional(),
  });
  app.post("/api/acquire", async (req) => {
    const input = acquisitionInput.parse(req.body);
    return acquire(input.magnet, input);
  });
  app.post("/api/torbox/magnet", async (req) => {
    const input = acquisitionInput.parse(req.body);
    return acquire(input.magnet, input);
  });
  app.get("/api/acquisitions", async () => [
    ...db
      .select()
      .from(s.acquisitions)
      .all()
      .map(({ magnet, ...job }) => job),
    ...listServerDownloads(),
  ]);
  app.post("/api/books/:id/keep", async (req) =>
    requestServerDownload((req.params as { id: string }).id),
  );
  app.post("/api/acquisitions/:id/control", async (req) => {
    const { id } = req.params as { id: string };
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "retry"]) })
      .parse(req.body);
    if (id.startsWith("copy-")) {
      const recordingId = id.slice(5);
      const copy = db
        .select()
        .from(s.serverDownloads)
        .where(eq(s.serverDownloads.recordingId, recordingId))
        .get();
      if (!copy) throw new Error("This download could not be found.");
      if (action === "pause") pauseServerDownload(recordingId);
      else requestServerDownload(copy.bookId);
      return { ok: true };
    }
    const job = db
      .select()
      .from(s.acquisitions)
      .where(eq(s.acquisitions.id, id))
      .get();
    if (!job) throw new Error("This download could not be found.");
    if (action === "retry") {
      db.update(s.acquisitions)
        .set({ status: "error" })
        .where(eq(s.acquisitions.id, id))
        .run();
      return acquire(job.magnet, {
        title: job.title,
        author: job.author,
        cover: job.cover,
        workId: job.workId || undefined,
        language: job.language,
        narrator: job.narrator,
      });
    }
    if (job.backend !== "local" || job.status === "ready")
      throw new Error("Only active local downloads can be paused or resumed.");
    await transmission(action === "pause" ? "torrent-stop" : "torrent-start", {
      ids: [job.hash],
    });
    db.update(s.acquisitions)
      .set({
        status: action === "pause" ? "paused" : "downloading",
        error: null,
        updatedAt: Date.now(),
      })
      .where(eq(s.acquisitions.id, id))
      .run();
    return { ok: true };
  });
  app.post("/api/local/test", async () => {
    ensureMediaStorage();
    const session = await transmission<{
      version: string;
      "download-dir": string;
      "incomplete-dir": string;
    }>("session-get");
    return {
      ok: true,
      version: session.version,
      storage: "4 TB media drive",
      downloadDir: session["download-dir"],
      incompleteDir: session["incomplete-dir"],
    };
  });
  app.get("/api/discover/abb", async (req) => {
    const { q } = z.object({ q: z.string().min(2).max(150) }).parse(req.query);
    return abbSearch(q);
  });
  const abbSlug = z
    .string()
    .max(300)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N}._~-]*$/u);
  app.get("/api/discover/abb/releases", async (req) => {
    const { q, page } = z
      .object({
        q: z.string().min(2).max(150),
        page: z.coerce.number().int().min(1).max(100).default(1),
      })
      .parse(req.query);
    return abbReleaseSearch(q, page);
  });
  app.get("/api/discover/abb/releases/:slug", async (req) => {
    return abbRelease(abbSlug.parse((req.params as { slug: string }).slug));
  });
  app.post("/api/discover/abb/add", async (req) => {
    const input = z
      .object({
        slug: abbSlug,
        title: z.string().max(300).optional(),
        author: z.string().max(200).optional(),
        cover: z.string().max(2000).optional(),
        workId: z.string().max(100).optional(),
      })
      .parse(req.body);
    const release = await abbRelease(input.slug);
    return acquire(await abbMagnet(input.slug), {
      ...input,
      title: release.title,
      author: release.author,
      cover: release.cover,
      language: release.language,
      narrator: release.narrator,
    });
  });
  app.get("/api/discover/prowlarr/releases", async (req) => {
    const { q } = z
      .object({ q: z.string().min(2).max(150) })
      .parse(req.query);
    return prowlarrReleaseSearch(q);
  });
  app.post("/api/discover/prowlarr/add", async (req) => {
    const input = z
      .object({
        id: z.string().regex(/^prowlarr-[a-f0-9]{32}$/),
        workId: z.string().max(100).optional(),
      })
      .parse(req.body);
    const link = prowlarrRelease(input.id);
    const work = input.workId
      ? db.select().from(s.works).where(eq(s.works.id, input.workId)).get()
      : undefined;
    if (input.workId && !work)
      throw new Error("The selected book could not be found.");
    return acquire(await prowlarrMagnet(input.id), {
      workId: input.workId,
      title: work?.title || releaseDisplayTitle(link.title),
      author: work?.author,
    });
  });
  app.get("/api/discover/ebooks", async (req) => {
    const { source, q, page } = z
      .object({
        source: z.enum(["annas", "libgen"]),
        q: z.string().min(2).max(150),
        page: z.coerce.number().int().min(1).max(100).default(1),
      })
      .parse(req.query);
    return searchEbooks(source, q, page);
  });
  app.post("/api/ebooks", async (req) => {
    const input = z
      .object({
        source: z.enum(["annas", "libgen"]),
        md5: z.string().regex(/^[a-f0-9]{32}$/i),
        title: z.string().min(1).max(300),
        authors: z.array(z.string().max(200)).max(30),
        extension: z.enum(["epub", "pdf"]),
        language: z.string().nullable(),
        size: z.string().nullable(),
        year: z.string().nullable(),
        coverUrl: z.string().nullable(),
        url: z.string().max(2000),
        workId: z.string().optional(),
      })
      .parse(req.body);
    return saveEbook(input);
  });
  app.get("/api/ebooks", async () => listEbooks());
  app.post("/api/ebooks/import", async (req) => {
    const { workId } = z
      .object({ workId: z.string().max(100).optional() })
      .parse(req.query);
    const part = await req.file({
      limits: { fileSize: 150 * 1024 * 1024, files: 1 },
    });
    if (!part) throw new Error("Choose an EPUB or PDF file.");
    return importEbook(part.file, part.filename, workId);
  });
  app.get("/api/ebooks/:id/file", async (req, reply) => {
    const row = db
      .select()
      .from(s.ebookEditions)
      .where(eq(s.ebookEditions.id, (req.params as { id: string }).id))
      .get();
    if (!row || !existsSync(row.source))
      return reply
        .code(404)
        .send({ error: "This ebook is no longer on the media drive." });
    const work = db
      .select()
      .from(s.works)
      .where(eq(s.works.id, row.workId))
      .get();
    const filename = (work?.title || "ebook")
      .replace(/[^a-zA-Z0-9 ._-]/g, "")
      .slice(0, 120);
    reply
      .header(
        "Content-Type",
        row.format === "epub" ? "application/epub+zip" : "application/pdf",
      )
      .header(
        "Content-Disposition",
        `attachment; filename="${filename}.${row.format}"`,
      )
      .header("Content-Length", statSync(row.source).size)
      .header("Cache-Control", "private, no-store");
    return reply.send(createReadStream(row.source));
  });
  let queueRunning = false;
  const poll = async () => {
    if (queueRunning) return;
    queueRunning = true;
    try {
      await refreshQueue();
      void processServerDownloads().catch(() => {});
    } finally {
      queueRunning = false;
    }
  };
  const queueTimer = setInterval(() => void poll().catch(() => {}), 10000);
  queueTimer.unref();
  void poll().catch(() => {});
  app.addHook("onClose", async () => {
    clearInterval(queueTimer);
    stopServerDownloads();
  });
  const hardcoverTimer = setInterval(
    () => void tickHardcover().catch(() => {}),
    60000,
  );
  hardcoverTimer.unref();
  void tickHardcover().catch(() => {});
  app.addHook("onClose", async () => clearInterval(hardcoverTimer));
  app.get("/api/discover/hardcover", async (req) => {
    const { q } = z.object({ q: z.string().min(2).max(150) }).parse(req.query);
    return hardcoverSearch(q);
  });
  app.post("/api/import", async (req) => {
    let title = "";
    let author = "Unknown author";
    const stored: {
      path: string;
      title: string;
      duration: number;
      id: string;
      chapters: Chapter[];
    }[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "title")
            title = String(part.value).slice(0, 200);
          if (part.fieldname === "author")
            author = String(part.value).slice(0, 200);
          continue;
        }
        const ext = extname(part.filename).toLowerCase();
        if (
          ![".mp3", ".m4b", ".m4a", ".ogg", ".opus", ".flac", ".wav"].includes(
            ext,
          )
        ) {
          part.file.resume();
          throw new Error(
            "Choose MP3, M4B, M4A, OGG, Opus, FLAC, or WAV audio files.",
          );
        }
        const id = randomUUID();
        const path = join(uploadDir, `${id}${ext}`);
        const temp = path + ".part";
        stored.push({
          path: temp,
          title: part.filename.replace(/\.[^.]+$/, ""),
          duration: 0,
          id,
          chapters: [],
        });
        await pipeline(
          part.file,
          await import("node:fs").then((fs) =>
            fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }),
          ),
        );
        if (part.file.truncated)
          throw new Error("This file exceeds the 4 GB upload limit.");
        const meta = await parseFile(temp, {
          duration: true,
          includeChapters: true,
          skipCovers: true,
        });
        if (!meta.format.codec)
          throw new Error("This file does not contain recognizable audio.");
        renameSync(temp, path);
        stored[stored.length - 1] = {
          path,
          title: meta.common.title || part.filename.replace(/\.[^.]+$/, ""),
          duration: meta.format.duration || 0,
          id,
          chapters: normalizeChapters(
            meta.format.chapters,
            meta.format.duration || 0,
          ),
        };
        if (!title)
          title =
            meta.common.album ||
            meta.common.title ||
            part.filename.replace(/\.[^.]+$/, "");
        if (author === "Unknown author") author = meta.common.artist || author;
      }
      if (!stored.length) throw new Error("Choose at least one audio file.");
      const id = randomUUID();
      const workId = hardcoverWorkForMedia(title, author) || `work-${id}`;
      sqlite.transaction(() => {
        db.insert(s.works)
          .values({
            id: workId,
            title: title || "Untitled audiobook",
            author,
            description: "An audiobook from your own collection.",
            genre: "Audiobook",
            year: new Date().getFullYear(),
          })
          .onConflictDoNothing()
          .run();
        db.insert(s.editions)
          .values({
            id,
            workId,
            cover: "/covers/meditations.svg",
            narrator: author,
            rating: 0,
            sourceLabel: "Your audio files",
          })
          .run();
        db.insert(s.recordings)
          .values({ id: `recording-${id}`, editionId: id })
          .run();
        stored.forEach((f, index) =>
          db
            .insert(s.tracks)
            .values({
              id: f.id,
              recordingId: `recording-${id}`,
              title: f.title,
              index,
              duration: f.duration,
              chapters: f.chapters,
              source: f.path,
              sourceType: "local",
            })
            .run(),
        );
        db.insert(s.library)
          .values({ bookId: id, status: "unread", addedAt: Date.now() })
          .run();
        claimHardcoverAudio(workId, id);
      })();
      return { id };
    } catch (error) {
      stored.forEach((f) => {
        if (existsSync(f.path)) unlinkSync(f.path);
      });
      throw error;
    }
  });
  app.get("/api/media/:id/location", async (req, reply) => {
    const track = db
      .select()
      .from(s.tracks)
      .where(eq(s.tracks.id, (req.params as { id: string }).id))
      .get();
    if (!track)
      return reply
        .code(404)
        .send({ error: "This chapter could not be found." });
    const choice=sourceChoice.default('auto').parse((req.query as {source?:string}).source);
    const selected=chooseMedia(track,choice);
    return {source:selected.sourceType==='local'?'server':selected.sourceType==='torbox'?'torbox':'remote'};
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/api/media/:id",
    config: {
      rateLimit: {
        max: 12000,
        timeWindow: "1 minute",
        keyGenerator: (request) => `media:${request.ip}`,
      },
    },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      let track = db.select().from(s.tracks).where(eq(s.tracks.id, id)).get();
      if (!track)
        return reply
          .code(404)
          .send({ error: "This chapter could not be found." });
      const choice=sourceChoice.default('auto').parse((req.query as {source?:string}).source);
      track=chooseMedia(track,choice);
      const localStat =
        track.sourceType === "local" && existsSync(track.source)
          ? statSync(track.source)
          : null;
      reply.header(
        "X-Sonder-Media-Source",
        track.sourceType === "local"
          ? "server"
          : track.sourceType === "torbox"
            ? "torbox"
            : "remote",
      );
      reply.header(
        "X-Sonder-Media-Version",
        createHash("sha256")
          .update(
            `${track.sourceType}:${track.source}:${localStat?.size || ""}:${localStat?.mtimeMs || ""}`,
          )
          .digest("hex"),
      );
      if (track.sourceType === "local") {
        const path = track.source.startsWith("/audio/")
          ? resolve("public" + track.source)
          : track.source;
        if (!existsSync(path))
          return reply
            .code(404)
            .send({ error: "This audio file is no longer available." });
        const size = statSync(path).size;
        const range = parseRange(req.headers.range, size);
        reply
          .header("Accept-Ranges", "bytes")
          .header("Content-Type", mime(path))
          .header("Cache-Control", "private, no-store");
        if (range === "invalid")
          return reply
            .code(416)
            .header("Content-Range", `bytes */${size}`)
            .send();
        const start = range?.start || 0;
        const end = range?.end ?? size - 1;
        reply.header("Content-Length", end - start + 1);
        if (range)
          reply
            .code(206)
            .header("Content-Range", `bytes ${start}-${end}/${size}`);
        return req.method === "HEAD"
          ? reply.send()
          : reply.send(createReadStream(path, { start, end }));
      }
      let url = track.source;
      if (track.sourceType === "torbox") {
        const source = JSON.parse(track.source);
        url = await torboxUrl(source.torrentId, source.fileId);
      }
      // Sources are server-created archive URLs or freshly resolved TorBox links, never client-supplied proxy URLs.
      const aborter = new AbortController();
      req.raw.once("aborted", () => aborter.abort());
      reply.raw.once("close", () => aborter.abort());
      // Bound connection setup, not the entire audiobook transfer. Large M4Bs
      // can legitimately take far longer than two minutes to save or play.
      const headersTimeout = setTimeout(() => aborter.abort(), 30000);
      let response: Response;
      try {
        response = await fetch(url, {
          method: req.method,
          headers: {
            "Accept-Encoding": "identity",
            ...(req.headers.range ? { Range: req.headers.range } : {}),
          },
          signal: aborter.signal,
        });
        if (
          track.sourceType === "torbox" &&
          [401, 403, 410].includes(response.status)
        ) {
          await response.body?.cancel();
          const source = JSON.parse(track.source);
          url = await torboxUrl(source.torrentId, source.fileId, true);
          response = await fetch(url, {
            method: req.method,
            headers: {
              "Accept-Encoding": "identity",
              ...(req.headers.range ? { Range: req.headers.range } : {}),
            },
            signal: aborter.signal,
          });
        }
      } catch (error) {
        if (typeof (error as { retryable?: boolean }).retryable === "boolean")
          throw error;
        throw Object.assign(
          new Error(
            "The audio source connection was interrupted. Retry to continue the download.",
          ),
          { statusCode: 503, retryable: true, retryAfterMs: 1000 },
        );
      } finally {
        clearTimeout(headersTimeout);
      }
      if (!response.ok && response.status !== 416) {
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(
          response.status,
        );
        const retryAfterMs = retryDelayFromHeader(
          response.headers.get("retry-after"),
        );
        await response.body?.cancel();
        if (retryable)
          reply.header("Retry-After", Math.ceil(retryAfterMs / 1000));
        return reply.code(retryable ? 503 : 502).send({
          retryable,
          retryAfterMs,
          error:
            "The audio source is temporarily unavailable. Try again shortly.",
        });
      }
      if (
        !req.headers.range &&
        response.status === 206 &&
        !isCompleteMediaResponse(response)
      ) {
        await response.body?.cancel();
        return reply
          .code(502)
          .send({
            error:
              "The source returned only part of this chapter. Retry using the current app or save another release.",
            retryable: true,
          });
      }
      reply.code(
        !req.headers.range && response.status === 206 ? 200 : response.status,
      );
      for (const key of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
      ]) {
        const v = response.headers.get(key);
        if (key === "content-range" && !req.headers.range) continue;
        if (
          key === "content-length" &&
          response.headers.get("content-encoding") &&
          response.headers.get("content-encoding") !== "identity"
        )
          continue;
        if (v) reply.header(key, v);
      }
      reply.header("Cache-Control", "private, no-store");
      if (!response.body) return reply.send();
      return reply.send(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        ),
      );
    },
  });
  if (existsSync(resolve("dist/index.html"))) {
    await app.register(staticFiles, { root: resolve("dist"), wildcard: false });
    app.setNotFoundHandler(async (req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
