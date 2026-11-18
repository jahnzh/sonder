// A Hardcover book that is not on the server (#574, ADR 0022): `GET /api/works/work-hc-<n>` answers it from
// Hardcover without writing anything, and `PUT /api/works/work-hc-<n>/library` makes it through today's Hardcover
// import first, then adds it and answers `workId`. On a throwaway database with the Hardcover fixture of the browser
// suite (`tests/hardcover-browser-fixture.ts`), read as the owner (the administrator), Sam (connected to Hardcover,
// not the administrator) and Kim (not connected).
//
// The fixture's books used here (none is on the server at the start; no sync runs):
// - 501 "Alice’s Adventures in Wonderland" (Lewis Carroll), in series 701 "The Crossing" at 1: looked at.
// - 502 "The Quiet Shelf": matched meanwhile to the local work w-quiet.
// - 503 "Crossing Two" (Ada North): added by the owner, then by Sam.
// - 504 "Crossing Companion" (Ada North): the owner's add matches the local work w-companion by title and author.
// - 505 "Future Crossing": two adds at once.
// - 999 is not a book Hardcover knows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { LibraryWork } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";
import { installHardcoverFixture } from "./hardcover-browser-fixture.ts";

const temp = tempDir("sonder-hardcover-look-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = "owner-token";
const SAM = "sam-token";
const KIM = "kim-token";
const T0 = Date.UTC(2026, 0, 1);

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const { hardcoverLooks } = await import("../server/hardcover.ts");
{
  const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(2,'sam',NULL,'user',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(3,'kim',NULL,'user',?)", T0);
  for (const [token, userId] of [[OWNER, 1], [SAM, 2], [KIM, 3]] as const)
    run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(token), Date.now() + 86_400_000, userId);
  const work = (id: string, title: string, author: string) =>
    run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)", id, title, author, "", "Fiction", 2001);
  work("w-companion", "Crossing Companion", "Ada North");
  work("w-other", "Something Else", "Someone");
}
sqlite.prepare("INSERT INTO user_settings(user_id,key,value) VALUES(1,'shelfEbooksJoined','1')").run();

installHardcoverFixture();
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });

after(async () => {
  await app.close();
  sqlite.close();
});

const request = (token: string, url: string, method: "GET" | "PUT" | "DELETE" = "GET", payload?: Record<string, unknown>) =>
  payload === undefined
    ? app.inject({ method, url, cookies: { sonder_session: token } })
    : app.inject({ method, url, cookies: { sonder_session: token }, payload });

for (const token of [OWNER, SAM])
  assert.equal((await request(token, "/api/hardcover/token", "PUT", { token: `hc-${token}` })).statusCode, 200);

/** Every table's row count. */
function rowCounts() {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all() as string[];
  return Object.fromEntries(tables.map((name) => [name, sqlite.prepare(`SELECT COUNT(*) FROM "${name}"`).pluck().get()]));
}
const workRows = (like: string) => sqlite.prepare("SELECT id FROM works WHERE id LIKE ? ORDER BY id").pluck().all(like) as string[];
const libraryIds = async (token: string) => {
  const response = await request(token, "/api/library");
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as LibraryWork[]).map((work) => work.workId);
};
// A look is answered from Hardcover each time here, so a change of the fixture's answer would show.
hardcoverLooks.ttlMs = 0;

test("an unknown work-hc-<n> answers Hardcover's book, not in the library, and writes nothing", async () => {
  const before = rowCounts();
  const response = await request(OWNER, "/api/works/work-hc-501");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    workId: "work-hc-501",
    title: "Alice’s Adventures in Wonderland",
    author: "Lewis Carroll",
    description: "A story from your Hardcover reading shelf.",
    genre: "From Hardcover",
    year: 2020,
    cover: "",
    inLibrary: false,
    addedAt: null,
    finished: false,
    completionOverride: null,
    chosenRecordingId: null,
    recordings: [],
    chosenEbookId: null,
    ebooks: [],
    readingSync: [],
    series: [{ id: 701, name: "The Crossing", position: 1, saved: false }],
    mediaState: { state: "missing", holdReason: null, acquisition: null },
    hardcover: {
      id: 501,
      slug: "alice’s-adventures-in-wonderland",
      series: [{ id: 701, name: "The Crossing", position: 1 }],
      statusId: null,
      pending: false,
      progressFraction: null,
      progressPending: false,
      syncError: null,
      listIds: [],
    },
  } satisfies LibraryWork);
  // Sam reads the same book the same way.
  assert.equal((await request(SAM, "/api/works/work-hc-501")).json().workId, "work-hc-501");
  assert.deepEqual(rowCounts(), before, "every table's row count is unchanged");
  assert.deepEqual(workRows("work-hc-%"), []);
});

