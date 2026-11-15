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
const { forgetEbookSetRunsForTests, listEbookSetMembers, resetEbookSetDeps, setEbookSetDeps } = await import("../server/ebook-set.ts");
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
/** When set, only the /anchor requests of these behaviour keys wait for the gate; the others answer at once. */
let gatedKeys: Set<string> | null = null;
function closeGate() {
  gate = new Promise((resolve) => (open = resolve));
}

/** The CTC worker answer of tests/ebook-set-ctc-probe.test.ts, behind the gate. */
async function anchorAnswer(_host: unknown, path: string, body: any) {
  if (path !== "/anchor") return new Response("unexpected request", { status: 500 });
  anchorRequests++;
  const key = body.fragments[1].split(" ")[0];
  if (!gatedKeys || gatedKeys.has(key)) await gate;
  const behaviour = behaviours[key] ?? "none";
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
  // A test that failed with the gate closed must not hold the next one.
  open();
  await ebookSetEvaluationsSettled();
  // Consensus jobs of earlier tests must not hold the fake hosts.
  sqlite.prepare("DELETE FROM alignment_jobs").run();
  resetEbookSetDeps();
  installPool();
  behaviours = {};
  gate = Promise.resolve();
  gatedKeys = null;
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

// Review round 1 of #325 (artifacts/orca/review-325-round1.md).

/** Alignment jobs the auto-queue or the backfill made for one ebook. */
const backfillJobs = (ebookId: string) =>
  (sqlite.prepare("SELECT data FROM alignment_jobs WHERE ebook_id=?").all(ebookId) as { data: string }[])
    .map((row) => JSON.parse(row.data) as { origin?: string })
    .filter((job) => job.origin === "backfill");

async function uploadEpub(workId: string, prefix: string, language = "en") {
  const boundary = "sonder-ebook-set-pending";
  const epub = await readerFixture({ language, title: prefix, bodies: [paragraphs(prefix), paragraphs(prefix)] });
  const res = await app.inject({
    method: "POST",
    url: `/api/ebooks/import?workId=${workId}`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${prefix}.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`),
      epub,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().id as string;
}

/** Queued alignment jobs stay queued: the scheduler does not start them while a test looks at the queue. */
async function withAlignmentsHeld(run: () => Promise<void>) {
  const { resetAlignmentRunnerForTests } = await import("../server/alignment.ts");
  stopAlignments();
  try {
    await run();
  } finally {
    sqlite.prepare("DELETE FROM alignment_jobs").run();
    resetAlignmentRunnerForTests();
  }
}

/** A test whose /anchor requests are only those of ebook-set checks: alignment jobs are held. */
const heldTest = (name: string, run: () => Promise<void>) => test(name, () => withAlignmentsHeld(run));

test("HIGH 1: an uploaded EPUB is not aligned while its check is pending; the check that ends accepted queues it once", async () => {
  await withAlignmentsHeld(async () => {
    const workId = seedWork();
    behaviours = { Upload: "forward" };
    closeGate();
    const ebookId = await uploadEpub(workId, "Upload");
    assert.equal(member(workId, ebookId)?.status, "pending");
    assert.equal(backfillJobs(ebookId).length, 0, "no alignment is queued while the member is pending");
    open();
    await ebookSetEvaluationsSettled();
    assert.equal(member(workId, ebookId)?.status, "accepted");
    assert.equal(backfillJobs(ebookId).length, 1, "the accepted check queues the alignment the upload queued on main");
    await backgroundRunner(app).tick("ebook-set");
    assert.equal(backfillJobs(ebookId).length, 1, "once");
  });
});

// Round 2 (coordinator, superseding round 1's option B): the only gate is "not while pending"; a check that ends
// with any result queues the alignment once, as main's upload did whatever its check said.
test("HIGH 1: a check that ends rejected or held queues the alignment once, as main's upload did", async () => {
  await withAlignmentsHeld(async () => {
    const workId = seedWork();
    behaviours = { Wrong: "none" };
    const rejected = await uploadEpub(workId, "Wrong");
    await ebookSetEvaluationsSettled();
    assert.equal(member(workId, rejected)?.status, "rejected");
    assert.equal(backfillJobs(rejected).length, 1, "rejected: queued");
    const french = await uploadEpub(workId, "Francais", "fr");
    await ebookSetEvaluationsSettled();
    assert.equal(member(workId, french)?.holdReason, "language_not_supported");
    assert.equal(backfillJobs(french).length, 1, "held: queued");
    await backgroundRunner(app).tick("ebook-set");
    assert.equal(backfillJobs(rejected).length + backfillJobs(french).length, 2, "once");
    // autoQueueAlignmentsForWork keeps main's own eligibility: without a configured worker it queues nothing.
    process.env.ALIGNMENT_POOL_ENABLED = "0";
    const held = await uploadEpub(workId, "Held");
    await ebookSetEvaluationsSettled();
    assert.equal(member(workId, held)?.holdReason, "awaiting_worker");
    assert.equal(backfillJobs(held).length, 0);
  });
});

for (const paused of ["ebook-set", "alignment"] as const) {
  heldTest(`HIGH 2: pausing ${paused} while a check runs lets that check finish and starts no other`, async () => {
    const workId = seedWork();
    const first = (await seedLibgenEpub(workId, "Right")).ebookId;
    const second = (await seedLibgenEpub(workId, "Right")).ebookId;
    seedMember(workId, first, "pending", null);
    seedMember(workId, second, "pending", null);
    behaviours = { Right: "forward" };
    closeGate();
    const round = backgroundRunner(app).tick("ebook-set");
    await until(() => anchorRequests > 0, "the first check");
    setPaused(paused, true);
    try {
      open();
      await round;
      await ebookSetEvaluationsSettled();
      const statuses = [member(workId, first)?.status, member(workId, second)?.status].sort();
      assert.deepEqual(statuses, ["accepted", "pending"], "the running check finished; the next one did not start");
    } finally {
      setPaused(paused, false);
    }
    await backgroundRunner(app).tick("ebook-set");
    assert.equal(member(workId, first)?.status, "accepted");
    assert.equal(member(workId, second)?.status, "accepted", "after resume the member left pending is checked");
  });
}

for (const order of ["valid first", "broken first"] as const) {
  heldTest(`HIGH 3: a sibling that cannot be parsed is left out of the evidence and does not fail a valid member's check (${order})`, async () => {
    const workId = seedWork();
    const seedBroken = async () => {
      const broken = (await seedLibgenEpub(workId, "Broken")).ebookId;
      writeFileSync(db.select().from(schema.ebookEditions).all().find((row) => row.id === broken)!.source, "not an epub");
      seedMember(workId, broken, "pending", null);
      return broken;
    };
    const seedValid = async () => {
      const valid = (await seedLibgenEpub(workId, "Right")).ebookId;
      seedMember(workId, valid, "pending", null);
      return valid;
    };
    // Members are checked in the order they were added.
    let valid: string;
    let broken: string;
    if (order === "valid first") {
      valid = await seedValid();
      broken = await seedBroken();
    } else {
      broken = await seedBroken();
      valid = await seedValid();
    }
    behaviours = { Right: "forward" };
    await backgroundRunner(app).tick("ebook-set");
    assert.equal(member(workId, broken)?.holdReason, "evaluation_failed");
    assert.equal(member(workId, valid)?.status, "accepted", "the broken sibling did not fail this check");
  });
}

heldTest("HIGH 3: a member held as evaluation_failed is not evidence; every other sibling that parses still is", async () => {
  behaviours = { Right: "forward" };
  const workId = seedWork();
  const failed = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, failed, "held", "evaluation_failed");
  const first = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, first, "pending", null);
  await backgroundRunner(app).tick("ebook-set");
  assert.equal(member(workId, first)?.status, "accepted");
  assert.equal(member(workId, first)?.evidence.sharedSentenceCount, 0, "the failed sibling's text is not evidence");
  // As on main, a sibling held for another reason, or accepted, is evidence.
  for (const [status, holdReason] of [["held", "awaiting_worker"], ["accepted", null]] as const) {
    const other = seedWork();
    const sibling = (await seedLibgenEpub(other, "Right")).ebookId;
    seedMember(other, sibling, status, holdReason);
    const next = (await seedLibgenEpub(other, "Right")).ebookId;
    seedMember(other, next, "pending", null);
    await backgroundRunner(app).tick("ebook-set");
    assert.ok((member(other, next)?.evidence.sharedSentenceCount ?? 0) > 0, `a ${status} sibling is evidence`);
    assert.equal(member(other, next)?.evidence.uniqueSentenceCount, 0, status);
  }
});

