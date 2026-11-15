// Rollback safety and cost of the derived work media state (issue #395, ADR 0011).
// - materialiseWorkMediaStates writes the derived state into the stored columns, so the
//   image from before ADR 0011, which reads them, sees the same states after a rollback.
// - The batched read uses indexes, not full scans of the audio and acquisition tables.
// - Reads never write. A hold is returned as stored and cleared only by an acquisition
//   reaching `ready` (for every user of it) or by the user's retry.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const temp = mkdtempSync(join(tmpdir(), "sonder-work-media-rollback-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const { sqlite, db } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { setAcquisitionStatus, startAcquisitionRecord } = await import(
  "../server/acquisition-status.ts"
);
const media = await import("../server/work-media-state.ts");
const {
  getWorkMediaState,
  getWorkMediaStates,
  clearWorkMediaHold,
  markWorkEmptySearch,
  setWorkMediaHold,
  trackWorkMediaState,
} = media;
type WorkMediaState = import("../server/work-media-state.ts").WorkMediaState;
type WorkMediaStateValue = import("../server/work-media-state.ts").WorkMediaStateValue;
type WorkMediaHoldReason = import("../server/work-media-state.ts").WorkMediaHoldReason;

const dbFile = join(process.env.DATA_DIR, "sonder.db");
const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/materialise-media-states.mjs");

after(() => rmSync(temp, { recursive: true, force: true }));

beforeEach(() => {
  for (const table of ["work_media_states", "user_acquisitions", "acquisitions", "tracks", "recordings", "audio_editions", "works"])
    sqlite.exec(`DELETE FROM ${table}`);
  sqlite
    .prepare("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(2,'second',NULL,'user',?)")
    .run(Date.now());
});

/**
 * The read of the image before ADR 0011, copied from
 * `git show origin/main:server/work-media-state.ts` (`getWorkMediaState`): it returns the
 * stored columns, or null without a row.
 */
function oldGetWorkMediaState(userId: number, workId: string): WorkMediaState | null {
  const row = db
    .select()
    .from(s.workMediaStates)
    .where(
      and(
        eq(s.workMediaStates.userId, userId),
        eq(s.workMediaStates.workId, workId),
      ),
    )
    .get();
  if (!row) return null;
  return {
    state: row.state as WorkMediaStateValue,
    holdReason: (row.holdReason as WorkMediaHoldReason | null) ?? null,
    acquisitionId: row.acquisitionId,
    updatedAt: row.updatedAt,
  };
}

function addWork(workId: string) {
  db.insert(s.works)
    .values({ id: workId, title: workId, author: "A", description: "", genre: "g", year: 2020 })
    .run();
}

function addAudio(workId: string) {
  const edition = `e-${workId}`;
  if (!db.select().from(s.editions).where(eq(s.editions.id, edition)).get()) {
    db.insert(s.editions)
      .values({ id: edition, workId, cover: "", narrator: "N", rating: 0, sourceLabel: "T" })
      .run();
    db.insert(s.recordings).values({ id: `r-${workId}`, editionId: edition }).run();
  }
  db.insert(s.tracks)
    .values({ id: `t-${workId}-${randomUUID()}`, recordingId: `r-${workId}`, title: "c", index: 0, duration: 1, source: "/dev/null", sourceType: "local" })
    .run();
}

function removeAudio(workId: string) {
  sqlite.prepare("DELETE FROM tracks WHERE recording_id=?").run(`r-${workId}`);
}

let clock = 1_000;
function start(userIds: number[], workId: string | null) {
  const id = randomUUID();
  const hash = id.replaceAll("-", "").padEnd(40, "0").slice(0, 40);
  startAcquisitionRecord({
    id,
    hash,
    magnet: `magnet:?xt=urn:btih:${hash}`,
    backend: "local",
    remoteId: null,
    title: "Release",
    author: "A",
    cover: "",
    workId,
    language: null,
    narrator: null,
    progress: 0,
    error: null,
    bookId: null,
    createdAt: clock,
    updatedAt: ++clock,
  });
  for (const userId of userIds)
    db.insert(s.userAcquisitions).values({ userId, acquisitionId: id }).run();
  return id;
}
const status = (id: string, value: Parameters<typeof setAcquisitionStatus>[1]) =>
  setAcquisitionStatus(id, value, { updatedAt: ++clock });

