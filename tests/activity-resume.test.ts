/**
 * Retry and Resume of downloads and reading syncs through Activity (#515, ADR 0010): `/api/activity/items/retry` and
 * `/api/activity/items/resume` on the real app, each through the route the feature has today (the server queue's
 * `POST /api/acquisitions/<id>/control` in Activity's Now, the reading sync's `PATCH /api/alignments/<id>` resume). A
 * fake Transmission answers the torrent client's RPC; nothing leaves the process.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-activity-resume-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.TRANSMISSION_RPC_URL = "http://transmission.invalid/transmission/rpc";
delete process.env.TRANSMISSION_USERNAME;
delete process.env.ALIGNMENT_POOL_ENABLED;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;

/** The RPC calls the fake torrent client received, by method. */
const rpc: Array<{ method: string; arguments: Record<string, unknown> }> = [];
/** The calls that change a torrent; Activity's health probe also asks the client (`session-get`, `port-test`). */
const changes = () => rpc.filter((call) => ["torrent-add", "torrent-start", "torrent-stop"].includes(call.method));
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("http://transmission.invalid/")) throw new Error(`No network in this test: ${url}`);
  const call = JSON.parse(String(init?.body)) as { method: string; arguments: Record<string, unknown> };
  rpc.push(call);
  const answers: Record<string, unknown> = {
    "session-get": { version: "4.0.6", "download-dir": join(temp, "media", "torrents", "complete"), "incomplete-dir": "", "incomplete-dir-enabled": false },
    "port-test": { "port-is-open": true },
    "torrent-add": { "torrent-added": { hashString: "a".repeat(40), id: 1, name: "Ender in Exile" } },
    "torrent-start": {},
    "torrent-stop": {},
    // The retried torrent downloads (Transmission status 4).
    "torrent-get": { torrents: [{
      id: 1, hashString: "a".repeat(40), name: "Ender in Exile", downloadDir: join(temp, "media", "torrents", "complete"), percentDone: 0.1,
      status: 4, rateDownload: 1000, eta: 600, error: 0, errorString: "", files: [], fileStats: [],
    }] },
  };
  return new Response(JSON.stringify({ result: "success", arguments: answers[call.method] ?? {} }), { status: 200 });
}) as typeof fetch;

const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const { alignmentKeepsPublishedMap, alignmentJob } = await import("../server/alignment-transitions.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.TRANSMISSION_RPC_URL;
  await app.close();
  sqlite.close();
});

const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;
const admin = await login("203.0.113.200", { password: "admin-password" });
const created = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
assert.equal(created.statusCode, 200, created.body);
const reader = await login("203.0.113.201", { username: "reader", password: "password1" });

const post = (cookie: string | null, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, ...(cookie ? { cookies: { sonder_session: cookie } } : {}), ...(payload === undefined ? {} : { payload: payload as any }) });
const items = async () =>
  Object.fromEntries(((await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: admin } })).json().items as any[])
    .map((item) => [item.id, item]));

const now = Date.now();
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
run("INSERT INTO works(id,title,author,description,genre,year) VALUES('w1','Speaker for the Dead','Card','','',1986)");
run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed1','w1','','',0,'')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb1','w1','epub','x')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb2','w1','epub','y')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb3','w1','epub','z')");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb4','w1','epub','v')");

/** A BitTorrent v1 info hash per download. */
const HASHES: Record<string, string> = { "acq-failed": "a".repeat(40), "acq-paused": "b".repeat(40), "acq-running": "c".repeat(40) };
const magnetOf = (id: string) => `magnet:?xt=urn:btih:${HASHES[id]}&dn=Ender`;
const acquisition = (id: string, status: string, error: string | null = null) =>
  run("INSERT INTO acquisitions(id,hash,magnet,backend,title,author,cover,status,progress,error,created_at,updated_at) VALUES(?,?,?,'local','Ender in Exile','Card','',?,0.4,?,?,?)",
    id, HASHES[id], magnetOf(id), status, error, now - 60_000, now - 30_000);
acquisition("acq-failed", "error", "No seeders");
acquisition("acq-paused", "paused");
acquisition("acq-running", "downloading");

const ALIGNMENT_DATA = (id: string, ebookId: string, recordingId: string, status: string, over: Record<string, unknown> = {}) => JSON.stringify({
  id, ebookId, recordingId, status, progress: 0.4, error: status === "error" ? "The worker stopped." : null, createdAt: now - 60_000,
  updatedAt: now - 30_000, engine: "ctc-book-1", fingerprint: "fp", audioFingerprint: "afp", sections: [], intervals: [], ...over,
});
const alignment = (id: string, ebookId: string, status: string, over: Record<string, unknown> = {}, publishedMap: string | null = null) => {
  const recording = `rec-${id}`;
  run("INSERT INTO recordings(id,edition_id) VALUES(?,'ed1')", recording);
  run("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,?,?,?,?)", id, ebookId, recording,
    ALIGNMENT_DATA(id, ebookId, recording, status, over), now - 30_000);
  if (publishedMap) run("UPDATE alignment_jobs SET published_map=? WHERE id=?", publishedMap, id);
};
// A rebuild that stopped in a row that keeps serving its earlier map (#277): the map in use must stay in use.
const KEPT_MAP = ALIGNMENT_DATA("sync-stopped", "eb1", "rec-sync-stopped", "ready", { outcome: "complete" });
alignment("sync-stopped", "eb1", "error", { rebuildOf: { engine: "old", status: "ready", requestedAt: now - 86_400_000 } }, KEPT_MAP);
alignment("sync-paused", "eb2", "paused");
alignment("sync-running", "eb3", "processing");
alignment("sync-cancelled", "eb4", "cancelled");

