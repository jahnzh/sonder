// Hardcover removed (#721 part d), on a throwaway database read as the owner (the administrator), Sam and Kim (two
// users who are not):
// - the switch at startup copies every user's stored Hardcover Want to read shelf into Sonder's Want to read and then
//   deletes every stored Hardcover token, once (a second start changes nothing), and a failed switch keeps both and
//   runs at the next start;
// - every removed Hardcover route answers 410 `hardcover_removed`, never cached, to anyone, with the request shapes
//   older builds sent;
// - the settings still accept an older build's Hardcover token field from anyone and ignore it, and still answer
//   `hardcoverConfigured` (always false);
// - listening progress, Add to library and a status change write nothing to the Hardcover queues;
// - Activity has no Hardcover sync process and its pause switch is gone;
// - a placeholder only Sam has on his Hardcover shelf stays hidden from Kim.
//
// Works: w-sam "Feersum Endjinn" (placeholder hc-2002, Hardcover 2002, Sam's shelf: Want to read); w-own "Matter"
// (placeholder hc-3001, Hardcover 3001, the owner's shelf: Want to read); w-audio "Excession" (a recording with a
// file, in the owner's library). Hardcover 3999 is on Kim's shelf (Want to read) but has no work: unmatched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-hardcover-removed-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = "owner-token";
const SAM = "sam-token";
const KIM = "kim-token";
const T0 = Date.UTC(2026, 0, 1);

// Nothing here may reach Hardcover (or anything else): every fetch is counted and refused.
const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("No network in this test.");
}) as typeof fetch;

const { sqlite } = await import("../server/db.ts");
const { hashToken, encrypt } = await import("../server/security.ts");
const { HARDCOVER_SWITCH_SETTING, switchFromHardcover } = await import("../server/hardcover-switch.ts");
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
{
  const media = join(process.env.MEDIA_ROOT, "fixture");
  mkdirSync(media, { recursive: true });
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(2,'sam',NULL,'user',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(3,'kim',NULL,'user',?)", T0);
  for (const [token, userId] of [[OWNER, 1], [SAM, 2], [KIM, 3]] as const)
    run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(token), Date.now() + 86_400_000, userId);
  const work = (id: string, title: string) =>
    run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)", id, title, "Iain M. Banks", "", "Fiction", 2000);
  const edition = (id: string, workId: string) =>
    run(
      "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,?,?,?,?)",
      id, workId, `/covers/${id}.jpg`, "Narrator", "en", null, 0, "Test",
    );
  work("w-audio", "Excession");
  edition("ed-audio", "w-audio");
  run("INSERT INTO recordings(id,edition_id) VALUES('rec-audio','ed-audio')");
  const source = join(media, "excession.mp3");
  writeFileSync(source, "audio");
  run(
    "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES('t-audio','rec-audio','Part 1',0,600,?,'local','[]')",
    source,
  );
  run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(1,'ed-audio','unread',?)", T0);
  for (const [workId, title, bookId] of [["w-sam", "Feersum Endjinn", 2002], ["w-own", "Matter", 3001]] as const) {
    work(workId, title);
    edition(`hc-${bookId}`, workId);
    run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `recording-hc-${bookId}`, `hc-${bookId}`);
    run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES(?,?,?,'[]')", workId, bookId, `book-${bookId}`);
  }
  run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(2,'hc-2002','unread',?)", T0);
  const shelf = (userId: number, bookId: number) =>
    run("INSERT INTO user_hardcover_links(user_id,book_id,user_book_id,status_id) VALUES(?,?,?,1)", userId, bookId, bookId + 100000);
  shelf(1, 3001);
  shelf(2, 2002);
  shelf(3, 3999);
  // The tokens and the sync state as the removed sync left them: two-way, so a write would have been queued.
  for (const userId of [1, 2, 3]) {
    run("INSERT INTO user_settings(user_id,key,value) VALUES(?,'hardcover',?)", userId, encrypt(`hardcover-key-${userId}`));
    run(
      "INSERT INTO user_settings(user_id,key,value) VALUES(?,'hardcoverState',?)",
      userId,
      JSON.stringify({ mode: "two-way", syncLists: true, accountId: 70 + userId, username: null, lastSync: T0, lastError: null, listWarning: null }),
    );
  }
  // The single-account token an early build kept for the whole server.
  run("INSERT OR REPLACE INTO settings(key,value) VALUES('hardcover',?)", encrypt("legacy-key"));
}
sqlite.prepare("INSERT INTO user_settings(user_id,key,value) VALUES(1,'shelfEbooksJoined','1')").run();

