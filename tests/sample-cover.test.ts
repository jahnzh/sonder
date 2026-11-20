/**
 * #763: an edition without its own cover never shows a sample book's art (The Time Machine, Meditations).
 *
 * - The rule: a sample cover (`/covers/<id>.svg`) held by another edition is no cover; the seeded book keeps its own.
 * - The one cover choice: the edition's own, else the work's (the placeholder's catalogue cover or another edition
 *   the user may see), else "" for the generated cover; on the server (`GET /api/library`, `GET /api/works`) and on
 *   the client (`bookCover`, which the mini player, the desktop footer and Now playing use over `GET /api/books`).
 * - No server code path writes a sample cover for another book: the source is scanned, and the writers run.
 * - `GET /api/books` keeps the stored values (its pin is `tests/books-pin.test.ts`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.ts";
import { ownCover, isSampleCoverOfAnother, SAMPLE_COVER_BOOKS, type Book, type LibraryWork, type WorkResult } from "../src/types.ts";
import { bookCover, coverShare, COVER_SHARES } from "../src/cover-choice.ts";

const temp = tempDir("sonder-sample-cover-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const { ensurePlaceholder } = await import("../server/placeholder-edition.ts");
const { parseAbbListings } = await import("../server/services.ts");

const OWNER = 1;
const SAM = 2;
const OWNER_TOKEN = "owner-763";
const SAM_TOKEN = "sam-763";
const HC_COVER = "https://assets.hardcover.app/got.jpg";
const OWNER_COVER = "https://covers.example/owner-only.jpg";
const T0 = Date.UTC(2026, 10, 19);
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(?,'admin',NULL,'admin',?)", OWNER, T0);
run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(?,'sam',NULL,'user',?)", SAM, T0);
run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(OWNER_TOKEN), Date.now() + 86_400_000, OWNER);
run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(SAM_TOKEN), Date.now() + 86_400_000, SAM);
const work = (id: string, title: string, author: string) =>
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,'','Fiction',1996)", id, title, author);
/** An edition with a recording; `tracks` makes it a real one, none a placeholder. */
const edition = (id: string, workId: string, cover: string, tracks: boolean, source = "TorBox") => {
  run(
    "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,'N','en',NULL,0,?)",
    id, workId, cover, source,
  );
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `recording-${id}`, id);
  if (tracks)
    run(
      "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,'Part 1',0,600,?,'remote','[]')",
      `${id}-t1`, `recording-${id}`, `https://audio.example/${id}.mp3`,
    );
};
const shelf = (userId: number, editionId: string, at: number) =>
  run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", userId, editionId, at);
const place = (userId: number, editionId: string, at: number) =>
  run(
    "INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(?,?,?,10,600,?)",
    userId, `recording-${editionId}`, `${editionId}-t1`, at,
  );

// The owner's data shape (#763): A Game of Thrones, its Hardcover placeholder hc-644 with a real cover and two TorBox
// editions stored with The Time Machine's art; the owner listens to the second.
work("w-got", "A Game of Thrones", "George R.R. Martin");
edition("hc-644", "w-got", HC_COVER, false, "Hardcover library");
edition("torbox-144379929", "w-got", "/covers/time.svg", true);
edition("torbox-150169001", "w-got", "/covers/time.svg", true);
shelf(OWNER, "torbox-144379929", T0 + 1);
shelf(OWNER, "torbox-150169001", T0 + 2);
place(OWNER, "torbox-150169001", T0 + 3);
// Dangerous Women: only a placeholder of a catalogue work, stored with Meditations' art; no cover anywhere.
work("w-dw", "Dangerous Women", "George R.R. Martin");
edition("placeholder-work-abdb-dw", "w-dw", "/covers/meditations.svg", false, "AudiobookDB");
shelf(OWNER, "placeholder-work-abdb-dw", T0 + 4);
// The sample book itself keeps its own art.
work("work-time", "The Time Machine", "H. G. Wells");
edition("time", "work-time", "/covers/time.svg", true, "LibriVox · Public domain");
shelf(OWNER, "time", T0 + 5);
// One work, two accounts: Sam's own edition has no cover; the owner's covered edition is the owner's alone.
work("w-shared", "Shared Work", "Ada North");
edition("ed-sam", "w-shared", "/covers/time.svg", true);
edition("ed-owner", "w-shared", OWNER_COVER, true);
shelf(SAM, "ed-sam", T0 + 6);
shelf(OWNER, "ed-owner", T0 + 7);

