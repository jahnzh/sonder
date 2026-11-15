// Alignment job transitions (ADR 0012, #393): which status each named transition may move a job from, and to which.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALIGNMENT_STATUSES, type AlignmentJob, type AlignmentStatus } from "../src/reading-types.ts";

// The module opens the database on import: everything it touches lives in a temporary directory.
const temp = mkdtempSync(join(tmpdir(), "sonder-transitions-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
after(() => rmSync(temp, { recursive: true, force: true }));

const transitions = await import("../server/alignment-transitions.ts");
const { ALIGNMENT_TRANSITIONS, AlignmentTransitionRefused, NO_JOB, assertTransition, transitionAllowed } = transitions;
type AlignmentTransition = import("../server/alignment-transitions.ts").AlignmentTransition;
type AlignmentTransitionFrom = import("../server/alignment-transitions.ts").AlignmentTransitionFrom;
const { sqlite } = await import("../server/db.ts");

const all = ALIGNMENT_STATUSES;
const active = ["queued", "copying", "processing"] as const;
const froms: AlignmentTransitionFrom[] = [NO_JOB, ...all];

/**
 * The transitions the server makes today, written out by hand from its writers (#393). Each line is
 * "from -> to"; every other (transition, from, to) triple must be refused.
 */
const ALLOWED: Record<AlignmentTransition, string[]> = {
  // createAlignment: a first prepare, or one that replaces any existing row (an active one is cancelled first).
  queue: froms.flatMap((from) => [`${from} -> queued`, `${from} -> copying`]),
  // runAlignmentJobSteps: a claimed job, also one a restarted server finds processing.
  start: active.map((from) => `${from} -> processing`),
  // Section, sample and pool-staging writes of a running job; a pause keeps work finished after it.
  progress: ["processing -> processing", "paused -> paused"],
  // The pool was busy after the job started.
  requeue: ["processing -> queued"],
  // processAnchored and the chapter loop publish "partial"; "ready" is kept for older maps.
  publish: ["processing -> ready", "processing -> partial"],
  // Download, EPUB or audio changed before the start; worker outcomes, pool failures and thrown errors after it.
  fail: active.map((from) => `${from} -> error`),
  // PATCH /api/alignments/:id takes every action from every status.
  pause: all.map((from) => `${from} -> paused`),
  resume: all.map((from) => `${from} -> queued`),
  cancel: all.map((from) => `${from} -> cancelled`),
  // queueEngineRebuilds and the retired-engine replan: a paused job stays paused, all others are queued.
  queueRebuild: all.map((from) => `${from} -> ${from === "paused" ? "paused" : "queued"}`),
  // PATCH resume of a rejected rebuild (status "error", outcome "rejected").
  retryRejectedRebuild: ["error -> queued"],
  // showRejectedConsensus: every member projection that serves a map shows the rejection.
  rejectRebuild: all.map((from) => `${from} -> error`),
  // publishProjectedMaps: the projection takes the consensus job's status; the #379 rule may reject it.
  project: froms.flatMap((from) => [`${from} -> ready`, `${from} -> partial`, `${from} -> error`]),
  // POST /api/alignments/:id/anchors on a finished map.
  correct: ["ready -> ready", "partial -> partial"],
  // registerAlignment's audio fingerprint upgrade rewrites any job in place.
  upgradeAudioFingerprint: all.map((from) => `${from} -> ${from}`),
};

test("the transition table allows exactly the transitions the server makes and refuses every other pair", () => {
  assert.deepEqual(Object.keys(ALIGNMENT_TRANSITIONS).sort(), Object.keys(ALLOWED).sort());
  let checked = 0;
  for (const transition of Object.keys(ALLOWED) as AlignmentTransition[]) {
    const allowed = new Set(ALLOWED[transition]);
    for (const from of froms)
      for (const to of all) {
        const pair = `${from} -> ${to}`;
        checked++;
        assert.equal(transitionAllowed(transition, from, to), allowed.has(pair), `${transition}: ${pair}`);
        if (allowed.has(pair)) assert.doesNotThrow(() => assertTransition(transition, from, to));
        else
          assert.throws(
            () => assertTransition(transition, from, to),
            (error: unknown) =>
              error instanceof AlignmentTransitionRefused &&
              error.transition === transition && error.from === from && error.to === to,
            `${transition}: ${pair} must be refused`,
          );
      }
  }
  assert.equal(checked, Object.keys(ALLOWED).length * froms.length * all.length);
});

test("a job that does not exist yet can only be queued or projected", () => {
  const fromNothing = (Object.keys(ALLOWED) as AlignmentTransition[]).filter((transition) =>
    all.some((to: AlignmentStatus) => transitionAllowed(transition, NO_JOB, to)),
  );
  assert.deepEqual(fromNothing.sort(), ["project", "queue"]);
});

test("the status predicates are defined once in reading-types and answer for every status", async () => {
  const { alignmentJobActive, alignmentJobInFlight, alignmentJobResumable, alignmentMapUsable, alignmentMapPublishes } =
    await import("../src/reading-types.ts");
  const where = (predicate: (status: AlignmentStatus) => boolean) => all.filter(predicate);
  assert.deepEqual(where(alignmentJobActive), ["queued", "copying", "processing"]);
  assert.deepEqual(where(alignmentJobInFlight), ["queued", "copying", "processing", "paused"]);
  assert.deepEqual(where(alignmentJobResumable), ["paused", "cancelled", "error"]);
  assert.deepEqual(where((status) => alignmentMapUsable({ status })), ["ready", "partial"]);
  assert.deepEqual(where((status) => alignmentMapPublishes({ status })), ["ready", "partial"]);
  assert.deepEqual(where((status) => alignmentMapPublishes({ status, outcome: "language_not_supported" })), ["ready", "partial", "error"]);
  for (const missing of [undefined, null, "", "pending"]) {
    assert.equal(alignmentJobActive(missing), false);
    assert.equal(alignmentJobInFlight(missing), false);
  }
  // The activity source maps each status to its own vocabulary; it must agree on which ones are active.
  const { ALIGNMENT_ACTIVITY_STATES } = await import("../server/alignment-activity.ts");
  assert.deepEqual(where((status) => ["queued", "running"].includes(ALIGNMENT_ACTIVITY_STATES[status])), where(alignmentJobActive));
});

// The same table, through the module's writes on a stored row: every refused pair throws and leaves the row as it was.
sqlite.exec(`
  INSERT INTO works(id,title,author,description,genre,year) VALUES('work-1','Book','Author','','',2020);
  INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('edition-1','work-1','','',0,'');
  INSERT INTO recordings(id,edition_id) VALUES('rec-1','edition-1'),('rec-2','edition-1');
  INSERT INTO ebook_editions(id,work_id,format,source) VALUES('ebook-1','work-1','epub','x'),('ebook-2','work-1','epub','x');
`);
let seeded = 0;
function jobAt(status: AlignmentStatus, overrides: Partial<AlignmentJob> = {}): AlignmentJob {
  return {
    id: `job-${++seeded}`, generation: `gen-${seeded}`, ebookId: "ebook-1", recordingId: "rec-1", status, progress: 0.5,
    engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-v2", error: null, warning: null,
    intervals: [{ paragraphId: "p1", section: 0, trackId: "t1", start: 0, end: 1, confidence: 0.65 }],
    sectionsDone: [0], elapsedSeconds: 1, fingerprint: "ebook-fp", audioFingerprint: "audio-v2:fp",
    createdAt: 1, updatedAt: 1, coverage: 0.5, pairings: [], ...overrides,
  };
}
const stored = (id: string) =>
  sqlite.prepare("SELECT data, published_map, projected_from FROM alignment_jobs WHERE id=?").get(id) as
    | { data: string; published_map: string | null; projected_from: string | null }
    | undefined;
const sentences = new Set(["p1"]);
/** Calls `transition` on a job stored with `from` (or on a job that was never stored). */
const calls: Record<AlignmentTransition, (job: AlignmentJob) => unknown> = {
  queue: (job) => transitions.queue({ ...job, generation: "next" }, { copying: false }),
  start: (job) => transitions.start(job),
  progress: (job) => transitions.progress(job),
  requeue: (job) => transitions.requeue(job),
  publish: (job) => transitions.publish(job, "partial"),
  fail: (job) => transitions.fail(job, "Failed."),
  pause: (job) => transitions.pause(job),
  resume: (job) => transitions.resume(job),
  cancel: (job) => transitions.cancel(job),
  queueRebuild: (job) => transitions.queueRebuild(job, { ...job, generation: "rebuild", intervals: [] }),
  retryRejectedRebuild: (job) => transitions.retryRejectedRebuild(job, { ...job, generation: "retry", intervals: [] }),
  rejectRebuild: (job) => transitions.rejectRebuild(job, jobAt("error", { id: "consensus", outcome: "rejected", error: "Rejected." })),
  project: (job) => transitions.project(jobAt("partial", { id: "consensus" }),
    { id: job.id, ebookId: job.ebookId, fingerprint: job.fingerprint, intervals: job.intervals, sectionsDone: [0], coverage: 1 }, sentences),
  correct: (job) => transitions.correct(job),
  upgradeAudioFingerprint: (job) => transitions.upgradeAudioFingerprint(job, "audio-v2:upgraded"),
};
/** The status each call above writes from `from` by the hand-written table, or null when it must be refused. */
function expected(transition: AlignmentTransition, from: AlignmentTransitionFrom): AlignmentStatus | null {
  const to = ALLOWED[transition].filter((pair) => pair.startsWith(`${from} -> `)).map((pair) => pair.split(" -> ")[1] as AlignmentStatus);
  if (!to.length) return null;
  const choice = transition === "queue" ? "queued" : transition === "publish" || transition === "project" ? "partial" : to[0];
  assert.ok(to.includes(choice));
  return choice;
}

test("each transition writes only from the statuses the table allows and refuses every other stored status", () => {
  let writes = 0, refusals = 0;
  for (const transition of Object.keys(calls) as AlignmentTransition[])
    for (const from of froms) {
      // queueRebuild and retryRejectedRebuild compare against the row they read; with no row they write nothing.
      if (from === NO_JOB && (transition === "queueRebuild" || transition === "retryRejectedRebuild")) continue;
      sqlite.prepare("DELETE FROM alignment_jobs").run();
      const job = jobAt(from === NO_JOB ? "queued" : from, transition === "retryRejectedRebuild" ? { outcome: "rejected" } : {});
      if (from !== NO_JOB) transitions.putAlignmentJob(job);
      const before = stored(job.id);
      const to = expected(transition, from);
      const label = `${transition} from ${from}`;
      if (to) {
        calls[transition]({ ...job });
        assert.equal(transitions.alignmentJob(job.id).status, to, label);
        writes++;
      } else {
        assert.throws(() => calls[transition]({ ...job }), AlignmentTransitionRefused, `${label} must be refused`);
        assert.deepEqual(stored(job.id), before, `${label} must leave the row unchanged`);
        refusals++;
      }
    }
  // Every transition was exercised both ways where the table allows both.
  assert.ok(writes > 50 && refusals > 30, `writes=${writes} refusals=${refusals}`);
});

test("a projection records the consensus job it was projected from", () => {
  sqlite.prepare("DELETE FROM alignment_jobs").run();
  const consensus = jobAt("ready", { id: "consensus-job" });
  transitions.project(consensus, { id: "projected-1", ebookId: "ebook-2", fingerprint: "ebook-fp", intervals: consensus.intervals,
    sectionsDone: [0], coverage: 1 }, sentences);
  assert.equal(stored("projected-1")?.projected_from, "consensus-job");
  const projected = transitions.alignmentJob("projected-1");
  assert.equal(projected.status, "ready");
  assert.equal(projected.origin, "projected");
  // The wire shape of a job is unchanged: the link lives in its own column.
  assert.equal("projectedFrom" in projected, false);
});

test("removing a recording's jobs leaves none of them and keeps other recordings' jobs", () => {
  sqlite.prepare("DELETE FROM alignment_jobs").run();
  transitions.putAlignmentJob(jobAt("ready", { id: "kept", recordingId: "rec-2" }));
  transitions.putAlignmentJob(jobAt("processing", { id: "gone-1" }));
  transitions.putAlignmentJob(jobAt("paused", { id: "gone-2", ebookId: "ebook-2" }));
  transitions.removeAlignmentJobsForRecording("rec-1");
  const left = (sqlite.prepare("SELECT id FROM alignment_jobs ORDER BY id").all() as { id: string }[]).map((row) => row.id);
  assert.deepEqual(left, ["kept"]);
});
