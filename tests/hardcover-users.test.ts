import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "sonder-hardcover-users-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const hc = await import("../server/hardcover.ts");
const app = await createApp();
const realFetch = globalThis.fetch;
const audio = {
  id: 901,
  audio_seconds: 21454,
  edition_format: "Audiobook",
  contributions: [
    { contribution: "narrator", author: { name: "Kara Shallenberg" } },
  ],
};
const alice = {
  id: 101,
  title: "Alice’s Adventures in Wonderland",
  slug: "alice",
  pages: 200,
  description: "A Hardcover edition",
  release_year: 1865,
  cached_image: null,
  contributions: [{ contribution: "author", author: { name: "Lewis Carroll" } }],
  book_series: [],
  default_audio_edition: audio,
  editions: [audio],
};
const read = (id: number, seconds: number) => ({
  id,
  started_at: "2026-01-01",
  finished_at: null,
  finished_at_precision: null,
  progress_seconds: seconds,
  progress_pages: null,
  edition_id: 901,
  edition: { id: 901, audio_seconds: 21454, pages: null, reading_format_id: 2 },
});
// Two separate Hardcover accounts. A request is answered only from the account its key
// belongs to, so a write carrying the wrong key cannot find the other account's records.
const accounts: Record<
  string,
  { id: number; username: string; entries: any[]; down?: boolean }
> = {
  "key-a": {
    id: 7001,
    username: "hc-reader-a",
    entries: [
      {
        id: 11,
        book_id: 101,
        status_id: 2,
        updated_at: "2020-01-01T00:00:00Z",
        book: alice,
        user_book_reads: [read(501, 2000)],
      },
    ],
  },
  "key-b": {
    id: 7002,
    username: "hc-reader-b",
    entries: [
      {
        id: 21,
        book_id: 101,
        status_id: 1,
        updated_at: "2020-01-01T00:00:00Z",
        book: alice,
        user_book_reads: [read(601, 4000)],
      },
    ],
  },
};
const calls: { key: string; query: string; variables: any }[] = [];
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.hardcover.app/"))
    return realFetch(input, init);
  const key = String(
    (init?.headers as Record<string, string>).Authorization,
  ).replace(/^Bearer /, "");
  const { query, variables: v } = JSON.parse(String(init?.body));
  calls.push({ key, query, variables: v });
  const account = accounts[key];
  if (!account) return new Response("unauthorized", { status: 401 });
  if (account.down) return new Response("unavailable", { status: 503 });
  let data: any;
  if (query.includes("SonderAccount"))
    data = { me: [{ id: account.id, username: account.username }] };
  else if (query.includes("SonderLibrary")) {
    if (v.userId !== account.id) throw new Error("Library of another account requested");
    data = { user_books: account.entries.slice(v.offset, v.offset + 250) };
  } else if (query.includes("SonderSearchLinks"))
    data = { books: [{ id: 101, slug: "alice" }] };
  else if (query.includes("SonderSearch"))
    data = { search: { results: { hits: [{ document: { id: 101 } }] } } };
  else if (query.includes("SonderShelfUpdate")) {
    const remote = account.entries.find((e) => e.id === v.id);
    if (!remote) return Response.json({ errors: [{ message: "not your book" }] });
    remote.status_id = v.object.status_id;
    remote.updated_at = new Date().toISOString();
    data = { update_user_book: { error: null, user_book: remote } };
  } else if (query.includes("SonderReadProgress")) {
    const remote = account.entries.find((e) =>
      e.user_book_reads.some((r: { id: number }) => r.id === v.id),
    );
    if (!remote) return Response.json({ errors: [{ message: "not your read" }] });
    const updated = { ...remote.user_book_reads[0], ...v.object };
    remote.user_book_reads = [updated];
    remote.updated_at = new Date().toISOString();
    data = { update_user_book_read: { error: null, user_book_read: updated } };
  } else if (query.includes("SonderBookProgress"))
    data = { user_books: account.entries.filter((e) => e.book_id === v.bookId) };
  else throw new Error("Unexpected Hardcover operation: " + query.slice(0, 70));
  return Response.json({ data: structuredClone(data) });
};
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
const login = async (username: string | undefined, password: string) => {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
};
const request = (cookie: string, method: any, url: string, payload?: any) =>
  app.inject({ method, url, cookies: { sonder_session: cookie }, payload });
