/**
 * `GET /api/books` for the fixture in `tests/library-works-fixture.ts` (#485): older clients read it,
 * so the read by work must leave it byte for byte as it was.
 *
 * `tests/fixtures/books-pin.json` was recorded before the read by work was built. Never rewrite it to
 * make this test pass; rewrite it only for an intended change to `GET /api/books`, with
 * `SONDER_UPDATE_BOOKS_PIN=1 npx tsx --test tests/books-pin.test.ts`, and review the diff.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
import { OWNER_TOKEN, SAM_TOKEN, removeRecording, writeLibraryFixture } from "./library-works-fixture.ts";

const temp = tempDir("sonder-books-pin-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
writeLibraryFixture(sqlite, process.env.MEDIA_ROOT, hashToken);
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: ["series-acquisition"] } });
await removeRecording((options) => app.inject(options));

after(async () => {
  await app.close();
  sqlite.close();
});

const PIN = new URL("./fixtures/books-pin.json", import.meta.url);

test("GET /api/books answers the fixture exactly as it did before the read by work", async () => {
  const bodies: Record<string, string> = {};
  for (const [user, token] of [["owner", OWNER_TOKEN], ["sam", SAM_TOKEN]]) {
    const response = await app.inject({ url: "/api/books", cookies: { sonder_session: token } });
    assert.equal(response.statusCode, 200, response.body);
    bodies[user] = response.body;
  }
  if (process.env.SONDER_UPDATE_BOOKS_PIN === "1")
    writeFileSync(
      PIN,
      `${JSON.stringify(Object.fromEntries(Object.entries(bodies).map(([user, body]) => [user, JSON.parse(body)])), null, 2)}\n`,
    );
  const pinned = JSON.parse(readFileSync(PIN, "utf8")) as Record<string, unknown>;
  // The pin is stored indented for review; the route's own compact JSON text must equal it exactly.
  for (const user of ["owner", "sam"]) assert.equal(bodies[user], JSON.stringify(pinned[user]), user);
});
