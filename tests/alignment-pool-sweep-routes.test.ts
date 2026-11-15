// The staging sweep's routes (#421) are for the administrator only. The pool hosts are the in-process fake
// (tests/fake-pool-host.ts), installed before the app starts: no SSH, no network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePoolHosts } from "./fake-pool-host.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-pool-sweep-routes-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.ALIGNMENT_POOL_ENABLED;
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });

const fake = fakePoolHosts(join(temp, "hosts"));
process.env.ALIGNMENT_POOL_HOSTS = JSON.stringify(Object.values(fake.hosts).map((host) => ({
  id: host.id, sshTarget: host.sshTarget, workerUrl: host.workerUrl, device: host.device, precision: host.precision,
})));
const pool = await import("../server/alignment-pool.ts");
pool.setAlignmentPoolDepsForTests(fake.deps);
const originalFetch = globalThis.fetch;
globalThis.fetch = fake.fetch;

const { createApp } = await import("../server/app.ts");
const app = await createApp();

after(async () => {
  await app.close();
  globalThis.fetch = originalFetch;
  pool.setAlignmentPoolDepsForTests(null);
  rmSync(temp, { recursive: true, force: true });
});

async function login(username: string | undefined, password: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(response.statusCode, 200, response.body);
  return response.cookies[0].value;
}

const routes = [
  { method: "GET", url: "/api/alignments/pool/staging" },
  { method: "POST", url: "/api/alignments/pool/staging/remove" },
] as const;

test("the dry run and the real run are refused to members and to signed-out requests", async () => {
  const admin = await login(undefined, "admin-password");
  const made = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
  assert.equal(made.statusCode, 200, made.body);
  const member = await login("reader", "password1");
  for (const route of routes) {
    assert.equal((await app.inject({ ...route, cookies: { sonder_session: member } })).statusCode, 403, route.url);
    assert.equal((await app.inject(route)).statusCode, 401, route.url);
  }
  for (const host of Object.values(fake.hosts)) assert.deepEqual(host.commands, [], "nothing reached a host");
});

test("the administrator gets the listing per host, and a run (an empty body is accepted)", async () => {
  const admin = await login(undefined, "admin-password");
  const listing = await app.inject({ method: "GET", url: "/api/alignments/pool/staging", cookies: { sonder_session: admin } });
  assert.equal(listing.statusCode, 200, listing.body);
  assert.deepEqual(listing.json().hosts.map((host: { hostId: string }) => host.hostId), ["wsl", "lisa"]);
  const one = await app.inject({ method: "GET", url: "/api/alignments/pool/staging?host=lisa", cookies: { sonder_session: admin } });
  assert.deepEqual(one.json().hosts.map((host: { hostId: string }) => host.hostId), ["lisa"]);
  const run = await app.inject({ method: "POST", url: "/api/alignments/pool/staging/remove", cookies: { sonder_session: admin } });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().hosts.length, 2);
  const unknown = await app.inject({ method: "POST", url: "/api/alignments/pool/staging/remove", cookies: { sonder_session: admin },
    payload: { host: "nowhere" } });
  assert.equal(unknown.statusCode, 400, unknown.body);
  for (const host of Object.values(fake.hosts))
    assert.ok(!host.commands.some((command) => /\brm\b/.test(command)), "nothing to remove, nothing removed");
});
