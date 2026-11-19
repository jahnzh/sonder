// A recording's chapters on the book's Edit page (#719 part c): edited titles and starts kept as a recording override
// (the files and the `tracks` rows are never written), placed over the files for `GET /api/books` and the read by
// work, Revert, Look up chapters from the linked AudiobookDB release or by an ASIN (taken only when the release's length
// agrees within a few seconds), saved places never moved, and only the administrator edits. On a throwaway database
// with the recorded AudiobookDB answers (tests/audiobookdb-fixture.ts): no live call.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Book, ChapterLookup, LibraryWork, RecordingChapters } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";
import { createControl, fixtureFetch } from "./audiobookdb-fixture.ts";

const temp = tempDir("sonder-recording-chapters-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = "owner-token";
const KIM = "kim-token";
const T0 = Date.UTC(2026, 0, 1);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("No network in this test.");
}) as typeof fetch;

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const chapters = await import("../server/recording-chapters.ts");
const abdb = await import("../server/audiobookdb.ts");
const control = createControl();
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control, globalThis.fetch), key: () => "test-key" });

const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
const media = join(process.env.MEDIA_ROOT, "fixture");
mkdirSync(media, { recursive: true });
run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)", T0);
run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(2,'kim',NULL,'user',?)", T0);
for (const [token, userId] of [[OWNER, 1], [KIM, 2]] as const)
  run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(token), Date.now() + 86_400_000, userId);
