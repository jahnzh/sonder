// The library by work (#485): `GET /api/library` and `GET /api/works/<workId>` on the fixture of
// `tests/library-works-fixture.ts`, read as the owner (the administrator) and as Sam (a user).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Book, LibraryWork } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";
import {
  DAY,
  OWNER_TOKEN,
  PLACEHOLDER_IDS,
  SAM_TOKEN,
  T0,
  removeRecording,
  writeLibraryFixture,
} from "./library-works-fixture.ts";

const temp = tempDir("sonder-library-works-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const { placeholderEditionSql } = await import("../server/placeholder-edition.ts");
writeLibraryFixture(sqlite, process.env.MEDIA_ROOT, hashToken);
// A placeholder named as the Hardcover import names one (`hardcover.ts`): edition hc-<n> in work
// work-hc-<n>. Written here, not in the shared fixture, so the `GET /api/books` pin stays as recorded.
sqlite
  .prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)")
  .run("work-hc-842", "From Hardcover", "Hardcover Author", "A book from your Hardcover library.", "From Hardcover", 2020);
sqlite
  .prepare(
    "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,?,?,?,?)",
  )
  .run("hc-842", "work-hc-842", "https://assets.hardcover.app/842.jpg", "Audio not added", null, null, 0, "Hardcover library");
sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,?)").run("recording-hc-842", "hc-842");
sqlite.prepare("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(1,?,'unread',?)").run("hc-842", T0 + 13 * DAY);
const { createApp } = await import("../server/app.ts");
const { filePresence } = await import("../server/library-works.ts");
const app = await createApp({ background: { manual: true } });
await removeRecording((options) => app.inject(options));
// The clock of the remembered file checks, moved by the tests.
let clock = Date.now();
filePresence.now = () => clock;

after(async () => {
  await app.close();
  sqlite.close();
});

const get = (url: string, token: string, headers: Record<string, string> = {}) =>
  app.inject({ url, headers, cookies: { sonder_session: token } });

async function library(token: string) {
  const response = await get("/api/library", token);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LibraryWork[];
}
async function work(token: string, workId: string) {
  const response = await get(`/api/works/${workId}`, token);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LibraryWork;
}
const find = (works: LibraryWork[], workId: string) => {
  const found = works.find((w) => w.workId === workId);
  assert.ok(found, `${workId} is listed`);
  return found;
};
const recordingIds = (w: LibraryWork) => w.recordings.map((r) => r.recordingId);

test("the library lists each of the owner's works once, the earliest added first", async () => {
  const works = await library(OWNER_TOKEN);
  assert.deepEqual(
    works.map((w) => w.workId),
    ["w-only", "w-beside", "w-two", "w-unplayed", "w-removed", "work-hc-842"],
  );
  assert.ok(works.every((w) => w.inLibrary));
});

test("a work with only a placeholder has no recordings and the placeholder's cover", async () => {
  const only = find(await library(OWNER_TOKEN), "w-only");
  assert.deepEqual(only, {
    workId: "w-only",
    title: "Only a Placeholder",
    author: "Author of Only a Placeholder",
    description: "About Only a Placeholder.",
    genre: "Fiction",
    year: 2001,
    cover: "https://assets.hardcover.app/only.jpg",
    inLibrary: true,
    addedAt: T0 + 1 * DAY,
    finished: false,
    completionOverride: null,
    chosenRecordingId: null,
    recordings: [],
    chosenEbookId: null,
    ebooks: [],
    readingSync: [],
    series: [],
    mediaState: { state: "missing", holdReason: "unreleased", acquisition: null },
    hardcover: null,
    wantToRead: false,
  });
  assert.deepEqual(await work(OWNER_TOKEN, "w-only"), only);
});

test("a placeholder beside a real edition lists only the real one", async () => {
  const beside = find(await library(OWNER_TOKEN), "w-beside");
  assert.deepEqual(recordingIds(beside), ["rec-beside"]);
  assert.equal(beside.recordings[0].editionId, "ed-beside");
  assert.equal(beside.chosenRecordingId, "rec-beside");
  assert.equal(beside.cover, "/covers/beside.jpg");
  // The earliest of the work's library rows is the placeholder's.
  assert.equal(beside.addedAt, T0 + 2 * DAY);
});

