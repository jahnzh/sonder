// `GET /api/settings` gains `storage` for the administrator (#580; spec #572 "Server storage"): connected from
// `mediaMountProblem()`, the sizes from `statfs` of the media root (faked here), null when unreadable; someone
// else's answer is unchanged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-settings-storage-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.MEDIA_VOLUME_ID;

const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const { serverStorage } = await import("../server/server-storage.ts");

// The drive's sizes as statfs gives them: 4 TB in 4 KiB blocks, 1.1 TB of them free.
const BLOCK = 4096;
let fakeStatfs: (path: string) => { bsize: number; blocks: number; bfree: number } = () => ({
  bsize: BLOCK,
  blocks: 4e12 / BLOCK,
  bfree: 1.1e12 / BLOCK,
});
const asked: string[] = [];
const app = await createApp({
  storage: {
    statfs: (path) => {
      asked.push(path);
      return fakeStatfs(path);
    },
  },
});
after(async () => {
  await app.close();
  sqlite.close();
});

const login = async (username: string | undefined, password: string) => {
  const answer = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(answer.statusCode, 200, answer.body);
  return answer.cookies[0].value;
};
const settings = async (cookie: string) => {
  const answer = await app.inject({ method: "GET", url: "/api/settings", cookies: { sonder_session: cookie } });
  assert.equal(answer.statusCode, 200, answer.body);
  return answer.json();
};

test("the administrator's settings carry the media drive: connected, used and total from statfs of the media root", async () => {
  const admin = await login(undefined, "admin-password");
  const answer = await settings(admin);
  assert.deepEqual(answer.storage, { connected: true, usedBytes: 4e12 - 1.1e12, totalBytes: 4e12 });
  assert.equal(asked.at(-1), join(temp, "media"));
  // Every field it had before is still there.
  for (const field of ["role", "name", "torboxConfigured", "hardcoverConfigured", "abbUrl", "libgenUrl", "prowlarrUrl", "prowlarrConfigured", "localConfigured", "storageLabel", "authenticationEnabled"])
    assert.ok(field in answer, field);
});

test("sizes statfs cannot read are null, the drive still connected", async () => {
  const admin = await login(undefined, "admin-password");
  const was = fakeStatfs;
  fakeStatfs = () => {
    throw Object.assign(new Error("EIO: i/o error, statfs"), { code: "EIO" });
  };
  try {
    assert.deepEqual((await settings(admin)).storage, { connected: true, usedBytes: null, totalBytes: null });
  } finally {
    fakeStatfs = was;
  }
});

test("with the volume marker missing the drive is not connected and has no sizes", async () => {
  const admin = await login(undefined, "admin-password");
  // The server checks the recorded volume: its marker file is not in the media root.
  process.env.REQUIRE_MEDIA_MOUNT = "true";
  process.env.MEDIA_VOLUME_ID = "sonder-media-test-volume";
  try {
    assert.deepEqual((await settings(admin)).storage, { connected: false, usedBytes: null, totalBytes: null });
  } finally {
    process.env.REQUIRE_MEDIA_MOUNT = "false";
    delete process.env.MEDIA_VOLUME_ID;
  }
  assert.equal((await settings(admin)).storage.connected, true);
});

test("someone else's settings are unchanged: no storage, the same four fields", async () => {
  const admin = await login(undefined, "admin-password");
  const created = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "second", password: "password1" } });
  assert.equal(created.statusCode, 200, created.body);
  const second = await login("second", "password1");
  const calls = asked.length;
  const answer = await settings(second);
  assert.deepEqual(Object.keys(answer).sort(), ["authenticationEnabled", "hardcoverConfigured", "name", "role"]);
  assert.equal(answer.role, "user");
  assert.doesNotMatch(JSON.stringify(answer), /storage|usedBytes|totalBytes/);
  // The drive is not even measured for them.
  assert.equal(asked.length, calls);
});

test("serverStorage: the problem decides connected; a nonsense statfs answer has no sizes", () => {
  const sizes = { bsize: 512, blocks: 100, bfree: 25 };
  assert.deepEqual(serverStorage({ problem: () => null, statfs: () => sizes, root: "/x" }), { connected: true, usedBytes: 75 * 512, totalBytes: 100 * 512 });
  assert.deepEqual(serverStorage({ problem: () => "The configured media volume is unavailable.", statfs: () => sizes }), { connected: false, usedBytes: null, totalBytes: null });
  assert.deepEqual(serverStorage({ problem: () => null, statfs: () => ({ bsize: 512, blocks: 0, bfree: 0 }) }), { connected: true, usedBytes: null, totalBytes: null });
  const warned: string[] = [];
  serverStorage({ problem: () => null, statfs: () => { throw new Error("ENOENT"); }, warn: (message) => warned.push(message) });
  assert.match(warned[0], /ENOENT/);
});
