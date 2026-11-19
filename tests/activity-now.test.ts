/**
 * Now and the attention dot (#521, spec #513 "Now" and "The attention dot"): one pure builder from the server's answer,
 * this device's save entries, whether the user is the administrator and whether there is a connection. The tests read
 * what a user would see: the group a book is in, its line, its button, what it opens, and whether the dot is lit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNow, type Now, type NowInput, type NowRow } from "../src/activity-now.ts";
import { deviceSaveEntries, type DeviceSaveInput, type DeviceSaveRecord } from "../src/device-saves.ts";
import type { ActivityFacts, ActivityItem, ActivityProcess, ActivityResponse } from "../src/types.ts";

const NOW = 10 * 24 * 3_600_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

const item = (id: string, over: Partial<ActivityItem> & { facts: ActivityFacts }): ActivityItem => ({
  id, kind: over.facts.kind, processId: "p", title: `Title of ${id}`, detail: null, user: "admin", state: "running",
  progress: null, host: null, startedAt: null, updatedAt: NOW - MINUTE, error: null, permanent: false, actions: [],
  stuck: null, blockedBy: null, workId: null, bookId: null, cover: null, attention: false, ...over,
});
const download = (id: string, workId: string | null, over: Partial<ActivityItem> = {}) =>
  item(id, {
    workId, bookId: workId ? `b-${workId}` : null, cover: `/cover/${workId ?? id}`, title: `Book ${workId ?? id}`,
    facts: { kind: "acquisition", status: "downloading", backend: "local" }, progress: 0.43, ...over,
  });
const sync = (id: string, workId: string, status: string, over: Partial<ActivityItem> = {}, facts: Partial<Extract<ActivityFacts, { kind: "alignment" }>> = {}) =>
  item(id, {
    workId, bookId: `b-${workId}`, cover: `/cover/${workId}`, title: `Book ${workId}`,
    facts: { kind: "alignment", status, outcome: null, coverage: null, wholeBook: true, stage: null, files: null, ...facts }, ...over,
  });
const process = (id: string, over: Partial<ActivityProcess> = {}): ActivityProcess => ({
  id, label: `Process ${id}`, type: "service", health: "ok", reason: null, since: null, notTracked: false, pausable: false,
  paused: false, lockedBy: null, pauseEffect: null, counts: { running: 0, queued: 0, failed: 0, stuck: 0 }, ...over,
});
const answer = (items: ActivityItem[], processes: ActivityProcess[] = []): ActivityResponse => ({
  checkedAt: NOW, stuckMultiplier: 1, processes, items,
  attention: items.filter((i) => i.attention).length + processes.filter((p) => p.health === "down" && !p.notTracked).length,
});

const bookOf = (id: string, workId: string, recordingId: string, files: number) => ({
  id, workId, recordingId, title: `Book ${workId}`, cover: `/cover/${workId}`,
  tracks: Array.from({ length: files }, (_, i) => ({ id: `${recordingId}-${i}` })),
});
const filesOf = (recordingId: string, count: number, size = 10 * MB, completedAt = NOW - HOUR) =>
  Array.from({ length: count }, (_, i) => ({ trackId: `${recordingId}-${i}`, recordingId, size, completedAt }));
const record = (recordingId: string, workId: string, over: Partial<DeviceSaveRecord>): DeviceSaveRecord =>
  ({ recordingId, workId, startedAt: NOW - 2 * HOUR, state: "saving", reason: null, finishedAt: null, ...over });

/** The device's saves through the real entry builder, as the shell makes them. */
function device(over: Partial<DeviceSaveInput>) {
  const input: DeviceSaveInput = { books: [], downloads: [], downloadParts: [], running: {}, records: [], ebooks: [], ...over };
  return { saves: deviceSaveEntries(input), books: input.books as unknown as NowInput["books"] };
}
const build = (over: Partial<NowInput>): Now =>
  buildNow({ activity: null, saves: [], books: [], admin: true, online: true, now: NOW, ...over });
const group = (now: Now, id: string) => now.groups.find((g) => g.id === id)!.rows;
const where = (now: Now) => Object.fromEntries(now.groups.flatMap((g) => g.rows.map((r) => [r.key, g.id])));
const row = (now: Now, key: string): NowRow => now.groups.flatMap((g) => g.rows).find((r) => r.key === key)!;

/** A failed save of w-fail (8 of 12 files) and a paused one of w-wait (3 of 12). */
const failedAndPaused = () =>
  device({
    books: [bookOf("b-w-fail", "w-fail", "r-fail", 12), bookOf("b-w-wait", "w-wait", "r-wait", 12)],
    downloads: [...filesOf("r-fail", 8), ...filesOf("r-wait", 3)],
    records: [
      record("r-fail", "w-fail", { state: "failed", reason: "Out of storage", startedAt: NOW - 5 * MINUTE }),
      record("r-wait", "w-wait", { state: "paused", startedAt: NOW - 10 * MINUTE }),
    ],
  });

