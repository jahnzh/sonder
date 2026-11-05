import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-worker-timeout-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { readerFixture } = await import("./reader-fixture.ts");
const { createAlignment, stopAlignments, WORKER_TIMEOUT_MESSAGE } =
  await import("../server/alignment.ts");
const app = await createApp();
const original = fetch;
after(async () => {
  globalThis.fetch = original;
  delete process.env.ALIGNMENT_WORKER_URL;
  delete process.env.ALIGNMENT_WORKER_TOKEN;
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
process.env.ALIGNMENT_WORKER_URL = "http://alignment.test";
process.env.ALIGNMENT_WORKER_TOKEN = "test-private-worker-token";
const aligned = (data: { fragments: string[]; start: number }) =>
  Response.json({
    engine: "aeneas-1.7.3",
    elapsedSeconds: 1,
    intervals: data.fragments.map((_, i) => ({
      index: i,
      start: data.start + i * 3,
      end: data.start + (i + 1) * 3,
    })),
  });
async function settled(id: string, done: (job: any) => boolean) {
  let job: any;
  for (let i = 0; i < 1000; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = (await app.inject(`/api/alignments/${id}/map`)).json();
    if (done(job)) break;
  }
  return job;
}

test("a worker timeout (504) is final: the job ends in an error naming it, keeps finished sections, and resumes on retry", async () => {
  const starts: number[] = [];
  let slow = true;
  globalThis.fetch = async (input, init) => {
    const data = JSON.parse(String(init?.body));
    assert.equal(String(input), "http://alignment.test/align");
    starts.push(data.start);
    if (slow && data.start === 300)
      return new Response(
        JSON.stringify({ detail: "Local alignment timed out after 390 seconds." }),
        { status: 504 },
      );
    return aligned(data);
  };
  const job = await createAlignment(ebook, "recording-alice");
  const failed = await settled(job.id, (value) => value.status === "error");
  assert.equal(failed.status, "error", "the job is not left in processing");
  assert.equal(failed.error, WORKER_TIMEOUT_MESSAGE);
  assert.match(failed.error, /timed out/);
  assert.deepEqual(failed.sectionsDone, [0]);
  // The ticker runs every 5 s; no other attempt may follow an error.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(starts, [0, 300], "the 504 was not retried");

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

test("a busy worker (409) is still retried", async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    const data = JSON.parse(String(init?.body));
    if (data.start === 0 && calls++ === 0)
      return new Response("{}", { status: 409 });
    return aligned(data);
  };
  const job = await createAlignment(ebook, "recording-alice");
  const done = await settled(job.id, (value) =>
    ["partial", "error"].includes(value.status),
  );
  assert.equal(done.status, "partial", done.error);
  assert.equal(calls, 2, "the first section was asked again after the 409");
});

test("a queued reading sync takes the worker after a background sample and prevents another sample", async () => {
  const { workerAnchorSample } = await import("../server/ebook-set.ts");
  let releaseSample!: () => void;
  let sampleStarted!: () => void;
  const started = new Promise<void>((resolve) => { sampleStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseSample = resolve; });
  let sampleCalls = 0;
  let busy = true;
  let conflicts = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/anchor")) {
      sampleCalls++;
      if (sampleCalls === 1) {
        sampleStarted();
        await released;
        busy = false;
      }
      return Response.json({ text: "sample", match: null });
    }
    if (busy) {
      conflicts++;
      return new Response("{}", { status: 409 });
    }
    return aligned(JSON.parse(String(init?.body)));
  };
  const input = { audioPath: file, fragmentTexts: ["sample"], language: "en", start: 0, duration: 30 };
  const first = workerAnchorSample(input);
  await started;
  const job = await createAlignment(ebook, "recording-alice");
  while (!conflicts) await new Promise((resolve) => setTimeout(resolve, 10));
  const second = workerAnchorSample(input);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sampleCalls, 1, "queued alignment blocks the next sample");
  releaseSample();
  await first;
  const done = await settled(job.id, (value) => ["partial", "error"].includes(value.status));
  assert.equal(done.status, "partial", done.error);
  await second;
  assert.equal(sampleCalls, 2);
});

test("a reading sync waits through more than five busy responses", async () => {
  let conflicts = 0;
  globalThis.fetch = async (_input, init) => {
    if (conflicts < 6) {
      conflicts++;
      return new Response("{}", { status: 409 });
    }
    return aligned(JSON.parse(String(init?.body)));
  };
  const job = await createAlignment(ebook, "recording-alice");
  for (let i = 0; i < 250 && conflicts < 6; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const done = await settled(job.id, (value) => ["partial", "error"].includes(value.status));
  assert.equal(done.status, "partial", done.error);
  assert.equal(conflicts, 6);
});


test("a permanently busy alignment worker fails after the busy wait cap", async () => {
  const { setWorkerRetryClockForTests, WORKER_BUSY_WAIT_MS } = await import("../server/alignment.ts");
  let now = 0;
  let calls = 0;
  setWorkerRetryClockForTests({ now: () => now, sleep: async (ms) => { now += ms; } });
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 409 }); };
  try {
    const job = await createAlignment(ebook, "recording-alice");
    const failed = await settled(job.id, (value) => value.status === "error");
    assert.equal(failed.status, "error");
    assert.equal(failed.error, "The alignment worker is busy. Retry in a moment.");
    assert.equal(now, WORKER_BUSY_WAIT_MS);
    assert.ok(calls > 5);
  } finally {
    setWorkerRetryClockForTests(null);
  }
});