heldTest("HIGH 4: a check whose ebook is relinked to another work while it runs writes nothing", async () => {
  const workId = seedWork();
  const otherWork = seedWork();
  const { ebookId } = await seedLibgenEpub(workId, "Right");
  seedMember(workId, ebookId, "pending", null);
  behaviours = { Right: "forward" };
  closeGate();
  const round = backgroundRunner(app).tick("ebook-set");
  await until(() => anchorRequests > 0, "the check");
  const link = await app.inject({ method: "POST", url: `/api/reader/${ebookId}/link`, payload: { workId: otherWork } });
  assert.equal(link.statusCode, 200, link.body);
  open();
  await round;
  await ebookSetEvaluationsSettled();
  // Review round 2: the relink removed the pending member from the work it left; the check's result was dropped.
  assert.equal(member(workId, ebookId), undefined, "the result for the old work was dropped and the member removed");
  assert.equal(member(otherWork, ebookId), undefined);
  // The work's next pending member is checked; the one whose ebook moved is not tried again (it would only fail).
  const next = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, next, "pending", null);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    await backgroundRunner(app).tick("ebook-set");
  } finally {
    console.warn = warn;
  }
  assert.equal(member(workId, next)?.status, "accepted");
  assert.equal(member(workId, ebookId), undefined);
  assert.deepEqual(warnings.filter((line) => line.includes(ebookId)), [], "a member whose ebook is in another work is not checked again");
});

