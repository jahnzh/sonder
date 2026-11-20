import { test } from "node:test";
import assert from "node:assert/strict";
import { catchUpDecision, CATCH_UP_TIMEOUT_MS, SAME_PLACE_SECONDS, type CatchUpInput } from "../src/paused-catch-up.ts";

// #773: a paused player picks up a newer place saved on another device, and nothing else moves it.
const paused = (over: Partial<CatchUpInput> = {}): CatchUpInput => ({
  playing: false,
  recordingId: "r1",
  trackIds: ["t1", "t2"],
  place: { trackId: "t1", position: 100 },
  savedAt: 1_000,
  server: { recordingId: "r1", trackId: "t1", position: 300, duration: 640, updatedAt: 2_000 },
  ...over,
});

test("a newer server place on the same track moves the paused player there", () => {
  const decision = catchUpDecision(paused());
  assert.equal(decision.action, "move");
  assert.ok(decision.action === "move");
  assert.equal(decision.trackId, "t1");
  assert.equal(decision.position, 300);
  assert.equal(decision.progress.updatedAt, 2_000);
});

test("a newer server place on another track moves the paused player to that track", () => {
  const decision = catchUpDecision(paused({ server: { recordingId: "r1", trackId: "t2", position: 12, duration: 640, updatedAt: 2_000 } }));
  assert.deepEqual(decision.action === "move" && [decision.trackId, decision.position], ["t2", 12]);
});

test("a playing player is never moved", () => {
  assert.deepEqual(catchUpDecision(paused({ playing: true })), { action: "stay", reason: "playing" });
});

test("a paused player whose own save is newer, or as new, is not moved", () => {
  assert.deepEqual(catchUpDecision(paused({ savedAt: 3_000 })), { action: "stay", reason: "not-newer" });
  assert.deepEqual(catchUpDecision(paused({ savedAt: 2_000 })), { action: "stay", reason: "not-newer" });
});

test("no answer (offline, slow server) or no saved place on the server leaves the local place", () => {
  assert.deepEqual(catchUpDecision(paused({ server: undefined })), { action: "stay", reason: "no-answer" });
  assert.deepEqual(catchUpDecision(paused({ server: null })), { action: "stay", reason: "no-server-place" });
});

test("a place within one second is the same place; past one second it moves", () => {
  const near = (position: number) => paused({ server: { recordingId: "r1", trackId: "t1", position, duration: 640, updatedAt: 2_000 } });
  assert.deepEqual(catchUpDecision(near(100 + SAME_PLACE_SECONDS)), { action: "stay", reason: "same-place" });
  assert.deepEqual(catchUpDecision(near(100 - 0.4)), { action: "stay", reason: "same-place" });
  assert.equal(catchUpDecision(near(100 + SAME_PLACE_SECONDS + 0.01)).action, "move");
  assert.equal(catchUpDecision(near(98.5)).action, "move");
  // The same position on another track is another place.
  assert.equal(catchUpDecision(paused({ server: { recordingId: "r1", trackId: "t2", position: 100, duration: 640, updatedAt: 2_000 } })).action, "move");
});

test("only the loaded recording is compared: another recording's place, or a track it lacks, never moves it", () => {
  assert.deepEqual(
    catchUpDecision(paused({ server: { recordingId: "r2", trackId: "t1", position: 300, duration: 640, updatedAt: 2_000 } })),
    { action: "stay", reason: "other-recording" },
  );
  assert.deepEqual(
    catchUpDecision(paused({ server: { recordingId: "r1", trackId: "elsewhere", position: 300, duration: 640, updatedAt: 2_000 } })),
    { action: "stay", reason: "unknown-track" },
  );
});

test("a device with no save of its own takes any server place", () => {
  assert.equal(catchUpDecision(paused({ savedAt: 0 })).action, "move");
});

test("a resume waits about 1.5 s at most", () => {
  assert.equal(CATCH_UP_TIMEOUT_MS, 1500);
});
