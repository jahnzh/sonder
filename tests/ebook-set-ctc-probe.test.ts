import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { readerFixture } from "./reader-fixture.ts";

// Env before any server import: storage.ts and db.ts capture paths at load.
const temp = mkdtempSync(join(tmpdir(), "sonder-ebook-set-ctc-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
process.env.ALIGNMENT_WORKER_TOKEN = "probe-token";
process.env.ALIGNMENT_POOL_ENABLED = "1";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });

const { db, sqlite } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { evaluateOutlierCheck } = await import("../server/ebook-set-outlier.ts");
const { planSamples } = await import("../server/alignment-anchors.ts");
const { getAlignmentPoolCoordinator, resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests, CTC_ENGINE } =
  await import("../server/alignment-pool.ts");
const { groupFragments, sampleFromCtcAnchor } = await import("../server/ebook-set-ctc-probe.ts");
const {
  evaluateEbookSetMember,
  fetchTopKIntoEbookSet,
  listEbookSetMembers,
  reevaluateEbookSetForWork,
  resetEbookSetDeps,
  setEbookSetDeps,
} = await import("../server/ebook-set.ts");
const { setPaused } = await import("../server/activity-pause.ts");
const { audioFingerprint, listAlignmentJobs, resetAlignmentRunnerForTests, stopAlignments } =
  await import("../server/alignment.ts");
const { iso3 } = await import("../server/language.ts");
const { CONSENSUS_EBOOK_PREFIX } = await import("../server/ebook-set-consensus.ts");

const originalFetch = globalThis.fetch;
const PARAGRAPHS = 150;
const audio = join(temp, "media", "audio.mp3");
writeFileSync(audio, "audio bytes");

type Handler = (path: string, body: any, host: "wsl" | "lisa") => Response | Promise<Response>;
let requests: { host: "wsl" | "lisa"; path: string; body: any }[] = [];
let uploads: { local: string; remote: string; target: string }[] = [];
let commands: { target: string; command: string }[] = [];
let health: { down: string[]; busy: string[] } = { down: [], busy: [] };
let handler: Handler = () => new Response("{}", { status: 500 });

setAlignmentPoolDepsForTests({
  async probe() {
    return true;
  },
  async exec(target, command) {
    commands.push({ target, command });
    return { code: 0, stdout: "", stderr: "" };
  },
  async uploadFile(local, remote, target) {
    uploads.push({ local, remote, target });
    mkdirSync(dirname(remote), { recursive: true });
    copyFileSync(local, remote);
  },
});
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const lisa = url.includes("lisa-worker");
  const host = lisa ? "lisa" : "wsl";
  const path = new URL(url).pathname;
  if (path === "/health") {
    if (health.down.includes(host)) throw new Error(`${host} is unreachable`);
    return Response.json({
      ready: true,
      busy: health.busy.includes(host),
      stuck: false,
      mediaRoot: join(temp, host),
      ctc: {
        engine: CTC_ENGINE,
        ready: true,
        device: lisa ? "cpu" : "cuda",
        precision: lisa ? "float32" : "float16",
        passageReady: true,
      },
    });
  }
  const body = JSON.parse(String(init?.body ?? "{}"));
  requests.push({ host, path, body });
  return handler(path, body, host);
};

/** The accepted candidate also queues a real alignment whose samples reuse the cache; only probe requests count here. */
const probeUploads = () => uploads.filter((u) => u.remote.includes("/ctc-probe-"));
const probes = () => requests.filter((r) => String(r.body.output ?? "").includes("/probe-"));

function resetPool() {
  resetAlignmentPoolCoordinator([
    { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl: "http://wsl-worker.test", device: "cuda", precision: "float16", rank: 1 },
    { id: "lisa", sshTarget: "lisa", maxConcurrent: 1, remoteWorkRoot: temp, workerUrl: "http://lisa-worker.test", device: "cpu", precision: "float32", rank: 2 },
  ]);
}

