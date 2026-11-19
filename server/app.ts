import { currentUser, currentUserId, getUserSecret, issueSession, sessionUser, requireAdmin, registerUsers, verifyPassword } from "./users.ts";
import Fastify, { type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { randomUUID, createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { resolve, join, extname, relative, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { parseFile } from "music-metadata";
import { audioParseOptions, normalizeChapters, type Chapter } from "./chapters.ts";
import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { db, sqlite, dataDir } from "./db.ts";
import * as s from "./schema.ts";
import { seed } from "./seed.ts";
import { removeUserLibraryRow, setLibraryOrigin } from "./library-origin.ts";
import {
  hardcoverForWork,
  hardcoverWorkForMedia,
  hiddenHardcoverPlaceholders,
} from "./hardcover.ts";
import { registerHardcoverRoutes } from "./hardcover-routes.ts";
import { switchFromHardcover } from "./hardcover-switch.ts";
import { registerCatalogueRoutes } from "./catalogue-routes.ts";
import { registerSeriesRoutes } from "./series-routes.ts";
import { savedSeriesRefreshLoop } from "./series-catalogue.ts";
import { discardResave, retryResave, seriesResaveLoop } from "./series-resave.ts";
import { catalogueRefreshLoop } from "./catalogue-links.ts";
import { audiobookDbKey } from "./audiobookdb.ts";
import { claimWorkAudio, joinLibraryWithEbook, joinShelfEbooksOnce } from "./work-library.ts";
import { registerEbookSetRoutes } from "./ebook-set-routes.ts";
import { CSP_REPORT_PATH, cspMode, registerCsp } from "./csp.ts";
import { registerAppearance } from "./appearance.ts";
import { registerAccountRequests } from "./account-requests.ts";
import { registerInvites } from "./invites.ts";
import { registerReader } from "./reader.ts";
import { registerLibraryWorks } from "./library-works.ts";
import { registerDeviceKeep } from "./device-keep.ts";
import { registerAlignment, autoQueueAlignmentsForWork, persistedPoolErrors, resumeAlignmentJob } from "./alignment.ts";
import { checkPoolHostsSetting, getAlignmentPoolCoordinator, getAlignmentPoolStatus } from "./alignment-pool.ts";
import { hostRestartStates, restartPoolHost } from "./alignment-host-control.ts";
import { activitySamplerLoop, registerActivity } from "./activity.ts";
import { backgroundRunner, type BackgroundOptions } from "./background-runner.ts";
import { databaseBackupLoop } from "./backups.ts";
import { pauseState, setHostDisabled, setPaused } from "./activity-pause.ts";
import {registerMediaLibrary,faultsFor,chooseMedia,sourceChoice,deliveredTracks} from "./media-library.ts";
import { audioFileMime } from "./media-response.ts";
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
import { serverStorage, type StorageProbe } from "./server-storage.ts";
import { acquireReplacing, acquisitionsLoop, cancelAcquisition, controlAcquisition } from "./acquisitions.ts";
import { acquireForNewBook } from "./new-book.ts";
import { retrySeriesAcquisitionJob, seriesAcquisitionLoop } from "./series-acquisition.ts";
import { getTorrentStates, transmission, transmissionConfigured } from "./transmission.ts";
import { getTorrentHealth } from "./torrent-health.ts";
import { searchEbooks, saveEbook, listEbooks, importEbook } from "./ebooks.ts";
import { reevaluateEbookSetForWork } from "./ebook-set.ts";
import { ebookSetEvaluationLoop, registerUploadedEbookSetMember, retryEbookSetMember } from "./ebook-set-evaluation.ts";
import {
  requestServerDownload,
  serverCopiesLoop,
  pauseServerDownload,
  listServerDownloads,
} from "./downloads.ts";
import { encrypt, passwordMatches, hashToken } from "./security.ts";
import {
  getSetting,
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
import { getWorkMediaStates } from "./work-media-state.ts";
const uploadDir = importedDir;
export function listBooks(userId = 1): Book[] {
  const allTracks = db.select().from(s.tracks).all();
  const allProgress = db.select().from(s.userProgress).where(eq(s.userProgress.userId, userId)).all();
  const lib = db.select().from(s.userLibrary).where(eq(s.userLibrary.userId, userId)).all();
  const hidden = hiddenHardcoverPlaceholders(userId);
  const libraryWorkIds = sqlite
    .prepare(
      "SELECT DISTINCT e.work_id AS workId FROM user_library u JOIN audio_editions e ON e.id=u.book_id WHERE u.user_id=?",
    )
    .all(userId) as { workId: string }[];
  const mediaStates = getWorkMediaStates(
    userId,
    libraryWorkIds.map((row) => row.workId),
  );
  return db
    .select({ work: s.works, edition: s.editions, recording: s.recordings })
    .from(s.editions)
    .innerJoin(s.works, eq(s.works.id, s.editions.workId))
    .innerJoin(s.recordings, eq(s.recordings.editionId, s.editions.id))
    .all()
    .filter(({ edition }) => !hidden.has(edition.id))
    .map(({ work, edition, recording }) => {
      const saved = lib.find((l) => l.bookId === edition.id);
      const faults=faultsFor(recording.id);
      const { tracks, serverStored } = deliveredTracks(
        allTracks.filter((t) => t.recordingId === recording.id),
        faults,
      );
      return {
        serverStored,
        faults,
        hardcover: hardcoverForWork(userId, work.id),
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
        mediaState: saved ? (mediaStates.get(work.id) ?? null) : null,
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
const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
/** `LOG_LEVEL` from the environment; unset or unrecognised values fall back to `info`. */
export function logLevel(value = process.env.LOG_LEVEL) {
  const level = value?.trim().toLowerCase();
  return level && LOG_LEVELS.has(level) ? level : "info";
}
export async function createApp(options?: {
  logger?: FastifyServerOptions["logger"];
  /** Tests: run the background loops by hand (see `server/background-runner.ts`). */
  background?: BackgroundOptions;
  /** Tests: the media drive's check and sizes for `GET /api/settings` (see `server/server-storage.ts`). */
  storage?: StorageProbe;
}) {
  checkPoolHostsSetting();
  ensureMediaStorage();
  seed();
  // Once: the shelf ebooks outside the administrator's library join it through their placeholders (#555).
  joinShelfEbooksOnce();
  sqlite
    .prepare("UPDATE tracks SET source=? WHERE id=? AND source=?")
    .run(
      join(mediaRoot, "demo", "alice-01.mp3"),
      "alice-0",
      "/audio/alice-01.mp3",
    );
  const app = Fastify({
    logger: options?.logger ?? (process.env.NODE_ENV !== "test" ? { level: logLevel() } : false),
    bodyLimit: 1024 * 1024,
    disableRequestLogging: true,
    trustProxy: "loopback",
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
          (/^\/api\/library\/[^/?]+(?:\?.*)?$/.test(request.url) ||
            /^\/api\/series\/[^/?]+(?:\?.*)?$/.test(request.url))) ||
          // Add to library and Remove from library by work (#527) take no body.
          (["PUT", "DELETE"].includes(request.method) &&
            /^\/api\/works\/[^/?]+\/library(?:\?.*)?$/.test(request.url)) ||
          // Keep on this device (#549) takes no body, or an optional one.
          (["PUT", "DELETE"].includes(request.method) &&
            /^\/api\/works\/[^/?]+\/keep(?:\?.*)?$/.test(request.url)) ||
          (request.method === "POST" &&
            /^\/api\/books\/[^/?]+\/keep(?:\?.*)?$/.test(request.url)))
      )
        return done(null, undefined);
      parseJson(request, String(body), done);
    },
  );
  await app.register(cookie);
  await app.register(rateLimit, {
    max: Number(process.env.API_RATE_LIMIT || 600),
    timeWindow: "1 minute",
    allowList: (request) => !request.url.startsWith("/api/"),
    // Users in one household share a public IP; count each signed-in session
    // separately and fall back to the address for anonymous requests.
    keyGenerator: (request) => {
      if (request.url.startsWith("/api/auth/")) return `ip:${request.ip}`;
      const user = sessionUser(request);
      return user ? `user:${user.id}` : `ip:${request.ip}`;
    },
  });
  await app.register(multipart, {
    limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 200, fields: 10 },
  });
  app.setErrorHandler((error, request, reply) => {
    const { code } = error as { code?: unknown };
    // A Node I/O failure (missing file, unmounted volume…) is temporary, not a bad
    // request, so clients keep and retry their writes (N1).
    const system =
      !(error as { statusCode?: number }).statusCode &&
      typeof code === "string" &&
      /^E[A-Z0-9]+$/.test(code) &&
      ("errno" in (error as object) || "syscall" in (error as object));
    if (system) request.log.error(error);
    const status = system
      ? 503
      : (error as { statusCode?: number }).statusCode || 400;
    const retry = error as { retryable?: boolean; retryAfterMs?: number };
    if (retry.retryable && retry.retryAfterMs !== undefined)
      reply.header("Retry-After", Math.ceil(retry.retryAfterMs / 1000));
    reply.code(status).send({
      ...(typeof retry.retryable === "boolean"
        ? { retryable: retry.retryable, retryAfterMs: retry.retryAfterMs }
        : {}),
      // App-defined codes are lower snake case; Node and Fastify codes are not sent.
      ...(typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code)
        ? { code }
        : {}),
      error: system
        ? "The server can't read its files right now. Try again shortly."
        : error instanceof z.ZodError
          ? "Please check the information you entered."
          : error instanceof Error
            ? error.message
            : "Something went wrong. Please try again.",
    });
  });
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req, reply) => {
    req.user = sessionUser(req);
    if (!req.url.startsWith("/api/")) return;
    // Browsers post violation reports unauthenticated and, from an opaque-origin frame, with `Origin: null`.
    if (req.method === "POST" && req.url.split("?")[0] === CSP_REPORT_PATH) return;
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
      ["/api/auth/status", "/api/auth/login", "/api/health", "/api/account-requests", "/api/invites/verify", "/api/invites/claim"].includes(
        req.url.split("?")[0],
      )
    )
      return;
    if (!req.user) return reply.code(401).send({ error: "Sign in to your listening space." });
    // Queued writes carry the user they were queued under. Another tab may have
    // switched the shared session cookie since, so refuse rather than write
    // one user's data into another's account. Older clients omit the header.
    const expected = req.headers["x-sonder-user-id"];
    if (typeof expected === "string" && expected !== String(req.user.id))
      return reply.code(409).send({ error: "Signed in as a different user.", code: "user_mismatch" });
  });
  app.addHook("preHandler", async (req) => {
    const path = req.routeOptions.url || "";
    if (/^\/api\/(prowlarr|torbox)(?:\/|$)/.test(path) || /^\/api\/acquisitions(?:\/|$)/.test(path) || path === "/api/acquire" || path === "/api/torrents/health" || path === "/api/alignments/pool" || path === "/api/alignments/pool/staging" || path === "/api/alignments/pool/staging/remove" || path === "/api/local/test" || /^\/api\/discover\/(abb|prowlarr)(?:\/|$)/.test(path) || path === "/api/discover/ebooks" || (req.method === "POST" && ["/api/ebooks", "/api/ebooks/import", "/api/import"].includes(path)) || (req.method === "POST" && /^\/api\/books\/[^/]+\/keep$/.test(path)) || (req.method === "POST" && /^\/api\/reader\/[^/]+\/link$/.test(path)) || (["PUT", "DELETE"].includes(req.method) && /^\/api\/recordings\/[^/]+\/(faults\/[^/]+|server-copy)$/.test(path)) || (["POST", "PATCH"].includes(req.method) && /^\/api\/alignments(?:\/|$)/.test(path)) || (req.method === "POST" && /^\/api\/works\/[^/]+\/ebook-set\/fetch$/.test(path))) requireAdmin(req);
  });
  registerCsp(app, { mode: cspMode() });
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/auth/status", async (req) => ({ required: !!process.env.APP_PASSWORD, authenticated: !!sessionUser(req), user: sessionUser(req) }));
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes", keyGenerator: (request) => request.ip } } },
    async (req, reply) => {
      const { password, username } = z
        .object({ password: z.string().max(512), username: z.string().max(40).optional() })
        .parse(req.body);
      const isAdmin = !username || username.toLowerCase() === "admin";
      const user = isAdmin ? { id: 1, password_hash: null } : sqlite.prepare("SELECT id,password_hash FROM users WHERE username=? COLLATE NOCASE").get(username) as {id:number;password_hash:string | null} | undefined;
      if (!process.env.APP_PASSWORD || !user || !(isAdmin ? passwordMatches(password) : verifyPassword(password, user.password_hash)))
        return reply
          .code(401)
          .send({ error: "That password doesn’t match. Try again." });
      return issueSession(reply, user.id).send({ ok: true });
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
  app.get("/api/books", async (req) => listBooks(currentUserId(req)));
  registerLibraryWorks(app);
  registerDeviceKeep(app);
  registerUsers(app);
  registerAccountRequests(app);
  registerInvites(app);
  registerHardcoverRoutes(app);
  registerCatalogueRoutes(app);
  registerSeriesRoutes(app);
  registerEbookSetRoutes(app);
  registerAppearance(app);
  registerReader(app);
  // The background loops start in this order and stop in reverse when the app closes (ADR 0010).
  const background = backgroundRunner(app, options?.background);
  registerAlignment(app); // adds the alignment loop
  const activityDeps = {
    sqlite,
    getSetting,
    torrentHealth: () => getTorrentHealth(),
    poolStatus: () => getAlignmentPoolStatus({ persistedErrors: persistedPoolErrors() }),
    requireAdmin,
    userId: currentUserId,
    retryEbookSetMember,
    controlAcquisition: (id: string, action: "retry" | "resume", userId: number) => controlAcquisition(id, action, userId),
    torrentStates: (hashes: string[]) => getTorrentStates(hashes),
    cancelAcquisition: (id: string) => cancelAcquisition(id),
    resumeAlignment: resumeAlignmentJob,
    retrySeriesSearch: retrySeriesAcquisitionJob,
    retrySeriesResave: retryResave,
    discardSeriesResave: discardResave,
    pauseState,
    setPaused,
    workerHosts: {
      ids: () => getAlignmentPoolCoordinator().listHosts().map((host) => host.id),
      restart: (hostId: string, options: { force: boolean }) => restartPoolHost(hostId, options),
      setDisabled: setHostDisabled,
      restarts: hostRestartStates,
    },
  };
  registerActivity(app, activityDeps);
  background.add(activitySamplerLoop(app, activityDeps));
  registerMediaLibrary(app);
  app.post("/api/library", async (req) => {
    const { bookId } = z.object({ bookId: z.string() }).parse(req.body);
    if (!db.select().from(s.editions).where(eq(s.editions.id, bookId)).get())
      throw new Error("This book could not be found.");
    db.delete(s.userHiddenLibrary).where(and(eq(s.userHiddenLibrary.userId, currentUserId(req)), eq(s.userHiddenLibrary.bookId, bookId))).run();
    const addedAt = Date.now();
    const inserted =
      db
        .insert(s.userLibrary)
        .values({ userId: currentUserId(req), bookId, status: "unread", addedAt })
        .onConflictDoNothing()
        .run().changes > 0;
    const edition = db
      .select()
      .from(s.editions)
      .where(eq(s.editions.id, bookId))
      .get();
    if (inserted && edition)
      setLibraryOrigin(currentUserId(req), edition.workId, "manual", { addedAt });
    return { ok: true };
  });
  app.patch("/api/library/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { status } = z
      .object({ status: z.enum(["unread", "listening", "finished"]) })
      .parse(req.body);
    db.update(s.userLibrary).set({ status }).where(and(eq(s.userLibrary.userId, currentUserId(req)), eq(s.userLibrary.bookId, id))).run();
    const edition = db
      .select()
      .from(s.editions)
      .where(eq(s.editions.id, id))
      .get();
    if (edition && db.select().from(s.userLibrary).where(and(eq(s.userLibrary.userId, currentUserId(req)), eq(s.userLibrary.bookId, id))).get()) {
      if (status === "listening") db.delete(s.userWorkCompletion).where(and(eq(s.userWorkCompletion.userId, currentUserId(req)), eq(s.userWorkCompletion.workId, edition.workId))).run();
      else db.insert(s.userWorkCompletion).values({ userId: currentUserId(req), workId: edition.workId, status })
        .onConflictDoUpdate({ target: [s.userWorkCompletion.userId, s.userWorkCompletion.workId], set: { status } }).run();
    }
    return { ok: true };
  });
  app.delete("/api/library/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (db.select().from(s.editions).where(eq(s.editions.id, id)).get())
      db.insert(s.userHiddenLibrary)
        .values({ userId: currentUserId(req), bookId: id })
        .onConflictDoNothing()
        .run();
    removeUserLibraryRow(currentUserId(req), id);
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
      .from(s.userProgress)
      .where(and(eq(s.userProgress.userId, currentUserId(req)), eq(s.userProgress.recordingId, p.recordingId)))
      .get();
    if (current && current.updatedAt > p.updatedAt)
      return { progress: current, conflict: true };
    db.insert(s.userProgress)
      .values({ ...p, userId: currentUserId(req) })
      .onConflictDoUpdate({ target: [s.userProgress.userId, s.userProgress.recordingId], set: p })
      .run();
    // Track duration is shared, so only the admin's playback may set it (r1#3).
    if (p.duration > 0 && currentUser(req).role === "admin")
      db.update(s.tracks)
        .set({ duration: p.duration })
        .where(eq(s.tracks.id, p.trackId))
        .run();
    const rec = db
      .select()
      .from(s.recordings)
      .where(eq(s.recordings.id, p.recordingId))
      .get();
    if (rec)
      db.update(s.userLibrary)
        .set({ status: "listening" })
        .where(
          and(
            eq(s.userLibrary.userId, currentUserId(req)),
            eq(s.userLibrary.bookId, rec.editionId),
            eq(s.userLibrary.status, "unread"),
          ),
        )
        .run();
    return { progress: p, conflict: false };
  });
  app.get("/api/settings", async (req) => currentUser(req).role !== "admin" ? ({ name: getSetting("name") || "My listening space", authenticationEnabled: !!process.env.APP_PASSWORD, role: currentUser(req).role, hardcoverConfigured: !!getUserSecret(currentUserId(req), "hardcover") }) : ({
    role: currentUser(req).role,
    name: getSetting("name") || "My listening space",
    torboxConfigured: !!getSetting("torbox"),
    // Hardcover is removed (#721 part d): the switch deleted every token and nothing stores one again, so this is
    // false. The field stays for the builds that read it, and for Discover's Hardcover search until part c2 replaces it.
    hardcoverConfigured: !!getUserSecret(currentUserId(req), "hardcover"),
    // AudiobookDB (#721): the server's AUDIOBOOKDB_API_KEY, else the key saved here; which one is in use.
    audiobookdbConfigured: !!audiobookDbKey().key,
    audiobookdbSource: audiobookDbKey().source,
    abbUrl: getSetting("abbUrl") || "https://audiobookbay.lu",
    libgenUrl: getSetting("libgenUrl") || "https://libgen.li",
    prowlarrUrl: getSetting("prowlarrUrl") || "",
    prowlarrConfigured: !!prowlarrConfig(),
    localConfigured: transmissionConfigured(),
    storageLabel: "4 TB media drive",
    authenticationEnabled: !!process.env.APP_PASSWORD,
    // The media drive for Settings › Library and storage (#580); the administrator's answer only.
    storage: serverStorage({ warn: (message) => req.log.warn(message), ...options?.storage }),
  }));
  app.patch("/api/settings", async (req) => {
    // Every setting is the admin's. An older build's Hardcover token field (#15) is still accepted from anyone
    // and ignored, since Hardcover is removed (#721 part d); an empty save from the reduced Settings form is a no-op (r6#5).
    const fields = Object.keys((req.body ?? {}) as Record<string, unknown>);
    if (fields.length > 0 && !(fields.length === 1 && fields[0] === "hardcover")) requireAdmin(req);
    const input = z
      .object({
        name: z.string().min(1).max(60).optional(),
        torbox: z.string().max(300).optional(),
        audiobookdb: z.string().max(300).optional(),
        hardcover: z.string().max(2000).optional(),
        abbUrl: z.url().optional(),
        libgenUrl: z.url().optional(),
        // Accepted from older clients and ignored: Anna’s Archive is removed (#8).
        annasUrl: z.string().optional(),
        annas: z.string().optional(),
        prowlarrUrl: z.union([z.url(), z.literal("")]).optional(),
        prowlarr: z.string().max(200).optional(),
      })
      .parse(req.body);
    delete input.annasUrl;
    delete input.annas;
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
    if (input.libgenUrl) {
      const url = new URL(input.libgenUrl);
      if (
        url.protocol !== "https:" ||
        !/^([a-z0-9-]+\.)?libgen\.[a-z]{2,8}$/.test(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error("Use an HTTPS mirror of the selected ebook source.");
      input.libgenUrl = url.origin;
    }
    // Accepted from older clients and ignored: Hardcover is removed (#721 part d).
    delete input.hardcover;
    for (const [key, value] of Object.entries(input)) {
      if (value === "") {
        db.delete(s.settings).where(eq(s.settings.key, key)).run();
        continue;
      }
      const v = ["torbox", "prowlarr", "audiobookdb"].includes(key)
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
      db.insert(s.userLibrary)
        .values({ userId: currentUserId(req), bookId: id, status: "unread", addedAt: Date.now() })
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
      db.insert(s.userLibrary)
        .values({ userId: currentUserId(req), bookId: id, status: "unread", addedAt: Date.now() })
        .run();
    })();
    return { id };
  });
  const acquisitionInput = z.object({
    magnet: z.string().startsWith("magnet:?").max(10000),
    title: z.string().max(300).optional(),
    author: z.string().max(200).optional(),
    cover: z.string().max(2000).optional(),
    // Optional (spec #600): the book the magnet link is for, and replacing its download on its way.
    workId: z.string().max(100).optional(),
    replaceActive: z.boolean().optional(),
  });
  app.post("/api/acquire", async (req) => {
    const input = acquisitionInput.parse(req.body);
    return acquireReplacing(input.magnet, { ...input, userId: currentUserId(req) });
  });
  app.post("/api/torbox/magnet", async (req) => {
    const input = acquisitionInput.parse(req.body);
    return acquireReplacing(input.magnet, { ...input, userId: currentUserId(req) });
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
    return controlAcquisition(id, action, currentUserId(req));
  });
  app.get("/api/torrents/health", async (req) => {
    const { fresh } = z
      .object({ fresh: z.string().optional() })
      .parse(req.query ?? {});
    return getTorrentHealth(fresh === "1" || fresh === "true" ? 0 : undefined);
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
        replaceActive: z.boolean().optional(),
        // A recording for a new book (#576): the book is made from the release, in the requester's library.
        makeWork: z.boolean().optional(),
      })
      .parse(req.body);
    const release = await abbRelease(input.slug);
    if (input.makeWork && !input.workId)
      return acquireForNewBook(
        await abbMagnet(input.slug),
        { title: release.title, author: release.author, cover: release.cover, language: release.language, narrator: release.narrator },
        currentUserId(req),
      );
    return acquireReplacing(await abbMagnet(input.slug), {
      ...input,
      title: release.title,
      author: release.author,
      cover: release.cover,
      language: release.language,
      narrator: release.narrator,
      userId: currentUserId(req),
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
        replaceActive: z.boolean().optional(),
        // A recording for a new book (#576): the book is made from the release, in the requester's library.
        makeWork: z.boolean().optional(),
      })
      .parse(req.body);
    const link = prowlarrRelease(input.id);
    if (input.makeWork && !input.workId)
      return acquireForNewBook(await prowlarrMagnet(input.id), { title: releaseDisplayTitle(link.title) }, currentUserId(req));
    const work = input.workId
      ? db.select().from(s.works).where(eq(s.works.id, input.workId)).get()
      : undefined;
    if (input.workId && !work)
      throw new Error("The selected book could not be found.");
    return acquireReplacing(await prowlarrMagnet(input.id), {
      workId: input.workId,
      replaceActive: input.replaceActive,
      title: work?.title || releaseDisplayTitle(link.title),
      author: work?.author,
      userId: currentUserId(req),
    });
  });
  // Older clients may still send "annas"; refuse it with a readable message.
  const libgenOnly = <T extends { source: "annas" | "libgen" }>(input: T) => {
    if (input.source === "annas")
      throw new Error(
        "Anna’s Archive is turned off. Search Library Genesis or import an EPUB or PDF.",
      );
    return { ...input, source: "libgen" as const };
  };
  app.get("/api/discover/ebooks", async (req) => {
    const { source, q, page } = libgenOnly(z
      .object({
        source: z.enum(["annas", "libgen"]),
        q: z.string().min(2).max(150),
        page: z.coerce.number().int().min(1).max(100).default(1),
      })
      .parse(req.query));
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
    const saved = await saveEbook(libgenOnly(input));
    // The ebook's work joins the library of the user who got it (#555).
    joinLibraryWithEbook(currentUserId(req), saved.id);
    // The set membership is recorded as pending and evaluated in the background (#325); `ebookSet` is additive.
    const ebookSet =
      input.workId && input.extension === "epub" ? registerUploadedEbookSetMember(input.workId, saved.id) : null;
    return ebookSet ? { ...saved, ebookSet } : saved;
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
    const imported = await importEbook(part.file, part.filename, workId);
    // The ebook's work joins the library of the user who imported it (#555).
    joinLibraryWithEbook(currentUserId(req), imported.id);
    if (workId) {
      const ebookSet = registerUploadedEbookSetMember(workId, imported.id);
      await autoQueueAlignmentsForWork(workId, { ebookId: imported.id }, req.log);
      if (ebookSet) return { ...imported, ebookSet };
    }
    return imported;
  });
  app.get("/api/ebooks/:id/file", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (id.startsWith("set-consensus:"))
      return reply.code(404).send({ error: "This ebook is no longer on the media drive." });
    const row = db
      .select()
      .from(s.ebookEditions)
      .where(eq(s.ebookEditions.id, id))
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
      .slice(0, 120).trim() || "ebook";
    const utf8Filename = `${(work?.title || "ebook").replace(/[\/\\\x00-\x1f\x7f]/g, "").slice(0, 120).trim() || "ebook"}.${row.format}`;
    reply
      .header(
        "Content-Type",
        row.format === "epub" ? "application/epub+zip" : "application/pdf",
      )
      .header(
        "Content-Disposition",
        `attachment; filename="${filename}.${row.format}"; filename*=UTF-8''${encodeURIComponent(utf8Filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      )
      .header("Content-Length", statSync(row.source).size)
      .header("Cache-Control", "private, no-store");
    return reply.send(createReadStream(row.source));
  });
  // Once per database (#721 part d): Hardcover's Want to read shelf is copied for every user, then its tokens go.
  const hardcoverSwitch = switchFromHardcover({ info: (message) => app.log.info(message), warn: (message) => app.log.warn(message) });
  if (hardcoverSwitch.ran)
    app.log.info(
      `Switched from Hardcover: ${hardcoverSwitch.copied} books copied to Want to read for ${hardcoverSwitch.users} users, ${hardcoverSwitch.unmatched} not matched, ${hardcoverSwitch.tokensDeleted} tokens deleted.`,
    );
  for (const loop of [
    acquisitionsLoop,
    serverCopiesLoop,
    seriesAcquisitionLoop,
    ebookSetEvaluationLoop,
    databaseBackupLoop(app.log),
  ])
    background.add(loop);
  // The catalogue cache keeps to its licence (#721): expired searches go, a week's details are fetched again.
  background.add(catalogueRefreshLoop((message) => app.log.warn(message)));
  // Series on AudiobookDB (#721 part b): saved series read again daily; the Hardcover series saved again after the reset.
  background.add(savedSeriesRefreshLoop((message) => app.log.warn(message)));
  background.add(seriesResaveLoop((message) => app.log.warn(message)));
  app.post("/api/import", async (req) => {
    ensureMediaStorage();
    let title = "";
    let author = "Unknown author";
    // The book the files join (#605): sent before the files. Its title and author name them, and Hardcover is not
    // asked which work they are.
    let work: { id: string; title: string; author: string } | null = null;
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
          if (part.fieldname === "workId") {
            const workId = String(part.value).slice(0, 200);
            // A book named after a file was written is not the one the files were sent for: refused, as unknown.
            const found = stored.length ? undefined : db.select().from(s.works).where(eq(s.works.id, workId)).get();
            if (!found) throw new Error("The selected book could not be found.");
            work = { id: found.id, title: found.title, author: found.author };
          }
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
        const meta = await parseFile(temp, audioParseOptions);
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
      // The book's author names the recording's narrator, as an upload's typed author does today.
      if (work) author = work.author;
      const workId = work?.id || hardcoverWorkForMedia(title, author) || `work-${id}`;
      // A recording of a known book takes the cover its other editions show (the placeholder's, as a rule).
      const cover = work
        ? db.select({ cover: s.editions.cover }).from(s.editions).where(eq(s.editions.workId, work.id)).all().map((e) => e.cover).find(Boolean)
        : undefined;
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
            cover: cover || "/covers/meditations.svg",
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
        db.insert(s.userLibrary)
          .values({ userId: currentUserId(req), bookId: id, status: "unread", addedAt: Date.now() })
          .run();
        claimWorkAudio(workId, id);
      })();
      await autoQueueAlignmentsForWork(workId, { recordingId: `recording-${id}` }, req.log);
      await reevaluateEbookSetForWork(workId);
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
          .header("Content-Type", audioFileMime(path) || mime(path))
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
  if (process.env.NODE_ENV === "test") {
    const { mediaRoot } = await import("./storage.ts");
    const testMediaPath = (rel: string) => {
      const root = realpathSync(mediaRoot);
      const target = resolve(mediaRoot, rel);
      if (!existsSync(target)) return null;
      const actual = realpathSync(target);
      const relPath = relative(root, actual);
      if (relPath.startsWith("..") || isAbsolute(relPath)) return null;
      return actual;
    };
    app.get("/api/test/media-exists", (req) => {
      const rel = (req.query as { path?: string }).path;
      if (!rel) throw new Error("path is required.");
      const actual = testMediaPath(rel);
      return { exists: actual ? existsSync(actual) : false };
    });
    app.post("/api/test/seed-local-audio", (req, reply) => {
      const input = z
        .object({
          relPath: z.string().min(1),
          editionId: z.string().min(1),
          recordingId: z.string().min(1),
          trackId: z.string().min(1),
          workId: z.string().min(1),
          releaseTitle: z.string().optional(),
          // A recording the browser tests can tell apart and seek in (#530); the defaults are the old ones.
          narrator: z.string().min(1).optional(),
          language: z.string().min(1).optional(),
          duration: z.number().positive().optional(),
          chapters: z.array(z.object({ title: z.string(), start: z.number(), end: z.number().optional() })).optional(),
        })
        .parse(req.body);
      // A track id that is already in use fails the request and writes nothing.
      const trackTaken = db.select({ id: s.tracks.id }).from(s.tracks).where(eq(s.tracks.id, input.trackId)).get();
      if (trackTaken) return reply.code(409).send({ error: `Track ${input.trackId} already exists.` });
      // So does a recording id of another edition: the new edition would be left without a recording.
      const recording = db
        .select({ editionId: s.recordings.editionId })
        .from(s.recordings)
        .where(eq(s.recordings.id, input.recordingId))
        .get();
      if (recording && recording.editionId !== input.editionId)
        return reply
          .code(409)
          .send({ error: `Recording ${input.recordingId} belongs to edition ${recording.editionId}.` });
      const full = resolve(mediaRoot, input.relPath);
      mkdirSync(resolve(full, ".."), { recursive: true });
      if (!existsSync(full)) writeFileSync(full, "audio");
      // One transaction: an edition left without its track would be taken for a placeholder
      // (#483).
      sqlite.transaction(() => {
        db.insert(s.editions)
          .values({
            id: input.editionId,
            workId: input.workId,
            cover: "",
            narrator: input.narrator ?? "N",
            language: input.language ?? null,
            releaseTitle: input.releaseTitle ?? "Test audio",
            rating: 0,
            sourceLabel: "Test",
          })
          .onConflictDoNothing()
          .run();
        db.insert(s.recordings)
          .values({ id: input.recordingId, editionId: input.editionId })
          .onConflictDoNothing()
          .run();
        db.insert(s.tracks)
          .values({
            id: input.trackId,
            recordingId: input.recordingId,
            title: "Ch 1",
            index: 0,
            duration: input.duration ?? 10,
            chapters: input.chapters ?? [],
            source: full,
            sourceType: "local",
          })
          .run();
        db.insert(s.userLibrary)
          .values({
            userId: 1,
            bookId: input.editionId,
            status: "unread",
            addedAt: Date.now(),
          })
          .onConflictDoNothing()
          .run();
      })();
      return { ok: true as const, relPath: input.relPath };
    });
  }
  return app;
}
