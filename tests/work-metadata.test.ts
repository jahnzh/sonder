// The book's Edit page (#719 part a): fields edited by hand win over the stored and catalogue values and over a
// refresh, show as edited, and Revert gives the source's value back; a recording's narrators; series by hand (a local
// series, an AudiobookDB series) on the Book page, the Series pages and the Library's Series chip; the cover by address
// and by upload. On a throwaway database, as the owner (the administrator), Kim (has the book) and Sam (has not).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LibraryWork, WorkMetadata } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-work-metadata-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = "owner-token";
const KIM = "kim-token";
const SAM = "sam-token";
const T0 = Date.UTC(2026, 0, 1);

// Nothing here may reach a provider: every fetch is refused.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("No network in this test.");
}) as typeof fetch;

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
{
  const media = join(process.env.MEDIA_ROOT, "fixture");
  mkdirSync(media, { recursive: true });
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(2,'kim',NULL,'user',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(3,'sam',NULL,'user',?)", T0);
  for (const [token, userId] of [[OWNER, 1], [KIM, 2], [SAM, 3]] as const)
    run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(token), Date.now() + 86_400_000, userId);
  const audio = (workId: string, title: string, author: string, narrator: string) => {
    run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)", workId, title, author, "From the file.", "Science Fiction", 2011);
    run(
      "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,?,?,?,?)",
      `ed-${workId}`, workId, `/covers/${workId}.svg`, narrator, "en", `${title} (Unabridged)`, 0, "Test",
    );
    run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${workId}`, `ed-${workId}`);
    const source = join(media, `${workId}.mp3`);
    writeFileSync(source, "audio");
    run(
      "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,?,?,?,?,?,?)",
      `t-${workId}`, `rec-${workId}`, "Part 1", 0, 600, source, "local", "[]",
    );
  };
  const shelf = (userId: number, workId: string) =>
    run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", userId, `ed-${workId}`, T0);
  audio("w-one", "Leviathan Wakes", "James S. A. Corey", "Jefferson Mays");
  audio("w-two", "Calibans War", "James S. A. Corey", "Jefferson Mays");
  audio("w-other", "Matter", "Iain M. Banks", "Peter Kenny");
  for (const workId of ["w-one", "w-two", "w-other"]) shelf(1, workId);
  shelf(2, "w-one");
  shelf(3, "w-other");
  // An AudiobookDB series the owner saved, read a moment ago (no provider request), listing one other book.
  run("INSERT INTO series_catalogue(id,name,author,book_count) VALUES('abdb-expanse','The Expanse','James S. A. Corey',1)");
  run("INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,position_label) VALUES('abdb-expanse','abdb-b9',NULL,'Abaddons Gate',3,'3')");
  run("INSERT INTO user_saved_series(user_id,series_id,saved_at,refreshed_at) VALUES(1,'abdb-expanse',?,?)", Date.now(), Date.now() + 86_400_000);
}
sqlite.prepare("INSERT INTO settings(key,value) VALUES('migration:hardcover-removed','0')").run();
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
});

type Method = "GET" | "PUT" | "DELETE" | "POST" | "PATCH";
const request = (token: string, url: string, method: Method = "GET", payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: token }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok<T>(token: string, url: string, method: Method = "GET", payload?: unknown): Promise<T> {
  const response = await request(token, url, method, payload);
  assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`);
  return response.json() as T;
}
const work = (token: string, workId: string) => ok<LibraryWork>(token, `/api/works/${workId}`);
const edit = (values: Record<string, unknown>, revert?: string[]) =>
  ok<WorkMetadata>(OWNER, "/api/works/w-one/metadata", "PATCH", { values, ...(revert ? { revert } : {}) });

test("an edited field wins over the stored value, shows as edited, and keeps the source's value beside it", async () => {
  const before = await ok<WorkMetadata>(OWNER, "/api/works/w-one/metadata");
  assert.deepEqual(before.edited, []);
  assert.equal(before.source.title, "Leviathan Wakes");
  assert.deepEqual(before.source.authors, ["James S. A. Corey"]);
  assert.equal(before.source.language, "en");
  const answer = await edit({ title: "Leviathan Wakes: The Expanse", subtitle: "Book one", authors: ["Daniel Abraham", "Ty Franck"], genres: ["Space opera", "Science Fiction"], tags: ["favourite"], publisher: "Orbit", year: 2011, isbn: "978-0-316-12908-4", asin: "b0036s4b5o", abridged: false, explicit: false });
  assert.equal(answer.values.title, "Leviathan Wakes: The Expanse");
  assert.equal(answer.source.title, "Leviathan Wakes");
  assert.equal(answer.values.asin, "B0036S4B5O");
  // The year equals the source's: it is not kept as an edit.
  assert.ok(!answer.edited.includes("year"));
  assert.deepEqual([...answer.edited].sort(), ["abridged", "asin", "authors", "explicit", "genres", "isbn", "publisher", "subtitle", "tags", "title"]);
  const shown = await work(OWNER, "w-one");
  assert.equal(shown.title, "Leviathan Wakes: The Expanse");
  assert.equal(shown.author, "Daniel Abraham, Ty Franck");
  assert.equal(shown.genre, "Space opera, Science Fiction");
  assert.equal(shown.details?.subtitle, "Book one");
  assert.equal(shown.details?.publisher, "Orbit");
  assert.deepEqual(shown.details?.tags, ["favourite"]);
  assert.equal(shown.details?.abridged, false);
  assert.ok(shown.details?.edited.includes("title"));
  const library = await ok<LibraryWork[]>(OWNER, "/api/library");
  assert.equal(library.find((entry) => entry.workId === "w-one")?.title, "Leviathan Wakes: The Expanse");
});

