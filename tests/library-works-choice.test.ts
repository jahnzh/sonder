// The chosen recording (#488): `PUT /api/works/<workId>/recording` and the rule both reads apply,
// on the fixture of `tests/library-works-fixture.ts`, as the owner (the administrator) and Sam.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { LibraryWork } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";
import { DAY, OWNER_TOKEN, SAM, SAM_TOKEN, T0, removeRecording, writeLibraryFixture } from "./library-works-fixture.ts";

const temp = tempDir("sonder-library-choice-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
writeLibraryFixture(sqlite, process.env.MEDIA_ROOT, hashToken);
// Sam also has the owner's second recording of w-two, so Sam has a choice to make there too.
sqlite.prepare("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)").run(SAM, "ed-two-b", T0 + 7 * DAY);
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });

after(async () => {
  await app.close();
  sqlite.close();
});

const get = (url: string, token: string, headers: Record<string, string> = {}) =>
  app.inject({ url, headers, cookies: { sonder_session: token } });
const choose = (workId: string, recordingId: string, token = OWNER_TOKEN) =>
  app.inject({
    method: "PUT",
    url: `/api/works/${workId}/recording`,
    payload: { recordingId },
    cookies: { sonder_session: token },
  });

async function library(token: string) {
  const response = await get("/api/library", token);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LibraryWork[];
}
async function work(token: string, workId: string) {
  const response = await get(`/api/works/${workId}`, token);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LibraryWork;
}
/** The work as both reads give it: the two must agree. */
async function bothReads(token: string, workId: string) {
  const listed = (await library(token)).find((w) => w.workId === workId);
  assert.ok(listed, `${workId} is in the library`);
  assert.deepEqual(await work(token, workId), listed, "both reads give the same work");
  return listed;
}
/** Removes ed-removed-gone from the owner's library, unless an earlier test did. */
async function removeOnce() {
  if (sqlite.prepare("SELECT 1 FROM user_library WHERE user_id=1 AND book_id='ed-removed-gone'").get())
    await removeRecording((options) => app.inject(options));
}
const chosen = (w: LibraryWork) => ({ chosenRecordingId: w.chosenRecordingId, cover: w.cover });
const stored = (userId: number, workId: string) =>
  (
    sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key=?").get(userId, `chosenRecording:${workId}`) as
      | { value: string }
      | undefined
  )?.value ?? null;

test("without a stored choice: the newest place, otherwise the recording added first", async () => {
  assert.deepEqual(chosen(await bothReads(OWNER_TOKEN, "w-two")), { chosenRecordingId: "rec-two-b", cover: "/covers/two-b.jpg" });
  assert.deepEqual(chosen(await bothReads(OWNER_TOKEN, "w-unplayed")), {
    chosenRecordingId: "rec-unplayed-b",
    cover: "/covers/unplayed-b.jpg",
  });
});

test("after PUT both reads name the new recording and show its cover", async () => {
  const response = await choose("w-two", "rec-two-a");
  assert.equal(response.statusCode, 200, response.body);
  const answered = response.json() as LibraryWork;
  const expected = { chosenRecordingId: "rec-two-a", cover: "/covers/two-a.jpg" };
  assert.deepEqual(chosen(answered), expected);
  // The stored choice wins over the newest place (rec-two-b) ...
  const two = await bothReads(OWNER_TOKEN, "w-two");
  assert.deepEqual(chosen(two), expected);
  assert.deepEqual(answered, two, "the PUT answers the work as the one-work read does");
  // ... and over the recording added first.
  assert.equal((await choose("w-unplayed", "rec-unplayed-a")).statusCode, 200);
  assert.deepEqual(chosen(await bothReads(OWNER_TOKEN, "w-unplayed")), {
    chosenRecordingId: "rec-unplayed-a",
    cover: "/covers/unplayed-a.jpg",
  });
  assert.equal(stored(1, "w-unplayed"), "rec-unplayed-a");
});

test("a stored choice whose recording was removed falls back to the default", async () => {
  assert.deepEqual(chosen(await bothReads(OWNER_TOKEN, "w-removed")), {
    chosenRecordingId: "rec-removed-keep",
    cover: "/covers/removed-keep.jpg",
  });
  assert.equal((await choose("w-removed", "rec-removed-gone")).statusCode, 200);
  assert.deepEqual(chosen(await bothReads(OWNER_TOKEN, "w-removed")), {
    chosenRecordingId: "rec-removed-gone",
    cover: "/covers/removed-gone.jpg",
  });
  await removeOnce();
  const removed = await bothReads(OWNER_TOKEN, "w-removed");
  assert.deepEqual(removed.recordings.map((r) => r.recordingId), ["rec-removed-keep"]);
  assert.deepEqual(chosen(removed), { chosenRecordingId: "rec-removed-keep", cover: "/covers/removed-keep.jpg" });
});

