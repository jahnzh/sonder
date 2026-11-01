import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-mapcache-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
delete process.env.TRANSMISSION_RPC_URL;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { readerFixture } = await import("./reader-fixture.ts");
const app = await createApp();
after(async () => {
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
// A linked work, recording and ebook whose files exist, so /map can read them.
const epub = join(temp, "media", "ebooks", "mapcache.epub");
writeFileSync(epub, await readerFixture());
db.insert(s.works)
  .values({ id: "work-mc", title: "Map cache", author: "A", description: "", genre: "Fiction", year: 2000 })
  .run();
db.insert(s.editions)
  .values({ id: "edition-mc", workId: "work-mc", cover: "/covers/meditations.svg", narrator: "N", rating: 0, sourceLabel: "test", language: "en" })
  .run();
db.insert(s.recordings).values({ id: "recording-mc", editionId: "edition-mc" }).run();
db.insert(s.tracks)
  .values({ id: "mc-0", recordingId: "recording-mc", title: "Track 0", index: 0, duration: 640, chapters: [], source: epub, sourceType: "local" })
  .run();
db.insert(s.ebookEditions)
  .values({ id: "ebook-mc", workId: "work-mc", format: "epub", source: epub })
  .run();
// alignment_pair(ebook_id,recording_id) is unique: the stale job needs its
// own pair (same ebook file, different recording) so both jobs can exist.
db.insert(s.works)
  .values({ id: "work-mc2", title: "Map cache 2", author: "A", description: "", genre: "Fiction", year: 2000 })
  .run();
db.insert(s.editions)
  .values({ id: "edition-mc2", workId: "work-mc2", cover: "/covers/meditations.svg", narrator: "N", rating: 0, sourceLabel: "test", language: "en" })
  .run();
db.insert(s.recordings).values({ id: "recording-mc2", editionId: "edition-mc2" }).run();
db.insert(s.tracks)
  .values({ id: "mc2-0", recordingId: "recording-mc2", title: "Track 0", index: 0, duration: 640, chapters: [], source: epub, sourceType: "local" })
  .run();
db.insert(s.ebookEditions)
  .values({ id: "ebook-mc2", workId: "work-mc2", format: "epub", source: epub })
  .run();
function seedJob(id: string, status: string, fingerprint: string, ebookId = "ebook-mc", recordingId = "recording-mc") {
  const now = Date.now();
  const data = { id, ebookId, recordingId, status, progress: 1, intervals: [], fingerprint, audioFingerprint: "audio-v2:mc", createdAt: now, updatedAt: now };
  sqlite
    .prepare("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at")
    .run(id, ebookId, recordingId, JSON.stringify(data), now);
}

// A 410 (cancelled or stale map) is a cacheable status per RFC 9111, so a
// browser stores the response even without freshness headers. The cached 410
// then answers every later /map fetch — including after a rebuild — and the
// client treats it as a missing map forever. The route must opt out of HTTP
// caching so a cancelled job can be rebuilt and its map re-fetched (#28).
test("GET /map on a cancelled job returns 410 with Cache-Control: private, no-store", async () => {
  seedJob("job-mc-cancelled", "cancelled", "fingerprint-mc");
  const r = await app.inject({ method: "GET", url: "/api/alignments/job-mc-cancelled/map" });
  assert.equal(r.statusCode, 410, r.body);
  assert.equal(r.json().code, "alignment_cancelled");
  assert.equal(r.headers["cache-control"], "private, no-store");
});

test("GET /map on a stale job returns 410 with Cache-Control: private, no-store", async () => {
  seedJob("job-mc-stale", "ready", "fingerprint-mismatch", "ebook-mc2", "recording-mc2");
  const r = await app.inject({ method: "GET", url: "/api/alignments/job-mc-stale/map" });
  assert.equal(r.statusCode, 410, r.body);
  assert.equal(r.json().code, "alignment_stale");
  assert.equal(r.headers["cache-control"], "private, no-store");
});
