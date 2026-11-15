// Adding an EPUB to a work returns at once with its ebook-set membership pending; the evaluation runs in the
// background on a fake pool host (tests/fake-pool-host.ts: no SSH, no network) and ends accepted or rejected (#325).
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readerFixture } from "./reader-fixture.ts";
import { fakePoolHosts, type FakePool } from "./fake-pool-host.ts";

// Env before any server import: storage.ts and db.ts capture paths at load.
const temp = mkdtempSync(join(tmpdir(), "sonder-ebook-set-pending-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.ALIGNMENT_WORKER_TOKEN = "probe-token";
process.env.ALIGNMENT_POOL_ENABLED = "1";
delete process.env.APP_PASSWORD;
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });

const { db, sqlite } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { CTC_ENGINE, resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests } = await import("../server/alignment-pool.ts");
const { forgetEbookSetRunsForTests, listEbookSetMembers, resetEbookSetDeps } = await import("../server/ebook-set.ts");
const { AWAITING_WORKER_RETRY_MS, ebookSetEvaluationsSettled, forgetEbookSetRoundForTests } =
  await import("../server/ebook-set-evaluation.ts");
const { backgroundRunner } = await import("../server/background-runner.ts");
const { setPaused } = await import("../server/activity-pause.ts");
const { stopAlignments } = await import("../server/alignment.ts");
const { createApp } = await import("../server/app.ts");

const originalFetch = globalThis.fetch;
const PARAGRAPHS = 150;
const audio = join(temp, "media", "audio.mp3");
writeFileSync(audio, "audio bytes");

// Every loop is ticked by hand, so a test decides when the background evaluation runs on its own.
const app = await createApp({ background: { manual: true } });

type Behaviour = "forward" | "none";
let behaviours: Record<string, Behaviour> = {};
/** A deliberately slow evaluation: every /anchor answer waits until the test opens the gate. */
let gate: Promise<void> = Promise.resolve();
let open: () => void = () => {};
let anchorRequests = 0;
function closeGate() {
  gate = new Promise((resolve) => (open = resolve));
}

/** The CTC worker answer of tests/ebook-set-ctc-probe.test.ts, behind the gate. */
async function anchorAnswer(_host: unknown, path: string, body: any) {
  if (path !== "/anchor") return new Response("unexpected request", { status: 500 });
  anchorRequests++;
  await gate;
  const behaviour = behaviours[body.fragments[1].split(" ")[0]] ?? "none";
  const base = { engine: CTC_ENGINE, outcome: "mapped", text: Array.from({ length: 40 }, () => "word").join(" ") };
  if (behaviour === "none") return { ...base, outcome: "unsynced", match: null, matches: [], start: body.start };
  const index = Math.floor(body.start / 12);
  const match = { index, lastIndex: index, score: 0.82, start: body.start + 1 };
  return { ...base, match, matches: [match], start: body.start + 1 };
}

let fake: FakePool;
let pools = 0;
/** A fresh fake pool, as a server (re)started with these hosts has. */
function installPool() {
  fake = fakePoolHosts(join(temp, `hosts-${++pools}`), undefined, anchorAnswer);
  resetAlignmentPoolCoordinator(Object.values(fake.hosts).map((host, index) => ({
    id: host.id, sshTarget: host.sshTarget, maxConcurrent: 1, remoteWorkRoot: host.root, workerUrl: host.workerUrl,
    device: host.device, precision: host.precision, rank: index + 1,
  })));
  setAlignmentPoolDepsForTests(fake.deps);
  globalThis.fetch = fake.fetch;
}

beforeEach(async () => {
  await ebookSetEvaluationsSettled();
  // Consensus jobs of earlier tests must not hold the fake hosts.
  sqlite.prepare("DELETE FROM alignment_jobs").run();
  resetEbookSetDeps();
  installPool();
  behaviours = {};
  gate = Promise.resolve();
  anchorRequests = 0;
  process.env.ALIGNMENT_POOL_ENABLED = "1";
});