test("the four groups in their order, always listed, and empty: Nothing running and no dot", () => {
  const now = build({ activity: answer([]) });
  assert.deepEqual(now.groups.map((g) => g.title), ["Needs attention", "In progress", "Waiting", "Finished today"]);
  assert.deepEqual(now.groups.map((g) => g.id), ["attention", "progress", "waiting", "finished"]);
  assert.equal(now.empty, true);
  assert.equal(now.dot, false);
  assert.equal(now.offline, false);
  assert.equal(build({}).empty, true);
});

test("one row per work across the two sources: a download, a reading sync and a save of one book are one row", () => {
  const { saves, books } = device({
    books: [bookOf("b-w1", "w1", "r1", 12)],
    downloads: filesOf("r1", 3),
    running: { r1: { chapter: 4, loaded: 0, size: 0 } },
    records: [record("r1", "w1", { state: "saving" })],
  });
  const now = build({
    activity: answer([download("acq:1", "w1"), sync("align:1", "w1", "queued"), download("acq:2", "w2")]),
    saves, books,
  });
  const rows = now.groups.flatMap((g) => g.rows);
  assert.deepEqual(rows.map((r) => r.key).sort(), ["work:w1", "work:w2"]);
  // In progress wins over Waiting, and the download comes before the save in the same group.
  assert.equal(where(now)["work:w1"], "progress");
  assert.equal(row(now, "work:w1").entry, "download");
  assert.equal(row(now, "work:w1").line, "Downloading to server · 43%");
  assert.equal(row(now, "work:w1").progress, 0.43);
  assert.equal(row(now, "work:w1").title, "Book w1");
  assert.equal(row(now, "work:w1").cover, "/cover/w1");
});

test("the most urgent group wins: a failed save under Needs attention over a running download of the same book", () => {
  const { saves, books } = device({
    books: [bookOf("b-w1", "w1", "r1", 12)],
    downloads: filesOf("r1", 8),
    records: [record("r1", "w1", { state: "failed", reason: "Out of storage" })],
  });
  const now = build({ activity: answer([download("acq:1", "w1"), sync("align:1", "w1", "ready", { state: "done" })]), saves, books });
  assert.deepEqual(where(now), { "work:w1": "attention" });
  const shown = row(now, "work:w1");
  assert.equal(shown.entry, "device-save");
  assert.equal(shown.line, "Not complete · 8 of 12 files");
  assert.equal(shown.failed, true);
  assert.deepEqual(shown.button, { action: "retry", source: "device", recordingId: "r1", bookId: "b-w1" });
  assert.equal(now.dot, true);
});

test("the order of entries in a group: download, copy, series search, ebook check, reading sync, save", () => {
  const work = (over: Partial<ActivityItem>) => ({ workId: "w1", bookId: "b-w1", cover: "/c", title: "Book", state: "queued" as const, ...over });
  const queue: ActivityItem[] = [
    sync("align:1", "w1", "queued", { state: "queued" }),
    item("ebook:1", { ...work({}), facts: { kind: "ebook-set", status: "held", holdReason: "awaiting_worker" } }),
    item("series:1", { ...work({}), facts: { kind: "series-acquisition", status: "pending", search: "ebook" } }),
    item("copy:1", { ...work({}), facts: { kind: "server-copy", status: "queued" } }),
    download("acq:1", "w1", { state: "paused", facts: { kind: "acquisition", status: "paused", backend: "local" } }),
  ];
  const lines: string[] = [];
  for (let i = queue.length; i > 0; i--) {
    const now = build({ activity: answer(queue.slice(0, i)) });
    assert.deepEqual(where(now), { "work:w1": "waiting" });
    lines.push(row(now, "work:w1").line);
  }
  assert.deepEqual(lines, [
    "Paused · 43%", "Waiting to copy to server", "Waiting for series search", "Waiting for a worker", "Waiting for a worker",
  ]);
  assert.deepEqual(lines.map((_, i) => row(build({ activity: answer(queue.slice(0, queue.length - i)) }), "work:w1").entry),
    ["download", "server-copy", "series-search", "ebook-check", "reading-sync"]);
  // The save of this device comes last.
  const { saves, books } = device({
    books: [bookOf("b-w1", "w1", "r1", 12)], downloads: filesOf("r1", 3), records: [record("r1", "w1", { state: "paused" })],
  });
  assert.equal(row(build({ activity: answer([queue[0]]), saves, books }), "work:w1").entry, "reading-sync");
  assert.equal(row(build({ activity: answer([]), saves, books }), "work:w1").entry, "device-save");
});

