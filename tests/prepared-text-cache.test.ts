// The disk cache and the routes of prepared reader text (server/prepared-text-cache.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
const { preparedDir, preparedKey, ensurePrepared, buildPrepared, prunePrepared, preparedCounts, located } = await import("../server/prepared-text-cache.ts");
const { EXTRACTOR_VERSION, invalidateParsedBook } = await import("../server/reader.ts");
const { eq } = await import("drizzle-orm");
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
  assert.notEqual(preparedKey(file), preparedKey(file, { prepared: PREPARED_TEXT_VERSION + 1 }));
  // The sentences are cut again after every restart, so what cuts them is in the key: the extractor and ICU's data.
  assert.notEqual(preparedKey(file), preparedKey(file, { extractor: EXTRACTOR_VERSION + 1 }));
  assert.notEqual(preparedKey(file), preparedKey(file, { icu: `${process.versions.icu}.1` }));
  assert.equal(preparedKey(file), preparedKey(file, { prepared: PREPARED_TEXT_VERSION, extractor: EXTRACTOR_VERSION, icu: process.versions.icu }));
});

test("the manifest holds nothing of the work that can change while the file stays", async () => {
  await edition("ed-title");
  const before = await get("/api/reader/ed-title/prepared");
  db.update(s.works).set({ title: "Another title", author: "Another author" }).where(eq(s.works.id, "work-cache")).run();
  invalidateParsedBook("ed-title");
  assert.equal((await get("/api/reader/ed-title")).json().title, "Another title");
  const after = await get("/api/reader/ed-title/prepared");
  assert.equal(after.headers.etag, before.headers.etag);
  assert.ok(!("title" in after.json()) && !("author" in after.json()));
});

test("only a part or picture that was served is kept: every refusal and failure says no-store", async () => {
  await edition("ed-errors");
  const { key } = (await get("/api/reader/ed-errors/prepared")).json();
  const base = `/api/reader/ed-errors/prepared/${key}`;
  const { dir } = await ensurePrepared("ed-errors");
  const refused: [string, string | null, number][] = [
    ["/api/reader/ed-errors/prepared", null, 401],
    [`${base}/parts/0`, null, 401],
    [`${base}/pictures/0.png`, null, 401],
    [`${base}/parts/9`, reader, 404],
    [`${base}/pictures/9.png`, reader, 404],
    [`/api/reader/ed-errors/prepared/${"0".repeat(16)}/parts/0`, reader, 404],
    ["/api/reader/ed-nobody/prepared", reader, 404],
    ["/api/reader/ed-nobody/prepared?x=1", reader, 404],
  ];
  for (const [url, cookie, status] of refused) {
    const response = await get(url, cookie);
    assert.equal(response.statusCode, status, url);
    assert.equal(response.headers["cache-control"], "no-store", url);
  }
  // A file that is there and cannot be read: the answer fails after the folder was found, and must not be kept
  // (a browser held such a 500 for the year the address is good for).
  if (process.getuid?.() !== 0) {
    for (const [file, url] of [["p0.html", `${base}/parts/0`], [join("pictures", "0.png"), `${base}/pictures/0.png`]]) {
      chmodSync(join(dir, file), 0o000);
      const failed = await get(url);
      chmodSync(join(dir, file), 0o640);
      assert.ok(failed.statusCode >= 500, `${url} answered ${failed.statusCode}`);
      assert.equal(failed.headers["cache-control"], "no-store", url);
      const served = await get(url);
      assert.equal(served.statusCode, 200);
      assert.equal(served.headers["cache-control"], "private, max-age=31536000, immutable");
    }
  }
  // Other routes keep their own headers.
  assert.notEqual((await get("/api/reader/ed-nobody")).headers["cache-control"], "no-store");
});

test("a key, a part number or a picture name cannot reach another folder's files", async () => {
  await edition("ed-here");
  await edition("ed-there");
  const here = await ensurePrepared("ed-here");
  const there = await ensurePrepared("ed-there");
  const other = there.dir.split("/").pop()!;
  const base = `/api/reader/ed-here/prepared/${here.key}`;
  // Real targets, so a missing check would answer 200: the other book's part and picture, a part with a name a
  // number check must refuse, and a picture that is no picture name.
  writeFileSync(join(here.dir, "pNaN.html"), "planted");
  writeFileSync(join(here.dir, "p00.html"), "planted");
  writeFileSync(join(here.dir, "pictures", "planted.png"), "planted");
  writeFileSync(join(here.dir, "pictures", "0.html"), "planted");
  assert.ok(existsSync(join(there.dir, "p0.html")) && existsSync(join(there.dir, "pictures", "0.png")));
  const slash = "%2F";
  for (const url of [
    // The key names another folder.
    `/api/reader/ed-here/prepared/x${slash}..${slash}${other}/parts/0`,
    `/api/reader/ed-here/prepared/x${slash}..${slash}${other}/pictures/0.png`,
    `/api/reader/ed-here/prepared/${here.key}${slash}..${slash}${other}/parts/0`,
    // The picture name walks out of the folder, to a picture and to a part.
    `${base}/pictures/..${slash}..${slash}${other}${slash}pictures${slash}0.png`,
    `${base}/pictures/..${slash}p0.html`,
    `${base}/pictures/planted.png`,
    `${base}/pictures/0.html`,
    // The part number is not a number.
    `${base}/parts/NaN`,
    `${base}/parts/abc`,
    `${base}/parts/0x0`,
    `${base}/parts/..${slash}..${slash}${other}${slash}p0`,
  ]) {
    const response = await get(url);
    assert.equal(response.statusCode, 404, url);
    assert.ok(!response.body.includes("planted") && !response.body.includes("First sentence"), url);
  }
  // The other book's own key under this edition's address is not this edition's folder either.
  assert.equal((await get(`/api/reader/ed-here/prepared/${there.key}/parts/0`)).statusCode, here.key === there.key ? 200 : 404);
});

