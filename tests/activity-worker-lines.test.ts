// The worker's page (#520, spec #513 "The worker's page"; boards Worker.dc.html, WorkerNotInUse.dc.html): its rows'
// values from the server's activity answer. Status (Online, Offline since …, Not in use); Device (GPU, CPU); Now
// (what it runs, or "Nothing running"); Code version (unknown when it reports none); Restart's line ("Last: today
// 09:12 · ready again", or why it failed); and which address names a worker the server reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivityItem, ActivityProcess, ActivityResponse, ActivityWorkerHost } from "../src/types.ts";
import {
  FORCEABLE_REFUSALS, UNKNOWN_VALUE, WORKER_CAPTION, findWorker, restartLine, restartWhen, workerDevice, workerNowValue,
  workerRevision, workerStatus,
} from "../src/pages/activity-worker-lines.ts";

const NOW = new Date(2026, 10, 17, 15, 30).getTime();
const at = (day: number, hours: number, minutes: number) => new Date(2026, 10, day, hours, minutes).getTime();
const counts = { running: 0, queued: 0, failed: 0, stuck: 0 };
const host = (over: Partial<ActivityWorkerHost> = {}): ActivityWorkerHost => ({
  hostId: "wsl", device: "cuda", online: true, disabled: false, revision: "c901429", work: null, jobs: [], restarting: false,
  lastRestart: null, ...over,
});
const worker = (over: Partial<ActivityWorkerHost> = {}, process: Partial<ActivityProcess> = {}): ActivityProcess => ({
  id: `alignment-host:${over.hostId ?? "wsl"}`, label: `Reading sync worker (${over.hostId ?? "wsl"})`, type: "service", health: "ok",
  reason: null, since: null, notTracked: false, pausable: false, paused: false, lockedBy: null, pauseEffect: null, counts,
  host: host(over), ...process,
});
const sync = (hostId: string, stage: string | null, state: ActivityItem["state"] = "running", title = "Feral Gods"): ActivityItem => ({
  id: `alignment:${Math.random()}`, kind: "alignment", processId: "alignment", title, detail: null, user: null, state,
  progress: null, host: hostId, startedAt: null, updatedAt: NOW, error: null, permanent: false, actions: [], stuck: null,
  blockedBy: null, workId: null, bookId: null, cover: null,
  facts: { kind: "alignment", status: "processing", outcome: null, coverage: null, wholeBook: true, stage, files: null },
  attention: false,
});

test("the caption names what the page is about", () => {
  assert.equal(WORKER_CAPTION, "Reading sync worker");
});

test("Status: Online, Offline since a time, Offline, Not in use", () => {
  assert.equal(workerStatus(worker(), NOW), "Online");
  assert.equal(workerStatus(worker({ online: false }, { health: "down", since: at(17, 14, 2) }), NOW), "Offline since 14:02");
  assert.equal(workerStatus(worker({ online: false }, { health: "down", since: at(16, 14, 2) }), NOW), "Offline since 16 Nov 14:02");
  assert.equal(workerStatus(worker({ online: false }, { health: "down", since: null }), NOW), "Offline");
  assert.equal(workerStatus(worker({ disabled: true }), NOW), "Not in use");
  // Switched off and unreachable: only "Not in use", as its row on Server reads.
  assert.equal(workerStatus(worker({ disabled: true, online: false }, { health: "unknown", since: at(17, 14, 2) }), NOW), "Not in use");
});

test("Device: GPU, CPU, or unknown while the worker cannot be read", () => {
  assert.equal(workerDevice(worker({ device: "cuda" })), "GPU");
  assert.equal(workerDevice(worker({ device: "cuda:0" })), "GPU");
  assert.equal(workerDevice(worker({ device: "cpu" })), "CPU");
  assert.equal(workerDevice(worker({ device: null })), UNKNOWN_VALUE);
});

test("Now: what the worker runs, or Nothing running; an offline worker runs nothing", () => {
  assert.equal(workerNowValue(worker(), [sync("wsl", "encoding")]), "Encoding: Feral Gods");
  // Another worker's work and work that waits are not this worker's now.
  assert.equal(workerNowValue(worker(), [sync("lisa", "encoding"), sync("wsl", null, "queued")]), "Nothing running");
  assert.equal(workerNowValue(worker(), []), "Nothing running");
  // The jobs Sonder holds there, when no reading sync item names the worker.
  assert.equal(workerNowValue(worker({ jobs: ["Speaker for the Dead"] }), []), "Preparing: Speaker for the Dead");
  assert.equal(workerNowValue(worker({ online: false, jobs: ["Speaker for the Dead"] }), [sync("wsl", "encoding")]), "Nothing running");
  assert.equal(workerNowValue(worker({ disabled: true }), []), "Nothing running");
});

test("Code version: the revision it reports, unknown when it reports none", () => {
  assert.equal(workerRevision(worker()), "c901429");
  assert.equal(workerRevision(worker({ revision: null })), "unknown");
  assert.equal(workerRevision(worker({ revision: "" })), "unknown");
});

test("Restart's line: when, and ready again or why it failed; nothing when never restarted from the page", () => {
  assert.equal(restartLine(null, NOW), "");
  assert.equal(restartLine({ at: at(17, 9, 12), ok: true, forced: false, message: "Restarted and ready again after 4 s." }, NOW), "Last: today 09:12 · ready again");
  assert.equal(restartLine({ at: at(16, 18, 40), ok: true, forced: true, message: "Restarted and ready again after 4 s." }, NOW), "Last: yesterday 18:40 · ready again");
  assert.equal(
    restartLine({ at: at(17, 15, 28), ok: false, forced: true, message: "The restart command failed: ssh: connect to host: Connection refused" }, NOW),
    "Last: today 15:28 · The restart command failed: ssh: connect to host: Connection refused",
  );
  assert.equal(
    restartLine({ at: at(17, 15, 28), ok: false, forced: false, message: "Restart refused. The host is running 1 whole-book job." }, NOW),
    "Last: today 15:28 · Restart refused. The host is running 1 whole-book job",
  );
});

test("when a restart was: today, yesterday, or its date", () => {
  assert.equal(restartWhen(at(17, 0, 5), NOW), "today 00:05");
  assert.equal(restartWhen(at(16, 23, 59), NOW), "yesterday 23:59");
  assert.equal(restartWhen(at(15, 8, 0), NOW), "15 Nov 08:00");
  // Across a month's end.
  assert.equal(restartWhen(new Date(2026, 10, 30, 22, 0).getTime(), new Date(2026, 11, 1, 8, 0).getTime()), "yesterday 22:00");
});

test("an address names a worker the server reports, or none", () => {
  const answer: ActivityResponse = {
    checkedAt: NOW, stuckMultiplier: 1, attention: 0, items: [],
    processes: [worker({ hostId: "wsl" }), worker({ hostId: "lisa", device: "cpu" }), { ...worker(), id: "alignment", host: undefined }],
  };
  assert.equal(findWorker(answer, "lisa")?.host?.hostId, "lisa");
  assert.equal(findWorker(answer, "wsl")?.id, "alignment-host:wsl");
  assert.equal(findWorker(answer, "nobody"), undefined);
  assert.equal(findWorker(answer, "alignment"), undefined);
});

test("only a busy or unreadable worker's refusal may be forced", () => {
  assert.deepEqual([...FORCEABLE_REFUSALS].sort(), ["host_busy", "host_unreadable"]);
});
