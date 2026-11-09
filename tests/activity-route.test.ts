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
  assert.equal(byId["hardcover:listening:admin"].permanent, true);
  assert.equal(byId["hardcover:listening:admin"].user, "admin");
  assert.ok(activity.processes.some((process: any) => process.id === "torrent-client"));
  assert.ok(activity.processes.some((process: any) => process.id === "backups" && process.notTracked));
  assert.equal(activity.stuckMultiplier, 1);
  assert.ok(activity.attention >= 1);
});

test("the stuck multiplier comes from the settings table", async () => {
  sqlite.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('activityStuckMultiplier','3')").run();
  const admin = await login("203.0.113.182", { password: "admin-password" });
  const activity = (await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: admin } })).json();
  assert.equal(activity.stuckMultiplier, 3);
});
