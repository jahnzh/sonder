// Add to library and Remove from library by work (#527): `PUT` and `DELETE /api/works/<workId>/library`
// on the fixture of `tests/library-works-fixture.ts`, with a few works of its own, read as the owner (the
// administrator) and as Sam (a user). Hardcover is removed (#721 part d): nothing is queued for it any more.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { LibraryWork } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";
import { DAY, OWNER, OWNER_TOKEN, SAM, SAM_TOKEN, T0, removeRecording, writeLibraryFixture } from "./library-works-fixture.ts";

const temp = tempDir("sonder-work-library-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
writeLibraryFixture(sqlite, process.env.MEDIA_ROOT, hashToken);
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
// Written here, not in the shared fixture, so the `GET /api/books` pin stays as recorded.
// - w-pair: two real recordings in nobody's library; the owner hid ed-pair-b and has a place in it.
//   Linked to Hardcover book 9002 (a stored link that stays, unused).
// - w-text: a work with an ebook and no audio edition at all.
// - w-two gets an ebook edition with the owner's place, checkpoint and bookmark in it.
run("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-pair','A Pair','Pair Author','About a pair.','Fiction',2002)");
for (const [edition, recording, track] of [
  ["ed-pair-a", "rec-pair-a", "t-pair-a-0"],
  ["ed-pair-b", "rec-pair-b", "t-pair-b-0"],
]) {
  run(
    "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,'w-pair',?,?,'en',?,4,'Test source')",
    edition,
    `/covers/${edition}.jpg`,
    `Narrator of ${edition}`,
    `Release ${edition}`,
  );
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", recording, edition);
  run(
    "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,'Part 1',0,600,?,'remote','[]')",
    track,
    recording,
    `https://audio.example/${track}.mp3`,
  );
}
run("INSERT INTO user_hidden_library(user_id,book_id) VALUES(?,'ed-pair-b')", OWNER);
run("INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(?,'rec-pair-b','t-pair-b-0',250,600,?)", OWNER, T0 + 2 * DAY);
run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-pair',9002,'a-pair','[]')");
run("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-text','Only Text','Text Author','About text.','Fiction',2003)");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-text','w-text','epub','/books/text.epub')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-two','w-two','epub','/books/two.epub')");
run("INSERT INTO user_ebook_progress(user_id,edition_id,cfi,chapter,updated_at) VALUES(?,'eb-two','epubcfi(/6/4)',2,?)", OWNER, T0 + 3 * DAY);
run("INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(?,'eb-two','{\"progression\":0.4}')", OWNER);
run("INSERT INTO user_reader_bookmarks(user_id,id,edition_id,label,locator,created_at) VALUES(?,'bm-1','eb-two','Here','{}',?)", OWNER, T0);

// The fixture is a library after the one-off start step (#555): w-text stays outside the owner's
// library until a test adds it, so the step is marked done before the server starts.
run("INSERT INTO user_settings(user_id,key,value) VALUES(?,'shelfEbooksJoined','1')", OWNER);
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
await removeRecording((options) => app.inject(options));

after(async () => {
  await app.close();
  sqlite.close();
});

type Method = "GET" | "PUT" | "DELETE" | "PATCH" | "POST";
const call = (method: Method, url: string, token: string, payload?: object) =>
  app.inject({ method, url, cookies: { sonder_session: token }, ...(payload ? { payload } : {}) });
/** `PUT` or `DELETE` of a work's membership with no body, as the book dialog sends it. */
const membership = (method: "PUT" | "DELETE", workId: string, token = OWNER_TOKEN) =>
  app.inject({ method, url: `/api/works/${workId}/library`, cookies: { sonder_session: token } });

const rows = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...args);
const libraryRows = (userId: number, workId: string) =>
  (rows(
    "SELECT u.book_id AS id FROM user_library u JOIN audio_editions e ON e.id=u.book_id WHERE u.user_id=? AND e.work_id=? ORDER BY u.book_id",
    userId,
    workId,
  ) as { id: string }[]).map((row) => row.id);
const hiddenRows = (userId: number, workId: string) =>
  (rows(
    "SELECT h.book_id AS id FROM user_hidden_library h JOIN audio_editions e ON e.id=h.book_id WHERE h.user_id=? AND e.work_id=? ORDER BY h.book_id",
    userId,
    workId,
  ) as { id: string }[]).map((row) => row.id);
const origin = (userId: number, workId: string) =>
  sqlite.prepare("SELECT source,series_id AS seriesId FROM user_work_library_origin WHERE user_id=? AND work_id=?").get(userId, workId);
