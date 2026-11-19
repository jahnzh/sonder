/**
 * The JSON of `GET /api/activity` for one fixed set of rows (#392): every status each feature writes, a few
 * values outside every vocabulary, finished and old rows, probes that answer and probes that fail.
 *
 * - `tests/fixtures/activity-golden-before-sources.json` was recorded from the Activity module before it was split
 *   into per-feature sources, for the rows without an intended change (statuses outside a vocabulary, and failed
 *   series acquisitions, #397). The JSON text must stay identical, key order included. Never rewrite it.
 * - `tests/fixtures/activity-golden.json` is the current output for all rows. Rewrite it only for an intended change,
 *   with `SONDER_UPDATE_ACTIVITY_GOLDEN=1 npx tsx --test tests/activity-golden.test.ts`, and review the diff.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TorrentHealth } from "../src/types.ts";
import type { AlignmentPoolStatus } from "../src/reading-types.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-activity-golden-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
const { sqlite } = await import("../server/db.ts");
const { collectActivity } = await import("../server/activity.ts");
const { ACTIVITY_SOURCES } = await import("../server/activity-sources.ts");
after(() => rmSync(temp, { recursive: true, force: true }));

const GOLDEN = new URL("./fixtures/activity-golden.json", import.meta.url);
const BEFORE_SOURCES = new URL("./fixtures/activity-golden-before-sources.json", import.meta.url);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(2,'sam',NULL,'user',?)", NOW);
run("INSERT INTO works(id,title,author,description,genre,year) VALUES('w1','Speaker for the Dead','Card','','',1986)");
run("INSERT INTO works(id,title,author,description,genre,year) VALUES('w2','Xenocide','Card','','',1991)");
// Neither edition has a track, so both are placeholders: a work lends its cover, and no edition id is sent (#514).
run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed1','w1','/covers/ed1.jpg','',0,'')");
run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed2','w2','/covers/ed2.jpg','',0,'')");
run("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(7,'Ender','Card',4)");

// Acquisitions: every status `server/acquisitions.ts`, `server/app.ts` and `server/series-removal.ts` write,
// the words the old mapping also recognised, and one nobody writes.
const acquisitions: Array<[string, string, string, number, string | null, number]> = [
  ["checking", "local", "checking", 0, null, NOW - MIN],
  ["preparing", "torbox", "preparing", 0.1, null, NOW - 2 * MIN],
  ["downloading", "local", "downloading", 0.5, null, NOW - 3 * MIN],
  ["blocked", "local", "downloading", 0.6, "The local torrent client cannot be reached.", NOW - 4 * MIN],
  ["paused", "local", "paused", 0.2, null, NOW - 5 * MIN],
  ["ready", "torbox", "ready", 1, null, NOW - 6 * MIN],
  ["ready-old", "local", "ready", 1, null, NOW - 2 * DAY],
  ["error", "local", "error", 0.3, "No seeders", NOW - 7 * MIN],
  ["error-old", "local", "error", 0.3, "Removed with series.", NOW - 9 * DAY],
  ["legacy-queued", "local", "queued", 0, null, NOW - 8 * MIN],
  ["legacy-complete", "local", "complete", 1, null, NOW - 9 * MIN],
  ["legacy-completed", "local", "completed", 1, null, NOW - 10 * MIN],
  ["legacy-done", "local", "done", 1, null, NOW - 11 * MIN],
  ["unknown", "local", "exploded", 0.4, null, NOW - 12 * MIN],
];
for (const [id, backend, status, progress, error, updated] of acquisitions)
  run("INSERT INTO acquisitions(id,hash,magnet,backend,title,author,cover,status,progress,error,created_at,updated_at) VALUES(?,?,?,?,?,?,'',?,?,?,?,?)",
    `acq-${id}`, `hash-${id}`, `magnet:?xt=urn:btih:${id}`, backend, `Book ${id}`, id === "unknown" ? "" : "Card", status, progress, error, NOW - DAY / 2, updated);

// Two downloads of a work (#514): by its `work_id`, and by its audio edition when it has no `work_id`. The ready one
// has no work yet and keeps its own cover.
run("UPDATE acquisitions SET work_id = 'w1' WHERE id = 'acq-downloading'");
run("UPDATE acquisitions SET book_id = 'ed2' WHERE id = 'acq-paused'");
run("UPDATE acquisitions SET cover = '/covers/torbox.jpg' WHERE id = 'acq-ready'");

// Copies to the server: every status `server/downloads.ts` writes, the old extra word, one nobody writes.
const copies: Array<[string, string, string, number, string | null, number]> = [
  ["queued", "ed1", "queued", 0, null, NOW - MIN],
  ["downloading", "ed1", "downloading", 0.4, null, NOW - 2 * MIN],
  ["paused", "ed2", "paused", 0.5, null, NOW - 3 * MIN],
  ["ready", "ed2", "ready", 1, null, NOW - 4 * MIN],
  ["error", "ed1", "error", 0.2, "HTTP 500", NOW - 5 * MIN],
  ["legacy-done", "ed2", "done", 1, null, NOW - 6 * MIN],
  ["unknown", "ed1", "exploded", 0.1, null, NOW - 7 * MIN],
];
for (const [id, edition, status, progress, error, updated] of copies) {
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${id}`, edition);
  run("INSERT INTO server_downloads(recording_id,book_id,status,progress,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    `rec-${id}`, edition, status, progress, error, NOW - DAY / 2, updated);
}

// Series acquisition: every status the CHECK constraint allows, with the error codes the feature stores.
const series: Array<[string, number, string, string, string | null, number]> = [
  ["pending", 1, "audio", "pending", null, NOW - MIN],
  ["searching", 2, "ebook", "searching", null, NOW - 2 * MIN],
  ["done", 1, "ebook", "done", "has_ebook", NOW - 3 * MIN],
  ["failed", 2, "audio", "failed", "No release found", NOW - 4 * MIN],
  ["failed-permission", 2, "ebook", "failed", "no_permission", NOW - 5 * MIN],
];
series.forEach(([id, user, kind, status, error, updated], index) => {
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'Card','','',2000)", `ws-${id}`, `Ender volume ${index + 1}`);
  run("INSERT INTO series_acquisition_jobs(id,user_id,series_id,book_id,work_id,kind,status,error,updated_at) VALUES(?,?,7,?,?,?,?,?,?)",
    `series-${id}`, user, 100 + index, `ws-${id}`, kind, status, error, updated);
});

// Alignment: every status of `AlignmentJob["status"]`, a record without a status, an unreadable one, an unknown word.
const alignments: Array<[string, string | null, Record<string, unknown> | string, number]> = [
  ["queued", "eb-1", { status: "queued", progress: 0 }, NOW - MIN],
  ["copying", "eb-1", { status: "copying", progress: 0.1, pool: { hostId: "wsl" } }, NOW - 2 * MIN],
  ["processing", "eb-1", { status: "processing", progress: 0.5, pool: { hostId: "lisa" }, createdAt: NOW - 60 * MIN }, NOW - 25 * MIN],
  ["paused", "eb-1", { status: "paused", progress: 0.3 }, NOW - 3 * MIN],
  ["cancelled", "eb-1", { status: "cancelled", progress: 0.3 }, NOW - 4 * MIN],
  ["ready", "set-consensus:w1", { status: "ready", progress: 0.9, outcome: "complete" }, NOW - 5 * MIN],
  ["partial", "eb-1", { status: "partial", progress: 0.7, rebuildOf: { engine: "old", status: "ready", requestedAt: NOW - DAY } }, NOW - 6 * MIN],
  ["error", "eb-1", { status: "error", progress: 1.7, error: "The worker stopped." }, NOW - 7 * MIN],
  // A new map the #379 rule did not use: the map in use stays (#539).
  ["rejected", "eb-1", { status: "error", outcome: "rejected", progress: 1, coverage: 0, rebuildOf: { engine: "old", status: "ready", requestedAt: NOW - DAY },
    error: "The rebuild was rejected: it mapped none of the text. The previous map (82% of the text mapped) stays published." }, NOW - 8 * MIN],
  ["no-status", "eb-1", { progress: -1 }, NOW - 2 * MIN], // same rank and time as hardcover:status:2: pins the tie order
  ["unreadable", "eb-1", "{not json", NOW - 9 * MIN],
  ["unknown", "eb-1", { status: "exploded", progress: 0.2 }, NOW - 10 * MIN],
];
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-1','w1','epub','x')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('set-consensus:w1','w1','epub','x')");
for (const [id, ebook, data, updated] of alignments) {
  const recording = `rec-align-${id}`;
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", recording, "ed1");
  run("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,?,?,?,?)",
    `align-${id}`, ebook, recording, typeof data === "string" ? data : JSON.stringify(data), updated);
}

// Hardcover: one queue of each kind per user, waiting, failing transiently, failing for good, waiting long. The tables
// stay, unused, since Hardcover went (#721 part d): Activity must list none of these rows.
run("INSERT INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,intent,updated_at,error) VALUES(1,11,1,1,'add',?,?)", NOW - 5 * DAY, "We weren't able to find that book. Was it deleted?");
run("INSERT INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,intent,updated_at,error) VALUES(1,12,1,1,'add',?,NULL)", NOW - MIN);
run("INSERT INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,intent,updated_at,error) VALUES(2,13,1,1,'add',?,NULL)", NOW - 2 * MIN);
run("INSERT INTO user_hardcover_progress(user_id,book_id,account_id,recording_id,position,duration,updated_at,error) VALUES(1,21,1,'rec-queued',10,100,?,?)", NOW - 3 * MIN, "socket hang up");
run("INSERT INTO user_hardcover_reading_outbox(user_id,book_id,account_id,work_id,fraction,updated_at,error) VALUES(2,31,1,'w1',0.5,?,NULL)", NOW - 45 * MIN);

// Ebook-set members (#325): every status and hold; the holds for audio and language are not background work. Of
// the pending members, eb-pending waits for its turn; eb-pending-old is being checked since 5 min (its row is 2 h
// old, so it is not stuck); the check of eb-pending-stuck started 2 h ago, past its threshold.
const members: Array<[string, string, string | null, string, number]> = [
  ["eb-pending", "pending", null, "{}", NOW - 5 * MIN],
  ["eb-pending-old", "pending", null, "{}", NOW - 2 * 60 * MIN],
  ["eb-pending-stuck", "pending", null, "{}", NOW - 3 * 60 * MIN],
  ["eb-worker", "held", "awaiting_worker", "{}", NOW - 6 * MIN],
  ["eb-failed", "held", "evaluation_failed", JSON.stringify({ error: "This file is not a valid EPUB." }), NOW - 7 * MIN],
  ["eb-accepted", "accepted", null, "{}", NOW - 8 * MIN],
  ["eb-rejected", "rejected", null, "{}", NOW - 9 * MIN],
  ["eb-accepted-old", "accepted", null, "{}", NOW - 2 * DAY],
  ["eb-audio", "held", "awaiting_audio", "{}", NOW - 10 * MIN],
  ["eb-language", "held", "language_not_supported", "{}", NOW - 11 * MIN],
  ["eb-unknown", "exploded", null, "{}", NOW - 12 * MIN],
];
for (const [ebookId, status, holdReason, evidence, updated] of members) {
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,'w2','epub',?)", ebookId, `/media/${ebookId}.epub`);
  run("INSERT INTO work_ebook_set_members(work_id,ebook_id,status,hold_reason,source_title,evidence,updated_at) VALUES('w2',?,?,?,?,?,?)",
    ebookId, status, holdReason, `Edition ${ebookId}`, evidence, updated);
}

const { ebookSetCheckStarted } = await import("../server/ebook-set-activity.ts");
ebookSetCheckStarted("w2", "eb-pending-old", NOW - 5 * MIN);
ebookSetCheckStarted("w2", "eb-pending-stuck", NOW - 2 * 60 * MIN);

const torrentDown: TorrentHealth = {
  status: "unreachable", session: false, network: "unknown", version: null, message: "The local torrent client cannot be reached.", checkedAt: NOW,
};
const pool: AlignmentPoolStatus = {
  enabled: true, engine: "ctc", checkedAt: NOW,
  hosts: [
    { id: "wsl", sshTarget: "wsl", workerUrl: "http://x", reachable: false, device: null, precision: null, busy: false, stuck: false, activeJobs: 0, maxConcurrent: 1, lastError: "ssh: no route to host" },
    { id: "lisa", sshTarget: "lisa", workerUrl: "http://y", reachable: true, device: null, precision: null, busy: true, stuck: false, activeJobs: 1, maxConcurrent: 1, lastError: null },
  ],
};

const deps = (over: Record<string, unknown>) => ({
  sqlite,
  getSetting: (key: string) => (key === "activityStuckMultiplier" ? "1" : undefined),
  torrentHealth: async () => torrentDown,
  poolStatus: async () => pool,
  requireAdmin: () => {},
  syncHardcover: async () => ({}),
  pauseState: () => ({
    acquisitions: { paused: false, locked: false },
    "server-copies": { paused: true, locked: false },
    "series-acquisition": { paused: false, locked: true },
    "hardcover-sync": { paused: false, locked: false },
    alignment: { paused: false, locked: false },
    "ebook-set": { paused: false, locked: false },
  }),
  setPaused: () => {},
  now: () => NOW,
  ...over,
}) as any;

const snapshots = async (sources = ACTIVITY_SOURCES) => ({
  probesAnswer: await collectActivity(deps({}), { probes: true }, sources),
  probesFail: await collectActivity(deps({
    torrentHealth: async () => { throw new Error("ECONNREFUSED"); },
    poolStatus: () => { throw new Error("ssh timed out"); },
  }), { probes: true }, sources),
  noProbes: await collectActivity(deps({}), { probes: false }, sources),
});

/** The sources that existed when the Activity module was split; the ebook-set checks came later (#325). */
const sourcesAtSplit = ACTIVITY_SOURCES.filter((source) => source.kind !== "ebook-set");