test("in Finished today the newest entry is shown, with when it finished; rows are ordered newest change first", () => {
  const now = build({
    activity: answer([
      download("acq:1", "w1", { state: "done", updatedAt: NOW - 3 * HOUR, facts: { kind: "acquisition", status: "ready", backend: "local" } }),
      sync("align:1", "w1", "ready", { state: "done", updatedAt: NOW - HOUR }),
      download("acq:2", "w2", { state: "done", updatedAt: NOW - 2 * HOUR, facts: { kind: "acquisition", status: "ready", backend: "torbox" } }),
      download("acq:3", "w3", { state: "running", updatedAt: NOW - 5 * HOUR }),
      download("acq:4", "w4", { state: "running", updatedAt: NOW - MINUTE }),
    ]),
  });
  assert.deepEqual(group(now, "finished").map((r) => [r.key, r.line, r.finishedAt]), [
    ["work:w1", "Reading sync ready", NOW - HOUR],
    ["work:w2", "Audiobook streams from TorBox", NOW - 2 * HOUR],
  ]);
  assert.deepEqual(group(now, "progress").map((r) => r.key), ["work:w4", "work:w3"]);
  assert.equal(group(now, "progress")[0].finishedAt, null);
});

test("every line of the table: finished and failed forms of each entry, with their figures", () => {
  const done = (facts: ActivityFacts, over: Partial<ActivityItem> = {}) =>
    row(build({ activity: answer([item("x", { workId: "w", bookId: "b", facts, state: "done", ...over })]) }), "work:w");
  const failed = (facts: ActivityFacts) =>
    row(build({ activity: answer([item("x", { workId: "w", bookId: "b", facts, state: "failed", attention: true })]) }), "work:w");
  const align = (status: string, over: Partial<Extract<ActivityFacts, { kind: "alignment" }>> = {}): ActivityFacts =>
    ({ kind: "alignment", status, outcome: null, coverage: null, wholeBook: true, stage: null, files: null, ...over });

  assert.equal(done({ kind: "acquisition", status: "ready", backend: "local" }).line, "Audiobook on server");
  assert.equal(done({ kind: "acquisition", status: "ready", backend: "torbox" }).line, "Audiobook streams from TorBox");
  assert.equal(failed({ kind: "acquisition", status: "error", backend: "local" }).line, "Download failed");
  assert.equal(done({ kind: "server-copy", status: "ready" }).line, "Audiobook on server");
  assert.equal(failed({ kind: "server-copy", status: "error" }).line, "Copy to server failed");
  assert.equal(done({ kind: "series-acquisition", status: "done", search: "ebook" }).line, "Ebook on server");
  assert.equal(failed({ kind: "series-acquisition", status: "failed", search: "audiobook" }).line, "Series search failed");
  assert.equal(failed({ kind: "series-acquisition", status: "failed", search: "ebook" }).line, "Series search failed");
  assert.equal(done({ kind: "ebook-set", status: "accepted", holdReason: null }).line, "Ebook matches the narration");
  assert.equal(done({ kind: "ebook-set", status: "rejected", holdReason: null }).line, "Ebook does not match the narration");
  assert.equal(failed({ kind: "ebook-set", status: "held", holdReason: "evaluation_failed" }).line, "Check failed");
  assert.equal(done(align("ready", { outcome: "mapped" })).line, "Reading sync ready");
  assert.equal(done(align("partial", { outcome: "partial", coverage: 0.61 })).line, "Reading sync partly ready · 61% of the text");
  assert.equal(done(align("cancelled")).line, "Reading sync cancelled");
  assert.equal(failed(align("error")).line, "Reading sync stopped");
  // Every failed line is in the failed colour; no finished one is.
  assert.equal(failed(align("error")).failed, true);
  assert.equal(done(align("ready")).failed, false);

  // A finished series search for the audiobook: the download it starts takes over the row.
  const search = item("s", { workId: "w", bookId: "b", state: "done", facts: { kind: "series-acquisition", status: "done", search: "audiobook" } });
  assert.equal(build({ activity: answer([search]) }).empty, true);
  const taken = build({ activity: answer([search, download("acq:1", "w", { updatedAt: NOW - HOUR })]) });
  assert.equal(row(taken, "work:w").line, "Downloading to server · 43%");

  // Save to this device: finished and failed.
  const finished = device({
    books: [bookOf("b-w1", "w1", "r1", 12)],
    downloads: filesOf("r1", 12, 414_000_000 / 12, NOW - 2 * HOUR),
    records: [record("r1", "w1", { state: "finished", finishedAt: NOW - 2 * HOUR })],
  });
  const kept = row(build(finished), "work:w1");
  assert.equal(kept.line, "On this device · 414 MB");
  assert.equal(kept.icon, null, "a finished save of the whole book has no icon");
  assert.equal(kept.finishedAt, NOW - 2 * HOUR);
  assert.equal(row(build(failedAndPaused()), "work:w-fail").line, "Not complete · 8 of 12 files");
});

