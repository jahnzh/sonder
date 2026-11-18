// This test exercises the isolated synthetic server only; it never invokes a live-verification script.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { app, checkpoint, closeFixture, job, mapped } from "./manual/reading-sync-fixture.ts";

after(closeFixture);
test("fixture serves a whole-book map without pairings and can recover a synthetic passage", async () => {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "synthetic-fixture-password" } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const work = await get("/api/works/synthetic-work");
  assert.equal(work.statusCode, 200, work.body);
  assert.equal(work.json().recordings[0].recordingId, job.recordingId);
  assert.equal(work.json().ebooks[0].id, job.ebookId);
  const listing = await get(`/api/alignments?ebookId=${job.ebookId}`);
  assert.equal(listing.statusCode, 200, listing.body);
  assert.equal(listing.json().jobs[0].pairings, undefined);
  const map = await get(`/api/alignments/${job.id}/map`);
  assert.equal(map.statusCode, 200, map.body);
  assert.deepEqual(map.json().intervals, mapped);
  const reader = await get(`/api/reader/${job.ebookId}`);
  assert.deepEqual(reader.json().checkpoint, checkpoint);
  for (const interval of mapped) {
    const recovery = await app.inject({ method: "POST", url: "/api/alignments/recover", headers: { cookie }, payload: {
      ebookId: job.ebookId, recordingId: job.recordingId, trackId: interval.trackId, position: interval.start + 2,
    } });
    assert.equal(recovery.statusCode, 200, recovery.body);
    assert.equal(recovery.json().locator.paragraphId, interval.paragraphId);
  }
  assert.deepEqual((await get(`/api/reader/${job.ebookId}`)).json().checkpoint, checkpoint);
});
