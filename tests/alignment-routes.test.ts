import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AlignmentPoolStatus } from "../src/reading-types.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-alignment-routes-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.ALIGNMENT_POOL_ENABLED;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;

const { createApp, logLevel } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { readerFixture } = await import("./reader-fixture.ts");
const { stopAlignments, alignmentJob } = await import("../server/alignment.ts");
const {
  CTC_ENGINE,
  resetAlignmentPoolCoordinator,
  setAlignmentPoolDepsForTests,
} = await import("../server/alignment-pool.ts");

const logLines: string[] = [];
const logStream = new Writable({
  write(chunk, _encoding, callback) {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) logLines.push(line.trim());
    }
    callback();
  },
});

const app = await createApp({ logger: { level: "debug", stream: logStream } });
const originalFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = originalFetch;
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  delete process.env.ALIGNMENT_POOL_ENABLED;
  delete process.env.ALIGNMENT_WORKER_URL;
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  stopAlignments();
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

mkdirSync(join(temp, "media", "ebooks"), { recursive: true });
mkdirSync(join(temp, "media", "imports"), { recursive: true });
const epubPath = join(temp, "media", "ebooks", "routes-book.epub");
writeFileSync(epubPath, await readerFixture());
const audioPath = join(temp, "media", "imports", "routes-track-0.mp3");
writeFileSync(audioPath, Buffer.from("RAW-AUDIO-SECRET-BYTES-0123456789"));

db.insert(s.works)
  .values({
    id: "work-routes",
    title: "Routes Test Book",
    author: "Author",
    description: "",
    genre: "Fiction",
    year: 2020,
  })
  .run();
db.insert(s.editions)
  .values({
    id: "edition-routes",
    workId: "work-routes",
    cover: "/covers/meditations.svg",
    narrator: "Narrator",
    rating: 0,
    sourceLabel: "test",
    language: "en",
  })
  .run();
db.insert(s.recordings)
  .values({ id: "recording-routes", editionId: "edition-routes" })
  .run();
db.insert(s.tracks)
  .values({
    id: "track-routes-0",
    recordingId: "recording-routes",
    title: "Down the Rabbit-Hole",
    index: 0,
    duration: 300,
    chapters: [{ title: "Down the Rabbit-Hole", start: 0, end: 300 }],
    source: audioPath,
    sourceType: "local",
  })
  .run();
db.insert(s.ebookEditions)
  .values({
    id: "ebook-routes",
    workId: "work-routes",
    format: "epub",
    source: epubPath,
  })
  .run();

async function login(username: string | undefined, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.cookies[0].value;
}

const debugEntries = () =>
  logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.level === 20);

test("logLevel accepts valid Pino levels case-insensitively and defaults invalid values to info", () => {
  assert.equal(logLevel("debug"), "debug");
  assert.equal(logLevel(" DEBUG "), "debug");
  assert.equal(logLevel("trace"), "trace");
  assert.equal(logLevel(undefined), "info");
  assert.equal(logLevel(""), "info");
  assert.equal(logLevel("verbose"), "info");
});