test("parts and pictures ask for the edition as the reader does, also when the folder is still there", async () => {
  await edition("ed-leaves");
  const { key } = (await get("/api/reader/ed-leaves/prepared")).json();
  const { dir } = await ensurePrepared("ed-leaves");
  const urls = [`/api/reader/ed-leaves/prepared/${key}/parts/0`, `/api/reader/ed-leaves/prepared/${key}/pictures/0.png`];
  for (const url of urls) assert.equal((await get(url)).statusCode, 200, url);
  // The edition is no EPUB any more: the reader refuses it, and so do the kept files.
  db.update(s.ebookEditions).set({ format: "pdf" }).where(eq(s.ebookEditions.id, "ed-leaves")).run();
  for (const url of urls) assert.equal((await get(url)).statusCode, 400, url);
  // The edition is gone.
  db.delete(s.ebookEditions).where(eq(s.ebookEditions.id, "ed-leaves")).run();
  assert.ok(existsSync(join(dir, "p0.html")));
  for (const url of urls) assert.equal((await get(url)).statusCode, 404, url);
});

test("a prepared folder appears whole: it is written beside its place and renamed into it", async () => {
  await edition("ed-whole", "A paragraph of the book, as long as a line.</p><p>".repeat(8000));
  const { dir } = await located("ed-whole");
  const seen = { half: 0, temp: 0, looks: 0 };
  let done = false;
  const building = buildPrepared("ed-whole").finally(() => (done = true));
  // Look at the disk between the writer's steps for as long as it works.
  while (!done) {
    seen.looks++;
    if (existsSync(dir) && !(existsSync(join(dir, "entry.json")) && existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "p0.html")))) seen.half++;
    if (entries().some((name) => name.startsWith(dir.split("/").pop()!) && name.includes(".tmp-"))) seen.temp++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  await building;
  assert.equal(seen.half, 0, "the folder was never there without all of its files");
  assert.ok(seen.temp > 0, `the work was seen in its own folder (${seen.looks} looks)`);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.ok(manifest.parts.length > 3);
  for (const part of manifest.parts) assert.equal(statSync(join(dir, `p${part.index}.html`)).size, part.bytes);
});

test("nothing is prepared onto another disk when the media drive is not the recorded one", async () => {
  await edition("ed-mount");
  const { dir } = await located("ed-mount");
  const before = entries();
  process.env.REQUIRE_MEDIA_MOUNT = "true";
  process.env.MEDIA_VOLUME_ID = "a-volume-that-is-not-mounted";
  try {
    await assert.rejects(buildPrepared("ed-mount"), { statusCode: 503, message: /media volume is unavailable/ });
    const response = await get("/api/reader/ed-mount/prepared");
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    process.env.REQUIRE_MEDIA_MOUNT = "false";
    delete process.env.MEDIA_VOLUME_ID;
  }
  assert.ok(!existsSync(dir));
  assert.deepEqual(entries(), before);
  assert.equal((await get("/api/reader/ed-mount/prepared")).statusCode, 200);
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

test("a second open of an unchanged book transfers nothing", async () => {
  const file = await edition("ed-warm", "Warm text.");
  const first = await get("/api/reader/ed-warm/prepared");
  const tag = String(first.headers.etag);
  assert.match(tag, /^"[0-9a-f]{16}-[0-9a-f]{16}"$/);
  assert.equal(first.headers["cache-control"], "private, no-cache");
  const again = (header: string) => app.inject({ method: "GET", url: "/api/reader/ed-warm/prepared", cookies: { sonder_session: reader }, headers: { "if-none-match": header } });
  for (const header of [tag, `W/${tag}`, `"other", ${tag}`]) {
    const second = await again(header);
    assert.equal(second.statusCode, 304, header);
    assert.equal(second.body, "");
    assert.equal(second.headers.etag, tag);
  }
  // Parts and pictures are never asked for again: their addresses hold the key and are cached for a year, immutable.
  const { key } = first.json();
  for (const url of [`/api/reader/ed-warm/prepared/${key}/parts/0`, `/api/reader/ed-warm/prepared/${key}/pictures/0.png`])
    assert.equal((await get(url)).headers["cache-control"], "private, max-age=31536000, immutable", url);
  // A changed book has another validator, so the old one gets the new manifest.
  writeFileSync(file, await fixture("Changed text."));
  utimesSync(file, new Date(), new Date(Date.now() + 9000));
  const changed = await again(tag);
  assert.equal(changed.statusCode, 200);
  assert.notEqual(changed.headers.etag, tag);
  assert.equal((await get("/api/reader/ed-warm/prepared", null)).statusCode, 401);
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