test("the series search lines and the worker's file count on a running step", () => {
  const series = (status: string, search: "audiobook" | "ebook", state: ActivityItem["state"]) =>
    row(build({ activity: answer([item("s", { workId: "w", bookId: "b", state, facts: { kind: "series-acquisition", status, search } })]) }), "work:w").line;
  assert.equal(series("pending", "audiobook", "queued"), "Waiting for series search");
  assert.equal(series("searching", "audiobook", "running"), "Searching for the audiobook");
  assert.equal(series("searching", "ebook", "running"), "Searching for the ebook");

  const step = (stage: string, files: { done: number; total: number } | null) =>
    row(build({ activity: answer([sync("a", "w", "processing", { state: "running" }, { stage, files })]) }), "work:w").line;
  assert.equal(step("encoding", { done: 24, total: 43 }), "Encoding audio · 24 of 43 files");
  assert.equal(step("decoding", { done: 3, total: 43 }), "Decoding audio · 3 of 43 files");
  assert.equal(step("aligning", null), "Aligning text");
});

test("a stuck and a blocked entry say why, under Needs attention, and light the dot", () => {
  const blocked = download("acq:1", "w1", { progress: 0.77, attention: true, stuck: { reason: "Blocked by Torrent client" }, blockedBy: "torrent" });
  const stuck = sync("align:1", "w2", "processing", { attention: true, stuck: { reason: "No change for 2 h" } }, { stage: "encoding", files: { done: 24, total: 43 } });
  const now = build({ activity: answer([blocked, stuck]) });
  assert.deepEqual(where(now), { "work:w1": "attention", "work:w2": "attention" });
  assert.equal(row(now, "work:w1").line, "Downloading to server · 77% · Blocked by Torrent client");
  assert.equal(row(now, "work:w2").line, "Encoding audio · 24 of 43 files · No change for 2 h");
  assert.equal(row(now, "work:w1").progress, null, "a stuck entry does not move");
  assert.equal(now.dot, true);
});

test("a down process and a Hardcover failure are rows that are not books, under Needs attention only", () => {
  const hardcover = item("hardcover:status:1", {
    title: "Status changes", state: "failed", attention: true, permanent: true, actions: ["discard"],
    error: "This change cannot succeed", facts: { kind: "hardcover", status: "failing", queue: "status" },
  });
  const waitingHardcover = item("hardcover:listening:1", { state: "queued", facts: { kind: "hardcover", status: "waiting", queue: "listening" } });
  const backup = item("backup:2026-11-16", { title: "Daily database backup", state: "done", facts: { kind: "backup", status: "done" } });
  const torrent = process("torrent", { label: "Torrent client", health: "down", reason: "The VPN has no connection", since: NOW - HOUR });
  const worker = process("alignment-host:lisa", {
    label: "Reading sync worker (lisa)", health: "down", reason: "Offline since 14:02",
    host: { hostId: "lisa", device: "CPU", online: false, disabled: false, revision: null, work: null, jobs: [], restarting: false, lastRestart: null },
  });
  const now = build({ activity: answer([hardcover, waitingHardcover, backup], [torrent, worker, process("ok")]) });
  assert.deepEqual(where(now), { "hardcover:status:1": "attention", torrent: "attention", "alignment-host:lisa": "attention" });
  const rows = group(now, "attention");
  for (const r of rows) {
    assert.equal(r.book, false);
    assert.equal(r.cover, null);
    assert.equal(r.icon, "server");
    assert.equal(r.failed, true);
  }
  assert.equal(row(now, "torrent").title, "Torrent client");
  assert.equal(row(now, "torrent").line, "The VPN has no connection");
  assert.deepEqual(row(now, "torrent").opens, { to: "server" });
  assert.deepEqual(row(now, "alignment-host:lisa").opens, { to: "worker", hostId: "lisa" });
  assert.equal(row(now, "hardcover:status:1").title, "Status changes");
  // A Hardcover queue is one user's: the line names whose it is (#522).
  assert.equal(row(now, "hardcover:status:1").line, "This change cannot succeed · admin");
  assert.deepEqual(row(now, "hardcover:status:1").opens, { to: "server" });
  assert.deepEqual(row(now, "hardcover:status:1").button, { action: "discard", source: "server", itemId: "hardcover:status:1" });
  assert.equal(now.dot, true);
});

