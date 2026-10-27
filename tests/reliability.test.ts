import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "sonder-reliability-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.NODE_ENV = "test";
process.env.REQUIRE_MEDIA_MOUNT = "false";
delete process.env.APP_PASSWORD;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { encrypt } = await import("../server/security.ts");
const { torboxUrl, TorBoxError } = await import("../server/services.ts");
const { isCompleteMediaResponse } = await import("../server/media-response.ts");
const app = await createApp();
const original = globalThis.fetch;
after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
function fixture(id: string, audio: boolean) {
  db.insert(s.works)
    .values({
      id: `work-${id}`,
      title: id,
      author: "Test author",
      description: "Test story",
      genre: "Audiobook",
      year: 2026,
    })
    .run();
  db.insert(s.editions)
    .values({
      id,
      workId: `work-${id}`,
      narrator: "Test reader",
      cover: "/covers/time.svg",
      rating: 0,
      sourceLabel: "Your server",
    })
    .run();
  db.insert(s.recordings)
    .values({ id: `recording-${id}`, editionId: id })
    .run();
  if (audio)
    db.insert(s.tracks)
      .values({
        id: `${id}-0`,
        recordingId: `recording-${id}`,
        title: "Chapter",
        index: 0,
        duration: 640,
        source: join(temp, "media", "demo", "alice-01.mp3"),
        sourceType: "local",
      })
      .run();
}
test("Save to server accepts an older client's empty JSON body without relaxing required JSON routes", async () => {
  fixture("bodyless-copy", true);
  const response = await app.inject({
    method: "POST",
    url: "/api/books/bodyless-copy/keep",
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  const required = await app.inject({
    method: "POST",
    url: "/api/library",
    headers: { "content-type": "application/json" },
  });
  assert.equal(required.statusCode, 400);
});
test("books without media cannot create misleading server-download jobs", async () => {
  fixture("metadata-only", false);
  const response = await app.inject({
    method: "POST",
    url: "/api/books/metadata-only/keep",
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /no audio yet/);
  assert.equal(
    db
      .select()
      .from(s.serverDownloads)
      .all()
      .some((job) => job.bookId === "metadata-only"),
    false,
  );
});
test("full-file 206 responses are complete only when the range covers the whole resource", () => {
  assert.equal(
    isCompleteMediaResponse(
      new Response("audio", {
        status: 206,
        headers: { "content-range": "bytes 0-4/5", "content-length": "5" },
      }),
    ),
    true,
  );
  assert.equal(
    isCompleteMediaResponse(
      new Response("part", {
        status: 206,
        headers: { "content-range": "bytes 0-3/100", "content-length": "4" },
      }),
    ),
    false,
  );
});
test("TorBox links coalesce simultaneous resolution and refresh explicitly when expired", async () => {
  db.insert(s.settings)
    .values({ key: "torbox", value: encrypt("retry-test-key") })
    .run();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      success: true,
      data: `https://cdn.example.org/audio-${calls}.mp3`,
    });
  };
  try {
    const links = await Promise.all([
      torboxUrl(101, 1),
      torboxUrl(101, 1),
      torboxUrl(101, 1),
    ]);
    assert.equal(calls, 1);
    assert.equal(new Set(links).size, 1);
    assert.notEqual(await torboxUrl(101, 1, true), links[0]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});
test("temporary TorBox errors remain retryable and do not poison the link cache", async () => {
  let fails = true,
    calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return fails
      ? Response.json(
          { success: false, detail: "Temporary provider failure" },
          { status: 429, headers: { "retry-after": "2" } },
        )
      : Response.json({
          success: true,
          data: "https://cdn.example.org/recovered.mp3",
        });
  };
  try {
    await assert.rejects(
      torboxUrl(102, 1),
      (error) =>
        error instanceof TorBoxError &&
        error.retryable &&
        error.retryAfterMs === 2000 &&
        error.statusCode === 503,
    );
    fails = false;
    assert.equal(
      await torboxUrl(102, 1),
      "https://cdn.example.org/recovered.mp3",
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});
test("legacy full downloads accept a complete upstream 206 and never label a fragment as complete", async () => {
  db.insert(s.tracks)
    .values({
      id: "legacy-full",
      recordingId: "recording-bodyless-copy",
      title: "A whole chapter",
      index: 1,
      duration: 100,
      source: "https://example.org/audio.mp3",
      sourceType: "remote",
    })
    .run();
  globalThis.fetch = async () =>
    new Response("audio", {
      status: 206,
      headers: {
        "content-range": "bytes 0-4/5",
        "content-length": "5",
        "content-type": "audio/mpeg",
      },
    });
  try {
    const full = await app.inject("/api/media/legacy-full");
    assert.equal(full.statusCode, 200);
    assert.equal(full.body, "audio");
    assert.equal(full.headers["content-range"], undefined);
    globalThis.fetch = async () =>
      new Response("part", {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/100",
          "content-length": "4",
          "content-type": "audio/mpeg",
        },
      });
    const partial = await app.inject("/api/media/legacy-full");
    assert.equal(partial.statusCode, 502);
    assert.equal(partial.json().retryable, true);
  } finally {
    globalThis.fetch = original;
  }
});