test("PUT is refused for a recording that is not one of the user's recordings of the work", async () => {
  await removeOnce();
  const choices = () => sqlite.prepare("SELECT user_id,key,value FROM user_settings ORDER BY user_id,key").all();
  const storedBefore = choices();
  const before = await library(OWNER_TOKEN);
  const refused = async (workId: string, recordingId: string, token: string, why: string) => {
    const response = await choose(workId, recordingId, token);
    assert.equal(response.statusCode, 400, `${why}: ${response.body}`);
    assert.match(response.json().error, /recordings of this book/, why);
  };
  // rec-unplayed-a is the owner's, of another work.
  await refused("w-two", "rec-unplayed-a", OWNER_TOKEN, "a recording of another work");
  // rec-removed-gone was in the owner's library until it was removed.
  await refused("w-removed", "rec-removed-gone", OWNER_TOKEN, "a recording the user removed");
  // hc-102 is a placeholder in the owner's library, beside ed-beside.
  await refused("w-beside", "recording-hc-102", OWNER_TOKEN, "a placeholder's recording");
  await refused("w-only", "recording-hc-101", OWNER_TOKEN, "the recording of a work's only placeholder");
  // ed-unplayed-a is only in the owner's library; Sam has neither recording of w-unplayed.
  await refused("w-unplayed", "rec-unplayed-a", SAM_TOKEN, "a recording only another user has");
  // ed-outside is in nobody's library.
  await refused("w-outside", "rec-outside", OWNER_TOKEN, "a recording outside the library");
  await refused("w-two", "no-such-recording", OWNER_TOKEN, "a recording that does not exist");
  const empty = await app.inject({
    method: "PUT",
    url: "/api/works/w-two/recording",
    payload: {},
    cookies: { sonder_session: OWNER_TOKEN },
  });
  assert.equal(empty.statusCode, 400, "a request without a recording");
  const unknown = await choose("no-such-work", "rec-two-a");
  assert.equal(unknown.statusCode, 404, unknown.body);
  // Nothing refused was stored, and no read changed.
  assert.deepEqual(choices(), storedBefore);
  assert.equal(stored(1, "w-beside"), null);
  assert.equal(stored(SAM, "w-unplayed"), null);
  assert.deepEqual(await library(OWNER_TOKEN), before);
});

test("a second user's choice for the same work is independent", async () => {
  // Sam has no stored choice yet, and Sam's newest place is in rec-two-a.
  assert.equal(stored(SAM, "w-two"), null);
  assert.equal((await bothReads(SAM_TOKEN, "w-two")).chosenRecordingId, "rec-two-a");
  assert.equal((await choose("w-two", "rec-two-a")).statusCode, 200);
  const ownerTag = String((await get("/api/library", OWNER_TOKEN)).headers.etag);
  assert.equal((await choose("w-two", "rec-two-b", SAM_TOKEN)).statusCode, 200);
  assert.deepEqual(chosen(await bothReads(SAM_TOKEN, "w-two")), { chosenRecordingId: "rec-two-b", cover: "/covers/two-b.jpg" });
  assert.deepEqual(chosen(await bothReads(OWNER_TOKEN, "w-two")), { chosenRecordingId: "rec-two-a", cover: "/covers/two-a.jpg" });
  assert.equal(
    (await get("/api/library", OWNER_TOKEN, { "if-none-match": ownerTag })).statusCode,
    304,
    "Sam's choice leaves the owner's library unchanged",
  );
  // The owner's change does not move Sam's.
  assert.equal((await choose("w-two", "rec-two-b")).statusCode, 200);
  assert.equal((await choose("w-two", "rec-two-a", SAM_TOKEN)).statusCode, 200);
  assert.equal((await bothReads(OWNER_TOKEN, "w-two")).chosenRecordingId, "rec-two-b");
  assert.equal((await bothReads(SAM_TOKEN, "w-two")).chosenRecordingId, "rec-two-a");
});

test("the entity tag of GET /api/library changes after a change of choice", async () => {
  const first = await get("/api/library", OWNER_TOKEN);
  const tag = String(first.headers.etag);
  assert.equal((await get("/api/library", OWNER_TOKEN, { "if-none-match": tag })).statusCode, 304);
  assert.equal((await choose("w-two", "rec-two-a")).statusCode, 200);
  const changed = await get("/api/library", OWNER_TOKEN, { "if-none-match": tag });
  assert.equal(changed.statusCode, 200);
  assert.notEqual(String(changed.headers.etag), tag);
  assert.equal((changed.json() as LibraryWork[]).find((w) => w.workId === "w-two")?.chosenRecordingId, "rec-two-a");
  // Choosing the same recording again changes nothing the response shows.
  const again = String(changed.headers.etag);
  assert.equal((await choose("w-two", "rec-two-a")).statusCode, 200);
  assert.equal((await get("/api/library", OWNER_TOKEN, { "if-none-match": again })).statusCode, 304);
});