test("a refresh that writes the stored value does not undo an edit; Revert gives the source's (new) value back", async () => {
  await edit({ description: "Written by hand." });
  // What a catalogue refresh or a match does: it writes the work's own row.
  run("UPDATE works SET description='From AudiobookDB.', title='Leviathan Wakes (refreshed)' WHERE id='w-one'");
  let shown = await work(OWNER, "w-one");
  assert.equal(shown.description, "Written by hand.");
  assert.equal(shown.title, "Leviathan Wakes: The Expanse");
  const reverted = await edit({}, ["description", "title"]);
  assert.ok(!reverted.edited.includes("description"));
  assert.ok(!reverted.edited.includes("title"));
  shown = await work(OWNER, "w-one");
  assert.equal(shown.description, "From AudiobookDB.");
  assert.equal(shown.title, "Leviathan Wakes (refreshed)");
  run("UPDATE works SET title='Leviathan Wakes' WHERE id='w-one'");
});

test("a value saved equal to the source's leaves the field not edited", async () => {
  await edit({ publisher: "Orbit" });
  const answer = await edit({ publisher: "" });
  assert.ok(!answer.edited.includes("publisher"));
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM work_metadata_overrides WHERE work_id='w-one' AND field='publisher'").pluck().get(), 0);
});

test("a recording's narrators are edited and reverted on their own", async () => {
  let answer = await ok<WorkMetadata>(OWNER, "/api/recordings/rec-w-one/metadata", "PATCH", { narrators: ["Jefferson Mays", "Someone Else"] });
  assert.deepEqual(answer.recordings[0].narrators, ["Jefferson Mays", "Someone Else"]);
  assert.deepEqual(answer.recordings[0].source, ["Jefferson Mays"]);
  assert.equal(answer.recordings[0].edited, true);
  let shown = await work(KIM, "w-one");
  assert.equal(shown.recordings[0].narrator, "Jefferson Mays, Someone Else");
  assert.equal(shown.recordings[0].narratorsEdited, true);
  answer = await ok<WorkMetadata>(OWNER, "/api/recordings/rec-w-one/metadata", "PATCH", { narrators: null });
  assert.equal(answer.recordings[0].edited, false);
  shown = await work(KIM, "w-one");
  assert.equal(shown.recordings[0].narrator, "Jefferson Mays");
  assert.deepEqual(shown.recordings[0].narrators, ["Jefferson Mays"]);
});

test("a local series by hand: the Book page, the Series page and the Series chip of those who have its books", async () => {
  await edit({ series: [{ id: null, name: "Hand Made", position: 1 }] });
  await ok<WorkMetadata>(OWNER, "/api/works/w-two/metadata", "PATCH", { values: { series: [{ id: null, name: "hand made", position: 2, positionLabel: "2" }] } });
  const one = await work(OWNER, "w-one");
  const two = await work(OWNER, "w-two");
  assert.equal(one.series.length, 1);
  assert.equal(one.series[0].local, true);
  assert.match(one.series[0].id!, /^local-/);
  // The same name (case ignored) is the same local series.
  assert.equal(two.series[0].id, one.series[0].id);
  assert.equal(two.series[0].name, "Hand Made");
  const id = one.series[0].id!;
  const chip = await ok<{ id: string; name: string; total: number }[]>(OWNER, "/api/series");
  const local = chip.find((item) => item.id === id);
  assert.ok(local, JSON.stringify(chip));
  assert.equal(local.total, 2);
  const page = await ok<{ name: string; works: { id: string; workId: string; position: number; added: boolean }[] }>(OWNER, `/api/series/${id}`);
  assert.equal(page.name, "Hand Made");
  assert.deepEqual(page.works.map((entry) => [entry.workId, entry.position, entry.added]), [["w-one", 1, true], ["w-two", 2, true]]);
  // Kim has one of its books: the series with that book; Sam has none: no series, and its page is not found.
  const kim = await ok<{ id: string }[]>(KIM, "/api/series");
  assert.ok(kim.some((item) => item.id === id));
  const kimPage = await ok<{ works: { workId: string }[] }>(KIM, `/api/series/${id}`);
  assert.deepEqual(kimPage.works.map((entry) => entry.workId), ["w-one"]);
  const sam = await ok<{ id: string }[]>(SAM, "/api/series");
  assert.ok(!sam.some((item) => item.id === id));
  assert.notEqual((await request(SAM, `/api/series/${id}`)).statusCode, 200);
});