test("two recordings are one work, and the one with the newest place is chosen", async () => {
  const works = await library(OWNER_TOKEN);
  assert.equal(works.filter((w) => w.workId === "w-two").length, 1);
  const two = find(works, "w-two");
  assert.deepEqual(recordingIds(two), ["rec-two-a", "rec-two-b"]);
  // rec-two-a was added first and Sam's place in it is newer than any of the owner's.
  assert.equal(two.chosenRecordingId, "rec-two-b");
  assert.equal(two.cover, "/covers/two-b.jpg");
  assert.deepEqual(two.recordings[1], {
    recordingId: "rec-two-b",
    editionId: "ed-two-b",
    narrator: "Narrator B",
    language: "de",
    releaseTitle: "Release ed-two-b",
    sourceLabel: "Test source",
    cover: "/covers/two-b.jpg",
    duration: 600,
    tracks: [
      {
        chapters: [{ title: "Chapter 1", start: 0, end: 600 }],
        id: "t-two-b-0",
        recordingId: "rec-two-b",
        title: "Part 1",
        index: 0,
        duration: 600,
        source: "",
        sourceType: "remote",
        serverAvailable: false,
        deliverySource: "remote",
      },
    ],
    serverStored: false,
    faults: {},
    progress: { recordingId: "rec-two-b", trackId: "t-two-b-0", position: 60, duration: 600, updatedAt: T0 + 11 * DAY },
    serverCopy: null,
  });
});

test("each recording's tracks, duration and server copy match the book list's entry for it", async () => {
  const books = (await get("/api/books", OWNER_TOKEN)).json() as Book[];
  for (const w of await library(OWNER_TOKEN))
    for (const recording of w.recordings) {
      const book = books.find((b) => b.recordingId === recording.recordingId);
      assert.ok(book, recording.recordingId);
      assert.deepEqual(recording.tracks, book.tracks, recording.recordingId);
      assert.equal(recording.duration, book.duration);
      assert.equal(recording.serverStored, book.serverStored);
      assert.deepEqual(recording.faults, book.faults);
    }
  const two = find(await library(OWNER_TOKEN), "w-two");
  assert.deepEqual(
    two.recordings[0].tracks.map((t) => [t.id, t.serverAvailable, t.deliverySource]),
    [
      ["t-two-a-0", true, "server"],
      ["t-two-a-1", false, "remote"],
    ],
  );
});

test("without a place the recording added first is chosen", async () => {
  const unplayed = find(await library(OWNER_TOKEN), "w-unplayed");
  assert.deepEqual(recordingIds(unplayed), ["rec-unplayed-b", "rec-unplayed-a"]);
  assert.equal(unplayed.chosenRecordingId, "rec-unplayed-b");
  assert.equal(unplayed.cover, "/covers/unplayed-b.jpg");
});

test("a removed recording is not listed", async () => {
  const removed = find(await library(OWNER_TOKEN), "w-removed");
  assert.deepEqual(recordingIds(removed), ["rec-removed-keep"]);
  assert.deepEqual(recordingIds(await work(OWNER_TOKEN, "w-removed")), ["rec-removed-keep"]);
  const kept = removed.recordings[0];
  assert.deepEqual(kept.faults, {
    original: { reason: "bad-audio", note: "Crackles in part 1", updatedAt: T0 + 9 * DAY },
  });
  assert.deepEqual(kept.serverCopy, { status: "downloading", progress: 0.4, error: null });
});

test("a second user's rows, places and placeholders are not visible", async () => {
  const owner = await library(OWNER_TOKEN);
  assert.equal(owner.find((w) => w.workId === "w-sam"), undefined);
  const ownerTwo = find(owner, "w-two");
  assert.equal(ownerTwo.recordings[0].progress?.position, 120);

  const sam = await library(SAM_TOKEN);
  assert.deepEqual(
    sam.map((w) => w.workId),
    ["w-two", "w-sam"],
  );
  const samTwo = find(sam, "w-two");
  assert.deepEqual(recordingIds(samTwo), ["rec-two-a"]);
  assert.equal(samTwo.chosenRecordingId, "rec-two-a");
  assert.equal(samTwo.addedAt, T0 + 6 * DAY);
  assert.equal(samTwo.recordings[0].progress?.position, 300);
  const samOwn = find(sam, "w-sam");
  assert.deepEqual(samOwn.recordings, []);
  assert.equal(samOwn.cover, "https://assets.hardcover.app/sam.jpg");

  // Works only the owner has are outside Sam's library, with no recordings and no place of the owner's.
  const samUnplayed = await work(SAM_TOKEN, "w-unplayed");
  assert.equal(samUnplayed.inLibrary, false);
  assert.equal(samUnplayed.addedAt, null);
  assert.deepEqual(samUnplayed.recordings, []);
});