const tokens = () => ({
  users: sqlite.prepare("SELECT user_id FROM user_settings WHERE key='hardcover' ORDER BY user_id").pluck().all(),
  server: sqlite.prepare("SELECT COUNT(*) FROM settings WHERE key='hardcover'").pluck().get(),
});
const wanted = (userId: number) =>
  sqlite.prepare("SELECT work_id FROM user_want_to_read WHERE user_id=? ORDER BY work_id").pluck().all(userId);

// The first start fails: its switch must keep the tokens, write no marker and say so in the log.
sqlite.exec("ALTER TABLE user_want_to_read RENAME TO user_want_to_read_away");
const { createApp } = await import("../server/app.ts");
const warnings: string[] = [];
const failed = switchFromHardcover({ info: () => {}, warn: (message) => warnings.push(message) });
sqlite.exec("ALTER TABLE user_want_to_read_away RENAME TO user_want_to_read");
const keptAfterFailure = tokens();
const markerAfterFailure = sqlite.prepare("SELECT COUNT(*) FROM settings WHERE key=?").pluck().get(HARDCOVER_SWITCH_SETTING);

// The next start runs it.
const app = await createApp({ background: { manual: true } });
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
});

const request = (token: string, url: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET", payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: token }, ...(payload === undefined ? {} : { payload: payload as object }) });

test("a switch that fails keeps every token, writes no marker, and says it is tried again", () => {
  assert.deepEqual(failed, { ran: false });
  assert.deepEqual(keptAfterFailure, { users: [1, 2, 3], server: 1 });
  assert.equal(markerAfterFailure, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tried again at the next start/);
});

test("the switch copies every user's Hardcover Want to read and then deletes every stored token", async () => {
  assert.deepEqual(tokens(), { users: [], server: 0 });
  assert.ok(sqlite.prepare("SELECT value FROM settings WHERE key=?").pluck().get(HARDCOVER_SWITCH_SETTING));
  assert.deepEqual(wanted(1), ["w-own"]);
  assert.deepEqual(wanted(2), ["w-sam"]);
  assert.deepEqual(wanted(3), []);
  // Each user's own result; Kim's book had no work and is listed as unmatched for her alone.
  const mine = (await request(OWNER, "/api/want-to-read/hardcover-copy")).json() as { copy: { added: string[]; unmatched: unknown[] } };
  assert.deepEqual(mine.copy.added, ["w-own"]);
  const kims = (await request(KIM, "/api/want-to-read/hardcover-copy")).json() as { copy: { added: string[]; unmatched: { bookId: number }[] } };
  assert.deepEqual(kims.copy.added, []);
  assert.deepEqual(kims.copy.unmatched, [{ bookId: 3999 }]);
  const sams = (await request(SAM, "/api/want-to-read/hardcover-copy")).json() as { copy: { added: string[]; unmatched: unknown[] } };
  assert.deepEqual(sams.copy, { ...sams.copy, added: ["w-sam"], unmatched: [] });
  // The Hardcover tables stay, unused, for one release.
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM user_hardcover_links").pluck().get(), 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM hardcover_links").pluck().get(), 2);
  assert.equal(fetches, 0);
});

test("the switch runs once: a later start copies and deletes nothing more", () => {
  run("INSERT INTO user_hardcover_links(user_id,book_id,user_book_id,status_id) VALUES(3,2002,1,1)");
  run("INSERT INTO user_settings(user_id,key,value) VALUES(3,'hardcover',?)", encrypt("pasted-again"));
  const said: string[] = [];
  assert.deepEqual(switchFromHardcover({ info: (message) => said.push(message), warn: (message) => said.push(message) }), { ran: false });
  // Stopped by its marker, not by a failure: nothing is logged.
  assert.deepEqual(said, []);
  assert.deepEqual(wanted(3), []);
  assert.deepEqual(tokens().users, [3]);
  run("DELETE FROM user_hardcover_links WHERE user_id=3 AND book_id=2002");
  run("DELETE FROM user_settings WHERE user_id=3 AND key='hardcover'");
});

const REMOVED: Array<[method: "GET" | "POST" | "PUT" | "PATCH", url: string, body?: unknown]> = [
  ["GET", "/api/hardcover"],
  ["PUT", "/api/hardcover/token", { token: "a-new-key" }],
  ["POST", "/api/hardcover/test", {}],
  ["PATCH", "/api/hardcover/config", { mode: "two-way", syncLists: true }],
  ["POST", "/api/hardcover/sync"],
  ["POST", "/api/hardcover/books", { id: 3001, workId: "w-own" }],
  ["PATCH", "/api/hardcover/shelf", { workId: "w-own", statusId: 3 }],
  ["PATCH", "/api/hardcover/lists/55", { workId: "w-own", included: true }],
  ["POST", "/api/hardcover/progress/pull", { workId: "w-audio", recordingId: "rec-audio" }],
  ["GET", "/api/hardcover/editions?workId=w-audio&recordingId=rec-audio"],
  ["PATCH", "/api/hardcover/edition", { workId: "w-audio", recordingId: "rec-audio", editionId: null }],
  // Hardcover's catalogue, removed with parts b and c2.
  ["GET", "/api/discover/hardcover?q=matter%20banks"],
  ["GET", "/api/hardcover/books/1001/series"],
  ["POST", "/api/hardcover/series", { name: "The Culture" }],
];

