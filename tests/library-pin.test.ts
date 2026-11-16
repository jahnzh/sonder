/**
 * `GET /api/library` and `GET /api/works/<workId>` for the fixture in `tests/library-works-fixture.ts`,
 * as the owner and as Sam (#573): Discover's read of the server's works (`GET /api/works`) and the
 * Hardcover hits' work ids were added beside these reads and must leave them as they were.
 *
 * `tests/fixtures/library-pin.json` was recorded on the base of #573, before `GET /api/works` was
 * built. Rewrite it only for an intended change to these reads, with
 * `SONDER_UPDATE_LIBRARY_PIN=1 npx tsx --test tests/library-pin.test.ts`, and review the diff.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
import { OWNER_TOKEN, SAM_TOKEN, removeRecording, writeLibraryFixture } from "./library-works-fixture.ts";

const temp = tempDir("sonder-library-pin-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
writeLibraryFixture(sqlite, process.env.MEDIA_ROOT, hashToken);
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
await removeRecording((options) => app.inject(options));

after(async () => {
  await app.close();
  sqlite.close();
});

const PIN = new URL("./fixtures/library-pin.json", import.meta.url);
const URLS = [
  "/api/library",
  ...["w-only", "w-beside", "w-two", "w-unplayed", "w-removed", "w-outside", "w-sam", "work-hc-9001", "w-none"].map(
    (workId) => `/api/works/${workId}`,
  ),
];

test("GET /api/library and GET /api/works/<workId> answer the fixture as they did before Discover's read of works", async () => {
  const bodies: Record<string, Record<string, { status: number; body: unknown }>> = {};
  for (const [user, token] of [["owner", OWNER_TOKEN], ["sam", SAM_TOKEN]]) {
    bodies[user] = {};
    for (const url of URLS) {
      const response = await app.inject({ url, cookies: { sonder_session: token } });
      bodies[user][url] = { status: response.statusCode, body: response.body };
    }
  }
  if (process.env.SONDER_UPDATE_LIBRARY_PIN === "1")
    writeFileSync(
      PIN,
      `${JSON.stringify(
        Object.fromEntries(
          Object.entries(bodies).map(([user, byUrl]) => [
            user,
            Object.fromEntries(
              Object.entries(byUrl).map(([url, { status, body }]) => [url, { status, body: JSON.parse(String(body)) }]),
            ),
          ]),
        ),
        null,
        2,
      )}\n`,
    );
  const pinned = JSON.parse(readFileSync(PIN, "utf8")) as Record<string, Record<string, { status: number; body: unknown }>>;
  // The pin is stored indented for review; each route's own compact JSON text must equal it exactly.
  for (const user of ["owner", "sam"])
    for (const url of URLS) {
      assert.equal(bodies[user][url].status, pinned[user][url].status, `${user} ${url}`);
      assert.equal(bodies[user][url].body, JSON.stringify(pinned[user][url].body), `${user} ${url}`);
    }
});