test("a work whose only edition is another user's placeholder follows the hidden placeholder rule", async () => {
  // Sam is not the administrator and has neither the book nor its Hardcover entry: not found.
  const hidden = await get("/api/works/w-only", SAM_TOKEN);
  assert.equal(hidden.statusCode, 404, hidden.body);
  // Beside a real edition the work is found, without the hidden placeholder's cover.
  const beside = await work(SAM_TOKEN, "w-beside");
  assert.deepEqual(beside.recordings, []);
  assert.equal(beside.cover, "/covers/beside.jpg");
  // The administrator sees every placeholder, as in the book list.
  const samsPlaceholder = await work(OWNER_TOKEN, "w-sam");
  assert.equal(samsPlaceholder.inLibrary, false);
  assert.deepEqual(samsPlaceholder.recordings, []);
  assert.equal(samsPlaceholder.cover, "https://assets.hardcover.app/sam.jpg");
});

test("a work outside the library comes through the one-work read", async () => {
  assert.deepEqual(await work(OWNER_TOKEN, "w-outside"), {
    workId: "w-outside",
    title: "Outside the Library",
    author: "Author of Outside the Library",
    description: "About Outside the Library.",
    genre: "Fiction",
    year: 2001,
    cover: "/covers/outside.jpg",
    inLibrary: false,
    addedAt: null,
    finished: false,
    completionOverride: null,
    chosenRecordingId: null,
    recordings: [],
    chosenEbookId: null,
    ebooks: [],
    readingSync: [],
    series: [],
    mediaState: null,
    hardcover: null,
    wantToRead: false,
  });
});

test("a work in the library reads the same through both routes", async () => {
  for (const w of await library(OWNER_TOKEN)) assert.deepEqual(await work(OWNER_TOKEN, w.workId), w);
  for (const w of await library(SAM_TOKEN)) assert.deepEqual(await work(SAM_TOKEN, w.workId), w);
});

test("an unknown work is not found", async () => {
  const response = await get("/api/works/no-such-work", OWNER_TOKEN);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "This book could not be found." });
});

/** Every string value in a JSON value, at any depth. */
function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

test("no value in the two reads is a placeholder edition's id or one of its recordings' ids", async () => {
  // A work's own id may contain a placeholder's (work-hc-842 holds hc-842); the contract is that no
  // field's value IS a placeholder edition's or recording's id.
  const placeholders = sqlite
    .prepare(
      `SELECT e.id AS editionId,r.id AS recordingId FROM audio_editions e LEFT JOIN recordings r ON r.edition_id=e.id
       WHERE ${placeholderEditionSql("e.id")}`,
    )
    .all() as { editionId: string; recordingId: string | null }[];
  const ids = new Set(placeholders.flatMap((p) => [p.editionId, ...(p.recordingId ? [p.recordingId] : [])]));
  for (const id of [...PLACEHOLDER_IDS, "hc-842", "recording-hc-101", "recording-hc-842"]) assert.ok(ids.has(id), id);
  const workIds = ["w-only", "w-beside", "w-two", "w-unplayed", "w-removed", "w-outside", "w-sam", "work-hc-842"];
  for (const token of [OWNER_TOKEN, SAM_TOKEN]) {
    const bodies = [(await get("/api/library", token)).json()];
    for (const workId of workIds) bodies.push((await get(`/api/works/${workId}`, token)).json());
    for (const value of stringValues(bodies)) assert.ok(!ids.has(value), `${value} is a placeholder's id`);
  }
  const hardcover = find(await library(OWNER_TOKEN), "work-hc-842");
  assert.deepEqual([hardcover.recordings, hardcover.chosenRecordingId], [[], null]);
  assert.equal((await work(OWNER_TOKEN, "work-hc-842")).workId, "work-hc-842");
});

