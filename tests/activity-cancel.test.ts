/**
 * Cancel of a stuck or failing download through Activity (#716): `POST /api/activity/items/cancel` on the real app.
 * A fake Transmission answers the torrent client's RPC; nothing leaves the process and no real torrent client is
 * touched. The production case: a local download stuck at 0.11% for weeks while its work already has a ready TorBox
 * copy, which must stay with the reader's place in it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-activity-cancel-");
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

const STUCK = "38136ad6".padEnd(40, "1");
const FAILED = "f".repeat(40);
const READY = "e".repeat(40);
const PAUSED = "d".repeat(40);

/** The RPC calls the fake torrent client received; it is "down" while `unreachable` is set. */
const rpc: Array<{ method: string; arguments: Record<string, unknown> }> = [];
let unreachable = false;
const removals = () => rpc.filter((call) => ["torrent-remove", "torrent-stop", "torrent-add", "torrent-start"].includes(call.method));
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("http://transmission.invalid/")) throw new Error(`No network in this test: ${url}`);
  if (unreachable) throw new TypeError("fetch failed");
  const call = JSON.parse(String(init?.body)) as { method: string; arguments: Record<string, unknown> };
  rpc.push(call);
  const answers: Record<string, unknown> = {
    "session-get": { version: "4.0.6", "download-dir": join(temp, "media", "torrents", "complete"), "incomplete-dir": "", "incomplete-dir-enabled": false },
    "port-test": { "port-is-open": true },
    "torrent-remove": {},
    // The stuck torrent: in the client, its metadata in, no peer connected, every tracker counting no seeder.
    "torrent-get": { torrents: [{
      hashString: STUCK, status: 4, error: 0, errorString: "", percentDone: 0.0011, metadataPercentComplete: 1,
      peersConnected: 0, peersSendingToUs: 0, trackerStats: [{ seederCount: 0 }],
    }] },
  };
  return new Response(JSON.stringify({ result: "success", arguments: answers[call.method] ?? {} }), { status: 200 });
}) as typeof fetch;

const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const { collectActivity } = await import("../server/activity.ts");
const { getTorrentStates } = await import("../server/transmission.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.TRANSMISSION_RPC_URL;
  await app.close();
  sqlite.close();
});

const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;
const admin = await login("203.0.113.210", { password: "admin-password" });
const created = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
assert.equal(created.statusCode, 200, created.body);
const reader = await login("203.0.113.211", { username: "reader", password: "password1" });
const readerId = (sqlite.prepare("SELECT id FROM users WHERE username='reader'").get() as { id: number }).id;

const post = (cookie: string | null, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, ...(cookie ? { cookies: { sonder_session: cookie } } : {}), ...(payload === undefined ? {} : { payload: payload as any }) });

const now = Date.now();
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
// The work with its ready TorBox copy, in both users' libraries, with a listening position in it each.
run("INSERT INTO works(id,title,author,description,genre,year) VALUES('got','A Game of Thrones','George R. R. Martin','','',1996)");
run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('torbox-1','got','','Roy Dotrice',0,'TorBox · Cached')");
run("INSERT INTO recordings(id,edition_id) VALUES('recording-torbox-1','torbox-1')");
run("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES('t1','recording-torbox-1','Prologue',0,3600,'{}','torbox')");
for (const userId of [1, readerId]) {
  run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,'torbox-1','reading',?)", userId, now);
  run("INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(?,'recording-torbox-1','t1',?,3600,?)", userId, 1234 + userId, now);
}
const acquisition = (id: string, hash: string, status: string, backend = "local", error: string | null = null) => {
  run(`INSERT INTO acquisitions(id,hash,magnet,backend,remote_id,title,author,cover,status,progress,error,work_id,created_at,updated_at)
       VALUES(?,?,?,?,?,'A Game of Thrones','George R. R. Martin','',?,0.0011,?,'got',?,?)`,
    id, hash, `magnet:?xt=urn:btih:${hash}&dn=GoT`, backend, hash, status, error, now - 19 * 86_400_000, now - 2 * 3_600_000);
  run("INSERT INTO user_acquisitions(user_id,acquisition_id) VALUES(1,?)", id);
};
acquisition("b1a70445", STUCK, "downloading");
acquisition("acq-failed", FAILED, "error", "local", "A completed torrent file could not be read as audio.");
acquisition("acq-ready", READY, "ready", "torbox");
acquisition("acq-paused", PAUSED, "paused");
acquisition("acq-torbox", "c".repeat(40), "preparing", "torbox");

