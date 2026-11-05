import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectUsageLimitInText,
  parseTerminalReadResult,
  terminalTextFromReadResult,
  USAGE_LIMIT_TERMINAL_SAMPLES,
} from "../scripts/orca-usage-limit-detect.mjs";
import { USAGE_LIMIT_SAMPLES_MISSING } from "../scripts/usage-limit-patterns.mjs";
import { REAL_EXHAUSTED } from "./codex-fixture.mjs";

test("detectUsageLimitInText matches codex upsell title from codex-fixture", () => {
  const tail = `Some spinner output\n${REAL_EXHAUSTED.rateLimitUpsell.title}\nPress enter`;
  const hit = detectUsageLimitInText(tail);
  assert.ok(hit);
  assert.equal(hit.agent, "codex");
  assert.equal(hit.id, "codex-out-of-messages");
});

test("detectUsageLimitInText matches claude session-limit sample", () => {
  const hit = detectUsageLimitInText("You've hit your session limit · resets 1:50am (UTC)");
  assert.equal(hit?.agent, "claude");
});

test("detectUsageLimitInText ignores unrelated terminal text", () => {
  assert.equal(detectUsageLimitInText("npm test passed"), null);
});

test("parseTerminalReadResult reads tail lines from a worker-read receipt shape", () => {
  const receipt = {
    ok: true,
    result: {
      terminal: {
        tail: ["line one", REAL_EXHAUSTED.rateLimitUpsell.title],
      },
    },
  };
  const parsed = parseTerminalReadResult(`${JSON.stringify(receipt)}\n`);
  assert.ok(parsed);
  assert.match(terminalTextFromReadResult(parsed), /out of Codex messages/);
});

test("fixture catalog documents agents without a captured terminal prompt", () => {
  assert.ok(USAGE_LIMIT_SAMPLES_MISSING.includes("cursor"));
  assert.ok(USAGE_LIMIT_SAMPLES_MISSING.includes("antigravity"));
  assert.ok(USAGE_LIMIT_TERMINAL_SAMPLES.every((row) => row.source && row.substring));
});