const status = (id: string) => (sqlite.prepare("SELECT status FROM acquisitions WHERE id=?").get(id) as { status: string }).status;

test("Activity offers Retry for a failed download and a stopped reading sync, Resume for paused ones, nothing else", async () => {
  const byId = await items();
  assert.deepEqual(byId["acquisition:acq-failed"].actions, ["retry"]);
  assert.deepEqual(byId["acquisition:acq-paused"].actions, ["resume"]);
  assert.deepEqual(byId["acquisition:acq-running"].actions, []);
  assert.deepEqual(byId["alignment:sync-stopped"].actions, ["retry"]);
  assert.deepEqual(byId["alignment:sync-paused"].actions, ["resume"]);
  assert.deepEqual(byId["alignment:sync-running"].actions, []);
  assert.deepEqual(byId["alignment:sync-cancelled"].actions, []);
});

test("the reader, who is not the administrator, can neither retry nor resume, and learns nothing about the items", async () => {
  for (const [url, id] of [
    ["/api/activity/items/retry", "acquisition:acq-failed"], ["/api/activity/items/resume", "acquisition:acq-paused"],
    ["/api/activity/items/retry", "alignment:sync-stopped"], ["/api/activity/items/resume", "alignment:sync-paused"],
    ["/api/activity/items/resume", "acquisition:no-such-download"],
  ]) {
    const refused = await post(reader, url, { id });
    assert.equal(refused.statusCode, 403, `${url} ${id}`);
    assert.doesNotMatch(refused.body, /Ender|Speaker|could not be found|paused|failed|stopped/i, "the answer does not say whether or how the item exists");
    assert.equal((await post(null, url, { id })).statusCode, 401);
  }
  assert.deepEqual(changes(), [], "no torrent was changed");
  assert.equal(status("acq-failed"), "error");
  assert.equal(status("acq-paused"), "paused");
  assert.equal(alignmentJob("sync-stopped").status, "error");
  assert.equal(alignmentJob("sync-paused").status, "paused");
});

test("an item in a state without that action is refused with a reason, and nothing changes", async () => {
  const cases: Array<[string, string, number, RegExp]> = [
    ["/api/activity/items/resume", "acquisition:acq-failed", 409, /Only a paused download can be resumed/],
    ["/api/activity/items/retry", "acquisition:acq-paused", 409, /Only a download that failed can be retried/],
    ["/api/activity/items/retry", "acquisition:acq-running", 409, /Only a download that failed can be retried/],
    ["/api/activity/items/resume", "acquisition:acq-running", 409, /Only a paused download can be resumed/],
    ["/api/activity/items/resume", "acquisition:no-such-download", 404, /This download could not be found/],
    ["/api/activity/items/resume", "alignment:sync-stopped", 409, /Only a paused reading sync can be resumed/],
    ["/api/activity/items/retry", "alignment:sync-paused", 409, /Only a reading sync that stopped can be retried/],
    ["/api/activity/items/retry", "alignment:sync-running", 409, /Only a reading sync that stopped can be retried/],
    ["/api/activity/items/resume", "alignment:sync-cancelled", 409, /Only a paused reading sync can be resumed/],
    ["/api/activity/items/retry", "alignment:no-such-sync", 404, /This reading sync could not be found/],
    ["/api/activity/items/resume", "hardcover:status:1", 400, /This item cannot be resumed/],
    ["/api/activity/items/resume", "server-copy:rec-sync-paused", 400, /This item cannot be resumed/],
    ["/api/activity/items/discard", "acquisition:acq-failed", 400, /This item has no retry or discard yet/],
  ];
  for (const [url, id, code, reason] of cases) {
    const refused = await post(admin, url, { id });
    assert.equal(refused.statusCode, code, `${url} ${id}: ${refused.body}`);
    assert.match(refused.json().error, reason, `${url} ${id}`);
  }
  assert.deepEqual(changes(), [], "no torrent was changed");
  assert.deepEqual(["acq-failed", "acq-paused", "acq-running"].map(status), ["error", "paused", "downloading"]);
  assert.deepEqual(["sync-stopped", "sync-paused", "sync-running", "sync-cancelled"].map((id) => alignmentJob(id).status),
    ["error", "paused", "processing", "cancelled"]);
});

