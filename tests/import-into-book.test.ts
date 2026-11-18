// Audio files imported into a book (#605, spec #600 "What the server answers and accepts"): `POST /api/import` with
// the optional form field `workId`, sent before the files. Through the app instance on a throwaway database, as the
// administrator (the uploader), Sam (a user who had the work's placeholder in his library) and Kim (a user with
// nothing of it).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-import-into-book-");
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
const { hashToken } = await import("../server/security.ts");
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
const rows = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...args);
for (const [id, name, role] of [[OWNER, "admin", "admin"], [SAM, "sam", "user"], [KIM, "kim", "user"]] as const) {
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(?,?,NULL,?,?)", id, name, role, T0);
  run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(TOKENS[id]), Date.now() + 86_400_000, id);
}
const work = (id: string, title: string, author: string) =>
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,'About it.','Fiction',2001)", id, title, author);
// Something in the library so the demo seed (which only seeds an empty database) stays out.
work("w-seedless", "Already Here", "Someone");
run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed-seedless','w-seedless','/covers/real.jpg','A Narrator',4,'Test source')");
run("INSERT INTO recordings(id,edition_id) VALUES('rec-ed-seedless','ed-seedless')");
run("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES('t-seedless','rec-ed-seedless','Part 1',0,600,'https://audio.example/a.mp3','remote','[]')");
run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", OWNER, "ed-seedless", T0);
run("INSERT INTO user_settings(user_id,key,value) VALUES(?,'shelfEbooksJoined','1')", OWNER);
// - w-target: a book with an ebook only. Its title and author differ from what the files' tags and the form say, and
//   Hardcover knows another work by the files' title and author (w-decoy), so neither may name the recording.
work("w-target", "The Real Title", "Real Author");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-target','w-target','epub','/books/target.epub')");
work("w-decoy", "Typed Title", "Real Author");
run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-decoy',4301,'typed-title','[]')");
// - w-bare: a book with nothing at all, in nobody's library.
work("w-bare", "Bare Book", "Bare Author");

const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
  sqlite.close();
});

const as = (userId: number) => ({ sonder_session: TOKENS[userId] });
const uploads = () => {
  const dir = join(temp, "media", "imports");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const libraryRows = (userId: number, workId: string) =>
  rows(
    "SELECT u.book_id AS id,u.status FROM user_library u JOIN audio_editions e ON e.id=u.book_id WHERE u.user_id=? AND e.work_id=? ORDER BY u.book_id",
    userId,
    workId,
  ) as { id: string; status: string }[];

function wave(n = 8000) {
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

type Part = { field: string; value: string } | { file: string; body: Buffer };
function multipart(parts: Part[]) {
  const boundary = "sonder-import-into-book";
  const chunks: Buffer[] = [];
  for (const part of parts)
    chunks.push(
      "field" in part
        ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`)
        : Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${part.file}"\r\nContent-Type: audio/wav\r\n\r\n`),
            part.body,
            Buffer.from("\r\n"),
          ]),
    );
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}
const upload = (userId: number, parts: Part[]) => app.inject({ method: "POST", url: "/api/import", cookies: as(userId), ...multipart(parts) });
const work_ = (userId: number, workId: string) => app.inject({ url: `/api/works/${workId}`, cookies: as(userId) });

test("an upload with workId makes a recording of that work with its title, in the uploader's library, replacing its placeholder row", async () => {
  // Sam and the owner have the book in their libraries through its placeholder (an ebook-only book).
  for (const user of [OWNER, SAM]) assert.equal((await app.inject({ method: "PUT", url: "/api/works/w-target/library", cookies: as(user) })).statusCode, 200);
  run("UPDATE user_library SET status='listening' WHERE user_id=? AND book_id='placeholder-w-target'", SAM);
  // The placeholder shows the book's own cover (Hardcover's, as a rule): the recording takes it.
  run("UPDATE audio_editions SET cover='https://assets.hardcover.app/target.jpg' WHERE id='placeholder-w-target'");
  const placeholderCover = (rows("SELECT cover FROM audio_editions WHERE id='placeholder-w-target'") as { cover: string }[])[0].cover;
  const answer = await upload(OWNER, [
    { field: "workId", value: "w-target" },
    // An older field the sheet does not send: the work's title and author win over it.
    { field: "title", value: "Typed Title" },
    { field: "author", value: "Typed Author" },
    { file: "02 Second.wav", body: wave() },
    { file: "01 First.wav", body: wave(4000) },
  ]);
  assert.equal(answer.statusCode, 200, answer.body);
  const id = answer.json().id as string;
  const edition = (rows("SELECT work_id AS workId,cover,narrator,source_label AS label FROM audio_editions WHERE id=?", id) as { workId: string; cover: string; label: string }[])[0];
  assert.equal(placeholderCover, "https://assets.hardcover.app/target.jpg");
  assert.deepEqual(edition, { workId: "w-target", cover: placeholderCover, narrator: "Real Author", label: "Your audio files" });
  // The work keeps its own title and author; no work was made for the typed or tagged names, and w-decoy gained nothing.
  assert.deepEqual(rows("SELECT title,author FROM works WHERE id='w-target'"), [{ title: "The Real Title", author: "Real Author" }]);
  assert.equal((rows("SELECT count(*) AS n FROM audio_editions WHERE work_id='w-decoy'") as { n: number }[])[0].n, 0);
  assert.equal((rows("SELECT count(*) AS n FROM works") as { n: number }[])[0].n, 4);
  // Its tracks, in the order sent, under one recording of the edition.
  assert.deepEqual(
    rows("SELECT t.title,t.track_index AS idx FROM tracks t WHERE t.recording_id=? ORDER BY t.track_index", `recording-${id}`),
    [{ title: "02 Second", idx: 0 }, { title: "01 First", idx: 1 }],
  );
  // The uploader's library row, and Sam's placeholder row replaced with its status kept (today's claim).
  assert.deepEqual(libraryRows(OWNER, "w-target"), [{ id, status: "unread" }]);
  assert.deepEqual(libraryRows(SAM, "w-target"), [{ id, status: "listening" }]);
  // Kim had nothing of the book and still has nothing.
  assert.deepEqual(libraryRows(KIM, "w-target"), []);
  // The book reads with its recording, under its own title.
  const book = await work_(OWNER, "w-target");
  assert.equal(book.statusCode, 200, book.body);
  assert.match(book.body, new RegExp(`recording-${id}`));
  const books = (await app.inject({ url: "/api/books", cookies: as(OWNER) })).json() as { id: string; title: string; author: string }[];
  const row = books.find((entry) => entry.id === id)!;
  assert.equal(row.title, "The Real Title");
  assert.equal(row.author, "Real Author");
  // Kim reads the server's catalogue as today, without the book in his library or a status of Sam's or the owner's.
  const kimBooks = (await app.inject({ url: "/api/books", cookies: as(KIM) })).json() as { id: string; inLibrary: boolean; status: string }[];
  const kims = kimBooks.find((entry) => entry.id === id);
  assert.equal(kims?.inLibrary ?? false, false);
  assert.equal(kims?.status ?? "unread", "unread");
});