/** A library driven through acquisitions, holds and track changes with this version. */
function driveLibrary() {
  for (const workId of ["series", "queued", "shared", "done", "held", "unreleased", "lost", "held-playable", "retried", "untracked"])
    addWork(workId);
  // The review's example: "Add series" tracks a work that is already playable.
  addAudio("series");
  trackWorkMediaState(1, "series");
  // An acquisition under way: no row at all is written for it now.
  status(start([1], "queued"), "downloading");
  // One acquisition of two users that failed.
  status(start([1, 2], "shared"), "error");
  // An acquisition that finished and brought audio.
  const done = start([1], "done");
  status(done, "downloading");
  addAudio("done");
  status(done, "ready");
  // An empty search, then an acquisition that is still checking.
  markWorkEmptySearch(1, "held");
  start([1], "held");
  // An unreleased volume of the second user.
  setWorkMediaHold(2, "unreleased", "unreleased");
  // Audio that arrived and was removed again.
  const lost = start([2], "lost");
  addAudio("lost");
  status(lost, "ready");
  removeAudio("lost");
  // A hold stored while the work is playable and never read since.
  addAudio("held-playable");
  setWorkMediaHold(1, "held-playable", "unreleased");
  // A failed acquisition followed by a newer one that is paused.
  status(start([1], "retried"), "error");
  status(start([1], "retried"), "paused");
  // An acquisition without a work, and a playable work nobody tracks.
  start([1], null);
  addAudio("untracked");
}

function allPairs() {
  const works = db.select({ id: s.works.id }).from(s.works).all().map((row) => row.id);
  return [1, 2].flatMap((userId) => works.map((workId) => ({ userId, workId })));
}

// This version's read, which the earlier image's read must equal after materialising.
const derived = (userId: number, workId: string) => getWorkMediaState(userId, workId);

test("before materialising, the earlier image misreads states this version derives", () => {
  driveLibrary();
  assert.equal(oldGetWorkMediaState(1, "series")?.state, "missing");
  assert.equal(derived(1, "series")?.state, "available");
  assert.equal(oldGetWorkMediaState(1, "queued"), null);
  assert.equal(derived(1, "queued")?.state, "queued");
});

test("after materialising, the earlier image's read equals the derived state for every user and work", () => {
  driveLibrary();
  const result = media.materialiseWorkMediaStates();
  assert.equal(result.dryRun, false);
  assert.ok(result.inserted > 0 && result.updated > 0, JSON.stringify(result));
  for (const { userId, workId } of allPairs())
    assert.deepEqual(
      oldGetWorkMediaState(userId, workId),
      derived(userId, workId),
      `user ${userId}, work ${workId}`,
    );
  // The cases spelled out, so a wrong derivation cannot pass by being wrong on both sides.
  const seen = (userId: number, workId: string) => {
    const state = oldGetWorkMediaState(userId, workId);
    return state && { state: state.state, holdReason: state.holdReason, named: !!state.acquisitionId };
  };
  assert.deepEqual(seen(1, "series"), { state: "available", holdReason: null, named: false });
  assert.deepEqual(seen(1, "queued"), { state: "queued", holdReason: null, named: true });
  assert.deepEqual(seen(1, "shared"), { state: "failed", holdReason: null, named: true });
  assert.deepEqual(seen(2, "shared"), { state: "failed", holdReason: null, named: true });
  assert.deepEqual(seen(1, "done"), { state: "available", holdReason: null, named: false });
  assert.deepEqual(seen(1, "held"), { state: "queued", holdReason: "empty_search", named: true });
  assert.deepEqual(seen(2, "unreleased"), { state: "missing", holdReason: "unreleased", named: false });
  assert.deepEqual(seen(2, "lost"), { state: "missing", holdReason: null, named: false });
  // A hold set on a playable work is kept as stored, as the earlier image's setter stored it.
  assert.deepEqual(seen(1, "held-playable"), { state: "available", holdReason: "unreleased", named: false });
  assert.deepEqual(seen(1, "retried"), { state: "queued", holdReason: null, named: true });
  assert.equal(seen(1, "untracked"), null);
  assert.equal(seen(2, "queued"), null);
});

