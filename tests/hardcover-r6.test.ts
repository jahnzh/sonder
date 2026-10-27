import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "sonder-hardcover-r6-"));
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
const book = (id: number, title: string, author: string) => ({
  id,
  title,
  slug: `book-${id}`,
  pages: 200,
  description: "A Hardcover edition",
  release_year: 2000,
  cached_image: null,
  contributions: [{ contribution: "author", author: { name: author } }],
  book_series: [],
  default_audio_edition: null,
  editions: [],
});
const alice = {
  ...book(101, "Alice’s Adventures in Wonderland", "Lewis Carroll"),
  default_audio_edition: { id: 901, audio_seconds: 21454, edition_format: "Audiobook", contributions: [] },
};
const read = (seconds: number) => ({
  id: 501,
  started_at: "2026-01-01",
  finished_at: null,
  finished_at_precision: null,
  progress_seconds: seconds,
  progress_pages: null,
  edition_id: 901,
  edition: { id: 901, audio_seconds: 21454, pages: null, reading_format_id: 2 },
});
const entries: any[] = [
  { id: 11, book_id: 101, status_id: 2, updated_at: "2020-01-01T00:00:00Z", book: alice, user_book_reads: [read(2000)] },
  { id: 12, book_id: 555, status_id: 1, updated_at: "2020-01-01T00:00:00Z", book: book(555, "Private Diary Of Reader A", "Reader A"), user_book_reads: [] },
];
const listBook = book(556, "Secret List Book", "Reader A");
let libraryGate: Promise<void> | null = null;
let reachedLibrary: () => void = () => {};
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.hardcover.app/"))
    return realFetch(input, init);
  const key = String((init?.headers as Record<string, string>).Authorization).replace(/^Bearer /, "");
  if (key !== "key-a") return new Response("unauthorized", { status: 401 });
  const { query, variables: v } = JSON.parse(String(init?.body));
  let data: any;
  if (query.includes("SonderAccount")) data = { me: [{ id: 7001, username: "hc-reader-a" }] };
  else if (query.includes("SonderLibrary")) {
    reachedLibrary();
    if (libraryGate) await libraryGate;
    data = { user_books: entries.slice(v.offset, v.offset + 250) };
  } else if (query.includes("SonderListBooks"))
    data = { list_books: [{ id: 81, list_id: 80, book_id: 556, book: listBook }] };
  else if (query.includes("SonderLists"))
    data = { lists: [{ id: 80, user_id: 7001, name: "Private list", slug: "private", books_count: 1 }] };
  else if (query.includes("SonderBook"))
    data = { books_by_pk: v.id === 101 ? alice : v.id === 621 ? book(621, "The Time Machine", "H. G. Wells") : null };
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
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
};
const request = (cookie: string, method: any, url: string, payload?: any) =>
  app.inject({ method, url, cookies: { sonder_session: cookie }, payload });
const admin = await login(undefined, "admin-password");
for (const username of ["reader-a", "reader-c"])
  assert.equal((await request(admin, "POST", "/api/users", { username, password: "password1" })).statusCode, 200);
const a = await login("reader-a", "password1"),
  c = await login("reader-c", "password1");
const [idA, idC] = [2, 3];
assert.equal((await request(a, "PUT", "/api/hardcover/token", { token: "key-a" })).statusCode, 200);
assert.equal(
  (await request(a, "PATCH", "/api/hardcover/config", { mode: "import", syncLists: true })).statusCode,
  200,
);
// The admin matched Alice to its Hardcover book earlier; regular users never create matches (G1).
sqlite
  .prepare("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('work-alice',101,'book-101','[]')")
  .run();
const firstSync = await request(a, "POST", "/api/hardcover/sync");
assert.equal(firstSync.statusCode, 200, firstSync.body);
const localPosition = () =>
  (sqlite.prepare("SELECT position FROM user_progress WHERE user_id=? AND recording_id='recording-alice'").get(idA) as
    | { position: number }
    | undefined)?.position;

test("r6#1: one user's Hardcover placeholders are hidden from other users but not from the owner or the admin", () => {
  assert.ok(sqlite.prepare("SELECT 1 FROM audio_editions WHERE id='hc-555'").get());
  assert.ok(sqlite.prepare("SELECT 1 FROM audio_editions WHERE id='hc-556'").get());
  const hidden = hc.hiddenHardcoverPlaceholders(idC);
  assert.ok(hidden.has("hc-555"), "shelf placeholder");
  assert.ok(hidden.has("hc-556"), "list placeholder");
  assert.ok(!hidden.has("alice"), "a book with audio stays visible");
  assert.deepEqual([...hc.hiddenHardcoverPlaceholders(idA)], []);
  assert.deepEqual([...hc.hiddenHardcoverPlaceholders(1)], []);
  // Removing it from A's library still leaves it visible to A while it's on their shelf.
  sqlite.prepare("DELETE FROM user_library WHERE user_id=? AND book_id='hc-555'").run(idA);
  assert.ok(!hc.hiddenHardcoverPlaceholders(idA).has("hc-555"));
  // Another user who adds it to their own library sees it too.
  sqlite.prepare("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,?,?)").run(idC, "hc-555", "unread", Date.now());
  assert.ok(!hc.hiddenHardcoverPlaceholders(idC).has("hc-555"));
  assert.ok(hc.hiddenHardcoverPlaceholders(idC).has("hc-556"));
});