/**
 * The record from before the split, less what went with Hardcover (#721 part d): its queues' items and the Hardcover
 * sync process, and what they added to the count needing attention. Their rows stay in the database, unused; Activity
 * no longer lists them. Everything else is the record's own text, key order included.
 */
function withoutHardcover(recorded: string) {
  type Item = { kind: string; state: string; stuck: unknown };
  const answers = JSON.parse(recorded) as Record<string, { processes: { id: string }[]; items: Item[]; attention: number }>;
  for (const answer of Object.values(answers)) {
    answer.processes = answer.processes.filter((process) => process.id !== "hardcover-sync");
    const gone = answer.items.filter((item) => item.kind === "hardcover");
    answer.items = answer.items.filter((item) => item.kind !== "hardcover");
    // The record counted a failed or stuck item as needing attention.
    answer.attention -= gone.filter((item) => item.state === "failed" || item.stuck).length;
  }
  return `${JSON.stringify(answers, null, 2)}\n`;
}

/**
 * Rows whose Activity state changes on purpose with #392 (statuses outside a vocabulary, failed series jobs), and the
 * rejected reading sync added with #539, which the record from before the split does not have.
 */
function deleteIntendedChanges() {
  run("DELETE FROM acquisitions WHERE status NOT IN ('checking','preparing','downloading','paused','ready','error')");
  run("DELETE FROM server_downloads WHERE status NOT IN ('queued','downloading','paused','ready','error')");
  run("DELETE FROM series_acquisition_jobs WHERE status = 'failed'");
  run("DELETE FROM alignment_jobs WHERE id = 'align-unknown'");
  run("DELETE FROM alignment_jobs WHERE id = 'align-rejected'"); // added after the split, with #539
}

