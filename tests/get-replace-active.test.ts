// Replacing the download on its way (#603, spec #600 "What the server answers and accepts"): `replaceActive: true` on
// POST /api/discover/abb/add, /api/discover/prowlarr/add, /api/acquire and /api/torbox/magnet, through the app
// instance on a throwaway database. The new acquisition goes to TorBox's fixture (never a real download); the local
// torrent client is a fixture that records what it is told to stop.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-get-replace-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.TRANSMISSION_RPC_URL = "http://transmission.fixture.test/transmission/rpc";
delete process.env.TRANSMISSION_USERNAME;
delete process.env.APP_PASSWORD;

const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../server/security.ts");
const { REPLACED_ERROR } = await import("../server/acquisitions.ts");
const { getWorkMediaState } = await import("../server/work-media-state.ts");

// The download loop never ticks here: it would ask the fixture client about the seeded torrents.
const app = await createApp({ background: { manual: ["acquisitions"] } });

const WORK = "work-get-replace";
const PREVIOUS = "a".repeat(40);
const NEW = "b".repeat(40);
const OTHER = "c".repeat(40);

const stopped: unknown[] = [];
const original = globalThis.fetch;
const detail = (hash: string) =>
  `<div class="post"><div class="postTitle"><h1>Replace Story - Ada Author</h1></div><div class="postInfo">Language: English<span>Keywords: Fantasy</span></div><div class="postContent"><p>Shared by: uploader</p><div class="desc">Written by <span class="author">Ada Author</span><br>Read by <span class="narrator">Reader One</span><br>Format: <span class="format">M4B</span><br>Bitrate: <span class="bitrate">64 Kbps</span><p>One release.</p></div><a href="magnet:?xt=urn:btih:${hash}">Magnet</a></div></div>`;
let torrentId = 500;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname.startsWith("audiobookbay.")) {
    const slug = /\/abss\/([^/]+)\//.exec(url.pathname)?.[1] ?? "";
    return new Response(detail(slug.replace(/^rec-/, "")));
  }
  if (url.origin === "http://prowlarr.fixture.test:9696") {
    if (url.pathname === "/api/v1/search")
      return Response.json(
        [PREVIOUS, NEW, OTHER].map((hash) => ({
          guid: `https://tracker.test/${hash}`,
          indexerId: 1,
          indexer: "Tracker",
          title: `Replace Story ${hash.slice(0, 1)}`,
          size: 400_000_000,
          seeders: 9,
          publishDate: "2026-09-01T00:00:00Z",
          categories: [{ id: 3030, name: "Audio/Audiobook" }],
          protocol: "torrent",
          infoHash: hash,
          magnetUrl: `magnet:?xt=urn:btih:${hash}`,
        })),
      );
    return new Response("", { status: 404 });
  }
  if (url.hostname === "transmission.fixture.test") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.method === "torrent-stop") stopped.push(body.arguments);
    return Response.json({ result: "success", arguments: {} });
  }
  if (url.hostname === "api.torbox.app") {
    let data: unknown;
    if (url.pathname.endsWith("checkcached")) data = [];
    else if (url.pathname.endsWith("createtorrent")) data = { torrent_id: torrentId++ };
    // Still on its way at TorBox: the new acquisition stays queued.
    else if (url.pathname.endsWith("mylist")) data = { download_present: false, files: [] };
    else throw new Error(`Unexpected TorBox request: ${url}`);
    return Response.json({ success: true, data });
  }
  throw new Error(`Unexpected external request: ${url}`);
};

db.insert(s.settings).values({ key: "torbox", value: encrypt("replace-test-key") }).run();
db.insert(s.settings).values({ key: "prowlarr", value: encrypt("fixture-prowlarr-key") }).run();
db.insert(s.settings).values({ key: "prowlarrUrl", value: "http://prowlarr.fixture.test:9696" }).run();
db.insert(s.works).values({ id: WORK, title: "Replace Story", author: "Ada Author", description: "", genre: "", year: 2020 }).run();
sqlite.prepare("INSERT INTO users(id,username,role,password_hash,created_at) VALUES(2,'other','user','x',?)").run(Date.now());

after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
});

beforeEach(() => {
  stopped.length = 0;
  sqlite.exec("DELETE FROM work_media_states");
  sqlite.exec("DELETE FROM user_acquisitions");
  sqlite.exec("DELETE FROM acquisitions");
});

/** A download for the work on its way, the administrator's (and user 2's when shared). */
function seedPrevious(backend: "local" | "torbox", { shared = false } = {}) {
  const id = randomUUID();
  db.insert(s.acquisitions)
    .values({
      id,
      hash: PREVIOUS,
      magnet: `magnet:?xt=urn:btih:${PREVIOUS}`,
      backend,
      remoteId: backend === "torbox" ? "77" : PREVIOUS,
      title: "Replace Story",
      author: "Ada Author",
      cover: "",
      workId: WORK,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.43,
      error: null,
      bookId: null,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    })
    .run();
  db.insert(s.userAcquisitions).values({ userId: 1, acquisitionId: id }).run();
  if (shared) db.insert(s.userAcquisitions).values({ userId: 2, acquisitionId: id }).run();
  assert.equal(getWorkMediaState(1, WORK)?.acquisitionId, id);
  return id;
}

const acquisition = (id: string) => db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get();
const links = (userId: number) =>
  db.select().from(s.userAcquisitions).where(eq(s.userAcquisitions.userId, userId)).all().map((row) => row.acquisitionId);

