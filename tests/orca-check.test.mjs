import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAllJsonValues,
  parseOrcaCheckOutput,
  formatCheckLines,
  formatMessageLine,
  parseCliArgs,
  parseFindingsLine,
  runOrcaCheck,
  main,
  autoRecordReviewWorkerDone,
  defaultRecordReview,
  resolveReviewedDispatch,
} from "../scripts/orca-check.mjs";
import { openStore } from "../scripts/orca-history.mjs";

// Copied from a real `orca orchestration check --terminal <handle> --json` on an empty queue.
const emptyResultEnvelope = {
  id: "c215f7fa-e4b1-4827-92a2-0fd4a02ee6ba",
  ok: true,
  result: {
    runId: "run_61b9802dae51",
    dispatchId: "ctx_4a3bf35d1371",
    deliveryId: null,
    messages: [],
    count: 0,
    replayed: false,
    acknowledged: null,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    mutation: { requestId: "c3f3df17-48c0-478e-961c-501436bfda5d", replayed: false },
  },
  _meta: { runtimeId: "22eeea5e-ba22-4ef8-bca5-bcaa34e2199e" },
};

// The same envelope with a delivery in it. Message fields follow the shape this script already read
// (id, type, subject, sender, body, payload); only the delivery is built by hand.
function deliveryEnvelope(deliveryId, messages) {
  return {
    ...emptyResultEnvelope,
    result: { ...emptyResultEnvelope.result, deliveryId, messages, count: messages.length },
  };
}

const heartbeat = (id) => ({
  id,
  type: "heartbeat",
  subject: "alive",
  sender: "term_worker",
  body: "phase=implementing",
  payload: { taskId: "task_1", dispatchId: "ctx_1", phase: "implementing" },
});
const workerDone = (id, dispatchId = "ctx_done1") => ({
  id,
  type: "worker_done",
  subject: "succeeded",
  sender: "term_worker",
  body: "Done.",
  payload: { outcome: "succeeded", taskId: "task_1", dispatchId },
});