test("r6#2: only the admin creates a shared match, while a regular user can still import an already-matched work", async () => {
  assert.equal(hc.hardcoverLinkedBook("work-frankenstein"), undefined);
  const create = await request(c, "POST", "/api/hardcover/books", { id: 101, workId: "work-frankenstein" });
  assert.equal(create.statusCode, 403, create.body);
  const createWithKey = await request(a, "POST", "/api/hardcover/books", { id: 101, workId: "work-frankenstein" });
  assert.equal(createWithKey.statusCode, 403, createWithKey.body);
  assert.equal(hc.hardcoverLinkedBook("work-frankenstein"), undefined);
  assert.equal(hc.hardcoverLinkedBook("work-alice"), 101);
  const existing = await request(a, "POST", "/api/hardcover/books", { id: 101, workId: "work-alice" });
  assert.equal(existing.statusCode, 200, existing.body);
  const plain = await request(a, "POST", "/api/hardcover/books", { id: 101 });
  assert.equal(plain.statusCode, 200, plain.body);
});

test("G1: a regular user's automatic sync never matches an unlinked local work, it uses a hidden placeholder", async () => {
  // Same title and author as the unlinked local Frankenstein work.
  entries.push({ id: 14, book_id: 620, status_id: 1, updated_at: "2020-01-01T00:00:00Z", book: book(620, "Frankenstein", "Mary Shelley"), user_book_reads: [] });
  try {
    const sync = await request(a, "POST", "/api/hardcover/sync");
    assert.equal(sync.statusCode, 200, sync.body);
    assert.equal(hc.hardcoverLinkedBook("work-frankenstein"), undefined);
    assert.equal(hc.hardcoverLinkedBook("work-hc-620"), 620);
    assert.ok(sqlite.prepare("SELECT 1 FROM user_library WHERE user_id=? AND book_id='hc-620'").get(idA));
    assert.equal(sqlite.prepare("SELECT 1 FROM user_library WHERE user_id=? AND book_id='frankenstein'").get(idA), undefined);
    assert.ok(hc.hiddenHardcoverPlaceholders(idC).has("hc-620"));
    // A plain import without a work id takes the same path.
    const plain = await request(a, "POST", "/api/hardcover/books", { id: 621 });
    assert.equal(plain.statusCode, 200, plain.body);
    assert.equal(hc.hardcoverLinkedBook("work-time"), undefined);
    assert.equal(hc.hardcoverLinkedBook("work-hc-621"), 621);
  } finally {
    entries.splice(entries.findIndex((e) => e.id === 14), 1);
  }
});

test("r6#3: in import mode an older Hardcover position never overwrites a newer local one", async () => {
  const saved = await request(a, "POST", "/api/progress", {
    recordingId: "recording-alice",
    trackId: "alice-0",
    position: 400,
    duration: 640,
    updatedAt: Date.now(),
  });
  assert.equal(saved.statusCode, 200, saved.body);
  // Hardcover changed an hour before the local listen.
  entries[0].user_book_reads = [read(16000)];
  entries[0].updated_at = new Date(Date.now() - 3600_000).toISOString();
  assert.equal((await request(a, "POST", "/api/hardcover/sync")).statusCode, 200);
  assert.equal(localPosition(), 400);
  // A Hardcover change made after the local listen still applies.
  entries[0].user_book_reads = [read(10727)];
  entries[0].updated_at = new Date(Date.now() + 1000).toISOString();
  assert.equal((await request(a, "POST", "/api/hardcover/sync")).statusCode, 200);
  assert.notEqual(localPosition(), 400);
});

test("r6#6: forgetting a deleted user stops their in-flight sync before it commits anything", async () => {
  entries.push({ id: 13, book_id: 777, status_id: 1, updated_at: "2020-01-01T00:00:00Z", book: book(777, "Late Book", "Reader A"), user_book_reads: [] });
  let release: () => void = () => {};
  libraryGate = new Promise((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reachedLibrary = resolve));
  const stateBefore = sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='hardcoverState'").get(idA);
  const running = hc.syncHardcover(idA);
  await reached;
  hc.forgetHardcoverUser(idA);
  release();
  await assert.rejects(running, /connection changed/);
  libraryGate = null;
  assert.equal(sqlite.prepare("SELECT 1 FROM audio_editions WHERE id='hc-777'").get(), undefined);
  assert.equal(sqlite.prepare("SELECT 1 FROM user_hardcover_links WHERE user_id=? AND book_id=777").get(idA), undefined);
  assert.deepEqual(
    sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='hardcoverState'").get(idA),
    stateBefore,
  );
  // A user who reuses the id starts with a fresh runtime, not the old in-flight sync.
  const fresh = await hc.syncHardcover(idA);
  assert.equal(fresh.imported >= 1, true);
});
