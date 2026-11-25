import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { appearanceSchema, defaultAppearance } from "../src/appearance.ts";
import { tempDir } from "./temp-dir.ts";

// The Lyrics and Word views are gone (ADR 0017), but an older open client still sends their fields:
// the view choice (`display`), the words per line (`segmentWords`) and the words per minute (`wordWpm`).
// tempDir removes the folder at exit, also when the server below fails to start.
const temp = tempDir("sonder-appearance-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const app = await createApp();
after(async () => {
  await app.close();
  sqlite.close();
});

const put = (payload: unknown) =>
  app.inject({ method: "PUT", url: "/api/appearance", payload: payload as object });
const get = async () => (await app.inject({ method: "GET", url: "/api/appearance" })).json();

test("an older client's save that names a removed view and its settings is accepted and read back unchanged", async () => {
  const current = await get();
  for (const display of ["segment", "word"] as const) {
    const older = { ...current, preset: "light", reader: { ...current.reader, size: 24, display, segmentWords: 12, wordWpm: 640 } };
    const saved = await put(older);
    assert.equal(saved.statusCode, 200, saved.body);
    // What the older client reads back still parses as the appearance it knows, its own fields included.
    const read = await get();
    assert.deepEqual(appearanceSchema.parse(read), read);
    assert.equal(read.preset, "light");
    assert.equal(read.reader.size, 24);
    assert.deepEqual([read.reader.display, read.reader.segmentWords, read.reader.wordWpm], [display, 12, 640]);
  }
});

test("a save without the removed fields, or with no reader at all, is accepted too", async () => {
  const current = await get();
  const { display: _display, segmentWords: _words, wordWpm: _wpm, ...reader } = current.reader;
  assert.equal((await put({ ...current, reader: { ...reader, mode: "scroll" } })).statusCode, 200);
  assert.equal((await get()).reader.mode, "scroll");
  assert.equal((await put({ preset: "forest" })).statusCode, 200);
  assert.deepEqual((await get()).reader, defaultAppearance.reader);
});

test("an older client's save, which has no Reading position choice, keeps the stored one", async () => {
  const current = await get();
  assert.equal((await put({ ...current, reader: { ...current.reader, positionScope: "chapter" } })).statusCode, 200);
  assert.equal((await get()).reader.positionScope, "chapter");
  // The build before the choice sends `reader` without it; what it changed is saved, and the choice stays.
  const { positionScope: _scope, ...older } = current.reader;
  assert.equal((await put({ ...current, preset: "light", reader: { ...older, size: 22 } })).statusCode, 200);
  const read = await get();
  assert.deepEqual([read.preset, read.reader.size, read.reader.positionScope], ["light", 22, "chapter"]);
  // A save with no reader at all keeps it too.
  assert.equal((await put({ preset: "forest" })).statusCode, 200);
  assert.equal((await get()).reader.positionScope, "chapter");
  // A client that knows the choice sets it, the whole book included.
  assert.equal((await put({ ...current, reader: { ...current.reader, positionScope: "book" } })).statusCode, 200);
  assert.equal((await get()).reader.positionScope, "book");
});