test("buttons: Pause, Resume and Retry of a save; Retry, Resume or Discard of a server entry from its actions", () => {
  const { saves, books } = device({
    books: [bookOf("b-w1", "w1", "r1", 12), bookOf("b-w2", "w2", "r2", 12), bookOf("b-w3", "w3", "r3", 12)],
    downloads: [...filesOf("r1", 3), ...filesOf("r2", 3), ...filesOf("r3", 3)],
    running: { r1: { chapter: 4 } },
    records: [record("r1", "w1", {}), record("r2", "w2", { state: "paused" }), record("r3", "w3", { state: "saving" })],
  });
  const now = build({ saves, books });
  assert.equal(row(now, "work:w1").button?.action, "pause");
  assert.equal(row(now, "work:w1").line, "Saving · 3 of 12 files");
  assert.equal(row(now, "work:w1").progress, 0.25);
  assert.equal(row(now, "work:w2").button?.action, "resume");
  // A save that stopped because Sonder closed waits with Resume, and lights nothing.
  assert.equal(where(now)["work:w3"], "waiting");
  assert.equal(row(now, "work:w3").button?.action, "resume");
  assert.equal(now.dot, false);

  const server = build({
    activity: answer([
      download("acq:1", "w1", { state: "failed", attention: true, actions: ["retry"] }),
      download("acq:2", "w2", { state: "paused", actions: ["resume"], facts: { kind: "acquisition", status: "paused", backend: "local" } }),
      download("acq:3", "w3", { state: "running" }),
    ]),
  });
  assert.deepEqual(row(server, "work:w1").button, { action: "retry", source: "server", itemId: "acq:1" });
  assert.deepEqual(row(server, "work:w2").button, { action: "resume", source: "server", itemId: "acq:2" });
  assert.equal(row(server, "work:w3").button, null);
  // At most one button: Retry before Resume before Discard.
  const both = build({ activity: answer([download("acq:4", "w4", { state: "failed", attention: true, actions: ["discard", "resume", "retry"] })]) });
  assert.equal(row(both, "work:w4").button?.action, "retry");
});

test("what a row opens: the book; a reading sync running, waiting or stopped opens its Reading sync page; no work, no link", () => {
  const opens = (i: ActivityItem) => row(build({ activity: answer([i]) }), i.workId ? `work:${i.workId}` : i.id).opens;
  assert.deepEqual(opens(download("acq:1", "w1")), { to: "book", workId: "w1", bookId: "b-w1" });
  assert.deepEqual(opens(sync("a", "w1", "processing")), { to: "reading-sync", workId: "w1", bookId: "b-w1" });
  assert.deepEqual(opens(sync("a", "w1", "queued", { state: "queued" })), { to: "reading-sync", workId: "w1", bookId: "b-w1" });
  assert.deepEqual(opens(sync("a", "w1", "error", { state: "failed", attention: true })), { to: "reading-sync", workId: "w1", bookId: "b-w1" });
  assert.deepEqual(opens(sync("a", "w1", "ready", { state: "done" })), { to: "book", workId: "w1", bookId: "b-w1" });
  // An acquisition with no work yet is a book row with its own cover, and not a link.
  const orphan = row(build({ activity: answer([download("acq:9", null)]) }), "acq:9");
  assert.equal(orphan.book, true);
  assert.equal(orphan.cover, "/cover/acq:9");
  assert.equal(orphan.opens, null);
  // A save opens its book.
  assert.deepEqual(row(build(failedAndPaused()), "work:w-fail").opens, { to: "book", workId: "w-fail", bookId: "b-w-fail" });
});

test("no connection: the device's saves only, the server's answer ignored; an unfinished save waits with no bar or Resume", () => {
  const { saves, books } = device({
    books: [bookOf("b-w1", "w1", "r1", 12), bookOf("b-w2", "w2", "r2", 12)],
    downloads: [...filesOf("r1", 3), ...filesOf("r2", 8)],
    running: { r1: { chapter: 4, loaded: 1, size: 2 } },
    records: [record("r1", "w1", {}), record("r2", "w2", { state: "failed", reason: "Network" })],
  });
  const server = answer(
    [download("acq:1", "w3", { attention: true, state: "failed" }), download("acq:2", "w1")],
    [process("torrent", { health: "down", reason: "VPN" })],
  );
  const now = build({ activity: server, saves, books, online: false });
  assert.equal(now.offline, true);
  assert.deepEqual(where(now), { "work:w1": "waiting", "work:w2": "attention" });
  assert.equal(row(now, "work:w1").line, "Not complete · 3 of 12 files");
  assert.equal(row(now, "work:w1").entry, "device-save");
  assert.equal(row(now, "work:w1").progress, null);
  assert.equal(row(now, "work:w1").button, null);
  // Only the device's failed saves count for the dot without a connection.
  assert.equal(now.dot, true);
  assert.equal(build({ activity: server, online: false }).dot, false);
  assert.equal(build({ activity: server, online: false }).empty, true);
});