heldTest("HIGH 4: a check whose member is removed while it runs does not bring it back", async () => {
  const workId = seedWork();
  const { ebookId } = await seedLibgenEpub(workId, "Right");
  seedMember(workId, ebookId, "pending", null);
  behaviours = { Right: "forward" };
  closeGate();
  const round = backgroundRunner(app).tick("ebook-set");
  await until(() => anchorRequests > 0, "the check");
  sqlite.prepare("DELETE FROM work_ebook_set_members WHERE work_id=? AND ebook_id=?").run(workId, ebookId);
  open();
  await round;
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, ebookId), undefined);
});

test("HIGH 4: a member re-added while its check runs keeps its new row and is checked again", async () => {
  // Alignment jobs (the consensus of an accepted member) also send /anchor requests; hold them so only checks count.
  await withAlignmentsHeld(async () => {
    behaviours = { Right: "forward" };
    // One check of this recording takes this many /anchor requests.
    const probeWork = seedWork();
    const probeEbook = (await seedLibgenEpub(probeWork, "Right")).ebookId;
    seedMember(probeWork, probeEbook, "pending", null);
    await backgroundRunner(app).tick("ebook-set");
    const perCheck = anchorRequests;
    assert.ok(perCheck > 0);
    anchorRequests = 0;
    const workId = seedWork();
    const { md5, ebookId } = await seedLibgenEpub(workId, "Right");
    seedMember(workId, ebookId, "pending", null, Date.now() - 60_000);
    closeGate();
    const round = backgroundRunner(app).tick("ebook-set");
    await until(() => anchorRequests > 0, "the check");
    // Removed and added again while the first check runs: the first result is not for the new row.
    sqlite.prepare("DELETE FROM work_ebook_set_members WHERE work_id=? AND ebook_id=?").run(workId, ebookId);
    await postEbook(workId, md5);
    open();
    await round;
    await ebookSetEvaluationsSettled();
    assert.equal(member(workId, ebookId)?.status, "accepted");
    assert.equal(anchorRequests, 2 * perCheck, "the new row got a check of its own");
  });
});

