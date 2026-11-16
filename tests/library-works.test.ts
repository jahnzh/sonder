// The library by work (#485): `GET /api/library` and `GET /api/works/<workId>` on the fixture of
// `tests/library-works-fixture.ts`, read as the owner (the administrator) and as Sam (a user).
import { test, after } from "node:test";
import assert from "node:assert/strict";
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
writeLibraryFixture(sqlite, process.env.MEDIA_ROOT, hashToken);
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
await removeRecording((options) => app.inject(options));

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
    ["w-only", "w-beside", "w-two", "w-unplayed", "w-removed"],
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
    chosenRecordingId: null,
    recordings: [],
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
    chosenRecordingId: null,
    recordings: [],
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

test("no response of the two reads contains a placeholder's id", async () => {
  const workIds = ["w-only", "w-beside", "w-two", "w-unplayed", "w-removed", "w-outside", "w-sam"];
  for (const token of [OWNER_TOKEN, SAM_TOKEN]) {
    const bodies = [(await get("/api/library", token)).body];
    for (const workId of workIds) bodies.push((await get(`/api/works/${workId}`, token)).body);
    for (const body of bodies)
      for (const id of PLACEHOLDER_IDS) assert.ok(!body.includes(id), `${id} in ${body.slice(0, 200)}`);
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
