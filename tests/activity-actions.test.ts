import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerActivity, type ActivityDeps } from "../server/activity.ts";

function build(overrides: Partial<ActivityDeps> = {}) {
  const calls: Array<[string, unknown]> = [];
  const app = Fastify();
  const deps = {
    sqlite: {} as any,
    getSetting: () => undefined,
    torrentHealth: async () => { throw new Error("unused"); },
    poolStatus: async () => { throw new Error("unused"); },
    requireAdmin: () => {},
    pauseState: () => ({ alignment: { paused: false, locked: false }, "series-acquisition": { paused: false, locked: true } }),
    setPaused: (id: string, paused: boolean) => { calls.push(["pause", { id, paused }]); },
    ...overrides,
  } as ActivityDeps;
  registerActivity(app, deps);
  return { app, calls };
}

test("Retry or Discard of a Hardcover queue an older page still shows answers that it has none (#721 part d)", async () => {
  const { app, calls } = build();
  for (const action of ["retry", "discard"]) {
    const response = await app.inject({ method: "POST", url: `/api/activity/items/${action}`, payload: { id: "hardcover:listening:7" } });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().message, "This item has no retry or discard yet.");
  }
  assert.deepEqual(calls, []);
  await app.close();
});

test("the pause switch is refused before anything is stored when it is not admin, unknown, locked or malformed", async () => {
  const { app, calls } = build();
  assert.equal((await app.inject({ method: "POST", url: "/api/activity/processes/nope/pause", payload: { paused: true } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/activity/processes/alignment/pause", payload: { paused: "true" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/activity/processes/series-acquisition/pause", payload: { paused: true } })).statusCode, 409);
  assert.deepEqual(calls, [], "nothing was stored");
  const ok = await app.inject({ method: "POST", url: "/api/activity/processes/alignment/pause", payload: { paused: true } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls, [["pause", { id: "alignment", paused: true }]]);
  await app.close();

  const denied = build({ requireAdmin: () => { throw Object.assign(new Error("Only the administrator can do this."), { statusCode: 403 }); } });
  assert.equal((await denied.app.inject({ method: "POST", url: "/api/activity/processes/alignment/pause", payload: { paused: true } })).statusCode, 403);
  assert.equal((await denied.app.inject({ method: "POST", url: "/api/activity/items/retry", payload: { id: "hardcover:status:1" } })).statusCode, 403);
  assert.deepEqual(denied.calls, [], "a non-admin changes nothing");
  await denied.app.close();
});
