import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAllJsonValues,
  parseOrcaCheckOutput,
  formatCheckLines,
  formatMessageLine,
  parseCliArgs,
  runOrcaCheck,
  main,
} from "../scripts/orca-check.mjs";

const emptyResultEnvelope = {
  id: "d23a7b42-e1f0-4e55-b533-acabaad58dee",
  ok: true,
  result: {
    runId: "run_561373069493",
    dispatchId: "ctx_49536e0c743e",
    deliveryId: null,
    messages: [],
    count: 0,
    replayed: false,
    acknowledged: null,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
  },
};

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
        payload: { outcome: "succeeded", taskId: "task_cda427e7c32f" },
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

test("runOrcaCheck prints count, delivery, timedOut and message lines", () => {
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
    assert.equal(outputLines[0], "count=2 delivery=del_abc123 timedOut=false");
    assert.equal(outputLines.length, 3);
    assert.match(outputLines[1], /^msg_heartbeat_1 heartbeat \| alive \| /);
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
    "msg_worker_done_1 worker_done | succeeded | term_worker_terminal_han | Finished the parser and tests. Nothing left for the coordinator. | {\"outcome\":\"succeeded\",\"taskId\":\"task_cda427e7c32f\"}",
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
  assert.equal(lines[1], "count=2 delivery=del_abc123 timedOut=false");
  assert.equal(lines.length, 4);
});
