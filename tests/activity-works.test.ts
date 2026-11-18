/**
 * What an item of `GET /api/activity` says of its book and of its status line (#514, spec #513 "What the server
 * answers"): `workId`, `bookId` and `cover` by the cover rule of the library by work, the facts each kind's status line
 * is written from, and `attention`. Every source runs against the real tables of a throwaway database; the route is
 * read as the administrator and as a second user.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ActivityItem, ActivityResponse, TorrentHealth } from "../src/types.ts";
import { BOOK_ENGINE, bookWorkerJobId } from "../src/reading-types.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-activity-works-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.TRANSMISSION_RPC_URL;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const { collectActivity, DEFAULT_ACTIVITY_USER_ID } = await import("../server/activity.ts");
const { ADMIN_USER_ID } = await import("../server/users.ts");
const app = await createApp();
after(async () => {
  await app.close();
  rmSync(temp, { recursive: true, force: true });
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const now = Date.now();
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;

const work = (id: string, title: string) =>
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'Card','','',1986)", id, title);
const edition = (id: string, workId: string, cover: string) =>
  run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES(?,?,?,'',0,'')", id, workId, cover);
const recording = (id: string, editionId: string, withTrack = true) => {
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", id, editionId);
  if (withTrack)
    run("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES(?,?,'Part 1',0,60,'https://audio.example/a.mp3','remote')", `t-${id}`, id);
};
const shelf = (userId: number, editionId: string, addedAt: number) =>
  run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", userId, editionId, addedAt);

// The administrator is user 1; "reader" is the second user, who has books of their own.
const admin = await login("203.0.113.190", { password: "admin-password" });
const created = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
assert.equal(created.statusCode, 200, created.body);
const reader = await login("203.0.113.191", { username: "reader", password: "password1" });
const READER_ID = (sqlite.prepare("SELECT id FROM users WHERE username='reader'").get() as { id: number }).id;

// w-real: a real audio edition in the library. w-two: two real editions. w-placeholder: only a placeholder (no
// track), in the library. w-bare: no audio edition at all. w-outside: a real edition in nobody's library.
work("w-real", "Speaker for the Dead");
edition("ed-real", "w-real", "/covers/real.jpg");
recording("rec-real", "ed-real");
shelf(1, "ed-real", now - 10 * DAY);
work("w-two", "Xenocide");
edition("ed-two-a", "w-two", "/covers/two-a.jpg");
edition("ed-two-b", "w-two", "/covers/two-b.jpg");
recording("rec-two-a", "ed-two-a");
recording("rec-two-b", "ed-two-b");
shelf(1, "ed-two-a", now - 9 * DAY);
shelf(1, "ed-two-b", now - 8 * DAY);
work("w-placeholder", "Children of the Mind");
edition("hc-900", "w-placeholder", "/covers/placeholder.jpg");
recording("rec-placeholder", "hc-900", false);
shelf(1, "hc-900", now - 7 * DAY);
work("w-bare", "Ender in Exile");
work("w-outside", "Shadow of the Hegemon");
edition("ed-outside", "w-outside", "/covers/outside.jpg");
recording("rec-outside", "ed-outside");
// The reader's own book: another account's library never decides what the administrator's list shows.
work("w-reader", "The Reader's Book");
edition("ed-reader", "w-reader", "/covers/reader.jpg");
recording("rec-reader", "ed-reader");
shelf(READER_ID, "ed-reader", now - DAY);

const acquisition = (id: string, over: Record<string, unknown>) => {
  const row = { backend: "local", status: "downloading", progress: 0.5, error: null, cover: "", work_id: null, book_id: null, updated_at: now - MIN, ...over };
  run(
    "INSERT INTO acquisitions(id,hash,magnet,backend,title,author,cover,status,progress,error,work_id,book_id,created_at,updated_at) VALUES(?,?,?,?,?,'Card',?,?,?,?,?,?,?,?)",
    id, `hash-${id}`, `magnet:?xt=urn:btih:${id}`, row.backend, `Download ${id}`, row.cover, row.status, row.progress, row.error, row.work_id, row.book_id, now - DAY, row.updated_at,
  );
};
// A download of a work, one that knows only its audio edition, and one that has no work yet and keeps its own cover.
acquisition("acq-work", { work_id: "w-real", status: "downloading" });
acquisition("acq-edition", { book_id: "ed-two-a", status: "paused", backend: "torbox" });
acquisition("acq-nowork", { cover: "/covers/own.jpg", status: "checking", progress: 0 });
acquisition("acq-bare", { work_id: "w-bare", cover: "/covers/bare-own.jpg", status: "checking", progress: 0 });
acquisition("acq-gone", { work_id: "w-missing-from-works", status: "preparing", backend: "torbox" });

// A copy to the server.
run("INSERT INTO server_downloads(recording_id,book_id,status,progress,created_at,updated_at) VALUES('rec-real','ed-real','downloading',0.3,?,?)", now - DAY, now - MIN);

// Reading syncs of a work: a whole-book job in a stage with file counts, one with its outcome, and the older engine's.
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-1','w-real','epub','/x/1.epub')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-2','w-real','epub','/x/2.epub')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-3','w-real','epub','/x/3.epub')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-4','w-real','epub','/x/4.epub')");
const alignment = (id: string, ebookId: string, recordingId: string, data: Record<string, unknown>) =>
  run("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,?,?,?,?)", id, ebookId, recordingId, JSON.stringify(data), now - MIN);
const bookJob = (id: string, generation: string, state: string, counts: Record<string, number>, workerId?: string) => ({
  id, generation, status: "processing", engine: BOOK_ENGINE, progress: 0.3, createdAt: now - 5 * MIN,
  bookJob: { id: workerId ?? bookWorkerJobId({ id, generation }), hostId: "wsl", state, startedAt: now - 4 * MIN, counts },
});
alignment("sync-encoding", "eb-1", "rec-real", bookJob("sync-encoding", "g1", "encoding", { tracksTotal: 43, tracksDecoded: 43, tracksEncoded: 24 }));
alignment("sync-partial", "eb-2", "rec-real", { id: "sync-partial", status: "partial", engine: BOOK_ENGINE, outcome: "partial", coverage: 0.61, progress: 1 });
alignment("sync-decoding", "eb-3", "rec-two-a", bookJob("sync-decoding", "g1", "decoding", { tracksTotal: 12, tracksDecoded: 20 }));
alignment("sync-aligning", "eb-4", "rec-two-b", bookJob("sync-aligning", "g1", "aligning", { groupsTotal: 8, groupsDone: 3 }));
// The worker's last state stays on the record of a job that is no longer processing: it is no stage.
alignment("sync-ready", "eb-1", "rec-two-b", { ...bookJob("sync-ready", "g1", "done", { tracksTotal: 3, tracksEncoded: 3 }), status: "ready", outcome: "mapped", coverage: 1 });
alignment("sync-paused", "eb-2", "rec-two-b", { ...bookJob("sync-paused", "g1", "encoding", { tracksTotal: 3, tracksEncoded: 1 }), status: "paused" });
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-5','w-two','epub','/x/5.epub')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-6','w-two','epub','/x/6.epub')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-7','w-two','epub','/x/7.epub')");
alignment("sync-starting", "eb-5", "rec-two-a", bookJob("sync-starting", "g1", "starting", {}));
alignment("sync-stale", "eb-6", "rec-two-a", bookJob("sync-stale", "g2", "encoding", { tracksTotal: 9, tracksEncoded: 4 }, "an-earlier-generation"));
alignment("sync-window", "eb-7", "rec-two-a", { id: "sync-window", status: "processing", engine: "ctc-window", progress: 0.4 });

// An ebook check of a work held with its reason, and a series search of each kind.
const member = (workId: string, ebookId: string, status: string, holdReason: string | null) =>
  run("INSERT INTO work_ebook_set_members(work_id,ebook_id,status,hold_reason,source_title,evidence,updated_at) VALUES(?,?,?,?,'Edition','{}',?)", workId, ebookId, status, holdReason, now - MIN);
member("w-real", "eb-1", "held", "awaiting_worker");
member("w-real", "eb-2", "held", "evaluation_failed");
run("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(7,'Ender','Card',4)");
const search = (id: string, workId: string, kind: "audio" | "ebook", status: string, book: number) =>
  run("INSERT INTO series_acquisition_jobs(id,user_id,series_id,book_id,work_id,kind,status,error,updated_at) VALUES(?,1,7,?,?,?,?,NULL,?)", id, book, workId, kind, status, now - MIN);
search("search-audio", "w-placeholder", "audio", "pending", 1);
search("search-ebook", "w-real", "ebook", "done", 2);
search("search-bare", "w-bare", "audio", "pending", 3);

// A Hardcover queue and a database backup concern no book.
run("INSERT INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,intent,updated_at,error) VALUES(1,1,1,1,'add',?,NULL)", now - MIN);
run("INSERT INTO backup_runs(day,file,status,bytes,error,started_at,finished_at,updated_at) VALUES('2026-11-15','daily.db','done',1000,NULL,?,?,?)", now - 2 * MIN, now - MIN, now - MIN);

const getActivity = async (cookie: string): Promise<ActivityResponse> =>
  (await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: cookie } })).json();
const activity = await getActivity(admin);
const item = (id: string): ActivityItem => {
  const found = activity.items.find((candidate) => candidate.id === id);
  assert.ok(found, `${id} is listed`);
  return found;
};
const book = (id: string) => {
  const { workId, bookId, cover } = item(id);
  return { workId, bookId, cover };
};

test("the default user of the covers is the administrator's id", () => {
  assert.equal(DEFAULT_ACTIVITY_USER_ID, ADMIN_USER_ID);
});

test("the cover rule answers for the works that exist only", async () => {
  const { workCovers } = await import("../server/work-cover.ts");
  const covers = workCovers(sqlite, 1, ["w-real", "w-bare", "w-missing-from-works"]);
  assert.deepEqual([...covers.keys()].sort(), ["w-bare", "w-real"]);
  assert.deepEqual(workCovers(sqlite, 1, []).size, 0);
});

test("a download names its work by its work, by its audio edition, or has none and keeps its own cover", () => {
  assert.deepEqual(book("acquisition:acq-work"), { workId: "w-real", bookId: "ed-real", cover: "/covers/real.jpg" });
  assert.deepEqual(book("acquisition:acq-edition"), { workId: "w-two", bookId: "ed-two-a", cover: "/covers/two-a.jpg" }, "the work of its audio edition");
  assert.deepEqual(book("acquisition:acq-nowork"), { workId: null, bookId: null, cover: "/covers/own.jpg" });
  assert.deepEqual(book("acquisition:acq-bare"), { workId: "w-bare", bookId: null, cover: "/covers/bare-own.jpg" }, "a work with no cover yet: the download's own");
  assert.deepEqual(book("acquisition:acq-gone"), { workId: null, bookId: null, cover: "" }, "a work that does not exist is no work");
  assert.deepEqual(item("acquisition:acq-work").facts, { kind: "acquisition", status: "downloading", backend: "local" });
  assert.deepEqual(item("acquisition:acq-edition").facts, { kind: "acquisition", status: "paused", backend: "torbox" });
  assert.deepEqual(item("acquisition:acq-nowork").facts, { kind: "acquisition", status: "checking", backend: "local" });
});

test("a copy to the server names its work", () => {
  assert.deepEqual(book("server-copy:rec-real"), { workId: "w-real", bookId: "ed-real", cover: "/covers/real.jpg" });
  assert.deepEqual(item("server-copy:rec-real").facts, { kind: "server-copy", status: "downloading" });
});

test("a reading sync names its work and carries the worker's stage with its file counts, or its outcome", () => {
  assert.deepEqual(book("alignment:sync-encoding"), { workId: "w-real", bookId: "ed-real", cover: "/covers/real.jpg" });
  assert.deepEqual(item("alignment:sync-encoding").facts, {
    kind: "alignment", status: "processing", outcome: null, coverage: null, wholeBook: true, stage: "encoding", files: { done: 24, total: 43 },
    spare: false, background: false,
  });
  assert.deepEqual(item("alignment:sync-partial").facts, {
    kind: "alignment", status: "partial", outcome: "partial", coverage: 0.61, wholeBook: true, stage: null, files: null,
    spare: false, background: false,
  });
  const decoding = item("alignment:sync-decoding").facts;
  assert.ok(decoding.kind === "alignment");
  assert.deepEqual([decoding.stage, decoding.files], ["decoding", { done: 12, total: 12 }], "a count past the total is the total");
  const aligning = item("alignment:sync-aligning").facts;
  assert.ok(aligning.kind === "alignment");
  assert.deepEqual([aligning.stage, aligning.files], ["aligning", null], "a stage that counts parts, not files, has no file count");
  for (const id of ["ready", "paused"]) {
    const facts = item(`alignment:sync-${id}`).facts;
    assert.ok(facts.kind === "alignment");
    assert.deepEqual([facts.stage, facts.files], [null, null], `${id}: a job that is not processing has no stage`);
  }
  for (const id of ["starting", "stale", "window"]) {
    const facts = item(`alignment:sync-${id}`).facts;
    assert.ok(facts.kind === "alignment");
    assert.deepEqual([facts.stage, facts.files], [null, null], `${id}: no stage of this run yet`);
  }
  const window = item("alignment:sync-window").facts;
  assert.ok(window.kind === "alignment");
  assert.equal(window.wholeBook, false, "a job of the older engine reports no stage");
});

test("an ebook check names its work and carries its hold reason", () => {
  assert.deepEqual(book("ebook-set:w-real:eb-1"), { workId: "w-real", bookId: "ed-real", cover: "/covers/real.jpg" });
  assert.deepEqual(item("ebook-set:w-real:eb-1").facts, { kind: "ebook-set", status: "held", holdReason: "awaiting_worker" });
  assert.deepEqual(item("ebook-set:w-real:eb-2").facts, { kind: "ebook-set", status: "held", holdReason: "evaluation_failed" });
});

test("a series search names its work and says whether it looks for the audiobook or the ebook", () => {
  assert.deepEqual(item("series-acquisition:search-ebook").facts, { kind: "series-acquisition", status: "done", search: "ebook" });
  assert.deepEqual(book("series-acquisition:search-ebook"), { workId: "w-real", bookId: "ed-real", cover: "/covers/real.jpg" });
  assert.deepEqual(item("series-acquisition:search-audio").facts, { kind: "series-acquisition", status: "pending", search: "audiobook" });
});

test("a work whose only audio edition is a placeholder lends its cover and no edition id", () => {
  assert.deepEqual(book("series-acquisition:search-audio"), { workId: "w-placeholder", bookId: null, cover: "/covers/placeholder.jpg" });
  assert.equal(JSON.stringify(item("series-acquisition:search-audio")).includes("hc-900"), false, "the placeholder's id is nowhere in the item");
  assert.equal(JSON.stringify(activity).includes("hc-900"), false, "nor anywhere in the response");
  assert.deepEqual(book("series-acquisition:search-bare"), { workId: "w-bare", bookId: null, cover: "" }, "a work without any audio edition has no cover");
});

test("a Hardcover queue and a backup have no work, no edition and no cover", () => {
  for (const id of ["hardcover:status:1", "backup:2026-11-15"]) {
    assert.deepEqual(book(id), { workId: null, bookId: null, cover: null }, id);
  }
  assert.deepEqual(item("hardcover:status:1").facts, { kind: "hardcover", status: "waiting", queue: "status" });
  assert.deepEqual(item("backup:2026-11-15").facts, { kind: "backup", status: "done" });
});

test("the cover is the one the library by work shows: the chosen recording's, which follows the user's choice", async () => {
  const library = async (cookie: string) => (await app.inject({ method: "GET", url: "/api/library", cookies: { sonder_session: cookie } })).json() as
    Array<{ workId: string; cover: string; chosenRecordingId: string | null }>;
  const shown = (await library(admin)).find((entry) => entry.workId === "w-two");
  assert.equal(shown?.cover, "/covers/two-a.jpg", "the one added first, until a place or a choice says otherwise");
  assert.equal(book("acquisition:acq-edition").cover, shown?.cover);

  const chosen = await app.inject({ method: "PUT", url: "/api/works/w-two/recording", cookies: { sonder_session: admin }, payload: { recordingId: "rec-two-b" } });
  assert.equal(chosen.statusCode, 200, chosen.body);
  const after = await getActivity(admin);
  const entry = after.items.find((candidate) => candidate.id === "acquisition:acq-edition")!;
  assert.deepEqual([entry.bookId, entry.cover], ["ed-two-b", "/covers/two-b.jpg"]);
  assert.equal((await library(admin)).find((candidate) => candidate.workId === "w-two")?.cover, entry.cover, "library and Activity agree");
  // The other account's choices and library do not move the administrator's covers.
  assert.equal(
    (await app.inject({ method: "PUT", url: "/api/works/w-two/recording", cookies: { sonder_session: reader }, payload: { recordingId: "rec-two-a" } })).statusCode,
    400, "the reader has no recording of that work to choose",
  );
});

test("the covers are read for the administrator who asks: a second administrator sees their own recording of a work", async () => {
  await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "second-admin", password: "password2" } });
  const second = (sqlite.prepare("SELECT id FROM users WHERE username='second-admin'").get() as { id: number }).id;
  run("UPDATE users SET role='admin' WHERE id=?", second);
  shelf(second, "ed-two-a", now - DAY);
  const cookie = await login("203.0.113.192", { username: "second-admin", password: "password2" });
  const mine = (await getActivity(cookie)).items.find((candidate) => candidate.id === "acquisition:acq-edition")!;
  const theirs = (await getActivity(admin)).items.find((candidate) => candidate.id === "acquisition:acq-edition")!;
  assert.deepEqual([mine.bookId, mine.cover], ["ed-two-a", "/covers/two-a.jpg"], "their library holds the first recording only");
  assert.deepEqual([theirs.bookId, theirs.cover], ["ed-two-b", "/covers/two-b.jpg"], "the first administrator chose the second");
});

test("the work and the cover of an item are read for the administrator who asks, from their own library", async () => {
  // w-reader is in the reader's library only: the administrator has no recording of it, so no edition is named for
  // them, though its cover still shows (the library's fallback for a work outside the library).
  run("INSERT INTO acquisitions(id,hash,magnet,backend,title,author,cover,status,progress,work_id,created_at,updated_at) VALUES('acq-reader','h-r','magnet:?xt=urn:btih:r','torbox','Reader download','','/own.jpg','preparing',0,'w-reader',?,?)", now - DAY, now - MIN);
  const entry = (await getActivity(admin)).items.find((candidate) => candidate.id === "acquisition:acq-reader")!;
  assert.deepEqual([entry.workId, entry.cover], ["w-reader", "/covers/reader.jpg"]);
});

test("a second user is refused the list, and nothing of it reaches them", async () => {
  const response = await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: reader } });
  assert.equal(response.statusCode, 403);
  for (const needle of ["w-real", "ed-real", "/covers/", "Speaker for the Dead", "facts", "attention", "hc-900"])
    assert.equal(response.body.includes(needle), false, needle);
  assert.equal((await app.inject({ method: "GET", url: "/api/activity" })).statusCode, 401, "and nobody signed out");
});

// Attention: failed in the last seven days, stuck or blocked; the response's count is those items plus the down processes.
const torrentDown: TorrentHealth = {
  status: "unreachable", session: false, network: "unknown", version: null, message: "The local torrent client cannot be reached.", checkedAt: now,
};
const deps = (over: Record<string, unknown> = {}) => ({
  sqlite,
  getSetting: () => undefined,
  torrentHealth: async () => torrentDown,
  poolStatus: async () => ({ enabled: false, engine: "ctc", checkedAt: now, hosts: [] }),
  requireAdmin: () => {},
  syncHardcover: async () => ({}),
  pauseState: () => ({}),
  setPaused: () => {},
  now: () => now,
  ...over,
}) as never;

test("attention is true for a failure of six days, false for one of eight, true for a stuck and for a blocked item", async () => {
  run("DELETE FROM acquisitions");
  run("DELETE FROM series_acquisition_jobs");
  run("DELETE FROM alignment_jobs");
  run("DELETE FROM server_downloads");
  run("DELETE FROM work_ebook_set_members");
  run("DELETE FROM user_hardcover_outbox");
  run("DELETE FROM backup_runs");
  acquisition("fail-6d", { status: "error", error: "No seeders", updated_at: now - 6 * DAY });
  acquisition("fail-8d", { status: "error", error: "No seeders", updated_at: now - 8 * DAY });
  acquisition("fail-7d", { status: "error", error: "No seeders", updated_at: now - 7 * DAY });
  acquisition("fail-7d-1ms", { status: "error", error: "No seeders", updated_at: now - 7 * DAY - 1 });
  acquisition("blocked", { status: "downloading", backend: "local" });
  acquisition("streaming", { status: "downloading", backend: "torbox" });
  acquisition("done", { status: "ready", backend: "torbox" });
  run("INSERT INTO series_acquisition_jobs(id,user_id,series_id,book_id,work_id,kind,status,error,updated_at) VALUES('stuck',1,7,10,'w-real','audio','searching',NULL,?)", now - 30 * MIN);
  run("INSERT INTO series_acquisition_jobs(id,user_id,series_id,book_id,work_id,kind,status,error,updated_at) VALUES('moving',1,7,11,'w-two','audio','searching',NULL,?)", now - MIN);

  const response = await collectActivity(deps(), { probes: true });
  const attention = Object.fromEntries(response.items.map((entry) => [entry.id.replace(/^[a-z-]+:/, ""), entry.attention]));
  assert.equal(attention["fail-6d"], true, "a failure of six days");
  assert.equal(attention["fail-8d"], false, "a failure of eight days");
  assert.equal(attention["fail-7d"], true, "seven days to the millisecond still counts");
  assert.equal(attention["fail-7d-1ms"], false, "one millisecond more does not");
  assert.equal(attention.blocked, true, "an item blocked by the torrent client that is down");
  assert.equal(response.items.find((entry) => entry.id === "acquisition:blocked")?.blockedBy, "torrent-client");
  assert.equal(attention.streaming, false, "a download that does not use the torrent client is not blocked");
  assert.equal(attention.done, false, "a finished one");
  assert.equal(attention.stuck, true, "a stuck item");
  assert.equal(response.items.find((entry) => entry.id === "series-acquisition:stuck")?.stuck?.reason, "No change for 30 min");
  assert.equal(attention.moving, false, "a running item that still changes");

  const down = response.processes.filter((process) => process.health === "down" && !process.notTracked);
  assert.deepEqual(down.map((process) => process.id), ["torrent-client"]);
  assert.equal(response.attention, response.items.filter((entry) => entry.attention).length + down.length, "the count keeps its meaning");
  assert.equal(response.attention, 4 + 1, "fail-6d, fail-7d, blocked and stuck, plus the torrent client");
});
