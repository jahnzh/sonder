// A preview of a recording cached on TorBox (#889): the routes in server/torbox-preview.ts through the app on a
// throwaway database. Nothing is ever removed from TorBox (removal is a later ticket): every TorBox call is recorded. TorBox, its download links, AudioBookBay and Prowlarr are a fake in this file (a stubbed
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
  links: [] as { torrentId: string | null; fileId: string | null }[],
  /** Every request to TorBox's API, by path: the proof that nothing is ever removed. */
  calls: [] as string[],
  nextId: 900,
  reset() {
    this.cached.clear();
    this.account.clear();
    this.created.length = 0;
    this.links.length = 0;
    this.calls.length = 0;
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
    torbox.calls.push(path);
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
      if (there) return ok({ torrent_id: there.id, hash });
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
  assert.equal(record.added, true, "the best-known fact, kept for the removal ticket");
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
});

test("the routes' bodies and the preview id are checked as the add routes check theirs", async () => {
  for (const [method, url, payload] of [
    ["POST", "/api/discover/prowlarr/preview", { id: "https://elsewhere.test/a.mp3" }],
    ["POST", "/api/discover/prowlarr/preview", {}],
    ["POST", "/api/discover/abb/preview", {}],
    ["POST", "/api/discover/abb/preview", { slug: "../etc/passwd" }],
    ["POST", "/api/discover/abb/preview", { slug: 7 }],
    ["GET", "/api/discover/previews/not-an-id/audio", undefined],
    ["DELETE", "/api/discover/previews/not-an-id", undefined],
  ] as const) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 400, `${method} ${url} ${JSON.stringify(payload)}: ${response.body}`);
  }
  assert.deepEqual(records(), []);
  assert.deepEqual(torbox.calls, [], "refused before TorBox is asked");
});

test("a release TorBox has not cached is refused and nothing is recorded", async () => {
  const response = await start("f".repeat(40));
  assert.notEqual(response.statusCode, 200);
  assert.deepEqual(records(), []);
  assert.deepEqual([...torbox.account.keys()], []);
});

test("a release without audio has nothing to preview; its record ends, and the release stays on TorBox", async () => {
  const hash = cachedRelease([{ id: 1, name: "Book/cover.jpg", size: 2 * MB }]);
  const response = await start(hash);
  assert.equal(response.statusCode, 422);
  assert.match(response.json().error, /no audio file to preview/);
  assert.equal(records().length, 1);
  assert.notEqual(records()[0].endedAt, null);
  assert.ok(torbox.account.has(hash));
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
  assert.deepEqual((await end(id)).json(), { ok: true });
  assert.equal((await bytes(id)).statusCode, 404);
});

test("a release already on the account is played, not added; added stays false", async () => {
  const hash = cachedRelease();
  torbox.account.set(hash, { id: 777, files: chapters });
  const id = await started(hash);
  assert.deepEqual(torbox.created, []);
  assert.equal(previewRecord(id)?.torrentId, 777);
  assert.equal(previewRecord(id)?.added, false);
});

test("no request to TorBox's controltorrent is ever made by a preview's start, end or timer", async () => {
  const kept = await started(cachedRelease());
  const second = await started(cachedRelease());
  await start(cachedRelease([{ id: 1, name: "a/cover.jpg", size: MB }]));
  await end(kept);
  await end(kept);
  await end("00000000-0000-4000-8000-000000000000");
  expirePreviews({ now: () => Date.now() + 2 * PREVIEW_LIFETIME_MS });
  assert.equal(previewRecord(second)?.endedAt !== null, true);
  // The loop's own tick, as the runner calls it.
  const { torboxPreviewLoop } = await import("../server/torbox-preview.ts");
  await torboxPreviewLoop({ warn: () => {} }).tick();
  assert.ok(torbox.calls.length > 0, "the stub saw the starts");
  assert.deepEqual(
    torbox.calls.filter((path) => !["torrents/mylist", "torrents/createtorrent", "torrents/checkcached", "torrents/requestdl"].includes(path)),
    [],
  );
  assert.equal(torbox.calls.filter((path) => path.includes("controltorrent")).length, 0);
  assert.equal(torbox.account.size, 3, "every previewed release stays on the account");
});

test("Get after a preview answers as it does without one", async () => {
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
  assert.equal(answer.remoteId, String(torrentId), "TorBox answers for the release that is already there");
  await end(id);
  assert.ok(torbox.account.has(hash));
  assert.equal(torbox.calls.filter((path) => path.includes("controltorrent")).length, 0);
});

test("a preview ends by itself 30 minutes after it was made (an injected clock), not before", async () => {
  const id = await started(cachedRelease());
  const made = previewRecord(id)!.createdAt;
  expirePreviews({ now: () => made + PREVIEW_LIFETIME_MS - 60_000 });
  assert.equal(previewRecord(id)?.endedAt, null, "29 minutes: still playing");
  assert.equal((await bytes(id, "bytes=0-0")).statusCode, 206);
  expirePreviews({ now: () => made + PREVIEW_LIFETIME_MS });
  assert.equal(previewRecord(id)?.endedAt, made + PREVIEW_LIFETIME_MS);
  assert.equal((await bytes(id, "bytes=0-0")).statusCode, 404);
});

test("the loop's tick logs a warning instead of throwing when ending previews fails", async () => {
  const { torboxPreviewLoop } = await import("../server/torbox-preview.ts");
  const warnings: unknown[] = [];
  sqlite.exec("ALTER TABLE torbox_previews RENAME TO torbox_previews_away");
  try {
    torboxPreviewLoop({ warn: (...args: unknown[]) => void warnings.push(args) } as never).tick();
  } finally {
    sqlite.exec("ALTER TABLE torbox_previews_away RENAME TO torbox_previews");
  }
  assert.equal(warnings.length, 1);
});

test("a preview's record survives a restart: the new server serves it and ends it at its start", async () => {
  const id = await started(cachedRelease());
  const made = previewRecord(id)!.createdAt;
  await app.close();
  app = await createApp({ background: { manual: true } });
  assert.equal((await bytes(id, "bytes=0-3")).statusCode, 206, "the restarted server still plays it");
  sqlite.prepare("UPDATE torbox_previews SET created_at=? WHERE id=?").run(made - PREVIEW_LIFETIME_MS, id);
  expirePreviews();
  assert.notEqual(previewRecord(id)?.endedAt, null);
  assert.equal((await bytes(id)).statusCode, 404);
});