test("older requests with an empty body still get their answer", async () => {
  for (const name of ["retry", "discard"]) {
    const empty = await post(admin, `/api/activity/items/${name}`);
    assert.equal(empty.statusCode, 400, name);
    assert.equal(empty.json().error, "This item has no retry or discard yet.", name);
    const emptyObject = await post(admin, `/api/activity/items/${name}`, {});
    assert.equal(emptyObject.json().error, "This item has no retry or discard yet.", name);
  }
  const resume = await post(admin, "/api/activity/items/resume");
  assert.equal(resume.statusCode, 400);
  assert.equal(resume.json().error, "This item cannot be resumed.");
});

test("Resume of a paused download starts its torrent again, as the server queue's Resume does", async () => {
  const resumed = await post(admin, "/api/activity/items/resume", { id: "acquisition:acq-paused" });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.deepEqual(resumed.json(), { ok: true, result: { ok: true } });
  assert.deepEqual(changes().map((call) => [call.method, call.arguments.ids]), [["torrent-start", [HASHES["acq-paused"]]]]);
  assert.equal(status("acq-paused"), "downloading");
  const item = (await items())["acquisition:acq-paused"];
  assert.equal(item.state, "running");
  assert.deepEqual(item.actions, [], "a running download offers neither");
  rpc.length = 0;

  // The same through the server queue's control in Activity's Now: the same RPC and the same stored status.
  run("UPDATE acquisitions SET status='paused' WHERE id='acq-paused'");
  assert.equal((await post(admin, "/api/acquisitions/acq-paused/control", { action: "resume" })).statusCode, 200);
  assert.deepEqual(changes().map((call) => [call.method, call.arguments.ids]), [["torrent-start", [HASHES["acq-paused"]]]]);
  assert.equal(status("acq-paused"), "downloading");
  rpc.length = 0;
});

test("Retry of a failed download adds its magnet again under the same id, as the server queue's Retry does", async () => {
  const retried = await post(admin, "/api/activity/items/retry", { id: "acquisition:acq-failed" });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().ok, true);
  assert.equal(retried.json().result.id, "acq-failed", "the same download, not a second one");
  const added = changes().find((call) => call.method === "torrent-add");
  assert.equal(added?.arguments.filename, magnetOf("acq-failed"));
  assert.equal(status("acq-failed"), "downloading");
  const row = sqlite.prepare("SELECT error FROM acquisitions WHERE id='acq-failed'").get() as { error: string | null };
  assert.equal(row.error, null);
  assert.equal((sqlite.prepare("SELECT COUNT(*) n FROM acquisitions").get() as { n: number }).n, 3, "no download was added");
  assert.ok(sqlite.prepare("SELECT 1 FROM user_acquisitions WHERE user_id=1 AND acquisition_id='acq-failed'").get(),
    "the download is the administrator's who retried it");
  const item = (await items())["acquisition:acq-failed"];
  assert.equal(item.id, "acquisition:acq-failed", "the item keeps its id");
  assert.equal(item.state, "running");
  rpc.length = 0;
});

test("Retry of a stopped reading sync queues it again in its row, and the map in use stays in use", async () => {
  assert.equal(alignmentKeepsPublishedMap("sync-stopped"), true);
  const retried = await post(admin, "/api/activity/items/retry", { id: "alignment:sync-stopped" });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().ok, true);
  assert.equal(retried.json().result.id, "sync-stopped");
  assert.equal(retried.json().result.status, "queued");
  const job = alignmentJob("sync-stopped");
  assert.equal(job.status, "queued");
  assert.equal(job.error, null);
  assert.equal(alignmentKeepsPublishedMap("sync-stopped"), true, "the kept map is still served while the rebuild runs again");
  assert.equal((sqlite.prepare("SELECT published_map FROM alignment_jobs WHERE id='sync-stopped'").get() as { published_map: string }).published_map,
    KEPT_MAP, "the map in use is unchanged");
  const listed = await app.inject({ method: "GET", url: "/api/alignments?ebookId=eb1", cookies: { sonder_session: admin } });
  assert.equal(listed.statusCode, 200, listed.body);
  const served = (listed.json().jobs as any[]).find((entry) => entry.id === "sync-stopped");
  assert.equal(served?.status, "ready", "the reader is still served the kept map");
  assert.equal(served?.rebuild?.status, "queued", "with the rebuild queued under it");
  const item = (await items())["alignment:sync-stopped"];
  assert.equal(item.state, "queued");
  assert.deepEqual(item.actions, []);
});

test("Resume of a paused reading sync queues it, as the reading sync route's Resume does", async () => {
  const before = alignmentJob("sync-paused");
  const resumed = await post(admin, "/api/activity/items/resume", { id: "alignment:sync-paused" });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().result.status, "queued");
  const after = alignmentJob("sync-paused");
  assert.equal(after.status, "queued");
  assert.notEqual(after.generation, before.generation, "a fresh run, as the route's Resume starts");
  assert.equal(after.recordingId, before.recordingId, "the job stays with its recording");

  // The same through the reading sync route: the same stored status.
  run("UPDATE alignment_jobs SET data=json_set(data,'$.status','paused') WHERE id='sync-paused'");
  const patched = await app.inject({ method: "PATCH", url: "/api/alignments/sync-paused", cookies: { sonder_session: admin }, payload: { action: "resume" } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(alignmentJob("sync-paused").status, "queued");
});
