import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-activity-"));
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
const app = await createApp();
after(async () => {
  await app.close();
  rmSync(temp, { recursive: true, force: true });
});

const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;

test("the Activity list reads every kind from the real tables and is admin only", async () => {
  const admin = await login("203.0.113.180", { password: "admin-password" });
  const created = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
  assert.equal(created.statusCode, 200, created.body);
  const user = await login("203.0.113.181", { username: "reader", password: "password1" });

  const now = Date.now();
  const run = (label: string, sql: string, ...args: unknown[]) => { try { sqlite.prepare(sql).run(...args); } catch (error) { throw new Error(`${label}: ${(error as Error).message}`); } };
  run("works", "INSERT INTO works(id,title,author,description,genre,year) VALUES('w1','Speaker for the Dead','Card','','',1986)");
  run("editions", "INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed1','w1','','',0,'')");
  run("recordings", "INSERT INTO recordings(id,edition_id) VALUES('rec1','ed1')");
  run("acquisitions", "INSERT INTO acquisitions(id,hash,backend,title,author,cover,status,progress,error,created_at,updated_at,magnet) VALUES('acq1','h','local','Ender in Exile','Card','','downloading',0.7,'The local torrent client cannot be reached.',?,?,'magnet:?xt=urn:btih:h')", now - 1000, now);
  run("copies", "INSERT INTO server_downloads(recording_id,book_id,status,progress,created_at,updated_at) VALUES('rec1','ed1','downloading',0.3,?,?)", now - 1000, now);
  run("ebook", "INSERT INTO ebook_editions(id,work_id,format,source) VALUES('set-consensus:w1','w1','epub','x')");
  run("alignment", "INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES('job1','set-consensus:w1','rec1',?,?)", JSON.stringify({ status: "processing", progress: 0.4, error: null, createdAt: now - 5000, pool: { hostId: "wsl" } }), now);
  run("hardcover", "INSERT INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,intent,updated_at,error) VALUES(1,2475248,1,1,'add',?,?)", now - 5 * 24 * 3600_000, "We weren't able to find that book. Was it deleted?");

  assert.equal((await app.inject({ method: "GET", url: "/api/activity" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: user } })).statusCode, 403);

  const response = await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: admin } });
  assert.equal(response.statusCode, 200, response.body);
  const activity = response.json();
  const byId = Object.fromEntries(activity.items.map((item: any) => [item.id, item]));
  assert.equal(byId["acquisition:acq1"].title, "Ender in Exile");
  assert.equal(byId["acquisition:acq1"].progress, 0.7);
  assert.equal(byId["server-copy:rec1"].title, "Speaker for the Dead", "copy title comes from the work");
  assert.equal(byId["alignment:job1"].detail, "Ebook set check");
  assert.equal(byId["alignment:job1"].title, "Speaker for the Dead");
  assert.equal(byId["alignment:job1"].host, "wsl");
  assert.equal(byId["hardcover:status:1"].permanent, true);
  assert.equal(byId["hardcover:status:1"].user, "admin");
  assert.ok(activity.processes.some((process: any) => process.id === "torrent-client"));
  const backups = activity.processes.find((process: any) => process.id === "backups");
  assert.equal(backups?.label, "Database backups");
  assert.equal(backups?.notTracked, false, "the daily backups report themselves (#361)");
  assert.equal(backups?.pausable, true);
  assert.match(backups?.reason ?? "", /Next run /);
  assert.ok(activity.processes.some((process: any) => process.id === "imports" && process.notTracked));
  assert.equal(activity.stuckMultiplier, 1);
  assert.ok(activity.attention >= 1);
});

test("the stuck multiplier comes from the settings table", async () => {
  sqlite.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('activityStuckMultiplier','3')").run();
  const admin = await login("203.0.113.182", { password: "admin-password" });
  const activity = (await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: admin } })).json();
  assert.equal(activity.stuckMultiplier, 3);
});

const post = async (cookie: string, url: string, payload: unknown) =>
  app.inject({ method: "POST", url, cookies: { sonder_session: cookie }, payload: payload as any });
const getActivity = async (cookie: string) =>
  (await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: cookie } })).json();