after(async () => {
  open();
  await ebookSetEvaluationsSettled();
  await app.close();
  // An accepted member queues its consensus alignment; let that run end before the database closes.
  stopAlignments();
  await new Promise((resolve) => setTimeout(resolve, 200));
  globalThis.fetch = originalFetch;
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

function paragraphs(prefix: string) {
  return Array.from({ length: PARAGRAPHS }, (_, i) => `<p>${prefix} paragraph ${i} of the story continues here.</p>`).join("");
}

/** A work with one recording whose audio is on the server. */
function seedWork() {
  const workId = `work-${randomUUID()}`;
  db.insert(schema.works).values({ id: workId, title: "Pending Book", author: "Ada Author", description: "", genre: "", year: 2026 }).run();
  const editionId = `edition-${randomUUID()}`;
  db.insert(schema.editions).values({ id: editionId, workId, cover: "", narrator: "", rating: 0, sourceLabel: "" }).run();
  const recordingId = `recording-${randomUUID()}`;
  db.insert(schema.recordings).values({ id: recordingId, editionId }).run();
  db.insert(schema.tracks)
    .values({ id: `track-${randomUUID()}`, recordingId, title: "Book", index: 0, duration: 3600, chapters: [], source: audio, sourceType: "local" })
    .run();
  return workId;
}

/** A LibGen EPUB already on the media drive, so POST /api/ebooks links it without a download. */
async function seedLibgenEpub(workId: string, prefix: string) {
  const md5 = randomUUID().replace(/-/g, "");
  const ebookId = `libgen-${md5}`;
  const path = join(temp, "media", `${ebookId}.epub`);
  writeFileSync(path, await readerFixture({ language: "en", title: prefix, bodies: [paragraphs(prefix), paragraphs(prefix)] }));
  db.insert(schema.ebookEditions).values({ id: ebookId, workId, format: "epub", source: path }).run();
  return { md5, ebookId };
}

function postEbook(workId: string, md5: string) {
  return app.inject({
    method: "POST",
    url: "/api/ebooks",
    payload: {
      source: "libgen", md5, title: "Pending Book", authors: ["Ada Author"], extension: "epub", language: "English",
      size: "435 kB", year: "2026", coverUrl: null, url: `https://libgen.test/ads.php?md5=${md5}`, workId,
    },
  });
}

function seedMember(workId: string, ebookId: string, status: string, holdReason: string | null, updatedAt = Date.now()) {
  db.insert(schema.workEbookSetMembers)
    .values({
      workId, ebookId, status, holdReason, updatedAt,
      evidence: JSON.stringify({ sharedSentenceCount: 0, uniqueSentenceCount: 0, audioSupportedCoverage: null, language: null, byteSize: null,
        outlier: { passed: false, reason: "no_spoken_samples", spokenSampleCount: 0, matchedSampleCount: 0, anchorCount: 0, forwardOrder: true, samples: [] } }),
    })
    .run();
}

const member = (workId: string, ebookId: string) => listEbookSetMembers(workId).find((m) => m.ebookId === ebookId);

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("an import whose evaluation takes longer than the request returns first, with the member pending", async () => {
  const workId = seedWork();
  const { md5, ebookId } = await seedLibgenEpub(workId, "Right");
  behaviours = { Right: "forward" };
  closeGate();
  const res = await postEbook(workId, md5);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().id, ebookId, "the fields older clients read are kept");
  assert.deepEqual(res.json().ebookSet, { status: "pending" });
  assert.equal(member(workId, ebookId)?.status, "pending", "the member row exists when the response arrives");
  // The evaluation has started on the pool and is still waiting on the slow worker.
  await until(() => anchorRequests > 0, "the first /anchor request");
  const view = await app.inject(`/api/works/${workId}/ebook-set`);
  assert.equal(view.json().members.find((m: { ebookId: string }) => m.ebookId === ebookId).status, "pending");
  const activity = await app.inject("/api/activity");
  const item = activity.json().items.find((i: { id: string }) => i.id === `ebook-set:${workId}:${ebookId}`);
  assert.equal(item?.state, "running", "the pending evaluation is an activity of the ebook-set checks");
  assert.equal(item?.processId, "ebook-set");
  open();
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, ebookId)?.status, "accepted", "the background evaluation ends the member accepted");
  assert.equal(member(workId, ebookId)?.holdReason, null);
  const done = await app.inject("/api/activity");
  assert.equal(done.json().items.find((i: { id: string }) => i.id === `ebook-set:${workId}:${ebookId}`)?.state, "done");
});

