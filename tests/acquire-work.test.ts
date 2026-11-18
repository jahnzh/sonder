// A magnet link pasted for a book (#606, spec #600 "What the server answers and accepts"): `POST /api/acquire` and its
// older alias `POST /api/torbox/magnet` take an optional `workId` and pass it to `acquire()`. With it the acquisition
// carries the work and its import attaches the recording to that work, not to a new book named after the torrent; an
// unknown one is refused before anything is fetched or written; without it the answer is today's. TorBox is a fixture
// that has every torrent cached: nothing is ever downloaded.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-acquire-work-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../server/security.ts");
const { refreshAcquisition } = await import("../server/acquisitions.ts");
const { getWorkMediaState } = await import("../server/work-media-state.ts");

const app = await createApp({ background: { manual: ["acquisitions"] } });

const WORK = "work-pasted";
const fetched: string[] = [];
let torrentId = 900;
const original = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  fetched.push(url.pathname);
  if (url.hostname !== "api.torbox.app") throw new Error(`Unexpected external request: ${url}`);
  let data: unknown;
  if (url.pathname.endsWith("checkcached")) data = [{ hash: url.searchParams.get("hash") }];
  else if (url.pathname.endsWith("createtorrent")) data = { torrent_id: torrentId++ };
  else if (url.pathname.endsWith("mylist"))
    data = { download_present: true, files: [{ id: 1, name: "Pasted/01 Chapter.mp3", short_name: "01 Chapter.mp3" }, { id: 2, name: "Pasted/02 Chapter.mp3", short_name: "02 Chapter.mp3" }] };
  else throw new Error(`Unexpected TorBox request: ${url}`);
  return Response.json({ success: true, data });
};

db.insert(s.settings).values({ key: "torbox", value: encrypt("acquire-work-key") }).run();
db.insert(s.works).values({ id: WORK, title: "The Pasted Book", author: "Ada Author", description: "", genre: "", year: 2020 }).run();
sqlite.prepare("INSERT INTO users(id,username,role,password_hash,created_at) VALUES(2,'other','user','x',?)").run(Date.now());

after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
});

beforeEach(() => {
  fetched.length = 0;
});

const magnetFor = (hash: string, name: string) => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
const acquisitions = () => db.select().from(s.acquisitions).all();

for (const url of ["/api/acquire", "/api/torbox/magnet"]) {
  const hash = (url === "/api/acquire" ? "d" : "e").repeat(40);
  const other = (url === "/api/acquire" ? "1" : "2").repeat(40);
  // A torrent named unlike the book, one name per route.
  const name = `Some Torrent Name [MP3] ${url}`;

  test(`${url} with a workId: the acquisition carries it and its import attaches the recording to that book`, async () => {
    const response = await app.inject({ method: "POST", url, payload: { magnet: magnetFor(hash, name), workId: WORK } });
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json();
    assert.equal(job.workId, WORK);
    assert.equal(job.hash, hash);
    assert.equal(job.backend, "torbox");
    assert.equal(db.select().from(s.acquisitions).where(eq(s.acquisitions.id, job.id)).get()?.workId, WORK);
    // The acquisition is this user's only.
    assert.deepEqual(db.select().from(s.userAcquisitions).where(eq(s.userAcquisitions.acquisitionId, job.id)).all().map((row) => row.userId), [1]);

    // TorBox's fixture has the files at once: acquire() imports them itself; a refresh changes nothing.
    await refreshAcquisition(job.id);
    const done = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, job.id)).get()!;
    assert.equal(done.status, "ready", done.error ?? "");
    const edition = db.select().from(s.editions).where(eq(s.editions.id, done.bookId!)).get()!;
    assert.equal(edition.workId, WORK);
    const recording = db.select().from(s.recordings).where(eq(s.recordings.editionId, edition.id)).get()!;
    assert.equal(db.select().from(s.tracks).where(eq(s.tracks.recordingId, recording.id)).all().length, 2);
    // No new book named after the torrent.
    assert.equal(db.select().from(s.works).where(eq(s.works.title, name)).all().length, 0);
    assert.equal(db.select().from(s.works).where(eq(s.works.id, WORK)).get()?.title, "The Pasted Book");
    // In the administrator's library, not in the other account's; the other account's view of the book is unchanged.
    assert.equal(getWorkMediaState(2, WORK), null);
    const rows = db.select().from(s.userLibrary).where(eq(s.userLibrary.bookId, edition.id)).all();
    assert.deepEqual(rows.map((row) => row.userId), [1]);
    const library = await app.inject({ method: "GET", url: "/api/works/" + WORK });
    assert.equal(library.statusCode, 200, library.body);
    assert.ok(JSON.stringify(library.json()).includes(recording.id), "the book lists the new recording");
  });

  test(`${url} with an unknown workId is refused before anything is fetched or written`, async () => {
    const before = acquisitions().length;
    const response = await app.inject({ method: "POST", url, payload: { magnet: magnetFor(other, name), workId: "work-nobody" } });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "The selected book could not be found.");
    assert.equal(acquisitions().length, before);
    assert.deepEqual(fetched, []);
  });

  test(`${url} without a workId does what it does today: a book named after the torrent`, async () => {
    const response = await app.inject({ method: "POST", url, payload: { magnet: magnetFor(other, name) } });
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json();
    assert.equal(job.workId, null);
    assert.equal(job.title, name);
    assert.equal("replaced" in job, false);
    await refreshAcquisition(job.id);
    const done = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, job.id)).get()!;
    assert.equal(done.status, "ready", done.error ?? "");
    const edition = db.select().from(s.editions).where(eq(s.editions.id, done.bookId!)).get()!;
    assert.notEqual(edition.workId, WORK);
    assert.equal(db.select().from(s.works).where(eq(s.works.id, edition.workId)).get()?.title, name);
  });
}

test("a magnet link without a v1 info hash is refused with the sentence the sheet shows, workId or not", async () => {
  for (const payload of [{ magnet: "magnet:?dn=nothing", workId: WORK }, { magnet: "magnet:?xt=urn:btih:short" }]) {
    const response = await app.inject({ method: "POST", url: "/api/acquire", payload });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "This magnet link needs a valid BitTorrent v1 info hash.");
  }
});
