// The one-off start step (#555; #467 decision 6): at server start, once, every work with an ebook
// edition outside the administrator's library joins it through its placeholder, unless he hid that
// placeholder; a recording he removed stays hidden. Production's case is Capitalist Realism: the PDF's
// work `work-hc-482313` has the placeholder `hc-482313` and the recording `torbox-128967368`, which the
// owner removed. A throwaway database, started twice; read as the owner and as Sam (a user).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-shelf-join-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = 1;
const SAM = 2;
const TOKENS: Record<number, string> = { [OWNER]: "owner-token", [SAM]: "sam-token" };
const T0 = Date.UTC(2026, 0, 1);

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
const rows = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...args);
for (const [id, name, role] of [[OWNER, "admin", "admin"], [SAM, "sam", "user"]] as const) {
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(?,?,NULL,?,?)", id, name, role, T0);
  run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(TOKENS[id]), Date.now() + 86_400_000, id);
}
const work = (id: string, title: string) =>
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'An Author','About it.','Fiction',2009)", id, title);
const edition = (workId: string, editionId: string, tracks: boolean) => {
  run(
    "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,'/covers/meditations.svg',?,NULL,NULL,0,'Test source')",
    editionId,
    workId,
    tracks ? "A Narrator" : "Audio not added",
  );
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `recording-${editionId}`, editionId);
  if (tracks)
    run(
      "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,'Part 1',0,600,'https://audio.example/a.mp3','remote','[]')",
      `t-${editionId}`,
      `recording-${editionId}`,
    );
};
const ebook = (id: string, workId: string, format = "pdf") =>
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,?,?)", id, workId, format, `/books/${id}.${format}`);

// Capitalist Realism, as on production.
work("work-hc-482313", "Capitalist Realism");
run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('work-hc-482313',482313,'capitalist-realism','[]')");
edition("work-hc-482313", "hc-482313", false);
edition("work-hc-482313", "torbox-128967368", true);
run("INSERT INTO user_hidden_library(user_id,book_id) VALUES(?,'torbox-128967368')", OWNER);
run("INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(?,'recording-torbox-128967368','t-torbox-128967368',120,600,?)", OWNER, T0);
ebook("upload-capitalist", "work-hc-482313");
// An ebook-only work with no audio edition, outside the library: joins through placeholder-<workId>.
work("w-shelf", "On the Shelf");
ebook("upload-shelf", "w-shelf", "epub");
// An ebook whose work's placeholder the owner hid (he removed the book): stays out.
work("w-gone", "Removed Book");
edition("w-gone", "hc-777", false);
run("INSERT INTO user_hidden_library(user_id,book_id) VALUES(?,'hc-777')", OWNER);
ebook("upload-gone", "w-gone", "epub");
// Only an ebook set's consensus text: not an ebook edition of the shelf.
work("w-consensus", "Consensus Only");
ebook("set-consensus:w-consensus", "w-consensus", "epub");
// An ebook whose work is in the library already: unchanged.
work("w-in", "Already In");
edition("w-in", "ed-in", true);
run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,'ed-in','listening',?)", OWNER, T0);
ebook("upload-in", "w-in", "epub");

const { createApp } = await import("../server/app.ts");
const { joinShelfEbooksOnce } = await import("../server/work-library.ts");
const libraryRows = (userId: number, workId: string) =>
  rows(
    "SELECT u.book_id AS id,u.status FROM user_library u JOIN audio_editions e ON e.id=u.book_id WHERE u.user_id=? AND e.work_id=? ORDER BY u.book_id",
    userId,
    workId,
  ) as { id: string; status: string }[];
const editionIds = (workId: string) =>
  (rows("SELECT id FROM audio_editions WHERE work_id=? ORDER BY rowid", workId) as { id: string }[]).map((row) => row.id);
const hidden = (userId: number) =>
  (rows("SELECT book_id AS id FROM user_hidden_library WHERE user_id=? ORDER BY book_id", userId) as { id: string }[]).map((row) => row.id);
const userState = (userId: number) =>
  Object.fromEntries(
    ["user_library", "user_hidden_library", "user_work_library_origin", "user_hardcover_outbox", "user_progress", "user_settings"].map(
      (table) => [table, rows(`SELECT * FROM ${table} WHERE user_id=? ORDER BY 1,2`, userId)],
    ),
  );
const samBefore = userState(SAM);
const editionsBefore = rows("SELECT id FROM audio_editions ORDER BY id");

