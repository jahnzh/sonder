// Sonder's own Want to read (#721 part c1): `PUT` and `DELETE /api/works/<workId>/want-to-read`, the `wantToRead`
// of `GET /api/library`, `GET /api/works/<workId>` and `GET /api/works`, and the one-time copy of Hardcover's Want
// to read shelf (`copyHardcoverWantToRead`, `POST` and `GET /api/want-to-read/hardcover-copy`), on a throwaway
// database, read as the owner (the administrator), Sam and Kim (two users who are not).
//
// Works:
// - w-audio "Matter": a recording with a file, in nobody's library.
// - w-kept "Excession": a recording, in the owner's and Kim's library.
// - w-ebook "Inversions": an EPUB only, no audio edition.
// - w-sam "Feersum Endjinn": only a placeholder, in Sam's library (hidden from Kim); Hardcover 2002.
// - w-hc-a, w-hc-b, w-hc-c, w-hc-d: placeholders matched to Hardcover 3001, 3004, 3005 and 3007, in no library.
// Hardcover's stored shelf rows, the owner's: 3001 Want to read; 3002 Read (no work); 3003 Want to read (no work);
// 3004 Currently reading with Want to read queued; 3005 Want to read with Read queued; 3006 Want to read queued only
// (no work); 3007 only on one of his Hardcover lists. Sam's: 3001 Want to read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LibraryWork, WorkResult } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-want-to-read-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = "owner-token";
const SAM = "sam-token";
const KIM = "kim-token";
const T0 = Date.UTC(2026, 0, 1);

// Nothing here may reach Hardcover (or anything else): every fetch is counted and refused.
const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("No network in this test.");
}) as typeof fetch;

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
{
  const media = join(process.env.MEDIA_ROOT, "fixture");
  mkdirSync(media, { recursive: true });
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(2,'sam',NULL,'user',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(3,'kim',NULL,'user',?)", T0);
  for (const [token, userId] of [[OWNER, 1], [SAM, 2], [KIM, 3]] as const)
    run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(token), Date.now() + 86_400_000, userId);
  const work = (id: string, title: string, author: string) =>
    run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)", id, title, author, "", "Fiction", 2000);
  const edition = (id: string, workId: string) =>
    run(
      "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,?,?,?,?)",
      id,
      workId,
      `/covers/${id}.jpg`,
      "Narrator",
      "en",
      null,
      0,
      "Test",
    );
  const audio = (editionId: string, workId: string) => {
    edition(editionId, workId);
    run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${editionId}`, editionId);
    const source = join(media, `${editionId}.mp3`);
    writeFileSync(source, "audio");
    run(
      "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,?,?,?,?,?,?)",
      `t-${editionId}`,
      `rec-${editionId}`,
      "Part 1",
      0,
      600,
      source,
      "local",
      "[]",
    );
  };
  const placeholder = (editionId: string, workId: string) => {
    edition(editionId, workId);
    run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `recording-${editionId}`, editionId);
  };
  const shelf = (userId: number, editionId: string) =>
    run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", userId, editionId, T0);
  const link = (workId: string, bookId: number) =>
    run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES(?,?,?,'[]')", workId, bookId, `book-${bookId}`);

  work("w-audio", "Matter", "Iain M. Banks");
  audio("ed-audio", "w-audio");
  work("w-kept", "Excession", "Iain M. Banks");
  audio("ed-kept", "w-kept");
  shelf(1, "ed-kept");
  shelf(3, "ed-kept");
  work("w-ebook", "Inversions", "Iain M. Banks");
  const epub = join(media, "inversions.epub");
  writeFileSync(epub, "epub");
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,?,?)", "eb-inversions", "w-ebook", "epub", epub);
  work("w-sam", "Feersum Endjinn", "Iain M. Banks");
  placeholder("hc-2002", "w-sam");
  link("w-sam", 2002);
  shelf(2, "hc-2002");
  for (const [workId, bookId] of [["w-hc-a", 3001], ["w-hc-b", 3004], ["w-hc-c", 3005], ["w-hc-d", 3007]] as const) {
    work(workId, `Shelf book ${bookId}`, "Shelf Author");
    placeholder(`hc-${bookId}`, workId);
    link(workId, bookId);
  }
  const hardcoverShelf = (userId: number, bookId: number, statusId: number) =>
    run("INSERT INTO user_hardcover_links(user_id,book_id,user_book_id,status_id) VALUES(?,?,?,?)", userId, bookId, bookId + 100000, statusId);
  const queued = (userId: number, bookId: number, statusId: number) =>
    run(
      "INSERT INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,intent,updated_at) VALUES(?,?,77,?,'status',?)",
      userId,
      bookId,
      statusId,
      T0,
    );
  hardcoverShelf(1, 3001, 1);
  hardcoverShelf(1, 3002, 3);
  hardcoverShelf(1, 3003, 1);
  hardcoverShelf(1, 3004, 2);
  queued(1, 3004, 1);
  hardcoverShelf(1, 3005, 1);
  queued(1, 3005, 3);
  queued(1, 3006, 1);
  run(
    "INSERT INTO user_hardcover_lists(user_id,id,account_id,name,slug,members,synced_at) VALUES(1,55,77,'Summer','summer',?,?)",
    JSON.stringify([{ bookId: 3007 }]),
    T0,
  );
  hardcoverShelf(2, 3001, 1);
}
sqlite.prepare("INSERT INTO user_settings(user_id,key,value) VALUES(1,'shelfEbooksJoined','1')").run();
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });

after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
});

type Method = "GET" | "PUT" | "DELETE" | "POST";
const request = (token: string, url: string, method: Method = "GET", payload?: unknown) =>
  payload === undefined
    ? app.inject({ method, url, cookies: { sonder_session: token } })
    : app.inject({ method, url, cookies: { sonder_session: token }, payload: payload as Record<string, unknown> });
const want = (token: string, workId: string, on: boolean, payload?: unknown) =>
  request(token, `/api/works/${encodeURIComponent(workId)}/want-to-read`, on ? "PUT" : "DELETE", payload);
async function library(token: string) {
  const response = await request(token, "/api/library");
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LibraryWork[];
}
async function oneWork(token: string, workId: string) {
  const response = await request(token, `/api/works/${encodeURIComponent(workId)}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LibraryWork;
}
async function found(token: string, q: string) {
  const response = await request(token, `/api/works?q=${encodeURIComponent(q)}`);
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { works: WorkResult[] }).works;
}
const wanted = async (token: string) => (await library(token)).filter((w) => w.wantToRead).map((w) => w.workId).sort();
const rows = (userId: number, workId: string) =>
  sqlite.prepare("SELECT source FROM user_want_to_read WHERE user_id=? AND work_id=?").all(userId, workId) as { source: string }[];