const userRows = (table: string, userId: number) =>
  sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=?`).all(userId);
const hardcoverTables = [
  "user_hardcover_links",
  "user_hardcover_outbox",
  "user_hardcover_reading_outbox",
  "user_hardcover_progress",
  "user_hardcover_lists",
  "user_hardcover_reads",
  "user_hardcover_recording_editions",
];

test("each user syncs their own Hardcover account and progress only ever travels with their own key", async () => {
  const admin = await login(undefined, "admin-password");
  for (const username of ["reader-a", "reader-b", "reader-c"])
    assert.equal(
      (
        await request(admin, "POST", "/api/users", {
          username,
          password: "password1",
        })
      ).statusCode,
      200,
    );
  const a = await login("reader-a", "password1"),
    b = await login("reader-b", "password1"),
    c = await login("reader-c", "password1");
  const [idA, idB, idC] = [2, 3, 4];
  assert.equal((await request(a, "PUT", "/api/hardcover/token", { token: "key-a" })).statusCode, 200);
  assert.equal((await request(b, "PUT", "/api/hardcover/token", { token: "key-b" })).statusCode, 200);
  for (const cookie of [a, b]) {
    const configured = await request(cookie, "PATCH", "/api/hardcover/config", {
      mode: "two-way",
      syncLists: false,
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const sync = await request(cookie, "POST", "/api/hardcover/sync");
    assert.equal(sync.statusCode, 200, sync.body);
  }
  const stateA = (await request(a, "GET", "/api/hardcover")).json(),
    stateB = (await request(b, "GET", "/api/hardcover")).json(),
    stateC = (await request(c, "GET", "/api/hardcover")).json();
  assert.equal(stateA.username, "hc-reader-a");
  assert.equal(stateB.username, "hc-reader-b");
  assert.equal(stateC.configured, false);
  assert.equal(stateC.accountId, null);
  assert.equal((await request(c, "GET", "/api/settings")).json().hardcoverConfigured, false);
  assert.equal((await request(a, "GET", "/api/settings")).json().hardcoverConfigured, true);
  // Each user's shelf status and remote position land in their own library and progress only.
  const book = (cookie: string) =>
    request(cookie, "GET", "/api/books").then((r) =>
      r.json().find((x: { id: string }) => x.id === "alice"),
    );
  assert.equal((await book(a)).status, "listening");
  assert.equal((await book(b)).status, "unread");
  assert.equal((await book(c)).inLibrary, false);
  assert.equal((await book(a)).hardcover.statusId, 2);
  assert.equal((await book(b)).hardcover.statusId, 1);
  assert.equal((await book(c)).hardcover.statusId, null);
  assert.deepEqual(
    userRows("user_hardcover_links", idA).map((r: any) => r.user_book_id),
    [11],
  );
  assert.deepEqual(
    userRows("user_hardcover_links", idB).map((r: any) => r.user_book_id),
    [21],
  );

  const position = (cookie: string, seconds: number) =>
    request(cookie, "POST", "/api/progress", {
      recordingId: "recording-alice",
      trackId: "alice-0",
      position: seconds,
      duration: 640,
      updatedAt: Date.now(),
    });
  assert.equal((await position(a, 320)).statusCode, 200);
  assert.equal((await position(b, 100)).statusCode, 200);
  assert.equal((await position(c, 50)).statusCode, 200);
  assert.equal((await request(c, "POST", "/api/library", { bookId: "alice" })).statusCode, 200);
  assert.equal((await request(c, "PATCH", "/api/library/alice", { status: "finished" })).statusCode, 200);
  hc.queueHardcoverReadingProgress(idC, "work-alice", 0.5);
  // A user without a key queues nothing and cannot turn sync on.
  for (const table of hardcoverTables)
    assert.deepEqual(userRows(table, idC), [], table);
  const enable = await request(c, "PATCH", "/api/hardcover/config", {
    mode: "two-way",
    syncLists: false,
  });
  assert.equal(enable.statusCode, 400);
  assert.match(enable.json().error, /Hardcover API token/);
  assert.deepEqual(
    userRows("user_hardcover_progress", idA).map((r: any) => r.position),
    [320],
  );
  assert.deepEqual(
    userRows("user_hardcover_progress", idB).map((r: any) => r.position),
    [100],
  );
  // B listening flipped the local shelf to "listening", which queues B's own status change.
  assert.deepEqual(
    userRows("user_hardcover_outbox", idB).map((r: any) => [r.status_id, r.account_id]),
    [[2, 7002]],
  );
  assert.deepEqual(userRows("user_hardcover_outbox", idA), []);

  const before = calls.length;
  await hc.tickHardcover();
  const sent = calls.slice(before);
  assert.ok(sent.length > 0);
  assert.ok(sent.every((call) => call.key === "key-a" || call.key === "key-b"));
  const writes = sent.filter((call) => call.query.startsWith("mutation"));
  assert.deepEqual(
    writes.map((w) => [w.key, w.query.match(/mutation (\w+)/)![1], w.variables.id]),
    [
      ["key-a", "SonderReadProgress", 501],
      ["key-b", "SonderShelfUpdate", 21],
      ["key-b", "SonderReadProgress", 601],
    ],
  );
  assert.equal(
    writes.find((w) => w.key === "key-a")!.variables.object.progress_seconds,
    640,
  );
  assert.equal(
    writes.filter((w) => w.key === "key-b").at(-1)!.variables.object.progress_seconds,
    200,
  );
  assert.equal(accounts["key-a"].entries[0].user_book_reads[0].progress_seconds, 640);
  assert.equal(accounts["key-a"].entries[0].status_id, 2);
  assert.equal(accounts["key-b"].entries[0].user_book_reads[0].progress_seconds, 200);
  assert.equal(accounts["key-b"].entries[0].status_id, 2);
  assert.equal((await request(a, "GET", "/api/hardcover")).json().pending, 0);
  assert.equal((await request(b, "GET", "/api/hardcover")).json().pending, 0);

  // A failing account keeps its own queue without blocking the other account.
  accounts["key-a"].down = true;
  assert.equal((await position(a, 160)).statusCode, 200);
  assert.equal((await position(b, 150)).statusCode, 200);
  const later = calls.length;
  await hc.tickHardcover();
  assert.deepEqual(
    calls
      .slice(later)
      .filter((call) => call.query.startsWith("mutation"))
      .map((call) => [call.key, call.variables.object.progress_seconds]),
    [["key-b", 300]],
  );
  const failed = (await request(a, "GET", "/api/hardcover")).json();
  assert.equal(failed.pending, 1);
  assert.match(failed.lastError, /503/);
  assert.equal((await request(b, "GET", "/api/hardcover")).json().pending, 0);
  accounts["key-a"].down = false;
  const retried = await request(a, "POST", "/api/hardcover/sync");
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(accounts["key-a"].entries[0].user_book_reads[0].progress_seconds, 320);

  // Discovery search uses the caller's key; a user without one gets a clear error.
  const searchCalls = calls.length;
  const search = await request(a, "GET", "/api/discover/hardcover?q=Alice");
  assert.equal(search.statusCode, 200, search.body);
  assert.ok(calls.slice(searchCalls).every((call) => call.key === "key-a"));
  const noKey = await request(c, "GET", "/api/discover/hardcover?q=Alice");
  assert.equal(noKey.statusCode, 400);
  assert.match(noKey.json().error, /Hardcover API token/);
  assert.ok(!calls.some((call) => call.key === "undefined" || call.key === ""));
});

test("any user saves their own Hardcover token through settings, while other settings stay admin-only", async () => {
  const { getUserSecret } = await import("../server/users.ts");
  const admin = await login(undefined, "admin-password");
  const c = await login("reader-c", "password1");
  const configured = async (cookie: string) =>
    (await request(cookie, "GET", "/api/settings")).json().hardcoverConfigured;
  assert.equal((await request(admin, "PATCH", "/api/settings", { hardcover: "admin-key" })).statusCode, 200);
  assert.equal(await configured(c), false);
  const saved = await request(c, "PATCH", "/api/settings", { hardcover: "key-c" });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(await configured(c), true);
  assert.equal(getUserSecret(4, "hardcover"), "key-c");
  assert.equal(getUserSecret(1, "hardcover"), "admin-key");
  for (const payload of [{ torbox: "x" }, { hardcover: "other", torbox: "x" }, {}])
    assert.equal((await request(c, "PATCH", "/api/settings", payload)).statusCode, 403, JSON.stringify(payload));
  assert.equal(getUserSecret(4, "hardcover"), "key-c");
  assert.equal((await request(c, "PATCH", "/api/settings", { hardcover: "" })).statusCode, 200);
  assert.equal(await configured(c), false);
  assert.equal(await configured(admin), true);
  assert.equal(getUserSecret(1, "hardcover"), "admin-key");
  assert.equal(sqlite.prepare("SELECT 1 FROM settings WHERE key='hardcover'").get(), undefined);
});

test("only the admin can move a shared Hardcover match, and deleting a user drops their Hardcover state", async () => {
  const admin = await login(undefined, "admin-password");
  const a = await login("reader-a", "password1");
  const rematch = await request(a, "POST", "/api/hardcover/books", {
    id: 202,
    workId: "work-alice",
  });
  assert.equal(rematch.statusCode, 403);
  assert.ok(userRows("user_hardcover_links", 2).length > 0);
  assert.equal((await request(admin, "DELETE", "/api/users/2")).statusCode, 200);
  for (const table of hardcoverTables) assert.deepEqual(userRows(table, 2), [], table);
  assert.equal(
    sqlite.prepare("SELECT 1 FROM user_settings WHERE user_id=2").get(),
    undefined,
  );
});

test("the single-account Hardcover key, state and queues move to the admin exactly once", async () => {
  const { execFileSync } = await import("node:child_process");
  const { default: Database } = await import("better-sqlite3");
  const migrationDir = join(temp, "migration");
  mkdirSync(migrationDir, { recursive: true });
  const env = { ...process.env, DATA_DIR: migrationDir };
  const run = () =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", 'import "./server/db.ts"'],
      { cwd: process.cwd(), env },
    );
  run();
  const legacy = new Database(join(migrationDir, "sonder.db"));
  const state = JSON.stringify({ mode: "two-way", syncLists: true, accountId: 41, username: "legacy" });
  legacy
    .prepare("DELETE FROM settings WHERE key='migration:multi-user-hardcover'")
    .run();
  legacy.exec(`
