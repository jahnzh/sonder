import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Plain JS module shared with scripts/verify-multi-user.mjs (no .d.ts)
import { adminMultiUserVerifySnapshot, assertAdminMultiUserVerifyUnchanged } from "../scripts/verify-multi-user-snapshot.mjs";

const temp = mkdtempSync(join(tmpdir(), "sonder-verify-mu-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const app = await createApp();

after(async () => {
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

test("verify-multi-user snapshot: ignores unrelated admin progress; fails on QA book or membership", async () => {
  const login = async (username: string | undefined, password: string) => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.cookies[0].value;
  };
  const adminCookie = await login(undefined, "admin-password");
  const req = (method: any, url: string, payload?: any) =>
    app.inject({ method, url, cookies: { sonder_session: adminCookie }, payload });

  const norm = (rows: any[]) =>
    rows.map((b) => ({
      id: b.id,
      inLibrary: b.inLibrary,
      status: b.status,
      progress: b.progress && {
        position: b.progress.position,
        updatedAt: b.progress.updatedAt,
      },
    }));

  const books = async () =>
    norm((await req("GET", "/api/books")).json());
  const rows = (await req("GET", "/api/books")).json();
  const playable = rows.find(
    (b: any) => b.tracks?.length && b.inLibrary,
  );
  assert.ok(playable, "seed should include an in-library book with tracks");
  const other = rows.find(
    (b: any) =>
      b.tracks?.length &&
      b.inLibrary &&
      b.recordingId !== playable.recordingId,
  );
  assert.ok(
    other,
    "seed should include a second in-library book with a different recording",
  );

  const snap = async () =>
    adminMultiUserVerifySnapshot(
      await books(),
      playable.id as string,
    );

  {
    const before = await snap();
    assert.equal(
      (
        await req("POST", "/api/progress", {
          recordingId: other.recordingId,
          trackId: other.tracks[0].id,
          position: 42,
          duration: other.tracks[0].duration || 60,
          updatedAt: Date.now(),
        })
      ).statusCode,
      200,
    );
    assertAdminMultiUserVerifyUnchanged(before, await snap());
  }

  {
    const before = await snap();
    assert.equal(
      (
        await req("POST", "/api/progress", {
          recordingId: playable.recordingId,
          trackId: playable.tracks[0].id,
          position: 77,
          duration: playable.tracks[0].duration || 60,
          updatedAt: Date.now(),
        })
      ).statusCode,
      200,
    );
    await assert.rejects(
      async () =>
        assertAdminMultiUserVerifyUnchanged(before, await snap()),
      /QA recording/,
    );
  }

  {
    const before = await snap();
    // Progress save flips unread → listening; patch to a different status so this exercises the library row.
    assert.equal(
      (await req("PATCH", `/api/library/${playable.id}`, { status: "finished" }))
        .statusCode,
      200,
    );
    await assert.rejects(
      async () =>
        assertAdminMultiUserVerifyUnchanged(before, await snap()),
      /QA recording/,
    );
  }

  {
    const before = await snap();
    assert.equal((await req("DELETE", `/api/library/${other.id}`)).statusCode, 200);
    await assert.rejects(
      async () =>
        assertAdminMultiUserVerifyUnchanged(before, await snap()),
      /library membership/,
    );
  }
});