const outbox = (userId: number) =>
  rows("SELECT book_id AS bookId,status_id AS statusId,intent FROM user_hardcover_outbox WHERE user_id=? ORDER BY book_id", userId);
/** Every row of the user's own that adding or removing a book could touch. */
const userState = (userId: number) =>
  Object.fromEntries(
    [
      "user_library",
      "user_hidden_library",
      "user_work_library_origin",
      "user_hardcover_outbox",
      "user_progress",
      "user_ebook_progress",
      "user_reader_checkpoints",
      "user_reader_bookmarks",
      "user_settings",
    ].map((table) => [table, rows(`SELECT * FROM ${table} WHERE user_id=? ORDER BY 1,2`, userId)]),
  );
async function library(token = OWNER_TOKEN) {
  const response = await call("GET", "/api/library", token);
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as LibraryWork[]).map((w) => w.workId);
}
async function work(workId: string, token = OWNER_TOKEN) {
  const response = await call("GET", `/api/works/${workId}`, token);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LibraryWork;
}
test("PUT adds every recording of a work and unhides a hidden one; the origin is written once and Hardcover is told nothing", async () => {
  const sam = userState(SAM);
  assert.deepEqual(libraryRows(OWNER, "w-pair"), []);
  assert.deepEqual(hiddenRows(OWNER, "w-pair"), ["ed-pair-b"]);
  const added = await membership("PUT", "w-pair");
  assert.equal(added.statusCode, 200, added.body);
  // The answer names the work that was added (#574).
  assert.deepEqual(added.json(), { ok: true, workId: "w-pair" });
  assert.deepEqual(libraryRows(OWNER, "w-pair"), ["ed-pair-a", "ed-pair-b"]);
  assert.deepEqual(hiddenRows(OWNER, "w-pair"), []);
  assert.deepEqual(origin(OWNER, "w-pair"), { source: "manual", seriesId: null });
  assert.deepEqual(outbox(OWNER), []);
  // The work is in the library with both recordings, the place in the one that was hidden kept.
  const pair = await work("w-pair");
  assert.equal(pair.inLibrary, true);
  assert.deepEqual(pair.recordings.map((r) => r.recordingId), ["rec-pair-a", "rec-pair-b"]);
  assert.equal(pair.recordings[1].progress?.position, 250);
  assert.ok((await library()).includes("w-pair"));
  // Adding the work again writes nothing more.
  assert.equal((await membership("PUT", "w-pair")).statusCode, 200);
  assert.deepEqual(outbox(OWNER), []);
  assert.deepEqual(libraryRows(OWNER, "w-pair"), ["ed-pair-a", "ed-pair-b"]);
  assert.deepEqual(userState(SAM), sam, "Sam's rows are untouched");
});

test("PUT of a work already in the library keeps its origin and its shelf status", async () => {
  run("INSERT INTO user_work_library_origin(user_id,work_id,source,series_id,added_at) VALUES(?,'w-removed','hardcover_sync',NULL,?)", OWNER, T0);
  run("UPDATE user_library SET status='listening' WHERE user_id=? AND book_id='ed-removed-keep'", OWNER);
  assert.deepEqual(hiddenRows(OWNER, "w-removed"), ["ed-removed-gone"]);
  assert.equal((await membership("PUT", "w-removed")).statusCode, 200);
  assert.deepEqual(libraryRows(OWNER, "w-removed"), ["ed-removed-gone", "ed-removed-keep"]);
  assert.deepEqual(hiddenRows(OWNER, "w-removed"), []);
  assert.deepEqual(origin(OWNER, "w-removed"), { source: "hardcover_sync", seriesId: null });
  assert.deepEqual(
    rows("SELECT book_id AS id,status FROM user_library WHERE user_id=? AND book_id LIKE 'ed-removed-%' ORDER BY book_id", OWNER),
    [
      { id: "ed-removed-gone", status: "unread" },
      { id: "ed-removed-keep", status: "listening" },
    ],
  );
  assert.deepEqual(outbox(OWNER), []);
});

test("PUT of a work with only a placeholder adds the placeholder's row", async () => {
  const sam = userState(SAM);
  // w-sam's only edition is the placeholder hc-103, in Sam's library; the administrator sees it.
  assert.deepEqual(libraryRows(OWNER, "w-sam"), []);
  const added = await membership("PUT", "w-sam");
  assert.equal(added.statusCode, 200, added.body);
  assert.deepEqual(libraryRows(OWNER, "w-sam"), ["hc-103"]);
  assert.deepEqual(origin(OWNER, "w-sam"), { source: "manual", seriesId: null });
  const placeholderOnly = await work("w-sam");
  assert.equal(placeholderOnly.inLibrary, true);
  assert.deepEqual(placeholderOnly.recordings, []);
  assert.ok((await library()).includes("w-sam"));
  assert.deepEqual(userState(SAM), sam, "Sam's rows are untouched");
});

