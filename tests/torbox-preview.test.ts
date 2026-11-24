// A preview of a recording cached on TorBox (#889, A1 to A7): the routes in server/torbox-preview.ts through the app
// on a throwaway database. TorBox, its download links, AudioBookBay and Prowlarr are a fake in this file (a stubbed
// fetch, as the other server tests stub them): no request leaves the process.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-preview-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.TRANSMISSION_RPC_URL;
delete process.env.APP_PASSWORD;

const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { encrypt } = await import("../server/security.ts");
const { expirePreviews, previewRecord, PREVIEW_LIFETIME_MS } = await import("../server/torbox-preview.ts");

const MB = 1024 * 1024;
const AUDIO = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
type FakeFile = { id: number; name: string; size: number; short_name?: string };

/** The fake TorBox account: what it has cached, what is on the account, and what it was asked. */
const torbox = {
  cached: new Map<string, FakeFile[]>(),
  account: new Map<string, { id: number; files: FakeFile[] }>(),
  created: [] as { hash: string; onlyIfCached: string | null }[],
  deleted: [] as number[],
  links: [] as { torrentId: string | null; fileId: string | null }[],
  refuseDelete: false,
  refuseDuplicate: false,
  nextId: 900,
  reset() {
    this.cached.clear();
    this.account.clear();
    this.created.length = 0;
    this.deleted.length = 0;
    this.links.length = 0;
    this.refuseDelete = false;
    this.refuseDuplicate = false;
  },
  byId(id: number) {
    for (const [hash, torrent] of this.account) if (torrent.id === id) return { hash, ...torrent };
    return null;
  },
};
const ok = (data: unknown) => Response.json({ success: true, data });
const refused = (detail: string) => Response.json({ success: false, detail, data: null }, { status: 400 });

const chapters: FakeFile[] = [
  { id: 1, name: "Book/00 Opening Credits.mp3", size: 1 * MB },
  { id: 2, name: "Book/01 Chapter One.mp3", size: 40 * MB },
  { id: 3, name: "Book/02 Chapter Two.mp3", size: 40 * MB },
];

const original = globalThis.fetch;
const page = (hash: string) =>
  `<div class="post"><div class="postTitle"><h1>Preview Story - Ada Author</h1></div><div class="postInfo">Language: English</div><div class="postContent"><div class="desc">Read by <span class="narrator">Reader One</span><p>One release.</p></div><a href="magnet:?xt=urn:btih:${hash}">Magnet</a></div></div>`;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname.startsWith("audiobookbay.")) return new Response(page(/\/abss\/rec-([a-f0-9]{40})\//.exec(url.pathname)?.[1] ?? ""));
  if (url.origin === "http://prowlarr.fixture.test:9696" && url.pathname === "/api/v1/search")
    return Response.json([
      {
        guid: "https://tracker.test/preview",
        indexerId: 1,
        indexer: "Tracker",
        title: "Preview Story",
        size: 400_000_000,
        seeders: 9,
        publishDate: "2026-09-01T00:00:00Z",
        categories: [{ id: 3030, name: "Audio/Audiobook" }],
        protocol: "torrent",
        infoHash: "e".repeat(40),
        magnetUrl: `magnet:?xt=urn:btih:${"e".repeat(40)}`,
      },
    ]);
  if (url.hostname === "cdn.torbox.fixture") {
    const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get("range") ?? "");
    if (!range) return new Response(AUDIO, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(AUDIO.length), "Accept-Ranges": "bytes" } });
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : AUDIO.length - 1;
    return new Response(AUDIO.subarray(start, end + 1), {
      status: 206,
      headers: { "Content-Type": "audio/mpeg", "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${AUDIO.length}`, "Accept-Ranges": "bytes" },
    });
  }
  if (url.hostname === "api.torbox.app") {
    const path = url.pathname.replace("/v1/api/", "");
    if (path === "torrents/checkcached") {
      const hashes = (url.searchParams.get("hash") ?? "").split(",");
      return ok(hashes.filter((hash) => torbox.cached.has(hash)).map((hash) => ({ hash, name: "Preview Story" })));
    }
    if (path === "torrents/createtorrent") {
      const form = init?.body as FormData;
      const magnet = String(form.get("magnet"));
      const hash = /btih:([a-f0-9]{40})/i.exec(magnet)![1].toLowerCase();
      torbox.created.push({ hash, onlyIfCached: form.get("add_only_if_cached") as string | null });
      const there = torbox.account.get(hash);
      if (there) return torbox.refuseDuplicate ? refused("This torrent is already in your list.") : ok({ torrent_id: there.id, hash });
      if (!torbox.cached.has(hash)) return refused("This torrent is not cached.");
      const id = torbox.nextId++;
      torbox.account.set(hash, { id, files: torbox.cached.get(hash)! });
      return ok({ torrent_id: id, hash });
    }
    if (path === "torrents/mylist") {
      const id = url.searchParams.get("id");
      if (id === null) return ok([...torbox.account].map(([hash, torrent]) => ({ id: torrent.id, hash, download_present: true, files: torrent.files })));
      const torrent = torbox.byId(Number(id));
      return torrent ? ok({ id: torrent.id, hash: torrent.hash, download_present: true, files: torrent.files }) : refused("Not found.");
    }
    if (path === "torrents/requestdl") {
      torbox.links.push({ torrentId: url.searchParams.get("torrent_id"), fileId: url.searchParams.get("file_id") });
      return ok(`https://cdn.torbox.fixture/${url.searchParams.get("torrent_id")}/${url.searchParams.get("file_id")}`);
    }
    if (path === "torrents/controltorrent") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.operation, "delete");
      if (torbox.refuseDelete) return Response.json({ success: false, detail: "Try again later.", data: null }, { status: 503 });
      torbox.deleted.push(body.torrent_id);
      const torrent = torbox.byId(body.torrent_id);
      if (torrent) torbox.account.delete(torrent.hash);
      return ok(null);
    }
    throw new Error(`Unexpected TorBox request: ${url}`);
  }
  throw new Error(`Unexpected external request: ${url}`);
};