heldTest("HIGH 4: a member removed while it waits for its turn is not checked or brought back", async () => {
  const workId = seedWork();
  const first = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, first, "pending", null);
  const second = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, second, "pending", null);
  behaviours = { Right: "forward" };
  closeGate();
  const round = backgroundRunner(app).tick("ebook-set");
  await until(() => anchorRequests > 0, "the first check");
  sqlite.prepare("DELETE FROM work_ebook_set_members WHERE work_id=? AND ebook_id=?").run(workId, second);
  open();
  await round;
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, first)?.status, "accepted");
  assert.equal(member(workId, second), undefined, "the member removed before its check is not recreated");
});

heldTest("HIGH 4: an ebook removed while its check runs does not stop the checks of the other members", async () => {
  const workId = seedWork();
  const gone = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, gone, "pending", null);
  const other = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, other, "pending", null);
  behaviours = { Right: "forward" };
  closeGate();
  const round = backgroundRunner(app).tick("ebook-set");
  await until(() => anchorRequests > 0, "the first check");
  // Which member runs first is the listing order; remove that one with its ebook.
  const running = listEbookSetMembers(workId)[0].ebookId;
  const survivor = running === gone ? other : gone;
  sqlite.prepare("DELETE FROM work_ebook_set_members WHERE work_id=? AND ebook_id=?").run(workId, running);
  sqlite.prepare("DELETE FROM ebook_editions WHERE id=?").run(running);
  open();
  await round;
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, running), undefined, "the removed member is not recreated");
  assert.equal(member(workId, survivor)?.status, "accepted", "the other member was still checked");
});

heldTest("MEDIUM 1: only the member being checked is running; the stuck time counts from the start of its check", async () => {
  const workId = seedWork();
  const long = Date.now() - 3 * 60 * 60_000;
  const first = (await seedLibgenEpub(workId, "Right")).ebookId;
  const second = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, first, "pending", null, long);
  seedMember(workId, second, "pending", null, long);
  behaviours = { Right: "forward" };
  closeGate();
  const before = (await app.inject("/api/activity")).json().items.filter((i: { processId: string; id: string }) =>
    i.processId === "ebook-set" && i.id.includes(encodeURIComponent(workId)));
  assert.deepEqual(before.map((i: { state: string }) => i.state), ["queued", "queued"], "nothing is checked yet");
  assert.ok(before.every((i: { stuck: unknown }) => !i.stuck), "a waiting member is not stuck");
  const round = backgroundRunner(app).tick("ebook-set");
  await until(() => anchorRequests > 0, "the first check");
  const items = (await app.inject("/api/activity")).json().items.filter((i: { processId: string; id: string }) =>
    i.processId === "ebook-set" && i.id.includes(encodeURIComponent(workId)));
  const states = items.map((i: { state: string }) => i.state).sort();
  assert.deepEqual(states, ["queued", "running"]);
  const running = items.find((i: { state: string }) => i.state === "running");
  assert.equal(running.stuck, null, "the check started just now, though the row is three hours old");
  assert.ok(running.startedAt >= long + 60_000, "startedAt is the start of the check");
  open();
  await round;
});

// Review round 2 of #325 (artifacts/orca/review-325-round2.md).

const link = (ebookId: string, workId: string) =>
  app.inject({ method: "POST", url: `/api/reader/${ebookId}/link`, payload: { workId } });

/** Points an ebook at another work behind the routes' back: the state a relink left before this fix. */
const moveBehindTheRoutes = (ebookId: string, workId: string) =>
  sqlite.prepare("UPDATE ebook_editions SET work_id=? WHERE id=?").run(workId, ebookId);