test("PUT of a work with a real recording beside a placeholder adds only the real one", async () => {
  const owner = userState(OWNER);
  // Sam has nothing of w-beside, which has the placeholder hc-102 beside ed-beside.
  assert.deepEqual(libraryRows(SAM, "w-beside"), []);
  const added = await membership("PUT", "w-beside", SAM_TOKEN);
  assert.equal(added.statusCode, 200, added.body);
  assert.deepEqual(libraryRows(SAM, "w-beside"), ["ed-beside"]);
  assert.deepEqual(origin(SAM, "w-beside"), { source: "manual", seriesId: null });
  assert.deepEqual((await work("w-beside", SAM_TOKEN)).recordings.map((r) => r.recordingId), ["rec-beside"]);
  assert.deepEqual(userState(OWNER), owner, "the owner's rows are untouched");
  // The owner has both rows; adding the work again drops the placeholder's row beside the real one.
  assert.deepEqual(libraryRows(OWNER, "w-beside"), ["ed-beside", "hc-102"]);
  assert.equal((await membership("PUT", "w-beside")).statusCode, 200);
  assert.deepEqual(libraryRows(OWNER, "w-beside"), ["ed-beside"]);
  // It was in the library already, so its origin (none in the fixture) is kept.
  assert.equal(origin(OWNER, "w-beside"), undefined);
});

test("PUT of a work with no audio edition makes its placeholder and adds its row (#555)", async () => {
  const sam = userState(SAM);
  assert.deepEqual(rows("SELECT id FROM audio_editions WHERE work_id='w-text'"), []);
  assert.equal((await work("w-text")).inLibrary, false);
  const added = await membership("PUT", "w-text");
  assert.equal(added.statusCode, 200, added.body);
  assert.deepEqual(added.json(), { ok: true, workId: "w-text" });
  assert.deepEqual(rows("SELECT id,narrator,cover FROM audio_editions WHERE work_id='w-text'"), [
    { id: "placeholder-w-text", narrator: "Audio not added", cover: "" },
  ]);
  assert.deepEqual(libraryRows(OWNER, "w-text"), ["placeholder-w-text"]);
  assert.deepEqual(origin(OWNER, "w-text"), { source: "manual", seriesId: null });
  assert.equal((await work("w-text")).inLibrary, true);
  assert.ok((await library()).includes("w-text"));
  assert.deepEqual(userState(SAM), sam, "Sam's rows are untouched");
});

test("a work the user may not see, or that does not exist, answers 404 and writes nothing", async () => {
  const sam = userState(SAM);
  // w-only's only edition is the owner's placeholder hc-101, which Sam may not see (GET answers 404 too).
  assert.equal((await call("GET", "/api/works/w-only", SAM_TOKEN)).statusCode, 404);
  for (const method of ["PUT", "DELETE"] as const) {
    const hidden = await membership(method, "w-only", SAM_TOKEN);
    assert.equal(hidden.statusCode, 404, hidden.body);
    assert.deepEqual(hidden.json(), { error: "This book could not be found." });
    assert.equal((await membership(method, "w-nowhere", SAM_TOKEN)).statusCode, 404);
  }
  assert.deepEqual(userState(SAM), sam);
  assert.deepEqual(libraryRows(OWNER, "w-only"), ["hc-101"]);
});