test("a copy to the server is shown to the administrator only, on both reads", async () => {
  // rec-two-a is in the owner's library and in Sam's; Sam is not the administrator.
  const copy = (status: string, progress: number, error: string | null) =>
    sqlite
      .prepare(
        `INSERT INTO server_downloads(recording_id,book_id,status,progress,error,created_at,updated_at)
         VALUES('rec-two-a','ed-two-a',?,?,?,?,?) ON CONFLICT(recording_id) DO UPDATE SET
         status=excluded.status,progress=excluded.progress,error=excluded.error,updated_at=excluded.updated_at`,
      )
      .run(status, progress, error, T0, Date.now());
  const copies = async (token: string) => {
    const shown = [find(await library(token), "w-two"), await work(token, "w-two")].map(
      (w) => w.recordings.find((r) => r.recordingId === "rec-two-a")?.serverCopy,
    );
    return shown;
  };
  const tagOf = async (token: string) => String((await get("/api/library", token)).headers.etag);
  const unchangedFor = async (token: string, tag: string) =>
    (await get("/api/library", token, { "if-none-match": tag })).statusCode;
  try {
    copy("downloading", 0.23, null);
    const moving = { status: "downloading", progress: 0.23, error: null };
    assert.deepEqual(await copies(OWNER_TOKEN), [moving, moving]);
    assert.deepEqual(await copies(SAM_TOKEN), [null, null]);
    const ownerTag = await tagOf(OWNER_TOKEN);
    const samTag = await tagOf(SAM_TOKEN);

    copy("downloading", 0.5, null);
    assert.equal(await unchangedFor(OWNER_TOKEN, ownerTag), 200, "the administrator sees the copy move");
    assert.equal(await unchangedFor(SAM_TOKEN, samTag), 304, "Sam's tag does not follow the copy");

    const error = "ENOENT: no such file or directory, open '/srv/media/saved/rec-two-a-0.mp3.part'";
    copy("error", 0.5, error);
    const failed = { status: "error", progress: 0.5, error };
    assert.deepEqual(await copies(OWNER_TOKEN), [failed, failed]);
    assert.deepEqual(await copies(SAM_TOKEN), [null, null]);
    for (const url of ["/api/library", "/api/works/w-two"])
      assert.ok(!(await get(url, SAM_TOKEN)).body.includes("/srv/media"), url);
    assert.equal(await unchangedFor(SAM_TOKEN, samTag), 304, "Sam's tag does not follow a failed copy");
  } finally {
    sqlite.prepare("DELETE FROM server_downloads WHERE recording_id='rec-two-a'").run();
  }
});

