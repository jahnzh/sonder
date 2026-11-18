// The four acquire routes with `replaceActive` (#603) stay the administrator's: someone else is refused before
// anything is fetched, and the administrator's download on its way is left as it was.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-get-replace-auth-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const fetched: string[] = [];
const original = globalThis.fetch;
globalThis.fetch = async (input) => {
  fetched.push(String(input));
  throw new Error(`Unexpected external request: ${String(input)}`);
};

const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const app = await createApp({ background: { manual: true } });

after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
});

test("someone who is not the administrator cannot get or replace a recording", async () => {
  const login = async (username: string | undefined, password: string) => {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    assert.equal(response.statusCode, 200, response.body);
    return response.cookies[0].value;
  };
  const admin = await login(undefined, "admin-password");
  const created = await app.inject({
    method: "POST",
    url: "/api/users",
    cookies: { sonder_session: admin },
    payload: { username: "listener", password: "password1" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const listener = await login("listener", "password1");

  db.insert(s.works).values({ id: "w-auth", title: "Auth Story", author: "Ada", description: "", genre: "", year: 2020 }).run();
  db.insert(s.acquisitions)
    .values({
      id: "admin-download",
      hash: "a".repeat(40),
      magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
      backend: "local",
      remoteId: null,
      title: "Auth Story",
      author: "Ada",
      cover: "",
      workId: "w-auth",
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.4,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(s.userAcquisitions).values({ userId: 1, acquisitionId: "admin-download" }).run();

  const magnet = `magnet:?xt=urn:btih:${"b".repeat(40)}`;
  for (const [url, payload] of [
    ["/api/discover/abb/add", { slug: "some-release", workId: "w-auth", replaceActive: true }],
    ["/api/discover/prowlarr/add", { id: `prowlarr-${"0".repeat(32)}`, workId: "w-auth", replaceActive: true }],
    ["/api/acquire", { magnet, workId: "w-auth", replaceActive: true }],
    ["/api/torbox/magnet", { magnet, workId: "w-auth", replaceActive: true }],
  ] as const) {
    const response = await app.inject({ method: "POST", url, cookies: { sonder_session: listener }, payload });
    assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
    // The refusal names nothing of the administrator's download.
    assert.doesNotMatch(response.body, /admin-download|Auth Story|aaaa/);
  }
  assert.deepEqual(fetched, []);
  const job = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, "admin-download")).get();
  assert.equal(job?.status, "downloading");
  assert.equal(db.select().from(s.userAcquisitions).all().length, 1);
  assert.equal(db.select().from(s.acquisitions).all().length, 1);
});