// Runs runOrcaCheck with a scripted queue of orca replies; returns the printed text and the argv of every call.
// A reply of "timeout" is Orca's own wait timing out: the empty queue with timedOut true.
function runScripted(options, replies, clock = { t: 0 }, extraHooks = {}) {
  const calls = [];
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (line) => logs.push(line);
  console.error = (line) => errors.push(String(line));
  let outcome;
  try {
    outcome = runOrcaCheck(options, {
      now: () => clock.t,
      runOrca: (args) => {
        calls.push(args);
        const next = replies.shift();
        assert.ok(next, "orca was called more often than the test scripted");
        const envelope =
          next === "timeout"
            ? { ...emptyResultEnvelope, result: { ...emptyResultEnvelope.result, timedOut: true } }
            : next;
        if (typeof clock.advance === "number") clock.t += clock.advance;
        return { status: 0, stdout: JSON.stringify(envelope), stderr: '{"_keepalive":true}\n' };
      },
      // Tests that do not care about history get a no-op; capture tests override this.
      captureHistory: () => {},
      ...extraHooks,
    });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(replies.length, 0, "scripted replies left over");
  return { outcome, logs, calls, errors };
}

const multiMessageEnvelope = {
  id: "batch-1",
  ok: true,
  result: {
    runId: "run_561373069493",
    deliveryId: "del_abc123",
    messages: [
      {
        id: "msg_heartbeat_1",
        type: "heartbeat",
        subject: "alive",
        sender: "term_153da411-8466-4a5a-bc53-b1d71cb157a5",
        body: "phase=implementing",
        payload: { taskId: "task_cda427e7c32f", dispatchId: "ctx_49536e0c743e" },
      },
      {
        id: "msg_worker_done_1",
        type: "worker_done",
        subject: "succeeded",
        sender: "term_worker_terminal_handle",
        body: "Finished the parser and tests. Nothing left for the coordinator.",
        payload: { outcome: "succeeded", taskId: "task_cda427e7c32f", dispatchId: "ctx_49536e0c743e" },
      },
    ],
    count: 2,
    timedOut: false,
  },
};

const errorEnvelope = {
  id: "aa75b02d-6acb-447f-a20c-365d3832007c",
  ok: false,
  error: {
    code: "stable_pane_required",
    message: "Terminal invalid_handle_xyz has no live pane.",
  },
};

test("parseAllJsonValues reads keepalive lines and a trailing result object", () => {
  const raw = `{"_keepalive":true,"elapsedMs":15000,"waitMs":90000}
{"_keepalive":true,"elapsedMs":30000,"waitMs":90000}
${JSON.stringify(emptyResultEnvelope)}`;
  const values = parseAllJsonValues(raw);
  assert.equal(values.length, 3);
  assert.equal(values[0]._keepalive, true);
  assert.equal(values[2].ok, true);
});

test("parseOrcaCheckOutput ignores keepalive and returns the result envelope", () => {
  const raw = `{"_keepalive":true}
${JSON.stringify(multiMessageEnvelope)}`;
  const parsed = parseOrcaCheckOutput(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.deliveryId, "del_abc123");
  assert.equal(parsed.result.count, 2);
});

test("parseOrcaCheckOutput handles an empty queue", () => {
  const parsed = parseOrcaCheckOutput(JSON.stringify(emptyResultEnvelope));
  assert.equal(parsed.ok, true);
  assert.deepEqual(formatCheckLines(parsed.result), [
    "count=0 delivery=null timedOut=false",
  ]);
});

test("formatCheckLines prints one line per message with truncation", () => {
  const longBody = "b".repeat(400);
  const longPayload = { note: "p".repeat(300) };
  const lines = formatCheckLines({
    deliveryId: "del_abc123",
    count: 1,
    timedOut: false,
    messages: [
      {
        id: "msg_1",
        type: "escalation",
        subject: "Blocked: usage",
        sender: "term_153da411-8466-4a5a-bc53-b1d71cb157a5",
        body: longBody,
        payload: longPayload,
      },
    ],
  });
  assert.equal(lines[0], "count=1 delivery=del_abc123 timedOut=false");
  const parts = lines[1].split(" | ");
  assert.equal(parts[3].length, 300);
  assert.equal(parts[4].length, 200);
  assert.match(lines[1], /^msg_1 escalation \| Blocked: usage \| term_153da411-8466-4a5a/);
});

test("parseOrcaCheckOutput surfaces Orca error objects", () => {
  const parsed = parseOrcaCheckOutput(JSON.stringify(errorEnvelope));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "stable_pane_required");
});

test("main returns exit code 2 on bad arguments", () => {
  assert.equal(main(["--wait", "200"]), 2);
});

test("parseCliArgs rejects unknown flags and overlong waits", () => {
  assert.equal(parseCliArgs(["--nope"]).ok, false);
  assert.equal(parseCliArgs(["--terminal", "term_x", "--wait", "101"]).ok, false);
  assert.equal(parseCliArgs(["--terminal", "term_x", "--wait", "0"]).ok, false);
});

test("parseCliArgs defaults --wait to 90 seconds", () => {
  const parsed = parseCliArgs(["--terminal", "term_x", "--wait"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.options.waitSeconds, 90);
});

test("a mixed delivery prints the other messages without the heartbeat and acks nothing", () => {
  const logs = [];
  const origLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    const outcome = runOrcaCheck(
      { terminal: "term_x" },
      {
        runOrca: () => ({
          status: 0,
          stdout: JSON.stringify(multiMessageEnvelope),
          stderr: '{"_keepalive":true}\n',
        }),
      },
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal(logs.length, 1);
    const outputLines = logs[0].split("\n");
    assert.equal(outputLines[0], "count=2 delivery=del_abc123 timedOut=false heartbeats=1");
    assert.equal(outputLines.length, 2);
    assert.match(outputLines[1], /^msg_worker_done_1 worker_done \| succeeded \| /);
  } finally {
    console.log = origLog;
  }
});

test("runOrcaCheck prints ack summary lines", () => {
  const logs = [];
  const origLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    const outcome = runOrcaCheck(
      { terminal: "term_x", ack: "del_old" },
      {
        runOrca: () => ({
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            result: { count: 0, deliveryId: null, messages: [], timedOut: false },
          }),
          stderr: "",
        }),
      },
    );
    assert.equal(outcome.ok, true);
    assert.deepEqual(logs, ["acked=del_old remaining=0"]);
  } finally {
    console.log = origLog;
  }
});