// The catalogue link's cover (kept on the placeholder) comes before another edition's, whichever was added first.
work("w-order", "Order of Covers", "Ada North");
edition("ed-order-covered", "w-order", "https://covers.example/other-edition.jpg", true);
edition("hc-900", "w-order", "https://covers.example/catalogue.jpg", false, "Hardcover library");
edition("ed-order-bare", "w-order", "/covers/war.svg", true);
shelf(OWNER, "ed-order-covered", T0 + 8);
shelf(OWNER, "ed-order-bare", T0 + 9);
place(OWNER, "ed-order-bare", T0 + 10);

const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
  sqlite.close();
});
const get = async <T>(url: string, token: string) => {
  const response = await app.inject({ url, cookies: { sonder_session: token } });
  assert.equal(response.statusCode, 200, response.body);
  return { body: response.body, json: response.json() as T };
};
const libraryWorks = async (token: string) => {
  const { body, json } = await get<{ works: LibraryWork[] } | LibraryWork[]>("/api/library", token);
  return { body, works: Array.isArray(json) ? json : json.works };
};

test("the rule: a sample book's cover held by another edition is no cover; the sample book keeps its own", () => {
  assert.equal(isSampleCoverOfAnother("/covers/time.svg", "torbox-144379929"), true);
  assert.equal(isSampleCoverOfAnother("/covers/meditations.svg", "placeholder-work-abdb-dw"), true);
  assert.equal(isSampleCoverOfAnother("/covers/time.svg", "time"), false);
  assert.equal(ownCover("/covers/time.svg", "torbox-144379929"), "");
  assert.equal(ownCover("/covers/time.svg", "time"), "/covers/time.svg");
  assert.equal(ownCover(HC_COVER, "hc-644"), HC_COVER);
  assert.equal(ownCover("/api/covers/0123456789abcdef0123456789abcdef.jpg", "x"), "/api/covers/0123456789abcdef0123456789abcdef.jpg");
  assert.equal(ownCover("", "x"), "");
  assert.equal(ownCover("/covers/w-one.svg", "ed-w-one"), "/covers/w-one.svg", "only the sample books' art is refused");
  assert.equal(ownCover(null, "x"), "");
});

test("the mini player's choice over GET /api/books: an uncovered edition shows its work's cover", async () => {
  const { json: books } = await get<Book[]>("/api/books", OWNER_TOKEN);
  const playing = books.find((book) => book.id === "torbox-150169001")!;
  // GET /api/books keeps the stored value (its pin): the choice is the client's.
  assert.equal(playing.cover, "/covers/time.svg");
  assert.equal(bookCover(playing, books), HC_COVER, "the work's cover (its placeholder's), not The Time Machine's");
  assert.equal(bookCover(books.find((book) => book.id === "torbox-144379929")!, books), HC_COVER);
  assert.equal(bookCover(books.find((book) => book.id === "hc-644")!, books), HC_COVER, "its own");
  assert.equal(bookCover(books.find((book) => book.id === "time")!, books), "/covers/time.svg", "the sample book's own art");
  const dw = books.find((book) => book.id === "placeholder-work-abdb-dw")!;
  assert.equal(bookCover(dw, books), "", "no cover anywhere: the generated cover, not Meditations");
  // Without the other editions, the work's cover the server chose (the mini player's second source).
  assert.equal(bookCover(playing, [], HC_COVER), HC_COVER);
  assert.equal(bookCover(playing, []), "");
});

test("GET /api/library: the work's cover by the one choice, for each account", async () => {
  const owner = await libraryWorks(OWNER_TOKEN);
  const cover = (workId: string) => owner.works.find((entry) => entry.workId === workId)?.cover;
  assert.equal(cover("w-got"), HC_COVER, "the chosen TorBox edition has none of its own: the work's");
  assert.equal(cover("w-dw"), "", "the placeholder of a catalogue work with no cover anywhere: none, for the generated cover");
  assert.equal(cover("work-time"), "/covers/time.svg");
  assert.equal(cover("w-shared"), OWNER_COVER);
  assert.equal(cover("w-order"), "https://covers.example/catalogue.jpg", "the catalogue link's cover before another edition's");

  const sam = await libraryWorks(SAM_TOKEN);
  assert.deepEqual(sam.works.map((entry) => [entry.workId, entry.cover]), [["w-shared", ""]], "never the owner's edition's cover");
  assert.ok(!sam.body.includes(OWNER_COVER) && !sam.body.includes(HC_COVER) && !sam.body.includes("/covers/time.svg"));
});