/**
 * The backups process changes on purpose with #361: it was listed as not tracked, and is a source now. For the
 * comparison with the record from before the split, put back the row it had then, last in the list.
 */
const UNTRACKED_BACKUPS = {
  id: "backups", label: "Database backups", type: "loop", notTracked: true, pausable: false, paused: false, lockedBy: null,
  pauseEffect: null, health: "unknown", reason: "Not tracked yet.", since: null, counts: { running: 0, queued: 0, failed: 0, stuck: 0 },
};
function withBackupsUntracked(all: Record<string, { processes: Array<{ id: string }> }>) {
  for (const snapshot of Object.values(all)) {
    const tracked = snapshot.processes.filter((process) => process.id === "backups");
    assert.equal(tracked.length, 1, "the backups source reports its process once");
    snapshot.processes = [...snapshot.processes.filter((process) => process.id !== "backups"), UNTRACKED_BACKUPS];
  }
  return all;
}

/**
 * The items gained their book, cover, status facts and `attention` on purpose with #514. Take them off again, so the
 * comparison with the record from before the split still proves that nothing else moved. Never rewrite that record.
 */
function withoutBookAndFacts<All extends Record<string, { items: object[] }>>(all: All): All {
  for (const snapshot of Object.values(all))
    for (const item of snapshot.items as Array<Record<string, unknown>>)
      for (const field of ["workId", "bookId", "cover", "facts", "attention"]) delete item[field];
  return all;
}