test("not the administrator: the device's saves only, also when an answer is passed", () => {
  const { saves, books } = failedAndPaused();
  const server = answer([download("acq:1", "w9", { attention: true, state: "failed" })], [process("torrent", { health: "down" })]);
  const now = build({ activity: server, saves, books, admin: false });
  assert.deepEqual(where(now), { "work:w-fail": "attention", "work:w-wait": "waiting" });
  assert.equal(now.dot, true);
  assert.equal(build({ activity: server, admin: false }).dot, false);
});

test("the dot for each reason", () => {
  const lit = (activity: ActivityResponse) => build({ activity }).dot;
  assert.equal(lit(answer([download("a", "w", { state: "failed", attention: true, updatedAt: NOW - 6 * DAY })])), true, "a failure of six days");
  assert.equal(lit(answer([download("a", "w", { attention: true, stuck: { reason: "No change for 2 h" } })])), true, "stuck");
  assert.equal(lit(answer([download("a", "w", { attention: true, stuck: { reason: "Blocked by Torrent client" }, blockedBy: "t" })])), true, "blocked");
  assert.equal(lit(answer([], [process("torrent", { health: "down", reason: "VPN" })])), true, "a process that is down");
  assert.equal(build(failedAndPaused()).dot, true, "a failed save on this device");
  // The dot is exactly whether Needs attention holds a row.
  const now = build({ activity: answer([download("a", "w", { state: "failed", attention: true })]) });
  assert.equal(now.dot, group(now, "attention").length > 0);
});

test("no dot for a paused queue, a worker not in use, a degraded process, a failure older than seven days or a paused save", () => {
  const notInUse = process("alignment-host:lisa", {
    health: "unknown", reason: "Not in use",
    host: { hostId: "lisa", device: "CPU", online: false, disabled: true, revision: null, work: null, jobs: [], restarting: false, lastRestart: null },
  });
  // Even if a worker switched off were reported down, it lights nothing.
  const offAndDown = { ...notInUse, id: "alignment-host:off", health: "down" as const, host: { ...notInUse.host!, hostId: "off" } };
  const now = build({
    activity: answer(
      [
        download("old", "w1", { state: "failed", attention: false, updatedAt: NOW - 8 * DAY }),
        download("paused", "w2", { state: "paused", facts: { kind: "acquisition", status: "paused", backend: "local" } }),
      ],
      [
        process("downloads", { type: "loop", pausable: true, paused: true }),
        process("server-copy", { type: "loop", pausable: true, paused: true, lockedBy: "environment" }),
        notInUse, offAndDown,
        process("hardcover-sync", { health: "degraded", reason: "1 failed" }),
        process("imports", { health: "unknown", notTracked: true, reason: "Not tracked yet." }),
        // A process that is not tracked lights nothing, whatever it reports.
        process("untracked", { health: "down", notTracked: true, reason: "Not tracked yet." }),
      ],
    ),
    ...device({
      books: [bookOf("b-w3", "w3", "r3", 12)], downloads: filesOf("r3", 3), records: [record("r3", "w3", { state: "paused" })],
    }),
  });
  assert.equal(now.dot, false);
  assert.deepEqual(group(now, "attention"), []);
  // The failure older than seven days is not listed on Now at all; the paused work waits.
  assert.deepEqual(where(now), { "work:w2": "waiting", "work:w3": "waiting" });
});

test("finished work older than 24 hours and a save finished more than 24 hours ago are not on Now", () => {
  const old = device({
    books: [bookOf("b-w1", "w1", "r1", 2)],
    downloads: filesOf("r1", 2, MB, NOW - 2 * DAY),
    records: [record("r1", "w1", { state: "finished", finishedAt: NOW - 2 * DAY })],
  });
  const now = build({
    activity: answer([download("acq:1", "w2", { state: "done", updatedAt: NOW - 25 * HOUR, facts: { kind: "acquisition", status: "ready", backend: "local" } })]),
    ...old,
  });
  assert.equal(now.empty, true);
});

test("an ebook kept for reading offline is not an entry on Now", () => {
  const { saves, books } = device({ ebooks: [{ id: "e1", workId: "w1", size: MB }] });
  assert.equal(saves.length, 1);
  assert.equal(build({ saves, books }).empty, true);
});

test("a save's row takes the server's title and cover when the device does not know the book", () => {
  const { saves } = failedAndPaused();
  const now = build({ activity: answer([sync("a", "w-fail", "queued", { state: "queued", title: "Feral Gods", cover: "/feral" })]), saves, books: [] });
  assert.equal(row(now, "work:w-fail").entry, "device-save");
  assert.equal(row(now, "work:w-fail").title, "Feral Gods");
  assert.equal(row(now, "work:w-fail").cover, "/feral");
});