beforeEach(() => {
  // Drop leftover consensus jobs so probing does not wait on them forever.
  sqlite.prepare("DELETE FROM alignment_jobs").run();
  resetEbookSetDeps();
  resetPool();
  requests = [];
  uploads = [];
  commands = [];
  health = { down: [], busy: [] };
  handler = () => new Response("{}", { status: 500 });
  process.env.ALIGNMENT_POOL_ENABLED = "1";
});

after(async () => {
  globalThis.fetch = originalFetch;
  stopAlignments();
  await new Promise((resolve) => setTimeout(resolve, 200));
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  resetEbookSetDeps();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

function paragraphs(prefix: string) {
  return Array.from({ length: PARAGRAPHS }, (_, i) => `<p>${prefix} paragraph ${i} of the story continues here.</p>`).join("");
}

async function seedEpub(workId: string, prefix: string, language = "en", id = `ebook-${randomUUID()}`) {
  const ebookId = id;
  const path = join(temp, "media", `${ebookId}.epub`);
  writeFileSync(path, await readerFixture({ language, title: prefix, bodies: [paragraphs(prefix), paragraphs(prefix)] }));
  db.insert(schema.ebookEditions).values({ id: ebookId, workId, format: "epub", source: path }).run();
  return ebookId;
}

function seedWork(withRecording = true, duration = 3600) {
  const workId = `work-${randomUUID()}`;
  db.insert(schema.works).values({ id: workId, title: "Probe Book", author: "Ada Author", description: "", genre: "", year: 2026 }).run();
  const recordingId = `recording-${randomUUID()}`;
  const trackId = `track-${randomUUID()}`;
  if (withRecording) {
    const editionId = `edition-${randomUUID()}`;
    db.insert(schema.editions).values({ id: editionId, workId, cover: "", narrator: "", rating: 0, sourceLabel: "" }).run();
    db.insert(schema.recordings).values({ id: recordingId, editionId }).run();
    db.insert(schema.tracks)
      .values({ id: trackId, recordingId, title: "Book", index: 0, duration, chapters: [], source: audio, sourceType: "local" })
      .run();
  }
  return { workId, recordingId, trackId };
}

type Behaviour = "forward" | "none" | "backward";
/** A fake CTC worker: the candidate's behaviour is chosen by its first body paragraph (the first fragment is a heading). */
function ctcWorker(behaviours: Record<string, Behaviour>): Handler {
  return (path, body) => {
    if (path !== "/anchor") return new Response("{}", { status: 404 });
    const behaviour = behaviours[body.fragments[1].split(" ")[0]] ?? "none";
    const base = { engine: CTC_ENGINE, outcome: "mapped", text: Array.from({ length: 40 }, () => "word").join(" ") };
    if (behaviour === "none") return Response.json({ ...base, outcome: "unsynced", match: null, matches: [], start: body.start });
    // The paragraph grows (or shrinks) with the position in the recording, as a real match does.
    const slot = Math.floor(body.start / 12);
    const index = behaviour === "forward" ? slot : 297 - slot;
    const match = { index, lastIndex: index, score: 0.82, start: body.start + 1 };
    return Response.json({ ...base, match, matches: [match], start: body.start + 1 });
  };
}

test("candidates are accepted and rejected by the unchanged outlier rule using CTC sample scores", async () => {
  const { workId, recordingId, trackId } = seedWork();
  const right = await seedEpub(workId, "Right");
  const wrong = await seedEpub(workId, "Wrong");
  const shuffled = await seedEpub(workId, "Shuffled");
  handler = ctcWorker({ Right: "forward", Wrong: "none", Shuffled: "backward" });

  const accepted = await evaluateEbookSetMember(workId, right);
  const rejected = await evaluateEbookSetMember(workId, wrong);
  const unordered = await evaluateEbookSetMember(workId, shuffled);

  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.evidence.outlier.reason, "ok");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.evidence.outlier.reason, "insufficient_matches");
  assert.equal(unordered.status, "rejected");
  assert.equal(unordered.evidence.outlier.reason, "not_forward");

  // The verdict is exactly the unchanged rule applied to the scores the worker returned.
  const planned = planSamples([{ id: trackId, duration: 3600 }]);
  assert.equal(accepted.evidence.outlier.spokenSampleCount, planned.length);
  assert.equal(accepted.evidence.outlier.matchedSampleCount, planned.length);
  const fragments = Array.from({ length: PARAGRAPHS * 2 + 2 }, () => ({ words: 8, section: 0 }));
  const direct = evaluateOutlierCheck(
    planned.map((sample, i) => ({
      ...sample,
      done: true,
      spokenWords: 40,
      match: { fragment: i * 7, score: 0.82, start: sample.time + 1 },
    })),
    fragments,
    [{ id: trackId, duration: 3600 }],
    fragments.map(() => ""),
  );
  assert.equal(direct.passed, accepted.evidence.outlier.passed);
  assert.deepEqual(
    listEbookSetMembers(workId).map((m) => [m.ebookId, m.status]).sort(),
    [[right, "accepted"], [shuffled, "rejected"], [wrong, "rejected"]].sort(),
  );

  // Requests carry the recording's cache identity and run on the pool, never on the production worker.
  const anchors = probes().filter((r) => r.path === "/anchor");
  assert.equal(anchors.length, 3 * planned.length, "one request per sample and candidate");
  assert.ok(probes().every((r) => r.host === "wsl"));
  for (const { body } of anchors) {
    assert.equal(body.engine, "ctc");
    assert.equal(body.language, "eng");
    assert.equal(body.recordingId, recordingId);
    assert.equal(body.trackId, trackId);
    assert.equal(body.audioFingerprint, audioFingerprint(recordingId), "the same cache identity a full alignment sends");
    assert.equal(body.token, "probe-token");
    assert.equal(body.duration, 30);
    assert.ok(body.audio.startsWith(join(temp, "wsl", "alignment", "pool-jobs")), body.audio);
    assert.ok(body.output.startsWith(join(temp, "wsl", "alignment", "pool-jobs")), body.output);
    assert.ok(planned.some((sample) => sample.time === body.start), "windows are the planned samples");
    assert.equal(body.fragments.length, PARAGRAPHS * 2 + 2, "every paragraph and the two chapter headings");
  }
  assert.ok(!requests.some((r) => String(JSON.stringify(r)).includes("production-worker")));
});