test("runOrcaCheck exits 1 on Orca errors", () => {
  const errors = [];
  const origError = console.error;
  console.error = (line) => errors.push(line);
  try {
    const outcome = runOrcaCheck(
      { terminal: "term_x" },
      {
        runOrca: () => ({
          status: 0,
          stdout: JSON.stringify(errorEnvelope),
          stderr: "",
        }),
      },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.deepEqual(errors, ["stable_pane_required: Terminal invalid_handle_xyz has no live pane."]);
  } finally {
    console.error = origError;
  }
});

test("runOrcaCheck forwards orchestration check flags", () => {
  /** @type {string[] | null} */
  let seen = null;
  const origLog = console.log;
  console.log = () => {};
  try {
    runOrcaCheck(
      {
        terminal: "term_x",
        run: "run_561373069493",
        types: "worker_done,escalation",
        waitSeconds: 45,
        ack: "del_prior",
      },
      {
        runOrca: (args) => {
          seen = args;
          return {
            status: 0,
            stdout: JSON.stringify(emptyResultEnvelope),
            stderr: "",
          };
        },
      },
    );
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(seen, [
    "orchestration",
    "check",
    "--json",
    "--terminal",
    "term_x",
    "--run",
    "run_561373069493",
    "--types",
    "worker_done,escalation",
    "--ack",
    "del_prior",
    "--wait",
    "--timeout-ms",
    "45000",
  ]);
});

test("formatMessageLine matches the coordinator-facing shape", () => {
  const line = formatMessageLine(multiMessageEnvelope.result.messages[1]);
  assert.equal(
    line,
    "msg_worker_done_1 worker_done | succeeded | term_worker_terminal_han | Finished the parser and tests. Nothing left for the coordinator. | {\"outcome\":\"succeeded\",\"taskId\":\"task_cda427e7c32f\",\"dispatchId\":\"ctx_49536e0c743e\"}",
  );
});

test("the coordinator can run without --terminal and the flag is not passed to orca", () => {
  const parsed = parseCliArgs(["--run", "run_1", "--wait"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.options.terminal, null);
  const seen = [];
  const origLog = console.log;
  console.log = () => {};
  try {
    runOrcaCheck(parsed.options, {
      runOrca: (args) => {
        seen.push(args);
        return { status: 0, stdout: JSON.stringify(multiMessageEnvelope), stderr: "" };
      },
    });
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(seen[0].slice(0, 3), ["orchestration", "check", "--json"]);
  assert.equal(seen[0].includes("--terminal"), false);
  assert.deepEqual(seen[0].slice(seen[0].indexOf("--run"), seen[0].indexOf("--run") + 2), ["--run", "run_1"]);
});

test("a worker's --terminal handle is passed to orca", () => {
  const parsed = parseCliArgs(["--terminal", "term_x"]);
  const seen = [];
  const origLog = console.log;
  console.log = () => {};
  try {
    runOrcaCheck(parsed.options, {
      runOrca: (args) => {
        seen.push(args);
        return { status: 0, stdout: JSON.stringify(multiMessageEnvelope), stderr: "" };
      },
    });
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(seen[0].slice(seen[0].indexOf("--terminal"), seen[0].indexOf("--terminal") + 2), ["--terminal", "term_x"]);
});

test("--ack prints the ack line and then the next batch when messages remain", () => {
  const logs = [];
  const origLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    runOrcaCheck(
      { ack: "del_old" },
      { runOrca: () => ({ status: 0, stdout: JSON.stringify(multiMessageEnvelope), stderr: "" }) },
    );
  } finally {
    console.log = origLog;
  }
  const lines = logs[0].split("\n");
  assert.equal(lines[0], "acked=del_old remaining=2");
  assert.equal(lines[1], "count=2 delivery=del_abc123 timedOut=false heartbeats=1");
  assert.equal(lines.length, 3);
});

test("a heartbeat-only delivery is acked and the wait goes on with the time left", () => {
  const clock = { t: 0, advance: 30000 };
  const { logs, calls } = runScripted(
    { terminal: "term_x", waitSeconds: 90 },
    [
      deliveryEnvelope("del_hb1", [heartbeat("m1")]),
      deliveryEnvelope("del_done", [workerDone("m2")]),
    ],
    clock,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes("--ack"), false);
  assert.deepEqual(calls[0].slice(-3), ["--wait", "--timeout-ms", "90000"]);
  assert.deepEqual(calls[1].slice(-5), ["--ack", "del_hb1", "--wait", "--timeout-ms", "60000"]);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].split("\n").map((l) => l.split(" | ")[0]), [
    "count=1 delivery=del_done timedOut=false heartbeats=1",
    "m2 worker_done",
  ]);
});

test("several heartbeat deliveries in a row are all acked, in order", () => {
  const { logs, calls } = runScripted(
    { waitSeconds: 90 },
    [
      deliveryEnvelope("del_a", [heartbeat("m1"), heartbeat("m2")]),
      deliveryEnvelope("del_b", [heartbeat("m3")]),
      deliveryEnvelope("del_c", [{ id: "m4", type: "question", subject: "which?", sender: "term_w", body: "A or B", payload: null }]),
    ],
  );
  assert.equal(calls[1][calls[1].indexOf("--ack") + 1], "del_a");
  assert.equal(calls[2][calls[2].indexOf("--ack") + 1], "del_b");
  assert.match(logs[0], /^count=1 delivery=del_c timedOut=false heartbeats=3\nm4 question \| which\?/);
});

test("heartbeats seen and then Orca's wait times out: one liveness line", () => {
  const { logs, outcome } = runScripted(
    { waitSeconds: 90 },
    [deliveryEnvelope("del_hb1", [heartbeat("m1"), heartbeat("m2")]), "timeout"],
  );
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(logs, ["count=0 delivery=null timedOut=true heartbeats=2"]);
});

test("when the budget runs out between heartbeats, the last call acks without blocking", () => {
  const clock = { t: 0, advance: 60000 };
  const { logs, calls } = runScripted(
    { waitSeconds: 100 },
    [
      deliveryEnvelope("del_a", [heartbeat("m1")]),
      deliveryEnvelope("del_b", [heartbeat("m2")]),
      emptyResultEnvelope,
    ],
    clock,
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1].includes("--wait"), true);
  assert.equal(calls[2].includes("--wait"), false);
  assert.equal(calls[2][calls[2].indexOf("--ack") + 1], "del_b");
  assert.deepEqual(logs, ["count=0 delivery=null timedOut=true heartbeats=2"]);
});

test("a message that arrives with the final ack is still printed", () => {
  const clock = { t: 0, advance: 100000 };
  const { logs } = runScripted(
    { waitSeconds: 100 },
    [deliveryEnvelope("del_a", [heartbeat("m1")]), deliveryEnvelope("del_b", [workerDone("m2")])],
    clock,
  );
  assert.match(logs[0], /^count=1 delivery=del_b timedOut=false heartbeats=1\nm2 worker_done/);
});

test("without --wait a heartbeat-only delivery is acked once and the next read is returned", () => {
  const { logs, calls } = runScripted({ terminal: "term_x" }, [
    deliveryEnvelope("del_hb1", [heartbeat("m1")]),
    emptyResultEnvelope,
  ]);
  assert.equal(calls[1].includes("--wait"), false);
  assert.equal(calls[1][calls[1].indexOf("--ack") + 1], "del_hb1");
  assert.deepEqual(logs, ["count=0 delivery=null timedOut=false heartbeats=1"]);
});

test("an ack that returns the same delivery does not loop", () => {
  const { calls } = runScripted({ ack: "del_hb1" }, [deliveryEnvelope("del_hb1", [heartbeat("m1")])]);
  assert.equal(calls.length, 1);
});

test("--ack of an earlier delivery is sent first and the heartbeats behind it are acked too", () => {
  const { logs, calls } = runScripted({ ack: "del_old", waitSeconds: 90 }, [
    deliveryEnvelope("del_hb1", [heartbeat("m1")]),
    emptyResultEnvelope,
  ]);
  assert.equal(calls[0][calls[0].indexOf("--ack") + 1], "del_old");
  assert.equal(calls[1][calls[1].indexOf("--ack") + 1], "del_hb1");
  assert.deepEqual(logs[0].split("\n"), [
    "acked=del_old remaining=0",
    "count=0 delivery=null timedOut=false heartbeats=1",
  ]);
});

test("--heartbeats prints the heartbeat delivery as Orca returned it and acks nothing", () => {
  const { logs, calls } = runScripted(
    { terminal: "term_x", waitSeconds: 90, heartbeats: true },
    [deliveryEnvelope("del_hb1", [heartbeat("m1")])],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("--ack"), false);
  assert.match(logs[0], /^count=1 delivery=del_hb1 timedOut=false\nm1 heartbeat \| alive \| /);
});

test("--heartbeats keeps the heartbeat line in a mixed delivery", () => {
  const { logs } = runScripted({ heartbeats: true }, [
    deliveryEnvelope("del_mix", [heartbeat("m1"), workerDone("m2")]),
  ]);
  const lines = logs[0].split("\n");
  assert.equal(lines[0], "count=2 delivery=del_mix timedOut=false");
  assert.equal(lines.length, 3);
});

test("parseCliArgs reads --heartbeats and it is off by default", () => {
  assert.equal(parseCliArgs([]).options.heartbeats, false);
  assert.equal(parseCliArgs(["--heartbeats", "--wait", "30"]).options.heartbeats, true);
});

test("an Orca error during the heartbeat loop is reported, real stale_delivery shape", () => {
  const stale = {
    id: "c9053f44-0134-482f-9f32-df9f0875f92e",
    ok: false,
    error: {
      code: "stale_delivery",
      message: "Delivery del_bogus does not belong to this mailbox.",
      data: { orchestrationRequestId: "3b8f1b65-dde2-4d92-ad22-9d95920f7f6b" },
    },
    _meta: { runtimeId: "22eeea5e-ba22-4ef8-bca5-bcaa34e2199e" },
  };
  const { outcome, errors } = runScripted({ waitSeconds: 90 }, [deliveryEnvelope("del_hb1", [heartbeat("m1")]), stale]);
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(errors, ["stale_delivery: Delivery del_bogus does not belong to this mailbox."]);
});

test("worker_done triggers automatic history capture for each dispatchId", () => {
  const captured = [];
  const { outcome, logs } = runScripted(
    {},
    [deliveryEnvelope("del_done", [workerDone("m1", "ctx_auto1"), heartbeat("h1"), workerDone("m2", "ctx_auto2")])],
    { t: 0 },
    { captureHistory: (id) => captured.push(id) },
  );
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(captured, ["ctx_auto1", "ctx_auto2"]);
  assert.match(logs[0], /m1 worker_done/);
});

test("a failed automatic capture does not fail the check", () => {
  const { outcome, errors, logs } = runScripted(
    {},
    [deliveryEnvelope("del_done", [workerDone("m1", "ctx_boom")])],
    { t: 0 },
    {
      captureHistory: () => {
        throw new Error("history store is locked");
      },
    },
  );
  assert.equal(outcome.exitCode, 0);
  assert.match(logs[0], /m1 worker_done/);
  assert.match(errors.join("\n"), /ctx_boom/);
  assert.match(errors.join("\n"), /history store is locked/);
});

test("worker_done without a dispatchId skips capture and still prints", () => {
  const captured = [];
  const done = workerDone("m1");
  delete done.payload.dispatchId;
  const { outcome, errors, logs } = runScripted(
    {},
    [deliveryEnvelope("del_done", [done])],
    { t: 0 },
    { captureHistory: (id) => captured.push(id) },
  );
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(captured, []);
  assert.match(logs[0], /m1 worker_done/);
  assert.match(errors.join("\n"), /no dispatchId/);
});

test("parseFindingsLine reads the documented Findings counts line", () => {
  assert.deepEqual(parseFindingsLine("Summary.\nFindings: blocking=1 high=2 medium=0 low=3\nDone."), {
    blocking: 1,
    high: 2,
    medium: 0,
    low: 3,
  });
  assert.equal(parseFindingsLine("no counts here"), null);
});

test("worker_done with a Findings line and a review_of link records the review on the reviewed dispatch", () => {
  const reviews = [];
  const done = workerDone("m1", "ctx_review");
  done.body = "Reviewed the branch.\nFindings: blocking=0 high=1 medium=2 low=0\nNothing left.";
  const { outcome, errors, logs } = runScripted(
    {},
    [deliveryEnvelope("del_done", [done])],
    { t: 0 },
    {
      captureHistory: () => {},
      resolveReviewedDispatch: (reviewerId) => {
        assert.equal(reviewerId, "ctx_review");
        return "ctx_impl";
      },
      recordReview: (reviewedId, findings, reviewerId) =>
        reviews.push({ reviewedId, findings, reviewerId }),
    },
  );
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(reviews, [
    {
      reviewedId: "ctx_impl",
      findings: { blocking: 0, high: 1, medium: 2, low: 0 },
      reviewerId: "ctx_review",
    },
  ]);
  assert.match(logs[0], /m1 worker_done/);
  assert.doesNotMatch(errors.join("\n"), /no Findings line|no review_of link/);
});

test("worker_done with Findings but no review_of link records nothing and prints one reminder", () => {
  const reviews = [];
  const done = workerDone("m1", "ctx_review");
  done.body = "Findings: blocking=0 high=1 medium=0 low=0";
  const { outcome, errors } = runScripted(
    {},
    [deliveryEnvelope("del_done", [done])],
    { t: 0 },
    {
      captureHistory: () => {},
      resolveReviewedDispatch: () => null,
      recordReview: (...args) => reviews.push(args),
    },
  );
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(reviews, []);
  assert.match(
    errors.join("\n"),
    /history: worker_done for ctx_review has Findings but no review_of link; skipping automatic record-review/,
  );
});

test("worker_done without a Findings line records nothing and prints one reminder", () => {
  const reviews = [];
  const { outcome, errors } = runScripted(
    {},
    [deliveryEnvelope("del_done", [workerDone("m1", "ctx_impl")])],
    { t: 0 },
    {
      captureHistory: () => {},
      recordReview: (id, findings) => reviews.push({ id, findings }),
    },
  );
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(reviews, []);
  assert.match(errors.join("\n"), /history: worker_done for ctx_impl has no Findings line; skipping automatic record-review/);
});

test("a failed automatic record-review does not fail the check", () => {
  const done = workerDone("m1", "ctx_review");
  done.body = "Findings: blocking=0 high=0 medium=0 low=0";
  const { outcome, errors } = runScripted(
    {},
    [deliveryEnvelope("del_done", [done])],
    { t: 0 },
    {
      captureHistory: () => {},
      resolveReviewedDispatch: () => "ctx_impl",
      recordReview: () => {
        throw new Error("no record for ctx_impl");
      },
    },
  );
  assert.equal(outcome.exitCode, 0);
  assert.match(errors.join("\n"), /automatic record-review failed for ctx_impl/);
  assert.match(errors.join("\n"), /no record for ctx_impl/);
});

function seedRecord(store, id, links = []) {
  const now = "2026-10-30T12:00:00.000Z";
  store.putRecord({
    schema: 1,
    id,
    dispatchId: id,
    taskId: "unknown",
    runId: "unknown",
    capturedAt: now,
    updatedAt: now,
    task: {
      type: "unknown",
      typeSource: "unknown",
      files: "unknown",
      difficulty: "unknown",
      difficultySource: "unknown",
      jevVersion: "unknown",
      jevUncertainty: null,
    },
    agent: {
      name: "unknown",
      requestedModel: "unknown",
      effectiveModel: "unknown",
      requestedEffort: "unknown",
      effectiveEffort: "unknown",
    },
    versions: { agent: "unknown", model: "unknown", jev: "unknown" },
    host: "unknown",
    branch: "unknown",
    baseBranch: "unknown",
    selection: { status: "unknown" },
    lifecycle: {
      dispatchStatus: "unknown",
      workerState: "unknown",
      outcome: "unknown",
      dispatchedAt: "unknown",
      completedAt: "unknown",
      events: [],
    },
    retries: { failureCount: "unknown", retryOf: null },
    signals: { checks: [], reviews: [] },
    links,
    usage: { attributable: [], shared: [] },
    transcript: { status: "unknown" },
  });
}

test("Findings with a review_of link record counts on the reviewed dispatch only (real history store)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-check-review-"));
  const prev = process.env.ORCA_HISTORY_DIR;
  process.env.ORCA_HISTORY_DIR = dir;
  const errors = [];
  const origErr = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    const store = openStore(dir);
    seedRecord(store, "ctx_impl");
    seedRecord(store, "ctx_review", [
      {
        kind: "review_of",
        target: "ctx_impl",
        evidence: "orca-spawn --review-of",
        at: "2026-10-30T12:00:00.000Z",
      },
    ]);
    assert.equal(resolveReviewedDispatch("ctx_review"), "ctx_impl");

    autoRecordReviewWorkerDone([
      {
        type: "worker_done",
        body: "Summary.\nFindings: blocking=0 high=2 medium=1 low=0\nDone.",
        payload: { dispatchId: "ctx_review" },
      },
    ]);

    const reviewed = openStore(dir).getRecord("ctx_impl");
    const reviewer = openStore(dir).getRecord("ctx_review");
    assert.equal(reviewed.signals.reviews.length, 1);
    assert.deepEqual(reviewed.signals.reviews[0].findings, {
      blocking: 0,
      high: 2,
      medium: 1,
      low: 0,
    });
    assert.equal(reviewed.signals.reviews[0].reviewerDispatch, "ctx_review");
    assert.equal(reviewer.signals.reviews.length, 0, "severity counts must not land on the reviewing dispatch");
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally {
    console.error = origErr;
    if (prev === undefined) delete process.env.ORCA_HISTORY_DIR;
    else process.env.ORCA_HISTORY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultRecordReview without a review_of link records nothing and prints one reminder", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-check-nolink-"));
  const prev = process.env.ORCA_HISTORY_DIR;
  process.env.ORCA_HISTORY_DIR = dir;
  const errors = [];
  const origErr = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    const store = openStore(dir);
    seedRecord(store, "ctx_review");
    defaultRecordReview("ctx_review", { blocking: 0, high: 1, medium: 0, low: 0 });
    assert.equal(openStore(dir).getRecord("ctx_review").signals.reviews.length, 0);
    assert.match(
      errors.join("\n"),
      /history: worker_done for ctx_review has Findings but no review_of link; skipping automatic record-review/,
    );
  } finally {
    console.error = origErr;
    if (prev === undefined) delete process.env.ORCA_HISTORY_DIR;
    else process.env.ORCA_HISTORY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