test("the background evaluation rejects a wrong edition", async () => {
  const workId = seedWork();
  const { md5, ebookId } = await seedLibgenEpub(workId, "Wrong");
  behaviours = { Wrong: "none" };
  const res = await postEbook(workId, md5);
  assert.deepEqual(res.json().ebookSet, { status: "pending" });
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, ebookId)?.status, "rejected");
});

test("an upload for a work also returns with the member pending and is evaluated in the background", async () => {
  const workId = seedWork();
  behaviours = { Upload: "forward" };
  closeGate();
  const boundary = "sonder-ebook-set-pending";
  const epub = await readerFixture({ language: "en", title: "Upload", bodies: [paragraphs("Upload"), paragraphs("Upload")] });
  const res = await app.inject({
    method: "POST",
    url: `/api/ebooks/import?workId=${workId}`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Upload.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`),
      epub,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().alreadySaved, false, "the fields older clients read are kept");
  assert.deepEqual(res.json().ebookSet, { status: "pending" });
  assert.equal(member(workId, res.json().id)?.status, "pending");
  open();
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, res.json().id)?.status, "accepted");
});

test("a server restart during an evaluation leaves the member pending, and the loop resumes it at start", async () => {
  const workId = seedWork();
  const { md5, ebookId } = await seedLibgenEpub(workId, "Right");
  behaviours = { Right: "forward" };
  closeGate();
  await postEbook(workId, md5);
  await until(() => anchorRequests > 0, "the first /anchor request");
  // The server stops here: nothing but the member row survives, and it says pending.
  assert.equal(member(workId, ebookId)?.status, "pending");
  forgetEbookSetRoundForTests();
  forgetEbookSetRunsForTests();
  installPool();
  gate = Promise.resolve();
  // The restarted server's loop runs at start.
  assert.equal(await backgroundRunner(app).tick("ebook-set"), "ran");
  assert.equal(member(workId, ebookId)?.status, "accepted");
});

test("reevaluate evaluates a pending member and a held one", async () => {
  const workId = seedWork();
  const pending = (await seedLibgenEpub(workId, "Right")).ebookId;
  const held = (await seedLibgenEpub(workId, "Wrong")).ebookId;
  seedMember(workId, pending, "pending", null);
  seedMember(workId, held, "held", "awaiting_worker");
  behaviours = { Right: "forward", Wrong: "none" };
  const res = await app.inject({ method: "POST", url: `/api/works/${workId}/ebook-set/reevaluate` });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().map((r: { status: string }) => r.status).sort(), ["accepted", "rejected"]);
  assert.equal(member(workId, pending)?.status, "accepted");
  assert.equal(member(workId, held)?.status, "rejected");
});

test("a member held awaiting_worker is re-examined by the loop once its hold is due and a worker is configured", async () => {
  const workId = seedWork();
  const due = (await seedLibgenEpub(workId, "Right")).ebookId;
  const recent = (await seedLibgenEpub(workId, "Other")).ebookId;
  seedMember(workId, due, "held", "awaiting_worker", Date.now() - AWAITING_WORKER_RETRY_MS - 1000);
  seedMember(workId, recent, "held", "awaiting_worker", Date.now());
  behaviours = { Right: "forward" };
  process.env.ALIGNMENT_POOL_ENABLED = "0";
  await backgroundRunner(app).tick("ebook-set");
  assert.equal(member(workId, due)?.status, "held", "with the pool off there is no worker to try");
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  await backgroundRunner(app).tick("ebook-set");
  assert.equal(member(workId, due)?.status, "accepted", "the pending evaluation re-examined the hold");
  assert.equal(member(workId, recent)?.status, "held", "a hold set just now waits for its retry time");
  assert.equal(member(workId, recent)?.holdReason, "awaiting_worker");
});

test("while ebook-set checks or alignment are paused a new member stays pending, and runs after resume", async () => {
  const workId = seedWork();
  const { md5, ebookId } = await seedLibgenEpub(workId, "Right");
  behaviours = { Right: "forward" };
  for (const process of ["ebook-set", "alignment"] as const) {
    setPaused(process, true);
    try {
      await postEbook(workId, md5);
      await ebookSetEvaluationsSettled();
      assert.equal(member(workId, ebookId)?.status, "pending", process);
      assert.equal(anchorRequests, 0, process);
    } finally {
      setPaused(process, false);
    }
  }
  await backgroundRunner(app).tick("ebook-set");
  assert.equal(member(workId, ebookId)?.status, "accepted");
});

test("an evaluation that throws holds the member as failed; Activity's Retry evaluates it again", async () => {
  const workId = seedWork();
  const { md5, ebookId } = await seedLibgenEpub(workId, "Right");
  behaviours = { Right: "forward" };
  const path = db.select().from(schema.ebookEditions).all().find((row) => row.id === ebookId)!.source;
  const epub = readFileSync(path);
  writeFileSync(path, "not an epub");
  await postEbook(workId, md5);
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, ebookId)?.status, "held");
  assert.equal(member(workId, ebookId)?.holdReason, "evaluation_failed");
  const id = `ebook-set:${workId}:${ebookId}`;
  const failed = (await app.inject("/api/activity")).json().items.find((i: { id: string }) => i.id === id);
  assert.equal(failed?.state, "failed");
  assert.ok(failed?.error, "the failure says why");
  assert.deepEqual(failed?.actions, ["retry"]);
  writeFileSync(path, epub);
  const { invalidateParsedBook } = await import("../server/reader.ts");
  invalidateParsedBook(ebookId);
  const retried = await app.inject({ method: "POST", url: "/api/activity/items/retry", payload: { id } });
  assert.equal(retried.statusCode, 200, retried.body);
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, ebookId)?.status, "accepted");
});

test("adding an ebook that is already an accepted member keeps its result", async () => {
  const workId = seedWork();
  const { md5, ebookId } = await seedLibgenEpub(workId, "Right");
  behaviours = { Right: "forward" };
  await postEbook(workId, md5);
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, ebookId)?.status, "accepted");
  const requests = anchorRequests;
  const again = await postEbook(workId, md5);
  assert.deepEqual(again.json().ebookSet, { status: "accepted" });
  await ebookSetEvaluationsSettled();
  assert.equal(anchorRequests, requests, "no new evaluation");
});

test("setting the default works once the pending member is accepted", async () => {
  const workId = seedWork();
  const { md5, ebookId } = await seedLibgenEpub(workId, "Right");
  behaviours = { Right: "forward" };
  closeGate();
  await postEbook(workId, md5);
  const early = await app.inject({ method: "PATCH", url: `/api/works/${workId}/ebook-set/default`, payload: { ebookId } });
  assert.equal(early.statusCode, 400, "a pending member cannot be the default yet");
  open();
  await ebookSetEvaluationsSettled();
  const res = await app.inject({ method: "PATCH", url: `/api/works/${workId}/ebook-set/default`, payload: { ebookId } });
  assert.equal(res.statusCode, 200, res.body);
});