test("a candidate with no audio yet stays held and no worker is contacted (ADR 0004)", async () => {
  const { workId } = seedWork(false);
  const ebook = await seedEpub(workId, "Right");
  handler = ctcWorker({ Right: "forward" });
  const result = await evaluateEbookSetMember(workId, ebook);
  assert.equal(result.status, "held");
  assert.equal(listEbookSetMembers(workId)[0].holdReason, "awaiting_audio");
  assert.equal(probes().length, 0);
  assert.equal(probeUploads().length, 0);
});

test("candidates re-evaluated together share one staging, one host lease and one cleanup", async () => {
  const { workId } = seedWork();
  const ids = [await seedEpub(workId, "Right"), await seedEpub(workId, "Wrong"), await seedEpub(workId, "Other")];
  for (const ebookId of ids) {
    // Seed as held members, as when the audio was not on the server yet.
    db.insert(schema.workEbookSetMembers)
      .values({
        workId,
        ebookId,
        status: "held",
        holdReason: "awaiting_audio",
        evidence: JSON.stringify({ outlier: { passed: false, reason: "no_spoken_samples", spokenSampleCount: 0, matchedSampleCount: 0, anchorCount: 0, forwardOrder: true, samples: [] } }),
        updatedAt: Date.now(),
      })
      .run();
  }
  handler = ctcWorker({ Right: "forward", Wrong: "none", Other: "none" });
  const results = await reevaluateEbookSetForWork(workId);
  assert.deepEqual(results.map((r) => r.status).sort(), ["accepted", "rejected", "rejected"]);
  assert.equal(probeUploads().length, 1, "the recording is copied to the host once");
  assert.equal(probes().length, 3 * planSamples([{ id: "t", duration: 3600 }]).length);
  const removals = commands.filter((c) => c.command.startsWith("rm -rf"));
  assert.equal(removals.length, 1);
  assert.match(removals[0].command, /pool-jobs\/ctc-probe-/);
  assert.equal(getAlignmentPoolCoordinator().activeOnHost("wsl"), 0, "the host is free again");
});

