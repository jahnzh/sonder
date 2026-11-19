// The lines of Activity › Server (#519, spec #513 "Server"): each queue in its own words or "Nothing running",
// "Paused" first when switched off, "Paused by a server setting" when an environment setting holds it; the torrent
// client; the workers ("Online · GPU · Encoding: Feral Gods", "Offline since 14:02", "Not in use · CPU"); and
// which rows carry the attention mark.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivityItem, ActivityProcess, ActivityWorkerHost } from "../src/types.ts";
import {
  NOTHING_RUNNING, clockTime, deviceName, lightsDot, prepareResult, prepareValue, queueLine, torrentLine, workerLine,
} from "../src/pages/activity-server-lines.ts";

const NOW = new Date(2026, 10, 17, 15, 30).getTime();
const counts = { running: 0, queued: 0, failed: 0, stuck: 0 };
const proc = (id: string, over: Partial<ActivityProcess> = {}): ActivityProcess => ({
  id, label: id, type: "loop", health: "ok", reason: null, since: null, notTracked: false, pausable: true, paused: false,
  lockedBy: null, pauseEffect: null, counts, ...over,
});
const item = (processId: string, state: ActivityItem["state"], over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: `${processId}:${Math.random()}`, kind: "acquisition", processId, title: "Feral Gods", detail: null, user: null, state,
  progress: null, host: null, startedAt: null, updatedAt: NOW, error: null, permanent: false, actions: [], stuck: null,
  blockedBy: null, workId: null, bookId: null, cover: null, facts: { kind: "acquisition", status: "downloading", backend: "local" },
  attention: false, ...over,
});
const host = (over: Partial<ActivityWorkerHost> = {}): ActivityWorkerHost => ({
  hostId: "wsl", device: "cuda", online: true, disabled: false, revision: "c901429", work: null, jobs: [], restarting: false,
  lastRestart: null, ...over,
});
const worker = (over: Partial<ActivityWorkerHost> = {}, process: Partial<ActivityProcess> = {}) =>
  proc(`alignment-host:${over.hostId ?? "wsl"}`, { type: "service", pausable: false, host: host(over), ...process });
const syncOn = (hostId: string, stage: string | null, title = "Feral Gods") =>
  item("alignment", "running", {
    kind: "alignment", host: hostId, title,
    facts: { kind: "alignment", status: "processing", outcome: null, coverage: null, wholeBook: true, stage, files: null },
  });

test("a queue counts what is there in its own words, or says Nothing running", () => {
  const sync = proc("alignment");
  assert.equal(queueLine(sync, []), NOTHING_RUNNING);
  assert.equal(queueLine(sync, [item("alignment", "running"), item("alignment", "queued")]), "1 preparing · 1 waiting");
  // Finished work and another queue's work do not count.
  assert.equal(queueLine(sync, [item("alignment", "done"), item("acquisitions", "running")]), NOTHING_RUNNING);
  assert.equal(queueLine(proc("acquisitions"), [item("acquisitions", "running")]), "1 downloading");
  assert.equal(
    queueLine(proc("acquisitions"), [item("acquisitions", "running"), item("acquisitions", "running"), item("acquisitions", "paused"), item("acquisitions", "failed")]),
    "2 downloading · 1 paused · 1 failed",
  );
  assert.equal(queueLine(proc("ebook-set"), [item("ebook-set", "running")]), "1 checking");
  assert.equal(queueLine(proc("server-copies"), [item("server-copies", "queued")]), "1 waiting");
  assert.equal(queueLine(proc("server-copies"), [item("server-copies", "running")]), "1 copying");
  assert.equal(queueLine(proc("series-acquisition"), [item("series-acquisition", "running")]), "1 searching");
});

test("Database backups read their schedule", () => {
  const backups = proc("backups", { reason: "Last run 17 Nov 03:00 UTC: succeeded, 48.0 MB · Next run 18 Nov 03:00 UTC" });
  assert.equal(queueLine(backups, []), "Last run 17 Nov 03:00 UTC: succeeded, 48.0 MB · Next run 18 Nov 03:00 UTC");
  assert.equal(queueLine(proc("backups", { paused: true, reason: "No backup yet · Next run when resumed" }), []), "Paused · No backup yet · Next run when resumed");
});