test("Want to read on a book outside the library adds it to the library and marks it, for that user only", async () => {
  assert.equal((await oneWork(OWNER, "w-audio")).inLibrary, false);
  const put = await want(OWNER, "w-audio", true);
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json(), { ok: true, workId: "w-audio" });
  const work = await oneWork(OWNER, "w-audio");
  assert.equal(work.inLibrary, true);
  assert.equal(work.wantToRead, true);
  assert.deepEqual(await wanted(OWNER), ["w-audio"]);
  assert.equal((await found(OWNER, "matter")).find((w) => w.workId === "w-audio")?.wantToRead, true);
  assert.deepEqual(rows(1, "w-audio"), [{ source: "manual" }]);
  // Its library origin is that of Add to library.
  assert.equal(
    sqlite.prepare("SELECT source FROM user_work_library_origin WHERE user_id=1 AND work_id='w-audio'").pluck().get(),
    "manual",
  );
  // A second PUT changes nothing.
  assert.equal((await want(OWNER, "w-audio", true)).statusCode, 200);
  assert.deepEqual(await wanted(OWNER), ["w-audio"]);
  // The second user: nothing of the owner's list shows, in the library read, the one-work read or Discover's.
  assert.deepEqual(await wanted(KIM), []);
  const kims = await oneWork(KIM, "w-audio");
  assert.equal(kims.wantToRead, false);
  assert.equal(kims.inLibrary, false);
  assert.equal((await found(KIM, "matter")).find((w) => w.workId === "w-audio")?.wantToRead, false);
});