/**
 * Downloads and reading syncs gained Retry and Resume on purpose with #515; before, they offered no action. Take them
 * off again for the comparison with the record from before the split. Never rewrite that record.
 */
function withoutActionsOf515<All extends Record<string, { items: Array<{ kind: string; actions: string[] }> }>>(all: All): All {
  for (const snapshot of Object.values(all))
    for (const item of snapshot.items) if (item.kind === "acquisition" || item.kind === "alignment") item.actions = [];
  return all;
}

/** The worker host rows gained their status and controls on purpose with #357 PR 3 (`host`); the rest is unchanged. */
function withoutHostDetail(all: Record<string, { processes: Array<{ id: string; host?: unknown }> }>) {
  for (const snapshot of Object.values(all)) for (const process of snapshot.processes) delete process.host;
  return all;
}

/**
 * The names the server sends changed on purpose with #495 ("Reading sync" is the only name for it, the queues take the
 * names on the boards, the pause sentences are the design's tooltips). Put the old words back, so the comparison with
 * the record from before the split still proves that nothing else moved. Never rewrite that record.
 */
const NAMES_BEFORE_495: Array<[string, string]> = [
  ['"label": "Reading sync queue"', '"label": "Alignment processor"'],
  ['"label": "Reading sync workers"', '"label": "Alignment workers"'],
  ['"label": "Reading sync worker (', '"label": "Alignment worker ('],
  ["Blocked by Reading sync worker (", "Blocked by Alignment worker ("],
  ['"label": "Series search"', '"label": "Series acquisition"'],
  ['"label": "Ebook checks"', '"label": "Ebook set checks"'],
  ['"detail": "Reading sync rebuild rejected, the earlier one is kept"', '"detail": "Alignment map rebuild rejected, previous map kept"'],
  ['"detail": "Reading sync rebuild"', '"detail": "Alignment map rebuild"'],
  ['"detail": "Reading sync"', '"detail": "Alignment map"'],
  ["Ebook set check waiting for a worker", "Ebook set check waiting for an alignment worker"],
  ["Off: Sonder stops checking downloads, so finished ones do not join the library. They keep downloading in the torrent client.",
    "Sonder stops checking downloads, so finished torrents are not imported. The torrents keep downloading in the torrent client."],
  ["Off: no new copy to the server starts. One that is running finishes.", "No new copy to the server starts. A copy already running finishes."],
  ["Off: no new search or download for a series starts.", "No new series search or download starts."],
  ["Off: your changes are still saved, but nothing is sent to Hardcover until it is on again. Sync now still works.",
    "Your changes keep being saved, but nothing is sent to Hardcover until you resume. Sync now still works."],
  ["Off: no new reading sync starts. One that is running finishes.", "No new alignment job starts. A job already running finishes."],
  ["Off: no new check of an ebook against the narration starts. One that is running finishes. Turning the reading sync queue off holds these checks too.",
    "No new ebook-set check starts. A check already running finishes. Pausing alignment also holds the checks."],
  ["Off: no new daily backup starts. One that is running finishes. A deploy still makes its own backup.",
    "No new daily database backup starts. A backup already running finishes. Deploys still make their own backups."],
];
// The record from before the split has no ebook-set source, so some of the pairs match nothing in it.
const withNamesBefore495 = (text: string) => NAMES_BEFORE_495.reduce((out, [now, before]) => out.split(now).join(before), text);