test("materialising twice changes nothing the second time", () => {
  driveLibrary();
  const first = media.materialiseWorkMediaStates();
  const rows = sqlite.prepare("SELECT * FROM work_media_states ORDER BY user_id,work_id").all();
  const second = media.materialiseWorkMediaStates();
  assert.deepEqual(second, { inserted: 0, updated: 0, unchanged: first.inserted + first.updated + first.unchanged, dryRun: false });
  assert.deepEqual(sqlite.prepare("SELECT * FROM work_media_states ORDER BY user_id,work_id").all(), rows);
});

test("the script counts in a dry run, writes otherwise, and works while the database is open", () => {
  driveLibrary();
  const before = sqlite.prepare("SELECT * FROM work_media_states ORDER BY user_id,work_id").all();
  const run = (...args: string[]) => {
    const child = spawnSync(process.execPath, [script, "--db", dbFile, ...args], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  };
  const dry = run("--dry-run");
  assert.match(dry, /would write (\d+) work_media_states rows \((\d+) inserted, (\d+) updated, (\d+) unchanged\); dry run, nothing written$/);
  assert.deepEqual(sqlite.prepare("SELECT * FROM work_media_states ORDER BY user_id,work_id").all(), before);
  const wouldWrite = Number(/would write (\d+)/.exec(dry)?.[1]);
  assert.ok(wouldWrite > 0);
  assert.match(run(), new RegExp(`wrote ${wouldWrite} work_media_states rows`));
  assert.equal(oldGetWorkMediaState(1, "series")?.state, "available");
  assert.match(run(), /wrote 0 work_media_states rows \(0 inserted, 0 updated, \d+ unchanged\)$/);
  const missing = spawnSync(process.execPath, [script, "--db", join(temp, "absent.db")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Database not found/);
});

test("the batched media-state read uses indexes, not full scans of tracks, recordings, editions or acquisitions", () => {
  const ids: string[] = [];
  for (let index = 0; index < 10; index++) {
    const workId = `bulk-${index}`;
    ids.push(workId);
    addWork(workId);
    if (index % 2) addAudio(workId);
    start([1], workId);
  }
  const sql: string[] = [];
  const original = sqlite.prepare;
  sqlite.prepare = ((source: string) => {
    sql.push(source);
    return original.call(sqlite, source);
  }) as typeof original;
  try {
    getWorkMediaStates(1, ids);
  } finally {
    sqlite.prepare = original;
  }
  assert.equal(sql.length, 3, sql.join("\n---\n"));
  const plans = sql.map((source) => {
    const params = (source.match(/\?/g) ?? []).map(() => JSON.stringify(ids));
    return (sqlite.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...params) as { detail: string }[])
      .map((row) => row.detail);
  });
  const all = plans.flat();
  for (const detail of all) {
    assert.doesNotMatch(detail, /AUTOMATIC/, `automatic index: ${detail}`);
    // A scan is only allowed over the bound id list or a subquery's rows.
    if (/^SCAN /.test(detail))
      assert.match(detail, /^SCAN (json_each|\(subquery|unnamed subquery|CONSTANT ROW)/, `full scan: ${detail}\n${all.join("\n")}`);
  }
  const used = all.join("\n");
  for (const index of ["audio_editions_work", "recordings_edition", "tracks_recording"])
    assert.match(used, new RegExp(index), `${index} unused:\n${used}`);
  // The acquisition query goes through the primary keys of user_acquisitions and acquisitions.
  assert.match(used, /USING (COVERING )?INDEX sqlite_autoindex_user_acquisitions_1 \(user_id=\?\)/, used);
  assert.match(used, /USING INDEX sqlite_autoindex_acquisitions_1 \(id=\?\)/, used);
});

const pickHold = (userId: number, workId: string) => {
  const state = getWorkMediaState(userId, workId);
  return state && [state.state, state.holdReason];
};

test("a ready acquisition clears the hold of every user of it, with no read while the audio is there", () => {
  sqlite
    .prepare("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(3,'third',NULL,'user',?)")
    .run(Date.now());
  addWork("w");
  addWork("other");
  markWorkEmptySearch(1, "w");
  markWorkEmptySearch(2, "w");
  markWorkEmptySearch(3, "w");
  markWorkEmptySearch(1, "other");
  // One acquisition shared by users 1 and 2; user 2 never opens the work.
  const id = start([1, 2], "w");
  status(id, "downloading");
  addAudio("w");
  status(id, "ready");
  removeAudio("w");
  assert.deepEqual(pickHold(1, "w"), ["missing", null]);
  assert.deepEqual(pickHold(2, "w"), ["missing", null]);
  // A user without that acquisition, and another work of the same user, keep their holds.
  assert.deepEqual(pickHold(3, "w"), ["missing", "empty_search"]);
  assert.deepEqual(pickHold(1, "other"), ["missing", "empty_search"]);
  // A hold set again afterwards is kept.
  markWorkEmptySearch(1, "w");
  assert.deepEqual(pickHold(1, "w"), ["missing", "empty_search"]);
});

test("an acquisition status other than ready leaves the hold in place", () => {
  addWork("w");
  markWorkEmptySearch(1, "w");
  const id = start([1], "w");
  for (const value of ["preparing", "downloading", "paused", "error", "checking"] as const) {
    status(id, value);
    assert.equal(getWorkMediaState(1, "w")?.holdReason, "empty_search", value);
  }
  // An acquisition without a work clears nothing and does not fail.
  status(start([1], null), "ready");
  assert.equal(getWorkMediaState(1, "w")?.holdReason, "empty_search");
});

test("reading media states writes nothing, also for a playable work with a stored hold", () => {
  addWork("w");
  addWork("q");
  markWorkEmptySearch(1, "w");
  addAudio("w");
  setWorkMediaHold(1, "q", "unreleased");
  addAudio("q");
  start([1], "q");
  const changes = () => (sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const before = changes();
  const statements: string[] = [];
  const originalPrepare = sqlite.prepare;
  const originalExec = sqlite.exec;
  sqlite.prepare = ((source: string) => {
    statements.push(source);
    return originalPrepare.call(sqlite, source);
  }) as typeof originalPrepare;
  sqlite.exec = ((source: string) => {
    statements.push(source);
    return originalExec.call(sqlite, source);
  }) as typeof originalExec;
  let single: WorkMediaState | null;
  let many: Map<string, WorkMediaState>;
  try {
    single = getWorkMediaState(1, "w");
    many = getWorkMediaStates(1, ["w", "q"]);
  } finally {
    sqlite.prepare = originalPrepare;
    sqlite.exec = originalExec;
  }
  assert.equal(changes(), before, "rows changed by a read");
  for (const source of statements)
    assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i, source);
  // The hold is returned exactly as stored while the work is playable.
  assert.deepEqual([single?.state, single?.holdReason], ["available", "empty_search"]);
  assert.deepEqual([many.get("q")?.state, many.get("q")?.holdReason], ["available", "unreleased"]);
});

test("a hold on a work whose audio arrived without an acquisition stays stored until the retry clears it", () => {
  addWork("w");
  markWorkEmptySearch(1, "w");
  // Audio uploaded or imported: no acquisition reaches ready, so nothing clears the hold.
  addAudio("w");
  assert.deepEqual(pickHold(1, "w"), ["available", "empty_search"]);
  removeAudio("w");
  assert.deepEqual(pickHold(1, "w"), ["missing", "empty_search"]);
  assert.deepEqual(
    (({ state, holdReason }) => [state, holdReason])(clearWorkMediaHold(1, "w")!),
    ["missing", null],
  );
  assert.deepEqual(pickHold(1, "w"), ["missing", null]);
});

test("an unreleased hold set on a playable work is kept and returns when the audio goes", () => {
  addWork("w");
  addAudio("w");
  setWorkMediaHold(1, "w", "unreleased");
  assert.deepEqual(pickHold(1, "w"), ["available", "unreleased"]);
  removeAudio("w");
  assert.deepEqual(pickHold(1, "w"), ["missing", "unreleased"]);
});