test("a book without media joins the library through its placeholder", async () => {
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM audio_editions WHERE work_id='w-ebook'").pluck().get(), 0);
  const put = await want(SAM, "w-ebook", true);
  assert.equal(put.statusCode, 200, put.body);
  const placeholder = sqlite.prepare("SELECT id FROM audio_editions WHERE work_id='w-ebook'").pluck().all() as string[];
  assert.equal(placeholder.length, 1);
  assert.deepEqual(
    sqlite.prepare("SELECT book_id FROM user_library WHERE user_id=2 AND book_id=?").pluck().all(placeholder[0]),
    placeholder,
  );
  const work = await oneWork(SAM, "w-ebook");
  assert.equal(work.inLibrary, true);
  assert.equal(work.wantToRead, true);
  assert.deepEqual(work.recordings, []);
  // Kim sees the work (it has an ebook) but not Sam's mark.
  assert.equal((await oneWork(KIM, "w-ebook")).wantToRead, false);
  assert.equal((await oneWork(KIM, "w-ebook")).inLibrary, false);
});

test("taking a book off Want to read leaves it in the library; an empty JSON body is accepted", async () => {
  assert.equal((await want(OWNER, "w-kept", true, {})).statusCode, 200);
  assert.equal((await oneWork(OWNER, "w-kept")).wantToRead, true);
  const off = await want(OWNER, "w-kept", false, {});
  assert.equal(off.statusCode, 200, off.body);
  assert.deepEqual(off.json(), { ok: true });
  const work = await oneWork(OWNER, "w-kept");
  assert.equal(work.wantToRead, false);
  assert.equal(work.inLibrary, true);
  // Off again is no error.
  assert.equal((await want(OWNER, "w-kept", false)).statusCode, 200);
});

test("a book that leaves the library leaves Want to read; added again it is not on it", async () => {
  assert.equal((await want(KIM, "w-kept", true)).statusCode, 200);
  assert.equal((await oneWork(KIM, "w-kept")).wantToRead, true);
  assert.equal((await request(KIM, "/api/works/w-kept/library", "DELETE")).statusCode, 200);
  assert.deepEqual(rows(3, "w-kept"), []);
  assert.equal((await request(KIM, "/api/works/w-kept/library", "PUT")).statusCode, 200);
  assert.equal((await oneWork(KIM, "w-kept")).wantToRead, false);
  // The owner's own row of the same work is untouched by Kim's removal.
  assert.equal((await oneWork(OWNER, "w-kept")).inLibrary, true);
});

test("a mark left on a work outside the library (written by an earlier build or by hand) does not count", async () => {
  run("INSERT INTO user_want_to_read(user_id,work_id,source,added_at) VALUES(3,'w-audio','manual',?)", T0);
  const work = await oneWork(KIM, "w-audio");
  assert.equal(work.inLibrary, false);
  assert.equal(work.wantToRead, false);
  assert.equal((await found(KIM, "matter")).find((w) => w.workId === "w-audio")?.wantToRead, false);
  run("DELETE FROM user_want_to_read WHERE user_id=3 AND work_id='w-audio'");
});

test("a work the user may not see answers 404, and so does a Hardcover book without Hardcover connected", async () => {
  // Sam's placeholder-only work is hidden from Kim.
  assert.equal((await want(KIM, "w-sam", true)).statusCode, 404);
  assert.equal((await want(KIM, "w-sam", false)).statusCode, 404);
  assert.deepEqual(rows(3, "w-sam"), []);
  assert.equal((await want(KIM, "no-such-work", true)).statusCode, 404);
  assert.equal((await want(KIM, "work-hc-999999", true)).statusCode, 404);
  // Sam's own works answer.
  assert.equal((await want(SAM, "w-sam", true)).statusCode, 200);
  assert.equal((await oneWork(SAM, "w-sam")).wantToRead, true);
  assert.equal(fetches, 0);
});

test("GET /api/books does not change when a book in the library goes on Want to read", async () => {
  const before = (await request(OWNER, "/api/books")).body;
  assert.equal((await want(OWNER, "w-kept", true)).statusCode, 200);
  assert.equal((await request(OWNER, "/api/books")).body, before);
  assert.equal((await want(OWNER, "w-kept", false)).statusCode, 200);
  assert.equal((await request(OWNER, "/api/books")).body, before);
});