test("the library's entity tag: not modified while unchanged, new after a new place or recording", async () => {
  const first = await get("/api/library", OWNER_TOKEN);
  const tag = String(first.headers.etag);
  assert.match(tag, /^"[0-9a-f]{32}"$/);
  assert.equal((await get("/api/library", OWNER_TOKEN)).headers.etag, tag, "two reads of an unchanged library");
  assert.notEqual((await get("/api/library", SAM_TOKEN)).headers.etag, tag, "per user");

  for (const ifNoneMatch of [tag, `W/${tag}`, `${tag.slice(0, -1)}-gzip"`, `"other", ${tag}`]) {
    const unchanged = await get("/api/library", OWNER_TOKEN, { "if-none-match": ifNoneMatch });
    assert.equal(unchanged.statusCode, 304, ifNoneMatch);
    assert.equal(unchanged.body, "");
    assert.equal(unchanged.headers.etag, tag);
  }

  // Sam's new place changes nothing the owner sees.
  const samPlace = await app.inject({
    method: "POST",
    url: "/api/progress",
    cookies: { sonder_session: SAM_TOKEN },
    payload: { recordingId: "rec-two-a", trackId: "t-two-a-0", position: 10, duration: 600, updatedAt: Date.now() },
  });
  assert.equal(samPlace.statusCode, 200, samPlace.body);
  assert.equal((await get("/api/library", OWNER_TOKEN, { "if-none-match": tag })).statusCode, 304);

  const place = await app.inject({
    method: "POST",
    url: "/api/progress",
    cookies: { sonder_session: OWNER_TOKEN },
    payload: { recordingId: "rec-unplayed-a", trackId: "t-unplayed-a-0", position: 42, duration: 600, updatedAt: Date.now() },
  });
  assert.equal(place.statusCode, 200, place.body);
  const afterPlace = await get("/api/library", OWNER_TOKEN, { "if-none-match": tag });
  assert.equal(afterPlace.statusCode, 200, "a new place");
  const placeTag = String(afterPlace.headers.etag);
  assert.notEqual(placeTag, tag);
  assert.equal(find(afterPlace.json(), "w-unplayed").chosenRecordingId, "rec-unplayed-a");

  const seeded = await app.inject({
    method: "POST",
    url: "/api/test/seed-local-audio",
    cookies: { sonder_session: OWNER_TOKEN },
    payload: {
      relPath: "fixture/seeded.mp3",
      editionId: "ed-seeded",
      recordingId: "rec-seeded",
      trackId: "t-seeded-0",
      workId: "w-outside",
    },
  });
  assert.equal(seeded.statusCode, 200, seeded.body);
  const afterRecording = await get("/api/library", OWNER_TOKEN, { "if-none-match": placeTag });
  assert.equal(afterRecording.statusCode, 200, "a new recording");
  const recordingTag = String(afterRecording.headers.etag);
  assert.notEqual(recordingTag, placeTag);
  assert.deepEqual(recordingIds(find(afterRecording.json(), "w-outside")), ["rec-seeded"]);

  await app.inject({ method: "DELETE", url: "/api/library/ed-two-a", cookies: { sonder_session: OWNER_TOKEN } });
  const afterRemoval = await get("/api/library", OWNER_TOKEN, { "if-none-match": recordingTag });
  assert.equal(afterRemoval.statusCode, 200, "a removed recording");
  assert.notEqual(afterRemoval.headers.etag, recordingTag);
  assert.deepEqual(recordingIds(find(afterRemoval.json(), "w-two")), ["rec-two-b"]);
});

test("two users with the same library get different entity tags", async () => {
  for (const [id, name] of [[3, "kim"], [4, "lee"]] as const) {
    sqlite
      .prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,NULL,'user',?)")
      .run(id, name, T0);
    sqlite
      .prepare("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)")
      .run(hashToken(`${name}-token`), Date.now() + DAY, id);
  }
  const kim = await get("/api/library", "kim-token");
  const lee = await get("/api/library", "lee-token");
  assert.equal(kim.body, "[]");
  assert.equal(lee.body, "[]");
  assert.notEqual(kim.headers.etag, lee.headers.etag);
  assert.equal((await get("/api/library", "lee-token", { "if-none-match": String(kim.headers.etag) })).statusCode, 200);
});

/**
 * Reads the library as `token`, makes `change`, and reads it again with the first tag: the second
 * read must be a new body with a new tag. Returns that body.
 */
async function afterChange(what: string, change: () => unknown, token = OWNER_TOKEN) {
  const tag = String((await get("/api/library", token)).headers.etag);
  assert.equal((await get("/api/library", token, { "if-none-match": tag })).statusCode, 304, `${what}: unchanged before`);
  await change();
  const changed = await get("/api/library", token, { "if-none-match": tag });
  assert.equal(changed.statusCode, 200, what);
  assert.notEqual(changed.headers.etag, tag, what);
  return changed.json() as LibraryWork[];
}
const track = (works: LibraryWork[], workId: string, trackId: string) => {
  const found = find(works, workId)
    .recordings.flatMap((r) => r.tracks)
    .find((t) => t.id === trackId);
  assert.ok(found, trackId);
  return found;
};

test("the entity tag follows a work joining the library", async () => {
  const works = await afterChange(
    "a new library row",
    () =>
      sqlite
        .prepare("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)")
        .run(2, "ed-beside", T0 + 30 * DAY),
    SAM_TOKEN,
  );
  assert.deepEqual(recordingIds(find(works, "w-beside")), ["rec-beside"]);
});