test("a top-k run fetches one edition, the next only after a failed narration check, with no lease held while downloading (#718, MEDIUM-1)", async () => {
  const { workId } = seedWork();
  db.update(schema.works).set({ title: "Probe Book", author: "Ada Author" }).where(eq(schema.works.id, workId)).run();
  handler = ctcWorker({ Right: "forward", Wrong: "none", Spare: "forward" });
  const heldWhileDownloading: number[] = [];
  const saved: string[] = [];
  const names = ["Wrong", "Right", "Spare"];
  setEbookSetDeps({
    search: async () => ({
      website: "https://example.test",
      files: names.map((name, i) => ({
        md5: `${i}`.repeat(32), source: "libgen" as const, title: `Probe Book ${name}`, authors: ["Ada Author"],
        extension: "epub", language: "English", size: "1 MB", year: "2020", coverUrl: null, url: `https://example.test/${i}`,
      })),
    }),
    save: async (file) => {
      heldWhileDownloading.push(getAlignmentPoolCoordinator().activeOnHost("wsl"));
      const name = file.title.split(" ").at(-1)!;
      saved.push(name);
      const id = `${file.source}-${file.md5}`;
      await seedEpub(workId, name, "en", id);
      return { id, alreadySaved: false };
    },
  });
  const result = await fetchTopKIntoEbookSet(workId);
  assert.deepEqual(result.downloaded.map((d) => d.status), ["rejected", "accepted"]);
  assert.deepEqual(saved, ["Wrong", "Right"], "the edition after the accepted one is never fetched");
  assert.ok(heldWhileDownloading.every((n) => n === 0), "no lease is held while candidates download");
  assert.equal(probeUploads().length, 2, "each check stages the recording; the lease is released before the next download");
  assert.equal(commands.filter((c) => c.command.startsWith("rm -rf")).length, 2);
  assert.equal(getAlignmentPoolCoordinator().activeOnHost("wsl"), 0);
});

test("consensus sync waits until the shared probe session releases (HIGH-1)", async () => {
  const { workId } = seedWork();
  const ids = [await seedEpub(workId, "Right"), await seedEpub(workId, "Other")];
  for (const ebookId of ids) {
    db.insert(schema.workEbookSetMembers)
      .values({
        workId,
        ebookId,
        status: "held",
        holdReason: "awaiting_audio",
        evidence: JSON.stringify({
          outlier: {
            passed: false,
            reason: "no_spoken_samples",
            spokenSampleCount: 0,
            matchedSampleCount: 0,
            anchorCount: 0,
            forwardOrder: true,
            samples: [],
          },
        }),
        updatedAt: Date.now(),
      })
      .run();
  }
  const consensusId = `${CONSENSUS_EBOOK_PREFIX}${workId}`;
  let syncDuringProbe = false;
  handler = (path, body, host) => {
    if (path === "/anchor" && listAlignmentJobs().some((job) => job.ebookId === consensusId)) {
      syncDuringProbe = true;
    }
    return ctcWorker({ Right: "forward", Other: "forward" })(path, body, host);
  };
  const results = await reevaluateEbookSetForWork(workId);
  assert.deepEqual(results.map((r) => r.status), ["accepted", "accepted"]);
  assert.equal(syncDuringProbe, false, "no consensus job while the probe lease is held");
  assert.ok(
    listAlignmentJobs().some((job) => job.ebookId === consensusId),
    "consensus sync runs once after the session releases",
  );
  assert.equal(getAlignmentPoolCoordinator().activeOnHost("wsl"), 0);
});