/** A work with one recording of `files` (title, seconds, the file's own chapters). */
function recording(workId: string, title: string, files: [string, number, { title: string; start: number; end?: number }[]][]) {
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)", workId, title, "Ida Vale", "", "", 2020);
  run(
    "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,?,?,?,?)",
    `ed-${workId}`, workId, `/covers/${workId}.svg`, "Mara Lind", "en", `${title} (Unabridged)`, 0, "Test",
  );
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${workId}`, `ed-${workId}`);
  for (const [index, [name, seconds, own]] of files.entries()) {
    const source = join(media, `${workId}-${index}.mp3`);
    writeFileSync(source, "audio");
    run(
      "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,?,?,?,?,?,?)",
      `t-${workId}-${index}`, `rec-${workId}`, name, index, seconds, source, "local", JSON.stringify(own),
    );
  }
  for (const userId of [1, 2]) run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", userId, `ed-${workId}`, T0);
}
// Two files of 5 h each (36 000 s and 36 002 s): AudiobookDB's rl-asin is 36 000 000 ms, 2 s off: its chapters are taken.
recording("w-two-files", "A Long Way Home", [
  ["Part 1", 18_000, [{ title: "Opening", start: 0, end: 9000 }, { title: "Middle", start: 9000, end: 18_000 }]],
  ["Part 2", 18_002, []],
]);
// One file 36 010 s long: 10 s off AudiobookDB's release, its chapters are shown with the reason, not taken.
recording("w-one-file", "Another Way Home", [["Whole book", 36_010, []]]);
// Linked to rl-asin with the release's chapters stored on the link (#721).
run(
  "INSERT INTO recording_release_links(recording_id,book_id,release_id,narrator,length_ms,asin,language,chapters,matched_by,linked_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  "rec-w-two-files", "bk-asin", "rl-asin", "Mara Lind", 36_000_000, "B0ASINFIX1", "en",
  JSON.stringify([{ title: "Linked one", startMs: 0, lengthMs: 1000 }, { title: "Linked two", startMs: 20_000_000, lengthMs: 16_000_000 }]), "manual", T0,
);
// Saved places, the owner's and Kim's: never moved by a chapter edit.
run("INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(1,'rec-w-two-files','t-w-two-files-1',1234.5,18002,?)", T0);
run("INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(2,'rec-w-two-files','t-w-two-files-0',42,18000,?)", T0);
sqlite.prepare("INSERT INTO settings(key,value) VALUES('migration:hardcover-removed','0')").run();

const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
});

type Method = "GET" | "PUT" | "POST";
const request = (token: string, url: string, method: Method = "GET", payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: token }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok<T>(token: string, url: string, method: Method = "GET", payload?: unknown): Promise<T> {
  const response = await request(token, url, method, payload);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as T;
}
const places = () => sqlite.prepare("SELECT * FROM user_progress ORDER BY user_id,recording_id").all();
const trackRows = () => sqlite.prepare("SELECT id,chapters,duration,track_index FROM tracks ORDER BY id").all();
const bookTracks = async (token: string, workId: string) => (await ok<Book[]>(token, "/api/books")).find((book) => book.workId === workId)!.tracks;
const workTracks = async (token: string, workId: string) =>
  (await ok<LibraryWork[]>(token, "/api/library")).find((work) => work.workId === workId)!.recordings[0].tracks;

// ---- Pure steps ----
const FILES = [
  { id: "a", index: 0, title: "Part 1", duration: 100, chapters: [] },
  { id: "b", index: 1, title: "Part 2", duration: 50, chapters: [] },
];
test("edited chapters are placed over the files: a file that begins inside a chapter starts with its title", () => {
  const placed = chapters.chaptersOverTracks(FILES, [
    { title: "One", start: 0 },
    { title: "Two", start: 80 },
    { title: "Three", start: 120 },
  ]);
  assert.deepEqual(placed.get("a"), [{ title: "One", start: 0, end: 80 }, { title: "Two", start: 80, end: 100 }]);
  assert.deepEqual(placed.get("b"), [{ title: "Two", start: 0, end: 20 }, { title: "Three", start: 20, end: 50 }]);
  // A chapter that starts exactly where a file starts is not repeated.
  assert.deepEqual(chapters.chaptersOverTracks(FILES, [{ title: "One", start: 0 }, { title: "Two", start: 100 }]).get("b"), [{ title: "Two", start: 0, end: 50 }]);
});
test("the files' own chapters over the recording: a file without any is one chapter named after it", () => {
  assert.deepEqual(chapters.fileChapters([{ ...FILES[0], chapters: [{ title: "Intro", start: 0 }, { title: "Later", start: 30 }] }, FILES[1]]), [
    { title: "Intro", start: 0 },
    { title: "Later", start: 30 },
    { title: "Part 2", start: 100 },
  ]);
});
test("a release's chapters are taken only within the tolerance of a few seconds", () => {
  const release = (lengthMs: number | null) => ({ lengthMs, chapters: [{ title: "x", startMs: 0, lengthMs: 1 }] });
  assert.equal(chapters.CHAPTER_LENGTH_TOLERANCE_S, 5);
  assert.equal(chapters.releaseAgreement(release(36_000_000), 36_005, true), null);
  assert.equal(chapters.releaseAgreement(release(36_000_000), 35_995, true), null);
  assert.match(chapters.releaseAgreement(release(36_000_000), 36_005.5, true)!, /^The release is 10:00:00 long and this recording 10:00:06; chapters are taken only when they agree within 5 seconds\.$/);
  assert.match(chapters.releaseAgreement(release(null), 36_000, true)!, /gives no length/);
  assert.match(chapters.releaseAgreement(release(36_000_000), 36_000, false)!, /length is not known yet/);
  assert.match(chapters.releaseAgreement({ lengthMs: 36_000_000, chapters: [] }, 36_000, true)!, /no chapters/);
});

// ---- Routes ----
test("chapters edited by hand: kept as an override, read over the files by /api/books and the library, the files untouched", async () => {
  const rowsBefore = trackRows();
  const before = await ok<RecordingChapters>(OWNER, "/api/recordings/rec-w-two-files/chapters");
  assert.equal(before.edited, false);
  assert.equal(before.duration, 36_002);
  assert.deepEqual(before.chapters, [{ title: "Opening", start: 0 }, { title: "Middle", start: 9000 }, { title: "Part 2", start: 18_000 }]);
  assert.deepEqual(before.release, { releaseId: "rl-asin", asin: "B0ASINFIX1", lengthMs: 36_000_000 });

  const edited = await ok<RecordingChapters>(OWNER, "/api/recordings/rec-w-two-files/chapters", "PUT", {
    chapters: [{ title: "Prologue", start: 0 }, { title: "The Road", start: 600 }, { title: "Crossing", start: 17_000 }, { title: "Home", start: 30_000 }],
  });
  assert.equal(edited.edited, true);
  assert.equal(edited.from, null);
  assert.deepEqual(edited.source, before.source);
  assert.deepEqual(trackRows(), rowsBefore, "the files' rows are never written");
  for (const tracks of [await bookTracks(OWNER, "w-two-files"), await workTracks(OWNER, "w-two-files"), await bookTracks(KIM, "w-two-files")]) {
    assert.deepEqual(tracks[0].chapters, [{ title: "Prologue", start: 0, end: 600 }, { title: "The Road", start: 600, end: 17_000 }, { title: "Crossing", start: 17_000, end: 18_000 }]);
    assert.deepEqual(tracks[1].chapters, [{ title: "Crossing", start: 0, end: 12_000 }, { title: "Home", start: 12_000, end: 18_002 }]);
  }
  // Revert: the files' chapters again, the override gone.
  const reverted = await ok<RecordingChapters>(OWNER, "/api/recordings/rec-w-two-files/chapters", "PUT", { chapters: null });
  assert.equal(reverted.edited, false);
  assert.deepEqual(reverted.chapters, before.chapters);
  assert.deepEqual((await bookTracks(OWNER, "w-two-files"))[0].chapters, [{ title: "Opening", start: 0, end: 9000 }, { title: "Middle", start: 9000, end: 18_000 }]);
  assert.deepEqual((await bookTracks(OWNER, "w-two-files"))[1].chapters, []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM recording_metadata_overrides WHERE field='chapters'").pluck().get(), 0);
});

test("editing, shifting and reverting chapters never moves a saved place", async () => {
  const before = places();
  const progressBefore = (await ok<Book[]>(OWNER, "/api/books")).find((book) => book.workId === "w-two-files")!.progress;
  await ok(OWNER, "/api/recordings/rec-w-two-files/chapters", "PUT", { chapters: [{ title: "Only", start: 0 }, { title: "Late", start: 35_000 }] });
  await ok(OWNER, "/api/recordings/rec-w-two-files/chapters", "PUT", { chapters: [{ title: "Only", start: 0 }, { title: "Late", start: 35_002 }] });
  assert.deepEqual(places(), before);
  const after = (await ok<Book[]>(OWNER, "/api/books")).find((book) => book.workId === "w-two-files")!.progress;
  assert.deepEqual(after, progressBefore);
  assert.equal(after?.trackId, "t-w-two-files-1");
  assert.equal(after?.position, 1234.5);
  const kim = (await ok<Book[]>(KIM, "/api/books")).find((book) => book.workId === "w-two-files")!.progress;
  assert.deepEqual([kim?.trackId, kim?.position], ["t-w-two-files-0", 42]);
  await ok(OWNER, "/api/recordings/rec-w-two-files/chapters", "PUT", { chapters: null });
  assert.deepEqual(places(), before);
});

test("Look up chapters from the linked release: its stored chapters, taken when the length agrees (2 s off)", async () => {
  const calls = control.calls.length;
  const found = await ok<ChapterLookup>(OWNER, "/api/recordings/rec-w-two-files/chapters/lookup", "POST", {});
  assert.equal(found.from, "release");
  assert.equal(found.agrees, true);
  assert.equal(found.reason, null);
  assert.deepEqual(found.chapters, [{ title: "Linked one", start: 0 }, { title: "Linked two", start: 20_000 }]);
  assert.equal(control.calls.length, calls, "the link's chapters need no request");
  // Looking up writes nothing: the administrator saves them (from AudiobookDB).
  assert.equal((await ok<RecordingChapters>(OWNER, "/api/recordings/rec-w-two-files/chapters")).edited, false);
  const saved = await ok<RecordingChapters>(OWNER, "/api/recordings/rec-w-two-files/chapters", "PUT", { chapters: found.chapters, from: "audiobookdb" });
  assert.equal(saved.from, "audiobookdb");
  assert.deepEqual((await bookTracks(OWNER, "w-two-files"))[1].chapters, [{ title: "Linked one", start: 0, end: 2000 }, { title: "Linked two", start: 2000, end: 18_002 }]);
  await ok(OWNER, "/api/recordings/rec-w-two-files/chapters", "PUT", { chapters: null });
});

test("Look up chapters by ASIN: AudiobookDB's release; 10 s off, they are shown with the reason and not taken", async () => {
  const unlinked = await ok<RecordingChapters>(OWNER, "/api/recordings/rec-w-one-file/chapters");
  assert.equal(unlinked.release, null);
  const found = await ok<ChapterLookup>(OWNER, "/api/recordings/rec-w-one-file/chapters/lookup", "POST", { asin: "b0asinfix1" });
  assert.equal(found.from, "asin");
  assert.equal(found.releaseId, "rl-asin");
  assert.equal(found.chapters.length, 12);
  assert.deepEqual(found.chapters[1], { title: "Chapter 2", start: 600 });
  assert.equal(found.agrees, false);
  assert.equal(found.reason, "The release is 10:00:00 long and this recording 10:00:10; chapters are taken only when they agree within 5 seconds.");
  // By ASIN on the two-file recording (2 s off): taken.
  assert.equal((await ok<ChapterLookup>(OWNER, "/api/recordings/rec-w-two-files/chapters/lookup", "POST", { asin: "B0ASINFIX1" })).agrees, true);
  // An unknown ASIN, a malformed one, and no link and no ASIN.
  assert.equal((await request(OWNER, "/api/recordings/rec-w-one-file/chapters/lookup", "POST", { asin: "B000000000" })).statusCode, 404);
  assert.equal((await request(OWNER, "/api/recordings/rec-w-one-file/chapters/lookup", "POST", { asin: "short" })).statusCode, 400);
  const none = await request(OWNER, "/api/recordings/rec-w-one-file/chapters/lookup", "POST", {});
  assert.equal(none.statusCode, 400);
  assert.match(none.json().error, /Link this recording/);
});

test("a provider failure is named and changes nothing", async () => {
  control.offline = true;
  const response = await request(OWNER, "/api/recordings/rec-w-one-file/chapters/lookup", "POST", { asin: "B004GJ4ZPU" });
  control.offline = false;
  assert.equal(response.statusCode, 502);
  assert.match(response.json().error, /AudiobookDB could not be reached/);
  assert.equal((await ok<RecordingChapters>(OWNER, "/api/recordings/rec-w-one-file/chapters")).edited, false);
});

test("bad chapter lists are refused; an older client's empty body changes nothing", async () => {
  const url = "/api/recordings/rec-w-one-file/chapters";
  const before = await ok<RecordingChapters>(OWNER, url);
  assert.deepEqual(await ok<RecordingChapters>(OWNER, url, "PUT", {}), before);
  for (const chapters of [
    [{ title: "A", start: 0 }, { title: "B", start: 0 }],
    [{ title: "", start: 0 }],
    [{ title: "A", start: -1 }],
    [{ title: "A", start: 0 }, { title: "After the end", start: 36_010 }],
  ])
    assert.equal((await request(OWNER, url, "PUT", { chapters })).statusCode, 400, JSON.stringify(chapters));
  // A list equal to the files' is not kept as an edit.
  assert.equal((await ok<RecordingChapters>(OWNER, url, "PUT", { chapters: before.source })).edited, false);
  assert.equal((await request(OWNER, "/api/recordings/no-such/chapters")).statusCode, 404);
});

test("another account cannot read, edit or look up chapters (403), and reads the edited chapters as everyone does", async () => {
  const url = "/api/recordings/rec-w-one-file/chapters";
  await ok(OWNER, url, "PUT", { chapters: [{ title: "Start", start: 0 }, { title: "Second", start: 100 }] });
  assert.equal((await request(KIM, url)).statusCode, 403);
  assert.equal((await request(KIM, url, "PUT", { chapters: null })).statusCode, 403);
  assert.equal((await request(KIM, `${url}/lookup`, "POST", { asin: "B0ASINFIX1" })).statusCode, 403);
  assert.equal((await ok<RecordingChapters>(OWNER, url)).edited, true, "Kim's refused revert changed nothing");
  assert.deepEqual((await bookTracks(KIM, "w-one-file"))[0].chapters, [{ title: "Start", start: 0, end: 100 }, { title: "Second", start: 100, end: 36_010 }]);
  await ok(OWNER, url, "PUT", { chapters: null });
});