test("GET /api/works (Discover's server rows): the same choice, and the second account learns nothing of the owner's", async () => {
  const owner = (await get<{ works: WorkResult[] }>("/api/works?q=George", OWNER_TOKEN)).json.works;
  assert.deepEqual(
    Object.fromEntries(owner.map((row) => [row.workId, row.cover])),
    { "w-got": HC_COVER, "w-dw": "" },
  );
  const sam = await get<{ works: WorkResult[] }>("/api/works?q=Shared", SAM_TOKEN);
  for (const row of sam.json.works) assert.notEqual(row.cover, OWNER_COVER);
  assert.ok(!sam.body.includes(OWNER_COVER));
});

test("the writers store no cover rather than a sample book's", () => {
  work("w-new", "New Work", "Someone");
  const id = ensurePlaceholder(sqlite, "w-new");
  assert.equal(sqlite.prepare("SELECT cover FROM audio_editions WHERE id=?").pluck().get(id), "");
  work("w-http", "Insecure Cover", "Someone");
  const insecure = ensurePlaceholder(sqlite, "w-http", { cover: "http://insecure.example/c.jpg" });
  assert.equal(sqlite.prepare("SELECT cover FROM audio_editions WHERE id=?").pluck().get(insecure), "");
  const listings = parseAbbListings(
    `<div class="post"><div class="postTitle"><a href="/abss/a-book/">A Book - An Author</a></div></div>
     <div class="post"><div class="postTitle"><a href="/abss/b-book/">B Book - An Author</a></div><img src="https://img.example/b.jpg"></div>`,
    "https://audiobookbay.example",
  );
  assert.deepEqual(listings.map((listing) => listing.cover), ["", "https://img.example/b.jpg"]);
});

test("no server code path writes a sample book's cover for another book", () => {
  // Every `/covers/<name>.svg` written as a value in server code. Patterns that only recognise one (`\/covers\/`)
  // are not values; the demo seed writes each sample book's own cover (`/covers/${b.id}.svg` on edition `b.id`).
  const root = fileURLToPath(new URL("../server/", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:ts|mjs|js)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  assert.ok(files.length > 20, "the server's files were found");
  const found: string[] = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/["'`]\/covers\/(?:[a-z0-9-]+|\$\{[^}]*\})\.svg/g)) {
      const where = `${relative(root, path)}: ${match[0]}`;
      if (where === "seed.ts: `/covers/${b.id}.svg") continue;
      found.push(where);
    }
  }
  assert.deepEqual(found, [], "a sample book's cover is a fallback again");
  // The seed's covers are the editions' own: edition id = cover name, and each is a sample book of the rule.
  const shipped = readdirSync(fileURLToPath(new URL("../public/covers/", import.meta.url))).map((name) => name.replace(/\.svg$/, "")).sort();
  assert.deepEqual([...SAMPLE_COVER_BOOKS].sort(), shipped);
  const seed = readFileSync(join(root, "seed.ts"), "utf8");
  assert.match(seed, /id: b\.id,\s*workId: `work-\$\{b\.id\}`,\s*cover: `\/covers\/\$\{b\.id\}\.svg`/);
});

test("no row the server writes holds a sample book's cover for another book", () => {
  const rows = sqlite.prepare("SELECT id,cover FROM audio_editions WHERE id IN ('w-new','w-http') OR work_id IN ('w-new','w-http')").all() as {
    id: string;
    cover: string;
  }[];
  assert.ok(rows.length >= 2);
  for (const row of rows) assert.equal(isSampleCoverOfAnother(row.cover, row.id), false, row.id);
});

test("the generated cover's colour is the work's: the same work always gets the same share", () => {
  assert.equal(coverShare("w-got"), coverShare("w-got"));
  assert.ok((COVER_SHARES as readonly number[]).includes(coverShare("w-dw")));
  assert.ok(new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(coverShare)).size > 1);
});