heldTest("R2 HIGH 1: relinking an ebook whose member is pending removes that member from the work it leaves; the work it joins gets what main did", async () => {
  const left = seedWork();
  const joined = seedWork();
  const { ebookId } = await seedLibgenEpub(left, "Right");
  seedMember(left, ebookId, "pending", null);
  const res = await link(ebookId, joined);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(member(left, ebookId), undefined, "the pending member left behind is removed");
  const view = await app.inject(`/api/works/${left}/ebook-set`);
  assert.deepEqual(view.json().members, [], "the work it left no longer shows it as Checking");
  const activity = await app.inject("/api/activity");
  assert.equal(activity.json().items.find((i: { id: string }) => i.id === `ebook-set:${left}:${ebookId}`), undefined);
  // As on main, the link registers no member in the work it joins and auto-queues the pair there.
  assert.equal(member(joined, ebookId), undefined);
  assert.equal(backfillJobs(ebookId).length, 1, "main's link auto-queue for the work it joins");
});

heldTest("R2 HIGH 1: relinking an ebook whose member is held, accepted or rejected keeps that member, as on main", async () => {
  for (const [status, holdReason] of [["held", "awaiting_worker"], ["accepted", null], ["rejected", null]] as const) {
    const left = seedWork();
    const joined = seedWork();
    const { ebookId } = await seedLibgenEpub(left, "Right");
    seedMember(left, ebookId, status, holdReason);
    const res = await link(ebookId, joined);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(member(left, ebookId)?.status, status, status);
    assert.equal(member(joined, ebookId), undefined, status);
  }
});

heldTest("R2 HIGH 1: after the removal the work it left has its set brought up to date (consensus synced)", async () => {
  const left = seedWork();
  const joined = seedWork();
  const accepted = (await seedLibgenEpub(left, "Right")).ebookId;
  seedMember(left, accepted, "accepted", null);
  const { ebookId } = await seedLibgenEpub(left, "Right");
  seedMember(left, ebookId, "pending", null);
  assert.equal((await app.inject(`/api/works/${left}/ebook-set`)).json().consensus, null, "no consensus yet");
  const res = await link(ebookId, joined);
  assert.equal(res.statusCode, 200, res.body);
  const view = (await app.inject(`/api/works/${left}/ebook-set`)).json();
  assert.deepEqual(view.members.map((m: { ebookId: string }) => m.ebookId), [accepted]);
  assert.ok(view.consensus?.sentenceCount > 0, "the set was synced after the member was removed");
});

heldTest("R2 HIGH 1: saving an ebook already on the server for another work removes its pending member in the old one", async () => {
  const left = seedWork();
  const joined = seedWork();
  const { md5, ebookId } = await seedLibgenEpub(left, "Right");
  seedMember(left, ebookId, "pending", null);
  behaviours = { Right: "forward" };
  closeGate();
  const res = await postEbook(joined, md5);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(member(left, ebookId), undefined);
  assert.equal(member(joined, ebookId)?.status, "pending", "the work it joins registers it, as this branch does for any save");
  open();
  await ebookSetEvaluationsSettled();
  assert.equal(member(joined, ebookId)?.status, "accepted");
});

heldTest("R2 HIGH 1: reevaluate skips a member whose ebook is linked to another work, removes it if pending, and checks the rest", async () => {
  const workId = seedWork();
  const elsewhere = seedWork();
  const stalePending = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, stalePending, "pending", null);
  const staleHeld = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, staleHeld, "held", "awaiting_worker");
  const valid = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, valid, "pending", null);
  moveBehindTheRoutes(stalePending, elsewhere);
  moveBehindTheRoutes(staleHeld, elsewhere);
  behaviours = { Right: "forward" };
  const res = await app.inject({ method: "POST", url: `/api/works/${workId}/ebook-set/reevaluate` });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().map((r: { status: string }) => r.status), ["accepted"]);
  assert.equal(member(workId, stalePending), undefined, "a stale pending member is removed");
  assert.equal(member(workId, staleHeld)?.status, "held", "a stale held member is skipped and kept");
  assert.equal(member(workId, valid)?.status, "accepted");
});

