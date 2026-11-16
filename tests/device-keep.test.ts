// Keep on this device, recorded on the server for each device (#549, ADR 0021): the `sonder_device`
// cookie, `GET /api/device/keep`, `PUT` and `DELETE /api/works/<workId>/keep`, pruning, and Remove from
// library turning Keep off on every device of the user. On the fixture of `tests/library-works-fixture.ts`,
// read as the owner (the administrator) and as Sam (a user).
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
import { DAY, OWNER, OWNER_TOKEN, SAM, SAM_TOKEN, T0, removeRecording, writeLibraryFixture } from "./library-works-fixture.ts";

const temp = tempDir("sonder-device-keep-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.COOKIE_SECURE;

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
writeLibraryFixture(sqlite, process.env.MEDIA_ROOT, hashToken);
// The fake clock below runs years ahead; the fixture's sessions must outlive it.
sqlite.prepare("UPDATE sessions SET expires_at=?").run(Date.now() + 10_000 * DAY);
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
await removeRecording((options) => app.inject(options));

after(async () => {
  mock.timers.reset();
  await app.close();
  sqlite.close();
});

type Method = "GET" | "PUT" | "DELETE";
type Record = { workId: string; on: boolean; at: number; completeAt: number | null };
type Options = { token?: string; device?: string; payload?: object; json?: boolean };
/** One request as a browser sends it: the session cookie, the device cookie when it has one. */
function call(method: Method, url: string, { token = OWNER_TOKEN, device, payload, json }: Options = {}) {
  return app.inject({
    method,
    url,
    cookies: { sonder_session: token, ...(device ? { sonder_device: device } : {}) },
    ...(payload ? { payload } : json ? { headers: { "content-type": "application/json" }, payload: "" } : {}),
  });
}
const deviceCookie = (response: Awaited<ReturnType<typeof call>>) =>
  response.cookies.find((cookie) => cookie.name === "sonder_device");
/** A new browser: reads its records once to get a device id. */
async function newDevice(token = OWNER_TOKEN) {
  const response = await call("GET", "/api/device/keep", { token });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = deviceCookie(response);
  assert.ok(cookie, "a device cookie is set");
  return cookie.value;
}
async function records(device: string, token = OWNER_TOKEN) {
  const response = await call("GET", "/api/device/keep", { token, device });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { records: Record[] }).records;
}
async function keep(method: "PUT" | "DELETE", workId: string, device: string, options: Options = {}) {
  const response = await call(method, `/api/works/${workId}/keep`, { device, ...options });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as Record;
}
/** The reads older clients and the Book page make, as text, for both users. */
async function reads() {
  const bodies: { [read: string]: string } = {};
  for (const [user, token] of [["owner", OWNER_TOKEN], ["sam", SAM_TOKEN]])
    for (const url of ["/api/books", "/api/library", "/api/works/w-two", "/api/works/w-beside"]) {
      const response = await app.inject({ url, cookies: { sonder_session: token } });
      bodies[`${user} ${url}`] = `${response.statusCode} ${response.headers.etag ?? ""} ${response.body}`;
    }
  return bodies;
}
const readsBefore = await reads();
const settings = (userId: number) =>
  sqlite.prepare("SELECT key,value FROM user_settings WHERE user_id=? ORDER BY key").all(userId);

test("the device cookie is set once, with its attributes, and renewed on every read", async () => {
  const first = await call("GET", "/api/device/keep");
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { records: [] });
  const cookie = deviceCookie(first);
  assert.ok(cookie);
  assert.match(cookie.value, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "Strict");
  assert.equal(cookie.path, "/");
  assert.equal(cookie.maxAge, 400 * 86_400);
  assert.equal(cookie.secure, undefined, "not Secure while the session cookie is not");
  // A second read keeps the id and renews the cookie for another 400 days.
  const again = await call("GET", "/api/device/keep", { device: cookie.value });
  const renewed = deviceCookie(again);
  assert.ok(renewed, "renewed on a read");
  assert.equal(renewed.value, cookie.value);
  assert.equal(renewed.maxAge, 400 * 86_400);
  assert.equal(renewed.httpOnly, true);
  assert.equal(renewed.sameSite, "Strict");
  // Another browser gets another id.
  assert.notEqual(await newDevice(), cookie.value);
  // A cookie this server could not have given is replaced.
  const forged = deviceCookie(await call("GET", "/api/device/keep", { device: "x" }));
  assert.ok(forged);
  assert.notEqual(forged.value, "x");
});

test("the device cookie is Secure exactly when the session cookie is", async () => {
  process.env.COOKIE_SECURE = "true";
  try {
    const cookie = deviceCookie(await call("GET", "/api/device/keep"));
    assert.equal(cookie?.secure, true);
  } finally {
    delete process.env.COOKIE_SECURE;
  }
});

