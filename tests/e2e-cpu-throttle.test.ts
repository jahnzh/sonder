// SONDER_E2E_CPU_THROTTLE (tests/e2e/cpu-throttle.ts, #662): the rate a spec's page is slowed by, and only in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpuThrottleRate, throttleCpu } from "./e2e/cpu-throttle.ts";

test("the rate is the variable's number above 1, otherwise 1 (no throttling)", () => {
  assert.equal(cpuThrottleRate({ SONDER_E2E_CPU_THROTTLE: "4" }), 4);
  assert.equal(cpuThrottleRate({ SONDER_E2E_CPU_THROTTLE: "2.5" }), 2.5);
  for (const value of [undefined, "", "1", "0", "-3", "fast", "Infinity"])
    assert.equal(cpuThrottleRate({ SONDER_E2E_CPU_THROTTLE: value }), 1, String(value));
});

test("only a Chromium page is slowed, through one CDP session, at the rate", async () => {
  const sent: unknown[] = [];
  const page = { context: () => ({ newCDPSession: async () => ({ send: async (...args: unknown[]) => void sent.push(args) }) }) };
  assert.equal(await throttleCpu(page as never, "firefox", 4), false);
  assert.equal(await throttleCpu(page as never, "chromium", 1), false);
  assert.deepEqual(sent, []);
  assert.equal(await throttleCpu(page as never, "chromium", 4), true);
  assert.deepEqual(sent, [["Emulation.setCPUThrottlingRate", { rate: 4 }]]);
});