test("a score failure on one candidate does not latch the rest of the session (MEDIUM-3)", async () => {
  const { workId } = seedWork();
  const bad = await seedEpub(workId, "Broken");
  const good = await seedEpub(workId, "Right");
  for (const ebookId of [bad, good]) {
    db.insert(schema.workEbookSetMembers)
      .values({
        workId,
        ebookId,
        status: "held",
        holdReason: "awaiting_audio",
        evidence: JSON.stringify({
          outlier: {
            passed: false,
            reason: "no_spoken_samples",
            spokenSampleCount: 0,
            matchedSampleCount: 0,
            anchorCount: 0,
            forwardOrder: true,
            samples: [],
          },
        }),
        updatedAt: Date.now(),
      })
      .run();
  }
  // Broken fails on every host; Right must still be scored in the same session.
  handler = (path, body, host) => {
    if (String(body.fragments?.[1] ?? "").startsWith("Broken")) return new Response("{}", { status: 500 });
    return ctcWorker({ Right: "forward" })(path, body, host);
  };
  await reevaluateEbookSetForWork(workId);
  const members = Object.fromEntries(listEbookSetMembers(workId).map((m) => [m.ebookId, m]));
  assert.equal(members[bad].status, "held");
  assert.equal(members[bad].holdReason, "awaiting_worker");
  assert.equal(members[good].status, "accepted");
  assert.ok(probes().some((r) => String(r.body.fragments?.[1] ?? "").startsWith("Right")));
});

test("dispatch triedHosts are seeded so a broken first host is not retried (MEDIUM-3)", async () => {
  const { workId } = seedWork();
  const broken = await seedEpub(workId, "Broken");
  const right = await seedEpub(workId, "Right");
  for (const ebookId of [broken, right]) {
    db.insert(schema.workEbookSetMembers)
      .values({
        workId,
        ebookId,
        status: "held",
        holdReason: "awaiting_audio",
        evidence: JSON.stringify({
          outlier: {
            passed: false,
            reason: "no_spoken_samples",
            spokenSampleCount: 0,
            matchedSampleCount: 0,
            anchorCount: 0,
            forwardOrder: true,
            samples: [],
          },
        }),
        updatedAt: Date.now(),
      })
      .run();
  }
  // Start with wsl down so the session leases lisa (triedHosts includes wsl). After lisa
  // fails, bring wsl back: without seeding triedHosts from the lease, the retry would hit wsl.
  health.down = ["wsl"];
  let lisaCalls = 0;
  handler = (path, body, host) => {
    if (host === "lisa" && String(body.fragments?.[1] ?? "").startsWith("Broken")) {
      lisaCalls++;
      health.down = [];
      return new Response("{}", { status: 500 });
    }
    return ctcWorker({ Right: "forward", Broken: "forward" })(path, body, host);
  };
  await reevaluateEbookSetForWork(workId);
  const members = Object.fromEntries(listEbookSetMembers(workId).map((m) => [m.ebookId, m]));
  assert.equal(members[broken].status, "held");
  assert.ok(lisaCalls > 0);
  assert.ok(
    !probes().some((r) => r.host === "wsl" && String(r.body.fragments?.[1] ?? "").startsWith("Broken")),
    "unreachable wsl is not retried after lisa fails",
  );
  // A failed failover acquire must not latch unavailable for the rest of the session.
  assert.equal(members[right].status, "accepted");
  assert.ok(probes().some((r) => String(r.body.fragments?.[1] ?? "").startsWith("Right")));
});