test("the entity tag follows a work's own fields", async () => {
  const works = await afterChange("a new title", () =>
    sqlite.prepare("UPDATE works SET title='Renamed' WHERE id='w-unplayed'").run(),
  );
  assert.equal(find(works, "w-unplayed").title, "Renamed");
});

test("the entity tag follows a fault", async () => {
  const works = await afterChange("a server fault", async () => {
    const marked = await app.inject({
      method: "PUT",
      url: "/api/recordings/rec-beside/faults/server",
      cookies: { sonder_session: OWNER_TOKEN },
      payload: { reason: "bad-audio", note: "Skips" },
    });
    assert.equal(marked.statusCode, 200, marked.body);
  });
  assert.equal(find(works, "w-beside").recordings[0].faults.server?.note, "Skips");
  assert.equal(track(works, "w-beside", "t-beside-0").deliverySource, "remote");
});

test("the entity tag follows a track's source", async () => {
  const works = await afterChange("a TorBox source", () =>
    sqlite.prepare("UPDATE tracks SET source_type='torbox' WHERE id='t-two-b-0'").run(),
  );
  assert.equal(track(works, "w-two", "t-two-b-0").deliverySource, "torbox");
});

test("the entity tag follows a copy to the server arriving and being removed through the server", async () => {
  const saved = join(process.env.MEDIA_ROOT!, "saved");
  mkdirSync(saved, { recursive: true });
  const path = join(saved, "t-two-b-0.mp3");
  // What the copy to the server does when a file is complete (`downloads.ts`): the file, then its row.
  const arrived = await afterChange("a server copy", () => {
    writeFileSync(path, "copied");
    sqlite
      .prepare("INSERT INTO media_copies(track_id,path,size,mime) VALUES(?,?,?,?)")
      .run("t-two-b-0", path, "copied".length, "audio/mpeg");
  });
  assert.equal(track(arrived, "w-two", "t-two-b-0").serverAvailable, true);
  const removed = await afterChange("a removed server copy", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/recordings/rec-two-b/server-copy",
      cookies: { sonder_session: OWNER_TOKEN },
    });
    assert.equal(response.statusCode, 200, response.body);
  });
  assert.equal(track(removed, "w-two", "t-two-b-0").serverAvailable, false);
});

test("a file removed or added outside the server shows within the file checks' time to live", async () => {
  const path = join(process.env.MEDIA_ROOT!, "fixture", "t-unplayed-a-0.mp3");
  // A server copy of a remote track, too.
  const copy = join(process.env.MEDIA_ROOT!, "saved", "t-removed-keep-0.mp3");
  writeFileSync(copy, "copied");
  sqlite
    .prepare("INSERT INTO media_copies(track_id,path,size,mime) VALUES(?,?,?,?)")
    .run("t-removed-keep-0", copy, "copied".length, "audio/mpeg");
  const tag = String((await get("/api/library", OWNER_TOKEN)).headers.etag);
  assert.equal(track((await get("/api/library", OWNER_TOKEN)).json(), "w-removed", "t-removed-keep-0").serverAvailable, true);
  unlinkSync(path);
  unlinkSync(copy);
  // Remembered: the next poll costs no file checks.
  assert.equal((await get("/api/library", OWNER_TOKEN, { "if-none-match": tag })).statusCode, 304);
  clock += filePresence.ttlMs;
  const gone = await get("/api/library", OWNER_TOKEN, { "if-none-match": tag });
  assert.equal(gone.statusCode, 200, "a file gone from the server");
  const goneTag = String(gone.headers.etag);
  assert.notEqual(goneTag, tag);
  assert.equal(track(gone.json(), "w-unplayed", "t-unplayed-a-0").serverAvailable, false);
  assert.equal(track(gone.json(), "w-removed", "t-removed-keep-0").serverAvailable, false);

  writeFileSync(path, "audio");
  writeFileSync(copy, "copied");
  clock += filePresence.ttlMs;
  const back = await get("/api/library", OWNER_TOKEN, { "if-none-match": goneTag });
  assert.equal(back.statusCode, 200, "a file back on the server");
  assert.equal(back.headers.etag, tag);
  assert.equal(track(back.json(), "w-unplayed", "t-unplayed-a-0").serverAvailable, true);
});