INSERT INTO works VALUES('w','Title','Author','','',2000);
INSERT INTO works VALUES('w2','Same book','Author','','',2000);
INSERT INTO works VALUES('w3','Other','Author','','',2000);
INSERT INTO settings VALUES('hardcover','iv:tag:encrypted-legacy-key');
INSERT INTO settings VALUES('hardcoverState','${state}');
INSERT INTO hardcover_links VALUES('w',101,'alice','[]',11,2,1000,2000);
INSERT INTO hardcover_links VALUES('w2',101,'alice','[]',10,1,900,1500);
INSERT INTO hardcover_links VALUES('w3',303,NULL,'[]',NULL,NULL,0,0);
INSERT INTO hardcover_outbox VALUES(101,41,3,'status',3000,NULL);
INSERT INTO hardcover_reading_outbox VALUES(101,41,'w',0.25,3100,'offline');
INSERT INTO hardcover_lists VALUES(70,41,'Weekend','weekend','[{"id":71,"bookId":101}]',4000);
INSERT INTO hardcover_reads VALUES(101,41,'{}',0.1,5000);
`);
  legacy.close();
  run();
  const migrated = new Database(join(migrationDir, "sonder.db"));
  const setting = (key: string) =>
    (migrated.prepare("SELECT value FROM user_settings WHERE user_id=1 AND key=?").get(key) as any)?.value;
  assert.equal(setting("hardcover"), "iv:tag:encrypted-legacy-key");
  assert.equal(setting("hardcoverState"), state);
  assert.deepEqual(
    migrated.prepare("SELECT * FROM user_hardcover_links").all(),
    [{ user_id: 1, book_id: 101, user_book_id: 11, status_id: 2, remote_updated_at: 1000, synced_at: 2000 }],
  );
  assert.deepEqual(
    migrated.prepare("SELECT user_id,book_id,account_id,status_id FROM user_hardcover_outbox").all(),
    [{ user_id: 1, book_id: 101, account_id: 41, status_id: 3 }],
  );
  assert.deepEqual(
    migrated.prepare("SELECT user_id,work_id,fraction,error FROM user_hardcover_reading_outbox").all(),
    [{ user_id: 1, work_id: "w", fraction: 0.25, error: "offline" }],
  );
  assert.equal((migrated.prepare("SELECT members FROM user_hardcover_lists WHERE user_id=1 AND id=70").get() as any).members, '[{"id":71,"bookId":101}]');
  assert.equal((migrated.prepare("SELECT fraction FROM user_hardcover_reads WHERE user_id=1").get() as any).fraction, 0.1);
  // A second start neither re-copies nor overwrites, and the legacy rows stay for rollback.
  migrated.exec("DELETE FROM user_hardcover_outbox; UPDATE user_settings SET value='new' WHERE user_id=1 AND key='hardcoverState'");
  migrated.close();
  run();
  const reopened = new Database(join(migrationDir, "sonder.db"));
  assert.deepEqual(reopened.prepare("SELECT * FROM user_hardcover_outbox").all(), []);
  assert.equal((reopened.prepare("SELECT value FROM user_settings WHERE user_id=1 AND key='hardcoverState'").get() as any).value, "new");
  assert.equal((reopened.prepare("SELECT count(*) AS n FROM hardcover_outbox").get() as any).n, 1);
  assert.equal((reopened.prepare("SELECT value FROM settings WHERE key='hardcover'").get() as any).value, "iv:tag:encrypted-legacy-key");
  assert.equal((reopened.prepare("SELECT user_book_id FROM hardcover_links WHERE work_id='w'").get() as any).user_book_id, 11);
  reopened.close();
});