const statusOf = (id: string) => (sqlite.prepare("SELECT status FROM acquisitions WHERE id=?").get(id) as { status: string }).status;
const positions = () => sqlite.prepare("SELECT user_id, recording_id, position FROM user_progress ORDER BY user_id").all();
const POSITIONS = [{ user_id: 1, recording_id: "recording-torbox-1", position: 1235 }, { user_id: readerId, recording_id: "recording-torbox-1", position: 1234 + readerId }];

/** Activity as the route reads it, two hours apart, so the download that did not move is stuck (the sampler's job in production). */
async function activity() {
  const deps = {
    sqlite, getSetting: () => undefined, requireAdmin: () => {}, syncHardcover: async () => ({}), setPaused: () => {},
    pauseState: () => ({}), poolStatus: async () => { throw new Error("no pool in this test"); },
    torrentHealth: async () => ({ status: "ok", session: true, network: "ok", version: "4.0.6", message: "ok", checkedAt: now }),
    torrentStates: (hashes: string[]) => getTorrentStates(hashes),
  } as any;
  await collectActivity({ ...deps, now: () => now - 3 * 3_600_000 }, { probes: true });
  const answer = await collectActivity({ ...deps, now: () => now }, { probes: true });
  return Object.fromEntries(answer.items.map((item) => [item.id, item]));
}

test("the owner's stuck download names why, from the client, and offers Cancel", async () => {
  const byId = await activity();
  const stuck = byId["acquisition:b1a70445"];
  assert.deepEqual(stuck.stuck, { reason: "No seeders", known: true });
  assert.deepEqual(stuck.actions, ["cancel"]);
  assert.equal(stuck.attention, true);
  assert.equal(JSON.stringify(stuck).includes(STUCK), false, "the torrent's hash is not sent to the page");
  const asked = rpc.filter((call) => call.method === "torrent-get").map((call) => call.arguments.ids);
  assert.ok(asked.length >= 1 && asked.every((ids) => JSON.stringify(ids) === JSON.stringify([STUCK])), "only the fetching local download is asked about");
  assert.deepEqual(byId["acquisition:acq-failed"].actions, ["retry", "cancel"]);
  assert.deepEqual(byId["acquisition:acq-torbox"].stuck, { reason: "No change for 3 h" }, "a TorBox download keeps the current line");
  assert.deepEqual(byId["acquisition:acq-torbox"].actions, ["cancel"]);
  rpc.length = 0;
  // The app's own route asks the client the same way (the wiring in `server/app.ts`).
  const read = await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: admin } });
  assert.equal(read.statusCode, 200, read.body);
  assert.ok(rpc.some((call) => call.method === "torrent-get" && JSON.stringify(call.arguments.ids) === JSON.stringify([STUCK])));
  assert.equal(read.body.includes(STUCK), false, "the hash is not in the answer");
  rpc.length = 0;
});

test("the reader, who is not the administrator, cannot cancel and learns nothing about the download", async () => {
  for (const id of ["acquisition:b1a70445", "acquisition:acq-failed", "acquisition:no-such-download"]) {
    const refused = await post(reader, "/api/activity/items/cancel", { id });
    assert.equal(refused.statusCode, 403, id);
    assert.doesNotMatch(refused.body, /Thrones|could not be found|cancel|finished/i, "the answer does not say whether or how the item exists");
    assert.equal((await post(null, "/api/activity/items/cancel", { id })).statusCode, 401);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: reader } })).statusCode, 403);
  assert.deepEqual(removals(), [], "no torrent was touched");
  assert.equal(statusOf("b1a70445"), "downloading");
});

test("refusals: a finished, paused, unknown or non-download item, and an empty body from an older page", async () => {
  const cases: Array<[unknown, number, RegExp]> = [
    [{ id: "acquisition:acq-ready" }, 409, /This download is finished; its recording stays/],
    [{ id: "acquisition:acq-paused" }, 409, /This download cannot be cancelled now/],
    [{ id: "acquisition:no-such-download" }, 404, /This download could not be found/],
    [{ id: "hardcover:status:1" }, 400, /This item cannot be cancelled/],
    [{ id: "alignment:sync-1" }, 400, /This item cannot be cancelled/],
    [{}, 400, /This item cannot be cancelled/],
    [undefined, 400, /This item cannot be cancelled/],
  ];
  for (const [payload, code, reason] of cases) {
    const refused = await post(admin, "/api/activity/items/cancel", payload);
    assert.equal(refused.statusCode, code, `${JSON.stringify(payload)}: ${refused.body}`);
    assert.match(refused.json().error, reason, JSON.stringify(payload));
  }
  assert.deepEqual(removals(), [], "no torrent was touched");
  assert.deepEqual(["acq-ready", "acq-paused"].map(statusOf), ["ready", "paused"]);
});

