import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-media-library-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const app = await createApp();
const original = globalThis.fetch;
const disk = join(temp, "media", "saved", "fixture.mp3");
writeFileSync(disk, "server-copy");
db.insert(s.tracks)
  .values({
    id: "copy-track",
    recordingId: "recording-alice",
    index: 20,
    title: "Test track",
    duration: 60,
    source: "https://archive.org/download/test/original.mp3",
    sourceType: "remote",
  })
  .run();
db.insert(s.mediaCopies)
  .values({ trackId: "copy-track", path: disk, size: 11, mime: "audio/mpeg" })
  .run();
globalThis.fetch = async () =>
  new Response("original-stream", {
    headers: { "Content-Type": "audio/mpeg", "Content-Length": "15" },
  });
after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
test("source selection bypasses a managed copy without changing the recording or exposing its upstream URL", async () => {
  const auto = await app.inject("/api/media/copy-track");
  assert.equal(auto.body, "server-copy");
  assert.equal(auto.headers["x-sonder-media-source"], "server");
  const stream = await app.inject("/api/media/copy-track?source=original");
  assert.equal(stream.body, "original-stream");
  assert.equal(stream.headers["x-sonder-media-source"], "remote");
  const source = await app.inject("/api/recordings/recording-alice/sources");
  assert.equal(source.statusCode, 200);
  assert.ok(!source.body.includes("archive.org"));
  assert.ok(!source.body.includes(temp));
  assert.equal(
    (await app.inject("/api/media/copy-track?source=https://example.com"))
      .statusCode,
    400,
  );
});
test("fault reports persist, automatic playback bypasses a faulty copy, and a faulty recording is blocked until cleared", async () => {
  let response = await app.inject({
    method: "PUT",
    url: "/api/recordings/recording-alice/faults/server",
    payload: { reason: "bad-audio", note: "Corrupt copy" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    (await app.inject("/api/media/copy-track")).body,
    "original-stream",
  );
  assert.equal(
    (await app.inject("/api/media/copy-track?source=server")).statusCode,
    409,
  );
  response = await app.inject({
    method: "PUT",
    url: "/api/recordings/recording-alice/faults/recording",
    payload: { reason: "wrong-language" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(
    (await app.inject("/api/media/copy-track?source=original")).statusCode,
    409,
  );
  assert.equal(
    (await app.inject("/api/media/copy-track/location")).statusCode,
    409,
  );
  await app.inject({
    method: "DELETE",
    url: "/api/recordings/recording-alice/faults/recording",
  });
  assert.equal((await app.inject("/api/media/copy-track")).statusCode, 200);
  await app.inject({
    method: "DELETE",
    url: "/api/recordings/recording-alice/faults/server",
  });
});
test("removing managed server downloads preserves the original source, library membership and recording progress", async () => {
  const before = {
    library: db.select().from(s.library).all(),
    progress: db.select().from(s.progress).all(),
  };
  const outside = join(temp, "media", "imports", "original.mp3");
  writeFileSync(outside, "original");
  db.insert(s.tracks)
    .values({
      id: "unsafe-copy",
      recordingId: "recording-alice",
      index: 21,
      title: "Original",
      duration: 5,
      source: outside,
      sourceType: "local",
    })
    .run();
  db.insert(s.mediaCopies)
    .values({
      trackId: "unsafe-copy",
      path: outside,
      size: 8,
      mime: "audio/mpeg",
    })
    .run();
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/api/recordings/recording-alice/server-copy",
      })
    ).statusCode,
    400,
  );
  assert.equal(existsSync(disk), true);
  assert.equal(existsSync(outside), true);
  db.delete(s.mediaCopies)
    .where(eq(s.mediaCopies.trackId, "unsafe-copy"))
    .run();
  const removed = await app.inject({
    method: "DELETE",
    url: "/api/recordings/recording-alice/server-copy",
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(existsSync(disk), false);
  assert.equal(existsSync(outside), true);
  assert.equal(
    db.select().from(s.tracks).where(eq(s.tracks.id, "copy-track")).get()!
      .sourceType,
    "remote",
  );
  assert.deepEqual(db.select().from(s.library).all(), before.library);
  assert.deepEqual(db.select().from(s.progress).all(), before.progress);
});