test("a Hardcover failure with no user says only its reason; a backup's failure has none either (#522)", () => {
  const hardcover = item("hardcover:reading:3", {
    title: "Reading changes", state: "failed", attention: true, user: null, actions: ["retry"],
    error: "socket hang up", facts: { kind: "hardcover", status: "failing", queue: "reading" },
  });
  const backup = item("backup:1", {
    title: "Daily database backup", state: "failed", attention: true, user: null, error: "Disk full", facts: { kind: "backup", status: "failed" },
  });
  const now = build({ activity: answer([hardcover, backup]) });
  assert.equal(row(now, "hardcover:reading:3").line, "socket hang up");
  assert.equal(row(now, "backup:1").line, "Disk full");
});

test("a series search's line has the icon of the file it looks for (#522)", () => {
  const search = (id: string, workId: string, kind: "audiobook" | "ebook", state: ActivityItem["state"]) =>
    item(id, { workId, bookId: `b-${workId}`, title: `Book ${workId}`, state, updatedAt: NOW - HOUR, facts: { kind: "series-acquisition", status: state === "done" ? "done" : "searching", search: kind } });
  const now = build({ activity: answer([search("s1", "w1", "ebook", "done"), search("s2", "w2", "audiobook", "running"), search("s3", "w3", "ebook", "running")]) });
  assert.equal(row(now, "work:w1").line, "Ebook on server");
  assert.equal(row(now, "work:w1").icon, "ebook");
  assert.equal(row(now, "work:w2").line, "Searching for the audiobook");
  assert.equal(row(now, "work:w2").icon, "audiobook");
  assert.equal(row(now, "work:w3").icon, "ebook");
});

// #718: a sync of a spare edition (an EPUB nobody reads, queued by itself) is not the book being synced again.
const spare = { spare: true, background: true } as const;

test("one sync of a spare edition reads 'Checking another edition' and waits, without a bar (#718)", () => {
  const now = build({
    activity: answer([sync("alignment:s1", "w-hs", "processing", { state: "running", progress: 0.2 }, { ...spare, stage: "encoding", files: { done: 0, total: 2 } })]),
  });
  assert.deepEqual(where(now), { "work:w-hs": "waiting" });
  const shown = row(now, "work:w-hs");
  assert.equal(shown.line, "Checking another edition");
  assert.equal(shown.progress, null);
  assert.equal(shown.entry, "reading-sync");
  assert.equal(now.dot, false);
});

test("a backfill of several spare editions is one row per book with the one being checked (#718)", () => {
  const items = [
    // Hydrogen Sonata: one ended today, one runs, two wait.
    sync("alignment:h1", "w-hs", "ready", { state: "done", updatedAt: NOW - HOUR }, spare),
    sync("alignment:h2", "w-hs", "processing", { state: "running", progress: 0.1 }, { ...spare, stage: "encoding", files: { done: 0, total: 2 } }),
    sync("alignment:h3", "w-hs", "queued", { state: "queued" }, spare),
    sync("alignment:h4", "w-hs", "queued", { state: "queued" }, spare),
    // Consider Phlebas: four wait, none started.
    ...[1, 2, 3, 4].map((n) => sync(`alignment:c${n}`, "w-cp", "queued", { state: "queued" }, spare)),
    // One that ended yesterday is not counted.
    sync("alignment:c0", "w-cp", "ready", { state: "done", updatedAt: NOW - 2 * DAY }, spare),
  ];
  const now = build({ activity: answer(items) });
  assert.deepEqual(where(now), { "work:w-hs": "waiting", "work:w-cp": "waiting" });
  assert.equal(row(now, "work:w-hs").line, "Checking 4 other editions · 2 of 4");
  assert.equal(row(now, "work:w-cp").line, "Checking 4 other editions · 1 of 4");
  assert.equal(group(now, "progress").length, 0, "nothing under In progress");
  assert.equal(group(now, "finished").length, 0, "a finished spare sync is not listed under Finished today");
});

test("the read edition's own sync stays In progress beside its spare editions; a Prepare of a spare edition is not background (#718)", () => {
  const now = build({
    activity: answer([
      sync("alignment:own", "w-own", "processing", { state: "running", progress: 0.5 }, { stage: "encoding", files: { done: 1, total: 2 }, spare: false, background: true }),
      sync("alignment:spare", "w-own", "queued", { state: "queued" }, spare),
      // The administrator prepared this spare edition: it reads as the sync it is.
      sync("alignment:asked", "w-asked", "processing", { state: "running", progress: 0.3 }, { stage: "encoding", files: { done: 0, total: 2 }, spare: true, background: false }),
    ]),
  });
  assert.deepEqual(where(now), { "work:w-own": "progress", "work:w-asked": "progress" });
  assert.equal(row(now, "work:w-own").line, "Encoding audio · 1 of 2 files");
  assert.equal(row(now, "work:w-asked").line, "Encoding audio · 0 of 2 files");
});

