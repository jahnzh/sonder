// `POST /api/test/seed-local-audio` (test builds only): its edition, recording and track are written
// together, and a track id already in use fails the request and writes nothing. An edition left
// without its track would be taken for a placeholder (#483).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-seed-local-audio-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const { sqlite } = await import("../server/db.ts");
const { isPlaceholderEdition } = await import("../server/placeholder-edition.ts");
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: ["series-acquisition"] } });
after(async () => {
  await app.close();
  sqlite.close();
});

const seed = (editionId: string, trackId: string) =>
  app.inject({
    method: "POST",
    url: "/api/test/seed-local-audio",
    payload: { relPath: `${editionId}.mp3`, editionId, recordingId: `rec-${editionId}`, trackId, workId: "work-alice" },
  });

test("a seeded edition comes with its track", async () => {
  const response = await seed("seeded-first", "seeded-track");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(isPlaceholderEdition(sqlite, "seeded-first"), false);
});

test("a track id already in use fails the request and leaves no edition without tracks", async () => {
  const response = await seed("seeded-second", "seeded-track");
  assert.equal(response.statusCode, 409, response.body);
  const count = (table: string, column: string, id: string) =>
    (sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(id) as { n: number }).n;
  assert.equal(count("audio_editions", "id", "seeded-second"), 0);
  assert.equal(count("recordings", "id", "rec-seeded-second"), 0);
  assert.equal(count("user_library", "book_id", "seeded-second"), 0);
  assert.equal(
    (sqlite.prepare("SELECT recording_id AS id FROM tracks WHERE id='seeded-track'").get() as { id: string }).id,
    "rec-seeded-first",
  );
});