test("the routes need a signed-in user", async () => {
  for (const [method, url] of [["GET", "/api/device/keep"], ["PUT", "/api/works/w-two/keep"], ["DELETE", "/api/works/w-two/keep"]] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
    assert.equal(deviceCookie(response), undefined, "no cookie for nobody");
  }
});

test("on, off and completeAt are stored and read back", async () => {
  const device = await newDevice();
  const before = Date.now();
  const on = await keep("PUT", "w-two", device);
  assert.equal(on.workId, "w-two");
  assert.equal(on.on, true);
  assert.ok(on.at >= before && on.at <= Date.now());
  assert.equal(on.completeAt, null);
  assert.deepEqual(await records(device), [on]);

  const completeAt = Date.now();
  const complete = await keep("PUT", "w-two", device, { payload: { completeAt } });
  assert.deepEqual(complete, { ...on, completeAt }, "a completion report keeps the choice and its time");
  assert.deepEqual(await records(device), [complete]);
  // Turning on again, as a second tab would, keeps what this device completed.
  const reOn = await keep("PUT", "w-two", device);
  assert.equal(reOn.on, true);
  assert.equal(reOn.completeAt, completeAt);

  const offAt = Date.now() + 1;
  mock.timers.enable({ apis: ["Date"], now: offAt });
  try {
    const off = await keep("DELETE", "w-two", device);
    assert.deepEqual(off, { workId: "w-two", on: false, at: offAt, completeAt: null }, "off is a record");
    assert.deepEqual(await records(device), [off]);
    // A completion report for a work turned off does not turn it on.
    assert.deepEqual(await keep("PUT", "w-two", device, { payload: { completeAt: offAt } }), off);
    // On again at a given time, after off: nothing is complete on this device yet.
    const again = await keep("PUT", "w-two", device, { payload: { at: offAt + 0 } });
    assert.deepEqual(again, { workId: "w-two", on: true, at: offAt, completeAt: null });
    // Two works, each its own record, in the order of their ids.
    const other = await keep("PUT", "w-beside", device, { payload: { at: offAt } });
    assert.deepEqual((await records(device)).map((r) => r.workId), ["w-beside", "w-two"]);
    assert.deepEqual(other, { workId: "w-beside", on: true, at: offAt, completeAt: null });
    // The stored row is the documented key and value.
    assert.equal(
      (sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key=?").get(OWNER, `keep:${device}:w-beside`) as { value: string }).value,
      JSON.stringify({ on: true, at: offAt, completeAt: null }),
    );
  } finally {
    mock.timers.reset();
  }
});

test("a write older than the stored record is ignored and the stored record answered", async () => {
  const device = await newDevice();
  const at = Date.now() - 1000;
  const stored = await keep("DELETE", "w-two", device, { payload: { at } });
  assert.deepEqual(stored, { workId: "w-two", on: false, at, completeAt: null });
  // An on made offline before that off arrives late: ignored.
  assert.deepEqual(await keep("PUT", "w-two", device, { payload: { at: at - 1 } }), stored);
  assert.deepEqual(await records(device), [stored]);
  // A newer on wins, then an older off is ignored.
  const on = await keep("PUT", "w-two", device, { payload: { at: at + 10 } });
  assert.deepEqual(on, { workId: "w-two", on: true, at: at + 10, completeAt: null });
  assert.deepEqual(await keep("DELETE", "w-two", device, { payload: { at: at + 5 } }), on);
  // An older completion report does not replace a newer one.
  const complete = await keep("PUT", "w-two", device, { payload: { completeAt: at + 20 } });
  assert.equal(complete.completeAt, at + 20);
  assert.deepEqual(await keep("PUT", "w-two", device, { payload: { completeAt: at + 15 } }), complete);
  assert.deepEqual(await records(device), [complete]);
  // A time ahead of the server's clock is taken as now, so it cannot freeze the record.
  const ahead = await keep("DELETE", "w-two", device, { payload: { at: Date.now() + 365 * DAY } });
  assert.ok(ahead.at <= Date.now());
  const later = await keep("PUT", "w-two", device);
  assert.equal(later.on, true, "a later write still wins");
});

test("an empty JSON body and no body are accepted; a malformed time is refused", async () => {
  const device = await newDevice();
  assert.equal((await keep("PUT", "w-two", device, { json: true })).on, true);
  assert.equal((await keep("DELETE", "w-two", device, { json: true })).on, false);
  assert.equal((await keep("PUT", "w-two", device)).on, true);
  assert.equal((await keep("DELETE", "w-two", device)).on, false);
  assert.equal((await keep("PUT", "w-two", device, { payload: {} })).on, true);
  assert.equal((await keep("DELETE", "w-two", device, { payload: {} })).on, false);
  const bad = await call("PUT", "/api/works/w-two/keep", { device, payload: { at: "yesterday" } });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal((await records(device))[0].on, false, "a refused write changes nothing");
});

test("a write without a device cookie gives the device its id", async () => {
  const response = await call("PUT", "/api/works/w-two/keep");
  assert.equal(response.statusCode, 200, response.body);
  const cookie = deviceCookie(response);
  assert.ok(cookie);
  assert.deepEqual(await records(cookie.value), [response.json()]);
});

test("a work the user cannot see is not found and writes nothing", async () => {
  const device = await newDevice(SAM_TOKEN);
  const before = settings(SAM);
  for (const method of ["PUT", "DELETE"] as const) {
    const missing = await call(method, "/api/works/no-such-work/keep", { token: SAM_TOKEN, device });
    assert.equal(missing.statusCode, 404, missing.body);
  }
  assert.deepEqual(settings(SAM), before);
});

test("another user's and another device's records are not visible", async () => {
  const shared = await newDevice();
  const phone = await newDevice();
  const owner = await keep("PUT", "w-two", shared);
  await keep("PUT", "w-beside", phone);
  // Sam on the same browser sees none of the owner's records, and writes their own.
  assert.deepEqual(await records(shared, SAM_TOKEN), []);
  const sam = await keep("DELETE", "w-two", shared, { token: SAM_TOKEN });
  assert.equal(sam.on, false);
  assert.deepEqual(await records(shared, SAM_TOKEN), [sam]);
  assert.deepEqual(await records(shared), [owner], "Sam's off did not touch the owner's on");
  // Each device answers only its own records.
  assert.deepEqual((await records(phone)).map((r) => r.workId), ["w-beside"]);
  // Sam on a browser of their own sees nothing of either.
  assert.deepEqual(await records(await newDevice(SAM_TOKEN), SAM_TOKEN), []);
});

test("a device not read for 400 days is pruned on a later read", async () => {
  const start = T0 + 4000 * DAY;
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    const old = await newDevice();
    const kept = await newDevice();
    const samOld = await newDevice(SAM_TOKEN);
    await keep("PUT", "w-two", old);
    await keep("PUT", "w-two", kept);
    await keep("PUT", "w-two", samOld, { token: SAM_TOKEN });
    // The kept device is read again just short of 400 days; nothing has been gone for 400 yet.
    mock.timers.tick(400 * DAY - 1);
    assert.equal((await records(kept)).length, 1);
    assert.equal(settings(OWNER).filter((row: any) => row.key.includes(old)).length, 2);
    // A moment later, the device the owner last saw 400 days ago and Sam's are dropped on another read.
    mock.timers.tick(2);
    assert.equal((await records(kept)).length, 1, "the device read since keeps its records");
    assert.deepEqual(settings(OWNER).filter((row: any) => row.key.includes(old)), [], "the old device's rows are gone");
    assert.deepEqual(settings(SAM).filter((row: any) => row.key.includes(samOld)), [], "for every account");
    // The pruned browser, when it comes back, is a device that knows nothing.
    assert.deepEqual(await records(old), []);
  } finally {
    mock.timers.reset();
  }
});