test("Resume press (PATCH /api/alignments/:id) leaves one debug log line with status and duration, and GET routes leave none", async () => {
  const admin = await login(undefined, "admin-password");
  const now = Date.now();
  const failedJob = {
    id: "job-resume-1",
    generation: "gen-1",
    ebookId: "ebook-routes",
    recordingId: "recording-routes",
    status: "error",
    progress: 0,
    engine: "aeneas-1.7.3",
    outcome: "error",
    error: "Remote alignment failed on all pool hosts. Resume to retry.",
    warning: null,
    intervals: [],
    sectionsDone: [],
    elapsedSeconds: 0,
    fingerprint: "fp-1",
    audioFingerprint: "afp-1",
    createdAt: now,
    updatedAt: now,
    coverage: 0,
    pairings: [{ section: 0, trackId: "track-routes-0", start: 0, duration: 300 }],
    poolErrors: { wsl: "ssh: Connection refused" },
  };
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at,engine,outcome) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      failedJob.id,
      failedJob.ebookId,
      failedJob.recordingId,
      JSON.stringify(failedJob),
      now,
      failedJob.engine,
      failedJob.outcome,
    );

  // Stall worker so queued job stays queued cleanly during test.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
  logLines.length = 0;

  // Polling GET routes must never emit alignment write debug logs.
  for (const url of [
    "/api/alignments?ebookId=ebook-routes&summary=1",
    "/api/alignments/backfill",
    "/api/alignments/options?ebookId=ebook-routes&recordingId=recording-routes",
    "/api/alignments/pool",
  ]) {
    const getRes = await app.inject({
      method: "GET",
      url,
      cookies: { sonder_session: admin },
    });
    assert.equal(getRes.statusCode, 200, `${url}: ${getRes.body}`);
  }
  assert.equal(debugEntries().length, 0);

  // Client Resume sequence: PATCH /api/alignments/:id followed by GET /api/alignments refresh.
  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/alignments/${failedJob.id}`,
    cookies: { sonder_session: admin },
    payload: { action: "resume" },
  });
  assert.equal(patchRes.statusCode, 200, patchRes.body);
  const refreshRes = await app.inject({
    method: "GET",
    url: "/api/alignments?ebookId=ebook-routes&summary=1",
    cookies: { sonder_session: admin },
  });
  assert.equal(refreshRes.statusCode, 200, refreshRes.body);

  const entries = debugEntries();
  assert.equal(entries.length, 1, JSON.stringify(entries));
  const [entry] = entries;
  assert.equal(entry.method, "PATCH");
  assert.equal(entry.path, `/api/alignments/${failedJob.id}`);
  assert.equal(entry.action, "resume");
  assert.equal(entry.jobId, failedJob.id);
  assert.equal(entry.jobStatus, "queued");
  assert.equal(entry.status, 200);
  assert.equal(typeof entry.durationMs, "number");
  assert.ok((entry.durationMs as number) >= 0);
  assert.equal(alignmentJob(failedJob.id).status, "queued");
});

test("non-GET /api/alignments writes log 200, 400, 401 and 403 without leaking tokens, cookies or audio payloads", async () => {
  const admin = await login(undefined, "admin-password");
  const createdUser = await app.inject({
    method: "POST",
    url: "/api/users",
    cookies: { sonder_session: admin },
    payload: { username: "reader-routes", password: "reader-password" },
  });
  assert.equal(createdUser.statusCode, 200, createdUser.body);
  const readerCookie = await login("reader-routes", "reader-password");

  process.env.ALIGNMENT_WORKER_URL = "http://worker.routes.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "SECRET-WORKER-TOKEN-DO-NOT-LOG";
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/anchor")) {
      return new Response(null, { status: 409 });
    }
    return new Promise(() => {});
  };

  try {
    logLines.length = 0;

    // 1. Unauthenticated write with sensitive query string -> 401
    const unauth = await app.inject({
      method: "PATCH",
      url: "/api/alignments/job-resume-1?token=QUERY-SECRET-VALUE",
      payload: { action: "resume" },
    });
    assert.equal(unauth.statusCode, 401);

    // 2. Non-admin write -> 403
    const forbidden = await app.inject({
      method: "PATCH",
      url: "/api/alignments/job-resume-1",
      cookies: { sonder_session: readerCookie },
      payload: { action: "pause" },
    });
    assert.equal(forbidden.statusCode, 403);

    // 3. Invalid payload -> 400
    const invalid = await app.inject({
      method: "POST",
      url: "/api/alignments",
      cookies: { sonder_session: admin },
      payload: { ebookId: "ebook-routes" },
    });
    assert.equal(invalid.statusCode, 400);

    // 4. Valid POST /api/alignments -> 200
    const created = await app.inject({
      method: "POST",
      url: "/api/alignments",
      cookies: { sonder_session: admin },
      payload: {
        ebookId: "ebook-routes",
        recordingId: "recording-routes",
        pairings: [{ section: 0, trackId: "track-routes-0", start: 0, duration: 300 }],
      },
    });
    assert.equal(created.statusCode, 200, created.body);

    // 5. POST /api/alignments/recover (touches worker token & local audio) -> 400
    const recover = await app.inject({
      method: "POST",
      url: "/api/alignments/recover",
      cookies: { sonder_session: admin },
      headers: { authorization: "Bearer HEADER-SECRET-VALUE" },
      payload: {
        ebookId: "ebook-routes",
        recordingId: "recording-routes",
        trackId: "track-routes-0",
        position: 10,
      },
    });
    assert.equal(recover.statusCode, 400);

    const entries = debugEntries();
    assert.equal(entries.length, 5, JSON.stringify(entries));
    assert.deepEqual(
      entries.map((entry) => [entry.method, entry.path, entry.status]),
      [
        ["PATCH", "/api/alignments/job-resume-1", 401],
        ["PATCH", "/api/alignments/job-resume-1", 403],
        ["POST", "/api/alignments", 400],
        ["POST", "/api/alignments", 200],
        ["POST", "/api/alignments/recover", 400],
      ],
    );
    for (const entry of entries) {
      assert.equal(typeof entry.durationMs, "number");
      assert.ok((entry.durationMs as number) >= 0);
    }

    const rawJoined = logLines.join("\n");
    for (const secret of [
      "SECRET-WORKER-TOKEN-DO-NOT-LOG",
      "QUERY-SECRET-VALUE",
      "HEADER-SECRET-VALUE",
      "RAW-AUDIO-SECRET-BYTES-0123456789",
      admin,
      readerCookie,
    ]) {
      assert.ok(!rawJoined.includes(secret), `leaked secret in logs: ${secret}`);
    }
  } finally {
    delete process.env.ALIGNMENT_WORKER_URL;
    delete process.env.ALIGNMENT_WORKER_TOKEN;
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/alignments/pool requires admin and exposes per-host pool state and skip reasons", async () => {
  const admin = await login(undefined, "admin-password");
  const readerCookie = await login("reader-routes", "reader-password");

  assert.equal((await app.inject({ method: "GET", url: "/api/alignments/pool" })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/alignments/pool",
        cookies: { sonder_session: readerCookie },
      })
    ).statusCode,
    403,
  );

  process.env.ALIGNMENT_POOL_ENABLED = "1";

  resetAlignmentPoolCoordinator([
    {
      id: "wsl",
      sshTarget: "wsl-pool.test",
      maxConcurrent: 3,
      remoteWorkRoot: temp,
      workerUrl: "http://wsl-pool.test:3012",
      device: "cuda",
      precision: "float16",
      rank: 1,
    },
    {
      id: "lisa",
      sshTarget: "lisa-pool.test",
      maxConcurrent: 1,
      remoteWorkRoot: temp,
      workerUrl: "http://lisa-pool.test:3012",
      device: "cpu",
      precision: "float32",
      rank: 2,
    },
  ]);
  setAlignmentPoolDepsForTests({
    async probe() {
      return true;
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile() {},
  });
  globalThis.fetch = async (input) => {
    const isLisa = String(input).includes("lisa-pool.test");
    return Response.json({
      ready: true,
      engine: "aeneas-1.7.3",
      busy: isLisa,
      stuck: false,
      busySeconds: isLisa ? 12.4 : null,
      lastTimeout: null,
      mediaRoot: temp,
      ctc: {
        engine: CTC_ENGINE,
        ready: true,
        device: isLisa ? "cpu" : "cuda",
        precision: isLisa ? "float32" : "float16",
        anchorReady: true,
        passageReady: true,
      },
    });
  };

  // Seed a persisted job whose poolErrors explain why wsl was skipped before a restart.
  const persistedNow = Date.now() + 10_000;
  const persistedJob = {
    id: "job-persisted-skip",
    ebookId: "ebook-routes",
    recordingId: "recording-routes",
    status: "processing",
    progress: 0.2,
    engine: CTC_ENGINE,
    error: null,
    warning: null,
    intervals: [],
    sectionsDone: [],
    elapsedSeconds: 0,
    fingerprint: "fp",
    audioFingerprint: "afp",
    createdAt: persistedNow,
    updatedAt: persistedNow,
    coverage: 0,
    pairings: [],
    poolErrors: { wsl: "health: passage discovery is not ready" },
    pool: {
      hostId: "lisa",
      attempt: 2,
      jobMediaRoot: join(temp, "alignment", "pool-jobs", "job-persisted-skip"),
      workerUrl: "http://lisa-pool.test:3012",
      triedHosts: ["wsl", "lisa"],
      stagedAudio: {},
    },
  };
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at,engine) VALUES(?,?,?,?,?,?)",
    )
    .run(
      persistedJob.id,
      persistedJob.ebookId,
      persistedJob.recordingId,
      JSON.stringify(persistedJob),
      persistedNow,
      persistedJob.engine,
    );

  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/alignments/pool?fresh=1",
      cookies: { sonder_session: admin },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as AlignmentPoolStatus;
    assert.equal(body.enabled, true);
    assert.equal(body.engine, "ctc");
    assert.deepEqual(
      body.hosts.map((host) => ({
        id: host.id,
        reachable: host.reachable,
        device: host.device,
        busy: host.busy,
        lastError: host.lastError,
      })),
      [
        {
          id: "wsl",
          reachable: true,
          device: "cuda",
          busy: false,
          lastError: "health: passage discovery is not ready",
        },
        {
          id: "lisa",
          reachable: true,
          device: "cpu",
          busy: true,
          lastError: null,
        },
      ],
    );

  } finally {
    delete process.env.ALIGNMENT_POOL_ENABLED;
    setAlignmentPoolDepsForTests(null);
    resetAlignmentPoolCoordinator();
    globalThis.fetch = originalFetch;
  }
});