test("no process name or item detail the server sends says alignment, and the ids stay (#495)", async () => {
  const all = await snapshots();
  const names: string[] = [];
  for (const snapshot of Object.values(all)) {
    for (const process of snapshot.processes) names.push(process.label);
    for (const item of snapshot.items) names.push(item.detail ?? "");
  }
  assert.ok(names.length > 40, "the rows cover every kind of process and item");
  assert.deepEqual(names.filter((name) => /alignment/i.test(name)), []);
  assert.deepEqual(all.probesAnswer.processes.map((process) => process.id), [
    "acquisitions", "server-copies", "series-acquisition", "alignment", "ebook-set", "backups", "torrent-client",
    "alignment-host:wsl", "alignment-host:lisa", "imports",
  ]);
  assert.deepEqual(all.probesFail.processes.map((process) => process.id).filter((id) => id.startsWith("alignment")), ["alignment", "alignment-pool"]);
  const labels = Object.fromEntries(all.probesAnswer.processes.map((process) => [process.id, process.label]));
  assert.equal(labels.alignment, "Reading sync queue");
  assert.equal(labels["alignment-host:wsl"], "Reading sync worker (wsl)");
  assert.equal(labels["series-acquisition"], "Series search");
  assert.equal(labels["ebook-set"], "Ebook checks");
  assert.equal(all.probesFail.processes.find((process) => process.id === "alignment-pool")?.label, "Reading sync workers");
  assert.equal(all.probesAnswer.items.some((item) => item.id.startsWith("hardcover:")), false, "no Hardcover queue is listed");
  for (const id of ["acquisitions", "server-copies", "backups", "torrent-client", "imports"]) {
    assert.equal(labels[id], { acquisitions: "Download queue", "server-copies": "Copies to server", backups: "Database backups", "torrent-client": "Torrent client", imports: "Imports" }[id], id);
  }
  assert.equal(new Set(all.probesAnswer.items.map((item) => item.detail)).has("Reading sync rebuild"), true);
});

test("GET /api/activity returns the recorded JSON for the same rows", async () => {
  const all = await snapshots();
  if (process.env.SONDER_UPDATE_ACTIVITY_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(all, null, 2)}\n`);
  assert.deepEqual(all, JSON.parse(readFileSync(GOLDEN, "utf8")));

  deleteIntendedChanges();
  const unchanged = withNamesBefore495(`${JSON.stringify(withBackupsUntracked(withoutHostDetail(withoutBookAndFacts(withoutActionsOf515(await snapshots(sourcesAtSplit))))), null, 2)}\n`);
  assert.equal(unchanged, withoutHardcover(readFileSync(BEFORE_SOURCES, "utf8")), "same rows, same JSON text as before the split into sources");
});