test("an upload with workId into a book with nothing at all joins that book", async () => {
  const answer = await upload(OWNER, [{ field: "workId", value: "w-bare" }, { file: "Only.wav", body: wave() }]);
  assert.equal(answer.statusCode, 200, answer.body);
  const id = answer.json().id as string;
  assert.deepEqual(rows("SELECT work_id AS workId FROM audio_editions WHERE id=?", id), [{ workId: "w-bare" }]);
  assert.deepEqual(libraryRows(OWNER, "w-bare"), [{ id, status: "unread" }]);
});

test("an unknown workId is refused before a file is written, and the upload folder stays empty", async () => {
  const before = uploads();
  const tracks = (rows("SELECT count(*) AS n FROM tracks") as { n: number }[])[0].n;
  const answer = await upload(OWNER, [{ field: "workId", value: "w-nowhere" }, { file: "Lost.wav", body: wave() }]);
  assert.equal(answer.statusCode, 400, answer.body);
  assert.equal(answer.json().error, "The selected book could not be found.");
  assert.deepEqual(uploads(), before);
  assert.equal((rows("SELECT count(*) AS n FROM tracks") as { n: number }[])[0].n, tracks);
});

test("a workId sent after a file is refused, and the file written is removed", async () => {
  const before = uploads();
  const answer = await upload(OWNER, [{ file: "Early.wav", body: wave() }, { field: "workId", value: "w-target" }, { file: "Late.wav", body: wave() }]);
  assert.equal(answer.statusCode, 400, answer.body);
  assert.deepEqual(uploads(), before);
});

test("a refused file with workId leaves nothing in the upload folder", async () => {
  const before = uploads();
  const answer = await upload(OWNER, [{ field: "workId", value: "w-target" }, { file: "a.wav", body: wave() }, { file: "notes.txt", body: Buffer.from("hello") }]);
  assert.equal(answer.statusCode, 400, answer.body);
  assert.equal(answer.json().error, "Choose MP3, M4B, M4A, OGG, Opus, FLAC, or WAV audio files.");
  assert.deepEqual(uploads(), before);
});

test("an upload without workId is today's: a new work from the typed title, or the Hardcover match", async () => {
  const typed = await upload(OWNER, [
    { field: "title", value: "Typed Title" },
    { field: "author", value: "Real Author" },
    { file: "One.wav", body: wave() },
  ]);
  assert.equal(typed.statusCode, 200, typed.body);
  // Hardcover's match of the title and author names the work, as today.
  assert.deepEqual(rows("SELECT work_id AS workId FROM audio_editions WHERE id=?", typed.json().id), [{ workId: "w-decoy" }]);
  const fresh = await upload(OWNER, [{ field: "title", value: "Brand New" }, { field: "author", value: "New Author" }, { file: "One.wav", body: wave() }]);
  assert.equal(fresh.statusCode, 200, fresh.body);
  const id = fresh.json().id as string;
  assert.deepEqual(rows("SELECT w.id,w.title,w.author FROM audio_editions e JOIN works w ON w.id=e.work_id WHERE e.id=?", id), [
    { id: `work-${id}`, title: "Brand New", author: "New Author" },
  ]);
  assert.equal((rows("SELECT cover FROM audio_editions WHERE id=?", id) as { cover: string }[])[0].cover, "/covers/meditations.svg");
});

test("someone who is not the administrator is refused, with or without workId, and nothing is written", async () => {
  const before = uploads();
  for (const parts of [[{ field: "workId", value: "w-target" }, { file: "Mine.wav", body: wave() }], [{ file: "Mine.wav", body: wave() }]] as Part[][]) {
    const answer = await upload(SAM, parts);
    assert.equal(answer.statusCode, 403, answer.body);
  }
  // An unknown book reads the same refusal to him: the guard answers before the work is looked up.
  assert.equal((await upload(SAM, [{ field: "workId", value: "w-nowhere" }, { file: "Mine.wav", body: wave() }])).statusCode, 403);
  assert.deepEqual(uploads(), before);
  assert.deepEqual(libraryRows(SAM, "w-bare"), []);
});

