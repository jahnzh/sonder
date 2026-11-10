import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChangeTracker, buildActivity, formatAge, isPermanentHardcoverError, stuckMultiplier,
  ATTENTION_FAILURE_MS, FINISHED_VISIBLE_MS,
  type ActivityInput,
} from "../server/activity.ts";
import type { TorrentHealth } from "../src/types.ts";
import type { AlignmentPoolStatus } from "../src/reading-types.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 9, 13, 0, 0);

const base = (over: Partial<ActivityInput> = {}): ActivityInput => ({
  now: NOW, multiplier: 1, acquisitions: [], copies: [], seriesJobs: [], alignments: [], hardcoverQueues: [],
  torrent: null, pool: null, tracker: new ChangeTracker(), ...over,
});
const acquisition = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Book ${id}`, author: "Author", backend: "local", status: "downloading", progress: 0.4, error: null,
  created_at: NOW - 3 * 60 * MIN, updated_at: NOW - MIN, ...over,
});
const torrent = (over: Partial<TorrentHealth> = {}): TorrentHealth => ({
  status: "ok", session: true, network: "ok", version: "4.0", message: "ok", checkedAt: NOW, ...over,
});
const alignmentData = (over: Record<string, unknown> = {}) => JSON.stringify({ status: "processing", progress: 0.5, error: null, createdAt: NOW - 90 * MIN, pool: { hostId: "wsl" }, ...over });
const pool = (hosts: Array<{ id: "wsl" | "lisa"; reachable: boolean; stuck?: boolean; lastError?: string | null }>): AlignmentPoolStatus => ({
  enabled: true, engine: "ctc", checkedAt: NOW,
  hosts: hosts.map((host) => ({
    id: host.id, sshTarget: host.id, workerUrl: "http://x", reachable: host.reachable, device: null, precision: null,
    busy: false, stuck: !!host.stuck, activeJobs: 0, maxConcurrent: 1, lastError: host.lastError ?? null,
  })),
});

test("the 2026-11-06 outage: downloads that look healthy are blocked by the down torrent client", () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map((id) =>
    acquisition(id, { error: "The local torrent client cannot be reached. Check that the torrent and VPN containers are running.", updated_at: NOW - 1000 }));
  const result = buildActivity(base({
    acquisitions: rows,
    torrent: torrent({ status: "unreachable", session: false, network: "unknown", message: "The local torrent client cannot be reached." }),
  }));
  assert.equal(result.items.length, 6);
  for (const item of result.items) {
    assert.equal(item.blockedBy, "torrent-client");
    assert.equal(item.stuck?.reason, "Blocked by Torrent client");
  }
  const client = result.processes.find((process) => process.id === "torrent-client")!;
  assert.equal(client.health, "down");
  assert.match(client.reason ?? "", /cannot be reached/);
  assert.equal(result.attention, 7, "six blocked downloads plus the down client");
  assert.equal(result.processes.find((process) => process.id === "acquisitions")!.counts.stuck, 6);
});

test("a TorBox download is not blocked by the local torrent client", () => {
  const result = buildActivity(base({
    acquisitions: [acquisition("t", { backend: "torbox" })],
    torrent: torrent({ status: "offline", session: false, message: "down" }),
  }));
  assert.equal(result.items[0].blockedBy, null);
  assert.equal(result.items[0].stuck, null);
});

test("no change for longer than the threshold is stuck, and a changing progress is not", () => {
  const tracker = new ChangeTracker();
  const first = buildActivity(base({ acquisitions: [acquisition("a")], tracker }));
  assert.equal(first.items[0].stuck, null, "first sight is never stuck");
  const later = buildActivity(base({ now: NOW + 16 * MIN, acquisitions: [acquisition("a", { updated_at: NOW + 16 * MIN })], tracker }));
  assert.equal(later.items[0].stuck?.reason, "No change for 16 min", "a row rewritten each poll still counts as unchanged");
  const moved = buildActivity(base({ now: NOW + 17 * MIN, acquisitions: [acquisition("a", { progress: 0.41 })], tracker }));
  assert.equal(moved.items[0].stuck, null);
});

test("the settings multiplier scales every threshold", () => {
  const tracker = new ChangeTracker();
  buildActivity(base({ acquisitions: [acquisition("a")], tracker, multiplier: 2 }));
  const result = buildActivity(base({ now: NOW + 16 * MIN, acquisitions: [acquisition("a")], tracker, multiplier: 2 }));
  assert.equal(result.items[0].stuck, null, "16 min is under 30 min at x2");
  assert.equal(result.stuckMultiplier, 2);
  assert.equal(stuckMultiplier("2"), 2);
  assert.equal(stuckMultiplier("0.1"), 1);
  assert.equal(stuckMultiplier("50"), 1);
  assert.equal(stuckMultiplier(undefined), 1);
  assert.equal(stuckMultiplier("abc"), 1);
});

test("server copies are stuck after 5 minutes without progress", () => {
  const tracker = new ChangeTracker();
  const copy = { recording_id: "r1", title: "Copy me", status: "downloading", progress: 0.2, error: null, created_at: NOW, updated_at: NOW };
  buildActivity(base({ copies: [copy], tracker }));
  const result = buildActivity(base({ now: NOW + 6 * MIN, copies: [copy], tracker }));
  assert.equal(result.items[0].stuck?.reason, "No change for 6 min");
  assert.equal(result.items[0].processId, "server-copies");
});

test("alignment: blocked by a down worker host, stuck by age, consensus labelled", () => {
  const down = buildActivity(base({
    alignments: [{ id: "j1", ebook_id: "libgen-1", recording_id: "rec", title: "Phlebas", data: alignmentData(), updated_at: NOW - MIN }],
    pool: pool([{ id: "wsl", reachable: false, lastError: "ssh: no route to host" }]),
  }));
  assert.equal(down.items[0].blockedBy, "alignment-host:wsl");
  assert.equal(down.items[0].stuck?.reason, "Blocked by Alignment worker (wsl)");
  assert.equal(down.processes.find((process) => process.id === "alignment-host:wsl")!.reason, "ssh: no route to host");

  const old = buildActivity(base({
    alignments: [{ id: "j2", ebook_id: "set-consensus:work-1", recording_id: "rec", title: "Phlebas", data: alignmentData({ pool: { hostId: "lisa" } }), updated_at: NOW - 25 * MIN }],
    pool: pool([{ id: "lisa", reachable: true }]),
  }));
  assert.equal(old.items[0].blockedBy, null);
  assert.equal(old.items[0].stuck?.reason, "No change for 25 min");
  assert.equal(old.items[0].detail, "Ebook set check");
  assert.equal(old.items[0].host, "lisa");
});

test("alignment states map and finished jobs drop off after 24 hours", () => {
  const row = (id: string, status: string, age: number) => ({ id, ebook_id: "e", recording_id: "r", title: id, data: alignmentData({ status }), updated_at: NOW - age });
  const result = buildActivity(base({
    alignments: [row("queued", "queued", MIN), row("copying", "copying", MIN), row("paused", "paused", MIN), row("ready", "ready", MIN),
      row("old-ready", "ready", FINISHED_VISIBLE_MS + MIN), row("old-error", "error", 30 * 24 * 60 * MIN)],
  }));
  const state = Object.fromEntries(result.items.map((item) => [item.title, item.state]));
  assert.deepEqual(state, { "old-error": "failed", queued: "queued", copying: "running", paused: "paused", ready: "done" });
  assert.equal(result.items[0].title, "old-error", "failed items sort first");
  assert.equal(result.attention, 0, "a failure older than a week stays listed without lighting the indicator");
});

test("Hardcover queues: permanent errors and long waits are flagged, one row per user and queue", () => {
  const result = buildActivity(base({
    hardcoverQueues: [
      { userId: 1, user: "admin", queue: "status", count: 1, oldest: NOW - 5 * 24 * 60 * MIN, newest: NOW - 5 * 24 * 60 * MIN, error: "We weren't able to find that book. Was it deleted?" },
      { userId: 2, user: "sam", queue: "reading", count: 3, oldest: NOW - 31 * MIN, newest: NOW - MIN, error: null },
      { userId: 2, user: "sam", queue: "listening", count: 2, oldest: NOW - 5 * MIN, newest: NOW - MIN, error: "network" },
    ],
  }));
  const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));
  assert.equal(byId["hardcover:status:1"].permanent, true);
  assert.equal(byId["hardcover:status:1"].stuck?.reason, "This change cannot succeed");
  assert.equal(byId["hardcover:reading:2"].stuck?.reason, "Unsent for 31 min");
  assert.equal(byId["hardcover:listening:2"].permanent, false);
  assert.equal(byId["hardcover:listening:2"].stuck, null);
  assert.equal(byId["hardcover:listening:2"].state, "failed");
  assert.equal(result.items.filter((item) => item.kind === "hardcover").length, 3);
  assert.equal(isPermanentHardcoverError("We weren't able to find that book. Was it deleted?"), true);
  assert.equal(isPermanentHardcoverError("socket hang up"), false);
});

test("processes: untracked ones are listed, loops degrade from their items, pool hosts appear only when enabled", () => {
  const none = buildActivity(base());
  assert.deepEqual(none.processes.map((process) => process.id), [
    "acquisitions", "server-copies", "series-acquisition", "hardcover-sync", "alignment", "torrent-client", "imports", "backups",
  ]);
  assert.equal(none.processes.find((process) => process.id === "imports")!.notTracked, true);
  assert.equal(none.processes.find((process) => process.id === "torrent-client")!.health, "unknown");
  assert.equal(none.attention, 0);

  const withHosts = buildActivity(base({
    pool: pool([{ id: "wsl", reachable: true }, { id: "lisa", reachable: true, stuck: true, lastError: "worker is stuck" }]),
    acquisitions: [acquisition("x", { status: "error", error: "boom", updated_at: NOW - MIN })],
  }));
  assert.equal(withHosts.processes.find((process) => process.id === "alignment-host:wsl")!.health, "ok");
  assert.equal(withHosts.processes.find((process) => process.id === "alignment-host:lisa")!.health, "degraded");
  const queue = withHosts.processes.find((process) => process.id === "acquisitions")!;
  assert.equal(queue.health, "degraded");
  assert.equal(queue.reason, "1 failed");
  assert.equal(queue.since, NOW - MIN);
});

test("a torrent client with a closed port is degraded, and a missing client is unknown", () => {
  const degraded = buildActivity(base({ torrent: torrent({ network: "port-closed", message: "Port closed" }) }));
  assert.equal(degraded.processes.find((process) => process.id === "torrent-client")!.health, "degraded");
  const unconfigured = buildActivity(base({ torrent: torrent({ status: "unconfigured", session: false }) }));
  assert.equal(unconfigured.processes.find((process) => process.id === "torrent-client")!.health, "unknown");
});

test("an unreadable alignment record is listed as failed with the reason and does not break the list", () => {
  const result = buildActivity(base({
    alignments: [{ id: "bad", ebook_id: "e", recording_id: "r", title: "Broken", data: "{not json", updated_at: NOW - MIN }],
    acquisitions: [acquisition("ok")],
  }));
  const bad = result.items.find((item) => item.id === "alignment:bad")!;
  assert.equal(bad.state, "failed");
  assert.match(bad.error ?? "", /^The job record could not be read: /);
  assert.equal(result.items.length, 2);
});

test("only the loops can be paused, and each shows its switch state, lock and what pausing does", () => {
  const result = buildActivity(base({
    pause: {
      alignment: { paused: true, locked: false },
      "series-acquisition": { paused: false, locked: true },
      "hardcover-sync": { paused: false, locked: false },
    },
  }));
  const byId = Object.fromEntries(result.processes.map((process) => [process.id, process]));
  assert.equal(byId.alignment.pausable, true);
  assert.equal(byId.alignment.paused, true);
  assert.equal(byId.alignment.lockedBy, null);
  assert.match(byId.alignment.pauseEffect ?? "", /No new alignment job starts/);
  assert.equal(byId["series-acquisition"].lockedBy, "environment");
  assert.equal(byId["series-acquisition"].paused, false);
  assert.match(byId["hardcover-sync"].pauseEffect ?? "", /Sync now still works/);
  assert.match(byId.acquisitions.pauseEffect ?? "", /keep downloading in the torrent client/);
  for (const id of ["torrent-client", "imports", "backups"]) {
    assert.equal(byId[id].pausable, false, id);
    assert.equal(byId[id].pauseEffect, null, id);
    assert.equal(byId[id].paused, false, id);
  }
  assert.equal(result.attention, 0, "a paused loop is not a problem by itself");
});

test("Hardcover items offer Discard for a permanent error and Retry otherwise; nothing else has actions", () => {
  const result = buildActivity(base({
    acquisitions: [acquisition("a")],
    hardcoverQueues: [
      { userId: 1, user: "admin", queue: "status", count: 1, oldest: NOW - 5 * 24 * 60 * MIN, newest: NOW - 5 * 24 * 60 * MIN, error: "We weren't able to find that book. Was it deleted?" },
      { userId: 1, user: "admin", queue: "listening", count: 2, oldest: NOW - MIN, newest: NOW - MIN, error: "socket hang up" },
      { userId: 1, user: "admin", queue: "reading", count: 1, oldest: NOW - MIN, newest: NOW - MIN, error: null },
    ],
  }));
  const actions = Object.fromEntries(result.items.map((item) => [item.id, item.actions]));
  assert.deepEqual(actions["hardcover:status:1"], ["discard"]);
  assert.deepEqual(actions["hardcover:listening:1"], ["retry"]);
  assert.deepEqual(actions["hardcover:reading:1"], ["retry"]);
  assert.deepEqual(actions["acquisition:a"], []);
  const titles = Object.fromEntries(result.items.filter((item) => item.kind === "hardcover").map((item) => [item.id, item.title]));
  assert.equal(titles["hardcover:status:1"], "Hardcover shelf changes");
  assert.equal(titles["hardcover:listening:1"], "Hardcover listening progress");
  assert.equal(titles["hardcover:reading:1"], "Hardcover reading progress");
});

test("a probe that failed shows why instead of silently reading as healthy", () => {
  const result = buildActivity(base({ torrentFailure: "ECONNREFUSED", poolFailure: "ssh timed out" }));
  const client = result.processes.find((process) => process.id === "torrent-client")!;
  assert.equal(client.health, "unknown");
  assert.equal(client.reason, "The check failed: ECONNREFUSED");
  const workers = result.processes.find((process) => process.id === "alignment-pool")!;
  assert.equal(workers.reason, "The check failed: ssh timed out");
});

test("the tracker forgets items that are gone, and ages read naturally", () => {
  const tracker = new ChangeTracker();
  buildActivity(base({ acquisitions: [acquisition("a")], tracker }));
  buildActivity(base({ acquisitions: [], tracker }));
  const result = buildActivity(base({ now: NOW + 30 * MIN, acquisitions: [acquisition("a")], tracker }));
  assert.equal(result.items[0].stuck, null, "a returning item starts fresh");
  assert.equal(formatAge(30 * 1000), "1 min");
  assert.equal(formatAge(80 * MIN), "80 min");
  assert.equal(formatAge(5 * 60 * MIN), "5 h");
  assert.equal(formatAge(3 * 24 * 60 * MIN), "3 days");
  assert.ok(ATTENTION_FAILURE_MS > 0);
});