test("GET /api/books, GET /api/library and GET /api/works/<workId> are unchanged by Keep records", async () => {
  assert.ok((sqlite.prepare("SELECT COUNT(*) AS n FROM user_settings WHERE key LIKE 'keep:%'").get() as { n: number }).n > 0);
  assert.deepEqual(await reads(), readsBefore);
});

test("Remove from library writes off for each of the user's devices and no other user's", async () => {
  const phone = await newDevice();
  const desk = await newDevice();
  const shared = await newDevice();
  await keep("PUT", "w-two", phone);
  await keep("PUT", "w-beside", desk);
  const samShared = await keep("PUT", "w-two", shared, { token: SAM_TOKEN });
  const samBefore = settings(SAM);
  const before = Date.now();
  const removed = await call("DELETE", "/api/works/w-two/library");
  assert.equal(removed.statusCode, 200, removed.body);
  // Every device of the owner, these three and the ones earlier tests made, has w-two off.
  const devices = new Set(
    (settings(OWNER) as { key: string }[]).filter((row) => row.key.startsWith("keepDevice:")).map((row) => row.key.slice(11)),
  );
  assert.ok(devices.has(phone) && devices.has(desk) && devices.has(shared));
  for (const device of devices) {
    const off = (await records(device)).find((r) => r.workId === "w-two");
    assert.ok(off, `a record on ${device}`);
    assert.equal(off.on, false);
    assert.equal(off.completeAt, null);
    assert.ok(off.at >= before);
  }
  assert.equal((await records(desk)).find((r) => r.workId === "w-beside")?.on, true, "other works keep their choice");
  // Sam keeps w-two on, on the shared browser and everywhere else.
  assert.deepEqual(settings(SAM), samBefore);
  assert.deepEqual(await records(shared, SAM_TOKEN), [samShared]);
});
