import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-worker-timeout-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
// Busy-wait tests poll /api/alignments/:id/map many times; the default 600/min
// limiter rejects those injects mid-suite (same pattern as tests/browser-server.ts).
process.env.API_RATE_LIMIT = "6000";
delete process.env.APP_PASSWORD;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;
const { CTC_ENGINE, installCtcTestPool, uninstallCtcTestPool, withCtcPoolFetch } =
  await import("./ctc-test-pool.ts");
// One host only: a 504/409 on WSL has nowhere else to go, so the job ends without
// the cross-host CTC failover covered in alignment-ctc.test.ts.
const { workerUrl } = installCtcTestPool(temp, "http://ctc-worker.test", { lisa: false });
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { readerFixture } = await import("./reader-fixture.ts");
const {
  createAlignment,
  setWorkerRetryClockForTests,
  stopAlignments,
  WORKER_BUSY_WAIT_MS,
  WORKER_TIMEOUT_MESSAGE,
} = await import("../server/alignment.ts");
const { POOL_FAILURE_MESSAGE } = await import("../server/alignment-pool.ts");
const app = await createApp();
const original = fetch;
after(async () => {
  globalThis.fetch = original;
  setWorkerRetryClockForTests(null);
  delete process.env.ALIGNMENT_WORKER_URL;
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  uninstallCtcTestPool();
  stopAlignments();
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
const ebook = "timeout-edition";
const file = join(temp, "media", "ebooks", "timeout.epub");
writeFileSync(file, await readerFixture({ script: true }));
db.insert(s.ebookEditions)
  .values({ id: ebook, workId: "work-alice", format: "epub", source: file })
  .run();
db.update(s.tracks)
  .set({
    chapters: [
      { title: "Down the Rabbit-Hole", start: 0, end: 300 },
      { title: "The Pool of Tears", start: 300, end: 640 },
    ],
  })
  .where(eq(s.tracks.id, "alice-0"))
  .run();
for (const track of db
  .select()
  .from(s.tracks)
  .where(eq(s.tracks.recordingId, "recording-alice"))
  .all()
  .slice(1))
  db.update(s.tracks)
    .set({ sourceType: "local", source: file })
    .where(eq(s.tracks.id, track.id))
    .run();
const aligned = (data: { fragments: string[]; start: number }) =>
  Response.json({
    engine: CTC_ENGINE,
    outcome: "mapped",
    elapsedSeconds: 1,
    intervals: data.fragments.map((_, i) => ({
      index: i,
      start: data.start + i * 3,
      end: data.start + (i + 1) * 3,
    })),
  });
async function settled(id: string, done: (job: any) => boolean) {
  let job: any;
  for (let i = 0; i < 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    job = (await app.inject(`/api/alignments/${id}/map`)).json();
    if (done(job)) break;
  }
  return job;
}
beforeEach(() => {
  // createAlignment reuses the (ebook, recording) job id, and chapter sections are
  // cached under alignment/<id>/; clear them so each test hits the worker again.
  rmSync(join(temp, "media", "alignment"), { recursive: true, force: true });
  sqlite.prepare("DELETE FROM alignment_jobs").run();
});

test("a CTC worker timeout (504) keeps finished sections; with no other host the job fails for resume", async () => {
  const starts: number[] = [];
  let slow = true;
  globalThis.fetch = withCtcPoolFetch(temp, async (input, init) => {
    assert.equal(String(input), `${workerUrl}/align`);
    const data = JSON.parse(String(init?.body));
    starts.push(data.start);
    if (slow && data.start === 300)
      return new Response(
        JSON.stringify({ detail: "Local alignment timed out after 390 seconds." }),
        { status: 504 },
      );
    return aligned(data);
  });
  const job = await createAlignment(ebook, "recording-alice");
  const failed = await settled(job.id, (value) => value.status === "error");
  assert.equal(failed.status, "error", "the job is not left in processing");
  // CTC tries the other pool host after a worker error; with only WSL that ends as a pool failure.
  // The timeout message is still what workerRequest throws before failover.
  assert.ok(
    failed.error === POOL_FAILURE_MESSAGE || failed.error === WORKER_TIMEOUT_MESSAGE,
    failed.error,
  );
  assert.deepEqual(failed.sectionsDone, [0]);
  assert.deepEqual(starts, [0, 300], "the 504 was not retried on the same host");

  slow = false;
  const resumed = await app.inject({
    method: "PATCH",
    url: `/api/alignments/${job.id}`,
    payload: { action: "resume" },
  });
  assert.equal(resumed.statusCode, 200, resumed.body);
  const done = await settled(job.id, (value) => value.status === "partial");
  assert.equal(done.status, "partial", done.error);
  assert.equal(done.error, null);
  assert.deepEqual(done.sectionsDone, [0, 1]);
  assert.deepEqual(starts, [0, 300, 300], "only the timed-out section ran again");
});

test("a busy CTC worker (409) is still retried on the same host", async () => {
  let calls = 0;
  const seen: string[] = [];
  globalThis.fetch = withCtcPoolFetch(temp, async (input, init) => {
    seen.push(String(input));
    const data = JSON.parse(String(init?.body));
    if (data.start === 0 && calls++ === 0)
      return new Response("{}", { status: 409 });
    return aligned(data);
  });
  const job = await createAlignment(ebook, "recording-alice");
  const done = await settled(job.id, (value) =>
    ["partial", "error"].includes(value.status),
  );
  assert.equal(done.status, "partial", `${done.error}; seen=${seen.join(",")}`);
  assert.equal(calls, 2, `the first section was asked again after the 409; seen=${seen.join(",")}`);
});

test("a reading sync waits through more than five busy responses on the CTC host", async () => {
  let now = 0;
  setWorkerRetryClockForTests({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  let conflicts = 0;
  globalThis.fetch = withCtcPoolFetch(temp, async (_input, init) => {
    if (conflicts < 6) {
      conflicts++;
      return new Response("{}", { status: 409 });
    }
    return aligned(JSON.parse(String(init?.body)));
  });
  try {
    const job = await createAlignment(ebook, "recording-alice");
    const done = await settled(job.id, (value) =>
      ["partial", "error"].includes(value.status),
    );
    assert.equal(done.status, "partial", done.error);
    assert.equal(conflicts, 6);
  } finally {
    setWorkerRetryClockForTests(null);
  }
});

test("a permanently busy CTC host fails after the busy wait cap when no other host exists", async () => {
  let now = 0;
  let calls = 0;
  setWorkerRetryClockForTests({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  globalThis.fetch = withCtcPoolFetch(temp, async () => {
    calls++;
    return new Response("{}", { status: 409 });
  });
  try {
    const job = await createAlignment(ebook, "recording-alice");
    const failed = await settled(job.id, (value) => value.status === "error");
    assert.equal(failed.status, "error", failed.error);
    // Busy wait exhausts, then CTC failover finds no other host.
    assert.ok(
      failed.error === "The alignment worker is busy. Retry in a moment." ||
        failed.error === POOL_FAILURE_MESSAGE,
      failed.error,
    );
    assert.equal(now, WORKER_BUSY_WAIT_MS);
    assert.ok(calls > 5, `calls=${calls}`);
  } finally {
    setWorkerRetryClockForTests(null);
  }
});