test("consensus sync still runs once when reevaluate throws mid-batch (MEDIUM-2)", async () => {
  const { workId } = seedWork();
  // Deterministic ids so Right is evaluated before Boom (no ORDER BY on members).
  const right = await seedEpub(workId, "Right", "en", "ebook-1-right");
  const boom = await seedEpub(workId, "Boom", "en", "ebook-2-boom");
  for (const ebookId of [right, boom]) {
    db.insert(schema.workEbookSetMembers)
      .values({
        workId,
        ebookId,
        status: "held",
        holdReason: "awaiting_audio",
        evidence: JSON.stringify({
          outlier: {
            passed: false,
            reason: "no_spoken_samples",
            spokenSampleCount: 0,
            matchedSampleCount: 0,
            anchorCount: 0,
            forwardOrder: true,
            samples: [],
          },
        }),
        updatedAt: Date.now(),
      })
      .run();
  }
  const consensusId = `${CONSENSUS_EBOOK_PREFIX}${workId}`;
  handler = (path, body, host) => {
    // Corrupt Boom's EPUB during its own probe so runOutlierCheck can finish, then buildEvidence throws
    // (Right's earlier buildEvidence still sees a valid Boom file).
    if (path === "/anchor" && String(body.fragments?.[1] ?? "").startsWith("Boom")) {
      const row = db.select().from(schema.ebookEditions).where(eq(schema.ebookEditions.id, boom)).get();
      if (row) writeFileSync(row.source, "not-an-epub");
    }
    return ctcWorker({ Right: "forward", Boom: "forward" })(path, body, host);
  };
  await assert.rejects(() => reevaluateEbookSetForWork(workId));
  assert.equal(listEbookSetMembers(workId).find((m) => m.ebookId === right)?.status, "accepted");
  assert.ok(
    listAlignmentJobs().some((job) => job.ebookId === consensusId),
    "consensus sync runs in finally after the mid-batch throw",
  );
});

test("uppercase and undetermined EPUB languages still probe as English (LOW-2)", async () => {
  assert.equal(iso3("ENG"), "eng");
  assert.equal(iso3("und"), "eng");
  assert.equal(iso3("unknown"), "eng");
  const { workId } = seedWork();
  handler = ctcWorker({ Right: "forward" });
  for (const language of ["ENG", "und"]) {
    const ebook = await seedEpub(workId, "Right", language);
    const result = await evaluateEbookSetMember(workId, ebook);
    assert.equal(result.status, "accepted", language);
    assert.equal(listEbookSetMembers(workId).find((m) => m.ebookId === ebook)?.holdReason, null);
  }
});

test("lisa takes the probe when WSL is unreachable", async () => {
  const { workId } = seedWork();
  const ebook = await seedEpub(workId, "Right");
  health.down = ["wsl"];
  handler = ctcWorker({ Right: "forward" });
  const result = await evaluateEbookSetMember(workId, ebook);
  assert.equal(result.status, "accepted");
  assert.ok(probes().length > 0 && probes().every((r) => r.host === "lisa"));
  assert.ok(probeUploads().length > 0 && probeUploads().every((u) => u.target === "lisa"));
});

test("a failed probe on WSL retries once on lisa, then the candidate stays held", async () => {
  const { workId } = seedWork();
  const ebook = await seedEpub(workId, "Right");
  handler = (path, body, host) => (host === "wsl" ? new Response("{}", { status: 500 }) : ctcWorker({ Right: "forward" })(path, body, host));
  const result = await evaluateEbookSetMember(workId, ebook);
  assert.equal(result.status, "accepted");
  assert.deepEqual([...new Set(probes().map((r) => r.host))], ["wsl", "lisa"]);

  const second = await seedEpub(workId, "Right");
  requests = [];
  handler = () => new Response("{}", { status: 500 });
  const held = await evaluateEbookSetMember(workId, second);
  assert.equal(held.status, "held");
  assert.deepEqual([...new Set(probes().map((r) => r.host))], ["wsl", "lisa"]);
  assert.equal(listEbookSetMembers(workId).find((m) => m.ebookId === second)?.holdReason, "awaiting_worker");
  assert.equal(getAlignmentPoolCoordinator().activeOnHost("lisa"), 0);
  assert.equal(getAlignmentPoolCoordinator().activeOnHost("wsl"), 0);
});

