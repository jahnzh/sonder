import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appearanceSchema, defaultAppearance, keepWordWpm } from "../src/appearance.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-wpm-"));
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
  rmSync(temp, { recursive: true, force: true });
});

const put = (payload: unknown) =>
  app.inject({ method: "PUT", url: "/api/appearance", payload: payload as object });
const get = async () => (await app.inject({ method: "GET", url: "/api/appearance" })).json();

test("saving appearance from an older client without wordWpm keeps the stored words per minute", async () => {
  const current = await get();
  assert.equal(current.reader.wordWpm, 300);
  const saved = await put({ ...current, reader: { ...current.reader, wordWpm: 640 } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await get()).reader.wordWpm, 640);
  // An older client's reader settings have no wordWpm, and it can change other things.
  const { wordWpm: _dropped, ...older } = current.reader;
  const fromOldTab = await put({ ...current, preset: "light", reader: { ...older, size: 24 } });
  assert.equal(fromOldTab.statusCode, 200, fromOldTab.body);
  const after = await get();
  assert.equal(after.preset, "light");
  assert.equal(after.reader.size, 24);
  assert.equal(after.reader.wordWpm, 640);
  assert.equal(fromOldTab.json().reader.wordWpm, 640);
  // A body with no reader at all keeps it as well.
  assert.equal((await put({ preset: "forest" })).statusCode, 200);
  assert.equal((await get()).reader.wordWpm, 640);
});

test("a client that sends wordWpm changes it, and a reset sends the default", async () => {
  const current = await get();
  assert.equal((await put({ ...current, reader: { ...current.reader, wordWpm: 420 } })).statusCode, 200);
  assert.equal((await get()).reader.wordWpm, 420);
  assert.equal((await put(defaultAppearance)).statusCode, 200);
  assert.equal((await get()).reader.wordWpm, 300);
  assert.equal(
    (await put({ ...current, reader: { ...current.reader, wordWpm: 950 } })).statusCode >= 400,
    true,
  );
  assert.equal((await get()).reader.wordWpm, 300);
});

test("keepWordWpm only fills in a missing value", () => {
  const stored = appearanceSchema.parse({ reader: { wordWpm: 500 } });
  const parsed = (body: unknown) => appearanceSchema.parse(body);
  assert.equal(keepWordWpm(parsed({}), stored, {}).reader.wordWpm, 500);
  assert.equal(keepWordWpm(parsed({ reader: {} }), stored, { reader: {} }).reader.wordWpm, 500);
  const body = { reader: { wordWpm: 200 } };
  assert.equal(keepWordWpm(parsed(body), stored, body).reader.wordWpm, 200);
  assert.equal(keepWordWpm(parsed({}), stored, null).reader.wordWpm, 500);
});
