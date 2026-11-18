// Books with only an ebook join the library through a placeholder (#555; decided in #467): the
// routes that make one (`PUT /api/works/<workId>/library`, `POST /api/ebooks/import`, `POST /api/ebooks`),
// the placeholder's id (`ensurePlaceholder`), and real audio arriving (`claimWorkAudio`, through the
// acquisition import). A throwaway database; read as the owner (the administrator), Sam (a user) and
// Kim (a user with nothing of these books).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-ebook-only-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = 1;
const SAM = 2;
const KIM = 3;
const TOKENS: Record<number, string> = { [OWNER]: "owner-token", [SAM]: "sam-token", [KIM]: "kim-token" };
const T0 = Date.UTC(2026, 0, 1);

const { sqlite } = await import("../server/db.ts");
const { hashToken, encrypt } = await import("../server/security.ts");
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
const rows = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...args);
for (const [id, name, role] of [[OWNER, "admin", "admin"], [SAM, "sam", "user"], [KIM, "kim", "user"]] as const) {
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(?,?,NULL,?,?)", id, name, role, T0);
  run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(TOKENS[id]), Date.now() + 86_400_000, id);
}
const work = (id: string, title: string) =>
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'An Author','About it.','Fiction',2001)", id, title);
const realEdition = (workId: string, editionId: string) => {
  run(
    "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,'/covers/real.jpg','A Narrator','en',NULL,4,'Test source')",
    editionId,
    workId,
  );
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${editionId}`, editionId);
  run(
    "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,'Part 1',0,600,'https://audio.example/a.mp3','remote','[]')",
    `t-${editionId}`,
    `rec-${editionId}`,
  );
};
// Something in the library so the demo seed (which only seeds an empty database) stays out.
work("w-seedless", "Already Here");
realEdition("w-seedless", "ed-seedless");
run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", OWNER, "ed-seedless", T0);
// - w-outside: a real recording in nobody's library.
work("w-outside", "Outside");
realEdition("w-outside", "ed-outside");
// - w-kept: in the owner's library through ed-kept-a; he removed ed-kept-b.
work("w-kept", "Kept");
realEdition("w-kept", "ed-kept-a");
realEdition("w-kept", "ed-kept-b");
run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,'ed-kept-a','listening',?)", OWNER, T0);
run("INSERT INTO user_hidden_library(user_id,book_id) VALUES(?,'ed-kept-b')", OWNER);
// - w-bare, w-race, w-search: works with no edition at all.
work("w-bare", "Bare");
work("w-race", "Race");
work("w-search", "Searched For");
// - w-matched: matched on Hardcover (book 4243), no edition yet. w-matched-dl: matched (4244) for a download.
work("w-matched", "Matched");
run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-matched',4243,'matched','[]')");
work("w-matched-dl", "Matched Download");
run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-matched-dl',4244,'matched-download','[]')");
// The administrator's start step already ran on this database (`shelf-ebooks-join.test.ts` tests it).
run("INSERT INTO user_settings(user_id,key,value) VALUES(?,'shelfEbooksJoined','1')", OWNER);

const { createApp } = await import("../server/app.ts");
const { ensurePlaceholder } = await import("../server/placeholder-edition.ts");
const { acquire } = await import("../server/acquisitions.ts");
const app = await createApp({ background: { manual: true } });
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
});

const as = (userId: number) => ({ sonder_session: TOKENS[userId] });
const editionsOf = (workId: string) =>
  rows(
    "SELECT e.id,e.narrator,e.cover,(SELECT group_concat(r.id) FROM recordings r WHERE r.edition_id=e.id) AS recordings FROM audio_editions e WHERE e.work_id=? ORDER BY e.rowid",
    workId,
  ) as { id: string; narrator: string; cover: string; recordings: string }[];
const libraryRows = (userId: number, workId: string) =>
  rows(
    "SELECT u.book_id AS id,u.status FROM user_library u JOIN audio_editions e ON e.id=u.book_id WHERE u.user_id=? AND e.work_id=? ORDER BY u.book_id",
    userId,
    workId,
  ) as { id: string; status: string }[];
const hiddenRows = (userId: number, workId: string) =>
  (rows(
    "SELECT h.book_id AS id FROM user_hidden_library h JOIN audio_editions e ON e.id=h.book_id WHERE h.user_id=? AND e.work_id=? ORDER BY h.book_id",
    userId,
    workId,
  ) as { id: string }[]).map((row) => row.id);
const origin = (userId: number, workId: string) =>
  sqlite.prepare("SELECT source FROM user_work_library_origin WHERE user_id=? AND work_id=?").pluck().get(userId, workId);
/** Every row of the user's own that joining a library could touch. */
const userState = (userId: number) =>
  Object.fromEntries(
    ["user_library", "user_hidden_library", "user_work_library_origin", "user_hardcover_outbox", "user_progress", "user_settings"].map(
      (table) => [table, rows(`SELECT * FROM ${table} WHERE user_id=? ORDER BY 1,2`, userId)],
    ),
  );
async function bookIds(userId: number) {
  const response = await app.inject({ url: "/api/books", cookies: as(userId) });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { id: string }[]).map((book) => book.id);
}
async function libraryWorkIds(userId: number) {
  const response = await app.inject({ url: "/api/library", cookies: as(userId) });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { workId: string }[]).map((entry) => entry.workId);
}
function upload(filename: string, bytes: Buffer, userId = OWNER, workId?: string) {
  const boundary = "sonder-ebook-only";
  return app.inject({
    method: "POST",
    url: "/api/ebooks/import" + (workId ? `?workId=${workId}` : ""),
    cookies: as(userId),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
const epub = (text: string) => Buffer.from(`PK\x03\x04${text}`);
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);
const ebookWork = (ebookId: string) =>
  sqlite.prepare("SELECT work_id FROM ebook_editions WHERE id=?").pluck().get(ebookId) as string;

test("an import with no book chosen puts the new work in the importer's library through one placeholder-<workId>", async () => {
  const sam = userState(SAM);
  const kim = userState(KIM);
  const imported = await upload("Frankenstein.epub", epub("frankenstein"));
  assert.equal(imported.statusCode, 200, imported.body);
  // The response keeps its shape (older clients read it).
  assert.deepEqual(Object.keys(imported.json()).sort(), ["alreadySaved", "id"]);
  const workId = ebookWork(imported.json().id);
  assert.match(workId, /^work-/);
  assert.deepEqual(editionsOf(workId), [
    { id: `placeholder-${workId}`, narrator: "Audio not added", cover: "/covers/meditations.svg", recordings: `recording-placeholder-${workId}` },
  ]);
  assert.deepEqual(libraryRows(OWNER, workId), [{ id: `placeholder-${workId}`, status: "unread" }]);
  assert.equal(origin(OWNER, workId), "manual");
  // Today's Library lists it through GET /api/books, as it lists Hardcover shelf books; the read by work too.
  assert.ok((await bookIds(OWNER)).includes(`placeholder-${workId}`));
  assert.ok((await libraryWorkIds(OWNER)).includes(workId));
  // The same file again finds the same work: still one placeholder.
  const again = await upload("Frankenstein copy.epub", epub("frankenstein"));
  assert.equal(again.json().alreadySaved, true);
  assert.equal(editionsOf(workId).length, 1);
  // Another account learns nothing of it and has nothing written.
  for (const other of [SAM, KIM]) {
    assert.ok(!(await bookIds(other)).includes(`placeholder-${workId}`), `user ${other}`);
    assert.ok(!(await libraryWorkIds(other)).includes(workId), `user ${other}`);
  }
  assert.deepEqual(userState(SAM), sam);
  assert.deepEqual(userState(KIM), kim);
});

test("a PDF import with no book joins the same way", async () => {
  const imported = await upload("Capitalist Realism.pdf", pdf("capitalist"));
  assert.equal(imported.statusCode, 200, imported.body);
  const workId = ebookWork(imported.json().id);
  assert.deepEqual(libraryRows(OWNER, workId), [{ id: `placeholder-${workId}`, status: "unread" }]);
});

test("an import into a work outside the library adds that work by the rule of Add to library", async () => {
  // A work with a real recording: its recording's row, no placeholder made.
  const intoOutside = await upload("Outside.epub", epub("outside"), OWNER, "w-outside");
  assert.equal(intoOutside.statusCode, 200, intoOutside.body);
  assert.deepEqual(editionsOf("w-outside").map((edition) => edition.id), ["ed-outside"]);
  assert.deepEqual(libraryRows(OWNER, "w-outside"), [{ id: "ed-outside", status: "unread" }]);
  assert.equal(origin(OWNER, "w-outside"), "manual");
  // A work with no audio edition: its placeholder.
  const intoBare = await upload("Bare.pdf", pdf("bare"), OWNER, "w-bare");
  assert.equal(intoBare.statusCode, 200, intoBare.body);
  assert.deepEqual(editionsOf("w-bare").map((edition) => edition.id), ["placeholder-w-bare"]);
  assert.deepEqual(libraryRows(OWNER, "w-bare"), [{ id: "placeholder-w-bare", status: "unread" }]);
  assert.deepEqual(libraryRows(SAM, "w-bare"), []);
});

test("an import into a work already in the library leaves it as it is: a removed recording stays removed", async () => {
  const imported = await upload("Kept.epub", epub("kept"), OWNER, "w-kept");
  assert.equal(imported.statusCode, 200, imported.body);
  assert.deepEqual(libraryRows(OWNER, "w-kept"), [{ id: "ed-kept-a", status: "listening" }]);
  assert.deepEqual(hiddenRows(OWNER, "w-kept"), ["ed-kept-b"]);
  assert.deepEqual(editionsOf("w-kept").map((edition) => edition.id), ["ed-kept-a", "ed-kept-b"]);
});

test("a user who is not the administrator cannot import or get an ebook, and nothing is written for them", async () => {
  const sam = userState(SAM);
  const refused = await upload("Sam.epub", epub("sam"), SAM);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.deepEqual(userState(SAM), sam);
});

/** A Library Genesis search result whose file is `content`, served by a fake mirror. */
function searchResult(content: Buffer, title: string, workId?: string) {
  const md5 = createHash("md5").update(content).digest("hex");
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/ads.php?"))
      return new Response(`<a href="https://1.1.1.1/get.php?md5=${md5}&amp;key=test">GET</a>`);
    if (String(input).startsWith("https://1.1.1.1/"))
      return new Response(new Uint8Array(content), { headers: { "Content-Length": String(content.length) } });
    return realFetch(input, init);
  };
  return {
    source: "libgen",
    md5,
    title,
    authors: ["An Author"],
    extension: "epub",
    language: "English",
    size: "1 KB",
    year: "2001",
    coverUrl: null,
    url: `https://libgen.li/ads.php?md5=${md5}`,
    ...(workId ? { workId } : {}),
  };
}