const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
  sqlite.close();
});
const as = (userId: number) => ({ sonder_session: TOKENS[userId] });

test("the start step joins Capitalist Realism through hc-482313; the removed recording stays hidden", async () => {
  assert.deepEqual(libraryRows(OWNER, "work-hc-482313"), [{ id: "hc-482313", status: "unread" }]);
  assert.deepEqual(editionIds("work-hc-482313"), ["hc-482313", "torbox-128967368"], "no second placeholder");
  assert.ok(hidden(OWNER).includes("torbox-128967368"));
  assert.equal(
    sqlite.prepare("SELECT position FROM user_progress WHERE user_id=? AND recording_id='recording-torbox-128967368'").pluck().get(OWNER),
    120,
    "the place in the removed recording is kept",
  );
  assert.equal(
    sqlite.prepare("SELECT source FROM user_work_library_origin WHERE user_id=? AND work_id='work-hc-482313'").pluck().get(OWNER),
    "manual",
  );
  assert.deepEqual(rows("SELECT * FROM user_hardcover_outbox"), [], "Hardcover is told nothing");
  // Today's Library lists it through GET /api/books; the read by work lists no recording for it.
  const books = await app.inject({ url: "/api/books", cookies: as(OWNER) });
  assert.equal(books.statusCode, 200, books.body);
  const ids = (books.json() as { id: string }[]).map((book) => book.id);
  assert.ok(ids.includes("hc-482313"));
  const read = await app.inject({ url: "/api/works/work-hc-482313", cookies: as(OWNER) });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().inLibrary, true);
  assert.deepEqual(read.json().recordings, []);
});

test("the start step joins an ebook-only work through placeholder-<workId> and leaves the rest", () => {
  assert.deepEqual(editionIds("w-shelf"), ["placeholder-w-shelf"]);
  assert.deepEqual(libraryRows(OWNER, "w-shelf"), [{ id: "placeholder-w-shelf", status: "unread" }]);
  assert.deepEqual(libraryRows(OWNER, "w-gone"), [], "a placeholder he hid stays out");
  assert.deepEqual(editionIds("w-gone"), ["hc-777"]);
  assert.deepEqual(editionIds("w-consensus"), [], "a consensus text is not a shelf ebook");
  assert.deepEqual(libraryRows(OWNER, "w-in"), [{ id: "ed-in", status: "listening" }]);
  assert.deepEqual(editionIds("w-in"), ["ed-in"]);
  assert.ok(sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='shelfEbooksJoined'").pluck().get(OWNER));
});

test("other users are left alone and do not see the owner's placeholders", async () => {
  assert.deepEqual(userState(SAM), samBefore);
  const books = await app.inject({ url: "/api/books", cookies: as(SAM) });
  assert.equal(books.statusCode, 200, books.body);
  const ids = (books.json() as { id: string }[]).map((book) => book.id);
  for (const id of ["hc-482313", "placeholder-w-shelf", "hc-777"]) assert.ok(!ids.includes(id), id);
  const library = await app.inject({ url: "/api/library", cookies: as(SAM) });
  assert.deepEqual((library.json() as { workId: string }[]).map((entry) => entry.workId), []);
});

test("a second start adds nothing", async () => {
  // A new shelf ebook outside the library after the step ran, and the owner removes Capitalist Realism.
  work("w-later", "Later");
  ebook("upload-later", "w-later", "epub");
  const removed = await app.inject({ method: "DELETE", url: "/api/works/work-hc-482313/library", cookies: as(OWNER) });
  assert.equal(removed.statusCode, 200, removed.body);
  const owner = userState(OWNER);
  const editions = rows("SELECT id FROM audio_editions ORDER BY id");
  const again = await createApp({ background: { manual: true } });
  try {
    assert.deepEqual(userState(OWNER), owner);
    assert.deepEqual(rows("SELECT id FROM audio_editions ORDER BY id"), editions);
    assert.deepEqual(joinShelfEbooksOnce(), []);
  } finally {
    await again.close();
  }
  assert.deepEqual(libraryRows(OWNER, "w-later"), []);
  assert.deepEqual(libraryRows(OWNER, "work-hc-482313"), []);
  // The first start made exactly one edition: w-shelf's placeholder.
  assert.deepEqual(
    (editions as { id: string }[]).map((row) => row.id).filter((id) => !(editionsBefore as { id: string }[]).some((row) => row.id === id)),
    ["placeholder-w-shelf"],
  );
});