test("the copy of Hardcover's Want to read shelf is the administrator's action, and only answers him his own books", async () => {
  assert.equal((await request(SAM, "/api/want-to-read/hardcover-copy", "POST", {})).statusCode, 403);
  assert.deepEqual((await request(OWNER, "/api/want-to-read/hardcover-copy")).json(), { copy: null });
  const outbox = sqlite.prepare("SELECT COUNT(*) FROM user_hardcover_outbox").pluck().get();
  const response = await request(OWNER, "/api/want-to-read/hardcover-copy", "POST");
  assert.equal(response.statusCode, 200, response.body);
  const { results } = response.json() as { results: Record<string, unknown>[] };
  assert.deepEqual(results.map((r) => r.userId), [1, 2, 3]);
  const mine = results[0] as { userId: number; ran: boolean; added: string[]; already: string[]; unmatched: { bookId: number }[]; copiedAt: number };
  assert.equal(mine.ran, true);
  // 3001 Want to read and 3004 with Want to read queued are copied; 3005 (Read queued), 3002 (Read) and the list's
  // 3007 are not; 3003 and 3006 have no work and are listed.
  assert.deepEqual(mine.added, ["w-hc-a", "w-hc-b"]);
  assert.deepEqual(mine.already, []);
  assert.deepEqual(mine.unmatched, [{ bookId: 3003 }, { bookId: 3006 }]);
  // Another user's entry says only whether it ran.
  assert.deepEqual(results[1], { userId: 2, ran: true });
  assert.deepEqual(results[2], { userId: 3, ran: true });
  assert.deepEqual(await wanted(OWNER), ["w-audio", "w-hc-a", "w-hc-b"]);
  assert.deepEqual(rows(1, "w-hc-a"), [{ source: "hardcover" }]);
  assert.equal((await oneWork(OWNER, "w-hc-c")).inLibrary, false);
  assert.equal((await oneWork(OWNER, "w-hc-d")).inLibrary, false);
  // Sam's own shelf row: 3001 joined his library and his Want to read; Kim had no shelf.
  assert.deepEqual(await wanted(SAM), ["w-ebook", "w-hc-a", "w-sam"]);
  assert.deepEqual(await wanted(KIM), []);
  // Each user reads their own result, and nothing of another's.
  const sams = (await request(SAM, "/api/want-to-read/hardcover-copy")).json() as { copy: { added: string[]; unmatched: unknown[] } };
  assert.deepEqual(sams.copy.added, ["w-hc-a"]);
  assert.deepEqual(sams.copy.unmatched, []);
  const kims = (await request(KIM, "/api/want-to-read/hardcover-copy")).json() as { copy: { added: string[]; unmatched: unknown[] } };
  assert.deepEqual(kims.copy.added, []);
  // Hardcover was neither called nor told anything.
  assert.equal(fetches, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM user_hardcover_outbox").pluck().get(), outbox);
});

test("the copy runs once per user: a second run changes nothing and answers the first result", async () => {
  // The owner takes a copied book off; a second run does not put it back.
  assert.equal((await want(OWNER, "w-hc-a", false)).statusCode, 200);
  const again = await request(OWNER, "/api/want-to-read/hardcover-copy", "POST", { userId: 1 });
  assert.equal(again.statusCode, 200, again.body);
  const [mine] = (again.json() as { results: { ran: boolean; added: string[] }[] }).results;
  assert.equal(mine.ran, false);
  assert.deepEqual(mine.added, ["w-hc-a", "w-hc-b"]);
  assert.deepEqual(await wanted(OWNER), ["w-audio", "w-hc-b"]);
  assert.equal((await request(OWNER, "/api/want-to-read/hardcover-copy", "POST", { userId: 99 })).statusCode, 404);
});

test("the copy lists a book already on Want to read as already there", async () => {
  const { copyHardcoverWantToRead, HARDCOVER_COPY_SETTING } = await import("../server/want-to-read.ts");
  run("DELETE FROM user_settings WHERE user_id=2 AND key=?", HARDCOVER_COPY_SETTING);
  const result = copyHardcoverWantToRead(2);
  assert.equal(result.ran, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.already, ["w-hc-a"]);
});

test("a deleted user's Want to read goes with them", async () => {
  const { USER_DATA_TABLES } = await import("../server/users.ts");
  assert.ok((USER_DATA_TABLES as readonly string[]).includes("user_want_to_read"));
});
