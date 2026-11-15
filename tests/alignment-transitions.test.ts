// Alignment job transitions (ADR 0012, #393): which status each named transition may move a job from, and to which.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIGNMENT_STATUSES, type AlignmentStatus } from "../src/reading-types.ts";
import {
  ALIGNMENT_TRANSITIONS,
  AlignmentTransitionRefused,
  NO_JOB,
  assertTransition,
  transitionAllowed,
  type AlignmentTransition,
  type AlignmentTransitionFrom,
} from "../server/alignment-transitions.ts";

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