for (const [result, behaviour] of [["accepted", "forward"], ["rejected", "none"]] as const)
heldTest(`R2 HIGH 3: a member's alignment is queued right after its result (${result}), before the next member's check starts`, async () => {
  const workId = seedWork();
  const right = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, right, "pending", null);
  const later = (await seedLibgenEpub(workId, "Later")).ebookId;
  seedMember(workId, later, "pending", null);
  // Members are checked in the listing order; the one checked second waits at the gate.
  const [first, second] = listEbookSetMembers(workId).map((m) => m.ebookId);
  const [firstKey, secondKey] = first === right ? ["Right", "Later"] : ["Later", "Right"];
  behaviours = { [firstKey]: behaviour, [secondKey]: "forward" };
  gatedKeys = new Set([secondKey]);
  closeGate();
  const round = backgroundRunner(app).tick("ebook-set");
  await until(() => member(workId, first)?.status === result, "the first member's result");
  await until(() => (anchorRequests > 0 && backfillJobs(first).length > 0) || member(workId, second)?.status !== "pending", "the queueing");
  assert.equal(member(workId, second)?.status, "pending", "the second check is still running");
  assert.equal(backfillJobs(first).length, 1, "queued before the batch ends");
  assert.equal(backfillJobs(second).length, 0);
  open();
  await round;
  await ebookSetEvaluationsSettled();
  assert.equal(member(workId, second)?.status, "accepted");
  assert.equal(backfillJobs(first).length, 1, "once");
  assert.equal(backfillJobs(second).length, 1);
});

heldTest("R2 HIGH 3: a queueing that fails is logged with its member and does not stop the batch", async () => {
  const workId = seedWork();
  const first = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, first, "pending", null);
  const second = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, second, "pending", null);
  behaviours = { Right: "forward" };
  const queued: string[] = [];
  setEbookSetDeps({
    queueAlignment: async (_workId: string, filter: { ebookId: string }) => {
      if (filter.ebookId === first) throw new Error("the queue is broken");
      queued.push(filter.ebookId);
    },
  } as never);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    await backgroundRunner(app).tick("ebook-set");
  } finally {
    console.warn = warn;
  }
  assert.equal(member(workId, first)?.status, "accepted", "the failed queueing does not change the result");
  assert.equal(member(workId, second)?.status, "accepted", "the batch went on");
  assert.deepEqual(queued, [second]);
  assert.ok(warnings.some((line) => line.includes(first) && line.includes("the queue is broken")), warnings.join("\n"));
});

heldTest("R3: a check that throws writes its hold and then queues the alignment, like every written result", async () => {
  const workId = seedWork();
  const { ebookId } = await seedLibgenEpub(workId, "Right");
  seedMember(workId, ebookId, "pending", null);
  behaviours = { Right: "forward" };
  writeFileSync(db.select().from(schema.ebookEditions).all().find((row) => row.id === ebookId)!.source, "not an epub");
  const queued: string[] = [];
  setEbookSetDeps({ queueAlignment: async (_workId: string, filter: { ebookId: string }) => void queued.push(filter.ebookId) } as never);
  await backgroundRunner(app).tick("ebook-set");
  assert.equal(member(workId, ebookId)?.holdReason, "evaluation_failed");
  assert.deepEqual(queued, [ebookId], "queued once, after the hold was written");
});

heldTest("R2 HIGH 3: reevaluate queues the alignment of a member it moves from pending to a result, not of a held one (as main)", async () => {
  const workId = seedWork();
  const accepted = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, accepted, "pending", null);
  const rejected = (await seedLibgenEpub(workId, "Wrong")).ebookId;
  seedMember(workId, rejected, "pending", null);
  const held = (await seedLibgenEpub(workId, "Right")).ebookId;
  seedMember(workId, held, "held", "awaiting_worker");
  behaviours = { Right: "forward", Wrong: "none" };
  const res = await app.inject({ method: "POST", url: `/api/works/${workId}/ebook-set/reevaluate` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(member(workId, accepted)?.status, "accepted");
  assert.equal(member(workId, rejected)?.status, "rejected");
  assert.equal(member(workId, held)?.status, "accepted");
  assert.equal(backfillJobs(accepted).length, 1, "pending to accepted: queued");
  assert.equal(backfillJobs(rejected).length, 1, "pending to rejected: queued");
  assert.equal(backfillJobs(held).length, 0, "main's reevaluate of a held member queued nothing");
});
