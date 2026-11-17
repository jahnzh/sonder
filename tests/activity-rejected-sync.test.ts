/**
 * A new reading sync the #379 rule did not use lights no attention dot (#539, decided in #462 point 6). Through the
 * real route on a throwaway database: the automatic rebuild, Prepare again and a projected member's rejection are
 * finished, carry no `attention` and are not in the response's count; a stopped one is failed and counted. A second
 * user learns nothing of them.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-activity-rejected-");
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
});

const MIN = 60_000;
const now = Date.now();
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;

const REASON = "The rebuild was rejected: it mapped none of the text. The previous map (82% of the text mapped) stays published.";

run("INSERT INTO works(id,title,author,description,genre,year) VALUES('w1','Speaker for the Dead','Card','','',1986)");
run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed1','w1','','',0,'')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb1','w1','epub','x')");
const job = (id: string, data: Record<string, unknown>, age = MIN) => {
  run("INSERT INTO recordings(id,edition_id) VALUES(?,'ed1')", `rec-${id}`);
  run("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,'eb1',?,?,?)",
    id, `rec-${id}`, JSON.stringify({ id, createdAt: now - 60 * MIN, ...data }), now - age);
};
// As `rejectWorseRebuild` and `rejectRebuild` in server/alignment-transitions.ts store them.
job("rebuild-rejected", { status: "error", outcome: "rejected", error: REASON, progress: 1, rebuildOf: { engine: "aeneas-1.7.3" } });
job("again-rejected", { status: "error", outcome: "rejected", error: REASON, progress: 1 }, 2 * MIN);
job("projected-rejected", { status: "error", outcome: "rejected", error: REASON, progress: 1, origin: "projected" }, 3 * MIN);
job("stopped", { status: "error", error: "The worker stopped.", progress: 0.4 }, 4 * MIN);

const admin = await login("203.0.113.200", { password: "admin-password" });
const created = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
assert.equal(created.statusCode, 200, created.body);
const reader = await login("203.0.113.201", { username: "reader", password: "password1" });

test("a rejected reading sync is finished, has no attention and is not counted; a stopped one is failed and counted", async () => {
  const response = await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: admin } });
  assert.equal(response.statusCode, 200, response.body);
  const activity = response.json();
  const byId = Object.fromEntries(activity.items.filter((item: any) => item.kind === "alignment").map((item: any) => [item.id, item]));
  for (const id of ["rebuild-rejected", "again-rejected", "projected-rejected"]) {
    const item = byId[`alignment:${id}`];
    assert.equal(item.state, "done", id);
    assert.equal(item.attention, false, id);
    assert.equal(item.stuck, null, id);
    assert.equal(item.facts.status, "error", `${id}: the facts keep the stored status`);
    assert.equal(item.facts.outcome, "rejected", id);
    assert.equal(item.error, REASON, `${id}: the server's sentence stays for older clients`);
  }
  assert.deepEqual(byId["alignment:rebuild-rejected"].actions, ["retry"], "Prepare again stays available");
  assert.deepEqual(byId["alignment:projected-rejected"].actions, [], "a projected map is rebuilt by its set's check");
  assert.equal(byId["alignment:stopped"].state, "failed");
  assert.equal(byId["alignment:stopped"].attention, true);
  const attentionItems = activity.items.filter((item: any) => item.attention).map((item: any) => item.id);
  assert.ok(attentionItems.includes("alignment:stopped"));
  assert.deepEqual(attentionItems.filter((id: string) => id.endsWith("-rejected")), [], "no rejected one is counted");
  const down = activity.processes.filter((process: any) => process.health === "down" && !process.notTracked).length;
  assert.equal(activity.attention, attentionItems.length + down, "the count is the items with attention plus the processes that are down");
  assert.equal(activity.processes.find((process: any) => process.id === "alignment").counts.failed, 1, "the queue counts the stopped one only");
});

test("a second user is refused the list and learns nothing of the rejected reading syncs", async () => {
  const response = await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: reader } });
  assert.equal(response.statusCode, 403);
  for (const needle of ["rejected", "Speaker for the Dead", "rec-", "attention", REASON])
    assert.equal(response.body.includes(needle), false, needle);
});