test("an AudiobookDB series by hand: the work joins the saved series' page and the chip's count at its position", async () => {
  await edit({ series: [{ id: "abdb-expanse", name: "The Expanse", position: 1, positionLabel: "1" }] });
  const one = await work(OWNER, "w-one");
  assert.deepEqual(one.series.map((entry) => [entry.id, entry.position, entry.saved, !!entry.local]), [["abdb-expanse", 1, true, false]]);
  const page = await ok<{ works: { id: string; workId: string | null; position: number | null; added: boolean }[] }>(OWNER, "/api/series/abdb-expanse");
  assert.deepEqual(page.works.map((entry) => [entry.id, entry.position]), [["work:w-one", 1], ["abdb-b9", 3]]);
  assert.equal(page.works[0].added, true);
  const chip = await ok<{ id: string; total: number }[]>(OWNER, "/api/series");
  assert.equal(chip.find((item) => item.id === "abdb-expanse")?.total, 2);
  // Reverting the series gives the catalogue's back: none for this work.
  await edit({}, ["series"]);
  assert.deepEqual((await work(OWNER, "w-one")).series, []);
});

test("the cover by address and by upload; an address that is not https is refused", async () => {
  let answer = await edit({ cover: "https://covers.example/leviathan.jpg" });
  assert.equal(answer.values.cover, "https://covers.example/leviathan.jpg");
  assert.equal((await work(KIM, "w-one")).cover, "https://covers.example/leviathan.jpg");
  const refused = await request(OWNER, "/api/works/w-one/metadata", "PATCH", { values: { cover: "http://covers.example/x.jpg" } });
  assert.equal(refused.statusCode, 400);
  const boundary = "----sonder-cover";
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const upload = await app.inject({ method: "POST", url: "/api/works/w-one/cover", cookies: { sonder_session: OWNER }, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(upload.statusCode, 200, upload.body);
  answer = upload.json() as WorkMetadata;
  assert.match(answer.values.cover, /^\/api\/covers\/[a-f0-9]{32}\.png$/);
  const served = await request(KIM, answer.values.cover);
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers["content-type"], "image/png");
  assert.deepEqual(served.rawPayload, png);
  const kimUpload = await app.inject({ method: "POST", url: "/api/works/w-one/cover", cookies: { sonder_session: KIM }, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(kimUpload.statusCode, 403);
  answer = await edit({}, ["cover"]);
  assert.equal(answer.values.cover, "/covers/w-one.svg");
});

test("another account cannot edit (403) and sees the edited values", async () => {
  await edit({ title: "Edited by the owner", authors: ["Owner's Author"] });
  for (const [method, url, payload] of [
    ["GET", "/api/works/w-one/metadata", undefined],
    ["PATCH", "/api/works/w-one/metadata", { values: { title: "Kim's" } }],
    ["PATCH", "/api/works/w-one/metadata", { revert: ["title"] }],
    ["PATCH", "/api/recordings/rec-w-one/metadata", { narrators: ["Kim"] }],
  ] as const) {
    const response = await request(KIM, url, method, payload);
    assert.equal(response.statusCode, 403, `${method} ${url}`);
  }
  const shown = await work(KIM, "w-one");
  assert.equal(shown.title, "Edited by the owner");
  assert.equal(shown.author, "Owner's Author");
  const library = await ok<LibraryWork[]>(KIM, "/api/library");
  assert.equal(library.find((entry) => entry.workId === "w-one")?.title, "Edited by the owner");
  // Discover's read of the server finds the book by its edited title.
  const found = await ok<{ works: { workId: string; title: string }[] }>(KIM, "/api/works?q=edited%20owner");
  assert.deepEqual(found.works.map((entry) => [entry.workId, entry.title]), [["w-one", "Edited by the owner"]]);
  // Nothing Kim cannot see is answered: Sam's book is not a work Kim reads through the edit routes either.
  assert.equal((await request(KIM, "/api/works/w-other/metadata")).statusCode, 403);
  await edit({}, ["title", "authors"]);
});

test("GET /api/books stays as it was: the edits are read through the library by work", async () => {
  await edit({ title: "Not in the old list" });
  const books = await ok<{ workId: string; title: string }[]>(OWNER, "/api/books");
  assert.equal(books.find((book) => book.workId === "w-one")?.title, "Leviathan Wakes");
  await edit({}, ["title"]);
});

test("an older client's empty PATCH changes nothing; unknown fields and bad values are refused", async () => {
  const before = await ok<WorkMetadata>(OWNER, "/api/works/w-one/metadata");
  const empty = await ok<WorkMetadata>(OWNER, "/api/works/w-one/metadata", "PATCH", {});
  assert.deepEqual(empty, before);
  assert.equal((await request(OWNER, "/api/works/w-one/metadata", "PATCH", { values: { rating: 5 } })).statusCode, 400);
  assert.equal((await request(OWNER, "/api/works/w-one/metadata", "PATCH", { values: { title: "" } })).statusCode, 400);
  assert.equal((await request(OWNER, "/api/works/w-one/metadata", "PATCH", { values: { asin: "short" } })).statusCode, 400);
  assert.equal((await request(OWNER, "/api/works/nope/metadata")).statusCode, 404);
});