test("a spare edition's sync that stopped still needs attention (#718)", () => {
  const now = build({ activity: answer([sync("alignment:x", "w-x", "error", { state: "failed", attention: true, actions: ["retry"] }, spare)]) });
  assert.deepEqual(where(now), { "work:w-x": "attention" });
  assert.equal(row(now, "work:w-x").line, "Reading sync stopped");
});

test("a book whose spare-edition syncs all ended today is not listed under Finished today (#718)", () => {
  const now = build({
    activity: answer([
      sync("alignment:d1", "w-done", "ready", { state: "done", updatedAt: NOW - HOUR }, spare),
      sync("alignment:d2", "w-done", "partial", { state: "done", updatedAt: NOW - 2 * HOUR }, { ...spare, coverage: 0.9 }),
      // The read edition's own sync that finished today is listed as before.
      sync("alignment:mine", "w-mine", "ready", { state: "done", updatedAt: NOW - HOUR }, { spare: false, background: true }),
    ]),
  });
  assert.deepEqual(where(now), { "work:w-mine": "finished" });
});

test("a stuck download says why and offers Cancel; a failing one Retry with Cancel beside it; a cancelled one is finished (#716)", () => {
  const now = build({
    activity: answer([
      download("acquisition:got", "got", {
        progress: 0.0011, stuck: { reason: "No seeders", known: true }, attention: true, actions: ["cancel"], updatedAt: NOW - 2 * HOUR,
      }),
      download("acquisition:bad", "bad", {
        state: "failed", attention: true, actions: ["retry", "cancel"], facts: { kind: "acquisition", status: "error", backend: "local" },
      }),
      download("acquisition:gone", "gone", {
        state: "done", updatedAt: NOW - 5 * MINUTE, facts: { kind: "acquisition", status: "cancelled", backend: "local" },
      }),
      download("acquisition:old", "old", { progress: 0.2, stuck: { reason: "No change for 2 h" }, attention: true, actions: [] }),
    ]),
  });
  const stuck = row(now, "work:got");
  assert.equal(where(now)["work:got"], "attention");
  assert.equal(stuck.line, "No seeders · Downloading to server · 0%", "the named cause leads, so a phone shows it");
  assert.deepEqual(stuck.button, { action: "cancel", source: "server", itemId: "acquisition:got" });
  assert.equal(stuck.cancel, undefined, "Cancel is the button itself: not twice");
  const failing = row(now, "work:bad");
  assert.equal(failing.line, "Download failed");
  assert.deepEqual(failing.button, { action: "retry", source: "server", itemId: "acquisition:bad" });
  assert.deepEqual(failing.cancel, { action: "cancel", source: "server", itemId: "acquisition:bad" });
  const cancelled = row(now, "work:gone");
  assert.equal(where(now)["work:gone"], "finished");
  assert.equal(cancelled.line, "Download cancelled");
  assert.equal(cancelled.button, null);
  // An answer of a server from before #716: the current line and no button, as before.
  const before = row(now, "work:old");
  assert.equal(before.line, "Downloading to server · 20% · No change for 2 h");
  assert.equal(before.button, null);
  assert.equal(before.cancel, undefined);
});

test("a stalled download of a book that already has a copy says so, offers Cancel and stays under In progress (#716)", () => {
  const now = build({
    activity: answer([
      download("acquisition:got", "got", { progress: 0.0011, superseded: true, actions: ["cancel"], updatedAt: NOW - 2 * HOUR }),
      download("acquisition:tb", "tb", {
        progress: null, superseded: true, actions: ["cancel"], facts: { kind: "acquisition", status: "preparing", backend: "torbox" },
      }),
    ]),
  });
  assert.equal(where(now)["work:got"], "progress", "not under Needs attention");
  const got = row(now, "work:got");
  assert.equal(got.line, "This book already has a copy · Downloading to server · 0%");
  assert.equal(got.progress, null, "no bar for a download that does not move");
  assert.equal(got.failed, false);
  assert.deepEqual(got.button, { action: "cancel", source: "server", itemId: "acquisition:got" });
  assert.equal(got.cancel, undefined);
  assert.equal(row(now, "work:tb").line, "This book already has a copy · Preparing the stream");
  assert.equal(now.dot, false, "nothing needs attention: no dot");
});
