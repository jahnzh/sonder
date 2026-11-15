import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlignmentJob } from "../src/reading-types.ts";

// servedDuringRebuild is imported to pin the card's merge to the listing's shape; its module chain opens the DB.
const temp = mkdtempSync(join(tmpdir(), "sonder-reading-sync-action-"));
process.env.DATA_DIR = join(temp, "data");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
const { JOB_NOT_LISTED, runJobAction, shownAfterAction } = await import("../src/reading-sync-controls.ts");
const { servedDuringRebuild } = await import("../server/alignment-rebuild.ts");
after(() => rmSync(temp, { recursive: true, force: true }));

const job = (patch: Partial<AlignmentJob> = {}): AlignmentJob =>
  ({
    id: "job-324",
    ebookId: "ebook-324",
    recordingId: "recording-324",
    status: "error",
    progress: 0.4,
    engine: "ctc-test",
    error: "Remote alignment failed on all pool hosts. Resume to retry.",
    coverage: 0,
    intervals: [],
    pairings: [],
    sectionsDone: [],
    updatedAt: 1,
    ...patch,
  }) as unknown as AlignmentJob;

/** Records what the card was told, in order. */
function card(send: (id: string, action: string) => Promise<AlignmentJob>, refresh: () => Promise<unknown> = async () => {}) {
  const calls: string[] = [];
  const shown: AlignmentJob[] = [];
  let busy = false, error = "";
  return {
    calls,
    shown,
    get busy() { return busy; },
    get error() { return error; },
    deps: {
      send: (id: string, action: string) => { calls.push(`send ${id} ${action}`); return send(id, action); },
      show: (answer: AlignmentJob) => { calls.push(`show ${answer.status}`); shown.push(answer); },
      refresh: () => { calls.push("refresh"); return refresh(); },
      busy: (value: boolean) => { calls.push(`busy ${value}`); busy = value; },
      error: (message: string) => { if (message) calls.push(`error ${message}`); error = message; },
    },
  };
}

test("Resume / retry with no job to act on tells the user instead of returning silently (#324)", async () => {
  const c = card(async () => { throw new Error("must not be sent"); });
  await runJobAction(undefined, "resume", c.deps);
  assert.equal(c.error, JOB_NOT_LISTED);
  assert.ok(!c.calls.some((call) => call.startsWith("send")), "nothing is sent for a job the card cannot name");
  assert.equal(c.busy, false);
});

test("Resume / retry sends the PATCH action for the shown job and shows the server's answer before refreshing (#324)", async () => {
  const c = card(async () => job({ status: "queued", error: null }));
  await runJobAction(job(), "resume", c.deps);
  assert.deepEqual(c.calls, ["busy true", "send job-324 resume", "busy false", "show queued", "refresh"]);
  assert.equal(c.error, "");
});

test("A rejected Resume / retry shows the server's error and frees the buttons (#324)", async () => {
  const c = card(async () => { throw new Error("This reading-sync job could not be found."); });
  await runJobAction(job(), "resume", c.deps);
  assert.equal(c.error, "This reading-sync job could not be found.");
  assert.equal(c.busy, false);
  assert.deepEqual(c.shown, [], "the card keeps the job as listed");
  assert.ok(!c.calls.includes("refresh"));
});

test("A listing refresh that never answers does not keep the card busy after the PATCH answered (#324)", async () => {
  const c = card(async () => job({ status: "queued", error: null }), () => new Promise(() => {}));
  const run = runJobAction(job(), "resume", c.deps);
  // The refresh hangs, so the action never settles; the card is already free and shows the answer.
  await new Promise((resolve) => setImmediate(resolve));
  void run;
  assert.equal(c.busy, false);
  assert.deepEqual(c.shown.map((shown) => shown.status), ["queued"]);
});

test("The card shows a resumed job as the server's answer, and a resumed rebuild under the kept map as the listing does (#324)", () => {
  const answer = job({ status: "queued", error: null, progress: 0, updatedAt: 5 });
  assert.equal(shownAfterAction(job(), answer), answer, "a job without a kept map is shown as answered");
  const kept = job({ status: "ready", error: null, progress: 1, coverage: 0.9, updatedAt: 2 });
  const failedRebuild = servedDuringRebuild(kept, job({ status: "error", outcome: "rejected", error: "The rebuild was rejected." }));
  assert.deepEqual(shownAfterAction(failedRebuild, answer), servedDuringRebuild(kept, answer));
  assert.equal(shownAfterAction(failedRebuild, answer).rebuild?.outcome, undefined, "a retried rejection no longer shows its reason");
});
