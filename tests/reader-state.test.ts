// GET /api/reader/:id/state (server/reader.ts): what a user saved in an edition, without the book's sentences.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-reader-state-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { preparedFixture } = await import("./prepared-text-fixture.ts");
const app = await createApp();
after(async () => {
  await app.close();
  sqlite.close();
});
mkdirSync(join(temp, "media", "ebooks"), { recursive: true });
db.insert(s.works).values({ id: "work-state", title: "State", author: "Test", description: "", genre: "", year: 2026 }).run();
const file = join(temp, "media", "ebooks", "state.epub");
writeFileSync(file, await preparedFixture({ chapters: { "one.xhtml": "<h1>One</h1><p>First sentence. Second sentence.</p>" } }));
db.insert(s.ebookEditions).values({ id: "ed-state", workId: "work-state", format: "epub", source: file }).run();
db.insert(s.ebookEditions).values({ id: "ed-pdf", workId: "work-state", format: "pdf", source: file }).run();
const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;
const admin = await login("203.0.113.50", { password: "admin-password" });
for (const username of ["first", "second"])
  await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username, password: "password1" } });
const first = await login("203.0.113.51", { username: "first", password: "password1" });
const second = await login("203.0.113.52", { username: "second", password: "password1" });
const call = (method: "GET" | "POST" | "PUT", url: string, cookie: string | null, payload?: object) =>
  app.inject({ method, url, ...(cookie ? { cookies: { sonder_session: cookie } } : {}), ...(payload ? { payload } : {}) });

test("the state is what this user saved, without the sentences, and is never kept by a cache", async () => {
  const book = (await call("GET", "/api/reader/ed-state", first)).json();
  const sentence = book.sections[0].paragraphs[1];
  const locator = { section: book.sections[0].index, paragraphId: sentence.id, quote: sentence.text, progression: 0.5 };
  const saved = await call("PUT", "/api/reader/ed-state/progress", first, { locator, baseRevision: 0, eventId: "event-0001", deviceId: "device-1", updatedAt: Date.now() });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await call("POST", "/api/reader/ed-state/bookmarks", first, { id: "bookmark-1", label: "Second", locator })).statusCode, 200);

  const response = await call("GET", "/api/reader/ed-state/state", first);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  const state = response.json();
  assert.deepEqual(Object.keys(state).sort(), ["author", "bookmarks", "checkpoint", "id", "title", "workId"]);
  // The work's own title and author, which an edit changes without the book's file changing.
  assert.deepEqual([state.title, state.author], ["State", "Test"]);
  assert.equal(state.id, "ed-state");
  assert.equal(state.workId, "work-state");
  assert.equal(state.checkpoint.locator.paragraphId, sentence.id);
  assert.deepEqual(state.bookmarks.map((entry: { id: string; locator: { paragraphId: string } }) => [entry.id, entry.locator.paragraphId]), [["bookmark-1", sentence.id]]);
  // The old route answers the same checkpoint and bookmarks, with the sentences.
  const whole = (await call("GET", "/api/reader/ed-state", first)).json();
  assert.deepEqual(state.checkpoint, whole.checkpoint);
  assert.deepEqual(state.bookmarks, whole.bookmarks);
});

test("another user gets their own state, not this one's", async () => {
  const state = (await call("GET", "/api/reader/ed-state/state", second)).json();
  assert.equal(state.workId, "work-state");
  assert.equal(state.checkpoint, null);
  assert.deepEqual(state.bookmarks, []);
});

test("a part the reader's allow-list refused markup in is reported once and logged; nothing else is accepted", async () => {
  const report = (cookie: string | null, payload: object, id = "ed-state") => call("POST", `/api/reader/${id}/prepared-refused`, cookie, payload);
  const good = { key: "0123456789abcdef", part: 3, refused: ["element script", "attribute onerror on img", "element svg of another namespace"] };
  assert.equal((await report(first, good)).statusCode, 204);
  assert.equal((await report(null, good)).statusCode, 401);
  assert.notEqual((await report(first, good, "ed-none")).statusCode, 204);
  for (const bad of [
    { ...good, refused: [] },
    { ...good, refused: ["x".repeat(81)] },
    { ...good, refused: [""] },
    { ...good, refused: Array.from({ length: 21 }, () => "element script") },
    { ...good, key: "../../etc" },
    { ...good, part: -1 },
    { key: good.key, part: 1 },
  ])
    assert.equal((await report(first, bad)).statusCode, 400, JSON.stringify(bad));
});

test("a signed-out request, a missing edition and a PDF are refused as the reader's own route refuses them", async () => {
  assert.equal((await call("GET", "/api/reader/ed-state/state", null)).statusCode, 401);
  for (const id of ["ed-none", "ed-pdf"]) {
    const whole = await call("GET", `/api/reader/${id}`, first);
    const state = await call("GET", `/api/reader/${id}/state`, first);
    assert.equal(state.statusCode, whole.statusCode, id);
    assert.notEqual(state.statusCode, 200, id);
  }
});