test("a work matched to the book meanwhile answers as itself", async () => {
  sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-quiet','The Quiet Shelf','Nora Reader','','Fiction',2020)").run();
  sqlite.prepare("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-quiet',502,'the-quiet-shelf','[]')").run();
  for (const token of [OWNER, SAM, KIM]) {
    const response = await request(token, "/api/works/work-hc-502");
    assert.equal(response.statusCode, 200, response.body);
    const work = response.json() as LibraryWork;
    assert.equal(work.workId, "w-quiet");
    assert.equal(work.hardcover?.id, 502);
  }
  // Add to library on the old address adds that work. Kim is not connected to Hardcover: the matched work is added
  // without asking Hardcover.
  const kim = await request(KIM, "/api/works/work-hc-502/library", "PUT");
  assert.equal(kim.statusCode, 200, kim.body);
  assert.deepEqual(kim.json(), { ok: true, workId: "w-quiet" });
  const added = await request(SAM, "/api/works/work-hc-502/library", "PUT");
  assert.equal(added.statusCode, 200, added.body);
  assert.deepEqual(added.json(), { ok: true, workId: "w-quiet" });
  assert.ok((await libraryIds(SAM)).includes("w-quiet"));
  assert.deepEqual(workRows("work-hc-%"), []);
});

test("without Hardcover connected, for a book Hardcover does not know, or for another id: 404, and nothing written", async () => {
  const before = rowCounts();
  for (const [token, url] of [
    [KIM, "/api/works/work-hc-501"],
    [OWNER, "/api/works/work-hc-999"],
    [OWNER, "/api/works/work-hc-0"],
    [OWNER, "/api/works/work-hc-501x"],
    [OWNER, "/api/works/no-such-work"],
  ] as const) {
    const response = await request(token, url);
    assert.equal(response.statusCode, 404, `${url}: ${response.body}`);
    assert.deepEqual(response.json(), { error: "This book could not be found." });
    const put = await request(token, `${url}/library`, "PUT");
    assert.equal(put.statusCode, 404, `PUT ${url}: ${put.body}`);
  }
  assert.deepEqual(rowCounts(), before);
});

test("Add to library makes the work through the Hardcover import, adds it and answers workId", async () => {
  const response = await request(OWNER, "/api/works/work-hc-503/library", "PUT");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, workId: "work-hc-503" });
  assert.deepEqual(workRows("work-hc-%"), ["work-hc-503"]);
  assert.ok((await libraryIds(OWNER)).includes("work-hc-503"));
  const work = (await request(OWNER, "/api/works/work-hc-503")).json() as LibraryWork;
  assert.deepEqual([work.title, work.author, work.inLibrary, work.hardcover?.id], ["Crossing Two", "Ada North", true, 503]);
  // Sam is not told the owner has it: the owner's placeholder is hidden from Sam, who reads Hardcover's book.
  const sam = (await request(SAM, "/api/works/work-hc-503")).json() as LibraryWork;
  assert.deepEqual([sam.workId, sam.inLibrary, sam.addedAt, sam.mediaState?.state], ["work-hc-503", false, null, "missing"]);
  assert.ok(!(await libraryIds(SAM)).includes("work-hc-503"));
  // Sam's add joins the same work; the owner's library is unchanged.
  const samAdd = await request(SAM, "/api/works/work-hc-503/library", "PUT");
  assert.deepEqual(samAdd.json(), { ok: true, workId: "work-hc-503" });
  assert.deepEqual(workRows("work-hc-%"), ["work-hc-503"]);
  assert.ok((await libraryIds(SAM)).includes("work-hc-503"));
  assert.equal(((await request(SAM, "/api/works/work-hc-503")).json() as LibraryWork).inLibrary, true);
  // Kim, not connected, still may not see it.
  assert.equal((await request(KIM, "/api/works/work-hc-503")).statusCode, 404);
});

test("the administrator's add matches the book to an existing work by title and author and answers that work", async () => {
  const response = await request(OWNER, "/api/works/work-hc-504/library", "PUT");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, workId: "w-companion" });
  assert.deepEqual(workRows("work-hc-504"), [], "no second work is made");
  assert.ok((await libraryIds(OWNER)).includes("w-companion"));
  assert.equal(sqlite.prepare("SELECT work_id FROM hardcover_links WHERE book_id=504").pluck().get(), "w-companion");
  // The old address now opens the matched work.
  assert.equal(((await request(OWNER, "/api/works/work-hc-504")).json() as LibraryWork).workId, "w-companion");
});

test("two adds at once make one work", async () => {
  const [first, second] = await Promise.all([
    request(OWNER, "/api/works/work-hc-505/library", "PUT"),
    request(OWNER, "/api/works/work-hc-505/library", "PUT"),
  ]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(first.json(), { ok: true, workId: "work-hc-505" });
  assert.deepEqual(second.json(), { ok: true, workId: "work-hc-505" });
  assert.deepEqual(workRows("work-hc-505"), ["work-hc-505"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM hardcover_links WHERE book_id=505").pluck().get(), 1);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) FROM audio_editions WHERE work_id='work-hc-505'").pluck().get(),
    1,
    "one placeholder",
  );
});

test("Add to library of a work on the server answers its own workId, and an empty JSON body is accepted", async () => {
  const response = await app.inject({
    method: "PUT",
    url: "/api/works/w-other/library",
    cookies: { sonder_session: SAM },
    headers: { "content-type": "application/json" },
    payload: "{}",
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, workId: "w-other" });
});