test("the pause switch is admin only, validated, stored, and shown with what it does", async () => {
  const admin = await login("203.0.113.183", { password: "admin-password" });
  const user = await login("203.0.113.184", { username: "reader", password: "password1" });
  const url = "/api/activity/processes/alignment/pause";
  assert.equal((await app.inject({ method: "POST", url, payload: { paused: true } })).statusCode, 401);
  assert.equal((await post(user, url, { paused: true })).statusCode, 403);
  assert.equal((await post(admin, "/api/activity/processes/torrent-client/pause", { paused: true })).statusCode, 404, "a service cannot be paused");
  assert.equal((await post(admin, "/api/activity/processes/imports/pause", { paused: true })).statusCode, 404, "untracked processes cannot");
  assert.equal((await post(admin, url, {})).statusCode, 400);
  assert.equal((await post(admin, url, { paused: "yes" })).statusCode, 400);

  assert.equal((await post(admin, url, { paused: true })).statusCode, 200);
  assert.equal((sqlite.prepare("SELECT value FROM settings WHERE key='activityPaused:alignment'").get() as any).value, "1");
  const alignment = (await getActivity(admin)).processes.find((process: any) => process.id === "alignment");
  assert.equal(alignment.pausable, true);
  assert.equal(alignment.paused, true);
  assert.equal(alignment.lockedBy, null);
  assert.match(alignment.pauseEffect, /No new alignment job starts/);
  const hardcover = (await getActivity(admin)).processes.find((process: any) => process.id === "hardcover-sync");
  assert.equal(hardcover.paused, false);
  const torrent = (await getActivity(admin)).processes.find((process: any) => process.id === "torrent-client");
  assert.equal(torrent.pausable, false);
  assert.equal(torrent.pauseEffect, null);

  assert.equal((await post(admin, url, { paused: false })).statusCode, 200);
  assert.equal(sqlite.prepare("SELECT 1 FROM settings WHERE key='activityPaused:alignment'").get(), undefined);
});

test("a loop disabled by the environment shows as locked and refuses the switch", async () => {
  const admin = await login("203.0.113.185", { password: "admin-password" });
  process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
  try {
    const series = (await getActivity(admin)).processes.find((process: any) => process.id === "series-acquisition");
    assert.equal(series.lockedBy, "environment");
    const refused = await post(admin, "/api/activity/processes/series-acquisition/pause", { paused: true });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /environment/);
    assert.equal(sqlite.prepare("SELECT 1 FROM settings WHERE key='activityPaused:series-acquisition'").get(), undefined);
  } finally {
    delete process.env.SONDER_SKIP_SERIES_ACQUISITION;
  }
});

test("Discard removes a permanently failed Hardcover queue and nothing else; Retry sends the user's sync", async () => {
  const admin = await login("203.0.113.186", { password: "admin-password" });
  const readerId = (sqlite.prepare("SELECT id FROM users WHERE username='reader'").get() as { id: number }).id;
  const now = Date.now();
  sqlite.prepare("INSERT INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,intent,updated_at,error) VALUES(?,?,1,1,'add',?,?)")
    .run(readerId, 999, now, "socket hang up");
  sqlite.prepare("INSERT INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,intent,updated_at,error) VALUES(?,?,1,1,'add',?,NULL)")
    .run(1, 555, now);
  const before = await getActivity(admin);
  const adminItem = before.items.find((item: any) => item.id === "hardcover:status:1");
  assert.deepEqual(adminItem.actions, ["discard"], "a permanent error offers Discard, not Retry");
  assert.deepEqual(before.items.find((item: any) => item.id === `hardcover:status:${readerId}`).actions, ["retry"], "a transient error offers Retry");
  assert.deepEqual(before.items.find((item: any) => item.id === "acquisition:acq1").actions, [], "other kinds have no actions yet");

  assert.equal((await post(admin, "/api/activity/items/discard", { id: `hardcover:status:${readerId}` })).statusCode, 409, "a change that may still go through is not discarded");
  assert.equal((await post(admin, "/api/activity/items/discard", { id: "acquisition:acq1" })).statusCode, 400);
  assert.equal((await post(admin, "/api/activity/items/discard", { id: "hardcover:status:abc" })).statusCode, 400);
  assert.equal((await post(admin, "/api/activity/items/discard", { id: "hardcover:reading:1" })).statusCode, 404, "nothing queued there");

  const discarded = await post(admin, "/api/activity/items/discard", { id: "hardcover:status:1" });
  assert.equal(discarded.statusCode, 200, discarded.body);
  assert.equal(discarded.json().discarded, 1, "only the failed row went");
  assert.equal((sqlite.prepare("SELECT COUNT(*) n FROM user_hardcover_outbox WHERE user_id=1").get() as any).n, 1, "the healthy change for the same user stays");
  assert.equal((sqlite.prepare("SELECT COUNT(*) n FROM user_hardcover_outbox WHERE user_id=?").get(readerId) as any).n, 1, "another user's queue is untouched");

  const user = await login("203.0.113.187", { username: "reader", password: "password1" });
  assert.equal((await post(user, "/api/activity/items/discard", { id: "hardcover:status:1" })).statusCode, 403);
  assert.equal((await post(user, "/api/activity/items/retry", { id: `hardcover:status:${readerId}` })).statusCode, 403);
  const retried = await post(admin, "/api/activity/items/retry", { id: `hardcover:status:${readerId}` });
  assert.notEqual(retried.statusCode, 200, "the reader has no Hardcover account, so the sync reports why instead of pretending");
  assert.ok(retried.json().error, retried.body);
});