db.insert(s.settings).values({ key: "torbox", value: encrypt("preview-test-key") }).run();
db.insert(s.settings).values({ key: "prowlarr", value: encrypt("fixture-prowlarr-key") }).run();
db.insert(s.settings).values({ key: "prowlarrUrl", value: "http://prowlarr.fixture.test:9696" }).run();

// The download loop and the preview loop never tick on their own here: the tests tick the previews' with a clock.
let app = await createApp({ background: { manual: true } });

after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
});

let counter = 0;
/** A new release's hash, cached on TorBox with `files` (Get's chapters by default). */
function cachedRelease(files: FakeFile[] = chapters) {
  const hash = (++counter).toString(16).padStart(40, "a");
  torbox.cached.set(hash, files);
  return hash;
}
const slug = (hash: string) => `rec-${hash}`;
const start = (hash: string) => app.inject({ method: "POST", url: "/api/discover/abb/preview", payload: { slug: slug(hash) } });
const end = (id: string) => app.inject({ method: "DELETE", url: `/api/discover/previews/${id}` });
const bytes = (id: string, range?: string) => app.inject({ method: "GET", url: `/api/discover/previews/${id}/audio`, headers: range ? { range } : {} });
const records = () => db.select().from(s.torboxPreviews).all();
async function started(hash: string) {
  const response = await start(hash);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().id as string;
}
const counts = () =>
  Object.fromEntries(
    ["acquisitions", "user_acquisitions", "user_library", "works", "audio_editions", "recordings", "tracks", "progress", "user_progress"].flatMap((table) => {
      try {
        return [[table, (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]];
      } catch {
        return [];
      }
    }),
  );

beforeEach(() => {
  torbox.reset();
  sqlite.exec("DELETE FROM torbox_previews");
});

test("a preview answers an id only, plays the release's first chapter, and makes nothing in the library or Activity", async () => {
  const hash = cachedRelease();
  const before = counts();
  const activity = (await app.inject("/api/acquisitions")).json();
  const response = await start(hash);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(Object.keys(response.json()), ["id"], "nothing the client could turn into an address");
  assert.deepEqual(torbox.created, [{ hash, onlyIfCached: "true" }], "put on TorBox only if cached");
  const record = previewRecord(response.json().id)!;
  assert.equal(record.fileId, 2, "the credits file passed over");
  assert.equal(record.added, true);
  assert.equal(record.hash, hash);
  assert.equal(record.torrentId, torbox.account.get(hash)!.id);
  assert.deepEqual(counts(), before, "no library row, work, recording, track, acquisition or progress");
  assert.deepEqual((await app.inject("/api/acquisitions")).json(), activity, "nothing in Activity");
});

test("the Prowlarr result is previewed as Prowlarr's add route names it", async () => {
  torbox.cached.set("e".repeat(40), chapters);
  const search = (await app.inject("/api/discover/prowlarr/releases?q=preview")).json();
  const id = search.results[0].id as string;
  const response = await app.inject({ method: "POST", url: "/api/discover/prowlarr/preview", payload: { id } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(previewRecord(response.json().id)?.hash, "e".repeat(40));
  assert.equal((await app.inject({ method: "POST", url: "/api/discover/prowlarr/preview", payload: { id: "https://elsewhere.test/a.mp3" } })).statusCode, 400);
});

test("a release TorBox has not cached is refused and nothing is recorded", async () => {
  const response = await start("f".repeat(40));
  assert.notEqual(response.statusCode, 200);
  assert.deepEqual(records(), []);
  assert.deepEqual([...torbox.account.keys()], []);
});

test("a release without audio has nothing to preview, and what the preview added is removed", async () => {
  const hash = cachedRelease([{ id: 1, name: "Book/cover.jpg", size: 2 * MB }]);
  const response = await start(hash);
  assert.equal(response.statusCode, 422);
  assert.match(response.json().error, /no audio file to preview/);
  assert.equal(torbox.deleted.length, 1);
  assert.deepEqual(records(), []);
});

test("the bytes route answers ranges from TorBox's address for the stored file, and refuses an unknown or ended id", async () => {
  const hash = cachedRelease();
  const id = await started(hash);
  const ranged = await bytes(id, "bytes=10-19");
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.headers["content-range"], `bytes 10-19/${AUDIO.length}`);
  assert.deepEqual([...ranged.rawPayload], [...AUDIO.subarray(10, 20)]);
  const whole = await bytes(id);
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.rawPayload.length, AUDIO.length);
  assert.equal(whole.headers["accept-ranges"], "bytes");
  const record = previewRecord(id)!;
  assert.deepEqual(torbox.links.at(-1), { torrentId: String(record.torrentId), fileId: String(record.fileId) });
  // An address the client names is not read: the record's file is played whatever the query says.
  await app.inject({ method: "GET", url: `/api/discover/previews/${id}/audio?url=https://elsewhere.test/a.mp3&file_id=3` });
  assert.deepEqual(torbox.links.at(-1), { torrentId: String(record.torrentId), fileId: "2" });
  assert.equal((await bytes("00000000-0000-4000-8000-000000000000")).statusCode, 404);
  await end(id);
  assert.equal((await bytes(id)).statusCode, 404);
});

test("guard: the preview put the release there and nothing else uses it: removed", async () => {
  const id = await started(cachedRelease());
  const torrentId = previewRecord(id)!.torrentId;
  assert.equal((await end(id)).statusCode, 200);
  assert.deepEqual(torbox.deleted, [torrentId]);
  assert.deepEqual(records(), []);
});

test("guard: the release was on the account before the preview: kept", async () => {
  const hash = cachedRelease();
  torbox.account.set(hash, { id: 777, files: chapters });
  const id = await started(hash);
  assert.deepEqual(torbox.created, [], "found there, not added");
  assert.equal(previewRecord(id)?.added, false);
  await end(id);
  assert.deepEqual(torbox.deleted, []);
  assert.deepEqual(records(), [], "only the record goes");
  assert.ok(torbox.account.has(hash));
});

test("guard: a recording of the library names the torrent: kept", async () => {
  const hash = cachedRelease();
  const id = await started(hash);
  const torrentId = previewRecord(id)!.torrentId;
  // A recording made another way (the TorBox import) whose track's stored source names the torrent.
  db.insert(s.works).values({ id: "work-guard", title: "Guard", author: "A", description: "", genre: "", year: 2020 }).run();
  db.insert(s.editions).values({ id: "edition-guard", workId: "work-guard", cover: "", narrator: "N", rating: 0, sourceLabel: "TorBox" }).run();
  db.insert(s.recordings).values({ id: "recording-guard", editionId: "edition-guard" }).run();
  db.insert(s.tracks).values({ id: "track-guard", recordingId: "recording-guard", index: 0, title: "1", duration: 0, source: JSON.stringify({ torrentId, fileId: 2 }), sourceType: "torbox" }).run();
  try {
    await end(id);
    assert.deepEqual(torbox.deleted, []);
    assert.deepEqual(records(), []);
  } finally {
    sqlite.exec("DELETE FROM tracks WHERE id='track-guard'; DELETE FROM recordings WHERE id='recording-guard'; DELETE FROM audio_editions WHERE id='edition-guard'; DELETE FROM works WHERE id='work-guard';");
  }
});

test("guard: an acquisition names the hash: kept", async () => {
  const hash = cachedRelease();
  const id = await started(hash);
  sqlite
    .prepare("INSERT INTO acquisitions(id,hash,magnet,backend,remote_id,title,author,cover,status,created_at,updated_at) VALUES('acq-guard',?,?,'local',?,'T','A','','downloading',?,?)")
    .run(hash, `magnet:?xt=urn:btih:${hash}`, hash, Date.now(), Date.now());
  try {
    await end(id);
    assert.deepEqual(torbox.deleted, []);
    assert.deepEqual(records(), []);
  } finally {
    sqlite.exec("DELETE FROM acquisitions WHERE id='acq-guard'");
  }
});

test("guard: another preview still uses the release: kept, and removed when that one ends", async () => {
  const hash = cachedRelease();
  const first = await started(hash);
  const second = await started(hash);
  assert.equal(torbox.created.length, 1, "Preview again does not add the release twice");
  assert.equal(previewRecord(second)?.added, true, "the release is there because of a preview");
  await end(first);
  assert.deepEqual(torbox.deleted, []);
  assert.deepEqual(records().map((record) => record.id), [second]);
  await end(second);
  assert.equal(torbox.deleted.length, 1);
  assert.deepEqual(records(), []);
});

test("guard: Get after a preview keeps the release, Get answers as it does without one, and the preview's end removes nothing", async () => {
  const plain = cachedRelease();
  const withoutPreview = (await app.inject({ method: "POST", url: "/api/discover/abb/add", payload: { slug: slug(plain) } })).json();
  const hash = cachedRelease();
  const id = await started(hash);
  const torrentId = previewRecord(id)!.torrentId;
  const got = await app.inject({ method: "POST", url: "/api/discover/abb/add", payload: { slug: slug(hash) } });
  assert.equal(got.statusCode, 200, got.body);
  const answer = got.json();
  assert.deepEqual(Object.keys(answer).sort(), Object.keys(withoutPreview).sort());
  assert.equal(answer.backend, "torbox");
  assert.equal(answer.status, withoutPreview.status);
  assert.equal(answer.remoteId, String(torrentId), "Get uses the release the preview put there");
  assert.deepEqual(records(), [], "the preview's record is given up");
  await end(id);
  await expirePreviews({ now: () => Date.now() + 2 * PREVIEW_LIFETIME_MS });
  assert.deepEqual(torbox.deleted, []);
  assert.ok(torbox.account.has(hash));
});

test("Get after a preview when TorBox will not add the release twice still takes the previewed one", async () => {
  const hash = cachedRelease();
  const id = await started(hash);
  const torrentId = previewRecord(id)!.torrentId;
  torbox.refuseDuplicate = true;
  const answer = (await app.inject({ method: "POST", url: "/api/discover/abb/add", payload: { slug: slug(hash) } })).json();
  assert.equal(answer.backend, "torbox");
  assert.equal(answer.remoteId, String(torrentId));
});

test("a preview ends by itself 30 minutes after it was made (an injected clock), not before", async () => {
  const id = await started(cachedRelease());
  const made = previewRecord(id)!.createdAt;
  await expirePreviews({ now: () => made + PREVIEW_LIFETIME_MS - 60_000 });
  assert.equal(previewRecord(id)?.endedAt, null, "29 minutes: still playing");
  assert.equal((await bytes(id, "bytes=0-0")).statusCode, 206);
  await expirePreviews({ now: () => made + PREVIEW_LIFETIME_MS });
  assert.equal(torbox.deleted.length, 1);
  assert.deepEqual(records(), []);
});

test("a removal TorBox refuses is not reported, and the loop tries it again", async () => {
  const id = await started(cachedRelease());
  torbox.refuseDelete = true;
  const response = await end(id);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  const waiting = previewRecord(id)!;
  assert.notEqual(waiting.endedAt, null);
  assert.ok(waiting.removalError);
  assert.equal((await bytes(id)).statusCode, 404, "ended: no longer played");
  torbox.refuseDelete = false;
  await expirePreviews();
  assert.equal(torbox.deleted.length, 1);
  assert.deepEqual(records(), []);
});

test("an older client's requests and an unknown id: the end route answers ok and touches nothing", async () => {
  assert.deepEqual((await end("00000000-0000-4000-8000-000000000000")).json(), { ok: true });
  assert.deepEqual((await end("not-an-id")).json(), { ok: true });
  assert.equal((await app.inject({ method: "POST", url: "/api/discover/abb/preview", payload: {} })).statusCode, 400);
  assert.deepEqual(torbox.deleted, []);
});

test("a preview's record survives a restart: the new server serves it and ends it at its start", async () => {
  const id = await started(cachedRelease());
  const made = previewRecord(id)!.createdAt;
  await app.close();
  app = await createApp({ background: { manual: true } });
  assert.equal((await bytes(id, "bytes=0-3")).statusCode, 206, "the restarted server still plays it");
  // The loop runs at the start: a preview made over 30 minutes before the restart ends then.
  sqlite.prepare("UPDATE torbox_previews SET created_at=? WHERE id=?").run(made - PREVIEW_LIFETIME_MS, id);
  await expirePreviews();
  assert.equal(torbox.deleted.length, 1);
  assert.deepEqual(records(), []);
});