test("every removed Hardcover route answers a clear 410 that is never cached, to the owner and to the others", async () => {
  for (const token of [OWNER, SAM, KIM])
    for (const [method, url, body] of REMOVED) {
      const response = await request(token, url, method, body);
      assert.equal(response.statusCode, 410, `${method} ${url}: ${response.body}`);
      assert.equal(response.headers["cache-control"], "private, no-store", `${method} ${url}`);
      const answer = response.json() as { code: string; error: string };
      assert.equal(answer.code, "hardcover_removed", `${method} ${url}`);
      assert.match(answer.error, /^Hardcover is no longer part of Sonder/);
    }
  // An older build's empty JSON body gets the same answer.
  const empty = await app.inject({ method: "POST", url: "/api/hardcover/sync", cookies: { sonder_session: SAM }, headers: { "content-type": "application/json" }, payload: "{}" });
  assert.equal(empty.statusCode, 410);
  // Nothing was written: no token came back, no shelf or progress was queued.
  assert.deepEqual(tokens(), { users: [], server: 0 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM user_hardcover_outbox").pluck().get(), 0);
  assert.equal(fetches, 0);
});

test("an older build's Hardcover token in the settings is accepted from anyone and ignored; hardcoverConfigured stays, false", async () => {
  for (const token of [SAM, OWNER]) {
    const saved = await request(token, "/api/settings", "PATCH", { hardcover: "a-key-from-an-old-build" });
    assert.equal(saved.statusCode, 200, saved.body);
    const read = (await request(token, "/api/settings")).json() as { hardcoverConfigured: boolean };
    assert.equal(read.hardcoverConfigured, false);
  }
  assert.deepEqual(tokens(), { users: [], server: 0 });
  // Sam may still not change a setting of the server's alongside it.
  assert.equal((await request(SAM, "/api/settings", "PATCH", { hardcover: "", name: "Sam's server" })).statusCode, 403);
});

test("listening, adding to the library and a status change queue nothing for Hardcover", async () => {
  const progress = await request(OWNER, "/api/progress", "POST", { recordingId: "rec-audio", trackId: "t-audio", position: 120, duration: 600, updatedAt: Date.now() });
  assert.equal(progress.statusCode, 200, progress.body);
  assert.equal((await request(KIM, "/api/library", "POST", { bookId: "ed-audio" })).statusCode, 200);
  assert.equal((await request(KIM, "/api/library/ed-audio", "PATCH", { status: "finished" })).statusCode, 200);
  assert.equal((await request(SAM, "/api/works/w-audio/library", "PUT", {})).statusCode, 200);
  for (const table of ["user_hardcover_outbox", "user_hardcover_progress", "user_hardcover_reading_outbox"])
    assert.equal(sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
  // The owner's place stays his own and on this recording.
  assert.deepEqual(
    sqlite.prepare("SELECT user_id,recording_id,position FROM user_progress ORDER BY user_id").all(),
    [{ user_id: 1, recording_id: "rec-audio", position: 120 }],
  );
  assert.equal(fetches, 0);
});

test("Activity has no Hardcover sync process, and its pause switch is gone", async () => {
  const { ACTIVITY_SOURCES } = await import("../server/activity-sources.ts");
  const { PAUSABLE_PROCESSES } = await import("../server/activity-pause-model.ts");
  assert.equal(ACTIVITY_SOURCES.some((source) => source.kind === ("hardcover" as string)), false);
  assert.equal((PAUSABLE_PROCESSES as readonly string[]).includes("hardcover-sync"), false);
  const pause = await request(OWNER, "/api/activity/processes/hardcover-sync/pause", "POST", { paused: true });
  assert.equal(pause.statusCode, 404, pause.body);
});

test("a placeholder only Sam has on his Hardcover shelf stays hidden from Kim, and the owner's from Sam", async () => {
  const ids = async (token: string) => ((await request(token, "/api/books")).json() as { id: string }[]).map((book) => book.id).sort();
  assert.ok((await ids(SAM)).includes("hc-2002"));
  assert.equal((await ids(KIM)).includes("hc-2002"), false);
  assert.equal((await ids(KIM)).includes("hc-3001"), false);
  assert.equal((await ids(SAM)).includes("hc-3001"), false);
  assert.ok((await ids(OWNER)).includes("hc-2002"), "the administrator sees every placeholder");
});