test("busy hosts hold the candidate after the wait and the pool is left free", async () => {
  const { workId } = seedWork();
  const ebook = await seedEpub(workId, "Right");
  health.busy = ["wsl", "lisa"];
  let sleeps = 0;
  setEbookSetDeps({
    probeWaitMs: 0,
    probeSleep: async () => {
      sleeps++;
    },
  });
  const result = await evaluateEbookSetMember(workId, ebook);
  assert.equal(result.status, "held");
  assert.equal(listEbookSetMembers(workId)[0].holdReason, "awaiting_worker");
  assert.equal(probes().length, 0);
  assert.equal(probeUploads().length, 0);
  assert.equal(sleeps, 0);
});

test("when the pool stays busy only the first candidate of a run waits; the others are held at once", async () => {
  const { workId } = seedWork();
  const ids = [await seedEpub(workId, "Right"), await seedEpub(workId, "Other")];
  for (const ebookId of ids)
    db.insert(schema.workEbookSetMembers)
      .values({ workId, ebookId, status: "held", holdReason: "awaiting_audio", evidence: JSON.stringify({ outlier: { passed: false, reason: "no_spoken_samples", spokenSampleCount: 0, matchedSampleCount: 0, anchorCount: 0, forwardOrder: true, samples: [] } }), updatedAt: Date.now() })
      .run();
  health.busy = ["wsl", "lisa"];
  let sleeps = 0;
  let clock = Date.now();
  const realNow = Date.now;
  Date.now = () => clock;
  setEbookSetDeps({ probeWaitMs: 20_000, probeSleep: async (ms) => { sleeps++; clock += ms; } });
  try {
    const results = await reevaluateEbookSetForWork(workId);
    assert.deepEqual(results.map((r) => r.status), ["held", "held"]);
    assert.equal(sleeps, 4, "20 s in 5 s steps, once for the whole run");
  } finally {
    Date.now = realNow;
  }
});

test("a probe waits for a busy host and then runs on it", async () => {
  const { workId } = seedWork();
  const ebook = await seedEpub(workId, "Right");
  health.busy = ["wsl", "lisa"];
  handler = ctcWorker({ Right: "forward" });
  setEbookSetDeps({
    probeWaitMs: 60_000,
    probeSleep: async () => {
      health.busy = [];
    },
  });
  const result = await evaluateEbookSetMember(workId, ebook);
  assert.equal(result.status, "accepted");
});

test("with the pool disabled the candidate is held and the production worker is never used", async () => {
  process.env.ALIGNMENT_POOL_ENABLED = "0";
  const { workId } = seedWork();
  const ebook = await seedEpub(workId, "Right");
  const result = await evaluateEbookSetMember(workId, ebook);
  assert.equal(result.status, "held");
  assert.equal(listEbookSetMembers(workId)[0].holdReason, "awaiting_worker");
  assert.equal(probes().length, 0);
});

test("a book in another language is held as not supported, without a worker request", async () => {
  const { workId } = seedWork();
  const ebook = await seedEpub(workId, "Right", "de");
  handler = ctcWorker({ Right: "forward" });
  const result = await evaluateEbookSetMember(workId, ebook);
  assert.equal(result.status, "held");
  assert.equal(listEbookSetMembers(workId)[0].holdReason, "language_not_supported");
  assert.equal(probes().length, 0);
  assert.equal(probeUploads().length, 0);
});