test("a client that cannot be reached removes nothing: the download stays as it was and the page is told why", async () => {
  unreachable = true;
  try {
    const failed = await post(admin, "/api/activity/items/cancel", { id: "acquisition:b1a70445" });
    assert.equal(failed.statusCode, 502, failed.body);
    assert.match(failed.json().error, /cannot be reached/);
  } finally {
    unreachable = false;
  }
  assert.equal(statusOf("b1a70445"), "downloading");
});

test("Cancel removes the stuck torrent with its partial data, marks the download cancelled and keeps the other copy and every place", async () => {
  const cancelled = await post(admin, "/api/activity/items/cancel", { id: "acquisition:b1a70445" });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.deepEqual(cancelled.json(), { ok: true, result: { ok: true, removed: true } });
  assert.deepEqual(removals(), [{ method: "torrent-remove", arguments: { ids: [STUCK], "delete-local-data": true } }]);
  assert.equal(statusOf("b1a70445"), "cancelled");
  // The ready TorBox copy, the library rows and both listening positions stay as they were.
  assert.equal(statusOf("acq-ready"), "ready");
  assert.ok(sqlite.prepare("SELECT 1 FROM audio_editions WHERE id='torbox-1'").get());
  assert.equal((sqlite.prepare("SELECT COUNT(*) n FROM user_library WHERE book_id='torbox-1'").get() as { n: number }).n, 2);
  assert.deepEqual(positions(), POSITIONS);
  const books = await app.inject({ method: "GET", url: "/api/books", cookies: { sonder_session: reader } });
  assert.ok((books.json() as Array<{ id: string }>).some((book) => book.id === "torbox-1"), "the reader still has the book");

  // Activity lists it as finished, with nothing to do and nothing needing attention; the queue never checks it again.
  const item = (await activity())["acquisition:b1a70445"];
  assert.equal(item.state, "done");
  assert.deepEqual(item.actions, []);
  assert.equal(item.attention, false);
  assert.deepEqual(item.facts, { kind: "acquisition", status: "cancelled", backend: "local" });
  rpc.length = 0;
  const { refreshQueue } = await import("../server/acquisitions.ts");
  await refreshQueue();
  assert.equal(rpc.filter((call) => (call.arguments.ids as string[] | undefined)?.includes(STUCK)).length, 0, "the queue leaves it alone");
  assert.equal(statusOf("b1a70445"), "cancelled");

  const again = await post(admin, "/api/activity/items/cancel", { id: "acquisition:b1a70445" });
  assert.equal(again.statusCode, 409, "a second Cancel from a page that is behind changes nothing");
  rpc.length = 0;
});

test("Cancel of a failing download removes its torrent; of a TorBox one marks it only", async () => {
  assert.equal((await post(admin, "/api/activity/items/cancel", { id: "acquisition:acq-failed" })).statusCode, 200);
  assert.deepEqual(removals(), [{ method: "torrent-remove", arguments: { ids: [FAILED], "delete-local-data": true } }]);
  assert.equal(statusOf("acq-failed"), "cancelled");
  rpc.length = 0;
  const torbox = await post(admin, "/api/activity/items/cancel", { id: "acquisition:acq-torbox" });
  assert.deepEqual(torbox.json(), { ok: true, result: { ok: true, removed: false } });
  assert.deepEqual(removals(), [], "the local client is not asked to remove a TorBox download");
  assert.equal(statusOf("acq-torbox"), "cancelled");
  assert.deepEqual(positions(), POSITIONS);
});

test("the same torrent added again after Cancel starts a new download in the same row", async () => {
  const { acquire } = await import("../server/acquisitions.ts");
  rpc.length = 0;
  await acquire(`magnet:?xt=urn:btih:${STUCK}&dn=GoT`, { title: "A Game of Thrones", workId: "got", userId: 1 }).catch(() => {});
  assert.ok(rpc.some((call) => call.method === "torrent-add"), "it was added, not answered with the cancelled row");
  assert.notEqual(statusOf("b1a70445"), "cancelled");
});

test("cancelAcquisition itself refuses a finished or already cancelled download, whoever calls it", async () => {
  const { cancelAcquisition } = await import("../server/acquisitions.ts");
  const removed: string[] = [];
  const removeTorrent = async (hash: string) => { removed.push(hash); };
  await assert.rejects(cancelAcquisition("acq-ready", { removeTorrent }), (error: any) => error.statusCode === 409 && /finished/.test(error.message));
  await assert.rejects(cancelAcquisition("acq-failed", { removeTorrent }), (error: any) => error.statusCode === 409 && /already cancelled/.test(error.message));
  await assert.rejects(cancelAcquisition("no-such-download", { removeTorrent }), (error: any) => error.statusCode === 404);
  assert.deepEqual(removed, []);
  assert.equal(statusOf("acq-ready"), "ready");
});
