import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
const temp = mkdtempSync(join(tmpdir(), "sonder-proxy-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const app = await createApp();
db.insert(s.tracks)
  .values({
    id: "long-proxy",
    recordingId: "recording-alice",
    index: 99,
    title: "A long audio file",
    duration: 36000,
    source: "https://archive.org/download/fixture/long.mp3",
    sourceType: "remote",
  })
  .run();
const original = globalThis.fetch;
after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
test("audio bodies can remain open past two minutes while connection setup is still bounded", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined,
    controller: ReadableStreamDefaultController<Uint8Array> | undefined,
    connected!: () => void;
  const ready = new Promise<void>((resolve) => (connected = resolve));
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal!;
    assert.equal(new Headers(init?.headers).get("Accept-Encoding"), "identity");
    connected();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
      {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": "5",
          ETag: '"stable-audio"',
        },
      },
    );
  };
  try {
    const response = app.inject("/api/media/long-proxy");
    await ready;
    await nextTurn();
    await nextTurn();
    context.mock.timers.tick(121000);
    assert.equal(signal!.aborted, false);
    controller!.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
    controller!.close();
    const result = await response;
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.rawPayload.length, 5);
    assert.equal(result.headers.etag, '"stable-audio"');
    assert.match(
      String(result.headers["x-sonder-media-version"]),
      /^[a-f0-9]{64}$/,
    );
  } finally {
    context.mock.timers.reset();
    globalThis.fetch = original;
  }
});
test("decoded proxy responses never reuse the compressed wire content length", async () => {
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-type": "audio/mpeg",
        "content-encoding": "gzip",
        "content-length": "100",
      },
    });
  try {
    const result = await app.inject("/api/media/long-proxy");
    assert.equal(result.statusCode, 200);
    assert.equal(result.rawPayload.length, 3);
    assert.notEqual(result.headers["content-length"], "100");
  } finally {
    globalThis.fetch = original;
  }
});
test("a TorBox track reports TorBox until a verified server copy takes over delivery", async () => {
  db.insert(s.tracks)
    .values({
      id: "copied-torbox",
      recordingId: "recording-alice",
      index: 100,
      title: "A cached release",
      duration: 36000,
      source: JSON.stringify({ torrentId: 12, fileId: 1 }),
      sourceType: "torbox",
    })
    .run();
  const before = await app.inject("/api/media/copied-torbox/location");
  assert.equal(before.json().source, "torbox");
  const path = join(temp, "media", "demo", "alice-01.mp3");
  db.insert(s.mediaCopies)
    .values({
      trackId: "copied-torbox",
      path,
      size: statSync(path).size,
      mime: "audio/mpeg",
    })
    .run();
  const after = await app.inject("/api/media/copied-torbox/location");
  assert.equal(after.json().source, "server");
  const audio = await app.inject({
    url: "/api/media/copied-torbox",
    headers: { range: "bytes=0-99" },
  });
  assert.equal(audio.statusCode, 206);
  assert.equal(audio.headers["x-sonder-media-source"], "server");
  const books = (await app.inject("/api/books")).json();
  assert.equal(
    books
      .find((book: any) => book.id === "alice")
      .tracks.find((track: any) => track.id === "copied-torbox").deliverySource,
    "server",
  );
});
test("bounded media requests do not exhaust the library API request budget", async () => {
  for (let index = 0; index < 605; index++) {
    const media = await app.inject({
      method: "HEAD",
      url: "/api/media/alice-0",
      headers: { range: "bytes=0-0" },
    });
    assert.equal(media.statusCode, 206);
  }
  const mutation = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: { bookId: "alice" },
  });
  assert.equal(mutation.statusCode, 200, mutation.body);
});