test("the Activity pause switch holds new probes", async () => {
  const { workId } = seedWork();
  const ebook = await seedEpub(workId, "Right");
  handler = ctcWorker({ Right: "forward" });
  setPaused("alignment", true);
  try {
    const result = await evaluateEbookSetMember(workId, ebook);
    assert.equal(result.status, "held");
    assert.equal(probes().length, 0);
  } finally {
    setPaused("alignment", false);
  }
});

test("a connection the worker closed between samples is retried, not counted as a failed probe", async () => {
  const { workId } = seedWork();
  const ebook = await seedEpub(workId, "Right");
  const answer = ctcWorker({ Right: "forward" });
  const real = globalThis.fetch;
  let dropped = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/anchor") && dropped < 2 && String(init?.body).includes('"start":300')) {
      dropped++;
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    }
    return real(input, init);
  };
  handler = answer;
  try {
    const result = await evaluateEbookSetMember(workId, ebook);
    assert.equal(result.status, "accepted");
    assert.equal(dropped, 2, "two retries, then the request got through");
  } finally {
    globalThis.fetch = real;
  }
});

test("a worker that is not the CTC engine is a failed probe, not a score", async () => {
  const { workId } = seedWork();
  const ebook = await seedEpub(workId, "Right");
  handler = () => Response.json({ engine: "aeneas-1.7.3", outcome: "mapped", match: null });
  const result = await evaluateEbookSetMember(workId, ebook);
  assert.equal(result.status, "held");
  assert.equal(listEbookSetMembers(workId)[0].holdReason, "awaiting_worker");
});

test("sampleFromCtcAnchor ignores matches outside the sample and rejects other engines", () => {
  const window = { time: 600, duration: 30 };
  const found = { engine: CTC_ENGINE, outcome: "mapped" as const, text: "a b c", match: { index: 3, score: 0.7 }, start: 610 };
  assert.deepEqual(sampleFromCtcAnchor(found, window, 1, 10), { spokenWords: 3, match: { fragment: 3, score: 0.7, start: 610 } });
  assert.equal(sampleFromCtcAnchor({ ...found, start: 700 }, window, 1, 10).match, null);
  assert.equal(sampleFromCtcAnchor({ ...found, match: { index: 12, score: 0.9 } }, window, 1, 10).match, null);
  assert.throws(() => sampleFromCtcAnchor({ ...found, engine: "aeneas" }, window, 1, 10), /requested CTC engine/);
  assert.throws(() => sampleFromCtcAnchor({ ...found, outcome: "language_not_supported" }, window, 1, 10), /English/);
  assert.equal(sampleFromCtcAnchor({ ...found, match: { index: 3, score: 0.7 } }, window, 4, 10).match?.fragment, 12);
});

test("sampleFromCtcAnchor keeps lastFragment and alternate matches for selectAnchors (LOW-1)", () => {
  const window = { time: 600, duration: 30 };
  const found = {
    engine: CTC_ENGINE,
    outcome: "mapped" as const,
    text: "a b c",
    match: { index: 3, lastIndex: 4, score: 0.7 },
    start: 610,
    matches: [
      { index: 3, lastIndex: 4, score: 0.7, start: 610 },
      { index: 20, lastIndex: 20, score: 0.65, start: 612 },
      { index: 1, lastIndex: 1, score: 0.9, start: 700 },
    ],
  };
  const sample = sampleFromCtcAnchor(found, window, 2, 30, 60);
  assert.equal(sample.match?.fragment, 6);
  assert.equal(sample.match?.lastFragment, 9);
  assert.deepEqual(
    sample.matches?.map((m) => [m.fragment, m.lastFragment, m.start]),
    [
      [6, 9, 610],
      [40, 41, 612],
    ],
  );
});

test("very long books are sent as groups of paragraphs and mapped back to paragraph numbers", () => {
  const texts = Array.from({ length: 45000 }, (_, i) => `p${i}`);
  const { group, blocks } = groupFragments(texts);
  assert.equal(group, 3);
  assert.equal(blocks.length, 15000);
  assert.equal(blocks[1], "p3 p4 p5");
});
