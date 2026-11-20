// The disk cache and the routes of prepared reader text (server/prepared-text-cache.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-prepared-cache-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.PREPARED_TEXT_DIR;
delete process.env.PREPARED_TEXT_CACHE_MB;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { PREPARED_TEXT_VERSION, sentencesOfParts } = await import("../server/prepared-text.ts");
const { preparedDir, preparedKey, ensurePrepared, buildPrepared, prunePrepared, preparedCounts } = await import("../server/prepared-text-cache.ts");
const { preparedFixture, tinyPng } = await import("./prepared-text-fixture.ts");
const app = await createApp();
after(async () => {
  await app.close();
  sqlite.close();
});
mkdirSync(join(temp, "media", "ebooks"), { recursive: true });
db.insert(s.works).values({ id: "work-cache", title: "Cached", author: "Test", description: "", genre: "", year: 2026 }).run();
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const fixture = (text: string) =>
  preparedFixture({ files: { "pic.png": tinyPng, "draw.svg": svg }, chapters: { "one.xhtml": `<h1>One</h1><p>${text}</p><p><img src="pic.png" alt=""/><img src="draw.svg" alt=""/></p>` } });
async function edition(id: string, text = "First sentence. Second sentence.") {
  const file = join(temp, "media", "ebooks", `${id.replace(/\W/g, "_")}.epub`);
  writeFileSync(file, await fixture(text));
  db.insert(s.ebookEditions).values({ id, workId: "work-cache", format: "epub", source: file }).run();
  return file;
}
const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;
const admin = await login("203.0.113.40", { password: "admin-password" });
await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } });
const reader = await login("203.0.113.41", { username: "reader", password: "password1" });
const get = (url: string, cookie: string | null = reader) => app.inject({ method: "GET", url, ...(cookie ? { cookies: { sonder_session: cookie } } : {}) });
const entries = () => (existsSync(preparedDir()) ? readdirSync(preparedDir()).sort() : []);

test("the key follows the EPUB file and the preparing code", () => {
  const file = { size: 1000, mtimeMs: 1700000000000.5 };
  assert.match(preparedKey(file), /^[0-9a-f]{16}$/);
  assert.equal(preparedKey(file), preparedKey({ ...file }));
  assert.notEqual(preparedKey(file), preparedKey({ ...file, size: 1001 }));
  assert.notEqual(preparedKey(file), preparedKey({ ...file, mtimeMs: file.mtimeMs + 1 }));
  assert.notEqual(preparedKey(file), preparedKey(file, PREPARED_TEXT_VERSION + 1));
});

