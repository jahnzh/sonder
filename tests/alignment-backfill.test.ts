import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-backfill-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
// These tests exercise queue policy with a deliberately stalled CTC pool worker.
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;
const { installCtcTestPool, uninstallCtcTestPool } = await import("./ctc-test-pool.ts");
installCtcTestPool(temp);
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { readerFixture } = await import("./reader-fixture.ts");
const {
  createAlignment,
  stopAlignments,
  backfillEligibility,
  runAlignmentBackfill,
  autoQueueAlignmentForPair,
  autoQueueAlignmentsForWork,
  alignmentJob,
} = await import("../server/alignment.ts");
const app = await createApp();
const original = fetch;
// The worker never answers, so queued jobs stay where the queue leaves them.
globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
after(async () => {
  globalThis.fetch = original;
  delete process.env.ALIGNMENT_WORKER_URL;
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  uninstallCtcTestPool();
  stopAlignments();
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
const epub = join(temp, "media", "ebooks", "backfill.epub");
const english = await readerFixture();
writeFileSync(epub, english);
const chapters = [
  { title: "Down the Rabbit-Hole", start: 0, end: 300 },
  { title: "The Pool of Tears", start: 300, end: 640 },
];
function title(id: string, options: { media?: "all" | "partial"; language?: string; ebook?: string | null } = {}) {
  db.insert(s.works)
    .values({ id: `work-${id}`, title: id, author: "A", description: "", genre: "Fiction", year: 2000 })
    .run();
  db.insert(s.editions)
    .values({
      id: `edition-${id}`,
      workId: `work-${id}`,
      cover: "/covers/meditations.svg",
      narrator: "N",
      rating: 0,
      sourceLabel: "test",
      language: options.language ?? "en",
    })
    .run();
  db.insert(s.recordings).values({ id: `recording-${id}`, editionId: `edition-${id}` }).run();
  for (const index of [0, 1])
    db.insert(s.tracks)
      .values({
        id: `${id}-${index}`,
        recordingId: `recording-${id}`,
        title: `Track ${index}`,
        index,
        duration: 640,
        chapters: index === 0 ? chapters : [],
        source: options.media === "partial" && index === 1 ? "https://example.test/a.mp3" : epub,
        sourceType: options.media === "partial" && index === 1 ? "remote" : "local",
      })
      .run();
  if (options.ebook !== null)
    db.insert(s.ebookEditions)
      .values({ id: `ebook-${id}`, workId: `work-${options.ebook ?? id}`, format: "epub", source: epub })
      .run();
}
const rows = () =>
  sqlite.prepare("SELECT id,ebook_id,recording_id,data FROM alignment_jobs").all() as {
    id: string; ebook_id: string; recording_id: string; data: string;
  }[];
const jobFor = (id: string) => rows().find((r) => r.recording_id === `recording-${id}`);
const wipe = () => sqlite.prepare("DELETE FROM alignment_jobs").run();
function seedJob(id: string, status: string, updatedAt = Date.now()) {
  const data = { id: `job-${id}`, ebookId: `ebook-${id}`, recordingId: `recording-${id}`, status, progress: 0.5, intervals: [], updatedAt, createdAt: updatedAt };
  sqlite
    .prepare("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at")
    .run(data.id, data.ebookId, data.recordingId, JSON.stringify(data), updatedAt);
}
async function login(username: string | undefined, password: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
}
function enableWorker() {
  process.env.ALIGNMENT_WORKER_URL = "http://alignment.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "test-private-worker-token";
}
function disableWorker() {
  delete process.env.ALIGNMENT_WORKER_URL;
  delete process.env.ALIGNMENT_WORKER_TOKEN;
}

title("good");
title("partial", { media: "partial" });
title("unlinked", { ebook: null });
title("french", { language: "fr" });
// The ebook exists but belongs to another work.
title("other", { ebook: "good" });
title("noebook", { ebook: null });

test("eligibility: linked, language-matching and fully on the server", async () => {
  assert.deepEqual(await backfillEligibility("ebook-good", "recording-good"), { eligible: true });
  assert.deepEqual(await backfillEligibility("ebook-partial", "recording-partial"), { eligible: false, reason: "media" });
  assert.deepEqual(await backfillEligibility("ebook-good", "recording-unlinked"), { eligible: false, reason: "linked" });
  assert.deepEqual(await backfillEligibility("ebook-french", "recording-french"), { eligible: false, reason: "language" });
});

test("backfill queues only eligible pairs, tags origin, is idempotent, and never downloads", async () => {
  wipe();
  enableWorker();
  try {
    const first = await runAlignmentBackfill();
    // good + other (ebook-other is linked to work-good, so it pairs with recording-good).
    assert.equal(first.queued, 2, JSON.stringify(first));
    assert.ok(jobFor("good"));
    assert.equal(jobFor("partial"), undefined, "a track missing server media is skipped");
    assert.equal(jobFor("french"), undefined);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM server_downloads").get() as { n: number }).n, 0);
    for (const row of rows()) assert.equal(JSON.parse(row.data).origin, "backfill");
    const second = await runAlignmentBackfill();
    assert.equal(second.queued, 0, "a second run queues nothing new");
    assert.equal(second.skipped.inProgress, 2);
    assert.equal(rows().length, 2);
  } finally {
    disableWorker();
  }
});

test("re-queue policy: skip ready/partial/in-progress/paused, re-queue error and cancelled", async () => {
  enableWorker();
  try {
    for (const status of ["ready", "partial", "queued", "processing", "copying", "paused"]) {
      wipe();
      seedJob("good", status);
      sqlite.prepare("DELETE FROM alignment_jobs WHERE id<>'job-good'").run();
      const before = alignmentJob("job-good");
      const result = await autoQueueAlignmentForPair("ebook-good", "recording-good");
      assert.equal(result, false, status);
      assert.deepEqual(alignmentJob("job-good"), before, `${status} is untouched`);
    }
    for (const status of ["error", "cancelled"]) {
      wipe();
      seedJob("good", status);
      const old = alignmentJob("job-good");
      assert.equal(await autoQueueAlignmentForPair("ebook-good", "recording-good"), true, status);
      const fresh = alignmentJob("job-good");
      assert.equal(fresh.id, "job-good", "the same job id is reused");
      assert.ok(fresh.generation, "a new generation starts");
      assert.notEqual(fresh.status, status);
      assert.equal(fresh.origin, "backfill");
      assert.equal(rows().length, 1);
      assert.notEqual(fresh.generation, (old as any).generation);
    }
  } finally {
    disableWorker();
  }
});

test("origin is absent on reader-panel jobs, and a job without it round-trips", async () => {
  wipe();
  const job = await createAlignment("ebook-good", "recording-good");
  assert.equal(job.origin, undefined);
  assert.equal(JSON.parse(jobFor("good")!.data).origin, undefined);
  assert.equal(alignmentJob(job.id).id, job.id);
  assert.equal(alignmentJob(job.id).origin, undefined);
});

test("endpoints: GET/POST /api/alignments/backfill are admin only; counts and next are right", async () => {
  const admin = await login(undefined, "admin-password");
  const made = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
  assert.equal(made.statusCode, 200, made.body);
  const user = await login("reader", "password1");
  for (const method of ["GET", "POST"] as const)
    assert.equal((await app.inject({ method, url: "/api/alignments/backfill", cookies: { sonder_session: user } })).statusCode, 403, method);

  wipe();
  const now = Date.now();
  const statuses = ["queued", "copying", "processing", "ready", "partial", "error", "paused", "cancelled", "ready"];
  db.insert(s.works)
    .values({ id: "work-empty", title: "empty", author: "A", description: "", genre: "Fiction", year: 2000 })
    .run();
  statuses.forEach((status, i) => {
    db.insert(s.ebookEditions)
      .values({ id: `ebook-seed-${i}`, workId: "work-empty", format: "epub", source: epub })
      .run();
    sqlite
      .prepare("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,?,?,?,?)")
      .run(`seed-${i}`, `ebook-seed-${i}`, "recording-good", JSON.stringify({ id: `seed-${i}`, ebookId: `ebook-seed-${i}`, recordingId: "recording-good", status, progress: 0.4, intervals: [{ start: 0, end: 1 }], updatedAt: now - i * 1000 }), now - i * 1000);
  });
  enableWorker();
  try {
    const got = await app.inject({ method: "GET", url: "/api/alignments/backfill", cookies: { sonder_session: admin } });
    assert.equal(got.statusCode, 200, got.body);
    const body = got.json();
    assert.equal(body.available, true);
    assert.deepEqual(body.counts, { queued: 1, running: 2, ready: 2, partial: 1, failed: 1 });
    assert.equal(body.next.id, "seed-0");
    assert.deepEqual(body.next.intervals, []);
    disableWorker();
    assert.equal((await app.inject({ method: "GET", url: "/api/alignments/backfill", cookies: { sonder_session: admin } })).json().available, false);

    wipe();
    enableWorker();
    const posted = await app.inject({ method: "POST", url: "/api/alignments/backfill", cookies: { sonder_session: admin } });
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(posted.json().queued, 2);
    assert.equal(rows().length, 2);
  } finally {
    disableWorker();
  }
});

test("link hook queues an eligible title, is silent without a worker, and never fails the request", async () => {
  const admin = await login(undefined, "admin-password");
  const link = (ebook: string, workId: string) =>
    app.inject({ method: "POST", url: `/api/reader/${ebook}/link`, cookies: { sonder_session: admin }, payload: { workId } });
  title("late", { ebook: null });
  db.insert(s.ebookEditions).values({ id: "ebook-late", workId: "work-noebook", format: "epub", source: epub }).run();

  wipe();
  assert.equal((await link("ebook-late", "work-late")).statusCode, 200);
  assert.equal(jobFor("late"), undefined, "no worker configured: nothing queued");

  enableWorker();
  try {
    db.update(s.ebookEditions).set({ workId: "work-noebook" }).where(eq(s.ebookEditions.id, "ebook-late")).run();
    assert.equal((await link("ebook-late", "work-late")).statusCode, 200);
    assert.equal(JSON.parse(jobFor("late")!.data).origin, "backfill");

    // A language mismatch makes createAlignment throw only if eligibility passed; force a failure.
    title("broken");
    sqlite.prepare("DELETE FROM alignment_jobs").run();
    db.update(s.tracks).set({ chapters: [] , duration: 0 }).where(eq(s.tracks.recordingId, "recording-broken")).run();
    db.update(s.ebookEditions).set({ workId: "work-noebook" }).where(eq(s.ebookEditions.id, "ebook-broken")).run();
    const failed = await link("ebook-broken", "work-broken");
    assert.equal(failed.statusCode, 200, failed.body);
    assert.equal(jobFor("broken"), undefined, "nothing queued, request still succeeded");
  } finally {
    disableWorker();
  }
});

test("reading sync is available and new pairs queue on the pool and its token alone, ignoring a leftover local worker URL (#279)", async () => {
  const admin = await login(undefined, "admin-password");
  const available = async () => ({
    list: (await app.inject({ url: "/api/alignments", cookies: { sonder_session: admin } })).json().available,
    backfill: (await app.inject({ url: "/api/alignments/backfill", cookies: { sonder_session: admin } })).json().available,
  });
  const pool = process.env.ALIGNMENT_POOL_ENABLED;
  try {
    // The pool and token are set and the retired local worker URL is not: available, and a new pair queues.
    wipe();
    delete process.env.ALIGNMENT_WORKER_URL;
    process.env.ALIGNMENT_WORKER_TOKEN = "test-private-worker-token";
    process.env.ALIGNMENT_POOL_ENABLED = "1";
    assert.deepEqual(await available(), { list: true, backfill: true });
    assert.equal(await autoQueueAlignmentForPair("ebook-good", "recording-good"), true);
    assert.ok(jobFor("good"));

    // Only a leftover local worker URL and the token: the pool is off, so nothing claims to work.
    wipe();
    process.env.ALIGNMENT_WORKER_URL = "http://127.0.0.1:3012";
    delete process.env.ALIGNMENT_POOL_ENABLED;
    assert.deepEqual(await available(), { list: false, backfill: false });
    assert.equal(await autoQueueAlignmentForPair("ebook-good", "recording-good"), false);
    assert.equal(jobFor("good"), undefined);

    // The leftover URL next to a working pool changes nothing.
    process.env.ALIGNMENT_POOL_ENABLED = "1";
    assert.deepEqual(await available(), { list: true, backfill: true });
    assert.equal(await autoQueueAlignmentForPair("ebook-good", "recording-good"), true);

    // The pool without its token cannot run anything either.
    wipe();
    delete process.env.ALIGNMENT_WORKER_TOKEN;
    assert.deepEqual(await available(), { list: false, backfill: false });
    assert.equal(await autoQueueAlignmentForPair("ebook-good", "recording-good"), false);
    assert.equal(jobFor("good"), undefined);
  } finally {
    if (pool === undefined) delete process.env.ALIGNMENT_POOL_ENABLED;
    else process.env.ALIGNMENT_POOL_ENABLED = pool;
    disableWorker();
    wipe();
  }
});

// #325 review round 1, HIGH 1: an ebook whose ebook-set member in its work is pending is not aligned until its
// check ends; every other status (and no member at all) queues exactly as on main.
const memberStatuses = [
  ["none", null, null],
  ["pending", "pending", null],
  ["held-awaiting-audio", "held", "awaiting_audio"],
  ["held-awaiting-worker", "held", "awaiting_worker"],
  ["held-evaluation-failed", "held", "evaluation_failed"],
  ["accepted", "accepted", null],
  ["rejected", "rejected", null],
] as const;
for (const [name, status, holdReason] of memberStatuses) {
  test(`HIGH 1: auto-queue, the work auto-queue and the backfill with an ebook-set member ${name}`, async () => {
    const id = `set-${name}`;
    title(id);
    if (status)
      db.insert(s.workEbookSetMembers)
        .values({ workId: `work-${id}`, ebookId: `ebook-${id}`, status, holdReason, evidence: "{}", updatedAt: Date.now() })
        .run();
    const expected = status !== "pending";
    const pool = process.env.ALIGNMENT_POOL_ENABLED;
    process.env.ALIGNMENT_POOL_ENABLED = "1";
    enableWorker();
    try {
      wipe();
      assert.equal(await autoQueueAlignmentForPair(`ebook-${id}`, `recording-${id}`), expected, "autoQueueAlignmentForPair");
      wipe();
      await autoQueueAlignmentsForWork(`work-${id}`, { ebookId: `ebook-${id}` });
      assert.equal(!!jobFor(id), expected, "autoQueueAlignmentsForWork");
      wipe();
      await runAlignmentBackfill();
      assert.equal(!!jobFor(id), expected, "runAlignmentBackfill");
    } finally {
      wipe();
      if (pool === undefined) delete process.env.ALIGNMENT_POOL_ENABLED;
      else process.env.ALIGNMENT_POOL_ENABLED = pool;
      disableWorker();
    }
  });
}