test("DELETE hides every edition of the work and keeps places, bookmarks and the other user's rows", async () => {
  const sam = userState(SAM);
  const progress = rows("SELECT * FROM user_progress WHERE user_id=? ORDER BY recording_id", OWNER);
  const reading = ["user_ebook_progress", "user_reader_checkpoints", "user_reader_bookmarks"].map((table) =>
    rows(`SELECT * FROM ${table} WHERE user_id=?`, OWNER),
  );
  assert.deepEqual(libraryRows(OWNER, "w-two"), ["ed-two-a", "ed-two-b"]);
  const removed = await membership("DELETE", "w-two");
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { ok: true });
  assert.deepEqual(libraryRows(OWNER, "w-two"), []);
  assert.deepEqual(hiddenRows(OWNER, "w-two"), ["ed-two-a", "ed-two-b"]);
  assert.equal(origin(OWNER, "w-two"), undefined);
  assert.deepEqual(rows("SELECT * FROM user_progress WHERE user_id=? ORDER BY recording_id", OWNER), progress);
  assert.deepEqual(
    ["user_ebook_progress", "user_reader_checkpoints", "user_reader_bookmarks"].map((table) =>
      rows(`SELECT * FROM ${table} WHERE user_id=?`, OWNER),
    ),
    reading,
  );
  assert.equal(reading[2].length, 1);
  assert.deepEqual(userState(SAM), sam, "Sam keeps ed-two-a and his place in it");
  assert.ok(!(await library()).includes("w-two"));
  const outside = await work("w-two");
  assert.equal(outside.inLibrary, false);
  assert.deepEqual(outside.recordings, []);
  assert.ok((await library(SAM_TOKEN)).includes("w-two"));
  // The stored Hardcover shelf row does not bring it back (Hardcover is removed, #721 part d).
  assert.deepEqual(libraryRows(OWNER, "w-two"), []);
  assert.ok(!(await library()).includes("w-two"));
  // Removing it again changes nothing.
  assert.equal((await membership("DELETE", "w-two")).statusCode, 200);
  assert.deepEqual(hiddenRows(OWNER, "w-two"), ["ed-two-a", "ed-two-b"]);
});

test("DELETE hides the placeholder too, so a work with only a placeholder stays out", async () => {
  assert.equal((await membership("DELETE", "w-only")).statusCode, 200);
  assert.deepEqual(libraryRows(OWNER, "w-only"), []);
  assert.deepEqual(hiddenRows(OWNER, "w-only"), ["hc-101"]);
  // w-beside: the placeholder is hidden beside the real edition, whether or not it had a row.
  assert.equal((await membership("DELETE", "w-beside")).statusCode, 200);
  assert.deepEqual(hiddenRows(OWNER, "w-beside"), ["ed-beside", "hc-102"]);
  assert.deepEqual(libraryRows(SAM, "w-beside"), ["ed-beside"]);
  for (const workId of ["w-only", "w-beside"]) assert.ok(!(await library()).includes(workId), workId);
  // Adding w-beside again unhides and adds only the real edition; the placeholder stays hidden.
  assert.equal((await membership("PUT", "w-beside")).statusCode, 200);
  assert.deepEqual(libraryRows(OWNER, "w-beside"), ["ed-beside"]);
  assert.deepEqual(hiddenRows(OWNER, "w-beside"), ["hc-102"]);
});

test("PUT after DELETE brings the work back with its places, its stored choice and nothing hidden", async () => {
  const chose = await call("PUT", "/api/works/w-pair/recording", OWNER_TOKEN, { recordingId: "rec-pair-a" });
  assert.equal(chose.statusCode, 200, chose.body);
  assert.equal((await membership("DELETE", "w-pair")).statusCode, 200);
  assert.ok(!(await library()).includes("w-pair"));
  assert.equal((await membership("PUT", "w-pair")).statusCode, 200);
  const pair = await work("w-pair");
  assert.equal(pair.inLibrary, true);
  assert.equal(pair.chosenRecordingId, "rec-pair-a");
  assert.equal(pair.recordings.find((r) => r.recordingId === "rec-pair-b")?.progress?.position, 250);
  assert.deepEqual(hiddenRows(OWNER, "w-pair"), []);
});

test("both routes accept an empty JSON body and no body at all", async () => {
  for (const [method, workId] of [
    ["DELETE", "w-unplayed"],
    ["PUT", "w-unplayed"],
  ] as const) {
    for (const body of [{ headers: { "content-type": "application/json" }, payload: "" }, {}]) {
      const response = await app.inject({
        method,
        url: `/api/works/${workId}/library`,
        cookies: { sonder_session: OWNER_TOKEN },
        ...body,
      });
      assert.equal(response.statusCode, 200, `${method} ${JSON.stringify(body)}: ${response.body}`);
      // PUT names the work that was added (#574); DELETE answers as before.
      assert.deepEqual(response.json(), method === "PUT" ? { ok: true, workId } : { ok: true });
    }
    assert.equal((await library()).includes("w-unplayed"), method === "PUT", method);
  }
  // Older clients' requests by edition still work beside them.
  assert.equal((await call("DELETE", "/api/library/ed-unplayed-a", OWNER_TOKEN)).statusCode, 200);
  assert.deepEqual(libraryRows(OWNER, "w-unplayed"), ["ed-unplayed-b"]);
  assert.equal((await call("POST", "/api/library", OWNER_TOKEN, { bookId: "ed-unplayed-a" })).statusCode, 200);
  assert.deepEqual(libraryRows(OWNER, "w-unplayed"), ["ed-unplayed-a", "ed-unplayed-b"]);
});
