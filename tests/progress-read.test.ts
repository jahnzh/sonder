// GET /api/progress/:recordingId (#773): one recording's saved place for the account asking, read by a paused player
// before it resumes. Additive (POST /api/progress and GET /api/books are unchanged) and per account: a second account
// learns nothing of the first one's place.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-progress-read-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
});

const login = async (username: string | undefined, password: string) => {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
};
const admin = await login(undefined, "admin-password");
assert.equal((await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "other", password: "password1" } })).statusCode, 200);
const other = await login("other", "password1");

sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-773','Progress','Author','','Fiction',1990)").run();
sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed-773','w-773','/covers/x.jpg','N',0,'Test')").run();
sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES('rec-773','ed-773')").run();
sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES('rec-773-b','ed-773')").run();
for (const [id, recording] of [["tr-773-0", "rec-773"], ["tr-773-1", "rec-773"], ["tr-773-b", "rec-773-b"]])
  sqlite.prepare("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES(?,?,'Part',0,640,'/media/x.mp3','local')").run(id, recording);

const read = (cookie: string, recordingId: string) =>
  app.inject({ method: "GET", url: `/api/progress/${encodeURIComponent(recordingId)}`, cookies: { sonder_session: cookie } });
const save = (cookie: string, payload: object) =>
  app.inject({ method: "POST", url: "/api/progress", cookies: { sonder_session: cookie }, payload });

test("a recording with no saved place answers null", async () => {
  const answer = await read(admin, "rec-773");
  assert.equal(answer.statusCode, 200);
  assert.deepEqual(answer.json(), { progress: null });
  assert.equal(answer.headers["cache-control"], "no-store");
  // An unknown recording answers the same, so the route says nothing of which recordings exist.
  assert.deepEqual((await read(admin, "no-such-recording")).json(), { progress: null });
});

test("the newest place saved from any device is the answer, with the fields POST /api/progress takes", async () => {
  const at = Date.now() - 10_000;
  // Device A pauses at 100 s; device B saves 300 s on the next track later.
  assert.equal((await save(admin, { recordingId: "rec-773", trackId: "tr-773-0", position: 100, duration: 640, updatedAt: at })).statusCode, 200);
  assert.equal((await save(admin, { recordingId: "rec-773", trackId: "tr-773-1", position: 300, duration: 640, updatedAt: at + 5_000 })).statusCode, 200);
  assert.deepEqual((await read(admin, "rec-773")).json(), {
    progress: { recordingId: "rec-773", trackId: "tr-773-1", position: 300, duration: 640, updatedAt: at + 5_000 },
  });
  // A's stale place, sent after, does not set it back, and the read still answers B's.
  const stale = await save(admin, { recordingId: "rec-773", trackId: "tr-773-0", position: 100, duration: 640, updatedAt: at + 1 });
  assert.equal(stale.json().conflict, true);
  assert.equal((await read(admin, "rec-773")).json().progress.position, 300);
  // Only the recording asked for: another recording of the same work has its own place (none here).
  assert.deepEqual((await read(admin, "rec-773-b")).json(), { progress: null });
});

test("a second account learns nothing of the first account's place, and keeps its own", async () => {
  assert.deepEqual((await read(other, "rec-773")).json(), { progress: null });
  const at = Date.now() - 1_000;
  assert.equal((await save(other, { recordingId: "rec-773", trackId: "tr-773-0", position: 7, duration: 640, updatedAt: at })).statusCode, 200);
  assert.deepEqual((await read(other, "rec-773")).json().progress, { recordingId: "rec-773", trackId: "tr-773-0", position: 7, duration: 640, updatedAt: at });
  assert.equal((await read(admin, "rec-773")).json().progress.position, 300);
  assert.ok(!JSON.stringify((await read(other, "rec-773")).json()).includes("userId"));
});

test("without a session the read is refused", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/progress/rec-773" })).statusCode, 401);
});