test("a queue switched off reads Paused first, and one an environment setting holds says so", () => {
  const items = [item("alignment", "running"), item("alignment", "queued")];
  assert.equal(queueLine(proc("alignment", { paused: true }), items), "Paused · 1 preparing · 1 waiting");
  assert.equal(queueLine(proc("series-acquisition", { paused: true }), []), "Paused");
  assert.equal(queueLine(proc("series-acquisition", { lockedBy: "environment" }), []), "Paused by a server setting");
  assert.equal(queueLine(proc("series-acquisition", { lockedBy: "environment", paused: true }), [item("series-acquisition", "queued")]), "Paused by a server setting · 1 waiting");
});

test("the torrent client: Running, or its health message; the mark only when it is down", () => {
  assert.equal(torrentLine(proc("torrent-client", { type: "service" })), "Running");
  const vpn = "The local torrent client has no internet connection through the VPN. Downloads will not start until the VPN container is fixed.";
  const down = proc("torrent-client", { type: "service", health: "down", reason: vpn });
  assert.equal(torrentLine(down), vpn);
  assert.equal(lightsDot(down), true);
  const degraded = proc("torrent-client", { type: "service", health: "degraded", reason: "Port closed" });
  assert.equal(torrentLine(degraded), "Port closed");
  assert.equal(lightsDot(degraded), false);
  assert.equal(lightsDot(proc("torrent-client", { type: "service" })), false);
  assert.equal(lightsDot(undefined), false);
});

test("a worker's line, and the mark only for one that is offline and in use", () => {
  assert.equal(workerLine(worker(), [], NOW), "Online · GPU");
  assert.equal(workerLine(worker({ hostId: "lisa", device: "cpu" }), [], NOW), "Online · CPU");
  assert.equal(workerLine(worker(), [syncOn("wsl", "encoding")], NOW), "Online · GPU · Encoding: Feral Gods");
  // A reading sync on another worker is not this one's.
  assert.equal(workerLine(worker(), [syncOn("lisa", "encoding")], NOW), "Online · GPU");
  assert.equal(workerLine(worker(), [syncOn("wsl", null, "Children of Time")], NOW), "Online · GPU · Preparing: Children of Time");
  const offline = worker({ hostId: "lisa", device: "cpu", online: false }, { health: "down", since: new Date(2026, 10, 17, 14, 2).getTime() });
  assert.equal(workerLine(offline, [], NOW), "Offline since 14:02");
  assert.equal(lightsDot(offline), true);
  assert.equal(workerLine(worker({ online: false }, { health: "down" }), [], NOW), "Offline");
  // Not in use: switched off; switched off and unreachable reads only Not in use. No mark (the server reports unknown).
  const notInUse = worker({ hostId: "lisa", device: "cpu", disabled: true });
  assert.equal(workerLine(notInUse, [syncOn("lisa", "encoding")], NOW), "Not in use · CPU");
  const offAndAway = worker({ hostId: "lisa", device: "cpu", disabled: true, online: false }, { health: "unknown" });
  assert.equal(workerLine(offAndAway, [], NOW), "Not in use");
  assert.equal(lightsDot(offAndAway), false);
  assert.equal(lightsDot(notInUse), false);
  // The mark follows Now's rule (#521): a worker switched off is never marked, even if it were reported down.
  assert.equal(lightsDot(worker({ hostId: "lisa", device: "cpu", disabled: true, online: false }, { health: "down" })), false);
});

test("devices and times as the boards write them", () => {
  assert.equal(deviceName("cuda"), "GPU");
  assert.equal(deviceName("cpu"), "CPU");
  assert.equal(deviceName(null), "");
  assert.equal(clockTime(new Date(2026, 10, 17, 9, 5).getTime(), NOW), "09:05");
  assert.equal(clockTime(new Date(2026, 10, 16, 14, 2).getTime(), NOW), "16 Nov 14:02");
});

test("Prepare for all books: the count ready and what queuing did", () => {
  assert.equal(prepareValue(34), "34 ready");
  assert.equal(prepareResult(3), "Queued reading sync for 3 books");
  assert.equal(prepareResult(1), "Queued reading sync for 1 book");
  assert.equal(prepareResult(0), "No new books needed reading sync");
});