test("the manifest, its parts and its pictures are served to a signed-in reader, and to nobody else", async () => {
  await edition("ed-routes");
  const manifestResponse = await get("/api/reader/ed-routes/prepared");
  assert.equal(manifestResponse.statusCode, 200, manifestResponse.body);
  assert.equal(manifestResponse.headers["cache-control"], "private, no-cache");
  const manifest = manifestResponse.json();
  assert.equal(manifest.id, "ed-routes");
  assert.equal(manifest.key, preparedKey(statSync(join(temp, "media", "ebooks", "ed_routes.epub"))));
  assert.equal(manifest.parts.length, 1);
  assert.deepEqual(manifest.problems, []);
  const base = `/api/reader/ed-routes/prepared/${manifest.key}`;
  const part = await get(`${base}/parts/0`);
  assert.equal(part.statusCode, 200, part.body);
  assert.equal(part.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(part.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.equal(part.headers["x-content-type-options"], "nosniff");
  assert.match(String(part.headers["content-security-policy"]), /sandbox/);
  assert.equal(Buffer.byteLength(part.body), manifest.parts[0].bytes);
  assert.deepEqual(sentencesOfParts([part.body]).sentences.map((sentence) => sentence.id), ["0:0", "0:1", "0:2"]);
  // Pictures sit under the same key, so a book prepared again never shows an old one.
  assert.ok(part.body.includes(`<img src="${base}/pictures/0.png"`));
  const picture = await get(`${base}/pictures/0.png`);
  assert.equal(picture.statusCode, 200);
  assert.equal(picture.headers["content-type"], "image/png");
  assert.equal(picture.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.equal(picture.headers["x-content-type-options"], "nosniff");
  assert.ok(picture.rawPayload.equals(tinyPng));
  // An SVG is the book's own file with whatever it holds: opened by its address it may run nothing.
  const drawing = await get(`${base}/pictures/1.svg`);
  assert.equal(drawing.headers["content-type"], "image/svg+xml");
  assert.match(String(drawing.headers["content-security-policy"]), /^default-src 'none'; style-src 'unsafe-inline'; sandbox$/);
  // The same checks as GET /api/reader/:id and the EPUB file: signed in, and the edition must be there.
  for (const url of ["/api/reader/ed-routes/prepared", `${base}/parts/0`, `${base}/pictures/0.png`]) {
    assert.equal((await get(url, null)).statusCode, 401, url);
    assert.equal((await get(url, admin)).statusCode, 200, url);
  }
  for (const url of ["/api/reader/ed-missing/prepared", `/api/reader/ed-missing/prepared/${manifest.key}/parts/0`, `/api/reader/ed-missing/prepared/${manifest.key}/pictures/0.png`])
    assert.equal((await get(url)).statusCode, 404, url);
  db.insert(s.ebookEditions).values({ id: "ed-pdf", workId: "work-cache", format: "pdf", source: join(temp, "media", "ebooks", "ed_routes.epub") }).run();
  assert.equal((await get("/api/reader/ed-pdf/prepared")).statusCode, 400);
  assert.equal((await get("/api/reader/set-consensus:work-cache/prepared")).statusCode, 404);
});

test("a part or picture that is not there is not found, whatever its name", async () => {
  await edition("ed-names");
  const { key } = (await get("/api/reader/ed-names/prepared")).json();
  const base = `/api/reader/ed-names/prepared/${key}`;
  for (const url of [
    `${base}/parts/1`,
    `${base}/parts/-1`,
    `${base}/parts/0.html`,
    `${base}/parts/..%2Fmanifest.json`,
    `${base}/pictures/7.png`,
    `${base}/pictures/0.html`,
    `${base}/pictures/..%2Fp0.html`,
    `${base}/pictures/..%2F..%2F..%2Febooks%2Fed_names.epub`,
    `/api/reader/ed-names/prepared/..%2F..%2Febooks/parts/0`,
    `/api/reader/ed-names/prepared/${"0".repeat(16)}/parts/0`,
  ]) {
    const response = await get(url);
    assert.equal(response.statusCode, 404, url);
  }
  // A key the server no longer keeps says so, and the reader loads the manifest again.
  assert.equal((await get(`/api/reader/ed-names/prepared/${"0".repeat(16)}/parts/0`)).json().code, "prepared_stale");
});

test("a changed EPUB is prepared again under a new key, and the old entry goes", async () => {
  const file = await edition("ed-changed", "The old text.");
  const before = (await get("/api/reader/ed-changed/prepared")).json();
  const oldPart = `/api/reader/ed-changed/prepared/${before.key}/parts/0`;
  assert.ok((await get(oldPart)).body.includes("The old text."));
  writeFileSync(file, await fixture("The new text is longer."));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const after = (await get("/api/reader/ed-changed/prepared")).json();
  assert.notEqual(after.key, before.key);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.ok((await get(`/api/reader/ed-changed/prepared/${after.key}/parts/0`)).body.includes("The new text is longer."));
  assert.equal((await get(oldPart)).statusCode, 404);
  assert.equal(entries().filter((name) => name.endsWith(before.key)).length, 0);
});

test("a book is prepared once, however many ask at the same time", async () => {
  await edition("ed-together");
  const before = preparedCounts.built;
  const answers = await Promise.all(Array.from({ length: 12 }, () => get("/api/reader/ed-together/prepared")));
  assert.deepEqual([...new Set(answers.map((answer) => answer.statusCode))], [200]);
  assert.equal(new Set(answers.map((answer) => answer.body)).size, 1);
  assert.equal(preparedCounts.built - before, 1);
  await get("/api/reader/ed-together/prepared");
  assert.equal(preparedCounts.built - before, 1, "and then read from the disk");
});

test("two servers preparing the same book leave one whole entry and nothing else", async () => {
  await edition("ed-race");
  // buildPrepared is what a server runs when the entry is missing; two at once are two servers on one disk.
  const [one, two] = await Promise.all([buildPrepared("ed-race"), buildPrepared("ed-race")]);
  assert.equal(one.dir, two.dir);
  assert.deepEqual(readdirSync(one.dir).sort(), ["entry.json", "manifest.json", "p0.html", "pictures"]);
  assert.deepEqual(readdirSync(join(one.dir, "pictures")).sort(), ["0.png", "1.svg"]);
  assert.equal(entries().filter((name) => name.includes(".tmp-")).length, 0);
  const manifest = JSON.parse(readFileSync(join(one.dir, "manifest.json"), "utf8"));
  assert.equal(statSync(join(one.dir, "p0.html")).size, manifest.parts[0].bytes);
  assert.equal((await ensurePrepared("ed-race")).dir, one.dir);
});

test("pruning removes abandoned work and, past the size bound, the entries read longest ago", async () => {
  await edition("ed-old");
  await edition("ed-new");
  const old = await ensurePrepared("ed-old");
  const fresh = await ensurePrepared("ed-new");
  const longAgo = new Date(Date.now() - 3 * 86_400_000);
  utimesSync(old.dir, longAgo, longAgo);
  const abandoned = join(preparedDir(), "0000000000000000-0000000000000000.tmp-1-abc");
  mkdirSync(abandoned);
  utimesSync(abandoned, longAgo, longAgo);
  const working = join(preparedDir(), "1111111111111111-1111111111111111.tmp-2-def");
  mkdirSync(working);
  await prunePrepared({ maxBytes: Number.MAX_SAFE_INTEGER });
  assert.ok(!existsSync(abandoned), "a preparing step that died is cleared away");
  assert.ok(existsSync(working), "one that may still be running is left alone");
  assert.ok(existsSync(old.dir));
  const size = JSON.parse(readFileSync(join(fresh.dir, "entry.json"), "utf8")).bytes;
  assert.ok(size > 0);
  await prunePrepared({ maxBytes: size, keep: fresh.dir });
  assert.ok(!existsSync(old.dir), "the entry read longest ago goes first");
  assert.ok(existsSync(fresh.dir));
  assert.deepEqual(entries().filter((name) => !name.includes(".tmp-")).length, 1);
  // It is prepared again when someone opens the book.
  assert.equal((await get("/api/reader/ed-old/prepared")).statusCode, 200);
});