test("a download from a search result puts its work in the library of the user who got it", async () => {
  const kim = userState(KIM);
  try {
    const got = await app.inject({ method: "POST", url: "/api/ebooks", cookies: as(OWNER), payload: searchResult(epub("searched new"), "A Search Result") });
    assert.equal(got.statusCode, 200, got.body);
    assert.deepEqual(Object.keys(got.json()), ["id"]);
    const workId = ebookWork(got.json().id);
    assert.deepEqual(editionsOf(workId).map((edition) => edition.id), [`placeholder-${workId}`]);
    assert.deepEqual(libraryRows(OWNER, workId), [{ id: `placeholder-${workId}`, status: "unread" }]);
    // Got for a book outside the library with no audio: that book joins.
    const forWork = await app.inject({
      method: "POST",
      url: "/api/ebooks",
      cookies: as(OWNER),
      payload: searchResult(epub("searched for work"), "Searched For", "w-search"),
    });
    assert.equal(forWork.statusCode, 200, forWork.body);
    assert.deepEqual(libraryRows(OWNER, "w-search"), [{ id: "placeholder-w-search", status: "unread" }]);
    // For a book matched on Hardcover the placeholder is hc-<book id>.
    const matched = await app.inject({
      method: "POST",
      url: "/api/ebooks",
      cookies: as(OWNER),
      payload: searchResult(epub("matched download"), "Matched Download", "w-matched-dl"),
    });
    assert.equal(matched.statusCode, 200, matched.body);
    assert.deepEqual(editionsOf("w-matched-dl").map((edition) => edition.id), ["hc-4244"]);
    assert.deepEqual(libraryRows(OWNER, "w-matched-dl"), [{ id: "hc-4244", status: "unread" }]);
    // Kim may not get one, and has nothing written.
    const refused = await app.inject({ method: "POST", url: "/api/ebooks", cookies: as(KIM), payload: searchResult(epub("kim"), "Kim's") });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.deepEqual(userState(KIM), kim);
    assert.ok(!(await bookIds(KIM)).includes(`placeholder-${workId}`));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("PUT of a work with no audio edition makes its placeholder and adds its row; two at once make one", async () => {
  const kim = userState(KIM);
  const [first, second] = await Promise.all([
    app.inject({ method: "PUT", url: "/api/works/w-race/library", cookies: as(OWNER) }),
    app.inject({ method: "PUT", url: "/api/works/w-race/library", cookies: as(OWNER), payload: {} }),
  ]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(first.json(), { ok: true, workId: "w-race" });
  assert.deepEqual(editionsOf("w-race"), [
    { id: "placeholder-w-race", narrator: "Audio not added", cover: "/covers/meditations.svg", recordings: "recording-placeholder-w-race" },
  ]);
  assert.deepEqual(libraryRows(OWNER, "w-race"), [{ id: "placeholder-w-race", status: "unread" }]);
  assert.equal(origin(OWNER, "w-race"), "manual");
  // w-race has no ebook, and its only edition is now the owner's placeholder: Sam may not see it, so
  // his PUT answers 404, writes nothing and makes no second placeholder.
  const owner = userState(OWNER);
  const samBefore = userState(SAM);
  const sam = await app.inject({ method: "PUT", url: "/api/works/w-race/library", cookies: as(SAM) });
  assert.equal(sam.statusCode, 404, "a work whose only edition is another user's placeholder is not Sam's to see");
  assert.deepEqual(userState(OWNER), owner);
  assert.deepEqual(userState(SAM), samBefore);
  assert.deepEqual(userState(KIM), kim);
  assert.equal(editionsOf("w-race").length, 1);
});

test("a work matched on Hardcover gets hc-<book id>, never a second placeholder", async () => {
  assert.equal((await app.inject({ method: "PUT", url: "/api/works/w-matched/library", cookies: as(OWNER) })).statusCode, 200);
  assert.deepEqual(editionsOf("w-matched").map((edition) => [edition.id, edition.recordings]), [["hc-4243", "recording-hc-4243"]]);
  assert.deepEqual(libraryRows(OWNER, "w-matched"), [{ id: "hc-4243", status: "unread" }]);
  // Again through every maker: the same one.
  assert.equal(ensurePlaceholder(sqlite, "w-matched"), "hc-4243");
  assert.equal((await upload("Matched.epub", epub("matched"), OWNER, "w-matched")).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/works/w-matched/library", cookies: as(OWNER) })).statusCode, 200);
  assert.deepEqual(editionsOf("w-matched").map((edition) => edition.id), ["hc-4243"]);
  // A work that has a placeholder already keeps it, whatever its id.
  assert.equal(ensurePlaceholder(sqlite, "w-race"), "placeholder-w-race");
  assert.equal(editionsOf("w-race").length, 1);
});

test("ensurePlaceholder: the Hardcover cover when it is an https address; another work's hc-<id> is never taken", () => {
  work("w-cover", "Covered");
  run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-cover',4250,'covered','[]')");
  assert.equal(ensurePlaceholder(sqlite, "w-cover", { cover: "https://assets.hardcover.app/c.jpg" }), "hc-4250");
  assert.equal(editionsOf("w-cover")[0].cover, "https://assets.hardcover.app/c.jpg");
  work("w-cover-plain", "Plain");
  assert.equal(ensurePlaceholder(sqlite, "w-cover-plain", { cover: "http://insecure.example/c.jpg" }), "placeholder-w-cover-plain");
  assert.equal(editionsOf("w-cover-plain")[0].cover, "/covers/meditations.svg");
  // A second work linked to book 4250: hc-4250 is w-cover's, so it gets its own.
  work("w-cover-twin", "Covered twin");
  run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-cover-twin',4250,'covered','[]')");
  assert.equal(ensurePlaceholder(sqlite, "w-cover-twin"), "placeholder-w-cover-twin");
  assert.deepEqual(editionsOf("w-cover").map((edition) => edition.id), ["hc-4250"]);
  // A work with only real audio gets a placeholder beside it (the start step joins through one).
  assert.equal(ensurePlaceholder(sqlite, "w-outside"), "placeholder-w-outside");
  assert.deepEqual(editionsOf("w-outside").map((edition) => edition.id), ["ed-outside", "placeholder-w-outside"]);
});

/** Real audio arriving for `workId` through the acquisition import (a cached TorBox download). */
async function audioArrives(workId: string, torrentId: number, userId: number) {
  const hash = createHash("sha1").update(`${workId}-${torrentId}`).digest("hex");
  run("INSERT INTO settings(key,value) VALUES('torbox',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", encrypt("fake-key"));
  const hardcoverCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.hardcover.app/")) hardcoverCalls.push(url);
    let data: unknown;
    if (url.includes("checkcached")) data = [{ hash }];
    else if (url.includes("createtorrent")) data = { torrent_id: torrentId };
    else if (url.includes("mylist")) data = { download_present: true, files: [{ id: 1, name: "Chapter 1.mp3" }] };
    else return realFetch(input, init);
    return Response.json({ success: true, data });
  };
  try {
    const job = await acquire(`magnet:?xt=urn:btih:${hash}`, { title: "Arriving audio", workId, userId });
    assert.equal(job.status, "ready", job.error ?? "");
    return { editionId: `torbox-${torrentId}`, hardcoverCalls };
  } finally {
    globalThis.fetch = realFetch;
    run("DELETE FROM settings WHERE key='torbox'");
  }
}

test("audio arriving for an ebook-only work: the real row with the status carried over, no placeholder row; a user who hid it untouched", async () => {
  // w-arrive: an ebook-only work in the owner's library (listening) and in Sam's (finished) through
  // its placeholder; Sam hid torbox-501 (the recording that arrives); Kim has nothing of it.
  work("w-arrive", "Arriving");
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-arrive','w-arrive','epub','/books/arrive.epub')");
  assert.equal((await app.inject({ method: "PUT", url: "/api/works/w-arrive/library", cookies: as(OWNER) })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/works/w-arrive/library", cookies: as(SAM) })).statusCode, 200);
  run("UPDATE user_library SET status='listening' WHERE user_id=? AND book_id='placeholder-w-arrive'", OWNER);
  run("UPDATE user_library SET status='finished' WHERE user_id=? AND book_id='placeholder-w-arrive'", SAM);
  // Hiding needs the edition to exist (the hidden entry references it): torbox-501 was delivered
  // once before for this work and Sam removed it; it is delivered again now. Nobody has its row.
  run(
    "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES('torbox-501','w-arrive','/covers/time.svg','Unknown author',NULL,'Arriving audio',0,'TorBox · Cached')",
  );
  run("INSERT INTO recordings(id,edition_id) VALUES('recording-torbox-501','torbox-501')");
  run(
    "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES('torbox-501-1','recording-torbox-501','Chapter 1.mp3',0,0,'{\"torrentId\":501,\"fileId\":1}','torbox','[]')",
  );
  run("INSERT INTO user_hidden_library(user_id,book_id) VALUES(?,'torbox-501')", SAM);
  run("INSERT INTO user_ebook_progress(user_id,edition_id,cfi,chapter,updated_at) VALUES(?,'eb-arrive','epubcfi(/6/4)',2,?)", OWNER, T0);
  const sam = userState(SAM);
  const kim = userState(KIM);

  const { editionId, hardcoverCalls } = await audioArrives("w-arrive", 501, OWNER);
  assert.equal(editionId, "torbox-501");
  assert.deepEqual(libraryRows(OWNER, "w-arrive"), [{ id: "torbox-501", status: "listening" }]);
  assert.equal(origin(OWNER, "w-arrive"), "manual", "the library origin is untouched");
  assert.equal(
    sqlite.prepare("SELECT cfi FROM user_ebook_progress WHERE user_id=? AND edition_id='eb-arrive'").pluck().get(OWNER),
    "epubcfi(/6/4)",
    "the place in the ebook is untouched",
  );
  assert.deepEqual(userState(SAM), sam, "Sam hid the recording: his rows are left alone");
  assert.deepEqual(libraryRows(SAM, "w-arrive"), [{ id: "placeholder-w-arrive", status: "finished" }]);
  assert.deepEqual(userState(KIM), kim);
  // The work is not matched on Hardcover: the Hardcover part does nothing.
  assert.deepEqual(hardcoverCalls, []);
  assert.deepEqual(rows("SELECT * FROM user_hardcover_outbox"), []);
  // The read by work: one book with the recording and the ebook.
  const read = await app.inject({ url: "/api/works/w-arrive", cookies: as(OWNER) });
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(read.json().recordings.map((r: { recordingId: string }) => r.recordingId), ["recording-torbox-501"]);
});

test("audio arriving for an ebook-only work another user asked for moves every placeholder row", async () => {
  // Sam asked for nothing, but he has the placeholder of w-arrive2 in his library: he gets the real row.
  work("w-arrive2", "Arriving Two");
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-arrive2','w-arrive2','pdf','/books/arrive2.pdf')");
  assert.equal((await app.inject({ method: "PUT", url: "/api/works/w-arrive2/library", cookies: as(SAM) })).statusCode, 200);
  run("UPDATE user_library SET status='listening' WHERE user_id=? AND book_id='placeholder-w-arrive2'", SAM);
  await audioArrives("w-arrive2", 502, OWNER);
  assert.deepEqual(libraryRows(SAM, "w-arrive2"), [{ id: "torbox-502", status: "listening" }]);
  assert.deepEqual(libraryRows(OWNER, "w-arrive2"), [{ id: "torbox-502", status: "unread" }]);
  assert.deepEqual(libraryRows(KIM, "w-arrive2"), []);
});

test("audio arriving for a matched work runs the Hardcover part: the user's own Hardcover shelf status", async () => {
  work("w-arrive-hc", "Arriving Matched");
  run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-arrive-hc',4260,'arriving','[]')");
  assert.equal((await app.inject({ method: "PUT", url: "/api/works/w-arrive-hc/library", cookies: as(OWNER) })).statusCode, 200);
  assert.deepEqual(libraryRows(OWNER, "w-arrive-hc"), [{ id: "hc-4260", status: "unread" }]);
  // The owner's Hardcover shelf has the book as Read.
  run("INSERT INTO user_hardcover_links(user_id,book_id,user_book_id,status_id,remote_updated_at,synced_at) VALUES(?,4260,90,3,0,0)", OWNER);
  await audioArrives("w-arrive-hc", 503, OWNER);
  assert.deepEqual(libraryRows(OWNER, "w-arrive-hc"), [{ id: "torbox-503", status: "finished" }]);
});

test("the series removal hides the work's placeholder through ensurePlaceholder, never making a second", async () => {
  const { ensureHardcoverSyncSuppressed } = await import("../server/series-removal.ts");
  // w-race got matched on Hardcover after its placeholder was made: the placeholder it has is hidden.
  run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-race',4270,'race','[]')");
  ensureHardcoverSyncSuppressed(KIM, "w-race");
  assert.deepEqual(editionsOf("w-race").map((edition) => edition.id), ["placeholder-w-race"]);
  assert.deepEqual(hiddenRows(KIM, "w-race"), ["placeholder-w-race"]);
  // A matched work with no edition gets hc-<book id>, hidden.
  work("w-series", "Series Member");
  run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-series',4271,'series-member','[]')");
  ensureHardcoverSyncSuppressed(KIM, "w-series");
  assert.deepEqual(editionsOf("w-series").map((edition) => [edition.id, edition.narrator]), [["hc-4271", "Audio not added"]]);
  assert.deepEqual(hiddenRows(KIM, "w-series"), ["hc-4271"]);
});

/** One second of a 440 Hz tone as a WAV file. */
function wave() {
  const n = 8000;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((i * 440 * Math.PI * 2) / 8000) * 2000), 44 + i * 2);
  return b;
}

test("an upload of audio for an ebook-only work claims its placeholder rows", async () => {
  // The upload finds a work by its Hardcover match (title and author), as before.
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-upload','Uploaded Book','Ana Writer','About it.','Fiction',2001)");
  run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-upload',4280,'uploaded-book','[]')");
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-upload','w-upload','epub','/books/upload.epub')");
  assert.equal((await app.inject({ method: "PUT", url: "/api/works/w-upload/library", cookies: as(SAM) })).statusCode, 200);
  run("UPDATE user_library SET status='listening' WHERE user_id=? AND book_id='hc-4280'", SAM);
  const boundary = "sonder-upload";
  const uploaded = await app.inject({
    method: "POST",
    url: "/api/import",
    cookies: as(OWNER),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nUploaded Book\r\n--${boundary}\r\nContent-Disposition: form-data; name="author"\r\n\r\nAna Writer\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="part.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      wave(),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const id = uploaded.json().id as string;
  assert.deepEqual(libraryRows(SAM, "w-upload"), [{ id, status: "listening" }]);
  assert.deepEqual(libraryRows(OWNER, "w-upload"), [{ id, status: "unread" }]);
});

test("the Hardcover import makes its placeholder through ensurePlaceholder with Hardcover's cover", async () => {
  const { applyHardcoverCatalogBook } = await import("../server/hardcover.ts");
  applyHardcoverCatalogBook(KIM, {
    id: 4290,
    title: "Shelved On Hardcover",
    slug: "shelved-on-hardcover",
    pages: 100,
    description: "About it.",
    release_year: 2001,
    cached_image: { url: "https://assets.hardcover.app/4290.jpg" },
    contributions: [{ contribution: "author", author: { name: "Someone" } }],
    book_series: [],
    default_audio_edition: null,
    editions: [],
  } as never);
  assert.deepEqual(editionsOf("work-hc-4290"), [
    { id: "hc-4290", narrator: "Audio not added", cover: "https://assets.hardcover.app/4290.jpg", recordings: "recording-hc-4290" },
  ]);
  assert.deepEqual(libraryRows(KIM, "work-hc-4290"), [{ id: "hc-4290", status: "unread" }]);
});