type RouteName = "abb" | "prowlarr" | "acquire" | "torbox-magnet";
const ROUTES: RouteName[] = ["abb", "prowlarr", "acquire", "torbox-magnet"];

/** Get the recording whose torrent has `hash` for the work through one of the four routes. */
async function get(route: RouteName, hash: string, replaceActive?: boolean) {
  const flag = replaceActive === undefined ? {} : { replaceActive };
  if (route === "abb")
    return app.inject({ method: "POST", url: "/api/discover/abb/add", payload: { slug: `rec-${hash}`, workId: WORK, ...flag } });
  if (route === "prowlarr") {
    const search = await app.inject("/api/discover/prowlarr/releases?q=replace%20story");
    assert.equal(search.statusCode, 200, search.body);
    const id = (search.json().results as { id: string; infoHash?: string }[]).find((r) => r.infoHash === hash)!.id;
    return app.inject({ method: "POST", url: "/api/discover/prowlarr/add", payload: { id, workId: WORK, ...flag } });
  }
  return app.inject({
    method: "POST",
    url: route === "acquire" ? "/api/acquire" : "/api/torbox/magnet",
    payload: { magnet: `magnet:?xt=urn:btih:${hash}&dn=Replace`, workId: WORK, ...flag },
  });
}

for (const route of ROUTES) {
  test(`${route}: replaceActive stops the user's own local download and marks it replaced`, async () => {
    const previous = seedPrevious("local");
    const response = await get(route, NEW, true);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.replaced, "stopped_local");
    assert.equal(body.hash, NEW);
    assert.equal(body.workId, WORK);
    assert.equal(acquisition(previous)?.status, "error");
    assert.equal(acquisition(previous)?.error, REPLACED_ERROR);
    assert.deepEqual(stopped, [{ ids: [PREVIOUS] }]);
    assert.deepEqual(links(1), [body.id]);
    // The book's download on its way is now the new one.
    const state = getWorkMediaState(1, WORK);
    assert.equal(state?.state, "queued");
    assert.equal(state?.acquisitionId, body.id);
  });

  test(`${route}: replaceActive detaches a shared download without stopping it`, async () => {
    const previous = seedPrevious("local", { shared: true });
    const response = await get(route, NEW, true);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().replaced, "detached_shared");
    assert.equal(acquisition(previous)?.status, "downloading");
    assert.equal(acquisition(previous)?.error, null);
    assert.deepEqual(stopped, []);
    assert.deepEqual(links(1), [response.json().id]);
    // The other account keeps its download.
    assert.deepEqual(links(2), [previous]);
    assert.equal(getWorkMediaState(2, WORK)?.acquisitionId, previous);
  });

  test(`${route}: replaceActive detaches a TorBox download`, async () => {
    const previous = seedPrevious("torbox");
    const response = await get(route, NEW, true);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().replaced, "detached_torbox");
    assert.equal(acquisition(previous)?.status, "downloading");
    assert.deepEqual(stopped, []);
    assert.deepEqual(links(1), [response.json().id]);
  });

  test(`${route}: replaceActive with the same torrent replaces nothing`, async () => {
    const previous = seedPrevious("local");
    const response = await get(route, PREVIOUS, true);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal("replaced" in body, false);
    assert.equal(body.id, previous);
    assert.equal(acquisition(previous)?.status, "downloading");
    assert.deepEqual(stopped, []);
    assert.deepEqual(links(1), [previous]);
  });

  test(`${route}: replaceActive with no download on its way replaces nothing`, async () => {
    const response = await get(route, NEW, true);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal("replaced" in body, false);
    assert.equal(body.hash, NEW);
    assert.deepEqual(stopped, []);
  });

  test(`${route}: without the flag the answer is today's and the second download runs beside the first`, async () => {
    const previous = seedPrevious("local");
    const response = await get(route, NEW);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    // Today's answer: the acquisition row, nothing added.
    assert.deepEqual(Object.keys(body).sort(), Object.keys(acquisition(body.id)!).sort());
    assert.equal(acquisition(previous)?.status, "downloading");
    assert.deepEqual(stopped, []);
    assert.deepEqual(links(1).sort(), [previous, body.id].sort());
    // replaceActive: false is the same as no flag.
    const off = await get(route, OTHER, false);
    assert.equal(off.statusCode, 200, off.body);
    assert.equal("replaced" in off.json(), false);
    assert.equal(acquisition(previous)?.status, "downloading");
    assert.equal(links(1).length, 3);
  });
}

test("a refused add replaces nothing", async () => {
  const previous = seedPrevious("local");
  const response = await app.inject({
    method: "POST",
    url: "/api/acquire",
    payload: { magnet: `magnet:?xt=urn:btih:${NEW}`, workId: "no-such-work", replaceActive: true },
  });
  assert.notEqual(response.statusCode, 200);
  assert.match(response.json().error, /could not be found/);
  assert.equal(acquisition(previous)?.status, "downloading");
  assert.deepEqual(stopped, []);
});

test("/api/acquire passes the work on: the acquisition carries it", async () => {
  const response = await get("acquire", NEW);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(acquisition(response.json().id)?.workId, WORK);
  // Without a work: today's answer, no work.
  const plain = await app.inject({ method: "POST", url: "/api/acquire", payload: { magnet: `magnet:?xt=urn:btih:${OTHER}` } });
  assert.equal(plain.statusCode, 200, plain.body);
  assert.equal(plain.json().workId, null);
});
